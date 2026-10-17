package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/out"
	"todos/internal/query"
	"todos/internal/queue"
)

// taskArgs completes task arguments with open tasks.
func (a *App) taskArgs(cmd *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Second)
	defer cancel()
	return a.completeTasks(ctx), cobra.ShellCompDirectiveNoFileComp | cobra.ShellCompDirectiveKeepOrder
}

func fixed(values ...string) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return values, cobra.ShellCompDirectiveNoFileComp
	}
}

// readAll reads standard input, for arguments given as "-".
func (a *App) readAll() (string, error) {
	if a.InTTY {
		return "", usagef("\"-\" reads from standard input, which is the terminal here: pipe the text in")
	}
	b, err := io.ReadAll(a.In)
	return strings.TrimRight(string(b), "\n"), err
}

// result prints what a change did: JSON, a row, or a line for a person.
func (a *App) result(verb string, res *api.TaskResult, many bool) error {
	p := a.p()
	if a.json {
		if many {
			return p.Line(res) // several results: one object to a line
		}
		return p.Value(res)
	}
	p.Changed(verb, &res.Task)
	if res.Next != nil {
		p.Note("next occurrence is #%d, due %s", res.Next.ID, res.Next.Due)
	}
	return nil
}

// each runs fn for every task named in refs, in order, stopping at the first failure.
func (a *App) each(ctx context.Context, refs []string, verb string, fn func(*Session, int) (*api.TaskResult, error)) error {
	s, err := a.connect(ctx)
	if err != nil {
		return err
	}
	a.p().Today = a.today(ctx, s)
	for _, ref := range refs {
		id, err := a.taskID(ctx, s, ref)
		if err != nil {
			return err
		}
		res, err := fn(s, id)
		if err != nil {
			return err
		}
		if err := a.result(verb, res, len(refs) > 1); err != nil {
			return err
		}
	}
	return nil
}

// patch changes fields of a task without overwriting someone else's change.
//
// The task is read first and the change is based on that revision. If it moved
// on in between, the change is tried once more only when what moved was other
// fields; if the same fields changed, that is a conflict and nothing is done.
// rev > 0 pins the revision instead (no reading, no second try), and force
// overwrites whatever is there.
func patch(ctx context.Context, c *api.Client, id int, fields map[string]any, rev int, force bool) (*api.TaskResult, error) {
	if force {
		return c.Patch(ctx, id, fields, api.AnyRev)
	}
	if rev > 0 {
		return c.Patch(ctx, id, fields, rev)
	}
	base, err := c.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return c.PatchOnTop(ctx, base, fields)
}

// list prints tasks matching o. limit 0 means all of them. With no sort given,
// the one "sort" in config.json names is used, if any.
func (a *App) list(ctx context.Context, o api.ListOptions, limit int) error {
	fromConfig := false
	if o.Sort == "" {
		if cfg, err := config.Load(a.configDir()); err == nil && cfg.Sort != "" {
			o.Sort, fromConfig = cfg.Sort, true
		}
	}
	// Checked here, so a mistyped key is said before anything is asked of the Mac.
	sort, err := query.ParseSort(o.Sort)
	switch {
	case err != nil && fromConfig:
		return usagef("\"sort\" in %s: %v", filepath.Join(a.configDir(), "config.json"), err)
	case err != nil:
		return usagef("%v", err)
	case sort.IsDefault():
		o.Sort = "" // the usual order: nothing to ask for, so any app can give it
	}
	s, err := a.connect(ctx)
	if err != nil {
		return err
	}
	if feature := newInLists(o, fromConfig); feature != "" && s.Info.APIVersion.Revision < api.ListsRevision {
		return &api.VersionError{AppTooOld: true, Feature: feature, Have: strconv.Itoa(s.Info.APIVersion.Revision), Need: strconv.Itoa(api.ListsRevision)}
	}
	o.Limit = limit
	found, err := s.Client.ListAll(ctx, o)
	if err != nil {
		return err
	}
	p := a.p()
	if a.json {
		return p.Value(found)
	}
	p.Today = a.today(ctx, s)
	p.Tasks(found.Tasks)
	if p.Styled && found.Total > len(found.Tasks) {
		p.Note("%d more not shown", found.Total-len(found.Tasks))
	}
	return nil
}

