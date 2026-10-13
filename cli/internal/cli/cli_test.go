package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"charm.land/huh/v2"
	"github.com/zalando/go-keyring"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/creds"
	"todos/internal/fakeserver"
	"todos/internal/launch"
)

// asker answers prompts and remembers what was asked.
type asker struct {
	yes    bool
	choice int
	secret string
	task   map[string]any
	err    error
	asked  []string
}

func (p *asker) Confirm(q string) (bool, error) { p.asked = append(p.asked, q); return p.yes, p.err }
func (p *asker) Choose(title string, options []string) (int, error) {
	p.asked = append(p.asked, title+" "+strings.Join(options, " | "))
	return p.choice, p.err
}
func (p *asker) Secret(title, _ string) (string, error) {
	p.asked = append(p.asked, title)
	return p.secret, p.err
}
func (p *asker) NewTask() (map[string]any, error) {
	p.asked = append(p.asked, "new task")
	return p.task, p.err
}

type memRing struct {
	mu    sync.Mutex
	items map[string]string
}

func (r *memRing) Get(s, a string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.items[s+"/"+a]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}
func (r *memRing) Set(s, a, secret string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[s+"/"+a] = secret
	return nil
}
func (r *memRing) Delete(s, a string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.items, s+"/"+a)
	return nil
}

