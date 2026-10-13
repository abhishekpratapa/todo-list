package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"todos/internal/api"
	"todos/internal/fakeserver"
)

// withHabits gives a backend habits to work on: Brush teeth, morning and
// evening, and Gym, three days a week. The command has no way to make a habit,
// so the real server is asked directly, over its socket.
func (b *backend) withHabits(t *testing.T) (brush, gym int) {
	t.Helper()
	if b.fake != nil {
		b.fake.Configure(func(s *fakeserver.Server) { s.Revision = 5 })
		return b.fake.AddHabit("Brush teeth", []string{"Morning", "Evening"}).ID, b.fake.AddHabit("Gym", nil).ID
	}
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", b.real.Socket)
	}}}
	make := func(body string) int {
		res, err := client.Post("http://todos/api/v1/habits", "application/json", bytes.NewReader([]byte(body)))
		if err != nil {
			t.Fatalf("making a habit: %v", err)
		}
		defer res.Body.Close()
		var out struct {
			Habit struct {
				ID int `json:"id"`
			} `json:"habit"`
		}
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 201 {
			t.Fatalf("making a habit: status %d, %v", res.StatusCode, err)
		}
		return out.Habit.ID
	}
	brush = make(`{"name":"Brush teeth","icon":"🪥","color":"blue","schedule":{"kind":"daily","slots":[{"name":"Morning","remind":"07:30"},{"name":"Evening","remind":"21:30"}]}}`)
	gym = make(`{"name":"Gym","schedule":{"kind":"weekly","target":3}}`)
	return brush, gym
}

func (b *backend) habit(t *testing.T, id int) api.Habit {
	t.Helper()
	list, _, err := b.client.Habits(context.Background(), true)
	if err != nil {
		t.Fatalf("listing habits: %v", err)
	}
	for _, h := range list.Habits {
		if h.ID == id {
			return h
		}
	}
	t.Fatalf("no habit #%d", id)
	return api.Habit{}
}

func TestHabits(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		brush, gym := b.withHabits(t)
		row := func(id int, rest string) string { return fmt.Sprintf("%d\t%s\n", id, rest) }

		// The list, as a script sees it: both still to do, the one with times of day first.
		if got, want := ok(t, b.env, "habit"), row(brush, "due\t0/2\t0d\tBrush teeth")+row(gym, "due\t0/3\t0w\tGym"); got != want {
			t.Fatalf("habit:\n%q\nwant\n%q", got, want)
		}
		listed := decode[api.HabitList](t, ok(t, b.env, "habit", "ls", "--json"))
		if len(listed.Habits) != 2 || listed.Habits[0].Name != "Brush teeth" || listed.Zone == "" {
			t.Errorf("habit ls --json: %+v", listed)
		}

		// Checking in a time of day by name; then the other, which completes the day and starts a streak.
		if got := ok(t, b.env, "habit", "done", "brush", "--slot", "morning"); got != row(brush, "due\t1/2\t0d\tBrush teeth") {
			t.Errorf("habit done --slot morning: %q", got)
		}
		done := decode[api.HabitResult](t, ok(t, b.env, "habit", "done", "Brush teeth", "--slot", "Evening", "--json"))
		if done.Habit.Today.State != "done" || done.Habit.Streak.Current != 1 || done.Slot() != "evening" {
			t.Errorf("habit done --slot Evening --json: %+v", done.Habit)
		}
		// The app has it as the command's doing: by the user, from the command line (or this machine, over the network).
		h := b.habit(t, brush)
		via := "command line"
		if !b.local {
			via = "todos on "
		}
		for _, slot := range h.Today.Slots {
			if !slot.Done || slot.By != "me" || !strings.HasPrefix(slot.Via, via) || slot.Source != "manual" {
				t.Errorf("slot %s as the app has it: %+v", slot.ID, slot)
			}
		}
		// Again changes nothing, and is not an error: with a slot named, and without.
		for _, args := range [][]string{{"habit", "done", "brush", "--slot", "evening"}, {"habit", "done", "brush"}} {
			if got := ok(t, b.env, args...); got != row(brush, "done\t2/2\t1d\tBrush teeth") {
				t.Errorf("%v: %q", args, got)
			}
		}
		if nothing := decode[map[string]any](t, ok(t, b.env, "habit", "done", "brush", "--json")); nothing["checkin"] != nil || nothing["habit"] == nil {
			t.Errorf("habit done --json with nothing left: %v", nothing)
		}

		// Taking one back opens the day again, and the streak with it.
		if got := ok(t, b.env, "habit", "undo", fmt.Sprint(brush), "--slot", "evening"); got != row(brush, "due\t1/2\t0d\tBrush teeth") {
			t.Errorf("habit undo --slot evening: %q", got)
		}
		// A rest day and back.
		if got := ok(t, b.env, "habit", "skip", "brush", "-m", "travelling"); got != row(brush, "off\t1/2\t0d\tBrush teeth") {
			t.Errorf("habit skip: %q", got)
		}
		if skipped := decode[map[string]any](t, ok(t, b.env, "habit", "skip", "brush", "--json")); skipped["skip"] != nil {
			t.Errorf("a second rest for the same day: %v", skipped["skip"])
		}
		if got := ok(t, b.env, "habit", "skip", "brush", "--undo"); got != row(brush, "due\t1/2\t0d\tBrush teeth") {
			t.Errorf("habit skip --undo: %q", got)
		}

		// A habit counted in weeks: one visit a day, and yesterday can still be logged.
		if got := ok(t, b.env, "habit", "done", "gym"); got != row(gym, "done\t1/3\t0w\tGym") {
			t.Errorf("habit done gym: %q", got)
		}
		if got := ok(t, b.env, "habit", "done", "gym"); got != row(gym, "done\t1/3\t0w\tGym") {
			t.Errorf("a second visit the same day: %q", got)
		}
		ok(t, b.env, "habit", "done", "gym", "--yesterday")
		if h := b.habit(t, gym); !h.Yesterday.CheckedIn || !h.Today.CheckedIn {
			t.Errorf("gym after logging yesterday: %+v %+v", h.Yesterday, h.Today)
		}

		// Both at once; then the list in the order of the day.
		ok(t, b.env, "habit", "undo", "gym")
		if got := rows(ok(t, b.env, "habit", "done", "brush", "gym")); len(got) != 2 || got[0][1] != "done" || got[1][1] != "done" {
			t.Errorf("habit done brush gym: %v", got)
		}
		if got := rows(ok(t, b.env, "habit")); len(got) != 2 || got[0][1] != "done" || got[0][2] != "2/2" || got[0][3] != "1d" {
			t.Errorf("habit, with everything done: %v", got)
		}

		// What the app refuses, in its own words.
		fails(t, b.env, 2, `"Brush teeth" has no slot "noon"`, "habit", "done", "brush", "--slot", "noon")
		fails(t, b.env, 2, `has no slots`, "habit", "done", "gym", "--slot", "morning")
		fails(t, b.env, 3, `no habit's name matches "piano"`, "habit", "done", "piano")
		fails(t, b.env, 3, `there is no habit #99`, "habit", "skip", "99")
		refused := fails(t, b.env, 2, `"code":"no_such_slot"`, "habit", "done", "brush", "--slot", "noon", "--json")
		if refused.stdout != "" {
			t.Errorf("a refusal printed to stdout: %q", refused.stdout)
		}

		// Tasks are untouched by all of this, and work as they did.
		if got := ok(t, b.env, "ls"); got != "" {
			t.Errorf("ls after working with habits: %q", got)
		}
		if got := rows(ok(t, b.env, "add", "Buy floss")); len(got) != 1 || got[0][4] != "Buy floss" {
			t.Errorf("add: %v", got)
		}
	})
}

