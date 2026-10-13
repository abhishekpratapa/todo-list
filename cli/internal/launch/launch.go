// Package launch starts the Todos app when a command needs it and finds it not
// running: on this Mac with `open`, on another over SSH. Either way the app
// starts in the background (no window, nothing brought to the front) and the
// command waits for its health check before going on.
package launch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	// How long to wait for the app on this Mac, and how often to ask. Electron
	// usually has the server up within two or three seconds; the first start
	// after a restart or an update is the slow one.
	LocalTimeout  = 15 * time.Second
	LocalInterval = 100 * time.Millisecond
	// Over SSH and the tailnet everything is slower, and each check is a request.
	RemoteTimeout  = 20 * time.Second
	RemoteInterval = 500 * time.Millisecond
	sshTimeout     = 20 * time.Second
)

// What the app is started with, on this Mac or over SSH.
var backgroundArgs = []string{"--args", "--background"}

var bundleRE = regexp.MustCompile(`^(.*/[^/]+\.app)/Contents/Resources/bin/[^/]+$`)

// BundleFor returns the Todos.app that the program at exe ships inside, or ""
// if it is not inside one. Links are followed first: the command on the PATH is
// a link to the copy in the app.
func BundleFor(exe string) string {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	if m := bundleRE.FindStringSubmatch(exe); m != nil {
		return m[1]
	}
	return ""
}

// OpenCommand is the command that starts the app in the background on this
// Mac. With the bundle this command came in, exactly that copy is started;
// otherwise macOS finds the app by name.
func OpenCommand(bundle string) []string {
	app := "Todos"
	if bundle != "" {
		app = bundle
	}
	return append([]string{"/usr/bin/open", "-g", "-a", app}, backgroundArgs...)
}

// SSHCommand is the command that starts the app on another Mac. It uses the
// user's own SSH setup (config, keys, agent, Tailscale SSH) and never asks for
// a password: BatchMode makes ssh fail instead.
func SSHCommand(ssh, host string) ([]string, error) {
	host = strings.TrimSpace(host)
	if host == "" || strings.HasPrefix(host, "-") || strings.ContainsAny(host, " \t\n'\"`$;&|<>()\\") {
		return nil, fmt.Errorf("%q is not an SSH host", host)
	}
	if ssh == "" {
		ssh = "ssh"
	}
	return []string{ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, "open -g -a Todos --args --background"}, nil
}

// StartError means the app could not be started, or did not come up.
type StartError struct{ Msg string }

func (e *StartError) Error() string { return e.Msg }

// Run runs a start command and reports its failure in a line.
func Run(ctx context.Context, argv []string) error {
	ctx, cancel := context.WithTimeout(ctx, sshTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	said := lastLine(string(out))
	if ctx.Err() == context.DeadlineExceeded {
		said = "it did not finish in time"
	}
	if said == "" {
		said = err.Error()
	}
	return errors.New(said)
}

// RunShell runs a start command given as one line (TODOS_LAUNCH_CMD), for a
// copy of the app that isn't the installed one.
func RunShell(ctx context.Context, line string) error {
	return Run(ctx, []string{"/bin/sh", "-c", line})
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// Waiter starts the app and waits for it.
type Waiter struct {
	Start    func(context.Context) error // starts the app
	Healthy  func(context.Context) error // nil once the app answers its health check
	Timeout  time.Duration
	Interval time.Duration
	// Waiting, if set, wraps the wait: it is given the function that does the
	// waiting, and may show progress around it.
	Waiting func(wait func() error) error
}

// Wait starts the app, then polls until it is healthy or the time is up.
func (w *Waiter) Wait(ctx context.Context) error {
	wait := func() error {
		if err := w.Start(ctx); err != nil {
			return &StartError{"could not start Todos: " + err.Error()}
		}
		deadline := time.Now().Add(w.Timeout)
		tick := time.NewTicker(w.Interval)
		defer tick.Stop()
		for {
			try, cancel := context.WithTimeout(ctx, 2*time.Second)
			err := w.Healthy(try)
			cancel()
			if err == nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if time.Now().After(deadline) {
				return &StartError{fmt.Sprintf("Todos did not start within %s", w.Timeout.Round(time.Second))}
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-tick.C:
			}
		}
	}
	if w.Waiting != nil {
		return w.Waiting(wait)
	}
	return wait()
}

// Executable is the running program's path, for BundleFor.
func Executable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
}