// harness is an App whose terminal, environment and app are all stand-ins.
type harness struct {
	*App
	out, err bytes.Buffer
	env      map[string]string
	ask      *asker
	ring     *memRing
	ran      [][]string // commands the App ran to start Todos
	fake     *fakeserver.Server
	socket   string
}

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "tdc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// newHarness makes an App on a terminal (tty) or a pipe, with a fake Todos
// running on its socket unless running is false.
func newHarness(t *testing.T, tty, running bool) *harness {
	t.Helper()
	h := &harness{ask: &asker{}, ring: &memRing{items: map[string]string{}}, fake: fakeserver.New()}
	h.socket = filepath.Join(shortDir(t), "t.sock")
	home := t.TempDir()
	h.env = map[string]string{"TODOS_SOCKET": h.socket, "XDG_CONFIG_HOME": filepath.Join(home, "config"), "TERM": "xterm-256color", "TODOS_THEME": "dark", "TODOS_START_TIMEOUT": "3", "TODO_PORT": "9"}
	h.App = &App{
		In: strings.NewReader(""), InTTY: tty, OutTTY: tty, ErrTTY: false,
		Getenv: func(k string) string { return h.env[k] }, Home: home, GOOS: "darwin", Exe: "/usr/local/bin/todos", Version: "0.1.0", Width: 100,
		Prompt: h.ask, Ring: h.ring,
		Run: func(_ context.Context, argv []string) error {
			h.ran = append(h.ran, argv)
			return errors.New("not in a test")
		},
	}
	h.App.Out, h.App.Err = &h.out, &h.err
	if running {
		if err := h.fake.ServeUnix(h.socket); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(h.fake.Close)
	return h
}

// run executes one command line and returns its exit code. Output accumulates
// in h.out and h.err until reset.
func (h *harness) run(args ...string) int {
	h.out.Reset()
	h.err.Reset()
	h.App.printer, h.App.json, h.App.noColor, h.App.noInput, h.App.profile = nil, false, false, false, ""
	h.App.Environ = nil
	for k, v := range h.env {
		h.App.Environ = append(h.App.Environ, k+"="+v)
	}
	return h.App.Execute(context.Background(), args)
}

var (
	anyEscape   = regexp.MustCompile("\x1b")
	colorEscape = regexp.MustCompile("\x1b\\[[0-9;]*(3[0-7]|9[0-7]|38;|48;)[0-9;]*m")
)

func TestExitCodes(t *testing.T) {
	refusal := func(status int, code string) error { return &api.Error{Status: status, Code: code, Message: "m"} }
	for _, c := range []struct {
		err  error
		exit int
		code string
	}{
		{errors.New("something else"), ExitError, "error"},
		{usagef("bad flag"), ExitUsage, "usage"},
		{&notFoundError{"no such"}, ExitNotFound, "not_found"},
		{refusal(404, "not_found"), ExitNotFound, "not_found"},
		{refusal(409, "conflict"), ExitConflict, "conflict"},
		{refusal(428, "precondition_required"), ExitConflict, "precondition_required"},
		{refusal(400, "invalid"), ExitUsage, "invalid"},
		{refusal(415, "unsupported_media_type"), ExitUsage, "unsupported_media_type"},
		{refusal(401, "unauthorized"), ExitAuth, "unauthorized"},
		{refusal(403, "forbidden_user"), ExitAuth, "forbidden_user"},
		{refusal(403, "forbidden_origin"), ExitAuth, "forbidden_origin"},
		{refusal(429, "rate_limited"), ExitBusy, "rate_limited"},
		{refusal(503, "busy"), ExitBusy, "busy"},
		{refusal(500, "internal"), ExitError, "internal"},
		{&api.ConnError{Kind: api.NotRunning, Msg: "m"}, ExitStart, "not_running"},
		{&launch.StartError{Msg: "m"}, ExitStart, "start_failed"},
		{&api.ConnError{Kind: api.Unreachable, Msg: "m"}, ExitUnreachable, "unreachable"},
		{&api.ConnError{Kind: api.TailscaleDown, Msg: "m"}, ExitUnreachable, "tailscale_down"},
		{&api.ConnError{Kind: api.RemoteOff, Msg: "m"}, ExitUnreachable, "remote_off"},
		{&api.ConnError{Kind: api.AppDown, Msg: "m"}, ExitUnreachable, "app_down"},
		{&api.ConnError{Kind: api.Interrupted, Msg: "m"}, ExitUnreachable, "unreachable"},
		{&api.VersionError{AppTooOld: true, Have: "3", Need: "4"}, ExitVersion, "version"},
		{&api.VersionError{Have: "0.1.0", Need: "0.2.0"}, ExitVersion, "version"},
		{&profileError{"local only"}, ExitProfile, "profile"},
		{&config.NoProfileError{Msg: "m"}, ExitProfile, "no_profile"},
		{creds.ErrNoToken, ExitAuth, "no_token"},
		{context.Canceled, ExitInterrupted, "cancelled"},
		{huh.ErrUserAborted, ExitInterrupted, "cancelled"},
		{fmt.Errorf("wrapped: %w", refusal(404, "not_found")), ExitNotFound, "not_found"},
		{&exitError{ExitAuth, errors.New("m")}, ExitAuth, "error"},
	} {
		exit, code, message := describe(c.err)
		if exit != c.exit || code != c.code || message == "" {
			t.Errorf("%T %v: exit %d code %q, want exit %d code %q", c.err, c.err, exit, code, c.exit, c.code)
		}
	}
	// The documented numbers themselves.
	if got := []int{ExitOK, ExitError, ExitUsage, ExitNotFound, ExitConflict, ExitUnreachable, ExitAuth, ExitStart, ExitVersion, ExitProfile, ExitBusy}; !reflect.DeepEqual(got, []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10}) {
		t.Errorf("exit codes changed: %v", got)
	}
}