func TestHabitsAndAnOlderApp(t *testing.T) {
	// An app from before habits: the fake at revision 4. The habit commands say
	// what is needed, and the rest of the command works with it.
	for _, make := range []func(*testing.T) *backend{fakeSocket, fakeRemote} {
		b := make(t)
		b.add(t, "A task")
		fails(t, b.env, 8, `habits need a newer Todos app: this one speaks API revision 4`, "habit")
		fails(t, b.env, 8, `"code":"version"`, "habit", "done", "floss", "--json")
		if got := rows(ok(t, b.env, "ls")); len(got) != 1 || got[0][4] != "A task" {
			t.Errorf("%s: ls: %v", b.name, got)
		}
		for _, r := range b.fake.Requests() {
			if strings.Contains(r.Path, "/habits") {
				t.Errorf("%s: the old app was asked for %s", b.name, r.Path)
			}
		}
	}
}

func TestWatchIsQuietAboutHabits(t *testing.T) {
	// `todos watch` follows tasks. A habit check-in is announced on the same
	// stream under its own name, and must neither print anything nor end it.
	everywhere(t, func(t *testing.T, b *backend) {
		brush, _ := b.withHabits(t)
		w := startWatch(t, b.env)
		time.Sleep(300 * time.Millisecond) // past the announcement of the habits being made
		ok(t, b.env, "habit", "done", fmt.Sprint(brush), "--slot", "morning")
		time.Sleep(300 * time.Millisecond)
		b.add(t, "Added while watching")
		if c := w.next(t); c.Event != "created" || c.Task.Title != "Added while watching" {
			t.Errorf("the first thing watch said was %+v", c)
		}
	})
}

// The board's habits panel, in a real terminal: t opens it, and a number checks
// a time of day in and takes it back. (A terminal is sent only the cells that
// change, so what is looked for here is text that is new on the screen; how the
// panel follows changes made elsewhere is tested on the model, in internal/tui.)
func TestHabitsPanelOnARealTerminal(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		brush, gym := b.withHabits(t)
		b.add(t, "A task")
		term := openTerminal(t, b.env, 110, 30)
		term.waitFor(t, "A task")
		term.waitFor(t, "habits: 3 left")
		term.send(t, "t")
		term.waitFor(t, "Habits · 3 left today")
		term.waitFor(t, "○ 1 Morning  ○ 2 Evening")

		// 1 is the morning; the app records it as this command's.
		term.send(t, "1")
		term.waitFor(t, "Checked in Brush teeth, morning")
		if slot := b.habit(t, brush).Today.Slots[0]; slot.ID != "morning" || !slot.Done || slot.By != "me" {
			t.Errorf("the morning as the app has it: %+v", slot)
		}
		// The same key takes it back.
		term.send(t, "1")
		term.waitFor(t, "Took back Brush teeth, morning")
		if h := b.habit(t, brush); h.Today.Done != 0 {
			t.Errorf("after taking it back: %+v", h.Today)
		}
		// Down to the gym, and x for today's visit.
		term.send(t, "j")
		term.send(t, "x")
		term.waitFor(t, "Checked in Gym")
		if h := b.habit(t, gym); !h.Today.CheckedIn || h.Week.Count != 1 {
			t.Errorf("the gym as the app has it: %+v %+v", h.Today, h.Week)
		}

		term.send(t, "t") // back to the board (esc would do too, but esc then q at once reads as one key)
		time.Sleep(100 * time.Millisecond)
		term.send(t, "q")
		if code := term.exit(t); code != 0 {
			t.Errorf("q should end the board cleanly, got exit %d", code)
		}
	})
}
