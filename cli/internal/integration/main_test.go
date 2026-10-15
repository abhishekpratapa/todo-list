// Package integration runs the built todos binary, as a user or a script would,
// against a server: the fake one, and the real Todos server from this
// repository (on port 7442, with its own data, token and socket; never the
// installed app's). Each is reached both ways the command connects: through a
// Unix socket, and over HTTPS with a token.
package integration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"todos/internal/api"
	"todos/internal/fakeserver"
	"todos/internal/realserver"
)

var bin string // the todos binary under test

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "todos-bin")
	if err != nil {
		panic(err)
	}
	bin = filepath.Join(dir, "todos")
	build := exec.Command("go", "build", "-o", bin, "todos")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "building todos failed: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// backend is one server, reached one way.
type backend struct {
	name   string
	local  bool     // through the socket
	env    []string // the environment in which the command finds it
	client *api.Client

	fake   *fakeserver.Server
	real   *realserver.Server
	rotate func() // replaces the access token on the server
	stop   func() // stops the server
}

// baseEnv is a clean environment for the command: its own home and config
// folders, no keyring, and nothing that could reach the installed app. If the
// command decides to start Todos, it runs `false` instead of opening the app.
func baseEnv(t *testing.T) []string {
	t.Helper()
	home := t.TempDir()
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, "config"),
		"TODOS_TOKEN_STORE=file",
		"TODOS_SOCKET=" + filepath.Join(realserver.ShortDir(t), "none.sock"),
		"TODOS_LAUNCH_CMD=false",
		"TODOS_START_TIMEOUT=2",
		"TODOS_SSH=false",
		"TODO_PORT=9", // nothing listens there
		"TZ=UTC",
		"TODOS_QUEUE=manual", // no sender left running in the background, unless a test asks
	}
}

func setEnv(env []string, kv string) []string {
	key := strings.SplitN(kv, "=", 2)[0] + "="
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, key) {
			out = append(out, e)
		}
	}
	return append(out, kv)
}

type result struct {
	stdout, stderr string
	code           int
}

// run runs the command and waits for it.
func run(t *testing.T, env []string, stdin string, args ...string) result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		code = exit.ExitCode()
	case err != nil:
		t.Fatalf("todos %s: %v", strings.Join(args, " "), err)
	}
	return result{stdout.String(), stderr.String(), code}
}

// ok runs the command, which must succeed, and returns what it printed.
func ok(t *testing.T, env []string, args ...string) string {
	t.Helper()
	r := run(t, env, "", args...)
	if r.code != 0 {
		t.Fatalf("todos %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, r.stdout, r.stderr)
	}
	return r.stdout
}

// fails runs the command, which must exit with code and say something matching want.
func fails(t *testing.T, env []string, code int, want string, args ...string) result {
	t.Helper()
	r := run(t, env, "", args...)
	if r.code != code {
		t.Fatalf("todos %s: exit %d, want %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, code, r.stdout, r.stderr)
	}
	if !regexp.MustCompile(want).MatchString(r.stderr) {
		t.Fatalf("todos %s: stderr %q does not match %q", strings.Join(args, " "), r.stderr, want)
	}
	if strings.Count(strings.TrimSpace(r.stderr), "\n") > 12 {
		t.Fatalf("todos %s: an error should be short, got:\n%s", strings.Join(args, " "), r.stderr)
	}
	return r
}

// pair connects the command's config to a hub and returns the environment to use.
func pair(t *testing.T, env []string, url, token string, extra ...string) []string {
	t.Helper()
	args := append([]string{"pair", url, "--token-stdin", "--name", "hub"}, extra...)
	r := run(t, env, token+"\n", args...)
	if r.code != 0 {
		t.Fatalf("todos pair: exit %d\nstdout: %s\nstderr: %s", r.code, r.stdout, r.stderr)
	}
	return env
}

func fakeSocket(t *testing.T) *backend {
	f := fakeserver.New()
	socket := filepath.Join(realserver.ShortDir(t), "t.sock")
	if err := f.ServeUnix(socket); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return &backend{name: "fake/socket", local: true, env: setEnv(baseEnv(t), "TODOS_SOCKET="+socket), client: api.NewSocket(socket), fake: f, stop: f.Close}
}

func fakeRemote(t *testing.T) *backend {
	f := fakeserver.New()
	url, ca := f.ServeTLS()
	t.Cleanup(f.Close)
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, ca, 0o600); err != nil {
		t.Fatal(err)
	}
	env := pair(t, setEnv(baseEnv(t), "TODOS_CA_FILE="+caFile), url, f.Token())
	client, err := api.NewRemote(url, f.Token(), caFile)
	if err != nil {
		t.Fatal(err)
	}
	return &backend{name: "fake/https", env: env, client: client, fake: f, stop: f.Close,
		rotate: func() { f.RotateToken("rotated-token-0123456789abcdef0123456789") }}
}

func realSocket(t *testing.T) *backend {
	rs := realserver.Start(t)
	return &backend{name: "real/socket", local: true, env: setEnv(baseEnv(t), "TODOS_SOCKET="+rs.Socket), client: api.NewSocket(rs.Socket), real: rs, stop: rs.Stop}
}

func realRemote(t *testing.T) *backend {
	rs := realserver.Start(t)
	relay := realserver.NewRelay(t, rs.URL)
	caFile := relay.CAFile(t)
	env := pair(t, setEnv(baseEnv(t), "TODOS_CA_FILE="+caFile), relay.URL, rs.Token())
	client, err := api.NewRemote(relay.URL, rs.Token(), caFile)
	if err != nil {
		t.Fatal(err)
	}
	return &backend{name: "real/https", env: env, client: client, real: rs, stop: rs.Stop, rotate: func() { rs.Rotate() }}
}

var backends = []struct {
	name string
	make func(*testing.T) *backend
}{
	{"fake/socket", fakeSocket},
	{"fake/https", fakeRemote},
	{"real/socket", realSocket},
	{"real/https", realRemote},
}

// everywhere runs a test against every backend, one at a time (the real server
// has one port).
func everywhere(t *testing.T, fn func(t *testing.T, b *backend)) {
	for _, b := range backends {
		t.Run(b.name, func(t *testing.T) { fn(t, b.make(t)) })
	}
}

// remotes and locals run a test against the backends of one kind.
func only(t *testing.T, local bool, fn func(t *testing.T, b *backend)) {
	for _, b := range backends {
		if strings.HasSuffix(b.name, "/socket") == local {
			t.Run(b.name, func(t *testing.T) { fn(t, b.make(t)) })
		}
	}
}

// add creates a task directly through the API, for a test to work on.
func (b *backend) add(t *testing.T, line string) api.Task {
	t.Helper()
	res, err := b.client.Capture(context.Background(), line)
	if err != nil {
		t.Fatalf("adding %q: %v", line, err)
	}
	return res.Task
}

func (b *backend) get(t *testing.T, id int) *api.Task {
	t.Helper()
	task, err := b.client.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("getting #%d: %v", id, err)
	}
	return task
}

var ansi = regexp.MustCompile("\x1b")
