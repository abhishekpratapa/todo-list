package tui

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"todos/internal/api"
	"todos/internal/out"
)

const (
	boardTop  = 2 // lines above the board: the tiles, and the search line
	cardLines = 3 // a card is two lines and a gap
)

func (m Model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.WindowTitle = "Todos"
	if m.opts.Mouse {
		v.MouseMode = tea.MouseModeCellMotion
	}
	return v
}

// bodyHeight is how many lines the board itself gets.
func (m Model) bodyHeight() int {
	return max(0, m.height-boardTop-2) // less the status line and the help line
}

// paneWidth is how wide the detail is: beside the board on a wide terminal,
// instead of it on a narrower one.
func (m Model) paneWidth() int {
	if m.width >= paneFrom {
		return min(64, m.width*45/100)
	}
	return m.width
}

// boardWidth is what is left for the columns.
func (m Model) boardWidth() int {
	if m.detail != nil && m.width >= paneFrom {
		return m.width - m.paneWidth() - 1
	}
	return m.width
}

func (m Model) columnWidths(total int) [4]int {
	var w [4]int
	each, extra := (total-3)/4, (total-3)%4
	for i := range w {
		w[i] = each
		if i < extra {
			w[i]++
		}
	}
	return w
}

// cardsVisible is how many cards fit in a column. Zero in the narrow list,
// which scrolls as one.
func (m Model) cardsVisible() int {
	if m.narrow() {
		return 0
	}
	// Inside the border: a heading, a gap, then the cards. The last line is kept for "more below".
	return max(1, (m.bodyHeight()-4)/cardLines)
}

func (m Model) render() string {
	if m.width == 0 || m.height == 0 {
		return ""
	}
	if m.width < 30 || m.height < 8 {
		return ansi.Truncate("The window is too small for the board.", m.width, "")
	}
	h := m.bodyHeight()
	var body string
	switch {
	case m.showHelp:
		body = m.helpPage()
	case !m.loaded && m.notice == "":
		body = m.styles.Muted.Render("\n  Reading the list…")
	case m.edit.active() && m.edit.fullScreen():
		body = m.editView(h)
	case m.showHabits:
		body = m.habitsView(h)
	case m.detail != nil && m.width < paneFrom:
		body = m.detailView(h)
	case m.detail != nil:
		body = lipgloss.JoinHorizontal(lipgloss.Top, m.boardView(m.boardWidth(), h), " ", m.detailView(h))
	case m.narrow():
		body = m.listView(h)
	default:
		body = m.boardView(m.width, h)
	}
	body = lipgloss.NewStyle().Width(m.width).Height(h).MaxHeight(h).MaxWidth(m.width).Render(body)
	return strings.Join([]string{m.tilesView(), m.secondLine(), body, m.statusView(), m.helpLine()}, "\n")
}

func (m Model) tileCount(f focus) int {
	switch f {
	case focusToday:
		return m.counts.DueToday
	case focusOverdue:
		return m.counts.Overdue
	case focusClaude:
		return m.counts.Claude
	case focusDone:
		return m.counts.Done7d
	case focusNow:
		return m.counts.Overdue + m.counts.DueToday // what the Dock badge counts
	}
	return m.counts.Open
}

func tileText(m Model, i int) string {
	label := tiles[i].label
	if m.width < 100 {
		label = tiles[i].short
	}
	return fmt.Sprintf("%s %d", label, m.tileCount(tiles[i].focus))
}

func tileWidth(m Model, i int) int { return lipgloss.Width(tileText(m, i)) + 2 }

func (m Model) tilesView() string {
	parts := make([]string, len(tiles))
	for i, tile := range tiles {
		style := m.styles.Tile
		switch {
		case tile.focus == m.focus:
			style = m.styles.TileActive
		case tile.focus == focusOverdue && m.counts.Overdue > 0:
			style = m.styles.TileAlert
		}
		parts[i] = style.Render(tileText(m, i))
	}
	return ansi.Truncate(strings.Join(parts, " "), m.width, "")
}

// secondLine is the search box while searching, what is being searched for
// afterwards, and otherwise whatever an edit in progress has to say.
func (m Model) secondLine() string {
	switch {
	case m.edit.banner() != "":
		return ansi.Truncate(m.styles.Banner.Render(m.edit.banner()), m.width, "…")
	case m.edit.mode == editCapture, m.edit.mode == editComment, m.edit.mode == editSubtask:
		return ansi.Truncate(" "+m.edit.input.View(), m.width, "")
	case m.searching:
		return ansi.Truncate(" "+m.search.View(), m.width, "")
	case m.query != "":
		return ansi.Truncate(" "+m.styles.Accent.Render("/ "+m.query)+m.styles.Faint.Render("   esc clears"), m.width, "…")
	}
	return ""
}

var statusLabels = [4]string{"To do", "In progress", "Blocked", "Done"}

func (m Model) statusStyle(c int) lipgloss.Style {
	switch statuses[c] {
	case "in_progress":
		return m.styles.Info.Bold(true)
	case "blocked":
		return m.styles.Warn.Bold(true)
	case "done":
		return m.styles.OK.Bold(true)
	}
	return m.styles.Title
}