// newInLists names what a listing asks for that came with API revision 7, for
// the refusal an older app gets. It is empty when the listing asks for nothing new.
func newInLists(o api.ListOptions, sortFromConfig bool) string {
	due := strings.ToLower(strings.TrimSpace(o.Due))
	switch {
	case o.Sort != "" && sortFromConfig:
		return `sorted lists ("sort" in config.json)`
	case o.Sort != "":
		return "sorted lists (--sort)"
	case strings.Contains(o.Tag, ",") || o.TagMode != "":
		return "lists of tags (--tag a,b) and --tag-mode"
	case o.Project != nil && strings.Contains(*o.Project, ","):
		return "lists of projects (--project a,b)"
	case due == "tomorrow" || strings.HasPrefix(due, "before:") || strings.HasPrefix(due, "after:"):
		return "--due tomorrow, before: and after:"
	}
	return ""
}

// sortKeys completes --sort: each key, ascending or reversed, after the ones
// already given.
func sortKeys(_ *cobra.Command, _ []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	given := ""
	if i := strings.LastIndex(toComplete, ","); i >= 0 {
		given = toComplete[:i+1]
	}
	var out []string
	for _, key := range query.Keys {
		switch {
		case key == query.Default:
			if given == "" {
				out = append(out, key)
			}
		case !strings.Contains(","+given, ","+key+",") && !strings.Contains(","+given, ",-"+key+","):
			out = append(out, given+key, given+"-"+key)
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp | cobra.ShellCompDirectiveNoSpace
}

// taskGroup is a heading and the tasks under it, as `todos due` and `todos today` print them.
type taskGroup struct {
	title string
	tasks []api.Task
}

// groups prints each group that has tasks under its heading, with a count.
func groups(p *out.Printer, list []taskGroup) {
	printed := false
	for _, g := range list {
		if len(g.tasks) == 0 {
			continue
		}
		if printed {
			p.Blank()
		}
		p.Heading(fmt.Sprintf("%s (%d)", g.title, len(g.tasks)))
		p.Tasks(g.tasks)
		printed = true
	}
	if !printed && p.Styled {
		p.Tasks(nil)
	}
}

func (a *App) taskCommands() []*cobra.Command {
	return []*cobra.Command{
		a.addCmd(), a.lsCmd(), a.dueCmd(), a.todayCmd(), a.showCmd(),
		a.doneCmd(), a.statusCmd("start", "in_progress", "Started", "Move tasks to In progress"),
		a.blockCmd(), a.statusCmd("reopen", "todo", "Reopened", "Move tasks back to To do"),
		a.editCmd(), a.rmCmd(), a.subCmd(), a.commentCmd(), a.watchCmd(), a.claudeCmd(),
	}
}

func (a *App) addCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add [line | -]",
		Short: "Add a task from one line",
		Long: "Add a task from one line, read exactly as the app's quick capture reads it:\n\n" +
			"  dates     today, tomorrow, fri, next week, in 3 days, oct 20, 2026-10-20\n" +
			"  times     3pm, 9:30am, 15:00 (a reminder then)\n" +
			"  repeats   every day, every week, every friday, every month\n" +
			"  !high !med !low   priority        #name   project\n" +
			"  @name     tag (@claude or @me sets who has it)\n\n" +
			"With no line, on a terminal, a short form opens instead. With \"-\", each line\n" +
			"of standard input becomes a task.",
		Example: "todos add \"Renew passport fri !high #personal\"\ntodos add Call the bank tomorrow 3pm\nprintf 'Buy milk\\nPost letter fri\\n' | todos add -",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			var lines []string
			switch {
			case len(args) == 1 && args[0] == "-":
				scanner := bufio.NewScanner(a.In)
				scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
				for scanner.Scan() {
					if line := strings.TrimSpace(scanner.Text()); line != "" {
						lines = append(lines, line)
					}
				}
				if err := scanner.Err(); err != nil {
					return err
				}
				if len(lines) == 0 {
					return usagef("nothing to add: standard input was empty")
				}
			case len(args) > 0:
				lines = []string{strings.Join(args, " ")}
			case !a.interactive():
				return usagef("nothing to add: give the task as a line (todos add \"Renew passport fri !high\"), or \"-\" to read lines from standard input")
			}

			if lines == nil {
				s, err := a.connect(ctx)
				if err != nil {
					return err
				}
				a.p().Today = a.today(ctx, s)
				fields, err := a.prompter().NewTask()
				if err != nil {
					return err
				}
				res, err := s.Client.Create(ctx, fields)
				if err != nil {
					return err
				}
				return a.result("Added", res, false)
			}
			changes := make([]change, len(lines))
			for i, line := range lines {
				changes[i] = change{item: func(int) queue.Item { return queue.Item{Kind: queue.KindAdd, Text: line} }}
			}
			return a.sendOrSave(ctx, changes)
		},
	}
}

