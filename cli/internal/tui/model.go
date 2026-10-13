// Package tui is the interactive board: what `todos` opens on a terminal.
package tui

import (
	"context"
	"os"
	"strings"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"

	"todos/internal/api"
)

// The columns of the board, in order.
var statuses = [4]string{"todo", "in_progress", "blocked", "done"}

// The tiles above the board. Each is a filter, as on the app's dashboard.
type focus int

const (
	focusOpen focus = iota
	focusToday
	focusOverdue
	focusClaude
	focusDone
)

var tiles = []struct {
	focus        focus
	label, short string
}{
	{focusOpen, "Open", "Open"},
	{focusToday, "Due today", "Today"},
	{focusOverdue, "Overdue", "Late"},
	{focusClaude, "With Claude", "Claude"},
	{focusDone, "Done this week", "Done"},
}

const (
	doneShown   = 50  // how many finished tasks the Done column loads
	narrowBelow = 80  // below this width the board becomes one list
	paneFrom    = 110 // from this width the detail opens beside the board
)

// Options are what the board is given to work with.
type Options struct {
	Client  *api.Client
	Profile string // the profile's name, for the status line
	Local   bool   // on the Mac itself, where Claude sessions can be started
	Getenv  func(string) string
	Dark    bool // the terminal's background, until the terminal says otherwise
	// FixedTheme keeps Dark as given, whatever the terminal says (TODOS_THEME).
	FixedTheme bool
	Mouse      bool // take mouse clicks and the wheel
	Habits     bool // the app has habits (API revision 5)
	Now        func() time.Time
	Loc        *time.Location
}

type liveState int

const (
	liveConnecting liveState = iota
	liveOn
	liveOff   // dropped; trying again
	liveEnded // not trying again (the token was rejected)
)

// Model is the board.
type Model struct {
	opts   Options
	ctx    context.Context
	keys   KeyMap
	help   help.Model
	styles Styles
	dark   bool
	width  int
	height int

	// The list, as last read.
	tasks   []api.Task
	counts  api.Counts
	today   string
	version int
	loaded  bool
	loading bool
	stale   bool // a change arrived while reading; read again after

	// What is shown and selected.
	focus     focus
	query     string
	search    textinput.Model
	searching bool
	col       int
	row       [4]int
	top       [4]int
	selID     int
	detail    *detail
	showHelp  bool

	// The connection.
	events  chan tea.Msg
	live    liveState
	liveErr error
	retry   time.Duration
	updated time.Time
	notice  string // something that went wrong, shown until the next thing works
	flash   string // what the last change did, shown until the next key

	edit editState // see edit.go

	// Habits, as last read, and the panel that shows them (see habits.go).
	habits     []api.Habit
	showHabits bool
	habitRow   int
}

// detail is the open task.
type detail struct {
	id      int
	task    *api.Task
	view    viewport.Model
	loading bool
}

type (
	loadedMsg struct {
		tasks   []api.Task
		counts  api.Counts
		today   string
		version int
		err     error
	}
	detailMsg struct {
		id   int
		task *api.Task
		err  error
	}
	eventMsg     api.Event
	stateMsg     api.FollowState
	liveEndedMsg struct{ err error }
	tickMsg      time.Time
)

// New makes a board. ctx ends its background work.
func New(ctx context.Context, opts Options) Model {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Loc == nil {
		opts.Loc = time.Local
	}
	if opts.Getenv == nil {
		opts.Getenv = os.Getenv
	}
	search := textinput.New()
	search.Prompt = "/ "
	search.Placeholder = "search titles, notes, tags…"
	m := Model{
		opts: opts, ctx: ctx, keys: newKeys(), help: help.New(), dark: opts.Dark, styles: newStyles(opts.Dark),
		search: search, events: make(chan tea.Msg, 64), loading: true,
	}
	m.help.Styles = help.DefaultStyles(opts.Dark)
	m.edit = newEditState()
	return m
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(m.load(), m.loadHabits(), m.follow(), m.nextEvent(), tick(), tea.RequestBackgroundColor)
}

