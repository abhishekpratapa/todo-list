package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/creds"
)

func (a *App) connectionCommands() []*cobra.Command {
	return []*cobra.Command{a.pairCmd(), a.profilesCmd(), a.statusInfoCmd()}
}

// tildify shortens a path under the home folder for showing.
func (a *App) tildify(path string) string {
	if a.Home != "" && strings.HasPrefix(path, a.Home+"/") {
		return "~" + path[len(a.Home):]
	}
	return path
}

// pairingLink reads what the Mac's "Pair iPhone" code says:
// todos-pair:?v=1&u=<address>&t=<token>.
func pairingLink(text string) (address, token string, ok bool) {
	if !strings.HasPrefix(text, "todos-pair:") {
		return "", "", false
	}
	u, err := url.Parse(text)
	if err != nil {
		return "", "", false
	}
	q := u.Query()
	return q.Get("u"), q.Get("t"), q.Get("u") != "" && q.Get("t") != ""
}

var notNameRE = regexp.MustCompile(`[^a-z0-9._-]`)

// nameFor suggests a profile name from the hub's address: its first label.
func nameFor(address string) string {
	u, err := url.Parse(address)
	if err != nil {
		return "mac"
	}
	name := notNameRE.ReplaceAllString(strings.ToLower(strings.Split(u.Hostname(), ".")[0]), "")
	if name == "" || name == config.Local || config.CheckName(name) != nil {
		return "mac"
	}
	return name
}

