package integration

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"todos/internal/fakeserver"
	"todos/internal/realserver"
)

// writeProfile saves a profile by hand, for hubs that can't be paired with
// because the point of the test is that they don't answer.
func writeProfile(t *testing.T, env []string, url, ssh, token string) {
	t.Helper()
	var dir string
	for _, e := range env {
		if strings.HasPrefix(e, "XDG_CONFIG_HOME=") {
			dir = filepath.Join(strings.TrimPrefix(e, "XDG_CONFIG_HOME="), "todos")
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"default": "hub", "profiles": map[string]any{"hub": map[string]string{"url": url, "ssh": ssh, "tokenStore": "file"}}})
	creds, _ := json.Marshal(map[string]string{"hub": token})
	for name, data := range map[string][]byte{"config.json": config, "credentials.json": creds} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// script writes an executable shell script and returns its path.
func script(t *testing.T, body string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "script.sh")
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return file
}

// whenExists calls fn once file appears.
func whenExists(t *testing.T, file string, fn func()) {
	t.Helper()
	go func() {
		for i := 0; i < 400; i++ {
			if _, err := os.Stat(file); err == nil {
				fn()
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()
}

// ---------- on the Mac: the app is not running ----------

func TestLocalAppNotRunningIsStarted(t *testing.T) {
	// The command finds no socket, runs the start command, waits for the health
	// check, and then does what it was asked. Here the "app" is a server that
	// appears a moment after the start command ran, as the real app does.
	for _, kind := range []string{"fake", "real"} {
		t.Run(kind, func(t *testing.T) {
			dir := realserver.ShortDir(t)
			marker := filepath.Join(dir, "started")
			env := setEnv(baseEnv(t), "TODOS_LAUNCH_CMD=touch "+marker)
			env = setEnv(env, "TODOS_START_TIMEOUT=10")

			if kind == "fake" {
				socket := filepath.Join(dir, "t.sock")
				env = setEnv(env, "TODOS_SOCKET="+socket)
				f := fakeserver.New()
				t.Cleanup(f.Close)
				whenExists(t, marker, func() {
					time.Sleep(300 * time.Millisecond)
					if err := f.ServeUnix(socket); err != nil {
						t.Error(err)
					}
				})
			} else {
				if realserver.Repo() == "" {
					t.Skip("the real server's sources are not here")
				}
				// The real server chooses its own folder, so start it as the command
				// would find it: at a socket path decided up front.
				rs := realserver.Prepare(t)
				env = setEnv(env, "TODOS_SOCKET="+rs.Socket)
				whenExists(t, marker, func() { rs.Run(t) })
			}

			began := time.Now()
			out := ok(t, env, "add", "Added after the app was started")
			if !strings.Contains(out, "Added after the app was started") {
				t.Errorf("add: %q", out)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Errorf("the start command was not run")
			}
			if time.Since(began) > 9*time.Second {
				t.Errorf("starting took %s", time.Since(began))
			}
			// Now that it is running, the start command is not run again.
			os.Remove(marker)
			ok(t, env, "ls")
			if _, err := os.Stat(marker); err == nil {
				t.Errorf("the start command ran although the app was already up")
			}
		})
	}
}

func TestLocalAppFailsToStart(t *testing.T) {
	env := baseEnv(t) // the start command is `false`, and nothing is on the socket

	// The start command itself fails.
	r := fails(t, env, 7, "could not start Todos", "ls")
	if r.stdout != "" {
		t.Errorf("stdout: %q", r.stdout)
	}

	// It runs, but the app never comes up: a clear message after the timeout.
	env = setEnv(env, "TODOS_LAUNCH_CMD=true")
	env = setEnv(env, "TODOS_START_TIMEOUT=1")
	began := time.Now()
	fails(t, env, 7, "did not start within 1s", "ls")
	if took := time.Since(began); took < 900*time.Millisecond || took > 5*time.Second {
		t.Errorf("gave up after %s, want about 1s", took)
	}

	// The app is up (something answers on its port) but has no socket: say that,
	// since waiting longer or starting it again will not help.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	old := fakeserver.New()
	t.Cleanup(old.Close)
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			conn.Write([]byte("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")) //nolint:errcheck
			conn.Close()
		}
	}()
	t.Cleanup(func() { l.Close() })
	env = setEnv(env, fmt.Sprintf("TODO_PORT=%d", l.Addr().(*net.TCPAddr).Port))
	fails(t, env, 7, "running, but its socket for the todos command is not there", "ls")

	// A stale socket file (left by a copy that crashed) is "not running" too.
	stale := filepath.Join(realserver.ShortDir(t), "stale.sock")
	sock, err := net.Listen("unix", stale)
	if err != nil {
		t.Fatal(err)
	}
	sock.(*net.UnixListener).SetUnlinkOnClose(false)
	sock.Close()
	env = setEnv(setEnv(baseEnv(t), "TODOS_SOCKET="+stale), "TODOS_LAUNCH_CMD=false")
	fails(t, env, 7, "could not start Todos", "ls")
}

// ---------- another machine: the token ----------

func TestRevokedToken(t *testing.T) {
	only(t, false, func(t *testing.T, b *backend) {
		ok(t, b.env, "add", "Before the token was rotated")
		b.rotate()

		r := fails(t, b.env, 6, "access token was rejected.*todos pair", "ls")
		if r.stdout != "" {
			t.Errorf("stdout: %q", r.stdout)
		}
		r = fails(t, b.env, 6, "rejected", "add", "After")
		// The old token must not be shown anywhere.
		var token string
		if b.fake != nil {
			token = "fake-token-0123456789abcdef0123456789abcdef"
		}
		for _, text := range []string{r.stdout, r.stderr} {
			if token != "" && strings.Contains(text, token) {
				t.Errorf("the token was printed: %s", text)
			}
		}
		// Watching does not keep knocking with a rejected token.
		began := time.Now()
		fails(t, b.env, 6, "rejected", "watch")
		if time.Since(began) > 5*time.Second {
			t.Errorf("watch kept retrying a rejected token for %s", time.Since(began))
		}
		if b.fake != nil {
			wrong := 0
			for _, req := range b.fake.Requests() {
				if req.Header.Get("Authorization") == "Bearer "+token && strings.HasPrefix(req.Path, "/api/v1/") {
					wrong++
				}
			}
			if wrong > 8 {
				t.Errorf("%d requests carried the old token", wrong)
			}
		}

		// Pairing again with the new token puts things right.
		newToken := "rotated-token-0123456789abcdef0123456789"
		if b.real != nil {
			newToken = b.real.Token()
		}
		var url string
		for _, line := range strings.Split(ok(t, b.env, "profiles"), "\n") {
			if fields := strings.Split(line, "\t"); len(fields) > 1 && fields[0] == "hub" {
				url = fields[1]
			}
		}
		pair(t, b.env, url, newToken)
		if got := rows(ok(t, b.env, "ls")); len(got) != 1 {
			t.Errorf("after pairing again: %v", got)
		}
	})
}

func TestPairing(t *testing.T) {
	only(t, false, func(t *testing.T, b *backend) {
		// What pairing wrote: a config with no token in it, and a token file only the user can read.
		var dir string
		for _, e := range b.env {
			if strings.HasPrefix(e, "XDG_CONFIG_HOME=") {
				dir = filepath.Join(strings.TrimPrefix(e, "XDG_CONFIG_HOME="), "todos")
			}
		}
		token := b.client.Token
		config, err := os.ReadFile(filepath.Join(dir, "config.json"))
		if err != nil || strings.Contains(string(config), token) {
			t.Fatalf("config.json (%v) must not hold the token: %s", err, config)
		}
		info, err := os.Stat(filepath.Join(dir, "credentials.json"))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("credentials.json: %v, mode %v", err, info.Mode().Perm())
		}
		if dirInfo, _ := os.Stat(dir); dirInfo.Mode().Perm() != 0o700 {
			t.Errorf("the config folder is %v, want 0700", dirInfo.Mode().Perm())
		}

		url := decode[map[string]any](t, ok(t, b.env, "status", "--json"))["address"].(string)

		// A wrong token: refused, and nothing is saved under the new name.
		r := run(t, b.env, "not-the-token\n", "pair", url, "--token-stdin", "--name", "other")
		if r.code != 6 || !strings.Contains(r.stderr, "did not accept that access token") {
			t.Fatalf("pair with a wrong token: exit %d: %s", r.code, r.stderr)
		}
		if strings.Contains(r.stderr+r.stdout, "not-the-token") {
			t.Errorf("the token was echoed: %s", r.stderr)
		}
		if out := ok(t, b.env, "profiles"); strings.Contains(out, "other") {
			t.Errorf("a failed pairing was saved:\n%s", out)
		}

		// No token and nobody to ask: say how to give one.
		fails(t, b.env, 2, "--token-stdin", "pair", url)
		// The token is never an argument.
		fails(t, b.env, 2, "one address", "pair", url, token)

		// TODOS_TOKEN, and the link the Mac's pairing code holds.
		ok(t, setEnv(b.env, "TODOS_TOKEN="+token), "pair", url, "--name", "second")
		link := "todos-pair:?v=1&u=" + strings.ReplaceAll(strings.ReplaceAll(url, ":", "%3A"), "/", "%2F") + "&t=" + token
		r = run(t, b.env, link+"\n", "pair", "--token-stdin", "--name", "third")
		if r.code != 0 {
			t.Fatalf("pair with a pairing link: exit %d: %s", r.code, r.stderr)
		}
		listed := decode[map[string]any](t, ok(t, b.env, "profiles", "--json"))
		paired := 0
		for _, p := range listed["profiles"].([]any) {
			if p.(map[string]any)["name"] != "local" { // this Mac's own, which is listed on a Mac
				paired++
			}
		}
		if paired != 3 || listed["default"] != "hub" {
			t.Errorf("profiles: %v", listed)
		}

		// Choosing between them.
		ok(t, b.env, "ls", "--profile", "second")
		ok(t, setEnv(b.env, "TODOS_PROFILE=third"), "ls")
		fails(t, b.env, 9, `no profile named "nope"`, "ls", "-p", "nope")
		ok(t, b.env, "profiles", "use", "third")
		if got := decode[map[string]any](t, ok(t, b.env, "status", "--json"))["profile"]; got != "third" {
			t.Errorf("after `profiles use third`, status says %v", got)
		}
		ok(t, b.env, "profiles", "rm", "third")
		ok(t, b.env, "profiles", "rm", "second")
		creds, _ := os.ReadFile(filepath.Join(dir, "credentials.json"))
		if strings.Contains(string(creds), "second") || strings.Contains(string(creds), "third") {
			t.Errorf("removed profiles' tokens are still in the file: %s", creds)
		}
		fails(t, b.env, 3, "no profile named", "profiles", "rm", "third")

		// A token file that others can read is refused, like an SSH key.
		if err := os.Chmod(filepath.Join(dir, "credentials.json"), 0o644); err != nil {
			t.Fatal(err)
		}
		fails(t, b.env, 1, "can be read by other users.*chmod 600", "ls")
	})
}

