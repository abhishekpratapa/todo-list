package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/golden"

	"todos/internal/api"
	"todos/internal/query"
)

// The moment every test is set at: Tuesday 13 October 2026, 12:00 UTC.
var now = time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)

func task(t testing.TB, js string) api.Task {
	t.Helper()
	var out api.Task
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// sample is a list with something in every column and every kind of card.
func sample(t testing.TB) loadedMsg {
	tasks := []api.Task{
		task(t, `{"id":38,"title":"Ship the command-line client","status":"in_progress","priority":"high","due":"2026-10-13","project":"todos","tags":[],"assignee":"claude","subtasks":[{"id":1,"title":"a","done":true},{"id":2,"title":"b","done":true},{"id":3,"title":"c","done":false}],"rev":7,"updatedAt":"2026-10-13T11:00:00.000Z"}`),
		task(t, `{"id":35,"title":"Review the security write-up","status":"in_progress","priority":"medium","due":null,"project":"todos","tags":["review"],"assignee":"me","subtasks":[],"rev":2}`),
		task(t, `{"id":29,"title":"Tax forms","status":"blocked","priority":"medium","due":"2026-10-09","project":null,"tags":["money"],"assignee":"me","subtasks":[],"rev":4}`),
		task(t, `{"id":41,"title":"Renew passport","notes":"Bring **two** photos.","status":"todo","priority":"high","due":"2026-10-16","project":"personal","tags":["errand"],"assignee":"me","subtasks":[{"id":1,"title":"Book appointment","done":true},{"id":2,"title":"Take photos","done":false}],"rev":3}`),
		task(t, `{"id":44,"title":"Call the bank about the standing order that went out twice","status":"todo","priority":"high","due":"2026-10-12","project":null,"tags":[],"assignee":"me","subtasks":[],"rev":1}`),
		task(t, `{"id":42,"title":"Water the plants","status":"todo","priority":"medium","due":"2026-10-13","project":"home","tags":[],"assignee":"me","subtasks":[],"repeat":"weekly","rev":1}`),
		task(t, `{"id":43,"title":"Read the Bubble Tea v2 guide","status":"todo","priority":"low","due":null,"project":null,"tags":["reading"],"assignee":"me","subtasks":[],"rev":1}`),
		task(t, `{"id":40,"title":"Book dentist","status":"done","priority":"medium","due":"2026-10-01","project":null,"tags":[],"assignee":"me","subtasks":[],"completedAt":"2026-10-12T09:00:00.000Z","rev":3}`),
		task(t, `{"id":33,"title":"Pair the iPhone","status":"done","priority":"medium","due":null,"project":"todos","tags":[],"assignee":"claude","subtasks":[],"completedAt":"2026-10-10T17:30:00.000Z","rev":5}`),
		task(t, `{"id":12,"title":"Old finished thing","status":"done","priority":"low","due":null,"project":null,"tags":[],"assignee":"me","subtasks":[],"completedAt":"2026-09-20T08:00:00.000Z","rev":2}`),
	}
	return loadedMsg{tasks: tasks, today: "2026-10-13", version: 57,
		counts: api.Counts{Open: 7, InProgress: 2, Blocked: 1, Overdue: 2, DueToday: 2, Claude: 1, Done7d: 2}}
}

// full is task 41 as GET /tasks/41 gives it, with its history.
const full = `{"id":41,"title":"Renew passport","notes":"# Steps\n\nBring **two** photos.\n\n- Form DS-82\n- Old passport","status":"todo","priority":"high","due":"2026-10-16","project":"personal","tags":["errand"],"assignee":"me",
"subtasks":[{"id":1,"title":"Book appointment","done":true},{"id":2,"title":"Take photos","done":false}],"repeat":"yearly","remindAt":"2026-10-15T14:00:00.000Z","remindedAt":null,"rev":3,"createdBy":"me",
"createdAt":"2026-10-01T08:30:00.000Z","updatedAt":"2026-10-12T16:45:00.000Z","completedAt":null,
"activity":[{"at":"2026-10-01T08:30:00.000Z","by":"me","kind":"event","text":"created this task"},{"at":"2026-10-12T16:40:00.000Z","by":"me","kind":"event","text":"added subtasks","via":"iPhone"},{"at":"2026-10-12T16:45:00.000Z","by":"claude","kind":"comment","text":"Booked for Friday at 10."}]}`

func options() Options {
	return Options{Profile: "local", Dark: true, FixedTheme: true, Now: func() time.Time { return now }, Loc: time.UTC}
}

// board is a board of the given size with the sample list on it, connected.
func board(t testing.TB, width, height int) Model {
	m := New(context.Background(), options())
	return send(m, tea.WindowSizeMsg{Width: width, Height: height}, sample(t), stateMsg{Connected: true})
}

func send(m Model, msgs ...tea.Msg) Model {
	for _, msg := range msgs {
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	return m
}

var special = map[string]tea.KeyPressMsg{
	"enter": {Code: tea.KeyEnter}, "esc": {Code: tea.KeyEscape}, "tab": {Code: tea.KeyTab}, "shift+tab": {Code: tea.KeyTab, Mod: tea.ModShift},
	"up": {Code: tea.KeyUp}, "down": {Code: tea.KeyDown}, "left": {Code: tea.KeyLeft}, "right": {Code: tea.KeyRight},
	"space": {Code: tea.KeySpace, Text: " "}, "backspace": {Code: tea.KeyBackspace}, "ctrl+c": {Code: 'c', Mod: tea.ModCtrl},
}

// press sends keys: named ones ("enter", "tab") or single characters.
func press(m Model, keys ...string) Model {
	for _, k := range keys {
		msg, ok := special[k]
		if !ok {
			r := []rune(k)[0]
			msg = tea.KeyPressMsg{Code: r, Text: k}
		}
		m = send(m, msg)
	}
	return m
}

func typed(m Model, text string) Model {
	for _, r := range text {
		m = press(m, string(r))
	}
	return m
}

func screen(m Model) string { return m.View().Content }
func plain(m Model) string  { return ansi.Strip(screen(m)) }

// wellFormed checks that what is drawn fits the window exactly.
func wellFormed(t *testing.T, m Model) {
	t.Helper()
	lines := strings.Split(screen(m), "\n")
	if m.width >= 30 && m.height >= 8 && len(lines) != m.height {
		t.Errorf("%dx%d: drew %d lines", m.width, m.height, len(lines))
	}
	for i, line := range lines {
		if w := lipgloss.Width(line); w > m.width {
			t.Errorf("%dx%d: line %d is %d wide: %q", m.width, m.height, i, w, ansi.Strip(line))
		}
	}
}

func TestBoard(t *testing.T) {
	for _, size := range [][2]int{{120, 30}, {80, 24}, {160, 45}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			m := board(t, size[0], size[1])
			wellFormed(t, m)
			golden.RequireEqual(t, []byte(plain(m)))
		})
	}
}

