package cli

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"todos/internal/fakeserver"
)

var escapes = regexp.MustCompile("\x1b\\[[0-9;]*m")

// plain is output with its styling taken off.
func plain(s string) string { return escapes.ReplaceAllString(s, "") }

func str(s string) *string { return &s }

// withHabits is a harness whose fake Todos speaks revision 5 and has three
// habits: Brush teeth (morning and evening, 12 days running), Floss (the same,
// yesterday's evening still missing) and Gym (three days a week, one so far).
func withHabits(t *testing.T, tty bool) *harness {
	t.Helper()
	h := newHarness(t, tty, true)
	h.fake.Configure(func(s *fakeserver.Server) { s.Revision = 5 })
	times := func(habit *fakeserver.Habit) {
		habit.Slots[0].Remind, habit.Slots[0].From, habit.Slots[0].Until = str("07:30"), str("05:00"), str("11:00")
		habit.Slots[1].Remind, habit.Slots[1].From, habit.Slots[1].Until = str("21:30"), str("19:00"), str("02:00")
	}
	h.fake.AddHabit("Brush teeth", []string{"Morning", "Evening"}, times, func(habit *fakeserver.Habit) { habit.Streak, habit.Best = 12, 30 })
	h.fake.AddHabit("Floss", []string{"Morning", "Evening"}, times, func(habit *fakeserver.Habit) { habit.Streak, habit.AtRisk = 5, []string{"evening"} })
	h.fake.AddHabit("Gym", nil, func(habit *fakeserver.Habit) { habit.Week, habit.Streak = 1, 3 })
	return h
}

func TestHabitListForAPipe(t *testing.T) {
	h := withHabits(t, false)
	h.fake.CheckInElsewhere(1, "morning", "me", "iPhone")
	if code := h.run("habit"); code != 0 {
		t.Fatalf("habit: exit %d, %q", code, h.err.String())
	}
	// In the order of the day: mornings still open first, then the evening, then the habit with no time.
	want := "2\tdue\t0/2\t5d\tFloss\n1\tdue\t1/2\t12d\tBrush teeth\n3\tdue\t1/3\t3w\tGym\n"
	if h.out.String() != want {
		t.Errorf("habit through a pipe:\n%q\nwant\n%q", h.out.String(), want)
	}
	for _, args := range [][]string{{"habit", "ls"}, {"habits"}, {"habit", "list"}} {
		if h.run(args...); h.out.String() != want {
			t.Errorf("%v: %q", args, h.out.String())
		}
	}

	// --json is the app's own answer.
	if code := h.run("habit", "ls", "--json"); code != 0 {
		t.Fatalf("habit ls --json: exit %d, %q", code, h.err.String())
	}
	var got struct {
		Habits []struct {
			Name  string `json:"name"`
			Today struct {
				State string `json:"state"`
			} `json:"today"`
			Rates map[string]any `json:"rates"` // a field this client makes no use of
		} `json:"habits"`
		Zone    string `json:"zone"`
		Version int    `json:"version"`
	}
	if err := json.Unmarshal(h.out.Bytes(), &got); err != nil || len(got.Habits) != 3 || got.Zone != "America/Chicago" || got.Habits[0].Name != "Brush teeth" || got.Habits[0].Rates == nil {
		t.Errorf("habit ls --json: %v %s", err, h.out.String())
	}
	if strings.Count(h.out.String(), "\n") != 1 {
		t.Errorf("JSON for a pipe is one line: %q", h.out.String())
	}
}

func TestHabitListOnATerminal(t *testing.T) {
	h := withHabits(t, true)
	h.fake.CheckInElsewhere(1, "morning", "me", "iPhone")
	h.fake.CheckInElsewhere(1, "evening", "me", "iPhone")
	h.fake.AddHabit("Stretch", []string{"Morning"}, func(habit *fakeserver.Habit) { habit.Paused = true })
	h.fake.AddHabit("Old habit", []string{"Morning"}, func(habit *fakeserver.Habit) { habit.Archived = true })
	if code := h.run("habit"); code != 0 {
		t.Fatalf("habit: exit %d, %q", code, h.err.String())
	}
	want := strings.Join([]string{
		"To do today (3)",
		"#2  Floss        0 of 2 · Morning 07:30  5 days, at risk",
		"    Log yesterday’s evening by the end of today to keep your 5-day streak.",
		"#3  Gym          1 of 3 this week        3 weeks",
		"",
		"Done (1)",
		"#1  Brush teeth  2 of 2 · done           13 days",
		"",
		"Not today",
		"#4  Stretch      Paused",
		"",
	}, "\n")
	if got := plain(h.out.String()); got != want {
		t.Errorf("habit on a terminal:\n%s\nwant\n%s", got, want)
	}
	if !colorEscape.MatchString(h.out.String()) {
		t.Error("and it is styled")
	}
	// Archived habits only with --all.
	if h.run("habit", "ls", "--all"); !strings.Contains(plain(h.out.String()), "Archived\n#5  Old habit") {
		t.Errorf("habit ls --all: %s", plain(h.out.String()))
	}

	// No habits at all.
	empty := newHarness(t, true, true)
	empty.fake.Configure(func(s *fakeserver.Server) { s.Revision = 5 })
	if empty.run("habit"); !strings.Contains(plain(empty.out.String()), "No habits yet") {
		t.Errorf("no habits: %q", empty.out.String())
	}
}