// load reads the list: every open task, the most recently finished ones, and
// today's date on the Mac.
func (m Model) load() tea.Cmd {
	c, ctx := m.opts.Client, m.ctx
	return func() tea.Msg {
		open, err := c.ListAll(ctx, api.ListOptions{Status: "open"})
		if err != nil {
			return loadedMsg{err: err}
		}
		done, err := c.List(ctx, api.ListOptions{Status: "done", Limit: doneShown})
		if err != nil {
			return loadedMsg{err: err}
		}
		msg := loadedMsg{tasks: append(open.Tasks, done.Tasks...), counts: done.Summary, version: done.Version}
		if sum, err := c.Summary(ctx); err == nil {
			msg.today = sum.Date
		}
		return msg
	}
}

// follow keeps the live-update stream open in the background. What it hears
// is handed to the board one message at a time by nextEvent.
func (m Model) follow() tea.Cmd {
	c, ctx, events := m.opts.Client, m.ctx, m.events
	send := func(msg tea.Msg) {
		select {
		case events <- msg:
		case <-ctx.Done():
		}
	}
	return func() tea.Msg {
		go func() {
			err := c.Follow(ctx, func(e api.Event) { send(eventMsg(e)) }, func(s api.FollowState) { send(stateMsg(s)) })
			send(liveEndedMsg{err})
		}()
		return nil
	}
}

func (m Model) nextEvent() tea.Cmd {
	ctx, events := m.ctx, m.events
	return func() tea.Msg {
		select {
		case msg := <-events:
			return msg
		case <-ctx.Done():
			return nil
		}
	}
}

// tick redraws now and then, so "updated 2m ago" stays true.
func tick() tea.Cmd {
	return tea.Tick(15*time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m Model) loadDetail(id int) tea.Cmd {
	c, ctx := m.opts.Client, m.ctx
	return func() tea.Msg {
		task, err := c.Get(ctx, id)
		return detailMsg{id: id, task: task, err: err}
	}
}

// refresh reads the list again, or notes that it should be once the reading
// already under way has finished.
func (m *Model) refresh() tea.Cmd {
	if m.loading {
		m.stale = true
		return nil
	}
	m.loading = true
	return m.load()
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.help.SetWidth(msg.Width)
		m.layoutDetail()
		m.clamp()
		if m.edit.mode == editForm {
			return m.formUpdate(msg)
		}
		return m, nil

	case tea.BackgroundColorMsg:
		if m.opts.FixedTheme {
			return m, nil
		}
		m.dark = msg.IsDark()
		m.styles = newStyles(m.dark)
		m.help.Styles = help.DefaultStyles(m.dark)
		m.layoutDetail()
		return m, nil

	case loadedMsg:
		m.loading = false
		if msg.err != nil {
			m.notice = "couldn't read the list: " + msg.err.Error()
		} else {
			m.tasks, m.counts, m.version, m.loaded = msg.tasks, msg.counts, msg.version, true
			if msg.today != "" {
				m.today = msg.today
			}
			m.updated = m.opts.Now()
			if strings.HasPrefix(m.notice, "couldn't read the list") {
				m.notice = ""
			}
			m.follow2()
		}
		var cmds []tea.Cmd
		if m.stale {
			m.stale = false
			cmds = append(cmds, m.refresh())
		}
		cmds = append(cmds, m.detailChanged(), m.editListChanged())
		return m, tea.Batch(cmds...)

	case detailMsg:
		if m.detail == nil || m.detail.id != msg.id {
			return m, nil
		}
		d := *m.detail
		m.detail = &d
		m.detail.loading = false
		if msg.err != nil {
			if api.IsStatus(msg.err, 404) {
				m.detail = nil
				m.notice = "that task was deleted"
			} else {
				m.notice = "couldn't read the task: " + msg.err.Error()
			}
			return m, nil
		}
		m.detail.task = msg.task
		m.layoutDetail()
		return m, nil

	case eventMsg:
		var cmd, habits tea.Cmd
		if msg.Version != m.version {
			cmd = m.refresh()
		}
		// Habits have their own event. After a reconnect ("hello") they may have changed unheard.
		if msg.Type == "habits" || msg.Type == "hello" {
			habits = m.loadHabits()
		}
		return m, tea.Batch(cmd, habits, m.nextEvent())

	case habitsMsg:
		return m.habitsLoaded(msg), nil

	case habitChangedMsg:
		return m.habitChanged(msg)

	case stateMsg:
		if msg.Connected {
			m.live, m.liveErr = liveOn, nil
		} else {
			m.live, m.liveErr, m.retry = liveOff, msg.Err, msg.Retry
		}
		return m, m.nextEvent()

	case liveEndedMsg:
		if m.ctx.Err() == nil {
			m.live, m.liveErr = liveEnded, msg.err
			if msg.err != nil {
				m.notice = "live updates stopped: " + msg.err.Error()
			}
		}
		return m, nil

	case tickMsg:
		return m, tick()

	case tea.KeyPressMsg:
		return m.key(msg)

	case tea.MouseClickMsg, tea.MouseWheelMsg:
		if m.opts.Mouse {
			return m.mouse(msg.(tea.MouseMsg))
		}
		return m, nil
	}
	return m.editUpdate(msg)
}