func (a *App) lsCmd() *cobra.Command {
	var o api.ListOptions
	var project string
	var all bool
	var limit int
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List tasks",
		Long: "List tasks: open ones unless --status or --all says otherwise. Several values\n" +
			"for one filter, separated by commas, mean any of them; different filters must\n" +
			"all match.\n\n" +
			"In the app's usual order (in progress, blocked, to do, done; then by priority\n" +
			"and due date) unless --sort says otherwise: keys separated by commas, each\n" +
			"reversed by a leading -, from default, status, priority (high first), due,\n" +
			"created, updated, completed, title, project and id. Tasks with nothing to sort\n" +
			"by (no due date, say) come last either way. \"sort\" in config.json sets the\n" +
			"one used when --sort isn't given.\n\n" +
			"For a pipe, each task is one line of tab-separated fields: id, status, priority,\n" +
			"due (\"-\" if none) and title. With --json the output is the API's own:\n" +
			"{\"tasks\": [...], \"total\": n, \"summary\": {...}, \"version\": n}.",
		Example: "todos ls --due week\ntodos ls --sort due,-priority\ntodos ls --status blocked,in_progress\ntodos ls --tag errand,bank --tag-mode all\n" +
			"todos ls --project work,home --priority high\ntodos ls --json | jq -r '.tasks[].title'",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if all {
				o.Status = "all"
			}
			if cmd.Flags().Changed("project") {
				o.Project = &project
			}
			return a.list(cmd.Context(), o, limit)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.Status, "status", "", "open (default), all, or any of todo, in_progress, blocked, done, separated by commas")
	f.BoolVarP(&all, "all", "a", false, "include finished tasks (same as --status all)")
	f.StringVar(&o.Tag, "tag", "", "only tasks with this tag, or any of these, separated by commas")
	f.StringVar(&o.TagMode, "tag-mode", "", "any (the default) or all: whether a task needs any of the tags or every one")
	f.StringVar(&project, "project", "", "only tasks in this project, or any of these, separated by commas (\"\" for tasks with none)")
	f.StringVar(&o.Priority, "priority", "", "high, medium or low, separated by commas")
	f.StringVar(&o.Assignee, "assignee", "", "me or claude")
	f.StringVar(&o.Due, "due", "", "overdue, today, tomorrow, week, none, any, before:DATE, after:DATE, or a date (due on or before it)")
	f.StringVarP(&o.Query, "search", "s", "", "words that must all appear in the title, notes, project, tags or subtasks")
	f.StringVar(&o.Sort, "sort", "", "keys to sort by, separated by commas, such as due,-priority (- reverses one)")
	f.IntVarP(&limit, "limit", "n", 0, "show at most this many")
	_ = cmd.RegisterFlagCompletionFunc("status", fixed("open", "all", "todo", "in_progress", "blocked", "done"))
	_ = cmd.RegisterFlagCompletionFunc("priority", fixed("high", "medium", "low"))
	_ = cmd.RegisterFlagCompletionFunc("assignee", fixed("me", "claude"))
	_ = cmd.RegisterFlagCompletionFunc("due", fixed("overdue", "today", "tomorrow", "week", "none", "any", "before:", "after:"))
	_ = cmd.RegisterFlagCompletionFunc("tag-mode", fixed("any", "all"))
	_ = cmd.RegisterFlagCompletionFunc("sort", sortKeys)
	return cmd
}

