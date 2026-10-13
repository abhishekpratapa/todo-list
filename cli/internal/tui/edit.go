package tui

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"todos/internal/api"
	"todos/internal/out"
)

// Changing things from the board.
//
// Every change is based on the task as it was on screen when the change began.
// Adding to a task (a comment, a subtask, checking one off, finishing it) can't
// overwrite anything. Changing its fields can, so those are sent with the
// revision they were based on. If the task has moved on in the meantime and the
// same fields changed, nothing is written: the two versions are shown side by
// side and the user chooses.

type editMode int

const (
	editNone     editMode = iota
	editCapture           // typing a new task, one line
	editComment           // typing a comment
	editSubtask           // typing a subtask's title
	editDelete            // asked "delete?"
	editForm              // the fields form
	editConflict          // the task changed under an edit; choosing what to do
)

type editState struct {
	mode   editMode
	input  textinput.Model
	target *api.Task // the task being changed, as it was when this began

	form    *huh.Form
	values  *formValues
	initial formValues

	seq     int    // counts what is typed into capture, so a late preview is ignored
	preview string // how the app would read the line being typed

	changed bool // the target was changed by someone else since this began
	gone    bool // ... or deleted

	conflict *conflict
}

// conflict is a change that was refused because the same fields had changed.
type conflict struct {
	base    *api.Task      // what the change was based on
	current *api.Task      // the task now
	fields  map[string]any // what the change wanted to set
	verb    string
}

// formValues are the form's fields, as text.
type formValues struct {
	Title, Due, Priority, Project, Tags, Assignee, Repeat, Remind string
}

type (
	savedMsg struct {
		verb    string
		id      int
		res     *api.TaskResult
		err     error
		base    *api.Task
		fields  map[string]any
		deleted bool
	}
	previewMsg struct {
		seq  int
		text string
	}
	previewTick struct{ seq int }
)

func newEditState() editState {
	return editState{input: textinput.New()}
}

func (e editState) active() bool     { return e.mode != editNone }
func (e editState) fullScreen() bool { return e.mode == editForm || e.mode == editConflict }

// banner is the line under the tiles while a change is being made.
func (e editState) banner() string {
	if e.target == nil {
		return ""
	}
	switch {
	case e.mode == editDelete:
		return fmt.Sprintf("Delete #%d “%s”?  y deletes · n keeps it", e.target.ID, e.target.Title)
	case e.mode == editForm && e.gone:
		return fmt.Sprintf("#%d was deleted elsewhere while you were editing it. Saving won't bring it back.", e.target.ID)
	case e.mode == editForm && e.changed:
		return fmt.Sprintf("#%d was changed elsewhere while you edit. ctrl+r loads the new version; or carry on and save yours.", e.target.ID)
	}
	return ""
}

// hint is the bottom line while a change is being made.
func (e editState) hint() string {
	switch e.mode {
	case editCapture:
		if e.preview != "" {
			return e.preview
		}
		return "one line: Renew passport fri !high #personal @errand  ·  enter adds · esc cancels"
	case editComment, editSubtask:
		return "enter saves · esc cancels"
	case editDelete:
		return "y deletes · n keeps it"
	case editForm:
		return "tab next field · shift+tab back · ←/→ choose · enter on the last field saves · esc cancels"
	case editConflict:
		return "o save mine over theirs · t keep theirs · e keep editing"
	}
	return ""
}

func (m Model) boardKeys() []key.Binding {
	k := m.keys
	keys := []key.Binding{k.Help, k.Add, k.Open, k.Edit, k.Done, k.Search, k.NextTile, k.Quit}
	if len(m.habits) > 0 {
		keys = append(keys[:len(keys)-1], k.Habits, k.Quit)
	}
	return keys
}

func (m Model) detailKeys() []key.Binding {
	k := m.keys
	return []key.Binding{k.Back, k.Edit, k.Comment, k.Toggle, k.AddSubtask, k.Done, k.Help}
}

func (m Model) fullHelp() [][]key.Binding {
	k := m.keys
	groups := [][]key.Binding{
		{k.Up, k.Down, k.Left, k.Right, k.Top, k.Bottom},
		{k.NextTile, k.PrevTile, k.Search, k.Open, k.Back, k.Refresh, k.Help, k.Quit},
		{k.Add, k.Edit, k.Notes, k.Comment, k.Delete, k.Claude},
		{k.Done, k.Start, k.Block, k.MoveLeft, k.MoveRight, k.Toggle, k.AddSubtask},
	}
	if m.opts.Habits {
		groups[1] = append(groups[1][:len(groups[1])-2], k.Habits, k.Help, k.Quit)
	}
	return groups
}