func TestBoardColors(t *testing.T) {
	// The same board with its styling, on a dark and on a light terminal.
	for name, dark := range map[string]bool{"dark": true, "light": false} {
		t.Run(name, func(t *testing.T) {
			opts := options()
			opts.Dark = dark
			m := send(New(context.Background(), opts), tea.WindowSizeMsg{Width: 100, Height: 24}, sample(t), stateMsg{Connected: true})
			golden.RequireEqual(t, []byte(screen(m)))
		})
	}
	// Unless TODOS_THEME fixed it, the terminal's answer about its background is used.
	opts := options()
	opts.FixedTheme = false
	m := send(New(context.Background(), opts), tea.WindowSizeMsg{Width: 100, Height: 24}, sample(t))
	dark := screen(m)
	if light := screen(send(m, tea.BackgroundColorMsg{Color: lipgloss.Color("#ffffff")})); light == dark {
		t.Error("a light background should change the colors")
	}
	if fixed := screen(send(board(t, 100, 24), tea.BackgroundColorMsg{Color: lipgloss.Color("#ffffff")})); fixed != screen(board(t, 100, 24)) {
		t.Error("with the theme fixed, the terminal's answer should change nothing")
	}
}

func TestNarrowList(t *testing.T) {
	// Below 80 columns the board is one list, grouped by status.
	for _, size := range [][2]int{{60, 20}, {79, 30}, {40, 12}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			m := board(t, size[0], size[1])
			wellFormed(t, m)
			golden.RequireEqual(t, []byte(plain(m)))
			if strings.Contains(plain(m), "╭") {
				t.Error("the narrow list has no column boxes")
			}
		})
	}
	// Moving down runs through every group in order, and back.
	m := board(t, 60, 40)
	var order []int
	for i := 0; i < 12; i++ {
		if s := m.selected(); s != nil && (len(order) == 0 || order[len(order)-1] != s.ID) {
			order = append(order, s.ID)
		}
		m = press(m, "j")
	}
	if got := fmt.Sprint(order); got != "[41 44 42 43 38 35 29 40 33 12]" {
		t.Errorf("down through the list: %s", got)
	}
	for i := 0; i < 12; i++ {
		m = press(m, "k")
	}
	if s := m.selected(); s == nil || s.ID != 41 {
		t.Errorf("back up to the top: %+v", s)
	}
	// h and l jump between groups, skipping none that have tasks.
	if s := press(m, "l").selected(); s.ID != 38 {
		t.Errorf("l: #%d", s.ID)
	}
	if s := press(m, "l", "l", "l", "l", "h").selected(); s.ID != 29 {
		t.Errorf("l l l l h: #%d", s.ID)
	}
}

