package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/exp/golden"

	"todos/internal/api"
	"todos/internal/fakeserver"
)

func habitOf(t testing.TB, js string) api.Habit {
	t.Helper()
	var out api.Habit
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

const twice = `"schedule":{"kind":"daily","slots":[{"id":"morning","name":"Morning","remind":"07:30","from":"05:00","until":"11:00","nudge":null},{"id":"evening","name":"Evening","remind":"21:30","from":"19:00","until":"02:00","nudge":"22:30"}]}`

// someHabits is a day with something of every kind: one part done, one with
// yesterday still missing, one counted in weeks, one done, one paused.
func someHabits(t testing.TB) habitsMsg {
	return habitsMsg{habits: []api.Habit{
		habitOf(t, `{"id":1,"name":"Brush teeth","icon":"🪥","color":"blue","dayStart":"03:00",`+twice+`,"paused":false,"archived":false,"rev":1,
			"today":{"day":"2026-10-13","state":"open","done":1,"total":2,"slots":[{"id":"morning","done":true,"at":"2026-10-13T12:00:00.000Z","by":"me","via":"iPhone","source":"widget"},{"id":"evening","done":false}]},
			"yesterday":{"day":"2026-10-12","state":"done","done":2,"total":2,"slots":[{"id":"morning","done":true},{"id":"evening","done":true}]},
			"streak":{"current":76,"best":76,"unit":"days","atRisk":null,"previous":null},"skipsLeft":2}`),
		habitOf(t, `{"id":2,"name":"Floss","icon":"🧵","color":"mint","dayStart":"03:00",`+twice+`,"paused":false,"archived":false,"rev":1,
			"today":{"day":"2026-10-13","state":"open","done":0,"total":2,"slots":[{"id":"morning","done":false},{"id":"evening","done":false}]},
			"yesterday":{"day":"2026-10-12","state":"open","done":1,"total":2,"slots":[{"id":"morning","done":true},{"id":"evening","done":false}]},
			"streak":{"current":11,"best":19,"unit":"days","atRisk":{"day":"2026-10-12","missing":["evening"],"until":"2026-10-14T08:00:00.000Z"},"previous":null},"skipsLeft":2}`),
		habitOf(t, `{"id":3,"name":"Gym","icon":"🏋️","color":"orange","dayStart":"03:00","schedule":{"kind":"weekly","target":3,"remind":{"days":["mon","wed","fri"],"time":"17:30"}},"paused":false,"archived":false,"rev":1,
			"today":{"day":"2026-10-13","done":false,"checkins":[]},"yesterday":{"day":"2026-10-12","done":true,"checkins":[40]},
			"week":{"start":"2026-10-12","state":"open","count":1,"target":3,"days":["2026-10-12"],"whole":true},"lastWeek":null,
			"streak":{"current":3,"best":4,"unit":"weeks","atRisk":null,"previous":null},"skipsLeft":1}`),
		habitOf(t, `{"id":4,"name":"Vitamins","icon":null,"color":"green","dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"once","name":"","remind":null,"from":null,"until":null,"nudge":null}]},"paused":false,"archived":false,"rev":1,
			"today":{"day":"2026-10-13","state":"done","done":1,"total":1,"slots":[{"id":"once","done":true}]},
			"yesterday":{"day":"2026-10-12","state":"done","done":1,"total":1,"slots":[{"id":"once","done":true}]},
			"streak":{"current":30,"best":30,"unit":"days","atRisk":null,"previous":null},"skipsLeft":2}`),
		habitOf(t, `{"id":5,"name":"Stretch","icon":null,"color":"teal","dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"morning","name":"Morning","remind":"07:00","from":null,"until":null,"nudge":null}]},"paused":true,"archived":false,"rev":2,
			"today":{"day":"2026-10-13","state":"off","done":0,"total":0,"slots":[]},"yesterday":{"day":"2026-10-12","state":"off","done":0,"total":0,"slots":[]},
			"streak":{"current":0,"best":8,"unit":"days","atRisk":null,"previous":null},"skipsLeft":2}`),
	}}
}

func habitBoard(t testing.TB, width, height int) Model {
	opts := options()
	opts.Habits = true
	m := New(context.Background(), opts)
	return send(m, tea.WindowSizeMsg{Width: width, Height: height}, sample(t), stateMsg{Connected: true}, someHabits(t))
}

func TestHabitsPanel(t *testing.T) {
	for _, size := range [][2]int{{110, 26}, {80, 24}, {56, 18}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			m := press(habitBoard(t, size[0], size[1]), "t")
			wellFormed(t, m)
			golden.RequireEqual(t, []byte(plain(m)))
		})
	}
}