func TestHabitDone(t *testing.T) {
	h := withHabits(t, true)
	// By words from its name; the app picks the slot still to do.
	if code := h.run("habit", "done", "floss"); code != 0 {
		t.Fatalf("habit done floss: exit %d, %q", code, h.err.String())
	}
	if got, want := plain(h.out.String()), "✓ Checked in #2 Floss (morning)  1 of 2 · Evening 21:30 · 5 days in a row\n"; got != want {
		t.Errorf("habit done floss: %q, want %q", got, want)
	}
	// A named slot, by number, and the day completing the streak.
	if h.run("habit", "done", "2", "--slot", "Evening"); plain(h.out.String()) != "✓ Checked in #2 Floss (evening)  2 of 2 · done · 6 days in a row\n" {
		t.Errorf("habit done 2 --slot Evening: %q", plain(h.out.String()))
	}
	checkins := h.fake.Checkins(2)
	if len(checkins) != 2 || checkins[0].Slot != "morning" || checkins[1].Slot != "evening" || checkins[0].Via != "command line" || checkins[0].Source != "manual" || len(checkins[0].Key) < 8 {
		t.Errorf("what the app recorded: %+v", checkins)
	}
	// Again: nothing is sent for a slot already done, and nothing is recorded with none named.
	before := len(h.fake.Requests())
	if code := h.run("habit", "done", "floss", "--slot", "evening"); code != 0 || plain(h.out.String()) != "· Already checked in #2 Floss  2 of 2 · done · 6 days in a row\n" {
		t.Errorf("a slot already done: exit %d %q", code, plain(h.out.String()))
	}
	for _, r := range h.fake.Requests()[before:] {
		if r.Method != "GET" {
			t.Errorf("a slot already done was sent again: %s %s", r.Method, r.Path)
		}
	}
	if code := h.run("habit", "done", "floss"); code != 0 || !strings.HasPrefix(plain(h.out.String()), "· Already checked in #2 Floss") {
		t.Errorf("nothing left to check in: exit %d %q", code, plain(h.out.String()))
	}
	if n := len(h.fake.Checkins(2)); n != 2 {
		t.Errorf("checking in what is done recorded something: %d check-ins", n)
	}

	// Yesterday, and a habit counted in weeks.
	if h.run("habit", "done", "gym", "--yesterday"); plain(h.out.String()) != "✓ Checked in #3 Gym (yesterday)  1 of 3 this week · 3 weeks in a row\n" {
		t.Errorf("habit done gym --yesterday: %q", plain(h.out.String()))
	}
	if h.run("habit", "done", "gym"); plain(h.out.String()) != "✓ Checked in #3 Gym  2 of 3 this week · 3 weeks in a row\n" {
		t.Errorf("habit done gym: %q", plain(h.out.String()))
	}
	if h.run("habit", "done", "gym"); !strings.HasPrefix(plain(h.out.String()), "· Already checked in #3 Gym") || len(h.fake.Checkins(3)) != 2 {
		t.Errorf("one visit a day: %q, %d check-ins", plain(h.out.String()), len(h.fake.Checkins(3)))
	}

	// Several at once.
	if code := h.run("habit", "done", "brush", "1"); code != 0 || strings.Count(plain(h.out.String()), "✓ Checked in #1 Brush teeth") != 2 {
		t.Errorf("habit done brush 1: exit %d %q", code, plain(h.out.String()))
	}
}

