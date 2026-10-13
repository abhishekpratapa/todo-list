package integration

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"todos/internal/api"
)

// watcher is a running `todos watch --json`.
type watcher struct {
	cmd    *exec.Cmd
	lines  chan string
	mu     sync.Mutex
	stderr strings.Builder
}

func startWatch(t *testing.T, env []string, args ...string) *watcher {
	t.Helper()
	w := &watcher{lines: make(chan string, 64)}
	w.cmd = exec.Command(bin, append([]string{"watch", "--json"}, args...)...)
	w.cmd.Env = env
	stdout, err := w.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := w.cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := w.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
		for scanner.Scan() {
			w.lines <- scanner.Text()
		}
		close(w.lines)
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			w.mu.Lock()
			w.stderr.WriteString(scanner.Text() + "\n")
			w.mu.Unlock()
		}
	}()
	t.Cleanup(func() { w.stop() })
	time.Sleep(400 * time.Millisecond) // let it take its first reading and connect
	return w
}

// next waits for the next change.
func (w *watcher) next(t *testing.T) cliChange {
	t.Helper()
	select {
	case line, open := <-w.lines:
		if !open {
			w.mu.Lock()
			defer w.mu.Unlock()
			t.Fatalf("watch ended: %s", w.stderr.String())
		}
		var c cliChange
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			t.Fatalf("watch printed something that is not JSON: %s", line)
		}
		return c
	case <-time.After(10 * time.Second):
		t.Fatal("watch printed nothing for 10s")
	}
	return cliChange{}
}

// expect waits for a change of this kind to a task with this title.
func (w *watcher) expect(t *testing.T, event, title string) cliChange {
	t.Helper()
	c := w.next(t)
	if c.Event != event || c.Task.Title != title {
		t.Fatalf("watch reported %s %q, want %s %q", c.Event, c.Task.Title, event, title)
	}
	return c
}

// stop interrupts it, as Ctrl-C does, and returns its exit code.
func (w *watcher) stop() int {
	if w.cmd.ProcessState != nil {
		return w.cmd.ProcessState.ExitCode()
	}
	_ = w.cmd.Process.Signal(syscall.SIGINT)
	done := make(chan struct{})
	go func() { _ = w.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = w.cmd.Process.Kill()
		<-done
	}
	return w.cmd.ProcessState.ExitCode()
}

type cliChange struct {
	Event   string   `json:"event"`
	Version int      `json:"version"`
	Task    api.Task `json:"task"`
	Changed []string `json:"changed"`
}

func TestWatch(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		ctx := context.Background()
		existing := b.add(t, "Was already there")
		w := startWatch(t, b.env)

		// Changes made by someone else (here: straight through the API) show up.
		created := b.add(t, "Made elsewhere !high")
		c := w.expect(t, "created", "Made elsewhere")
		if c.Task.ID != created.ID || c.Version == 0 || c.Task.Priority != "high" {
			t.Errorf("created: %+v", c)
		}

		if _, err := b.client.Patch(ctx, created.ID, map[string]any{"status": "in_progress", "due": "2031-01-02"}, created.Rev); err != nil {
			t.Fatal(err)
		}
		c = w.expect(t, "updated", "Made elsewhere")
		if strings.Join(c.Changed, ",") != "due,status" || c.Task.Status != "in_progress" {
			t.Errorf("updated: changed %v, status %s", c.Changed, c.Task.Status)
		}

		if _, err := b.client.Comment(ctx, existing.ID, "A note"); err != nil {
			t.Fatal(err)
		}
		if c = w.expect(t, "updated", "Was already there"); strings.Join(c.Changed, ",") != "comments" {
			t.Errorf("a comment changes the count of comments: %v", c.Changed)
		}

		if err := b.client.Delete(ctx, created.ID, api.AnyRev); err != nil {
			t.Fatal(err)
		}
		if c = w.expect(t, "deleted", "Made elsewhere"); c.Task.ID != created.ID {
			t.Errorf("deleted: %+v", c)
		}

		// And so do changes made with the command itself, from another terminal.
		ok(t, b.env, "done", fmt.Sprint(existing.ID))
		if c = w.expect(t, "updated", "Was already there"); c.Task.Status != "done" {
			t.Errorf("done: %+v", c)
		}

		// Ctrl-C ends it cleanly.
		if code := w.stop(); code != 0 {
			t.Errorf("watch exited %d after being interrupted", code)
		}
	})
}

func TestWatchPlain(t *testing.T) {
	b := fakeSocket(t)
	cmd := exec.Command(bin, "watch")
	cmd.Env = b.env
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill() //nolint:errcheck
	time.Sleep(400 * time.Millisecond)
	b.add(t, "Plain line tomorrow")
	line := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			line <- scanner.Text()
		}
	}()
	select {
	case got := <-line:
		fields := strings.Split(got, "\t")
		if len(fields) != 6 || fields[0] != "created" || fields[5] != "Plain line" || ansi.MatchString(got) {
			t.Errorf("watch printed %q", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("watch printed nothing")
	}
}

func TestWatchReconnects(t *testing.T) {
	// The stream drops (the Mac slept, the network changed). Watch opens it again
	// and reports what happened in between.
	for _, make := range []func(*testing.T) *backend{fakeSocket, fakeRemote} {
		b := make(t)
		t.Run(b.name, func(t *testing.T) {
			w := startWatch(t, b.env)
			b.add(t, "Before the drop")
			w.expect(t, "created", "Before the drop")

			b.fake.DropStreams()
			b.add(t, "While disconnected") // nobody is listening when this happens
			w.expect(t, "created", "While disconnected")

			b.add(t, "After reconnecting")
			w.expect(t, "created", "After reconnecting")
			if n := b.fake.Streams(); n != 1 {
				t.Errorf("%d streams open, want 1", n)
			}
		})
	}
}