func TestHabitsOnTheBoard(t *testing.T) {
	m := habitBoard(t, 110, 26)
	wellFormed(t, m)
	// The board itself only gains a few words: how many are left, and the key that opens the panel.
	if s := plain(m); !strings.Contains(s, "habits: 4 left") || !strings.Contains(s, "t habits") || strings.Contains(s, "Brush teeth") {
		t.Errorf("the board with habits:\n%s", s)
	}
	// With no habits, and with an app that has none to give, the board is as it always was.
	if plain(board(t, 110, 26)) != plain(send(habitBoard(t, 110, 26), habitsMsg{})) {
		t.Error("a board with no habits should look like one that never heard of them")
	}
	if s := plain(press(board(t, 110, 26), "t")); strings.Contains(s, "Habits ·") {
		t.Errorf("t opened a panel with nothing to show:\n%s", s)
	}
	if s := plain(press(habitBoard(t, 110, 26), "?")); !strings.Contains(s, "habits") {
		t.Errorf("the key is in the help:\n%s", s)
	}

	// The panel: in the order of the day, the selection moving through it.
	p := press(m, "t")
	screen := plain(p)
	for _, want := range []string{"Habits · 4 left today", "To do today", "Done", "Not today", "76 days", "11 days, at risk", "3 weeks", "○ 1 Morning  ○ 2 Evening", "● 1 Morning  ○ 2 Evening", "○ today", "Paused", "x check in"} {
		if !strings.Contains(screen, want) {
			t.Errorf("the panel lacks %q:\n%s", want, screen)
		}
	}
	order := []string{"Floss", "Brush teeth", "Gym", "Vitamins", "Stretch"}
	at := -1
	for _, name := range order {
		i := strings.Index(screen, name)
		if i < at {
			t.Errorf("%s is out of order:\n%s", name, screen)
		}
		at = i
	}
	if h := p.selectedHabit(); h == nil || h.Name != "Floss" {
		t.Errorf("the first habit is selected to begin with: %+v", h)
	}
	// What can still be saved is said under the habit it is about, while it is selected.
	if !strings.Contains(screen, "Log yesterday’s evening by the end of today to keep your 11-day streak. Press y.") {
		t.Errorf("the selected habit's streak at risk:\n%s", screen)
	}
	p = press(p, "j", "j")
	if h := p.selectedHabit(); h.Name != "Gym" || strings.Contains(plain(p), "Press y.") {
		t.Errorf("after j j: %s", h.Name)
	}
	if h := press(p, "G").selectedHabit(); h.Name != "Stretch" {
		t.Errorf("after G: %s", h.Name)
	}
	if h := press(p, "g", "k").selectedHabit(); h.Name != "Floss" {
		t.Errorf("after g k: %s", h.Name)
	}
	for _, k := range []string{"esc", "t", "q"} {
		if closed := press(p, k); closed.showHabits || strings.Contains(plain(closed), "Habits ·") {
			t.Errorf("%s should close the panel", k)
		}
	}
	// A fresh reading keeps the selection on the same habit, wherever it now is in the list.
	fresh := someHabits(t)
	fresh.habits[2] = habitOf(t, strings.Replace(string(fresh.habits[2].Raw), `"today":{"day":"2026-10-13","done":false`, `"today":{"day":"2026-10-13","done":true`, 1))
	if h := send(p, fresh).selectedHabit(); h.Name != "Gym" {
		t.Errorf("the selection followed %s instead of staying on Gym", h.Name)
	}
	// Keys that have nothing to act on say so and send nothing.
	done := press(p, "g", "j", "j", "j")
	if h := done.selectedHabit(); h.Name != "Vitamins" {
		t.Fatalf("expected Vitamins, on %s", h.Name)
	}
	next, cmd := done.Update(tea.KeyPressMsg{Code: 'x', Text: "x"})
	if cmd != nil || !strings.Contains(plain(next.(Model)), "Vitamins asks nothing more today") {
		t.Errorf("checking in what is done:\n%s", plain(next.(Model)))
	}
	next, cmd = done.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	if cmd != nil || !strings.Contains(plain(next.(Model)), "Vitamins has nothing left from yesterday") {
		t.Errorf("logging a finished yesterday:\n%s", plain(next.(Model)))
	}
}

// habitsServer is a fake Todos with habits: Floss twice a day with yesterday's
// evening missing, and Gym three days a week.
func habitsServer(f *fakeserver.Server) {
	f.Configure(func(s *fakeserver.Server) { s.Revision = 5 })
	f.Add("A task")
	f.AddHabit("Floss", []string{"Morning", "Evening"}, func(h *fakeserver.Habit) { h.Streak, h.AtRisk = 11, []string{"evening"} })
	f.CheckedInYesterday(1, "morning")
	f.AddHabit("Gym", nil, func(h *fakeserver.Habit) { h.Week, h.Streak = 1, 3 })
}