// key handles a key press, by what is on screen.
func (m Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return m, tea.Quit
	}
	if m.edit.active() {
		return m.editKey(msg)
	}
	m.flash = ""
	if m.showHelp {
		m.showHelp = false
		m.help.ShowAll = false
		return m, nil
	}
	if m.searching {
		switch {
		case key.Matches(msg, m.keys.Back):
			m.searching, m.query = false, ""
			m.search.SetValue("")
			m.search.Blur()
		case key.Matches(msg, m.keys.Open):
			m.searching = false
			m.search.Blur()
		default:
			var cmd tea.Cmd
			m.search, cmd = m.search.Update(msg)
			m.query = m.search.Value()
			m.clamp()
			return m, cmd
		}
		m.clamp()
		return m, nil
	}
	if m.showHabits {
		return m.habitsKey(msg)
	}
	if m.detail != nil {
		switch {
		case key.Matches(msg, m.keys.Back), msg.String() == "q":
			m.detail = nil
			return m, nil
		case key.Matches(msg, m.keys.Help):
			m.showHelp, m.help.ShowAll = true, true
			return m, nil
		}
		if next, cmd, handled := m.editDetailKey(msg); handled {
			return next, cmd
		}
		d := *m.detail
		var cmd tea.Cmd
		d.view, cmd = d.view.Update(msg)
		m.detail = &d
		return m, cmd
	}

	cols := m.columns()
	switch {
	case key.Matches(msg, m.keys.Quit):
		return m, tea.Quit
	case key.Matches(msg, m.keys.Help):
		m.showHelp, m.help.ShowAll = true, true
	case key.Matches(msg, m.keys.Search):
		m.searching = true
		return m, m.search.Focus()
	case key.Matches(msg, m.keys.Back):
		switch {
		case m.notice != "":
			m.notice = ""
		case m.query != "":
			m.query = ""
			m.search.SetValue("")
		default:
			m.focus = focusOpen
		}
	case key.Matches(msg, m.keys.NextTile):
		m.focus = focus((int(m.focus) + 1) % len(tiles))
	case key.Matches(msg, m.keys.PrevTile):
		m.focus = focus((int(m.focus) + len(tiles) - 1) % len(tiles))
	case len(msg.String()) == 1 && msg.String() >= "1" && msg.String() <= "5":
		m.focus = focus(msg.String()[0] - '1')
	case key.Matches(msg, m.keys.Refresh):
		return m, tea.Batch(m.refresh(), m.loadHabits())
	case key.Matches(msg, m.keys.Habits) && len(m.habits) > 0:
		m.showHabits = true
	case key.Matches(msg, m.keys.Left):
		m.moveColumn(cols, -1)
	case key.Matches(msg, m.keys.Right):
		m.moveColumn(cols, 1)
	case key.Matches(msg, m.keys.Up):
		if m.row[m.col] > 0 {
			m.row[m.col]--
		} else if m.narrow() {
			// One list: going up from the top of a group lands on the end of the one before.
			for c := m.col - 1; c >= 0; c-- {
				if len(cols[c]) > 0 {
					m.col, m.row[c] = c, len(cols[c])-1
					break
				}
			}
		}
	case key.Matches(msg, m.keys.Down):
		if m.row[m.col] < len(cols[m.col])-1 {
			m.row[m.col]++
		} else if m.narrow() {
			for c := m.col + 1; c < len(cols); c++ {
				if len(cols[c]) > 0 {
					m.col, m.row[c] = c, 0
					break
				}
			}
		}
	case key.Matches(msg, m.keys.Top):
		m.row[m.col] = 0
	case key.Matches(msg, m.keys.Bottom):
		m.row[m.col] = max(0, len(cols[m.col])-1)
	case key.Matches(msg, m.keys.Open):
		if t := m.selected(); t != nil {
			return m.open(t.ID)
		}
	default:
		return m.editBoardKey(msg)
	}
	m.clamp()
	m.remember()
	return m, nil
}