// spread puts left and right at the two ends of a line of the given width.
func spread(left, right string, width int) string {
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return ansi.Truncate(left, max(0, width-lipgloss.Width(right)-1), "…") + " " + right
	}
	return left + strings.Repeat(" ", gap) + right
}

func (m Model) boardView(width, height int) string {
	cols := m.columns()
	widths := m.columnWidths(width)
	visible := m.cardsVisible()
	rendered := make([]string, 0, 7)
	for c := range cols {
		style := m.styles.Column
		if c == m.col && m.detail == nil {
			style = m.styles.ColumnFocused
		}
		inner := widths[c] - 4
		lines := []string{spread(m.statusStyle(c).Render(statusLabels[c]), m.styles.Faint.Render(fmt.Sprint(len(cols[c]))), inner), ""}
		end := min(len(cols[c]), m.top[c]+visible)
		for i := m.top[c]; i < end; i++ {
			first, second := m.card(&cols[c][i], inner, c == m.col && i == m.row[c])
			lines = append(lines, first, second, "")
		}
		if len(cols[c]) == 0 {
			lines = append(lines, m.styles.Faint.Render(ansi.Truncate("  nothing here", inner, "")))
		}
		var more []string
		if m.top[c] > 0 {
			more = append(more, fmt.Sprintf("↑ %d", m.top[c]))
		}
		if end < len(cols[c]) {
			more = append(more, fmt.Sprintf("↓ %d more", len(cols[c])-end))
		}
		if len(more) > 0 {
			for len(lines) < height-3 {
				lines = append(lines, "")
			}
			lines = append(lines[:height-3], m.styles.Faint.Render("  "+strings.Join(more, " · ")))
		}
		rendered = append(rendered, style.Width(widths[c]).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n")))
		if c < len(cols)-1 {
			rendered = append(rendered, " ")
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, rendered...)
}

// meta is the small print under a card's title.
func (m Model) meta(t *api.Task) string {
	s := m.styles
	var parts []string
	if t.Status == "done" {
		if when, err := time.Parse(time.RFC3339, t.CompletedAt); err == nil {
			parts = append(parts, s.Faint.Render(when.In(m.opts.Loc).Format("Jan 2")))
		}
	} else {
		switch t.Priority {
		case "high":
			parts = append(parts, s.Danger.Render("high"))
		case "low":
			parts = append(parts, s.Faint.Render("low"))
		}
		if label, late := out.DueLabel(t.Due, m.today); label != "" {
			switch {
			case late:
				label = s.Danger.Render(label)
			case label == "today":
				label = s.Warn.Render(label)
			default:
				label = s.Muted.Render(label)
			}
			parts = append(parts, label)
		}
	}
	if t.Assignee == "claude" {
		parts = append(parts, s.Claude.Render("claude"))
	}
	if t.Project != "" {
		parts = append(parts, s.Muted.Render("#"+t.Project))
	}
	for _, tag := range t.Tags {
		parts = append(parts, s.Muted.Render("@"+tag))
	}
	if n := len(t.Subtasks); n > 0 {
		parts = append(parts, s.Muted.Render(fmt.Sprintf("%d/%d", t.SubtasksDone(), n)))
	}
	if t.Repeat != "" {
		parts = append(parts, s.Muted.Render("↻"))
	}
	return strings.Join(parts, s.Faint.Render(" · "))
}

func (m Model) title(t *api.Task) string {
	title := strings.Join(strings.Fields(t.Title), " ")
	if t.Status == "done" {
		return m.styles.TitleDone.Render(title)
	}
	return m.styles.Title.Render(title)
}

// card is a task as two lines. The selected one has a bar down its left side,
// which shows in any terminal, with or without color.
func (m Model) card(t *api.Task, width int, selected bool) (string, string) {
	bar := "  "
	if selected {
		bar = m.styles.Accent.Render("▌") + " "
	}
	first := m.styles.Faint.Render(fmt.Sprintf("#%d ", t.ID)) + m.title(t)
	return bar + ansi.Truncate(first, width-2, "…"), bar + ansi.Truncate(m.meta(t), width-2, "…")
}

// listView is the board on a narrow terminal: one list, grouped by status.
func (m Model) listView(height int) string {
	cols := m.columns()
	var lines []string
	selectedLine := 0
	for c := range cols {
		if len(cols[c]) == 0 {
			continue
		}
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, " "+m.statusStyle(c).Render(statusLabels[c])+m.styles.Faint.Render(fmt.Sprintf(" · %d", len(cols[c]))))
		for i := range cols[c] {
			t := &cols[c][i]
			bar := "  "
			if c == m.col && i == m.row[c] {
				bar = m.styles.Accent.Render("▌") + " "
				selectedLine = len(lines)
			}
			line := m.styles.Faint.Render(fmt.Sprintf("#%d ", t.ID)) + m.title(t)
			if meta := m.meta(t); meta != "" {
				line += "  " + meta
			}
			lines = append(lines, bar+ansi.Truncate(line, m.width-3, "…"))
		}
	}
	if len(lines) == 0 {
		return m.styles.Faint.Render("\n  Nothing here.")
	}
	// Scroll so the selected line is in view, near the middle when there is room.
	top := max(0, min(selectedLine-height/2, len(lines)-height))
	return strings.Join(lines[top:min(len(lines), top+height)], "\n")
}

// layoutDetail fits the open task into its pane.
func (m *Model) layoutDetail() {
	if m.detail == nil || m.width == 0 {
		return
	}
	width, height := m.paneWidth()-4, m.bodyHeight()-2
	if width < 10 || height < 1 {
		return
	}
	// A copy: the model this one was made from keeps the detail it had.
	d := *m.detail
	m.detail = &d
	at := m.detail.view.YOffset()
	m.detail.view.SetWidth(width)
	m.detail.view.SetHeight(height)
	content := ""
	if m.detail.task != nil {
		var buf bytes.Buffer
		p := &out.Printer{W: &buf, Styled: true, Today: m.today, Width: width, Dark: m.dark, Loc: m.opts.Loc}
		p.Detail(m.detail.task)
		content = lipgloss.NewStyle().Width(width).Render(strings.TrimRight(buf.String(), "\n"))
		if m.detail.loading {
			content += "\n\n" + m.styles.Faint.Render("Reading its history…")
		}
	}
	m.detail.view.SetContent(content)
	m.detail.view.SetYOffset(at)
}

func (m Model) detailView(height int) string {
	return m.styles.Pane.Width(m.paneWidth()).Height(height).MaxHeight(height).Render(m.detail.view.View())
}

func (m Model) ago(t time.Time) string {
	d := m.opts.Now().Sub(t)
	switch {
	case t.IsZero():
		return ""
	case d < 10*time.Second:
		return "updated just now"
	case d < time.Minute:
		return fmt.Sprintf("updated %ds ago", int(d.Seconds())/10*10)
	case d < time.Hour:
		return fmt.Sprintf("updated %dm ago", int(d.Minutes()))
	}
	return "updated at " + t.In(m.opts.Loc).Format("15:04")
}

// statusView is the line that says how things stand: the connection, the
// profile, how fresh the list is, and anything that went wrong.
func (m Model) statusView() string {
	s := m.styles
	var live string
	switch m.live {
	case liveOn:
		live = s.OK.Render("●") + s.StatusBar.Render(" live")
	case liveOff:
		live = s.Warn.Render("○ reconnecting")
		if m.retry > 0 {
			live += s.StatusBar.Render(fmt.Sprintf(" in %ds", int(m.retry.Seconds())))
		}
	case liveEnded:
		live = s.Danger.Render("○ not live")
	default:
		live = s.StatusBar.Render("◌ connecting")
	}
	parts := []string{live, s.StatusBar.Render(m.opts.Profile)}
	if ago := m.ago(m.updated); ago != "" {
		parts = append(parts, s.StatusBar.Render(ago))
	}
	if habits := m.habitsStatus(); habits != "" {
		parts = append(parts, s.StatusBar.Render(habits))
	}
	if m.order > 0 {
		parts = append(parts, s.StatusBar.Render("sorted by "+sorts[m.order].label))
	}
	left := " " + strings.Join(parts, s.Faint.Render(" · "))
	right := ""
	room := max(10, m.width-lipgloss.Width(left)-3)
	switch {
	case m.notice != "":
		right = s.Error.Render(ansi.Truncate(strings.Join(strings.Fields(m.notice), " "), room, "…")) + " "
	case m.flash != "":
		right = s.OK.Render(ansi.Truncate(strings.Join(strings.Fields(m.flash), " "), room, "…")) + " "
	}
	return spread(left, right, m.width)
}

func (m Model) helpLine() string {
	if m.showHelp {
		return m.styles.Faint.Render(" any key closes this")
	}
	if hint := m.edit.hint(); hint != "" {
		return ansi.Truncate(" "+m.styles.Faint.Render(hint), m.width, "…")
	}
	if m.showHabits {
		return ansi.Truncate(" "+m.styles.Faint.Render(m.habitsHint()), m.width, "…")
	}
	keys := m.boardKeys()
	if m.detail != nil {
		keys = m.detailKeys()
	}
	return ansi.Truncate(" "+m.help.ShortHelpView(keys), m.width, "…")
}

func (m Model) helpPage() string {
	groups := m.fullHelp()
	wide := m.help
	wide.SetWidth(0) // as wide as it wants, to see whether it fits
	keys := wide.FullHelpView(groups)
	if lipgloss.Width(keys) > m.width-4 {
		// Too wide for the window: two groups above, two below.
		keys = wide.FullHelpView(groups[:2]) + "\n\n" + wide.FullHelpView(groups[2:])
	}
	return "\n" + lipgloss.NewStyle().Padding(0, 2).Render(m.styles.Title.Render("Keys")+"\n\n"+keys)
}