// ---------- sending changes ----------

// patch changes fields of a task as it was shown, on top of whatever else has
// changed since, unless that touched the same fields.
func (m Model) patch(verb string, base *api.Task, fields map[string]any) tea.Cmd {
	c, ctx := m.opts.Client, m.ctx
	return func() tea.Msg {
		res, err := c.PatchOnTop(ctx, base, fields)
		return savedMsg{verb: verb, id: base.ID, res: res, err: err, base: base, fields: fields}
	}
}

// send runs a change that adds to a task and can't overwrite anything.
func (m Model) send(verb string, id int, do func() (*api.TaskResult, error)) tea.Cmd {
	return func() tea.Msg {
		res, err := do()
		return savedMsg{verb: verb, id: id, res: res, err: err}
	}
}

// setStatus moves a card to another column.
func (m Model) setStatus(t *api.Task, status string) (tea.Model, tea.Cmd) {
	if t.Status == status {
		return m, nil
	}
	return m, m.patch("Moved", t, map[string]any{"status": status})
}

func column(status string) int {
	for c, s := range statuses {
		if s == status {
			return c
		}
	}
	return 0
}

// ---------- keys ----------

// editTaskKey handles the keys that act on one task, from the board (the
// selected card) or from an open detail. handled is false for any other key.
func (m Model) editTaskKey(msg tea.KeyPressMsg, t *api.Task) (tea.Model, tea.Cmd, bool) {
	c, ctx, k := m.opts.Client, m.ctx, m.keys
	m.flash = ""
	switch {
	case key.Matches(msg, k.Done):
		return m, m.send("Done", t.ID, func() (*api.TaskResult, error) { return c.Complete(ctx, t.ID, "") }), true
	case key.Matches(msg, k.Start):
		next, cmd := m.setStatus(t, "in_progress")
		return next, cmd, true
	case key.Matches(msg, k.Block):
		next, cmd := m.setStatus(t, "blocked")
		return next, cmd, true
	case key.Matches(msg, k.MoveLeft), key.Matches(msg, k.MoveRight):
		to := column(t.Status) - 1
		if key.Matches(msg, k.MoveRight) {
			to += 2
		}
		if to < 0 || to >= len(statuses) {
			return m, nil, true
		}
		next, cmd := m.setStatus(t, statuses[to])
		return next, cmd, true
	case key.Matches(msg, k.Edit):
		next, cmd := m.openForm(t, nil)
		return next, cmd, true
	case key.Matches(msg, k.Comment):
		return m.ask(editComment, t, "comment › ", "what to say"), nil, true
	case key.Matches(msg, k.AddSubtask):
		return m.ask(editSubtask, t, "subtask › ", "what needs doing"), nil, true
	case key.Matches(msg, k.Delete):
		m.edit = newEditState()
		m.edit.mode, m.edit.target = editDelete, t
		return m, nil, true
	}
	return m.extraTaskKey(msg, t)
}

// editBoardKey handles a key on the board that is not for moving around.
func (m Model) editBoardKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Add) {
		m.flash = ""
		return m.ask(editCapture, nil, "add › ", "Renew passport fri !high #personal"), nil
	}
	if t := m.selected(); t != nil {
		next, cmd, _ := m.editTaskKey(msg, t)
		return next, cmd
	}
	return m, nil
}

// editDetailKey handles a key in an open detail. There, space checks off the
// next subtask and a digit checks or unchecks the subtask with that number.
func (m Model) editDetailKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	t := m.detail.task
	if t == nil {
		return m, nil, false
	}
	c, ctx := m.opts.Client, m.ctx
	toggle := func(sub api.Subtask) (tea.Model, tea.Cmd, bool) {
		return m, m.send("Updated", t.ID, func() (*api.TaskResult, error) {
			return c.PatchSubtask(ctx, t.ID, sub.ID, map[string]any{"done": !sub.Done})
		}), true
	}
	if key.Matches(msg, m.keys.Toggle) {
		for _, sub := range t.Subtasks {
			if !sub.Done {
				return toggle(sub)
			}
		}
		return m, nil, true
	}
	if s := msg.String(); len(s) == 1 && s >= "1" && s <= "9" {
		for _, sub := range t.Subtasks {
			if sub.ID == int(s[0]-'0') {
				return toggle(sub)
			}
		}
		return m, nil, true
	}
	if key.Matches(msg, m.keys.Add) {
		return m.ask(editCapture, nil, "add › ", "Renew passport fri !high #personal"), nil, true
	}
	return m.editTaskKey(msg, t)
}

