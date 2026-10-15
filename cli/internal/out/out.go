// Package out turns tasks into what the commands print: aligned and colored for
// a terminal, plain tab-separated lines for a pipe, or the server's own JSON.
package out

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"

	"todos/internal/api"
	"todos/internal/queue"
)

// Printer writes results. The zero value prints plainly.
type Printer struct {
	W      io.Writer
	Styled bool   // a terminal: color, alignment and headings
	Pretty bool   // a terminal: JSON is indented
	JSON   bool   // --json
	Today  string // today on the Mac (YYYY-MM-DD), which decides what is overdue
	Width  int    // the terminal's width; 80 if unknown
	Dark   bool   // the terminal has a dark background
	Loc    *time.Location
}

// Colors for one-off output are the terminal's own sixteen, which suit a light
// or a dark background without asking the terminal which it has.
var (
	faint  = lipgloss.NewStyle().Faint(true)
	bold   = lipgloss.NewStyle().Bold(true)
	red    = lipgloss.NewStyle().Foreground(lipgloss.Red)
	yellow = lipgloss.NewStyle().Foreground(lipgloss.Yellow)
	green  = lipgloss.NewStyle().Foreground(lipgloss.Green)
	blue   = lipgloss.NewStyle().Foreground(lipgloss.Blue)
	orange = lipgloss.NewStyle().Foreground(lipgloss.BrightRed)
)

// StatusLabel is a status as the app words it.
func StatusLabel(status string) string {
	switch status {
	case "todo":
		return "To do"
	case "in_progress":
		return "In progress"
	case "blocked":
		return "Blocked"
	case "done":
		return "Done"
	}
	return status
}

func (p *Printer) loc() *time.Location {
	if p.Loc != nil {
		return p.Loc
	}
	return time.Local
}

func (p *Printer) width() int {
	if p.Width > 0 {
		return p.Width
	}
	return 80
}

// style applies s on a terminal, and nothing otherwise.
func (p *Printer) style(s lipgloss.Style, text string) string {
	if !p.Styled || text == "" {
		return text
	}
	return s.Render(text)
}