// open shows a task's detail.
func (m Model) open(id int) (tea.Model, tea.Cmd) {
	m.detail = &detail{id: id, view: viewport.New(), loading: true}
	// What the list already knows is shown at once; the history arrives with the full task.
	for i := range m.tasks {
		if m.tasks[i].ID == id {
			m.detail.task = &m.tasks[i]
		}
	}
	m.layoutDetail()
	return m, m.loadDetail(id)
}

// moveColumn moves the selection to the next column in a direction that has
// something in it. There is nothing to select in an empty one.
func (m *Model) moveColumn(cols [4][]api.Task, by int) {
	for c := m.col + by; c >= 0 && c < len(cols); c += by {
		if len(cols[c]) > 0 {
			m.col = c
			return
		}
	}
}

// follow2 keeps the selection on the same task after the list is read again,
// when that task is still in the column it was in.
func (m *Model) follow2() {
	cols := m.columns()
	for i, t := range cols[m.col] {
		if t.ID == m.selID {
			m.row[m.col] = i
		}
	}
	m.clamp()
	m.remember()
}

// remember notes which task is selected.
func (m *Model) remember() {
	if t := m.selected(); t != nil {
		m.selID = t.ID
	}
}

// detailChanged reads the open task again if the list shows it has moved on,
// and closes it if it is gone.
func (m *Model) detailChanged() tea.Cmd {
	if m.detail == nil || m.detail.task == nil {
		return nil
	}
	for i := range m.tasks {
		if t := &m.tasks[i]; t.ID == m.detail.id {
			if t.Rev != m.detail.task.Rev {
				return m.loadDetail(t.ID)
			}
			return nil
		}
	}
	// Not among the open tasks or the recent finished ones any more: ask for it.
	return m.loadDetail(m.detail.id)
}

func (m Model) narrow() bool { return m.width < narrowBelow }