func TestNoProfile(t *testing.T) {
	env := setEnv(baseEnv(t), "TODOS_SOCKET=") // nothing paired; no socket chosen
	r := run(t, env, "", "ls")
	// On a Mac the local profile is the fallback and the app is "started" (here: false).
	// Anywhere else there is nothing to talk to until `todos pair`.
	if r.code != 7 && r.code != 9 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if r.code == 9 && !strings.Contains(r.stderr, "todos pair") {
		t.Errorf("should point at `todos pair`: %s", r.stderr)
	}
}

// ---------- another machine: the Mac, the app, the tailnet ----------

func TestRemoteAppNotRunning(t *testing.T) {
	// The Mac answers (the relay stands in for `tailscale serve`) but Todos is
	// not running behind it.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	relay := realserver.NewRelay(t, "http://"+addr)
	f := fakeserver.New()
	t.Cleanup(f.Close)

	env := setEnv(baseEnv(t), "TODOS_CA_FILE="+relay.CAFile(t))
	writeProfile(t, env, relay.URL, "", f.Token())

	// With no SSH host there is nothing to try: say what is wrong and how to fix it.
	r := fails(t, env, 5, "is on, but Todos isn't running there.*profiles ssh hub", "ls")
	if r.stdout != "" {
		t.Errorf("stdout: %q", r.stdout)
	}

	// With one, the app is started over SSH and the command goes on.
	marker := filepath.Join(t.TempDir(), "ssh-args")
	ssh := script(t, `printf '%s\n' "$@" > `+marker)
	env = setEnv(setEnv(env, "TODOS_SSH="+ssh), "TODOS_START_TIMEOUT=10")
	ok(t, env, "profiles", "ssh", "hub", "my-mac")
	whenExists(t, marker, func() {
		time.Sleep(300 * time.Millisecond)
		if err := f.ServeTCPAt(addr); err != nil {
			t.Error(err)
		}
	})
	out := ok(t, env, "add", "Added after an SSH start")
	if !strings.Contains(out, "Added after an SSH start") {
		t.Errorf("add: %q", out)
	}
	args, _ := os.ReadFile(marker)
	want := "-o\nBatchMode=yes\n-o\nConnectTimeout=10\n--\nmy-mac\nopen -g -a Todos --args --background\n"
	if string(args) != want {
		t.Errorf("ssh was run with:\n%s\nwant:\n%s", args, want)
	}
}