func TestMovingAround(t *testing.T) {
	m := board(t, 120, 30)
	at := func(m Model) int { return m.selected().ID }
	if at(m) != 41 {
		t.Fatalf("starts on #%d", at(m))
	}
	for _, c := range []struct {
		keys []string
		want int
	}{
		{[]string{"j"}, 44}, {[]string{"down", "down"}, 43}, {[]string{"j", "j", "j"}, 43}, // stops at the end
		{[]string{"k"}, 42}, {[]string{"g"}, 41}, {[]string{"G"}, 43}, {[]string{"g", "up"}, 41},
		{[]string{"l"}, 38}, {[]string{"right"}, 29}, {[]string{"l"}, 40}, {[]string{"l", "l"}, 40},
		{[]string{"h", "h", "h", "left"}, 41},
	} {
		start := at(m)
		if m = press(m, c.keys...); at(m) != c.want {
			t.Errorf("from #%d, %v: on #%d, want #%d", start, c.keys, at(m), c.want)
		}
	}
	// Each column remembers where it was.
	m = press(m, "j", "j", "l", "j", "h")
	if at(m) != 42 {
		t.Errorf("back in the first column: #%d", at(m))
	}
	if at(press(m, "l")) != 35 {
		t.Errorf("and the second kept its place: #%d", at(press(m, "l")))
	}
	if next, cmd := press(m, "q").Update(nil); next == nil || cmd != nil {
		t.Error("nil messages are ignored")
	}
	if _, cmd := m.Update(tea.KeyPressMsg{Code: 'q', Text: "q"}); cmd == nil {
		t.Error("q quits")
	}
}

func TestALongColumnScrolls(t *testing.T) {
	msg := sample(t)
	for i := 0; i < 40; i++ {
		msg.tasks = append(msg.tasks, task(t, fmt.Sprintf(`{"id":%d,"title":"Filler %d","status":"todo","priority":"low","tags":[],"subtasks":[],"assignee":"me","rev":1}`, 100+i, i)))
	}
	m := send(New(context.Background(), options()), tea.WindowSizeMsg{Width: 100, Height: 24}, msg)
	if !strings.Contains(plain(m), "↓ 39 more") { // five cards fit; 44 are in the column
		t.Errorf("should say how many are below:\n%s", plain(m))
	}
	for i := 0; i < 20; i++ {
		m = press(m, "j")
		if !strings.Contains(plain(m), fmt.Sprintf("#%d ", m.selected().ID)) {
			t.Fatalf("the selected card (#%d) scrolled out of view", m.selected().ID)
		}
	}
	if !strings.Contains(plain(m), "↑ ") {
		t.Errorf("should say there are some above:\n%s", plain(m))
	}
	m = press(m, "G")
	if !strings.Contains(plain(m), "Filler 39") || strings.Contains(plain(m), "more") {
		t.Errorf("at the end:\n%s", plain(m))
	}
	wellFormed(t, m)
	golden.RequireEqual(t, []byte(plain(press(m, "g", "j", "j", "j", "j", "j", "j", "j", "j"))))
}