// matches says whether a task passes the tile filter and the search.
func (m Model) matches(t *api.Task) bool {
	switch m.focus {
	case focusToday:
		if t.Status == "done" || t.Due == "" || t.Due != m.today {
			return false
		}
	case focusOverdue:
		if t.Status == "done" || t.Due == "" || t.Due >= m.today {
			return false
		}
	case focusClaude:
		if t.Status == "done" || t.Assignee != "claude" {
			return false
		}
	case focusDone:
		weekAgo := m.opts.Now().Add(-7 * 24 * time.Hour).UTC().Format(time.RFC3339)
		if t.Status != "done" || t.CompletedAt < weekAgo {
			return false
		}
	}
	if words := strings.Fields(strings.ToLower(m.query)); len(words) > 0 {
		text := strings.ToLower(strings.Join(append([]string{t.Title, t.Notes, t.Project}, t.Tags...), "\n"))
		for _, s := range t.Subtasks {
			text += "\n" + strings.ToLower(s.Title)
		}
		for _, w := range words {
			if !strings.Contains(text, w) {
				return false
			}
		}
	}
	return true
}

// columns is what is shown: the tasks that pass the filters, by status, in the
// order the app sorts them.
func (m Model) columns() [4][]api.Task {
	var cols [4][]api.Task
	for i := range m.tasks {
		t := &m.tasks[i]
		if !m.matches(t) {
			continue
		}
		for c, status := range statuses {
			if t.Status == status {
				cols[c] = append(cols[c], *t)
			}
		}
	}
	return cols
}

func (m Model) selected() *api.Task {
	cols := m.columns()
	if m.col < 0 || m.col >= len(cols) || m.row[m.col] >= len(cols[m.col]) || m.row[m.col] < 0 {
		return nil
	}
	return &cols[m.col][m.row[m.col]]
}

// clamp keeps the selection inside what is shown, and scrolled into view.
func (m *Model) clamp() {
	cols := m.columns()
	if len(cols[m.col]) == 0 {
		// A filter emptied this column: go to the first one that has something.
		for c := range cols {
			if len(cols[c]) > 0 {
				m.col = c
				break
			}
		}
	}
	visible := m.cardsVisible()
	for c := range cols {
		m.row[c] = max(0, min(m.row[c], len(cols[c])-1))
		if m.row[c] < m.top[c] {
			m.top[c] = m.row[c]
		}
		if visible > 0 && m.row[c] >= m.top[c]+visible {
			m.top[c] = m.row[c] - visible + 1
		}
		m.top[c] = max(0, min(m.top[c], max(0, len(cols[c])-visible)))
	}
}

// mouse selects the card that was clicked, and scrolls with the wheel.
func (m Model) mouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.edit.active() || m.showHelp || m.searching {
		return m, nil
	}
	mouse := msg.Mouse()
	if wheel, ok := msg.(tea.MouseWheelMsg); ok {
		if m.detail != nil {
			d := *m.detail
			var cmd tea.Cmd
			d.view, cmd = d.view.Update(wheel)
			m.detail = &d
			return m, cmd
		}
		cols := m.columns()
		switch mouse.Button {
		case tea.MouseWheelUp:
			m.row[m.col] = max(0, m.row[m.col]-1)
		case tea.MouseWheelDown:
			m.row[m.col] = min(max(0, len(cols[m.col])-1), m.row[m.col]+1)
		}
		m.clamp()
		m.remember()
		return m, nil
	}
	if mouse.Button != tea.MouseLeft || m.detail != nil || m.narrow() {
		return m, nil
	}
	if mouse.Y == 0 { // the tiles
		x := 0
		for i := range tiles {
			w := tileWidth(m, i)
			if mouse.X >= x && mouse.X < x+w {
				m.focus = tiles[i].focus
			}
			x += w + 1
		}
		m.clamp()
		return m, nil
	}
	widths := m.columnWidths(m.boardWidth())
	x := 0
	for c, w := range widths {
		if mouse.X >= x && mouse.X < x+w {
			m.col = c
			// Inside a column: the border, its heading and a blank line, then three lines a card.
			if line := mouse.Y - boardTop - 3; line >= 0 {
				cols := m.columns()
				if row := m.top[c] + line/cardLines; row < len(cols[c]) {
					m.row[c] = row
				}
			}
		}
		x += w + 1
	}
	m.clamp()
	m.remember()
	return m, nil
}