func TestRemoteStartOverSSHFails(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	relay := realserver.NewRelay(t, "http://"+addr)
	env := setEnv(baseEnv(t), "TODOS_CA_FILE="+relay.CAFile(t))
	writeProfile(t, env, relay.URL, "my-mac", "some-token-0123456789abcdef0123456789abcdef")

	// SSH itself fails (not logged in to the desktop, no key, host down).
	ssh := script(t, `echo "The window server could not be contacted" >&2; exit 1`)
	fails(t, setEnv(env, "TODOS_SSH="+ssh), 7, "Starting it over SSH \\(my-mac\\) did not work: The window server could not be contacted.*logged in to the Mac's desktop", "ls")

	// SSH works but the app never answers.
	env = setEnv(setEnv(env, "TODOS_SSH="+script(t, "exit 0")), "TODOS_START_TIMEOUT=1")
	fails(t, env, 7, "did not start within 1s", "ls")
}

func TestRemoteAccessOff(t *testing.T) {
	b := realRemote(t)
	ok(t, b.env, "ls")
	b.real.RemoteAccess(false)
	fails(t, b.env, 5, "Remote Access is turned off in Todos", "ls")
	b.real.RemoteAccess(true)
	ok(t, b.env, "ls")
}

func TestWrongTailscaleAccount(t *testing.T) {
	// The Mac only answers its owner's Tailscale account.
	rs := realserver.Start(t)
	relay := realserver.NewRelay(t, rs.URL)
	relay.Login = "someone-else@example.com"
	env := setEnv(baseEnv(t), "TODOS_CA_FILE="+relay.CAFile(t))
	writeProfile(t, env, relay.URL, "", rs.Token())
	fails(t, env, 6, "Tailscale account is not the Mac owner's", "ls")
}