func TestTilesFilter(t *testing.T) {
	m := board(t, 120, 30)
	shown := func(m Model) string {
		var ids []string
		for _, col := range m.columns() {
			for _, task := range col {
				ids = append(ids, fmt.Sprint(task.ID))
			}
		}
		return strings.Join(ids, " ")
	}
	tilesLine := func(m Model) string { return strings.Split(plain(m), "\n")[0] }
	if got := tilesLine(m); got != " Open 7   Due today 2   Overdue 2   With Claude 1   Done this week 2   Today 4 " {
		t.Errorf("tiles: %q", got)
	}
	for _, c := range []struct {
		keys []string
		want string
	}{
		{nil, "41 44 42 43 38 35 29 40 33 12"},
		{[]string{"tab"}, "42 38"},       // due today
		{[]string{"tab"}, "44 29"},       // overdue
		{[]string{"tab"}, "38"},          // with Claude
		{[]string{"tab"}, "40 33"},       // done this week: not the one from September
		{[]string{"tab"}, "44 42 38 29"}, // today: overdue and due today, as the Dock counts them
		{[]string{"tab"}, "41 44 42 43 38 35 29 40 33 12"},
		{[]string{"shift+tab"}, "44 42 38 29"},
		{[]string{"3"}, "44 29"},
		{[]string{"6"}, "44 42 38 29"},
		{[]string{"1"}, "41 44 42 43 38 35 29 40 33 12"},
		{[]string{"2", "esc"}, "41 44 42 43 38 35 29 40 33 12"},
	} {
		if m = press(m, c.keys...); shown(m) != c.want {
			t.Errorf("after %v: showing %q, want %q", c.keys, shown(m), c.want)
		}
		if m.selected() == nil {
			t.Errorf("after %v: nothing is selected", c.keys)
		}
	}
	golden.RequireEqual(t, []byte(plain(press(m, "3"))))
}

func TestSortPresets(t *testing.T) {
	m := board(t, 120, 30)
	usual := m.columns()
	statusLine := func(m Model) string {
		lines := strings.Split(plain(m), "\n")
		return lines[len(lines)-2]
	}
	m = press(m, "l") // a card in the second column, to follow
	picked := m.selected().ID
	for i, want := range []string{"due date", "priority", "newest", "title", ""} {
		m = press(m, "o")
		if said := strings.Contains(statusLine(m), "sorted by"); said != (want != "") || !strings.Contains(statusLine(m), "sorted by "+want) && said {
			t.Errorf("press %d: the status line says %q", i+1, statusLine(m))
		}
		if m.selected() == nil || m.selected().ID != picked {
			t.Errorf("press %d: the selection moved off #%d", i+1, picked)
		}
		// Each column is sorted on its own, by the app's rules. The default is the
		// order the list came in, which the app has already put it in.
		for c, col := range m.columns() {
			want := usual[c]
			if m.order > 0 {
				want = query.Sorted(usual[c], api.Task.AsQuery, sorts[m.order].sort)
			}
			if fmt.Sprint(ids(col)) != fmt.Sprint(ids(want)) {
				t.Errorf("press %d, column %d: %v, want %v", i+1, c, ids(col), ids(want))
			}
		}
	}
	if fmt.Sprint(m.columns()) != fmt.Sprint(usual) {
		t.Errorf("five presses come back to the usual order")
	}
}

func ids(list []api.Task) []int {
	out := []int{}
	for _, t := range list {
		out = append(out, t.ID)
	}
	return out
}

