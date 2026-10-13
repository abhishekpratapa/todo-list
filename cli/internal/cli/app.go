// Package cli is the todos command: its subcommands, how it connects, and what
// it prints.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"charm.land/fang/v2"
	"charm.land/huh/v2/spinner"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/term"
	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/creds"
	"todos/internal/launch"
	"todos/internal/out"
	"todos/internal/tui"
)

// App is one run of the command. Everything it touches outside itself is a
// field, so tests can stand in for the terminal, the environment and the app.
type App struct {
	In      io.Reader
	Out     io.Writer
	Err     io.Writer
	InTTY   bool
	OutTTY  bool
	ErrTTY  bool
	Getenv  func(string) string
	Environ []string
	Home    string
	GOOS    string
	Exe     string // this program's path, to find the app it shipped in
	Version string
	Width   int // the terminal's width, when Out is one

	Prompt Prompter   // asks the user things; nil means the terminal
	Ring   creds.Ring // the keyring; nil means the system's
	// Run runs a command that starts the app (open, or ssh).
	Run func(ctx context.Context, argv []string) error
	// Replace runs a program in this one's place, in a folder (claude).
	Replace func(bin string, args []string, dir string) error
	profile string
	json    bool
	noColor bool
	noInput bool

	printer *out.Printer
}

// NewApp returns an App wired to the real terminal and environment.
func NewApp(version string) *App {
	home, _ := os.UserHomeDir()
	a := &App{
		In: os.Stdin, Out: os.Stdout, Err: os.Stderr,
		InTTY:  term.IsTerminal(os.Stdin.Fd()),
		OutTTY: term.IsTerminal(os.Stdout.Fd()),
		ErrTTY: term.IsTerminal(os.Stderr.Fd()),
		Getenv: os.Getenv, Environ: os.Environ(),
		Home: home, GOOS: runtime.GOOS, Exe: launch.Executable(), Version: version,
		Run: launch.Run, Replace: replace,
	}
	if a.OutTTY {
		if w, _, err := term.GetSize(os.Stdout.Fd()); err == nil {
			a.Width = w
		}
	}
	return a
}

// Main runs the command with the process's arguments and returns its exit code.
func Main(version string) int {
	a := NewApp(version)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return a.Execute(ctx, os.Args[1:])
}

// Execute runs the command with args and returns its exit code. Errors have
// been printed by the time it returns.
func (a *App) Execute(ctx context.Context, args []string) int {
	root := a.Root()
	root.SetArgs(args)
	root.SetIn(a.In)
	// Help is drawn by Fang, which colors it whenever the environment says to
	// (CLICOLOR_FORCE), terminal or not. Off a terminal, strip that on the way out.
	root.SetOut(a.Out)
	if !a.OutTTY {
		root.SetOut(a.colorOut(a.Out, false))
	}
	root.SetErr(a.Err)
	err := fang.Execute(ctx, root,
		fang.WithVersion(a.Version),
		fang.WithoutManpage(),
		fang.WithErrorHandler(func(io.Writer, fang.Styles, error) {}), // reported below, our way
	)
	if err == nil {
		return ExitOK
	}
	exit, code, message := describe(err)
	if exit == ExitInterrupted {
		return exit
	}
	a.report(err, code, message)
	return exit
}

// report prints an error: one line on stderr, or a JSON object with --json.
// Tokens never appear in either; nothing that builds an error is given one.
func (a *App) report(err error, code, message string) {
	if a.json {
		body := map[string]any{"code": code, "message": message}
		var refused *api.Error
		if errors.As(err, &refused) && refused.Current != nil {
			body["current"] = refused.Current
		}
		b, _ := json.Marshal(map[string]any{"error": body})
		fmt.Fprintf(a.Err, "%s\n", b)
		return
	}
	fmt.Fprintf(a.Err, "todos: %s\n", message)
}

// ---------- output ----------

// colorOut wraps a stream so that color is removed, or reduced to what the
// terminal can show, on the way out. NO_COLOR and --no-color remove it.
func (a *App) colorOut(w io.Writer, tty bool) io.Writer {
	cw := &colorprofile.Writer{Forward: w, Profile: colorprofile.NoTTY}
	if tty {
		cw.Profile = colorprofile.Detect(w, a.Environ)
		if cw.Profile < colorprofile.ASCII {
			cw.Profile = colorprofile.Env(a.Environ)
		}
		if (a.noColor || a.Getenv("NO_COLOR") != "") && cw.Profile > colorprofile.ASCII {
			cw.Profile = colorprofile.ASCII
		}
	}
	return cw
}