func (a *App) dueCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "due",
		Short: "What is due: what the menu bar shows",
		Long: "What is due, as the Mac's menu bar item lists it: overdue, today, the next seven\n" +
			"days, and open tasks with no date.\n\n" +
			"With --json the output is the API's own, which also has \"later\" (due after\n" +
			"that week): {\"overdue\": [...], \"today\": [...], \"upcoming\": [...], \"undated\": [...],\n" +
			"\"later\": [...], \"counts\": {...}, \"date\": \"YYYY-MM-DD\"}.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := a.connect(cmd.Context())
			if err != nil {
				return err
			}
			due, raw, err := s.Client.Due(cmd.Context())
			if err != nil {
				return err
			}
			p := a.p()
			if a.json {
				return p.Value(raw)
			}
			p.Today = due.Date
			groups(p, []taskGroup{{"Overdue", due.Overdue}, {"Today", due.Today}, {"Next 7 days", due.Upcoming}, {"No date", due.Undated}})
			return nil
		},
	}
}

func (a *App) todayCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "today",
		Short: "What needs doing today: overdue, then due today",
		Long: "Open tasks that are overdue, then the ones due today, each most important first\n" +
			"and then oldest first: the app's Today view. Between them they are what the\n" +
			"Mac's Dock badge counts.\n\n" +
			"With --json the output is the API's own: {\"overdue\": [...], \"today\": [...],\n" +
			"\"counts\": {\"overdue\": n, \"today\": n, \"total\": n}, \"date\": \"YYYY-MM-DD\"}.",
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := a.connect(cmd.Context())
			if err != nil {
				return err
			}
			today, raw, err := todayView(cmd.Context(), s)
			if err != nil {
				return err
			}
			p := a.p()
			if a.json {
				return p.Value(raw)
			}
			p.Today = today.Date
			groups(p, []taskGroup{{"Overdue", today.Overdue}, {"Today", today.Today}})
			return nil
		},
	}
}

// todayView asks the app for the Today view, and returns the answer as it came
// too. An app from before the view (API revision 7) has the same two groups in
// GET /due, in the list's usual order: here they are put in the view's own,
// by the app's own rules, and the answer is made in the same shape.
func todayView(ctx context.Context, s *Session) (*api.Today, any, error) {
	if s.Info.APIVersion.Revision >= api.ListsRevision {
		return s.Client.Today(ctx)
	}
	due, _, err := s.Client.Due(ctx)
	if err != nil {
		return nil, nil, err
	}
	t := &api.Today{
		Overdue: query.Sorted(due.Overdue, api.Task.AsQuery, query.TodaySort),
		Today:   query.Sorted(due.Today, api.Task.AsQuery, query.TodaySort),
		Date:    due.Date,
	}
	t.Counts = map[string]int{"overdue": len(t.Overdue), "today": len(t.Today), "total": len(t.Overdue) + len(t.Today)}
	return t, t, nil
}

func (a *App) showCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "show <task>",
		Short:             "Show one task in full",
		Long:              "Show one task: its fields, notes, subtasks, comments and history.\n\nWith --json: {\"task\": {...}}.",
		Args:              exactly(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.connect(ctx)
			if err != nil {
				return err
			}
			id, err := a.taskID(ctx, s, args[0])
			if err != nil {
				return err
			}
			t, err := s.Client.Get(ctx, id)
			if err != nil {
				return err
			}
			p := a.p()
			if a.json {
				return p.Value(map[string]any{"task": t})
			}
			p.Today = a.today(ctx, s)
			p.Detail(t)
			return nil
		},
	}
}

func (a *App) doneCmd() *cobra.Command {
	var comment string
	cmd := &cobra.Command{
		Use:               "done <task>...",
		Short:             "Mark tasks done",
		Long:              "Mark tasks done. Finishing a repeating task creates its next occurrence.",
		Example:           "todos done 12\ntodos done 12 14 -m \"Sent both\"",
		Args:              atLeast(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			changes := make([]change, len(args))
			for i, ref := range args {
				changes[i] = change{ref: ref, item: func(id int) queue.Item { return queue.Item{Kind: queue.KindDone, Task: id, Text: comment} }}
			}
			return a.sendOrSave(cmd.Context(), changes)
		},
	}
	cmd.Flags().StringVarP(&comment, "message", "m", "", "a closing comment")
	return cmd
}