func tap(r rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: r, Text: string(r)} }

func TestHabitsAreCheckedInFromThePanel(t *testing.T) {
	r := start(t, 110, 26, habitsServer)
	r.waitFor(t, "habits: 3 left")
	r.Send(tap('t'))
	r.waitFor(t, "Habits · 3 left today")

	// x checks in whichever is still to do; the app says which.
	r.Send(tap('x'))
	r.waitFor(t, "● 1 Morning  ○ 2 Evening")
	r.waitFor(t, "Checked in Floss, morning: 1 of 2 · evening")
	// A number is one time of day: checked in, and taken back with the same key.
	r.Send(tap('2'))
	r.waitFor(t, "● 1 Morning  ● 2 Evening")
	r.waitFor(t, "Checked in Floss, evening: 2 of 2 · done · 12 days")
	r.waitFor(t, "Habits · 1 left today")
	r.Send(tap('2'))
	r.waitFor(t, "● 1 Morning  ○ 2 Evening")
	if got := r.fake.Checkins(1); len(got) != 2 || got[1].Slot != "morning" || got[1].Via != "command line" {
		t.Errorf("what the app has for Floss: %+v", got)
	}
	// u takes back everything of today's.
	r.Send(tap('u'))
	r.waitFor(t, "○ 1 Morning  ○ 2 Evening")
	// y logs yesterday's missing evening, and the streak is no longer at risk.
	r.waitFor(t, "11 days, at risk")
	r.Send(tap('y'))
	r.waitFor(t, "Logged yesterday's Floss, evening")
	r.until(t, "the streak safe", func(f *frame) bool { return !strings.Contains(f.screen, "at risk") })
	// s is a rest day, and s again takes it back.
	r.Send(tap('s'))
	r.waitFor(t, "Rest day")
	r.Send(tap('s'))
	r.until(t, "the rest day taken back", func(f *frame) bool { return !strings.Contains(f.screen, "Rest day") })

	// A habit counted in weeks: one visit.
	r.Send(tap('j'))
	r.Send(tap('x'))
	r.waitFor(t, "● today")
	r.waitFor(t, "2 of 3 this week")

	// The app refuses something: it is said, and nothing is lost.
	r.fake.FailNext("POST", "/api/v1/habits/2/undo", 400, `{"error":{"code":"too_late","message":"You can log yesterday until the end of today, but no further back."}}`)
	r.Send(tap('u'))
	r.waitFor(t, "You can log yesterday until the end of today")
	r.waitFor(t, "● today")
}

func TestThePanelFollowsCheckInsMadeElsewhere(t *testing.T) {
	r := start(t, 110, 26, habitsServer)
	r.waitFor(t, "habits: 3 left")
	r.waitFor(t, "● live")
	// On the board: the count moves when the phone checks in. No key is pressed.
	before := r.fake.Version()
	r.fake.CheckInElsewhere(1, "morning", "me", "iPhone")
	r.waitFor(t, "habits: 2 left")
	if r.fake.Version() != before {
		t.Error("a check-in should not change the task list's version")
	}
	r.Send(tap('t'))
	r.waitFor(t, "● 1 Morning  ○ 2 Evening")
	r.fake.CheckInElsewhere(1, "evening", "me", "iPhone")
	r.waitFor(t, "● 1 Morning  ● 2 Evening")
	r.waitFor(t, "Habits · 1 left today")
	// After a dropped connection, what was missed is caught up on.
	r.fake.DropStreams()
	r.fake.CheckInElsewhere(2, "", "me", "iPhone")
	r.waitFor(t, "Habits · all done today")
	// The task list was not read again for any of it.
	lists := 0
	for _, req := range r.fake.Requests() {
		if req.Method == "GET" && strings.HasPrefix(req.Path, "/api/v1/tasks?") {
			lists++
		}
	}
	if lists > 4 { // two readings at the start, and two after the reconnect
		t.Errorf("the task list was read %d times; habits changing should not cause that", lists)
	}
}

func TestAnAppWithoutHabitsIsNotAskedForThem(t *testing.T) {
	r := start(t, 100, 24, func(f *fakeserver.Server) { f.Add("A task") }) // revision 4
	r.waitFor(t, "A task")
	r.waitFor(t, "● live")
	r.Send(tap('t'))
	r.Send(tap('r'))
	r.waitFor(t, "updated just now")
	m := r.model(t)
	if m.showHabits || len(m.habits) != 0 {
		t.Error("no panel without habits")
	}
	for _, req := range r.fake.Requests() {
		if strings.Contains(req.Path, "/habits") {
			t.Errorf("an app from before habits was asked for %s", req.Path)
		}
	}
}