// styled says whether output is for a person at a terminal.
func (a *App) styled() bool { return a.OutTTY && !a.json }

// p is the printer for results.
func (a *App) p() *out.Printer {
	if a.printer == nil {
		a.printer = &out.Printer{W: a.colorOut(a.Out, a.OutTTY), Styled: a.styled(), Pretty: a.OutTTY, JSON: a.json, Width: a.Width, Dark: a.dark()}
	}
	return a.printer
}

// dark says whether the terminal's background is dark. TODOS_THEME decides if
// set; otherwise the terminal is asked, which only works on a real one.
func (a *App) dark() bool {
	switch strings.ToLower(a.Getenv("TODOS_THEME")) {
	case "light":
		return false
	case "dark":
		return true
	}
	in, inOK := a.In.(term.File)
	outFile, outOK := a.Out.(term.File)
	if a.InTTY && a.OutTTY && inOK && outOK {
		return lipgloss.HasDarkBackground(in, outFile)
	}
	return true
}

// interactive says whether the user can be asked something. Never when output
// is going to a pipe or a file: a script must fail rather than wait.
func (a *App) interactive() bool {
	return a.InTTY && a.OutTTY && !a.noInput && !a.json
}

func (a *App) prompter() Prompter {
	if a.Prompt != nil {
		return a.Prompt
	}
	return &terminalPrompter{in: a.In, out: a.Out, dark: a.dark()}
}

// ---------- connecting ----------

// Session is a connection to one Todos, checked and ready.
type Session struct {
	Client  *api.Client
	Info    *api.Info
	Profile *config.Resolved
}

// Where a remote profile's name for itself comes from, in a task's activity.
var labelRE = regexp.MustCompile(`[^\w .,()'-]`)

func (a *App) configDir() string { return config.Dir(a.Getenv, a.Home) }

func (a *App) store() *creds.Store {
	return &creds.Store{Dir: a.configDir(), Getenv: a.Getenv, GOOS: a.GOOS, Ring: a.Ring}
}

func (a *App) socketPath() string { return config.SocketPath(a.Getenv, a.Home, a.GOOS) }

func isSocket(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

// resolve picks the profile this run uses.
func (a *App) resolve() (*config.File, *config.Resolved, error) {
	cfg, err := config.Load(a.configDir())
	if err != nil {
		return nil, nil, err
	}
	asked := a.profile
	if asked == "" {
		asked = a.Getenv("TODOS_PROFILE")
	}
	socket := a.socketPath()
	res, err := config.Resolve(cfg, asked, config.Where{
		GOOS: a.GOOS, Socket: socket, SocketExists: socket != "" && isSocket(socket), InBundle: launch.BundleFor(a.Exe) != "",
	})
	return cfg, res, err
}

type connectOptions struct {
	noStart bool // don't start the app if it isn't running (shell completion must never)
}

// connect opens a session with the chosen profile: finds the app, starts it if
// it is not running, and checks that the two sides are new enough for each other.
func (a *App) connect(ctx context.Context, opts ...connectOptions) (*Session, error) {
	var opt connectOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	_, res, err := a.resolve()
	if err != nil {
		return nil, err
	}
	var c *api.Client
	if res.Local {
		c = api.NewSocket(res.Socket)
	} else {
		token, err := a.store().Get(res.Name, res.Profile)
		if err != nil {
			return nil, err
		}
		if c, err = api.NewRemote(res.Profile.URL, token, a.Getenv("TODOS_CA_FILE")); err != nil {
			return nil, fmt.Errorf("profile %q: %w", res.Name, err)
		}
		host, _ := os.Hostname()
		c.Label = strings.TrimSpace(labelRE.ReplaceAllString("todos on "+strings.Split(host, ".")[0], ""))
		if len(c.Label) > 40 {
			c.Label = c.Label[:40]
		}
	}
	c.UserAgent = "todos-cli/" + a.Version

	info, err := c.Info(ctx)
	if err != nil && !opt.noStart {
		switch {
		case res.Local && api.IsConn(err, api.NotRunning):
			if err = a.startLocal(ctx, c); err == nil {
				info, err = c.Info(ctx)
			}
		case !res.Local && api.IsConn(err, api.AppDown, api.Unreachable):
			if started := a.startRemote(ctx, c, res, err); started == nil {
				info, err = c.Info(ctx)
			} else {
				err = started
			}
		}
	}
	if err != nil {
		return nil, err
	}
	if err := api.CheckVersions(info, a.Version); err != nil {
		return nil, err
	}
	return &Session{Client: c, Info: info, Profile: res}, nil
}

// startTimeout is how long to wait for the app: TODOS_START_TIMEOUT (seconds,
// or a duration like 30s) if set.
func (a *App) startTimeout(fallback time.Duration) time.Duration {
	raw := a.Getenv("TODOS_START_TIMEOUT")
	if raw == "" {
		return fallback
	}
	if n, err := strconv.ParseFloat(raw, 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Second))
	}
	if d, err := time.ParseDuration(raw); err == nil && d > 0 {
		return d
	}
	return fallback
}