// revFlags are the two ways to say what a change is based on.
type revFlags struct {
	rev   int
	force bool
}

func (r *revFlags) add(cmd *cobra.Command) {
	cmd.Flags().IntVar(&r.rev, "rev", 0, "only if the task is still at this revision (as --json shows it)")
	cmd.Flags().BoolVar(&r.force, "force", false, "overwrite even if the task has changed")
}

func (r *revFlags) check() error {
	if r.rev > 0 && r.force {
		return usagef("--rev and --force say opposite things: use one")
	}
	return nil
}

func (a *App) statusCmd(name, status, verb, short string) *cobra.Command {
	var rf revFlags
	cmd := &cobra.Command{
		Use:               name + " <task>...",
		Short:             short,
		Args:              atLeast(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := rf.check(); err != nil {
				return err
			}
			return a.each(cmd.Context(), args, verb, func(s *Session, id int) (*api.TaskResult, error) {
				return patch(cmd.Context(), s.Client, id, map[string]any{"status": status}, rf.rev, rf.force)
			})
		},
	}
	rf.add(cmd)
	return cmd
}

func (a *App) blockCmd() *cobra.Command {
	var rf revFlags
	var reason string
	cmd := &cobra.Command{
		Use:               "block <task>...",
		Short:             "Move tasks to Blocked",
		Example:           "todos block 12 -m \"Waiting on the bank\"",
		Args:              atLeast(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := rf.check(); err != nil {
				return err
			}
			return a.each(cmd.Context(), args, "Blocked", func(s *Session, id int) (*api.TaskResult, error) {
				res, err := patch(cmd.Context(), s.Client, id, map[string]any{"status": "blocked"}, rf.rev, rf.force)
				if err != nil || reason == "" {
					return res, err
				}
				return s.Client.Comment(cmd.Context(), id, reason)
			})
		},
	}
	cmd.Flags().StringVarP(&reason, "message", "m", "", "a comment saying what it is waiting on")
	rf.add(cmd)
	return cmd
}

