package cli

import (
	"errors"
	"io"
	"strings"

	"charm.land/huh/v2"
)

// Prompter asks the user things. The real one draws Huh forms on the terminal;
// tests answer for it.
type Prompter interface {
	// Confirm asks a yes/no question.
	Confirm(question string) (bool, error)
	// Choose asks for one of options and returns its index.
	Choose(title string, options []string) (int, error)
	// Secret asks for something that must not be shown as it is typed.
	Secret(title, help string) (string, error)
	// NewTask asks for a new task's fields, as POST /tasks takes them.
	NewTask() (map[string]any, error)
}

type terminalPrompter struct {
	in   io.Reader
	out  io.Writer
	dark bool
}

// The terminal's own sixteen colors, so forms suit a light or a dark background.
func (t *terminalPrompter) run(fields ...huh.Field) error {
	return huh.NewForm(huh.NewGroup(fields...)).WithTheme(huh.ThemeFunc(huh.ThemeBase16)).WithInput(t.in).WithOutput(t.out).Run()
}

func (t *terminalPrompter) Confirm(question string) (bool, error) {
	yes := false
	err := t.run(huh.NewConfirm().Title(question).Affirmative("Yes").Negative("No").Value(&yes))
	return yes, err
}

func (t *terminalPrompter) Choose(title string, options []string) (int, error) {
	choice := 0
	opts := make([]huh.Option[int], len(options))
	for i, o := range options {
		opts[i] = huh.NewOption(o, i)
	}
	err := t.run(huh.NewSelect[int]().Title(title).Options(opts...).Value(&choice))
	return choice, err
}

func (t *terminalPrompter) Secret(title, help string) (string, error) {
	secret := ""
	err := t.run(huh.NewInput().Title(title).Description(help).EchoMode(huh.EchoModePassword).Value(&secret).Validate(func(s string) error {
		if strings.TrimSpace(s) == "" {
			return errors.New("nothing was entered")
		}
		return nil
	}))
	return strings.TrimSpace(secret), err
}

func (t *terminalPrompter) NewTask() (map[string]any, error) {
	var title, due, project, tags, notes string
	priority := "medium"
	err := t.run(
		huh.NewInput().Title("Task").Value(&title).Validate(func(s string) error {
			if strings.TrimSpace(s) == "" {
				return errors.New("a task needs a title")
			}
			return nil
		}),
		huh.NewInput().Title("Due").Placeholder("fri, tomorrow, oct 20, 2026-10-20…").Value(&due),
		huh.NewSelect[string]().Title("Priority").Options(huh.NewOption("High", "high"), huh.NewOption("Medium", "medium"), huh.NewOption("Low", "low")).Value(&priority),
		huh.NewInput().Title("Project").Value(&project),
		huh.NewInput().Title("Tags").Placeholder("separated by commas").Value(&tags),
		huh.NewText().Title("Notes").Lines(4).Value(&notes),
	)
	if err != nil {
		return nil, err
	}
	fields := map[string]any{"title": strings.TrimSpace(title), "priority": priority}
	for key, value := range map[string]string{"due": due, "project": project, "tags": tags, "notes": notes} {
		if strings.TrimSpace(value) != "" {
			fields[key] = strings.TrimSpace(value)
		}
	}
	return fields, nil
}