// waiting shows a spinner on a terminal while fn runs, and nothing otherwise.
func (a *App) waiting(title string) func(func() error) error {
	return func(fn func() error) error {
		errFile, ok := a.Err.(*os.File)
		if !a.ErrTTY || !a.InTTY || !ok || a.json {
			return fn()
		}
		return spinner.New().Title(title).WithOutput(errFile).ActionWithErr(func(context.Context) error { return fn() }).Run()
	}
}

// startLocal starts the app on this Mac in the background and waits for its
// socket to answer.
func (a *App) startLocal(ctx context.Context, c *api.Client) error {
	custom := a.Getenv("TODOS_LAUNCH_CMD")
	if a.GOOS != "darwin" && custom == "" {
		return &api.ConnError{Kind: api.NotRunning, Msg: "Todos is not running here, and only a Mac can start it: start the server, or use a profile for your Mac (`todos pair`)"}
	}
	w := launch.Waiter{
		Start: func(ctx context.Context) error {
			if custom != "" {
				return launch.RunShell(ctx, custom)
			}
			return a.Run(ctx, launch.OpenCommand(launch.BundleFor(a.Exe)))
		},
		Healthy:  func(ctx context.Context) error { _, err := c.Health(ctx); return err },
		Timeout:  a.startTimeout(launch.LocalTimeout),
		Interval: launch.LocalInterval,
		Waiting:  a.waiting("Starting Todos…"),
	}
	err := w.Wait(ctx)
	var failed *launch.StartError
	if errors.As(err, &failed) && strings.Contains(failed.Msg, "did not start within") && a.appAnswersOnPort(ctx) {
		// The app is up, but its socket is not there.
		failed.Msg = "Todos is running, but its socket for the todos command is not there. In the app, see Todos → Why the todos Command Can’t Connect…; if there is no such item, this copy of Todos predates the command and needs updating"
	}
	return err
}