func (a *App) pairCmd() *cobra.Command {
	var name, ssh, store string
	var tokenStdin, makeDefault bool
	cmd := &cobra.Command{
		Use:   "pair [address]",
		Short: "Connect this machine to Todos on your Mac",
		Long: "Connect this machine to Todos on your Mac, over your tailnet.\n\n" +
			"On the Mac, turn on Todos → Remote Access. The address is shown in that menu,\n" +
			"and Copy Access Token gives the token. The token is asked for here without\n" +
			"being shown; it is never taken as an argument, so it stays out of your shell's\n" +
			"history. For scripts, pipe it in with --token-stdin or set TODOS_TOKEN.\n\n" +
			"The token is kept in the system keyring where there is one (the macOS Keychain,\n" +
			"or the Secret Service on Linux). On a machine without one, such as a server you\n" +
			"reach over SSH, it goes in a file only you can read.\n\n" +
			"--ssh names a host from your own SSH setup for the Mac. If Todos is not running\n" +
			"when a command needs it, the command starts it there over SSH, in the\n" +
			"background. That works only while you are logged in to the Mac's desktop, and\n" +
			"only if SSH connects without asking for a password.",
		Example: "todos pair https://my-mac.my-tailnet.ts.net\ntodos pair my-mac.my-tailnet.ts.net --name home --ssh my-mac\npass show todos | todos pair https://my-mac.my-tailnet.ts.net --token-stdin",
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) > 1 {
				return usagef("one address, not %d (usage: %s)", len(args), cmd.UseLine())
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if store != "" && store != creds.Keyring && store != creds.File {
				return usagef("--store is keyring or file, not %q", store)
			}
			address := ""
			if len(args) == 1 {
				address = args[0]
			}

			var token string
			switch {
			case tokenStdin:
				b, err := io.ReadAll(io.LimitReader(a.In, 64*1024))
				if err != nil {
					return err
				}
				token = strings.TrimSpace(string(b))
			case a.Getenv("TODOS_TOKEN") != "":
				token = strings.TrimSpace(a.Getenv("TODOS_TOKEN"))
			case a.interactive():
				var err error
				if token, err = a.prompter().Secret("Access token", "On the Mac: Todos → Remote Access → Copy Access Token"); err != nil {
					return err
				}
			default:
				return usagef("the access token is needed: pipe it in with --token-stdin, or set TODOS_TOKEN")
			}
			if linkAddress, linkToken, ok := pairingLink(token); ok {
				token = linkToken
				if address == "" {
					address = linkAddress
				}
			}
			if token == "" {
				return usagef("the access token is empty")
			}
			if address == "" {
				return usagef("which Mac? Give its address, as shown in Todos → Remote Access (usage: %s)", cmd.UseLine())
			}
			address, err := api.CleanURL(address)
			if err != nil {
				return usagef("%v", err)
			}
			if name == "" {
				name = nameFor(address)
			}
			if err := config.CheckName(name); err != nil {
				return usagef("%v", err)
			}

			// Check that the address and the token work before saving anything.
			profile := &config.Profile{URL: address, SSH: ssh}
			c, err := api.NewRemote(address, token, a.Getenv("TODOS_CA_FILE"))
			if err != nil {
				return usagef("%v", err)
			}
			c.UserAgent = "todos-cli/" + a.Version
			info, err := c.Info(ctx)
			if err != nil && ssh != "" && api.IsConn(err, api.AppDown, api.Unreachable) {
				if started := a.startRemote(ctx, c, &config.Resolved{Name: name, Profile: profile}, err); started == nil {
					info, err = c.Info(ctx)
				} else {
					err = started
				}
			}
			switch {
			case api.IsStatus(err, 401):
				return &exitError{ExitAuth, errors.New("the Mac did not accept that access token: copy it again from Todos → Remote Access → Copy Access Token")}
			case err != nil:
				return err
			}
			if err := api.CheckVersions(info, a.Version); err != nil {
				return err
			}

			cfg, err := config.Load(a.configDir())
			if err != nil {
				return err
			}
			where, err := a.store().Set(name, token, store)
			if err != nil {
				return err
			}
			profile.TokenStore = where
			cfg.Profiles[name] = profile
			if makeDefault || cfg.Default == "" || cfg.Profiles[cfg.Default] == nil {
				cfg.Default = name
			}
			if err := cfg.Save(a.configDir()); err != nil {
				return err
			}

			if a.json {
				return a.p().Value(map[string]any{"profile": name, "url": address, "ssh": ssh, "tokenStore": where, "default": cfg.Default == name, "appVersion": info.AppVersion})
			}
			fmt.Fprintf(a.Out, "Paired %q with %s (Todos %s).\n", name, address, info.AppVersion)
			switch {
			case where == creds.Keyring && a.GOOS == "darwin":
				fmt.Fprintln(a.Out, "The access token is in your macOS Keychain.")
			case where == creds.Keyring:
				fmt.Fprintln(a.Out, "The access token is in your system keyring.")
			default:
				fmt.Fprintf(a.Out, "The access token is in %s, which only you can read (there is no keyring to use here).\n", a.tildify(a.store().Path()))
			}
			if cfg.Default == name {
				fmt.Fprintln(a.Out, "It is the default profile.")
			} else {
				fmt.Fprintf(a.Out, "Use it with --profile %s, or make it the default: todos profiles use %s\n", name, name)
			}
			if ssh != "" {
				fmt.Fprintf(a.Out, "If Todos isn't running, it will be started over SSH (%s). That needs you to be logged in to the Mac's desktop.\n", ssh)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&name, "name", "", "what to call this profile (default: the first part of the address)")
	f.StringVar(&ssh, "ssh", "", "an SSH `host` for the Mac, to start Todos there when it isn't running")
	f.BoolVar(&tokenStdin, "token-stdin", false, "read the access token from standard input")
	f.StringVar(&store, "store", "", "where to keep the token: keyring or file (default: the keyring if there is one)")
	f.BoolVar(&makeDefault, "default", false, "make this the default profile")
	_ = cmd.RegisterFlagCompletionFunc("store", fixed(creds.Keyring, creds.File))
	return cmd
}

func (a *App) profilesCmd() *cobra.Command {
	list := func(cmd *cobra.Command, _ []string) error {
		cfg, current, err := a.resolve()
		if cfg == nil {
			return err
		}
		type row struct {
			Name       string `json:"name"`
			URL        string `json:"url,omitempty"`
			Socket     string `json:"socket,omitempty"`
			SSH        string `json:"ssh,omitempty"`
			TokenStore string `json:"tokenStore,omitempty"`
			Default    bool   `json:"default"`
			Current    bool   `json:"current"`
		}
		var rows []row
		if socket := a.socketPath(); socket != "" && (a.GOOS == "darwin" || isSocket(socket)) {
			rows = append(rows, row{Name: config.Local, Socket: socket, Default: cfg.Default == config.Local, Current: current != nil && current.Local})
		}
		for _, name := range cfg.Names() {
			p := cfg.Profiles[name]
			rows = append(rows, row{Name: name, URL: p.URL, SSH: p.SSH, TokenStore: p.TokenStore, Default: cfg.Default == name, Current: current != nil && current.Name == name})
		}
		switch {
		case a.json:
			return a.p().Value(map[string]any{"profiles": rows, "default": cfg.Default})
		case len(rows) == 0:
			fmt.Fprintln(a.Err, "No profiles yet. Connect to your Mac with: todos pair <address>")
			return nil
		}
		for _, r := range rows {
			where := r.URL
			if r.Socket != "" {
				where = "this Mac (" + a.tildify(r.Socket) + ")"
			}
			if !a.styled() {
				fmt.Fprintf(a.Out, "%s\t%s\t%s\t%s\t%t\n", r.Name, where, r.TokenStore, r.SSH, r.Current)
				continue
			}
			mark := " "
			if r.Current {
				mark = "*"
			}
			line := fmt.Sprintf("%s %-12s %s", mark, r.Name, where)
			var notes []string
			if r.TokenStore != "" {
				notes = append(notes, "token in "+r.TokenStore)
			}
			if r.SSH != "" {
				notes = append(notes, "starts Todos over ssh "+r.SSH)
			}
			if r.Default {
				notes = append(notes, "default")
			}
			if len(notes) > 0 {
				line += "  (" + strings.Join(notes, ", ") + ")"
			}
			fmt.Fprintln(a.Out, line)
		}
		if a.styled() {
			fmt.Fprintln(a.Out, "\n* is what a command uses when --profile isn't given.")
		}
		return nil
	}

	cmd := &cobra.Command{
		Use:     "profiles",
		Aliases: []string{"profile"},
		Short:   "List and manage the Macs this machine is paired with",
		Long: "List and manage profiles. \"local\" is built in: Todos on this Mac, through its\n" +
			"socket. It is used whenever that socket is there. Otherwise the default profile\n" +
			"is used, and --profile or TODOS_PROFILE choose one for a single command.\n\n" +
			"Profiles are kept in " + "$XDG_CONFIG_HOME/todos/config.json (~/.config/todos/config.json).",
		Args: noArgs,
		RunE: list,
	}
	cmd.AddCommand(&cobra.Command{Use: "ls", Short: "List profiles", Args: noArgs, RunE: list})

	// change loads the config, applies fn to the named profile, and saves.
	change := func(name string, fn func(*config.File, *config.Profile) error) error {
		cfg, err := config.Load(a.configDir())
		if err != nil {
			return err
		}
		p := cfg.Profiles[name]
		if p == nil && name != config.Local {
			return &notFoundError{fmt.Sprintf("there is no profile named %q", name)}
		}
		if err := fn(cfg, p); err != nil {
			return err
		}
		return cfg.Save(a.configDir())
	}
	names := func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		cfg, err := config.Load(a.configDir())
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return cfg.Names(), cobra.ShellCompDirectiveNoFileComp
	}

	cmd.AddCommand(&cobra.Command{
		Use: "use <name>", Short: "Make a profile the default", Args: exactly(1, "which profile?"), ValidArgsFunction: names,
		RunE: func(_ *cobra.Command, args []string) error {
			err := change(args[0], func(cfg *config.File, _ *config.Profile) error {
				cfg.Default = args[0]
				return nil
			})
			if err == nil && !a.json {
				fmt.Fprintf(a.Out, "%s is now the default profile.\n", args[0])
			}
			return err
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use: "rm <name>", Short: "Forget a profile and its access token", Args: exactly(1, "which profile?"), ValidArgsFunction: names,
		RunE: func(_ *cobra.Command, args []string) error {
			if args[0] == config.Local {
				return usagef("%q is built in and has nothing to forget", config.Local)
			}
			err := change(args[0], func(cfg *config.File, p *config.Profile) error {
				if err := a.store().Delete(args[0], p); err != nil {
					return err
				}
				delete(cfg.Profiles, args[0])
				if cfg.Default == args[0] {
					cfg.Default = ""
				}
				return nil
			})
			if err == nil && !a.json {
				fmt.Fprintf(a.Out, "Forgot %s and its access token. (The token still works until it is rotated on the Mac.)\n", args[0])
			}
			return err
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "ssh <name> [host]",
		Short: "Set the SSH host used to start Todos on that Mac (no host: stop doing that)",
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) < 1 || len(args) > 2 {
				return usagef("which profile, and which SSH host? (usage: %s)", cmd.UseLine())
			}
			return nil
		},
		ValidArgsFunction: names,
		RunE: func(_ *cobra.Command, args []string) error {
			if args[0] == config.Local {
				return usagef("%q is this Mac: Todos is started here directly, not over SSH", config.Local)
			}
			host := ""
			if len(args) == 2 {
				host = args[1]
			}
			err := change(args[0], func(_ *config.File, p *config.Profile) error {
				p.SSH = host
				return nil
			})
			if err == nil && !a.json {
				if host == "" {
					fmt.Fprintf(a.Out, "%s will no longer start Todos over SSH.\n", args[0])
				} else {
					fmt.Fprintf(a.Out, "When Todos isn't running, %s will start it with: ssh %s open -g -a Todos --args --background\n", args[0], host)
				}
			}
			return err
		},
	})
	return cmd
}

