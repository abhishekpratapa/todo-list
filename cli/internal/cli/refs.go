package cli

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"todos/internal/api"
)

var idRE = regexp.MustCompile(`^#?(\d+)$`)

// taskID turns what the user typed into a task's id. A number (12 or #12) is
// the id. Anything else is matched against titles: every word must appear in
// the title, open tasks are preferred over finished ones, and an exact title
// wins. Several matches are offered as a choice on a terminal, and are an error
// (listing them) anywhere else.
func (a *App) taskID(ctx context.Context, s *Session, ref string) (int, error) {
	ref = strings.TrimSpace(ref)
	if m := idRE.FindStringSubmatch(ref); m != nil {
		return strconv.Atoi(m[1])
	}
	if ref == "" {
		return 0, usagef("which task? Give its number or some words from its title")
	}
	found, err := s.Client.ListAll(ctx, api.ListOptions{Status: "all", Query: ref})
	if err != nil {
		return 0, err
	}
	words := strings.Fields(strings.ToLower(ref))
	var open, done, exact []api.Task
	for _, t := range found.Tasks {
		title := strings.ToLower(t.Title)
		matches := true
		for _, w := range words {
			matches = matches && strings.Contains(title, w)
		}
		if !matches {
			continue
		}
		if title == strings.ToLower(ref) && t.Status != "done" {
			exact = append(exact, t)
		}
		if t.Status == "done" {
			done = append(done, t)
		} else {
			open = append(open, t)
		}
	}
	candidates := open
	switch {
	case len(exact) == 1:
		return exact[0].ID, nil
	case len(open) == 0:
		candidates = done
	}
	switch len(candidates) {
	case 0:
		return 0, &notFoundError{fmt.Sprintf("no task's title matches %q", ref)}
	case 1:
		return candidates[0].ID, nil
	}
	if !a.interactive() {
		lines := make([]string, 0, len(candidates))
		for i, t := range candidates {
			if i == 8 {
				lines = append(lines, fmt.Sprintf("  … and %d more", len(candidates)-i))
				break
			}
			lines = append(lines, fmt.Sprintf("  #%d  %s", t.ID, t.Title))
		}
		return 0, usagef("%q matches %d tasks; use a number:\n%s", ref, len(candidates), strings.Join(lines, "\n"))
	}
	options := make([]string, len(candidates))
	for i, t := range candidates {
		options[i] = fmt.Sprintf("#%d  %s", t.ID, t.Title)
	}
	choice, err := a.prompter().Choose(fmt.Sprintf("Which task did you mean by %q?", ref), options)
	if err != nil {
		return 0, err
	}
	return candidates[choice].ID, nil
}

// subtaskID turns what the user typed into the id of one of a task's subtasks:
// its number, or words that match exactly one subtask's title.
func subtaskID(t *api.Task, ref string) (int, error) {
	ref = strings.TrimSpace(ref)
	if n, err := strconv.Atoi(ref); err == nil {
		for _, sub := range t.Subtasks {
			if sub.ID == n {
				return n, nil
			}
		}
		return 0, &notFoundError{fmt.Sprintf("task #%d has no subtask %d", t.ID, n)}
	}
	var matches []api.Subtask
	for _, sub := range t.Subtasks {
		if strings.Contains(strings.ToLower(sub.Title), strings.ToLower(ref)) {
			matches = append(matches, sub)
		}
	}
	switch len(matches) {
	case 0:
		return 0, &notFoundError{fmt.Sprintf("task #%d has no subtask matching %q", t.ID, ref)}
	case 1:
		return matches[0].ID, nil
	}
	lines := make([]string, len(matches))
	for i, sub := range matches {
		lines[i] = fmt.Sprintf("  %d  %s", sub.ID, sub.Title)
	}
	return 0, usagef("%q matches %d subtasks of #%d; use a number:\n%s", ref, len(matches), t.ID, strings.Join(lines, "\n"))
}

// completeTasks offers open tasks for shell completion: "id<TAB>title". It
// never starts the app, and says nothing if the app can't be reached quickly.
func (a *App) completeTasks(ctx context.Context) []string {
	s, err := a.connect(ctx, connectOptions{noStart: true})
	if err != nil {
		return nil
	}
	list, err := s.Client.List(ctx, api.ListOptions{Limit: 100})
	if err != nil {
		return nil
	}
	out := make([]string, len(list.Tasks))
	for i, t := range list.Tasks {
		out[i] = fmt.Sprintf("%d\t%s", t.ID, t.Title)
	}
	return out
}