// appAnswersOnPort says whether something answers on the app's port. Only used
// to explain a start that never produced a socket.
func (a *App) appAnswersOnPort(ctx context.Context) bool {
	port := a.Getenv("TODO_PORT")
	if port == "" {
		port = "7420"
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://"+net.JoinHostPort("127.0.0.1", port)+"/health", nil)
	if err != nil {
		return false
	}
	res, err := (&http.Client{Transport: &http.Transport{}}).Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return true
}

// startRemote starts the app on the other Mac over SSH, if the profile names a
// host, and waits for it to answer through the tailnet. `why` is the reason the
// Mac's Todos could not be reached; it is what gets reported if this can't help.
func (a *App) startRemote(ctx context.Context, c *api.Client, res *config.Resolved, why error) error {
	if res.Profile.SSH == "" {
		if api.IsConn(why, api.AppDown) {
			return &api.ConnError{Kind: api.AppDown, Msg: why.Error() + fmt.Sprintf(". Open Todos on the Mac, or let todos start it for you: `todos profiles ssh %s <host>`", res.Name), Err: why}
		}
		return why
	}
	argv, err := launch.SSHCommand(a.Getenv("TODOS_SSH"), res.Profile.SSH)
	if err != nil {
		return usagef("profile %q: %v", res.Name, err)
	}
	w := launch.Waiter{
		Start:    func(ctx context.Context) error { return a.Run(ctx, argv) },
		Healthy:  func(ctx context.Context) error { _, err := c.Health(ctx); return err },
		Timeout:  a.startTimeout(launch.RemoteTimeout),
		Interval: launch.RemoteInterval,
		Waiting:  a.waiting(fmt.Sprintf("Starting Todos on %s…", res.Profile.SSH)),
	}
	err = w.Wait(ctx)
	var failed *launch.StartError
	if !errors.As(err, &failed) {
		return err
	}
	if api.IsConn(why, api.Unreachable) {
		// The Mac did not answer over HTTPS, and SSH got nowhere either: it is the Mac, not the app.
		return &api.ConnError{Kind: api.Unreachable, Msg: fmt.Sprintf("%s (starting Todos over SSH also failed: %s)", why.Error(), strings.TrimPrefix(failed.Msg, "could not start Todos: ")), Err: why}
	}
	failed.Msg = fmt.Sprintf("%s. Starting it over SSH (%s) did not work: %s. That needs you to be logged in to the Mac's desktop, and SSH to work without a password",
		why.Error(), res.Profile.SSH, strings.TrimPrefix(failed.Msg, "could not start Todos: "))
	return failed
}

// today is today's date on the Mac, which is what decides "overdue" there.
// If the Mac won't say, this machine's date is close enough. Only output for a
// person uses it, so nothing is asked when the output is for a script.
func (a *App) today(ctx context.Context, s *Session) string {
	if !a.styled() {
		return ""
	}
	if sum, err := s.Client.Summary(ctx); err == nil && sum.Date != "" {
		return sum.Date
	}
	return time.Now().Format("2006-01-02")
}

// localOnly refuses a command that only works on the Mac itself.
func localOnly(s *Session, what string) error {
	if s.Profile.Local {
		return nil
	}
	return &profileError{fmt.Sprintf("%s only works on the Mac itself, and the %q profile reaches it over the network. Run it in a terminal on the Mac", what, s.Profile.Name)}
}

// ---------- the command tree ----------

// Root builds the command tree.
func (a *App) Root() *cobra.Command {
	var mouse bool
	root := &cobra.Command{
		Use:   "todos",
		Short: "Your Todos list, from the terminal",
		Long: "Your Todos list, from the terminal.\n\n" +
			"On the Mac it talks to the Todos app through a local socket and starts the app\n" +
			"in the background if it isn't running. On other machines, pair it with the Mac\n" +
			"once (`todos pair`) and it reaches the app over your tailnet.",
		Example: "todos add \"Renew passport fri !high #personal\"\ntodos ls --due week\ntodos done 12\ntodos show \"passport\"",
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return usagef("unknown command %q (see `todos --help`)", args[0])
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !a.interactive() {
				return a.list(cmd.Context(), api.ListOptions{}, 0)
			}
			s, err := a.connect(cmd.Context())
			if err != nil {
				return err
			}
			theme := strings.ToLower(a.Getenv("TODOS_THEME"))
			return tui.Run(cmd.Context(), tui.Options{
				Client: s.Client, Profile: s.Profile.Name, Local: s.Profile.Local, Mouse: mouse, Getenv: a.Getenv,
				Habits: s.Info.APIVersion.Revision >= api.HabitsRevision,
				Dark:   theme != "light", FixedTheme: theme == "light" || theme == "dark",
			}, a.In, a.Out)
		},
	}
	root.Flags().BoolVar(&mouse, "mouse", false, "let the board take mouse clicks and the wheel (this stops the terminal's own text selection)")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return usagef("%v", err) })
	pf := root.PersistentFlags()
	pf.StringVarP(&a.profile, "profile", "p", "", "which Todos to talk to: `name` of a saved profile, or \"local\"")
	pf.BoolVar(&a.json, "json", false, "print JSON instead of text")
	pf.BoolVar(&a.noColor, "no-color", false, "don't use color")
	pf.BoolVar(&a.noInput, "no-input", false, "never ask anything; fail instead")
	_ = root.RegisterFlagCompletionFunc("profile", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		names := []string{config.Local}
		if cfg, err := config.Load(a.configDir()); err == nil {
			names = append(names, cfg.Names()...)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	})

	root.AddGroup(
		&cobra.Group{ID: "tasks", Title: "Tasks"},
		&cobra.Group{ID: "habits", Title: "Habits"},
		&cobra.Group{ID: "connection", Title: "Connection"},
	)
	for _, c := range a.taskCommands() {
		c.GroupID = "tasks"
		root.AddCommand(c)
	}
	habits := a.habitCommand()
	habits.GroupID = "habits"
	root.AddCommand(habits)
	for _, c := range a.connectionCommands() {
		c.GroupID = "connection"
		root.AddCommand(c)
	}
	root.AddCommand(&cobra.Command{
		Use: "version", Short: "Print the version", Args: noArgs,
		RunE: func(*cobra.Command, []string) error {
			if a.json {
				return a.p().Value(map[string]string{"version": a.Version})
			}
			fmt.Fprintf(a.Out, "todos %s\n", a.Version)
			return nil
		},
	})
	return root
}

// Argument checks that fail as usage errors (exit 2), with the command's usage line.
func noArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 0 {
		return usagef("`%s` takes no arguments", cmd.CommandPath())
	}
	return nil
}

func atLeast(n int, what string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < n {
			return usagef("%s (usage: %s)", what, cmd.UseLine())
		}
		return nil
	}
}

func exactly(n int, what string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) != n {
			return usagef("%s (usage: %s)", what, cmd.UseLine())
		}
		return nil
	}
}