func TestSearch(t *testing.T) {
	m := board(t, 120, 30)
	m = typed(press(m, "/"), "the")
	if got := len(m.columns()[0]) + len(m.columns()[1]) + len(m.columns()[2]) + len(m.columns()[3]); got != 6 {
		t.Errorf("\"the\" matches %d tasks, want 6:\n%s", got, plain(m))
	}
	if !strings.Contains(plain(m), "/ the") {
		t.Errorf("the search box should be shown:\n%s", plain(m))
	}
	// Letters typed while searching are text, not commands: q does not quit, j does not move.
	m = typed(m, " plants j")
	if m.query != "the plants j" {
		t.Errorf("query: %q", m.query)
	}
	m = press(m, "backspace", "backspace")
	if ids := m.columns()[0]; len(ids) != 1 || ids[0].ID != 42 {
		t.Errorf("\"the plants\": %+v", ids)
	}
	// Enter keeps the filter and gives the keys back to the board.
	m = press(m, "enter")
	if m.searching || m.query != "the plants" || m.selected().ID != 42 {
		t.Errorf("after enter: searching %v, query %q", m.searching, m.query)
	}
	golden.RequireEqual(t, []byte(plain(m)))
	// It searches notes, projects, tags and subtasks too.
	for query, id := range map[string]int{"photos": 41, "money": 29, "personal": 41, "book appointment": 41} {
		found := press(typed(press(press(m, "esc"), "/"), query), "enter")
		if s := found.selected(); s == nil || s.ID != id {
			t.Errorf("searching %q: %+v, want #%d", query, s, id)
		}
	}
	// Esc clears it; a search and a tile narrow things down together.
	if m = press(m, "esc"); m.query != "" || len(m.columns()[0]) != 4 {
		t.Errorf("after esc: %q", m.query)
	}
	m = press(typed(press(press(m, "2"), "/"), "ship"), "enter")
	if s := m.selected(); s == nil || s.ID != 38 || len(m.columns()[0]) != 0 {
		t.Errorf("due today and \"ship\": %+v", s)
	}
	// Leaving the search box with esc drops what was typed.
	if left := press(typed(press(board(t, 120, 30), "/"), "xyz"), "esc"); left.query != "" || left.searching {
		t.Errorf("esc while typing: %q", left.query)
	}
}

func TestDetail(t *testing.T) {
	one := task(t, full)
	for _, size := range [][2]int{{140, 36}, {80, 24}, {60, 20}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			m := press(board(t, size[0], size[1]), "enter")
			if m.detail == nil || m.detail.id != 41 {
				t.Fatalf("enter opens the selected task: %+v", m.detail)
			}
			// What the list knows is shown at once; the history comes with the full task.
			if !strings.Contains(plain(m), "Renew passport") || !strings.Contains(plain(m), "Reading its history") {
				t.Errorf("before the full task arrives:\n%s", plain(m))
			}
			m = send(m, detailMsg{id: 41, task: &one})
			wellFormed(t, m)
			golden.RequireEqual(t, []byte(plain(m)))
			beside := size[0] >= paneFrom
			if strings.Contains(plain(m), "Blocked") != beside {
				t.Errorf("at %d columns the board should be visible beside the detail: %v", size[0], beside)
			}
			// It scrolls, and esc goes back to the board with the same card selected.
			scrolled := press(m, "j", "j", "j", "j", "j", "j")
			if size[1] < 30 && plain(scrolled) == plain(m) {
				t.Error("j should scroll a detail that doesn't fit")
			}
			back := press(scrolled, "esc")
			if back.detail != nil || back.selected().ID != 41 {
				t.Errorf("esc: %+v", back.detail)
			}
		})
	}
	m := send(press(board(t, 140, 40), "enter"), detailMsg{id: 41, task: &one})
	for _, want := range []string{"high priority", "due 2026-10-16 (Fri)", "#personal", "@errand", "repeats yearly", "reminder Oct 15 14:00", "Subtasks 1/2", "Book appointment", "Take photos",
		"Steps", "Form DS-82", "Activity", "you · iPhone", "“Booked for Friday at 10.”"} {
		if !strings.Contains(plain(m), want) {
			t.Errorf("the detail should show %q:\n%s", want, plain(m))
		}
	}
	if strings.Contains(plain(m), "**two**") {
		t.Error("notes should be rendered, not shown as Markdown source")
	}
	// An answer for a task that is no longer the open one is ignored.
	other := send(press(m, "esc", "j", "enter"), detailMsg{id: 41, task: &one})
	if other.detail.id != 44 || other.detail.task.ID != 44 {
		t.Errorf("a late answer replaced the open task: %+v", other.detail.task)
	}
}

func TestHelp(t *testing.T) {
	m := press(board(t, 100, 30), "?")
	for _, want := range []string{"Keys", "search", "next filter", "quit", "any key closes this"} {
		if !strings.Contains(plain(m), want) {
			t.Errorf("help should mention %q:\n%s", want, plain(m))
		}
	}
	wellFormed(t, m)
	if m = press(m, "j"); m.showHelp || m.selected().ID != 41 {
		t.Error("any key closes the help, and does nothing else")
	}
	if !strings.Contains(plain(m), "? help") {
		t.Errorf("the bottom line names the help key:\n%s", plain(m))
	}
}

