package tui

import (
	"context"
	"errors"
	"io"

	tea "charm.land/bubbletea/v2"
)

// Run shows the board until the user quits or ctx ends.
func Run(ctx context.Context, opts Options, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // ends the live-update stream with the board
	_, err := tea.NewProgram(New(ctx, opts), tea.WithContext(ctx), tea.WithInput(in), tea.WithOutput(out)).Run()
	if errors.Is(err, tea.ErrProgramKilled) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
