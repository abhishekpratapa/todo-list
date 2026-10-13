// Package realserver runs the real Todos server for this client's tests: the
// app's own src/server.js, from the repository this module sits in, on port
// 7442 with a data file, token and socket of its own. Never the installed app,
// its port (7420), its socket or its data.
//
// The port is fixed, so only one can run at a time: every test that needs it
// lives in one package (internal/integration).
package realserver

import (
	"bufio"
	"crypto/tls"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

//go:embed harness.mjs
var harness []byte

const (
	Port = 7442
	// The Mac's name on the pretend tailnet, and the account that owns it.
	TailnetHost = "test-mac.example.ts.net"
	Owner       = "owner@example.com"
)

// Server is a running copy.
type Server struct {
	Dir    string // everything it owns is in here
	Socket string
	URL    string // the port, reached directly on this machine: http://127.0.0.1:7442

	mu    sync.Mutex
	token string
	cmd   *exec.Cmd
	stdin interface{ Write([]byte) (int, error) }
	lines *bufio.Scanner
}

// Repo finds the repository root (the folder holding src/server.js) above the
// current directory, or "".
func Repo() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "src", "server.js")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// ShortDir makes a temporary folder with a short path. A socket's path must fit
// in 103 bytes, and the usual temporary folder on macOS is too deep.
func ShortDir(tb testing.TB) string {
	tb.Helper()
	dir, err := os.MkdirTemp("/tmp", "tds")
	if err != nil {
		tb.Fatal(err)
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	tb.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// Start runs the server, or skips the test where it can't be run: no Node, the
// app's sources not next to this module, or the port in use.
func Start(tb testing.TB) *Server {
	tb.Helper()
	s := Prepare(tb)
	if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", Port), 300*time.Millisecond); err == nil {
		conn.Close()
		tb.Skipf("port %d is in use, so the real server can't be started for this test", Port)
	}
	if err := s.start(tb); err != nil {
		tb.Fatal(err)
	}
	return s
}

func (s *Server) start(tb testing.TB) error {
	node, err := exec.LookPath("node")
	if err != nil {
		return err
	}
	script := filepath.Join(s.Dir, "harness.mjs")
	if err := os.WriteFile(script, harness, 0o600); err != nil {
		return err
	}
	cmd := exec.Command(node, script)
	cmd.Dir = s.Dir
	cmd.Env = append(os.Environ(),
		"TODOS_REPO="+Repo(),
		"TODO_DATA_FILE="+filepath.Join(s.Dir, "data", "todos.json"),
		fmt.Sprintf("TODO_PORT=%d", Port),
		"TODOS_SOCKET="+s.Socket,
		"TODOS_TOKEN_FILE="+filepath.Join(s.Dir, "token"),
		"TODOS_TAILNET_HOST="+TailnetHost,
		"TODOS_OWNER="+Owner,
		"TODOS_CLAUDE_BIN="+filepath.Join(s.Dir, "no-claude-here"),
	)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cmd, s.stdin, s.lines = cmd, stdin, bufio.NewScanner(stdout)
	s.mu.Unlock()
	tb.Cleanup(s.Stop)

	var hello struct {
		Port          int
		Socket        string
		SocketProblem string
		Token         string
	}
	if err := s.read(&hello); err != nil {
		return fmt.Errorf("the real server did not start: %v", err)
	}
	if hello.Socket == "" {
		return fmt.Errorf("the real server opened no socket: %s", hello.SocketProblem)
	}
	s.mu.Lock()
	s.token = hello.Token
	s.mu.Unlock()
	return nil
}

func (s *Server) read(into any) error {
	done := make(chan error, 1)
	go func() {
		if !s.lines.Scan() {
			done <- fmt.Errorf("it exited (%v)", s.lines.Err())
			return
		}
		done <- json.Unmarshal(s.lines.Bytes(), into)
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(15 * time.Second):
		return fmt.Errorf("no answer within 15s")
	}
}

func (s *Server) command(name string, into any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.stdin.Write([]byte(name + "\n")); err != nil {
		panic(err)
	}
	if err := s.read(into); err != nil {
		panic(err)
	}
}

// Token is the access token, as Todos → Remote Access → Copy Access Token gives it.
func (s *Server) Token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// Rotate replaces the access token, as the app's Rotate Access Token does.
func (s *Server) Rotate() string {
	var out struct{ Token string }
	s.command("rotate", &out)
	s.mu.Lock()
	s.token = out.Token
	s.mu.Unlock()
	return out.Token
}

// RemoteAccess turns Remote Access on or off.
func (s *Server) RemoteAccess(on bool) {
	var out map[string]any
	if on {
		s.command("on", &out)
	} else {
		s.command("off", &out)
	}
}

// Stop ends the server. Its socket file goes with it.
func (s *Server) Stop() {
	s.mu.Lock()
	cmd := s.cmd
	s.cmd = nil
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}

// Relay stands in for `tailscale serve`: an HTTPS address that relays to a
// local server, adding the headers Tailscale adds. It is what a machine
// elsewhere on the tailnet connects to. When nothing is listening behind it, it
// answers 502, as a reverse proxy does.
type Relay struct {
	URL string // https://127.0.0.1:port
	CA  []byte // the certificate to trust, PEM
	srv *httptest.Server
	// Login is the Tailscale account requests appear to come from.
	Login string
}

// NewRelay relays to target (http://127.0.0.1:port).
func NewRelay(tb testing.TB, target string) *Relay {
	tb.Helper()
	to, err := url.Parse(target)
	if err != nil {
		tb.Fatal(err)
	}
	r := &Relay{Login: Owner}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(to)
			pr.Out.Host = to.Host
			pr.Out.Header.Set("X-Forwarded-For", "100.64.0.7")
			pr.Out.Header.Set("X-Forwarded-Host", TailnetHost)
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
			pr.Out.Header.Set("Tailscale-User-Login", r.Login)
			pr.Out.Header.Set("Tailscale-User-Name", "Test Owner")
		},
		FlushInterval: -1, // live updates must not sit in a buffer
		ErrorLog:      nil,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.WriteHeader(http.StatusBadGateway)
		},
	}
	r.srv = httptest.NewUnstartedServer(proxy)
	r.srv.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	r.srv.StartTLS()
	tb.Cleanup(r.srv.Close)
	r.URL = r.srv.URL
	r.CA = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: r.srv.Certificate().Raw})
	return r
}

// CAFile writes the relay's certificate where TODOS_CA_FILE can point at it.
func (r *Relay) CAFile(tb testing.TB) string {
	tb.Helper()
	file := filepath.Join(tb.TempDir(), "ca.pem")
	if err := os.WriteFile(file, r.CA, 0o600); err != nil {
		tb.Fatal(err)
	}
	return file
}

// Prepare decides where a server will be (its folder and socket) without
// starting it, for tests where something else must happen first. Skips the
// test where the server can't be run.
func Prepare(tb testing.TB) *Server {
	tb.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		tb.Skip("the real server needs Node, which was not found")
	}
	if Repo() == "" {
		tb.Skip("the real server's sources (src/server.js) are not next to this module")
	}
	dir := ShortDir(tb)
	return &Server{Dir: dir, Socket: filepath.Join(dir, "t.sock"), URL: fmt.Sprintf("http://127.0.0.1:%d", Port)}
}

// Run starts a server made by Prepare.
func (s *Server) Run(tb testing.TB) {
	if err := s.start(tb); err != nil {
		tb.Error(err)
	}
}