func TestColorOnlyOnATerminal(t *testing.T) {
	// On a terminal: styled.
	h := newHarness(t, true, true)
	h.fake.Add("Renew passport", func(t *fakeserver.Task) { t.Priority = "high" })
	if code := h.run("ls"); code != 0 || !colorEscape.MatchString(h.out.String()) {
		t.Fatalf("ls on a terminal: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	// NO_COLOR and --no-color: no color, though bold and faint may stay.
	h.env["NO_COLOR"] = "1"
	if h.run("ls"); colorEscape.MatchString(h.out.String()) || !strings.Contains(h.out.String(), "Renew passport") {
		t.Errorf("ls with NO_COLOR: %q", h.out.String())
	}
	delete(h.env, "NO_COLOR")
	if h.run("ls", "--no-color"); colorEscape.MatchString(h.out.String()) {
		t.Errorf("ls --no-color: %q", h.out.String())
	}
	// A terminal that can't do color.
	h.env["TERM"] = "dumb"
	if h.run("ls"); anyEscape.MatchString(h.out.String()) {
		t.Errorf("ls on a dumb terminal: %q", h.out.String())
	}
	h.env["TERM"] = "xterm-256color"
	// JSON on a terminal is indented, and never colored.
	if h.run("ls", "--json"); anyEscape.MatchString(h.out.String()) || !strings.Contains(h.out.String(), "\n  \"tasks\": [") {
		t.Errorf("ls --json on a terminal: %q", h.out.String())
	}
	if h.run("show", "1"); !strings.Contains(h.out.String(), "Renew passport") || !anyEscape.MatchString(h.out.String()) {
		t.Errorf("show on a terminal: %q", h.out.String())
	}

	// Through a pipe: nothing, whatever the environment says.
	p := newHarness(t, false, true)
	p.fake.Add("Renew passport", func(t *fakeserver.Task) { t.Priority = "high"; t.Notes = "**bold**" })
	p.env["CLICOLOR_FORCE"], p.env["COLORTERM"] = "1", "truecolor"
	for _, args := range [][]string{{"ls"}, {"show", "1"}, {"due"}, {"status"}, {"add", "x"}, {"done", "1"}, {"--help"}, {"ls", "--help"}} {
		if code := p.run(args...); code != 0 || anyEscape.MatchString(p.out.String()+p.err.String()) {
			t.Errorf("%v through a pipe: exit %d, %q %q", args, code, p.out.String(), p.err.String())
		}
	}
}

func TestDeletingAsksFirst(t *testing.T) {
	h := newHarness(t, true, true)
	task := h.fake.Add("Keep or delete")

	h.ask.yes = false
	if code := h.run("rm", "1"); code != ExitInterrupted {
		t.Errorf("answering no: exit %d", code)
	}
	if _, still := h.fake.Task(task.ID); !still || len(h.ask.asked) != 1 || !strings.Contains(h.ask.asked[0], "Delete #1 “Keep or delete”?") {
		t.Fatalf("answering no must not delete (asked: %v)", h.ask.asked)
	}

	// --no-input on a terminal: don't ask, and don't delete.
	if code := h.run("rm", "1", "--no-input"); code != ExitUsage || len(h.ask.asked) != 1 {
		t.Errorf("--no-input: exit %d, asked %v", code, h.ask.asked)
	}

	// If the task changes between the question and the answer, it is not deleted.
	h.ask.yes = true
	var once sync.Once
	h.fake.Configure(func(f *fakeserver.Server) {
		f.Hook = func(r fakeserver.Request) {
			if r.Method == "DELETE" {
				once.Do(func() {
					h.fake.Touch(task.ID, "claude", "edited notes", func(t *fakeserver.Task) { t.Notes = "Don't delete this, I need it" })
				})
			}
		}
	})
	if code := h.run("rm", "1"); code != ExitConflict {
		t.Errorf("changed while confirming: exit %d (%s)", code, h.err.String())
	}
	if _, still := h.fake.Task(task.ID); !still {
		t.Fatal("a task that changed after the question was deleted anyway")
	}

	if code := h.run("rm", "1"); code != 0 || !strings.Contains(h.out.String(), "Deleted #1") {
		t.Errorf("answering yes: exit %d, %q", code, h.out.String())
	}
	if _, still := h.fake.Task(task.ID); still {
		t.Error("answering yes should delete")
	}
	// --yes never asks.
	h.fake.Add("Another")
	asked := len(h.ask.asked)
	if code := h.run("rm", "2", "--yes"); code != 0 || len(h.ask.asked) != asked {
		t.Errorf("--yes: exit %d, asked %d more times", code, len(h.ask.asked)-asked)
	}
}

func TestAddOpensAFormOnATerminal(t *testing.T) {
	h := newHarness(t, true, true)
	h.ask.task = map[string]any{"title": "From the form", "due": "tomorrow", "priority": "high", "tags": "a, b"}
	if code := h.run("add"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	got, _ := h.fake.Task(1)
	if got.Title != "From the form" || got.Priority != "high" || got.Due == nil || strings.Join(got.Tags, ",") != "a,b" {
		t.Errorf("created %+v", got)
	}
	if !strings.Contains(h.out.String(), "Added") {
		t.Errorf("printed %q", h.out.String())
	}
	// The form's date is read by the server, not here: the request carried it as typed.
	var post fakeserver.Request
	for _, r := range h.fake.Requests() {
		if r.Method == "POST" {
			post = r
		}
	}
	if post.Path != "/api/v1/tasks" || !strings.Contains(post.Body, `"due":"tomorrow"`) {
		t.Errorf("the request: %s %s", post.Path, post.Body)
	}
	// Leaving the form is not an error message, just a quiet exit.
	h.ask.err = huh.ErrUserAborted
	if code := h.run("add"); code != ExitInterrupted || h.err.Len() != 0 {
		t.Errorf("leaving the form: exit %d, %q", code, h.err.String())
	}
	// With a line, no form.
	h.ask.err = nil
	asked := len(h.ask.asked)
	if h.run("add", "Just a line"); len(h.ask.asked) != asked {
		t.Error("add with a line should not open the form")
	}
}

func TestAnAmbiguousNameAsksOnATerminal(t *testing.T) {
	h := newHarness(t, true, true)
	h.fake.Add("Call the bank")
	h.fake.Add("Call the dentist")
	h.fake.Add("Call the plumber", func(t *fakeserver.Task) { t.Status = "done" })
	h.ask.choice = 1
	if code := h.run("start", "call"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	// Open tasks are offered; the finished one is not.
	if len(h.ask.asked) != 1 || !strings.Contains(h.ask.asked[0], "#1  Call the bank | #2  Call the dentist") || strings.Contains(h.ask.asked[0], "plumber") {
		t.Errorf("asked: %v", h.ask.asked)
	}
	if got, _ := h.fake.Task(2); got.Status != "in_progress" {
		t.Errorf("the chosen task: %+v", got)
	}
	// A finished task is found when nothing open matches.
	if code := h.run("reopen", "plumber"); code != 0 {
		t.Errorf("reopen by title: exit %d: %s", code, h.err.String())
	}
}

func TestAConflictIsRetriedOnlyWhenOtherFieldsChanged(t *testing.T) {
	h := newHarness(t, false, true)
	task := h.fake.Add("Shared")
	// Someone changes a different field between this command's read and its write.
	meanwhile := func(edit func(*fakeserver.Task)) {
		var once sync.Once
		h.fake.Configure(func(f *fakeserver.Server) {
			f.Hook = func(r fakeserver.Request) {
				if r.Method == "PATCH" {
					once.Do(func() { h.fake.Touch(task.ID, "claude", "changed something", edit) })
				}
			}
		})
	}

	meanwhile(func(t *fakeserver.Task) { t.Priority = "high" })
	if code := h.run("edit", "1", "--title", "Renamed"); code != 0 {
		t.Fatalf("a change to another field should not stop this one: exit %d: %s", code, h.err.String())
	}
	if got, _ := h.fake.Task(1); got.Title != "Renamed" || got.Priority != "high" {
		t.Errorf("both changes should stand: %+v", got)
	}

	// Someone changes the same field: theirs is not overwritten.
	meanwhile(func(t *fakeserver.Task) { t.Title = "Theirs" })
	if code := h.run("edit", "1", "--title", "Mine"); code != ExitConflict {
		t.Fatalf("a change to the same field: exit %d: %s", code, h.err.String())
	}
	if got, _ := h.fake.Task(1); got.Title != "Theirs" {
		t.Errorf("their title was overwritten: %q", got.Title)
	}
	if !strings.Contains(h.err.String(), "nothing was changed") || h.out.Len() != 0 {
		t.Errorf("the message: %q (stdout %q)", h.err.String(), h.out.String())
	}

	// With --rev there is no second try, even for another field.
	now, _ := h.fake.Task(1)
	meanwhile(func(t *fakeserver.Task) { t.Priority = "low" })
	if code := h.run("start", "1", "--rev", fmt.Sprint(now.Rev)); code != ExitConflict {
		t.Errorf("--rev is strict: exit %d", code)
	}
	if code := h.run("start", "1", "--rev", "1", "--force"); code != ExitUsage {
		t.Errorf("--rev with --force: exit %d", code)
	}
}

func TestStartingTheAppOnAMac(t *testing.T) {
	h := newHarness(t, false, false)
	h.App.Run = func(_ context.Context, argv []string) error {
		h.ran = append(h.ran, argv)
		return h.fake.ServeUnix(h.socket) // the "app" comes up
	}
	if code := h.run("add", "After starting"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	want := []string{"/usr/bin/open", "-g", "-a", "Todos", "--args", "--background"}
	if len(h.ran) != 1 || !reflect.DeepEqual(h.ran[0], want) {
		t.Errorf("ran %v, want %v", h.ran, want)
	}
	// It is running now: nothing is started again.
	if h.run("ls"); len(h.ran) != 1 {
		t.Errorf("started again: %v", h.ran)
	}

	// The copy inside the app starts the app it is inside.
	inside := newHarness(t, false, false)
	bundle := filepath.Join(t.TempDir(), "Todos.app")
	inside.App.Exe = filepath.Join(bundle, "Contents", "Resources", "bin", "todos")
	os.MkdirAll(filepath.Dir(inside.App.Exe), 0o755) //nolint:errcheck
	os.WriteFile(inside.App.Exe, nil, 0o755)         //nolint:errcheck
	real, _ := filepath.EvalSymlinks(bundle)
	inside.App.Run = func(_ context.Context, argv []string) error {
		inside.ran = append(inside.ran, argv)
		return inside.fake.ServeUnix(inside.socket)
	}
	if code := inside.run("ls"); code != 0 || len(inside.ran) != 1 || inside.ran[0][3] != real {
		t.Errorf("exit %d, ran %v, want -a %s", code, inside.ran, real)
	}

	// Anywhere but a Mac there is no app to start.
	linux := newHarness(t, false, false)
	linux.App.GOOS = "linux"
	if code := linux.run("ls", "--profile", "local"); code != ExitStart || len(linux.ran) != 0 || !strings.Contains(linux.err.String(), "only a Mac can start it") {
		t.Errorf("on Linux: exit %d, ran %v, %q", code, linux.ran, linux.err.String())
	}
	// And with nothing paired there, the answer is to pair.
	delete(linux.env, "TODOS_SOCKET")
	if code := linux.run("ls"); code != ExitProfile || !strings.Contains(linux.err.String(), "todos pair") {
		t.Errorf("on Linux with no profile: exit %d, %q", code, linux.err.String())
	}
}

func TestCompletionNeverStartsTheApp(t *testing.T) {
	h := newHarness(t, false, false)
	if code := h.run("__complete", "show", ""); code != 0 || len(h.ran) != 0 {
		t.Errorf("completing with the app not running: exit %d, started %v", code, h.ran)
	}
	if strings.Contains(h.out.String(), "\t") {
		t.Errorf("no tasks can be offered: %q", h.out.String())
	}

	up := newHarness(t, false, true)
	up.fake.Add("Renew passport")
	up.fake.Add("Finished", func(t *fakeserver.Task) { t.Status = "done" })
	if code := up.run("__complete", "done", ""); code != 0 || !strings.Contains(up.out.String(), "1\tRenew passport\n") || strings.Contains(up.out.String(), "Finished") {
		t.Errorf("completing tasks: exit %d, %q", code, up.out.String())
	}
	if up.run("__complete", "ls", "--status", ""); !strings.Contains(up.out.String(), "in_progress") {
		t.Errorf("completing --status: %q", up.out.String())
	}
	if up.run("__complete", "sub", "done", "1", ""); strings.Contains(up.out.String(), "Renew passport") {
		t.Errorf("only the first argument of `sub done` is a task: %q", up.out.String())
	}
}

func TestPairingKeepsTheTokenInTheKeyring(t *testing.T) {
	h := newHarness(t, true, false)
	url, ca := h.fake.ServeTLS()
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	os.WriteFile(caFile, ca, 0o600) //nolint:errcheck
	h.env["TODOS_CA_FILE"] = caFile
	delete(h.env, "TODOS_SOCKET")
	h.env["TODOS_SOCKET"] = filepath.Join(shortDir(t), "absent.sock")

	// On a terminal the token is asked for, hidden; on a Mac it goes in the Keychain.
	h.ask.secret = h.fake.Token()
	if code := h.run("pair", url, "--name", "home"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if len(h.ask.asked) != 1 || h.ask.asked[0] != "Access token" {
		t.Errorf("asked: %v", h.ask.asked)
	}
	if h.ring.items["todos-cli/home"] != h.fake.Token() {
		t.Errorf("the keyring holds %v", h.ring.items)
	}
	if !strings.Contains(h.out.String(), "macOS Keychain") || strings.Contains(h.out.String()+h.err.String(), h.fake.Token()) {
		t.Errorf("printed: %q", h.out.String())
	}
	dir := filepath.Join(h.env["XDG_CONFIG_HOME"], "todos")
	if _, err := os.Stat(filepath.Join(dir, "credentials.json")); !errors.Is(err, os.ErrNotExist) {
		t.Error("no token file should be written when the keyring has the token")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	var cfg config.File
	json.Unmarshal(raw, &cfg) //nolint:errcheck
	if cfg.Default != "home" || cfg.Profiles["home"].TokenStore != "keyring" || strings.Contains(string(raw), h.fake.Token()) {
		t.Errorf("config.json: %s", raw)
	}
	// And commands then use it.
	h.fake.Add("On the hub")
	if code := h.run("ls", "--profile", "home"); code != 0 || !strings.Contains(h.out.String(), "On the hub") {
		t.Errorf("ls with the paired profile: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	// Forgetting the profile takes the token out of the keyring.
	if code := h.run("profiles", "rm", "home"); code != 0 || len(h.ring.items) != 0 {
		t.Errorf("profiles rm: exit %d, keyring %v", code, h.ring.items)
	}

	// On a Linux machine with no keyring: a file, and the message says where and why.
	h.App.GOOS = "linux"
	if code := h.run("pair", url, "--name", "home"); code != 0 || len(h.ring.items) != 0 {
		t.Fatalf("on Linux: exit %d: %s", code, h.err.String())
	}
	if !strings.Contains(h.out.String(), "credentials.json, which only you can read (there is no keyring to use here)") {
		t.Errorf("printed: %q", h.out.String())
	}
	// --store keyring there fails rather than quietly using a file... unless there is one.
	h.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
	if code := h.run("pair", url, "--name", "desk"); code != 0 || h.ring.items["todos-cli/desk"] == "" || !strings.Contains(h.out.String(), "system keyring") {
		t.Errorf("with a Secret Service: exit %d, %v, %q", code, h.ring.items, h.out.String())
	}
}

func TestDiff(t *testing.T) {
	task := func(js string) api.Task {
		var out api.Task
		if err := json.Unmarshal([]byte(js), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	before := map[int]api.Task{
		1: task(`{"id":1,"title":"Stays","status":"todo","rev":1,"updatedAt":"a"}`),
		2: task(`{"id":2,"title":"Changes","status":"todo","due":null,"rev":1,"updatedAt":"a","comments":0}`),
		3: task(`{"id":3,"title":"Goes","status":"todo","rev":1,"updatedAt":"a"}`),
	}
	after := map[int]api.Task{
		1: task(`{"id":1,"title":"Stays","status":"todo","rev":1,"updatedAt":"a"}`),
		2: task(`{"id":2,"title":"Changes","status":"done","due":"2026-10-20","rev":3,"updatedAt":"b","comments":1}`),
		4: task(`{"id":4,"title":"Arrives","status":"todo","rev":1,"updatedAt":"b"}`),
	}
	got := Diff(before, after, 9)
	if len(got) != 3 {
		t.Fatalf("%d changes: %+v", len(got), got)
	}
	if got[0].Event != "updated" || got[0].Task.ID != 2 || strings.Join(got[0].Changed, ",") != "comments,due,status" || got[0].Version != 9 {
		t.Errorf("updated: %+v", got[0])
	}
	if got[1].Event != "deleted" || got[1].Task.Title != "Goes" {
		t.Errorf("deleted: %+v", got[1])
	}
	if got[2].Event != "created" || got[2].Task.ID != 4 {
		t.Errorf("created: %+v", got[2])
	}
	if len(Diff(after, after, 9)) != 0 {
		t.Error("no difference, no changes")
	}
}
