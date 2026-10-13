package tui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"todos/internal/api"
	"todos/internal/habit"
)

// The habits panel: today's habits in the order of the day, each checked in
// with a key. It opens over the board with t, when the app has habits.
//
// Streaks and everything else shown come from the app as they are; the panel
// reads the list again after every change, its own or anyone else's.

type (
	habitsMsg struct {
		habits []api.Habit
		err    error
	}
	habitChangedMsg struct {
		res  *api.HabitResult
		said string // what to say if it worked
		err  error
	}
)

// loadHabits reads the habits, if the app has them.
func (m Model) loadHabits() tea.Cmd {
	if !m.opts.Habits {
		return nil
	}
	c, ctx := m.opts.Client, m.ctx
	return func() tea.Msg {
		list, _, err := c.Habits(ctx, false)
		if err != nil {
			return habitsMsg{err: err}
		}
		return habitsMsg{habits: list.Habits}
	}
}

// habitList is what the panel shows, in order: to do, done, nothing today.
func (m Model) habitList() []api.Habit { return habit.ForToday(m.habits).All() }

func (m Model) selectedHabit() *api.Habit {
	list := m.habitList()
	if m.habitRow < 0 || m.habitRow >= len(list) {
		return nil
	}
	return &list[m.habitRow]
}

// habitsLoaded takes a fresh reading of the habits, keeping the selection on
// the habit it was on even if a check-in moved it down the list.
func (m Model) habitsLoaded(msg habitsMsg) Model {
	if msg.err != nil {
		if m.showHabits {
			m.notice = "couldn't read the habits: " + msg.err.Error()
		}
		return m
	}
	selected := 0
	if h := m.selectedHabit(); h != nil {
		selected = h.ID
	}
	m.habits = msg.habits
	if strings.HasPrefix(m.notice, "couldn't read the habits") {
		m.notice = ""
	}
	list := m.habitList()
	for i := range list {
		if list[i].ID == selected {
			m.habitRow = i
		}
	}
	m.habitRow = max(0, min(m.habitRow, len(list)-1))
	if len(list) == 0 {
		m.showHabits = false
	}
	return m
}

// changeHabit sends one change and reports what it did.
func (m Model) changeHabit(said string, fn func(c *api.Client) (*api.HabitResult, error)) tea.Cmd {
	c := m.opts.Client
	return func() tea.Msg {
		res, err := fn(c)
		return habitChangedMsg{res: res, said: said, err: err}
	}
}

func (m Model) habitChanged(msg habitChangedMsg) (Model, tea.Cmd) {
	if msg.err != nil {
		m.notice = msg.err.Error()
		return m, m.loadHabits()
	}
	m.notice = ""
	h := &msg.res.Habit
	said := msg.said
	// Where the app chose the time of day, say which it took.
	if slot := h.Slot(msg.res.Slot()); slot != nil && slot.Name != "" && !strings.Contains(said, strings.ToLower(slot.Name)) {
		said += ", " + strings.ToLower(slot.Name)
	}
	m.flash = fmt.Sprintf("%s: %s", said, strings.ToLower(habit.Progress(h)))
	if h.Streak.Current > 0 {
		m.flash += " · " + habit.Length(h.Streak.Current, h.Streak.Unit) + " in a row"
	}
	// What the app answered is shown at once; the list is read again for its order.
	for i := range m.habits {
		if m.habits[i].ID == h.ID {
			id := 0
			if sel := m.selectedHabit(); sel != nil {
				id = sel.ID
			}
			m.habits[i] = *h
			for j, shown := range m.habitList() {
				if shown.ID == id {
					m.habitRow = j
				}
			}
		}
	}
	return m, m.loadHabits()
}