// ask opens the one-line box for typing something.
func (m Model) ask(mode editMode, target *api.Task, prompt, placeholder string) Model {
	m.edit = newEditState()
	m.edit.mode, m.edit.target = mode, target
	m.edit.input.Prompt, m.edit.input.Placeholder = prompt, placeholder
	m.edit.input.SetWidth(max(10, m.width-lipgloss.Width(prompt)-3))
	m.edit.input.Focus()
	return m
}

// editKey handles a key while a change is being made.
func (m Model) editKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	c, ctx := m.opts.Client, m.ctx
	e := &m.edit
	switch e.mode {
	case editCapture, editComment, editSubtask:
		switch {
		case key.Matches(msg, m.keys.Back):
			m.edit = newEditState()
			return m, nil
		case key.Matches(msg, m.keys.Open):
			text := strings.TrimSpace(e.input.Value())
			if text == "" {
				return m, nil
			}
			mode, target := e.mode, e.target
			m.edit = newEditState()
			switch mode {
			case editCapture:
				return m, func() tea.Msg {
					res, err := c.Capture(ctx, text)
					return savedMsg{verb: "Added", res: res, err: err}
				}
			case editComment:
				return m, m.send("Commented on", target.ID, func() (*api.TaskResult, error) { return c.Comment(ctx, target.ID, text) })
			default:
				return m, m.send("Added a subtask to", target.ID, func() (*api.TaskResult, error) { return c.AddSubtasks(ctx, target.ID, []string{text}) })
			}
		}
		var cmd tea.Cmd
		before := e.input.Value()
		e.input, cmd = e.input.Update(msg)
		if e.mode == editCapture && e.input.Value() != before {
			// Ask the app how it reads the line, once the typing pauses.
			e.seq++
			seq := e.seq
			if strings.TrimSpace(e.input.Value()) == "" {
				e.preview = ""
			}
			return m, tea.Batch(cmd, tea.Tick(180*time.Millisecond, func(time.Time) tea.Msg { return previewTick{seq} }))
		}
		return m, cmd

	case editDelete:
		target := e.target
		switch msg.String() {
		case "y", "Y":
			m.edit = newEditState()
			// Deleted as it was shown: if it has changed since, it is not deleted.
			return m, func() tea.Msg {
				err := c.Delete(ctx, target.ID, target.Rev)
				return savedMsg{verb: "Deleted", id: target.ID, err: err, base: target, deleted: true}
			}
		case "n", "N", "esc", "q":
			m.edit = newEditState()
		}
		return m, nil

	case editForm:
		if msg.String() == "ctrl+r" && (e.changed || e.gone) {
			return m.reloadForm()
		}
		return m.formUpdate(msg)

	case editConflict:
		k := e.conflict
		switch msg.String() {
		case "o": // mine, over theirs: a decision made looking at both
			m.edit = newEditState()
			return m, m.patch(k.verb, k.current, k.fields)
		case "t", "esc", "q":
			m.edit = newEditState()
			m.flash = fmt.Sprintf("Kept #%d as it is", k.current.ID)
			return m, m.refresh()
		case "e":
			if notes, ok := k.fields["notes"].(string); ok && len(k.fields) == 1 {
				// Notes are edited in the editor, not the form: back there, with my text.
				m.edit = newEditState()
				return m.editNotes(k.current, notes)
			}
			return m.openForm(k.current, k.fields)
		}
		return m, nil
	}
	return m, nil
}