func TestStatusLine(t *testing.T) {
	line := func(m Model) string { l := strings.Split(plain(m), "\n"); return l[len(l)-2] }
	m := send(New(context.Background(), options()), tea.WindowSizeMsg{Width: 100, Height: 24})
	if !strings.Contains(plain(m), "Reading the list") || !strings.Contains(line(m), "◌ connecting · local") {
		t.Errorf("before anything has arrived:\n%s", plain(m))
	}
	m = send(m, sample(t), stateMsg{Connected: true})
	if got := line(m); !strings.Contains(got, "● live · local · updated just now") {
		t.Errorf("connected: %q", got)
	}
	// Time passes.
	later := m
	later.opts.Now = func() time.Time { return now.Add(3 * time.Minute) }
	if got := line(later); !strings.Contains(got, "updated 3m ago") {
		t.Errorf("three minutes on: %q", got)
	}
	// The connection drops, and comes back.
	m = send(m, stateMsg{Err: &api.ConnError{Kind: api.Interrupted, Msg: "live updates ended"}, Retry: 4 * time.Second})
	if got := line(m); !strings.Contains(got, "○ reconnecting in 4s") {
		t.Errorf("dropped: %q", got)
	}
	if got := line(send(m, stateMsg{Connected: true})); !strings.Contains(got, "● live") {
		t.Errorf("back: %q", got)
	}
	// A refresh that fails says so, keeps what was on screen, and clears when one works.
	m = send(m, loadedMsg{err: &api.ConnError{Kind: api.Unreachable, Msg: "can't reach my-mac: the Mac is asleep"}})
	if got := line(m); !strings.Contains(got, "couldn't read the list: can't reach my-mac") || !strings.Contains(plain(m), "Renew passport") {
		t.Errorf("a failed refresh: %q", got)
	}
	if got := line(send(m, sample(t))); strings.Contains(got, "couldn't") {
		t.Errorf("after a refresh that worked: %q", got)
	}
	// The token was rotated: live updates stop for good, and the line says why.
	m = send(m, liveEndedMsg{err: &api.Error{Status: 401, Message: "That access token is not valid."}})
	if got := line(m); !strings.Contains(got, "○ not live") || !strings.Contains(got, "access token is not valid") {
		t.Errorf("rejected token: %q", got)
	}
}

func TestAChangeFromElsewhere(t *testing.T) {
	m := press(board(t, 120, 30), "j", "j") // on #42
	if m.selected().ID != 42 {
		t.Fatal("setup")
	}
	// A change event with a newer version asks for the list again; one with the version already shown does not.
	if _, cmd := m.Update(eventMsg{Type: "change", Version: 57}); cmd == nil {
		t.Error("the next event should still be waited for")
	}
	fresh := m
	fresh.loading = false
	next, _ := fresh.Update(eventMsg{Type: "change", Version: 58})
	if !next.(Model).loading {
		t.Error("a newer version should start a refresh")
	}
	// While one refresh is under way, another change is remembered rather than piled on.
	next, _ = next.(Model).Update(eventMsg{Type: "change", Version: 59})
	if !next.(Model).stale {
		t.Error("a change during a refresh should be remembered")
	}

	// The new list: #44 was finished elsewhere, #41 was deleted, and a new one arrived.
	msg := sample(t)
	var tasks []api.Task
	for _, task := range msg.tasks {
		switch task.ID {
		case 41:
			continue
		case 44:
			task.Status, task.CompletedAt = "done", "2026-10-13T11:59:00.000Z"
		}
		tasks = append(tasks, task)
	}
	msg.tasks = append([]api.Task{task(t, `{"id":50,"title":"Arrived from the iPhone","status":"todo","priority":"high","tags":[],"subtasks":[],"assignee":"me","rev":1}`)}, tasks...)
	msg.version = 60
	m = send(m, msg)
	// The selection stays on the task it was on, though its position changed.
	if m.selected().ID != 42 {
		t.Errorf("the selection moved to #%d", m.selected().ID)
	}
	text := plain(m)
	if !strings.Contains(text, "#50 Arrived from") || strings.Contains(text, "Renew passport") {
		t.Errorf("the board should show the new list:\n%s", text)
	}
	if done := m.columns()[3]; len(done) != 4 {
		t.Errorf("the finished task should be in Done: %d there", len(done))
	}

	// The selected task itself goes: the selection lands on a neighbour, not nowhere.
	msg.tasks = msg.tasks[:1]
	if m = send(m, msg); m.selected() == nil || m.selected().ID != 50 {
		t.Errorf("after the selected task went: %+v", m.selected())
	}
	// Everything goes.
	msg.tasks = nil
	if m = send(m, msg); m.selected() != nil || !strings.Contains(plain(m), "nothing here") {
		t.Errorf("an empty list:\n%s", plain(m))
	}
	wellFormed(t, m)
}

