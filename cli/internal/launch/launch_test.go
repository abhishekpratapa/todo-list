package launch

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOpenCommand(t *testing.T) {
	// By name when this isn't the copy inside an app.
	want := []string{"/usr/bin/open", "-g", "-a", "Todos", "--args", "--background"}
	if got := OpenCommand(""); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v", got)
	}
	// The exact bundle when it is, so another copy on the disk is never the one started.
	want[3] = "/Applications/Todos.app"
	if got := OpenCommand("/Applications/Todos.app"); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v", got)
	}
}

func TestBundleFor(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	inside := filepath.Join(root, "Apps", "Todos.app", "Contents", "Resources", "bin", "todos")
	os.MkdirAll(filepath.Dir(inside), 0o755) //nolint:errcheck
	os.WriteFile(inside, nil, 0o755)         //nolint:errcheck
	bundle := filepath.Join(root, "Apps", "Todos.app")
	if got := BundleFor(inside); got != bundle {
		t.Errorf("the copy in the app: %q", got)
	}
	// As installed: a link on the PATH pointing into the app.
	link := filepath.Join(root, "bin", "todos")
	os.MkdirAll(filepath.Dir(link), 0o755) //nolint:errcheck
	if err := os.Symlink(inside, link); err != nil {
		t.Fatal(err)
	}
	if got := BundleFor(link); got != bundle {
		t.Errorf("through the link: %q", got)
	}
	for _, elsewhere := range []string{"/usr/local/bin/todos", filepath.Join(root, "cli", "dist", "todos-darwin-arm64"), "", "/Applications/Todos.app/Contents/MacOS/Todos"} {
		if got := BundleFor(elsewhere); got != "" {
			t.Errorf("BundleFor(%q) = %q", elsewhere, got)
		}
	}
}

func TestSSHCommand(t *testing.T) {
	got, err := SSHCommand("", "my-mac")
	want := []string{"ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "my-mac", "open -g -a Todos --args --background"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, %v", got, err)
	}
	// user@host and a tailnet name are hosts too; a different ssh can be named.
	for _, host := range []string{"me@my-mac", "my-mac.tail1234.ts.net", "100.64.0.3"} {
		if got, err := SSHCommand("/opt/ssh", host); err != nil || got[0] != "/opt/ssh" || got[6] != host {
			t.Errorf("%s: %v, %v", host, got, err)
		}
	}
	// It never asks for a password: BatchMode makes ssh fail instead.
	if !strings.Contains(strings.Join(want, " "), "BatchMode=yes") {
		t.Error("BatchMode must be on")
	}
	// Nothing that ssh would read as an option, or that a shell would act on.
	for _, bad := range []string{"", " ", "-oProxyCommand=evil", "my mac", "mac;rm -rf ~", "$(evil)", "mac`x`", "a|b", "mac\nother"} {
		if got, err := SSHCommand("", bad); err == nil {
			t.Errorf("SSHCommand(%q) = %v, want an error", bad, got)
		}
	}
}

func TestWaiterStartsThenPollsUntilHealthy(t *testing.T) {
	var started, polls atomic.Int32
	w := Waiter{
		Start: func(context.Context) error { started.Add(1); return nil },
		Healthy: func(context.Context) error {
			if polls.Add(1) < 5 {
				return errors.New("not yet")
			}
			return nil
		},
		Timeout: 5 * time.Second, Interval: 10 * time.Millisecond,
	}
	began := time.Now()
	if err := w.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if started.Load() != 1 || polls.Load() != 5 {
		t.Errorf("started %d times, polled %d times", started.Load(), polls.Load())
	}
	if took := time.Since(began); took < 40*time.Millisecond || took > 2*time.Second {
		t.Errorf("took %s", took)
	}
}

func TestWaiterGivesUp(t *testing.T) {
	var polls atomic.Int32
	w := Waiter{
		Start:   func(context.Context) error { return nil },
		Healthy: func(context.Context) error { polls.Add(1); return errors.New("no") },
		Timeout: 300 * time.Millisecond, Interval: 50 * time.Millisecond,
	}
	began := time.Now()
	err := w.Wait(context.Background())
	var failed *StartError
	if !errors.As(err, &failed) || !strings.Contains(err.Error(), "did not start within") {
		t.Fatalf("got %v", err)
	}
	if took := time.Since(began); took < 250*time.Millisecond || took > 2*time.Second {
		t.Errorf("gave up after %s", took)
	}
	if n := polls.Load(); n < 4 || n > 9 {
		t.Errorf("polled %d times in 300ms at 50ms intervals", n)
	}
}

func TestWaiterWhenStartingFails(t *testing.T) {
	polled := false
	w := Waiter{
		Start:   func(context.Context) error { return errors.New("LSOpenURLsWithRole() failed with error -610") },
		Healthy: func(context.Context) error { polled = true; return nil },
		Timeout: time.Second, Interval: 10 * time.Millisecond,
	}
	err := w.Wait(context.Background())
	var failed *StartError
	if !errors.As(err, &failed) || !strings.Contains(err.Error(), "could not start Todos: LSOpenURLsWithRole") || polled {
		t.Errorf("got %v (polled: %v)", err, polled)
	}
}

func TestWaiterStopsWhenInterrupted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	w := Waiter{
		Start:   func(context.Context) error { return nil },
		Healthy: func(context.Context) error { return errors.New("no") },
		Timeout: time.Minute, Interval: 20 * time.Millisecond,
	}
	time.AfterFunc(100*time.Millisecond, cancel)
	began := time.Now()
	if err := w.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("got %v", err)
	}
	if time.Since(began) > 2*time.Second {
		t.Error("kept waiting after being interrupted")
	}
}

func TestWaiterShowsProgressAroundTheWait(t *testing.T) {
	shown := false
	w := Waiter{
		Start: func(context.Context) error { return nil }, Healthy: func(context.Context) error { return nil },
		Timeout: time.Second, Interval: time.Millisecond,
		Waiting: func(wait func() error) error { shown = true; return wait() },
	}
	if err := w.Wait(context.Background()); err != nil || !shown {
		t.Errorf("err %v, shown %v", err, shown)
	}
}

func TestRunReportsTheLastLine(t *testing.T) {
	if err := Run(context.Background(), []string{"/bin/sh", "-c", "exit 0"}); err != nil {
		t.Errorf("a command that works: %v", err)
	}
	err := Run(context.Background(), []string{"/bin/sh", "-c", "echo first; echo 'ssh: connect to host my-mac port 22: Operation timed out' >&2; exit 255"})
	if err == nil || err.Error() != "ssh: connect to host my-mac port 22: Operation timed out" {
		t.Errorf("got %v", err)
	}
	if err := Run(context.Background(), []string{"/no/such/program"}); err == nil {
		t.Error("a program that isn't there should fail")
	}
	if err := RunShell(context.Background(), "test 1 = 1 && exit 3"); err == nil {
		t.Error("RunShell should report a failing line")
	}
}