func TestHabitDoneForScripts(t *testing.T) {
	h := withHabits(t, false)
	if code := h.run("habit", "done", "brush", "--slot", "morning"); code != 0 || h.out.String() != "1\tdue\t1/2\t12d\tBrush teeth\n" {
		t.Errorf("habit done through a pipe: exit %d %q %q", code, h.out.String(), h.err.String())
	}
	if code := h.run("habit", "done", "brush", "--json"); code != 0 {
		t.Fatalf("habit done --json: exit %d %q", code, h.err.String())
	}
	var res struct {
		Habit struct {
			Today struct {
				State string `json:"state"`
			} `json:"today"`
		} `json:"habit"`
		Checkin *struct {
			Slot string `json:"slot"`
			By   string `json:"by"`
		} `json:"checkin"`
	}
	if err := json.Unmarshal(h.out.Bytes(), &res); err != nil || res.Checkin == nil || res.Checkin.Slot != "evening" || res.Habit.Today.State != "done" {
		t.Errorf("habit done --json: %v %s", err, h.out.String())
	}
	// Nothing left: still JSON, with a null check-in, and still exit 0.
	if code := h.run("habit", "done", "brush", "--json"); code != 0 || !strings.Contains(h.out.String(), `"checkin":null`) {
		t.Errorf("habit done --json with nothing left: exit %d %s", code, h.out.String())
	}
	if code := h.run("habit", "done", "brush", "--slot", "morning", "--json"); code != 0 || !strings.Contains(h.out.String(), `"checkin":null`) || !strings.Contains(h.out.String(), `"habit":{`) {
		t.Errorf("habit done --slot --json for a slot already done: exit %d %s", code, h.out.String())
	}
	// Several: one object to a line.
	if h.run("habit", "done", "floss", "gym", "--json"); strings.Count(h.out.String(), "\n") != 2 {
		t.Errorf("several results: %q", h.out.String())
	}
}

func TestHabitUndoAndSkip(t *testing.T) {
	h := withHabits(t, true)
	h.run("habit", "done", "brush", "--slot", "morning")
	h.run("habit", "done", "brush", "--slot", "evening")
	if h.run("habit", "undo", "brush", "--slot", "evening"); plain(h.out.String()) != "✓ Took back #1 Brush teeth  1 of 2 · Evening 21:30 · 12 days in a row\n" {
		t.Errorf("habit undo --slot: %q", plain(h.out.String()))
	}
	if h.run("habit", "undo", "brush"); !strings.HasPrefix(plain(h.out.String()), "✓ Took back #1 Brush teeth  0 of 2") || len(h.fake.Checkins(1)) != 0 {
		t.Errorf("habit undo: %q", plain(h.out.String()))
	}
	if code := h.run("habit", "undo", "brush"); code != 0 || !strings.HasPrefix(plain(h.out.String()), "· Nothing to take back for #1 Brush teeth") {
		t.Errorf("nothing to take back: exit %d %q", code, plain(h.out.String()))
	}

	// A rest day, with a reason; then it is taken back.
	if code := h.run("habit", "skip", "floss", "-m", "travelling"); code != 0 || plain(h.out.String()) != "✓ Rest day for #2 Floss  Rest day · 5 days in a row\n" {
		t.Errorf("habit skip: exit %d %q %q", code, plain(h.out.String()), h.err.String())
	}
	var sent map[string]any
	for _, r := range h.fake.Requests() {
		if r.Method == "POST" && strings.HasSuffix(r.Path, "/habits/2/skips") {
			_ = json.Unmarshal([]byte(r.Body), &sent)
		}
	}
	if sent["reason"] != "travelling" {
		t.Errorf("the reason was not sent: %v", sent)
	}
	if h.run("habit", "skip", "floss"); !strings.HasPrefix(plain(h.out.String()), "· Nothing to rest for #2 Floss") {
		t.Errorf("a day already rested: %q", plain(h.out.String()))
	}
	if h.run("habit", "skip", "floss", "--undo"); plain(h.out.String()) != "✓ Took back the rest day for #2 Floss  0 of 2 · Morning 07:30 · 5 days in a row\n" {
		t.Errorf("habit skip --undo: %q", plain(h.out.String()))
	}
	if h.run("habit", "skip", "gym"); plain(h.out.String()) != "✓ Rest week for #3 Gym  Rest week · 3 weeks in a row\n" {
		t.Errorf("habit skip gym: %q", plain(h.out.String()))
	}

	// The app's limit on rest days is passed on as it is said.
	h.fake.AddHabit("Read", []string{"Evening"}, func(habit *fakeserver.Habit) { habit.Skips = 0 })
	if code := h.run("habit", "skip", "read"); code != ExitUsage || !strings.Contains(h.err.String(), "You can skip 2 days in any 7") {
		t.Errorf("past the limit: exit %d %q", code, h.err.String())
	}
}

