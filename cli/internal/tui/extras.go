package tui

import (
	"fmt"
	"os"
	"os/exec"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"

	"todos/internal/api"
	"todos/internal/handoff"
)

// Things that hand the terminal to another program for a while: the user's
// editor, for a task's notes, and claude, for a session on a task. The board
// steps aside while they run and comes back when they exit.

type (
	notesMsg struct {
		task *api.Task
		path string
		err  error
	}
	claudeMsg struct {
		task    *api.Task
		session *api.ClaudeSession
		err     error
	}
	claudeDoneMsg struct{ err error }
)

func (m Model) extraTaskKey(msg tea.KeyPressMsg, t *api.Task) (tea.Model, tea.Cmd, bool) {
	switch {
	case key.Matches(msg, m.keys.Notes):
		next, cmd := m.editNotes(t, t.Notes)
		return next, cmd, true
	case key.Matches(msg, m.keys.Claude):
		next, cmd := m.startClaude(t)
		return next, cmd, true
	}
	return m, nil, false
}

func (m Model) extraUpdate(msg tea.Msg) (tea.Model, tea.Cmd, bool) {
	switch msg := msg.(type) {
	case notesMsg:
		next, cmd := m.notesEdited(msg)
		return next, cmd, true
	case claudeMsg:
		next, cmd := m.claudeReady(msg)
		return next, cmd, true
	case claudeDoneMsg:
		if msg.err != nil {
			m.notice = "claude: " + msg.err.Error()
		}
		return m, m.refresh(), true
	}
	return m, nil, false
}

// editNotes opens a task's notes in the user's editor. `text` is what to put
// in front of them: the notes as they are, or an edit of them that was refused.
func (m Model) editNotes(t *api.Task, text string) (tea.Model, tea.Cmd) {
	path, err := handoff.NotesFile(t.ID, text)
	if err != nil {
		m.notice = "couldn't make a file for the notes: " + err.Error()
		return m, nil
	}
	argv := handoff.Editor(m.opts.Getenv, path)
	return m, tea.ExecProcess(exec.Command(argv[0], argv[1:]...), func(err error) tea.Msg {
		return notesMsg{task: t, path: path, err: err}
	})
}

// notesEdited saves the notes once the editor has closed, if they changed.
func (m Model) notesEdited(msg notesMsg) (tea.Model, tea.Cmd) {
	defer os.Remove(msg.path)
	if msg.err != nil {
		m.notice = "the editor did not finish cleanly, so the notes were not saved: " + msg.err.Error()
		return m, nil
	}
	notes, err := handoff.ReadNotes(msg.path)
	if err != nil {
		m.notice = "couldn't read the notes back: " + err.Error()
		return m, nil
	}
	if handoff.SameNotes(msg.task.Notes, notes) {
		m.flash = "Notes not changed"
		return m, nil
	}
	return m, m.patch("Updated the notes of", msg.task, map[string]any{"notes": notes})
}

// startClaude asks the app what a session on the task is started with.
func (m Model) startClaude(t *api.Task) (tea.Model, tea.Cmd) {
	if !m.opts.Local {
		m.notice = "a Claude session can only be started on the Mac itself, not from another machine"
		return m, nil
	}
	c, ctx := m.opts.Client, m.ctx
	return m, func() tea.Msg {
		session, err := c.ClaudeSession(ctx, t.ID)
		return claudeMsg{task: t, session: session, err: err}
	}
}

// claudeReady records the start and gives the terminal to claude.
func (m Model) claudeReady(msg claudeMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.notice = msg.err.Error()
		return m, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		m.notice = err.Error()
		return m, nil
	}
	plan, err := handoff.Plan(msg.session, "", cwd, m.opts.Getenv, exec.LookPath)
	if err != nil {
		m.notice = err.Error()
		return m, nil
	}
	c, ctx, id := m.opts.Client, m.ctx, msg.task.ID
	record := func() tea.Msg {
		if _, err := c.ClaudeStarted(ctx, id, plan.Dir); err != nil {
			return claudeDoneMsg{fmt.Errorf("couldn't record the start, so it was not started: %w", err)}
		}
		return nil
	}
	return m, tea.Sequence(record, tea.ExecProcess(plan.Command(), func(err error) tea.Msg { return claudeDoneMsg{err} }))
}