// editUpdate handles the messages that changes produce, and passes everything
// else to the form while one is open (it has messages of its own).
func (m Model) editUpdate(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case previewTick:
		if m.edit.mode != editCapture || msg.seq != m.edit.seq {
			return m, nil
		}
		line, c, ctx := m.edit.input.Value(), m.opts.Client, m.ctx
		return m, func() tea.Msg {
			parsed, err := c.Preview(ctx, line)
			if err != nil {
				return previewMsg{msg.seq, ""}
			}
			return previewMsg{msg.seq, describeParsed(parsed)}
		}
	case previewMsg:
		if m.edit.mode == editCapture && msg.seq == m.edit.seq {
			m.edit.preview = msg.text
		}
		return m, nil
	case savedMsg:
		return m.saved(msg)
	}
	if next, cmd, handled := m.extraUpdate(msg); handled {
		return next, cmd
	}
	if m.edit.mode == editForm {
		return m.formUpdate(msg)
	}
	return m, nil
}

// describeParsed says how the app read a line: "→ Renew passport · due
// 2026-10-16 · high · #personal".
func describeParsed(p *api.Parsed) string {
	if p == nil || p.Title == "" {
		return "→ (no title yet)"
	}
	parts := []string{"→ " + p.Title}
	str := func(name string) string {
		if v, ok := p.Fields[name].(string); ok {
			return v
		}
		return ""
	}
	if v := str("due"); v != "" {
		parts = append(parts, "due "+v)
	}
	if v := str("priority"); v != "" {
		parts = append(parts, v)
	}
	if v := str("project"); v != "" {
		parts = append(parts, "#"+v)
	}
	if tags, ok := p.Fields["tags"].([]any); ok {
		for _, tag := range tags {
			parts = append(parts, fmt.Sprintf("@%v", tag))
		}
	}
	if v := str("assignee"); v == "claude" {
		parts = append(parts, "for Claude")
	}
	if v := str("repeat"); v != "" {
		parts = append(parts, "repeats "+v)
	}
	if v := str("remindAt"); v != "" {
		if at, err := time.Parse(time.RFC3339, v); err == nil {
			parts = append(parts, "reminder "+at.Local().Format("Jan 2 15:04"))
		}
	}
	return strings.Join(parts, " · ")
}

// saved handles the answer to a change.
func (m Model) saved(msg savedMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		var refused *api.Error
		conflicted := errors.As(msg.err, &refused) && refused.Status == 409 && refused.Current != nil
		switch {
		case conflicted && msg.deleted:
			m.notice = fmt.Sprintf("#%d was changed after you were asked, so it was not deleted", msg.id)
		case conflicted:
			// The same fields changed elsewhere. Show both; write nothing.
			m.edit = newEditState()
			m.edit.mode = editConflict
			m.edit.target = refused.Current
			m.edit.conflict = &conflict{base: msg.base, current: refused.Current, fields: msg.fields, verb: msg.verb}
		case api.IsStatus(msg.err, 404):
			m.notice = fmt.Sprintf("#%d no longer exists", msg.id)
		default:
			m.notice = msg.err.Error()
		}
		return m, m.refresh()
	}
	m.notice = ""
	switch {
	case msg.deleted:
		m.flash = fmt.Sprintf("Deleted #%d %s", msg.id, msg.base.Title)
		kept := m.tasks[:0:0]
		for _, t := range m.tasks {
			if t.ID != msg.id {
				kept = append(kept, t)
			}
		}
		m.tasks = kept
		if m.detail != nil && m.detail.id == msg.id {
			m.detail = nil
		}
	case msg.res != nil:
		t := msg.res.Task
		m.flash = fmt.Sprintf("%s #%d %s", msg.verb, t.ID, t.Title)
		if msg.res.Next != nil {
			m.flash += fmt.Sprintf(" · next is #%d, due %s", msg.res.Next.ID, msg.res.Next.Due)
		}
		// Show it at once; the list is read again right after.
		found := false
		tasks := append(m.tasks[:0:0], m.tasks...)
		for i := range tasks {
			if tasks[i].ID == t.ID {
				tasks[i], found = t, true
			}
		}
		if !found {
			tasks = append([]api.Task{t}, tasks...)
		}
		m.tasks = tasks
		if m.detail != nil && m.detail.id == t.ID {
			d := *m.detail
			d.task = &t
			m.detail = &d
			m.layoutDetail()
		} else if m.matches(&t) {
			// Follow the card to wherever it is now.
			m.col, m.selID = column(t.Status), t.ID
		}
	}
	m.follow2()
	return m, m.refresh()
}