func TestHabitNamesAndRefusals(t *testing.T) {
	h := withHabits(t, false)
	h.fake.AddHabit("Brush the dog", []string{"Evening"})
	for _, c := range []struct {
		args []string
		exit int
		says string
	}{
		{[]string{"habit", "done", "nothing-like-it"}, ExitNotFound, `no habit's name matches "nothing-like-it"`},
		{[]string{"habit", "done", "99"}, ExitNotFound, "there is no habit #99"},
		{[]string{"habit", "done", "brush"}, ExitUsage, "\"brush\" matches 2 habits; use a number:\n  #1  Brush teeth\n  #4  Brush the dog"},
		{[]string{"habit", "done", "floss", "--slot", "noon"}, ExitUsage, `"Floss" has no slot "noon". It has: morning, evening.`},
		{[]string{"habit", "done", "gym", "--slot", "morning"}, ExitUsage, `"Gym" has no slots.`},
		{[]string{"habit", "done"}, ExitUsage, "which habit?"},
		{[]string{"habit", "frobnicate"}, ExitUsage, `unknown command "frobnicate"`},
		{[]string{"habit", "ls", "extra"}, ExitUsage, "takes no arguments"},
	} {
		if code := h.run(c.args...); code != c.exit || !strings.Contains(h.err.String(), c.says) || h.out.Len() != 0 {
			t.Errorf("%v: exit %d, stderr %q, stdout %q; want exit %d saying %q", c.args, code, h.err.String(), h.out.String(), c.exit, c.says)
		}
	}
	// An exact name wins over a longer one that contains it.
	h.fake.AddHabit("Brush", []string{"Evening"})
	if code := h.run("habit", "done", "brush"); code != 0 || !strings.HasSuffix(h.out.String(), "\tBrush\n") {
		t.Errorf("an exact name: exit %d %q %q", code, h.out.String(), h.err.String())
	}
	// With --json, a refusal is JSON too, on stderr, with the app's code.
	if code := h.run("habit", "done", "floss", "--slot", "noon", "--json"); code != ExitUsage || !strings.Contains(h.err.String(), `"code":"no_such_slot"`) {
		t.Errorf("a refusal with --json: exit %d %q", code, h.err.String())
	}

	// On a terminal, several matches are a question.
	tty := withHabits(t, true)
	tty.fake.AddHabit("Brush the dog", []string{"Evening"})
	tty.ask.choice = 1
	if code := tty.run("habit", "done", "brush"); code != 0 || !strings.Contains(plain(tty.out.String()), "Checked in #4 Brush the dog") || !strings.Contains(strings.Join(tty.ask.asked, "\n"), `Which habit did you mean by "brush"?`) {
		t.Errorf("choosing among several: exit %d %q asked %q", code, plain(tty.out.String()), tty.ask.asked)
	}
}

func TestHabitsNeedANewerApp(t *testing.T) {
	// An app from before habits (revision 4): the habit commands say so, and
	// everything else works as it did.
	h := newHarness(t, false, true)
	h.fake.Add("Renew passport")
	for _, args := range [][]string{{"habit"}, {"habit", "ls"}, {"habit", "done", "floss"}, {"habit", "skip", "floss"}, {"habit", "undo", "floss"}} {
		if code := h.run(args...); code != ExitVersion || !strings.Contains(h.err.String(), "habits need a newer Todos app") || !strings.Contains(h.err.String(), "revision 4") {
			t.Errorf("%v against an app without habits: exit %d %q", args, code, h.err.String())
		}
	}
	for _, r := range h.fake.Requests() {
		if strings.Contains(r.Path, "/habits") {
			t.Errorf("the old app was asked for %s", r.Path)
		}
	}
	if code := h.run("ls"); code != 0 || !strings.Contains(h.out.String(), "Renew passport") {
		t.Errorf("ls against the same app: exit %d %q", code, h.err.String())
	}
	if code := h.run("habit", "--help"); code != 0 || !strings.Contains(h.out.String(), "todos habit done brush --slot evening") {
		t.Errorf("habit --help: exit %d %q", code, h.out.String())
	}
	if h.run("--help"); !strings.Contains(h.out.String(), "habit") {
		t.Errorf("the top-level help lists habit: %q", h.out.String())
	}
}

func TestHabitCompletion(t *testing.T) {
	h := withHabits(t, false)
	h.fake.AddHabit("Old habit", []string{"Morning"}, func(habit *fakeserver.Habit) { habit.Archived = true })
	if code := h.run("__complete", "habit", "done", ""); code != 0 {
		t.Fatalf("completion: exit %d %q", code, h.err.String())
	}
	for _, want := range []string{"1\tBrush teeth", "2\tFloss", "3\tGym"} {
		if !strings.Contains(h.out.String(), want) {
			t.Errorf("completion lacks %q: %q", want, h.out.String())
		}
	}
	if strings.Contains(h.out.String(), "Old habit") {
		t.Errorf("completion offers an archived habit: %q", h.out.String())
	}
}