func (a *App) statusInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show which Todos this machine talks to, and whether it answers",
		Long: "Show the profile in use, how it connects, and the versions on both sides. If\n" +
			"Todos can't be reached, the error says which part is at fault: the app, the Mac,\n" +
			"Tailscale, Remote Access, the token, or a version that is too old.\n\n" +
			"With --json: {\"profile\", \"transport\": \"socket|https\", \"address\", \"appVersion\",\n" +
			"\"apiVersion\": {\"version\", \"revision\"}, \"cliVersion\", \"minClientVersions\": {...}}.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := a.connect(cmd.Context())
			if err != nil {
				return err
			}
			transport, address := "https", ""
			if s.Profile.Local {
				transport, address = "socket", s.Profile.Socket
			} else {
				address = s.Profile.Profile.URL
			}
			if a.json {
				return a.p().Value(map[string]any{
					"profile": s.Profile.Name, "transport": transport, "address": address,
					"appVersion": s.Info.AppVersion, "apiVersion": s.Info.APIVersion, "cliVersion": a.Version, "minClientVersions": s.Info.MinClientVersions,
				})
			}
			where := address
			if s.Profile.Local {
				where = "this Mac, through " + a.tildify(address)
			}
			fmt.Fprintf(a.Out, "profile  %s\n", s.Profile.Name)
			fmt.Fprintf(a.Out, "reaches  %s\n", where)
			fmt.Fprintf(a.Out, "Todos    %s (API %d.%d)\n", s.Info.AppVersion, s.Info.APIVersion.Version, s.Info.APIVersion.Revision)
			fmt.Fprintf(a.Out, "todos    %s\n", a.Version)
			return nil
		},
	}
}

var _ = context.Background