// Value prints v as JSON: indented for a terminal, on one line for a pipe.
func (p *Printer) Value(v any) error {
	var b []byte
	var err error
	if p.Pretty {
		b, err = json.MarshalIndent(v, "", "  ")
	} else {
		b, err = json.Marshal(v)
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(p.W, "%s\n", b)
	return err
}

// Line prints a compact one-line JSON value, whatever the output is. For
// streams of values, one to a line.
func (p *Printer) Line(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(p.W, "%s\n", b)
	return err
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// Row is a task as one plain line: id, status, priority, due and title,
// separated by tabs. A task with no due date has "-" there.
func Row(t *api.Task) string {
	due := t.Due
	if due == "" {
		due = "-"
	}
	return fmt.Sprintf("%d\t%s\t%s\t%s\t%s", t.ID, t.Status, t.Priority, due, oneLine(t.Title))
}

// DueLabel says when a task is due relative to today: "today", "tomorrow",
// "Fri", "Oct 20", or "3d overdue". Late is true when the date has passed.
func DueLabel(due, today string) (label string, late bool) {
	if due == "" {
		return "", false
	}
	d, err1 := time.Parse("2006-01-02", due)
	t0, err2 := time.Parse("2006-01-02", today)
	if err1 != nil || err2 != nil {
		return due, false
	}
	days := int(d.Sub(t0).Hours() / 24)
	switch {
	case days < 0:
		return fmt.Sprintf("%dd overdue", -days), true
	case days == 0:
		return "today", false
	case days == 1:
		return "tomorrow", false
	case days < 7:
		return d.Format("Mon"), false
	case d.Year() == t0.Year():
		return d.Format("Jan 2"), false
	}
	return due, false
}

func (p *Printer) statusCell(t *api.Task) string {
	label := StatusLabel(t.Status)
	switch t.Status {
	case "in_progress":
		return p.style(blue, label)
	case "blocked":
		return p.style(yellow, label)
	case "done":
		return p.style(green, label)
	}
	return label
}

func (p *Printer) priorityCell(t *api.Task) string {
	switch t.Priority {
	case "high":
		return p.style(red, "high")
	case "low":
		return p.style(faint, "low")
	}
	return ""
}

func (p *Printer) dueCell(t *api.Task) string {
	label, late := DueLabel(t.Due, p.Today)
	switch {
	case t.Status == "done":
		// Finished: when it was due no longer matters, and it is not "overdue".
		if d, err := time.Parse("2006-01-02", t.Due); err == nil {
			return p.style(faint, d.Format("Jan 2"))
		}
		return p.style(faint, t.Due)
	case late:
		return p.style(red, label)
	case label == "today":
		return p.style(yellow, label)
	}
	return label
}

// extras are the small things after a title: project, tags, who has it, progress.
func (p *Printer) extras(t *api.Task) string {
	var parts []string
	if t.Project != "" {
		parts = append(parts, "#"+t.Project)
	}
	for _, tag := range t.Tags {
		parts = append(parts, "@"+tag)
	}
	if len(t.Subtasks) > 0 {
		parts = append(parts, fmt.Sprintf("%d/%d", t.SubtasksDone(), len(t.Subtasks)))
	}
	if t.Repeat != "" {
		parts = append(parts, "↻ "+t.Repeat)
	}
	out := p.style(faint, strings.Join(parts, " "))
	if t.Assignee == "claude" {
		who := p.style(orange, "claude")
		if out == "" {
			return who
		}
		return who + " " + out
	}
	return out
}

func pad(s string, width int) string {
	if n := width - lipgloss.Width(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}

// Tasks prints a list: one Row per task for a pipe; an aligned table on a terminal.
func (p *Printer) Tasks(tasks []api.Task) {
	if !p.Styled {
		for i := range tasks {
			fmt.Fprintln(p.W, Row(&tasks[i]))
		}
		return
	}
	if len(tasks) == 0 {
		fmt.Fprintln(p.W, p.style(faint, "Nothing here."))
		return
	}
	type row struct{ id, status, priority, due, title, extras string }
	rows := make([]row, len(tasks))
	var wID, wStatus, wPriority, wDue int
	for i := range tasks {
		t := &tasks[i]
		title := oneLine(t.Title)
		if t.Status == "done" {
			title = p.style(faint, title)
		} else {
			title = p.style(bold, title)
		}
		rows[i] = row{p.style(faint, fmt.Sprintf("#%d", t.ID)), p.statusCell(t), p.priorityCell(t), p.dueCell(t), title, p.extras(t)}
		wID, wStatus = max(wID, lipgloss.Width(rows[i].id)), max(wStatus, lipgloss.Width(rows[i].status))
		wPriority, wDue = max(wPriority, lipgloss.Width(rows[i].priority)), max(wDue, lipgloss.Width(rows[i].due))
	}
	for _, r := range rows {
		line := pad(r.id, wID) + "  " + pad(r.status, wStatus) + "  "
		if wPriority > 0 {
			line += pad(r.priority, wPriority) + "  "
		}
		if wDue > 0 {
			line += pad(r.due, wDue) + "  "
		}
		line += r.title
		if r.extras != "" {
			line += "  " + r.extras
		}
		fmt.Fprintln(p.W, strings.TrimRight(line, " "))
	}
}

// Heading prints a section heading on a terminal, and nothing for a pipe.
func (p *Printer) Heading(text string) {
	if p.Styled {
		fmt.Fprintln(p.W, p.style(bold, text))
	}
}

// Blank prints an empty line on a terminal, and nothing for a pipe.
func (p *Printer) Blank() {
	if p.Styled {
		fmt.Fprintln(p.W)
	}
}

// Changed prints the result of a change to one task: its Row for a pipe, or a
// line saying what happened on a terminal.
func (p *Printer) Changed(verb string, t *api.Task) {
	if !p.Styled {
		fmt.Fprintln(p.W, Row(t))
		return
	}
	line := fmt.Sprintf("%s %s %s", p.style(green, "✓"), verb, p.style(faint, fmt.Sprintf("#%d", t.ID))+" "+p.style(bold, oneLine(t.Title)))
	var details []string
	if label, _ := DueLabel(t.Due, p.Today); label != "" && t.Status != "done" {
		details = append(details, "due "+label)
	}
	if t.Priority != "medium" && t.Status != "done" {
		details = append(details, t.Priority)
	}
	if extras := p.extras(t); extras != "" && t.Status != "done" {
		details = append(details, extras)
	}
	if len(details) > 0 {
		line += "  " + p.style(faint, strings.Join(details, " · "))
	}
	fmt.Fprintln(p.W, line)
}

// Note prints a secondary line, on a terminal only.
func (p *Printer) Note(format string, args ...any) {
	if p.Styled {
		fmt.Fprintln(p.W, p.style(faint, "  "+fmt.Sprintf(format, args...)))
	}
}

// Saved says, on a terminal, that a change was kept to be sent later.
func (p *Printer) Saved(what string) {
	fmt.Fprintln(p.W, p.style(yellow, "◷")+" Saved for later  "+p.style(bold, oneLine(what)))
}

// TurnedDown says, on a terminal, that the app refused a change sent from the queue.
func (p *Printer) TurnedDown(what, why string) {
	fmt.Fprintln(p.W, p.style(red, "✗")+" Turned down  "+p.style(bold, oneLine(what))+"  "+p.style(faint, oneLine(why)))
}

// Queue lists changes saved to be sent later. For a terminal: a line each
// with its number, when it was made and what it is, and why the app turned
// it down if it did. For a pipe: tab-separated fields, which are the number,
// "waiting" or "refused", when it was made (RFC 3339), the kind, the task ("-"
// if none), the text ("-" if none), and why it was refused ("-" if it wasn't).
func (p *Printer) Queue(items []queue.Item) {
	if !p.Styled {
		for _, it := range items {
			state, task, why := "waiting", "-", "-"
			if !it.Waiting() {
				state, why = "refused", oneLine(it.Refused.Message)
			}
			if it.Task > 0 {
				task = strconv.Itoa(it.Task)
			}
			text := oneLine(it.Text)
			if it.Kind == queue.KindSubtasks {
				text = oneLine(strings.Join(it.Titles, "; "))
			}
			if text == "" {
				text = "-"
			}
			fmt.Fprintf(p.W, "%d\t%s\t%s\t%s\t%s\t%s\t%s\n", it.ID, state, it.Made.UTC().Format(time.RFC3339), it.Kind, task, text, why)
		}
		return
	}
	if len(items) == 0 {
		fmt.Fprintln(p.W, p.style(faint, "Nothing is waiting to be sent."))
		return
	}
	width := len(strconv.Itoa(items[len(items)-1].ID))
	for _, it := range items {
		mark := p.style(yellow, "◷")
		if !it.Waiting() {
			mark = p.style(red, "✗")
		}
		fmt.Fprintf(p.W, "%s %s  %s  %s\n", mark, p.style(faint, fmt.Sprintf("%*d", width, it.ID)),
			p.style(faint, it.Made.In(p.loc()).Format("Jan 2 15:04")), oneLine(it.Describe()))
		if !it.Waiting() {
			fmt.Fprintf(p.W, "  %s %s\n", strings.Repeat(" ", width), p.style(red, "turned down: "+oneLine(it.Refused.Message)))
		}
	}
}

// When shows a timestamp from the server in local time.
func (p *Printer) When(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return t.In(p.loc()).Format("Jan 2 15:04")
}

// Markdown renders notes for a terminal. If that fails the notes are returned as written.
func (p *Printer) Markdown(text string, width int) string {
	style := "light"
	if p.Dark {
		style = "dark"
	}
	r, err := glamour.NewTermRenderer(glamour.WithStylePath(style), glamour.WithWordWrap(width))
	if err != nil {
		return text
	}
	rendered, err := r.Render(text)
	if err != nil {
		return text
	}
	// Glamour pads every line out to the full width with styled spaces. Drop them.
	lines := strings.Split(strings.Trim(rendered, "\n"), "\n")
	for i, line := range lines {
		if trimmed := padding.ReplaceAllString(line, ""); trimmed != line && strings.Contains(trimmed, "\x1b") {
			lines[i] = trimmed + "\x1b[m"
		} else {
			lines[i] = trimmed
		}
	}
	return strings.Join(lines, "\n")
}

// Styled spaces at the end of a line.
var padding = regexp.MustCompile("(?:\x1b\\[[0-9;]*m| )+$")

// Who names the author of an activity entry as the app does.
func Who(a api.Activity) string {
	who := a.By
	switch a.By {
	case "me":
		who = "you"
	case "claude":
		who = "Claude"
	}
	if a.Via != "" {
		who += " · " + a.Via
	}
	return who
}

// Detail prints everything about one task.
func (p *Printer) Detail(t *api.Task) {
	w := p.W
	fmt.Fprintf(w, "%s %s\n", p.style(faint, fmt.Sprintf("#%d", t.ID)), p.style(bold, oneLine(t.Title)))

	meta := []string{p.statusCell(t)}
	if t.Priority != "" {
		prio := t.Priority + " priority"
		if t.Priority == "high" {
			prio = p.style(red, prio)
		}
		meta = append(meta, prio)
	}
	if t.Due != "" {
		label, late := DueLabel(t.Due, p.Today)
		due := "due " + t.Due
		if label != "" && label != t.Due {
			due += " (" + label + ")"
		}
		if late && t.Status != "done" {
			due = p.style(red, due)
		}
		meta = append(meta, due)
	}
	if t.Project != "" {
		meta = append(meta, "#"+t.Project)
	}
	for _, tag := range t.Tags {
		meta = append(meta, "@"+tag)
	}
	who := "yours"
	if t.Assignee == "claude" {
		who = p.style(orange, "with Claude")
	}
	meta = append(meta, who)
	fmt.Fprintln(w, strings.Join(meta, " · "))

	var more []string
	if t.Repeat != "" {
		more = append(more, "repeats "+t.Repeat)
	}
	if t.RemindAt != "" {
		remind := "reminder " + p.When(t.RemindAt)
		if t.RemindedAt != "" {
			remind += " (sent)"
		}
		more = append(more, remind)
	}
	more = append(more, "created "+p.When(t.CreatedAt), "updated "+p.When(t.UpdatedAt))
	if t.CompletedAt != "" {
		more = append(more, "completed "+p.When(t.CompletedAt))
	}
	more = append(more, fmt.Sprintf("rev %d", t.Rev))
	fmt.Fprintln(w, p.style(faint, strings.Join(more, " · ")))

	if strings.TrimSpace(t.Notes) != "" {
		fmt.Fprintln(w)
		if p.Styled {
			fmt.Fprintln(w, p.Markdown(t.Notes, min(p.width(), 100)))
		} else {
			fmt.Fprintln(w, t.Notes)
		}
	}

	if len(t.Subtasks) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, p.style(bold, fmt.Sprintf("Subtasks %d/%d", t.SubtasksDone(), len(t.Subtasks))))
		for _, s := range t.Subtasks {
			box, title := "[ ]", s.Title
			if s.Done {
				box, title = "[x]", p.style(faint, s.Title)
			}
			if p.Styled {
				box = map[bool]string{true: p.style(green, "✓"), false: "○"}[s.Done]
			}
			fmt.Fprintf(w, "  %s %s %s\n", box, p.style(faint, fmt.Sprintf("%d", s.ID)), title)
		}
	}

	if len(t.Activity) > 0 {
		fmt.Fprintln(w)
		fmt.Fprintln(w, p.style(bold, "Activity"))
		wWhen, wWho := 0, 0
		for _, a := range t.Activity {
			wWhen, wWho = max(wWhen, lipgloss.Width(p.When(a.At))), max(wWho, lipgloss.Width(Who(a)))
		}
		for _, a := range t.Activity {
			text := a.Text
			if a.Kind == "comment" {
				text = "“" + text + "”"
			}
			fmt.Fprintf(w, "  %s  %s  %s\n", p.style(faint, pad(p.When(a.At), wWhen)), pad(Who(a), wWho), text)
		}
	}
}
