package tui

import "charm.land/bubbles/v2/key"

// KeyMap is every key the board answers to. It also drives the help.
type KeyMap struct {
	Up, Down, Left, Right, Top, Bottom key.Binding
	NextTile, PrevTile                 key.Binding
	Search, Open, Back, Refresh        key.Binding
	Help, Quit                         key.Binding

	// Changes.
	MoveLeft, MoveRight, Done, Start, Block key.Binding
	Add, Edit, Notes, Comment, Delete       key.Binding
	Toggle, AddSubtask                      key.Binding
	Claude                                  key.Binding

	// Habits (see habits.go).
	Habits, HabitUndo, HabitYesterday, HabitRest key.Binding
}

func newKeys() KeyMap {
	b := func(help, desc string, keys ...string) key.Binding {
		return key.NewBinding(key.WithKeys(keys...), key.WithHelp(help, desc))
	}
	return KeyMap{
		Up:       b("↑/k", "up", "up", "k"),
		Down:     b("↓/j", "down", "down", "j"),
		Left:     b("←/h", "column left", "left", "h"),
		Right:    b("→/l", "column right", "right", "l"),
		Top:      b("g", "first", "g", "home"),
		Bottom:   b("G", "last", "G", "end"),
		NextTile: b("tab", "next filter", "tab"),
		PrevTile: b("shift+tab", "previous filter", "shift+tab"),
		Search:   b("/", "search", "/"),
		Open:     b("enter", "open", "enter"),
		Back:     b("esc", "back", "esc"),
		Refresh:  b("r", "refresh", "r"),
		Help:     b("?", "help", "?"),
		Quit:     b("q", "quit", "q", "ctrl+c"),

		MoveLeft:   b("H", "move card left", "H", "shift+left"),
		MoveRight:  b("L", "move card right", "L", "shift+right"),
		Done:       b("x", "done", "x"),
		Start:      b("s", "start", "s"),
		Block:      b("b", "block", "b"),
		Add:        b("a", "add", "a"),
		Edit:       b("e", "edit", "e"),
		Notes:      b("n", "notes (in your editor)", "n"),
		Comment:    b("c", "comment", "c"),
		Delete:     b("d", "delete", "d"),
		Toggle:     b("space", "check subtask", "space"),
		AddSubtask: b("+", "add subtask", "+"),
		Claude:     b("C", "start with Claude", "C"),

		Habits:         b("t", "habits", "t"),
		HabitUndo:      b("u", "take back", "u"),
		HabitYesterday: b("y", "log yesterday", "y"),
		HabitRest:      b("s", "rest day", "s"),
	}
}