// editListChanged notices, each time the list is read, whether the task being
// edited was changed or deleted by someone else.
func (m *Model) editListChanged() tea.Cmd {
	e := &m.edit
	if e.mode != editForm || e.target == nil {
		return nil
	}
	for i := range m.tasks {
		if m.tasks[i].ID == e.target.ID {
			e.changed = m.tasks[i].Rev != e.target.Rev
			return nil
		}
	}
	e.gone = m.loaded
	return nil
}

// ---------- the form ----------

var repeats = []string{"", "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"}

func valuesOf(t *api.Task, loc *time.Location) formValues {
	v := formValues{Title: t.Title, Due: t.Due, Priority: t.Priority, Project: t.Project, Tags: strings.Join(t.Tags, ", "), Assignee: t.Assignee, Repeat: t.Repeat}
	if at, err := time.Parse(time.RFC3339, t.RemindAt); err == nil {
		v.Remind = at.In(loc).Format("2006-01-02 15:04")
	}
	return v
}

// changes is what differs between the form as it was opened and as it is now,
// as the fields a PATCH takes. Dates and times are sent as typed: the app reads them.
func (v formValues) changes(initial formValues) map[string]any {
	fields := map[string]any{}
	set := func(name, was, now string) {
		if strings.TrimSpace(now) != strings.TrimSpace(was) {
			fields[name] = strings.TrimSpace(now)
		}
	}
	set("title", initial.Title, v.Title)
	set("due", initial.Due, v.Due)
	set("priority", initial.Priority, v.Priority)
	set("project", initial.Project, v.Project)
	set("assignee", initial.Assignee, v.Assignee)
	set("repeat", initial.Repeat, v.Repeat)
	set("remindAt", initial.Remind, v.Remind)
	if strings.TrimSpace(v.Tags) != strings.TrimSpace(initial.Tags) {
		tags := []string{}
		for _, tag := range strings.Split(v.Tags, ",") {
			if tag = strings.TrimSpace(tag); tag != "" {
				tags = append(tags, tag)
			}
		}
		fields["tags"] = tags
	}
	return fields
}

// apply puts fields (as a PATCH takes them) into the form's values, for
// reopening the form with an edit that was refused.
func (v *formValues) apply(fields map[string]any) {
	for name, value := range fields {
		text := fmt.Sprint(value)
		switch name {
		case "title":
			v.Title = text
		case "due":
			v.Due = text
		case "priority":
			v.Priority = text
		case "project":
			v.Project = text
		case "assignee":
			v.Assignee = text
		case "repeat":
			v.Repeat = text
		case "remindAt":
			v.Remind = text
		case "tags":
			if tags, ok := value.([]string); ok {
				v.Tags = strings.Join(tags, ", ")
			}
		}
	}
}

// openForm opens the fields form on a task. `mine`, if given, is an edit to
// carry over into it: what the user had typed before the task changed.
func (m Model) openForm(t *api.Task, mine map[string]any) (tea.Model, tea.Cmd) {
	m.edit = newEditState()
	e := &m.edit
	e.mode, e.target = editForm, t
	e.initial = valuesOf(t, m.opts.Loc)
	values := e.initial
	values.apply(mine)
	e.values = &values

	options := func(list ...string) []huh.Option[string] {
		opts := make([]huh.Option[string], len(list))
		for i, v := range list {
			label := v
			if v == "" {
				label = "never"
			}
			opts[i] = huh.NewOption(label, v)
		}
		return opts
	}
	keys := huh.NewDefaultKeyMap()
	keys.Quit = key.NewBinding(key.WithKeys("esc", "ctrl+c"))
	e.form = huh.NewForm(huh.NewGroup(
		huh.NewInput().Title("Title ").Inline(true).Value(&values.Title).Validate(func(s string) error {
			if strings.TrimSpace(s) == "" {
				return errors.New("a task needs a title")
			}
			return nil
		}),
		huh.NewInput().Title("Due ").Inline(true).Placeholder("fri, tomorrow, oct 20, 2026-10-20; empty for none").Value(&values.Due),
		huh.NewSelect[string]().Title("Priority").Options(options("high", "medium", "low")...).Inline(true).Value(&values.Priority),
		huh.NewInput().Title("Project ").Inline(true).Value(&values.Project),
		huh.NewInput().Title("Tags ").Inline(true).Placeholder("separated by commas").Value(&values.Tags),
		huh.NewSelect[string]().Title("With").Options(huh.NewOption("me", "me"), huh.NewOption("Claude", "claude")).Inline(true).Value(&values.Assignee),
		huh.NewSelect[string]().Title("Repeats").Options(options(repeats...)...).Inline(true).Value(&values.Repeat),
		huh.NewInput().Title("Reminder ").Inline(true).Placeholder("tomorrow 9am, fri 14:30, 2026-10-20 09:00; empty for none").Value(&values.Remind),
	)).WithTheme(huh.ThemeFunc(huh.ThemeBase16)).WithKeyMap(keys).WithShowHelp(false).WithWidth(min(72, max(20, m.width-4))).WithHeight(max(4, m.bodyHeight()-6))
	return m, e.form.Init()
}

