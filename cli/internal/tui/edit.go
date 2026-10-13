package tui

import (
	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

// editState is whatever change is being made on the board. The board is
// read-only for now, so there is never one.
type editState struct{}

func newEditState() editState             { return editState{} }
func (editState) active() bool            { return false }
func (editState) fullScreen() bool        { return false }
func (editState) banner() string          { return "" }
func (editState) hint() string            { return "" }
func (m Model) editView(int) string       { return "" }
func (m *Model) editListChanged() tea.Cmd { return nil }

func (m Model) editKey(tea.KeyPressMsg) (tea.Model, tea.Cmd)      { return m, nil }
func (m Model) editBoardKey(tea.KeyPressMsg) (tea.Model, tea.Cmd) { return m, nil }
func (m Model) editUpdate(tea.Msg) (tea.Model, tea.Cmd)           { return m, nil }
func (m Model) editDetailKey(tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	return m, nil, false
}

// boardKeys, detailKeys and fullHelp are the keys the help shows.
func (m Model) boardKeys() []key.Binding {
	k := m.keys
	return []key.Binding{k.Help, k.Open, k.Search, k.NextTile, k.Refresh, k.Quit}
}

func (m Model) detailKeys() []key.Binding {
	k := m.keys
	return []key.Binding{k.Back, k.Up, k.Down, k.Help}
}

func (m Model) fullHelp() [][]key.Binding {
	k := m.keys
	return [][]key.Binding{
		{k.Up, k.Down, k.Left, k.Right, k.Top, k.Bottom},
		{k.NextTile, k.PrevTile, k.Search, k.Open, k.Back, k.Refresh},
		{k.Help, k.Quit},
	}
}