func TestTheOpenTaskFollowsChanges(t *testing.T) {
	one := task(t, full)
	m := send(press(board(t, 140, 36), "enter"), detailMsg{id: 41, task: &one})
	// The list arrives again with #41 at a later revision: the detail asks for it again.
	msg := sample(t)
	for i := range msg.tasks {
		if msg.tasks[i].ID == 41 {
			msg.tasks[i] = task(t, strings.Replace(string(msg.tasks[i].Raw), `"rev":3`, `"rev":4`, 1))
		}
	}
	next, cmd := m.Update(msg)
	if cmd == nil {
		t.Fatal("a newer revision of the open task should be fetched")
	}
	// Unchanged: nothing to fetch for the detail.
	same := send(m, sample(t))
	if same.detail == nil || same.detail.task.Rev != 3 {
		t.Errorf("unchanged: %+v", same.detail)
	}
	// It was deleted: the detail closes and says so.
	gone := send(next.(Model), detailMsg{id: 41, err: &api.Error{Status: 404, Message: "No todo with id #41"}})
	if gone.detail != nil || !strings.Contains(plain(gone), "that task was deleted") {
		t.Errorf("after the open task was deleted:\n%s", plain(gone))
	}
}

func TestAnySizeIsDrawnCleanly(t *testing.T) {
	// Resizing, to any size, with anything open: it fits, and nothing panics.
	one := task(t, full)
	rng := rand.New(rand.NewSource(1))
	m := board(t, 120, 30)
	states := map[string]func(Model) Model{
		"board":  func(m Model) Model { return m },
		"detail": func(m Model) Model { return send(press(m, "enter"), detailMsg{id: 41, task: &one}) },
		"search": func(m Model) Model { return typed(press(m, "/"), "the") },
		"help":   func(m Model) Model { return press(m, "?") },
		"filter": func(m Model) Model { return press(m, "3") },
	}
	for name, enter := range states {
		open := enter(m)
		for i := 0; i < 150; i++ {
			w, h := 1+rng.Intn(220), 1+rng.Intn(70)
			open = send(open, tea.WindowSizeMsg{Width: w, Height: h})
			lines := strings.Split(screen(open), "\n")
			for _, line := range lines {
				if lipgloss.Width(line) > w {
					t.Fatalf("%s at %dx%d: a line is %d wide: %q", name, w, h, lipgloss.Width(line), ansi.Strip(line))
				}
			}
			if w >= 30 && h >= 8 && len(lines) != h {
				t.Fatalf("%s at %dx%d: drew %d lines", name, w, h, len(lines))
			}
			open = press(open, []string{"j", "k", "l", "h", "tab"}[rng.Intn(5)])
		}
	}
	// A selection made on the wide board is still the selection in the narrow list, and back.
	m = press(m, "l", "j") // #35
	narrow := send(m, tea.WindowSizeMsg{Width: 50, Height: 20})
	if narrow.selected().ID != 35 || !regexp.MustCompile(`▌ #35`).MatchString(plain(narrow)) {
		t.Errorf("narrowed: #%d\n%s", narrow.selected().ID, plain(narrow))
	}
	if wide := send(narrow, tea.WindowSizeMsg{Width: 130, Height: 30}); wide.selected().ID != 35 {
		t.Errorf("widened again: #%d", wide.selected().ID)
	}
	if tiny := plain(send(m, tea.WindowSizeMsg{Width: 20, Height: 5})); !strings.Contains(tiny, "The window is too") {
		t.Errorf("a tiny window: %q", tiny)
	}
}
