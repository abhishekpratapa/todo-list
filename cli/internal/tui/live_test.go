package tui

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/exp/teatest/v2"

	"todos/internal/api"
	"todos/internal/fakeserver"
)

// watched wraps the board so a test can see each frame it draws. Reading the
// terminal output instead would mean piecing frames together from the changed
// cells the renderer sends.
type watched struct {
	Model
	latest *atomic.Pointer[frame]
}

type frame struct {
	screen string // what is drawn, without styling
	m      Model
}

func (w watched) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := w.Model.Update(msg)
	m := next.(Model)
	w.latest.Store(&frame{screen: plain(m), m: m})
	return watched{m, w.latest}, cmd
}

// running is the board as a program, talking to a fake Todos over a socket.
type running struct {
	*teatest.TestModel
	fake   *fakeserver.Server
	latest *atomic.Pointer[frame]
}

func start(t *testing.T, width, height int, seed func(*fakeserver.Server)) *running {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "tdt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := fakeserver.New()
	if seed != nil {
		seed(f)
	}
	socket := filepath.Join(dir, "t.sock")
	if err := f.ServeUnix(socket); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := Options{Client: api.NewSocket(socket), Profile: "local", Dark: true, FixedTheme: true, Loc: time.UTC}
	r := &running{fake: f, latest: &atomic.Pointer[frame]{}}
	r.latest.Store(&frame{})
	r.TestModel = teatest.NewTestModel(t, watched{New(ctx, opts), r.latest}, teatest.WithInitialTermSize(width, height))
	t.Cleanup(func() { _ = r.Quit() })
	return r
}

// until waits for a frame that satisfies ok, and returns it.
func (r *running) until(t *testing.T, what string, ok func(f *frame) bool) *frame {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if f := r.latest.Load(); ok(f) {
			return f
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("never saw %s. The last frame:\n%s", what, r.latest.Load().screen)
	return nil
}

// waitFor waits until text is on screen.
func (r *running) waitFor(t *testing.T, text string) *frame {
	t.Helper()
	return r.until(t, fmt.Sprintf("%q on screen", text), func(f *frame) bool { return strings.Contains(f.screen, text) })
}

// model stops the program and returns the board as it was.
func (r *running) model(t *testing.T) Model {
	t.Helper()
	r.Send(tea.QuitMsg{})
	return r.FinalModel(t, teatest.WithFinalTimeout(5*time.Second)).(watched).Model
}

func TestTheBoardStaysCurrent(t *testing.T) {
	r := start(t, 110, 26, func(f *fakeserver.Server) {
		f.Add("Was there at the start", func(t *fakeserver.Task) { t.Priority = "high" })
	})
	r.waitFor(t, "Was there at the")
	r.waitFor(t, "● live")

	// Someone else adds a task, moves one, and deletes one. None of it needs a key press here.
	r.fake.Add("Added from the iPhone")
	r.waitFor(t, "Added from the")
	r.fake.Touch(1, "claude", "moved todo → in_progress", func(t *fakeserver.Task) { t.Status = "in_progress"; t.Assignee = "claude" })
	r.waitFor(t, "claude")
	doomed := r.fake.Add("Soon deleted")
	r.waitFor(t, "Soon deleted")
	r.fake.Remove(doomed.ID)
	r.until(t, "the deleted task gone", func(f *frame) bool { return !strings.Contains(f.screen, "Soon deleted") })

	// The connection drops. The board says so, reconnects, and catches up on what it missed.
	r.fake.DropStreams()
	r.fake.Add("While disconnected")
	r.waitFor(t, "reconnecting")
	r.waitFor(t, "While disconnected")
	r.waitFor(t, "● live")

	m := r.model(t)
	cols := m.columns()
	if len(cols[0]) != 2 || len(cols[1]) != 1 || cols[1][0].ID != 1 || cols[1][0].Assignee != "claude" {
		t.Errorf("the board ended up with %d to do and %d in progress", len(cols[0]), len(cols[1]))
	}
	for _, task := range m.tasks {
		if task.ID == doomed.ID {
			t.Error("the deleted task is still on the board")
		}
	}
	if m.live != liveOn || m.version != r.fake.Version() || m.counts.Open != 3 || m.today == "" {
		t.Errorf("live %v, at version %d (the list is at %d), %d open, today %q", m.live, m.version, r.fake.Version(), m.counts.Open, m.today)
	}
}

func TestTheOpenDetailStaysCurrent(t *testing.T) {
	r := start(t, 130, 30, func(f *fakeserver.Server) {
		f.Add("Renew passport", func(t *fakeserver.Task) { t.Notes = "Bring two photos." })
	})
	r.waitFor(t, "Renew passport")
	r.Send(tea.KeyPressMsg{Code: tea.KeyEnter})
	r.waitFor(t, "Bring two photos.")
	r.waitFor(t, "created this task")

	// A comment arrives from Claude while the task is open.
	r.fake.Touch(1, "claude", "edited notes", func(t *fakeserver.Task) {
		t.Activity = append(t.Activity, fakeserver.Activity{At: t.UpdatedAt, By: "claude", Kind: "comment", Text: "Booked for Friday at ten."})
	})
	r.waitFor(t, "Booked for Friday at ten.")

	// It is deleted while open: the detail closes and says why.
	r.fake.Remove(1)
	r.waitFor(t, "that task was deleted")
	if m := r.model(t); m.detail != nil {
		t.Error("the detail of a deleted task should close")
	}
}

func TestKeysReachTheRunningBoard(t *testing.T) {
	r := start(t, 100, 24, func(f *fakeserver.Server) {
		f.Add("Alpha task")
		f.Add("Beta task", func(t *fakeserver.Task) { t.Status = "blocked" })
		f.Add("Gamma task")
	})
	r.waitFor(t, "Gamma task")
	r.Type("j")
	r.Type("/")
	r.Type("beta")
	r.waitFor(t, "/ beta")
	r.Send(tea.KeyPressMsg{Code: tea.KeyEnter})
	r.Send(tea.WindowSizeMsg{Width: 60, Height: 20}) // and a resize on the way
	r.until(t, "the narrow list", func(f *frame) bool { return f.m.narrow() && !f.m.searching })
	r.Type("q")
	m := r.FinalModel(t, teatest.WithFinalTimeout(5*time.Second)).(watched).Model
	if s := m.selected(); s == nil || s.Title != "Beta task" || m.query != "beta" || !m.narrow() {
		t.Errorf("selected %+v, query %q, narrow %v", s, m.query, m.narrow())
	}
}