// habitsKey handles a key while the panel is open.
func (m Model) habitsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	list := m.habitList()
	switch {
	case key.Matches(msg, m.keys.Back), key.Matches(msg, m.keys.Habits), msg.String() == "q":
		m.showHabits = false
		return m, nil
	case key.Matches(msg, m.keys.Help):
		m.showHelp, m.help.ShowAll = true, true
		return m, nil
	case key.Matches(msg, m.keys.Up):
		m.habitRow = max(0, m.habitRow-1)
		return m, nil
	case key.Matches(msg, m.keys.Down):
		m.habitRow = min(len(list)-1, m.habitRow+1)
		return m, nil
	case key.Matches(msg, m.keys.Top):
		m.habitRow = 0
		return m, nil
	case key.Matches(msg, m.keys.Bottom):
		m.habitRow = max(0, len(list)-1)
		return m, nil
	case key.Matches(msg, m.keys.Refresh):
		return m, tea.Batch(m.refresh(), m.loadHabits())
	}
	h := m.selectedHabit()
	if h == nil {
		return m, nil
	}
	id, name, ctx := h.ID, h.Name, m.ctx
	switch {
	case key.Matches(msg, m.keys.Done), key.Matches(msg, m.keys.Open), key.Matches(msg, m.keys.Toggle):
		// Whichever is still to do: the app picks, by the hour.
		if !habit.Due(h) {
			m.flash = name + " asks nothing more today"
			return m, nil
		}
		return m, m.changeHabit("Checked in "+name, func(c *api.Client) (*api.HabitResult, error) { return c.CheckIn(ctx, id, "", "") })
	case len(msg.String()) == 1 && msg.String() >= "1" && msg.String() <= "9":
		// A time of day by its number: checks it in, or takes it back if it is done.
		n := int(msg.String()[0] - '1')
		if h.Weekly() || n >= len(h.Today.Slots) {
			return m, nil
		}
		slot := h.Today.Slots[n]
		label := name + ", " + strings.ToLower(habit.SlotName(h, slot.ID))
		if slot.Done {
			return m, m.changeHabit("Took back "+label, func(c *api.Client) (*api.HabitResult, error) { return c.UndoCheckIn(ctx, id, slot.ID, "") })
		}
		return m, m.changeHabit("Checked in "+label, func(c *api.Client) (*api.HabitResult, error) { return c.CheckIn(ctx, id, slot.ID, "") })
	case key.Matches(msg, m.keys.HabitUndo):
		return m, m.changeHabit("Took back today's "+name, func(c *api.Client) (*api.HabitResult, error) { return c.UndoCheckIn(ctx, id, "", "") })
	case key.Matches(msg, m.keys.HabitYesterday):
		if !h.Weekly() && len(h.Yesterday.Remaining()) == 0 || h.Weekly() && h.Yesterday.CheckedIn {
			m.flash = name + " has nothing left from yesterday"
			return m, nil
		}
		return m, m.changeHabit("Logged yesterday's "+name, func(c *api.Client) (*api.HabitResult, error) { return c.CheckIn(ctx, id, "", "yesterday") })
	case key.Matches(msg, m.keys.HabitRest):
		rested := h.Today.State == "skipped" || (h.Week != nil && h.Week.State == "skipped")
		if rested {
			return m, m.changeHabit("Took back the rest for "+name, func(c *api.Client) (*api.HabitResult, error) { return c.UndoSkip(ctx, id, "") })
		}
		return m, m.changeHabit("Rest for "+name, func(c *api.Client) (*api.HabitResult, error) { return c.SkipHabit(ctx, id, "", "") })
	}
	return m, nil
}

// habitsStatus is what the status line says about habits, when there are any.
func (m Model) habitsStatus() string {
	if len(m.habits) == 0 {
		return ""
	}
	if left := habit.Left(m.habits); left > 0 {
		return fmt.Sprintf("habits: %d left", left)
	}
	return "habits done"
}

