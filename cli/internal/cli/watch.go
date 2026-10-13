package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/out"
)

// Change is one difference between two readings of the list.
type Change struct {
	Event   string   `json:"event"` // created, updated or deleted
	Version int      `json:"version"`
	Task    api.Task `json:"task"` // as it is now; for a deletion, as it last was
	Changed []string `json:"changed,omitempty"`
}

// Fields that move with every change and say nothing about what it was.
var bookkeeping = map[string]bool{"rev": true, "updatedAt": true}

// Diff compares two readings of the list, by id.
func Diff(before, after map[int]api.Task, version int) []Change {
	var changes []Change
	for id, now := range after {
		was, existed := before[id]
		switch {
		case !existed:
			changes = append(changes, Change{Event: "created", Version: version, Task: now})
		case !bytes.Equal(was.Raw, now.Raw):
			var a, b map[string]json.RawMessage
			_ = json.Unmarshal(was.Raw, &a)
			_ = json.Unmarshal(now.Raw, &b)
			var fields []string
			for key, value := range b {
				if !bookkeeping[key] && !bytes.Equal(a[key], value) {
					fields = append(fields, key)
				}
			}
			for key := range a {
				if _, still := b[key]; !still {
					fields = append(fields, key)
				}
			}
			sort.Strings(fields)
			changes = append(changes, Change{Event: "updated", Version: version, Task: now, Changed: fields})
		}
	}
	for id, was := range before {
		if _, still := after[id]; !still {
			changes = append(changes, Change{Event: "deleted", Version: version, Task: was})
		}
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Task.ID < changes[j].Task.ID })
	return changes
}

func byID(tasks []api.Task) map[int]api.Task {
	m := make(map[int]api.Task, len(tasks))
	for _, t := range tasks {
		m[t.ID] = t
	}
	return m
}

func (a *App) watchCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "watch",
		Short: "Print changes to the list as they happen",
		Long: "Print changes to the list as they happen, whoever makes them: the app, the\n" +
			"iPhone, a Claude session or another terminal. Stops with Ctrl-C.\n\n" +
			"For a pipe, each change is one line of tab-separated fields: created, updated or\n" +
			"deleted, then the task as `todos ls` prints it. With --json each change is one\n" +
			"object on a line: {\"event\": \"created|updated|deleted\", \"version\": n, \"task\": {...},\n" +
			"\"changed\": [\"status\", ...]}. If the connection drops it is opened again, and\n" +
			"changes made in the meantime are reported then.",
		Example: "todos watch\ntodos watch --json | jq -r 'select(.event == \"created\") | .task.title'",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			s, err := a.connect(ctx)
			if err != nil {
				return err
			}
			p := a.p()
			note := func(format string, args ...any) {
				if a.ErrTTY && !a.json {
					fmt.Fprintf(a.Err, "%s\n", fmt.Sprintf(format, args...))
				}
			}

			first, err := s.Client.ListAll(ctx, api.ListOptions{Status: "all"})
			if err != nil {
				return err
			}
			known, version := byID(first.Tasks), first.Version
			note("Watching %s: %d open. Ctrl-C to stop.", s.Profile.Name, first.Summary.Open)

			refresh := func() {
				now, err := s.Client.ListAll(ctx, api.ListOptions{Status: "all"})
				if err != nil {
					return // the next event, or the reconnect, tries again
				}
				latest := byID(now.Tasks)
				for _, change := range Diff(known, latest, now.Version) {
					a.printChange(ctx, s, p, change, known)
				}
				known, version = latest, now.Version
			}

			err = s.Client.Follow(ctx, func(e api.Event) {
				if e.Version != version {
					refresh()
				}
			}, func(state api.FollowState) {
				if state.Connected {
					return
				}
				note("Lost the connection (%v). Trying again in %s…", state.Err, state.Retry.Round(time.Second))
			})
			if errors.Is(err, context.Canceled) {
				return nil // Ctrl-C is how this command ends
			}
			return err
		},
	}
}

// printChange prints one change in the form the output calls for.
func (a *App) printChange(ctx context.Context, s *Session, p *out.Printer, c Change, before map[int]api.Task) {
	if a.json {
		_ = p.Line(c)
		return
	}
	if !p.Styled {
		fmt.Fprintf(p.W, "%s\t%s\n", c.Event, out.Row(&c.Task))
		return
	}
	faint, bold := lipgloss.NewStyle().Faint(true), lipgloss.NewStyle().Bold(true)
	mark := map[string]string{
		"created": lipgloss.NewStyle().Foreground(lipgloss.Green).Render("+"),
		"updated": lipgloss.NewStyle().Foreground(lipgloss.Blue).Render("~"),
		"deleted": lipgloss.NewStyle().Foreground(lipgloss.Red).Render("-"),
	}[c.Event]
	line := fmt.Sprintf("%s  %s %s %s", faint.Render(time.Now().Format("15:04:05")), mark, faint.Render(fmt.Sprintf("#%d", c.Task.ID)), bold.Render(c.Task.Title))
	if c.Event == "updated" {
		line += "  " + faint.Render(a.describeChange(ctx, s, c, before[c.Task.ID]))
	}
	fmt.Fprintln(p.W, line)
}

// describeChange says what an update was, in the words the task's own history
// uses ("you · iPhone: moved To do → In progress"). If the history has nothing
// newer than the last reading, the names of the fields that changed.
func (a *App) describeChange(ctx context.Context, s *Session, c Change, was api.Task) string {
	if activity, err := s.Client.Activity(ctx, c.Task.ID); err == nil {
		var said []string
		for _, entry := range activity {
			if entry.At > was.UpdatedAt {
				text := entry.Text
				if entry.Kind == "comment" {
					text = "“" + text + "”"
				}
				said = append(said, out.Who(entry)+": "+text)
			}
		}
		if len(said) > 0 {
			return strings.Join(said, "; ")
		}
	}
	return "changed " + strings.Join(c.Changed, ", ")
}