func (a *App) editCmd() *cobra.Command {
	var rf revFlags
	var title, notes, due, priority, project, tags, assignee, repeat, remind, status string
	var editor bool
	cmd := &cobra.Command{
		Use:   "edit <task>",
		Short: "Change a task's fields",
		Long: "Change a task's fields. Only the flags given are changed. Dates, reminder times\n" +
			"and repeats are read by the app, so anything it understands works here:\n" +
			"--due fri, --remind \"tomorrow 9am\", --repeat weekly. An empty value clears a\n" +
			"field (--due \"\"), and --notes - reads the notes from standard input.\n" +
			"--editor opens the notes in your editor ($VISUAL, then $EDITOR, then vi) and\n" +
			"saves them when you close it.\n\n" +
			"The change is based on the task as it is when the command runs. If someone else\n" +
			"changes the same fields at that moment, nothing is overwritten and the command\n" +
			"exits 4. --rev N makes that stricter (only if the task is still at revision N);\n" +
			"--force overwrites regardless.",
		Example:           "todos edit 12 --due fri --priority high\ntodos edit 12 --tags errand,bank --project personal\ntodos edit 12 --notes - < notes.md",
		Args:              exactly(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fields := map[string]any{}
			for flag, value := range map[string]*string{
				"title": &title, "notes": &notes, "due": &due, "priority": &priority, "project": &project,
				"assignee": &assignee, "repeat": &repeat, "status": &status,
			} {
				if cmd.Flags().Changed(flag) {
					fields[flag] = *value
				}
			}
			if cmd.Flags().Changed("remind") {
				fields["remindAt"] = remind
			}
			if cmd.Flags().Changed("tags") {
				list := []string{}
				for _, tag := range strings.Split(tags, ",") {
					if tag = strings.TrimSpace(tag); tag != "" {
						list = append(list, tag)
					}
				}
				fields["tags"] = list
			}
			if notes == "-" && cmd.Flags().Changed("notes") {
				text, err := a.readAll()
				if err != nil {
					return err
				}
				fields["notes"] = text
			}
			if err := rf.check(); err != nil {
				return err
			}
			if editor {
				if _, has := fields["notes"]; has {
					return usagef("--editor and --notes both set the notes: use one")
				}
				return a.each(cmd.Context(), args, "Updated", func(s *Session, id int) (*api.TaskResult, error) {
					if len(fields) > 0 {
						if _, err := patch(cmd.Context(), s.Client, id, fields, rf.rev, rf.force); err != nil {
							return nil, err
						}
					}
					return a.editNotes(cmd.Context(), s, id)
				})
			}
			if len(fields) == 0 {
				return usagef("nothing to change: say what with flags such as --title, --due or --priority (see `todos edit --help`)")
			}
			return a.each(cmd.Context(), args, "Updated", func(s *Session, id int) (*api.TaskResult, error) {
				return patch(cmd.Context(), s.Client, id, fields, rf.rev, rf.force)
			})
		},
	}
	f := cmd.Flags()
	f.StringVar(&title, "title", "", "new title")
	f.StringVar(&notes, "notes", "", "new notes (Markdown); - reads standard input")
	f.BoolVarP(&editor, "editor", "e", false, "edit the notes in $VISUAL or $EDITOR")
	f.StringVar(&due, "due", "", "due date: fri, tomorrow, oct 20, 2026-10-20; \"\" clears it")
	f.StringVar(&priority, "priority", "", "high, medium or low")
	f.StringVar(&project, "project", "", "project; \"\" clears it")
	f.StringVar(&tags, "tags", "", "tags, separated by commas, replacing the ones it has; \"\" clears them")
	f.StringVar(&assignee, "assignee", "", "me or claude")
	f.StringVar(&repeat, "repeat", "", "daily, weekdays, weekly, biweekly, monthly, yearly; \"\" stops it")
	f.StringVar(&remind, "remind", "", "reminder time: \"tomorrow 9am\", \"fri 14:30\", +2h; \"\" clears it")
	f.StringVar(&status, "status", "", "todo, in_progress, blocked or done")
	_ = cmd.RegisterFlagCompletionFunc("priority", fixed("high", "medium", "low"))
	_ = cmd.RegisterFlagCompletionFunc("assignee", fixed("me", "claude"))
	_ = cmd.RegisterFlagCompletionFunc("status", fixed("todo", "in_progress", "blocked", "done"))
	_ = cmd.RegisterFlagCompletionFunc("repeat", fixed("daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"))
	rf.add(cmd)
	return cmd
}

func (a *App) rmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:               "rm <task>",
		Aliases:           []string{"delete"},
		Short:             "Delete a task",
		Long:              "Delete a task, after asking. With --yes it doesn't ask; without a terminal to\nask on, --yes is required.\n\nWith --json: {\"deleted\": {\"id\": n, \"title\": \"...\"}}.",
		Args:              exactly(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !yes && !a.interactive() {
				return usagef("deleting needs a yes: pass --yes to delete without being asked")
			}
			s, err := a.connect(ctx)
			if err != nil {
				return err
			}
			id, err := a.taskID(ctx, s, args[0])
			if err != nil {
				return err
			}
			t, err := s.Client.Get(ctx, id)
			if err != nil {
				return err
			}
			if !yes {
				ok, err := a.prompter().Confirm(fmt.Sprintf("Delete #%d “%s”?", t.ID, t.Title))
				if err != nil {
					return err
				}
				if !ok {
					fmt.Fprintln(a.Err, "Not deleted.")
					return &exitError{ExitInterrupted, errors.New("not deleted")}
				}
			}
			// Based on the task as it was shown: if it changed since, it is not deleted.
			if err := s.Client.Delete(ctx, id, t.Rev); err != nil {
				return err
			}
			p := a.p()
			switch {
			case a.json:
				return p.Value(map[string]any{"deleted": map[string]any{"id": t.ID, "title": t.Title}})
			case p.Styled:
				fmt.Fprintf(p.W, "Deleted #%d %s\n", t.ID, t.Title)
			default:
				fmt.Fprintln(p.W, t.ID)
			}
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "delete without asking")
	return cmd
}

