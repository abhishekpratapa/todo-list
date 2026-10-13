package tui

import (
	tea "charm.land/bubbletea/v2"

	"todos/internal/api"
)

// Keys and messages for things that leave the board for another program. None yet.
func (m Model) extraTaskKey(tea.KeyPressMsg, *api.Task) (tea.Model, tea.Cmd, bool) {
	return m, nil, false
}

func (m Model) extraUpdate(tea.Msg) (tea.Model, tea.Cmd, bool) { return m, nil, false }