// slots is a habit's times of day today, numbered as the keys that toggle them.
func (m Model) habitSlots(h *api.Habit) string {
	s := m.styles
	if h.Paused || h.Archived {
		return ""
	}
	if h.Weekly() {
		if h.Today.CheckedIn {
			return s.OK.Render("● today")
		}
		return s.Muted.Render("○ today")
	}
	parts := make([]string, len(h.Today.Slots))
	for i, slot := range h.Today.Slots {
		label := fmt.Sprintf("%d %s", i+1, habit.SlotName(h, slot.ID))
		if known := h.Slot(slot.ID); len(h.Today.Slots) == 1 && (known == nil || known.Name == "") {
			label = "today" // done once a day, with no name for when
		}
		if slot.Done {
			parts[i] = s.OK.Render("● " + label)
		} else {
			parts[i] = s.Muted.Render("○ " + label)
		}
	}
	return strings.Join(parts, "  ")
}

func (m Model) habitsView(height int) string {
	s := m.styles
	today := habit.ForToday(m.habits)
	list := today.All()
	head := "Habits · all done today"
	if left := habit.Left(m.habits); left > 0 {
		head = fmt.Sprintf("Habits · %d left today", left)
	}
	var wName, wProgress, wStreak int
	streak := func(h *api.Habit) string {
		if h.Streak.Current == 0 {
			return ""
		}
		text := habit.Length(h.Streak.Current, h.Streak.Unit)
		if h.Streak.AtRisk != nil {
			return text + ", at risk"
		}
		return text
	}
	for i := range list {
		wName = max(wName, lipgloss.Width(list[i].Name))
		wProgress = max(wProgress, lipgloss.Width(habit.Progress(&list[i])))
		wStreak = max(wStreak, lipgloss.Width(streak(&list[i])))
	}
	wName = min(wName, max(12, m.width/3))
	pad := func(text string, width int) string {
		text = ansi.Truncate(text, width, "…")
		return text + strings.Repeat(" ", max(0, width-lipgloss.Width(text)))
	}

	lines := []string{"", " " + s.Title.Render(head), ""}
	selectedLine, row := 0, 0
	for _, group := range []struct {
		title string
		list  []api.Habit
	}{{"To do today", today.Due}, {"Done", today.Done}, {"Not today", today.Off}} {
		if len(group.list) == 0 {
			continue
		}
		lines = append(lines, " "+s.Muted.Render(group.title))
		for i := range group.list {
			h := &group.list[i]
			bar := "  "
			if row == m.habitRow {
				bar = s.Accent.Render("▌") + " "
				selectedLine = len(lines)
			}
			name := s.TitleDone.Render(pad(h.Name, wName))
			if habit.Due(h) {
				name = s.Title.Render(pad(h.Name, wName))
			}
			streakCell := pad(streak(h), wStreak)
			if h.Streak.AtRisk != nil {
				streakCell = s.Warn.Render(streakCell)
			} else {
				streakCell = s.Claude.Render(streakCell)
			}
			line := bar + name + "  " + s.Muted.Render(pad(habit.Progress(h), wProgress)) + "  " + streakCell
			if slots := m.habitSlots(h); lipgloss.Width(line)+2+lipgloss.Width(slots) < m.width {
				lines = append(lines, strings.TrimRight(line+"  "+slots, " "))
			} else {
				// No room beside it: the times of day go on a line of their own.
				lines = append(lines, ansi.Truncate(strings.TrimRight(line, " "), m.width-1, "…"))
				if slots != "" {
					lines = append(lines, ansi.Truncate("    "+slots, m.width-1, "…"))
				}
			}
			if risk := habit.AtRisk(h); risk != "" && row == m.habitRow {
				lines = append(lines, ansi.Truncate("    "+s.Warn.Render(risk+" Press y."), m.width-1, "…"))
			}
			row++
		}
		lines = append(lines, "")
	}
	// Scroll so the selected habit is in view.
	top := max(0, min(selectedLine-height/2, len(lines)-height))
	return strings.Join(lines[top:min(len(lines), top+height)], "\n")
}

func (m Model) habitsHint() string {
	return "x check in · 1-9 a time of day · u take back · y yesterday · s rest day · esc back"
}