func (a *App) subCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "sub",
		Aliases: []string{"subtask"},
		Short:   "Add, check off and remove subtasks",
		Long:    "Work with a task's checklist. A subtask is named by its number (as `todos show`\nlists them) or by words from its title.",
		Example: "todos sub add 12 \"Book appointment\" \"Take photos\"\ntodos sub done 12 1\ntodos sub done 12 photos",
		Args:    noArgs,
		RunE:    func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(&cobra.Command{
		Use:               "add <task> <title>...",
		Short:             "Add subtasks",
		Args:              atLeast(2, "which task, and what subtask?"),
		ValidArgsFunction: a.firstArgTask,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.sendOrSave(cmd.Context(), []change{{ref: args[0], item: func(id int) queue.Item {
				return queue.Item{Kind: queue.KindSubtasks, Task: id, Titles: args[1:]}
			}}})
		},
	})
	// One command per thing that can be done to existing subtasks.
	for _, op := range []struct {
		name, short string
		do          func(ctx context.Context, c *api.Client, id, sub int) (*api.TaskResult, error)
	}{
		{"done", "Check subtasks off", func(ctx context.Context, c *api.Client, id, sub int) (*api.TaskResult, error) {
			return c.PatchSubtask(ctx, id, sub, map[string]any{"done": true})
		}},
		{"undo", "Uncheck subtasks", func(ctx context.Context, c *api.Client, id, sub int) (*api.TaskResult, error) {
			return c.PatchSubtask(ctx, id, sub, map[string]any{"done": false})
		}},
		{"rm", "Remove subtasks", func(ctx context.Context, c *api.Client, id, sub int) (*api.TaskResult, error) {
			return c.DeleteSubtask(ctx, id, sub)
		}},
	} {
		cmd.AddCommand(&cobra.Command{
			Use:               op.name + " <task> <subtask>...",
			Short:             op.short,
			Args:              atLeast(2, "which task, and which subtask?"),
			ValidArgsFunction: a.firstArgTask,
			RunE: func(cmd *cobra.Command, args []string) error {
				ctx := cmd.Context()
				return a.each(ctx, args[:1], "Updated", func(s *Session, id int) (*api.TaskResult, error) {
					t, err := s.Client.Get(ctx, id)
					if err != nil {
						return nil, err
					}
					// Work out every subtask first, so a mistyped one changes nothing.
					subs := make([]int, 0, len(args)-1)
					for _, ref := range args[1:] {
						sub, err := subtaskID(t, ref)
						if err != nil {
							return nil, err
						}
						subs = append(subs, sub)
					}
					var res *api.TaskResult
					for _, sub := range subs {
						if res, err = op.do(ctx, s.Client, id, sub); err != nil {
							return nil, err
						}
					}
					return res, nil
				})
			},
		})
	}
	return cmd
}

// firstArgTask completes a task for the first argument only.
func (a *App) firstArgTask(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) > 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	return a.taskArgs(cmd, args, toComplete)
}

func (a *App) commentCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "comment <task> <text | ->",
		Short:             "Add a comment to a task",
		Example:           "todos comment 12 \"Called them, waiting for a reply\"\ngit log -1 --format=%s | todos comment 12 -",
		Args:              atLeast(2, "which task, and what comment?"),
		ValidArgsFunction: a.firstArgTask,
		RunE: func(cmd *cobra.Command, args []string) error {
			text := strings.Join(args[1:], " ")
			if text == "-" {
				var err error
				if text, err = a.readAll(); err != nil {
					return err
				}
			}
			if strings.TrimSpace(text) == "" {
				return usagef("the comment is empty")
			}
			return a.sendOrSave(cmd.Context(), []change{{ref: args[0], item: func(id int) queue.Item {
				return queue.Item{Kind: queue.KindComment, Task: id, Text: text}
			}}})
		},
	}
}