func TestUnreachable(t *testing.T) {
	env := baseEnv(t)

	// A tailnet name that does not resolve: Tailscale is not running here.
	writeProfile(t, env, "https://no-such-mac.example.ts.net", "", "t")
	fails(t, env, 5, "can't find no-such-mac.example.ts.net: Tailscale isn't running on this machine", "ls")

	// Nothing listening at the address at all (the port is closed).
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	writeProfile(t, env, "https://"+addr, "", "t")
	fails(t, env, 5, "nothing is serving Todos there.*Remote Access", "ls")

	// A certificate that is not trusted is not ignored.
	f := fakeserver.New()
	t.Cleanup(f.Close)
	url, _ := f.ServeTLS()
	writeProfile(t, env, url, "", f.Token())
	fails(t, env, 5, "can't trust", "ls")
	if len(f.Requests()) != 0 {
		t.Errorf("a request reached a server whose certificate was not trusted")
	}
}

func TestUnreachableMac(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for a connection to time out")
	}
	// An address that swallows packets, as a sleeping Mac's does.
	env := baseEnv(t)
	writeProfile(t, env, "https://192.0.2.1", "", "t") // TEST-NET-1: never routed
	began := time.Now()
	fails(t, env, 5, "can't reach 192.0.2.1.*(asleep|offline)", "ls")
	if took := time.Since(began); took > 12*time.Second {
		t.Errorf("took %s to give up", took)
	}
}

func TestVersionMismatch(t *testing.T) {
	// The app asks for a newer command.
	b := fakeSocket(t)
	b.fake.Configure(func(f *fakeserver.Server) { f.MinCLI = "99.0.0" })
	fails(t, b.env, 8, `this todos command \(0\.\d+\.\d+\) is too old.*needs 99.0.0 or later`, "ls")

	// The app is too old for the command: it has no GET /info.
	for _, make := range []func(*testing.T) *backend{fakeSocket, fakeRemote} {
		b := make(t)
		b.fake.Configure(func(f *fakeserver.Server) { f.Revision = 3 })
		fails(t, b.env, 8, "the Todos app is too old.*API revision 3.*update Todos on the Mac", "ls")
	}
}

func TestRateLimitedAndBusy(t *testing.T) {
	b := fakeRemote(t)
	b.fake.FailNext("GET", "/api/v1/tasks", 429, `{"error":{"code":"rate_limited","message":"Too many changes in a short time. Try again shortly."}}`)
	fails(t, b.env, 10, "Too many changes", "ls")
	b.fake.FailNext("GET", "/api/v1/events", 503, `{"error":{"code":"busy","message":"Too many live connections."}}`)
	// watch waits and tries again rather than giving up; it is still running after a moment.
	w := startWatch(t, b.env)
	b.add(t, "Seen after the busy answer")
	w.expect(t, "created", "Seen after the busy answer")
}