// reloadForm drops the edit in progress and opens the form on the task as it is now.
func (m Model) reloadForm() (tea.Model, tea.Cmd) {
	id := m.edit.target.ID
	for i := range m.tasks {
		if m.tasks[i].ID == id {
			return m.openForm(&m.tasks[i], nil)
		}
	}
	m.edit = newEditState()
	m.notice = fmt.Sprintf("#%d no longer exists", id)
	return m, nil
}

// formUpdate passes a message to the form, and acts when it is finished.
func (m Model) formUpdate(msg tea.Msg) (tea.Model, tea.Cmd) {
	e := &m.edit
	next, cmd := e.form.Update(msg)
	if form, ok := next.(*huh.Form); ok {
		e.form = form
	}
	switch e.form.State {
	case huh.StateAborted:
		m.edit = newEditState()
		return m, nil
	case huh.StateCompleted:
		target, fields := e.target, e.values.changes(e.initial)
		m.edit = newEditState()
		if len(fields) == 0 {
			m.flash = "Nothing was changed"
			return m, nil
		}
		return m, m.patch("Updated", target, fields)
	}
	return m, cmd
}

// ---------- drawing ----------

// editView is the form, or the two versions of a task in conflict.
func (m Model) editView(height int) string {
	e := m.edit
	if e.mode == editForm {
		heading := m.styles.Title.Render(fmt.Sprintf("Edit #%d", e.target.ID))
		return lipgloss.NewStyle().Padding(1, 2).Render(heading + "\n\n" + e.form.View())
	}
	k := e.conflict
	names := make([]string, 0, len(k.fields))
	for name := range k.fields {
		names = append(names, name)
	}
	sort.Strings(names)
	show := func(v string) string {
		var list []string
		if json.Unmarshal([]byte(v), &list) == nil {
			v = strings.Join(list, ", ")
		}
		v = strings.Trim(v, `"`)
		if v == "" || v == "null" {
			return "(none)"
		}
		return v
	}
	width := max(12, (m.width-22)/2)
	rows := []string{
		m.styles.Title.Render(fmt.Sprintf("#%d “%s” was changed by someone else while you were changing it.", k.current.ID, k.current.Title)),
		m.styles.Muted.Render("Nothing has been saved. What you both changed is marked:"),
		"",
		m.styles.Faint.Render(fmt.Sprintf("  %-10s  %-*s  %s", "", width, "yours", "theirs (as it is now)")),
	}
	for _, name := range names {
		mine := show(fmt.Sprint(k.fields[name]))
		if tags, ok := k.fields[name].([]string); ok {
			mine = show(strings.Join(tags, ", "))
		}
		theirs := show(string(k.current.Field(name)))
		if name == "status" {
			mine, theirs = out.StatusLabel(mine), out.StatusLabel(theirs)
		}
		line := fmt.Sprintf("  %-10s  %-*s  %s", name, width, ansi.Truncate(mine, width, "…"), ansi.Truncate(theirs, width, "…"))
		if len(api.Overlap(k.base, k.current, map[string]any{name: nil})) > 0 {
			line = m.styles.Warn.Render(line + "  ←")
		}
		rows = append(rows, line)
	}
	rows = append(rows, "",
		"  "+m.styles.Accent.Render("o")+"  save mine over theirs",
		"  "+m.styles.Accent.Render("t")+"  keep theirs, and drop my change",
		"  "+m.styles.Accent.Render("e")+"  keep editing, starting from theirs with my changes filled in",
	)
	return lipgloss.NewStyle().Padding(1, 2).MaxHeight(height).Render(strings.Join(rows, "\n"))
}
