package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/handoff"
)

// replace runs a program in place of this one, in dir: the terminal becomes
// that program's, as if it had been typed.
func replace(bin string, args []string, dir string) error {
	if err := os.Chdir(dir); err != nil {
		return err
	}
	return syscall.Exec(bin, append([]string{bin}, args...), os.Environ())
}

func (a *App) claudeCmd() *cobra.Command {
	var dir string
	var dryRun bool
	cmd := &cobra.Command{
		Use:   "claude <task>",
		Short: "Start a Claude session on a task, here in this terminal",
		Long: "Start a Claude Code session on a task, in this terminal. It is what the app's\n" +
			"Start with Claude button does: the same opening message and options, and the\n" +
			"task is handed to Claude with a note in its history.\n\n" +
			"The session starts in --dir if given; otherwise in the folder the app remembers\n" +
			"for the task's project; otherwise in the current folder. The folder used is\n" +
			"remembered for the project. --dir . starts it here whatever is remembered.\n\n" +
			"This only works on the Mac itself, with the local profile. It is not available\n" +
			"from another machine: starting programs on the Mac stays on the Mac.\n\n" +
			"--dry-run prints what would be run, and neither starts it nor records anything.",
		Example:           "todos claude 12\ntodos claude 12 --dir ~/code/site\ntodos claude \"fix login\" --dir .",
		Args:              exactly(1, "which task?"),
		ValidArgsFunction: a.taskArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			// Decided before anything is sent: with a remote profile this is refused
			// whether or not the Mac can be reached.
			if _, res, err := a.resolve(); err != nil {
				return err
			} else if !res.Local {
				return localOnly(&Session{Profile: res}, "`todos claude`")
			}
			s, err := a.connect(ctx)
			if err != nil {
				return err
			}
			id, err := a.taskID(ctx, s, args[0])
			if err != nil {
				return err
			}
			session, err := s.Client.ClaudeSession(ctx, id)
			if err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			plan, err := handoff.Plan(session, dir, cwd, a.Getenv, exec.LookPath)
			if err != nil {
				return usagef("%v", err)
			}
			if dryRun {
				if a.json {
					return a.p().Value(map[string]any{"claude": plan.Bin, "args": plan.Args, "folder": plan.Dir})
				}
				fmt.Fprintf(a.Out, "cd %s\n%s", shellQuote(plan.Dir), shellQuote(plan.Bin))
				for _, arg := range plan.Args {
					fmt.Fprintf(a.Out, " %s", shellQuote(arg))
				}
				fmt.Fprintln(a.Out)
				return nil
			}
			// Recorded first: once claude has the terminal, this program is gone.
			if _, err := s.Client.ClaudeStarted(ctx, id, plan.Dir); err != nil {
				return err
			}
			if a.ErrTTY {
				fmt.Fprintf(a.Err, "Starting Claude on #%d in %s\n", id, a.tildify(plan.Dir))
			}
			return a.Replace(plan.Bin, plan.Args, plan.Dir)
		},
	}
	cmd.Flags().StringVar(&dir, "dir", "", "the `folder` to start in")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "print the command instead of running it")
	return cmd
}

func shellQuote(s string) string {
	safe := s != ""
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '/' || r == '.' || r == '-' || r == '_' || r == ':' || r == '=' || r == '+' || r == '@' || r == '~') {
			safe = false
		}
	}
	if safe {
		return s
	}
	quoted := "'"
	for _, r := range s {
		if r == '\'' {
			quoted += `'\''`
		} else {
			quoted += string(r)
		}
	}
	return quoted + "'"
}

// editNotes opens a task's notes in the user's editor and saves what comes back.
func (a *App) editNotes(ctx context.Context, s *Session, id int) (*api.TaskResult, error) {
	if !a.interactive() {
		return nil, usagef("--editor needs a terminal. In a script, pipe the notes in: todos edit %d --notes -", id)
	}
	task, err := s.Client.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	path, err := handoff.NotesFile(id, task.Notes)
	if err != nil {
		return nil, err
	}
	defer os.Remove(path)
	argv := handoff.Editor(a.Getenv, path)
	editor := exec.CommandContext(ctx, argv[0], argv[1:]...)
	editor.Stdin, editor.Stdout, editor.Stderr = a.In, a.Out, a.Err
	if err := editor.Run(); err != nil {
		return nil, fmt.Errorf("the editor (%s) did not finish cleanly, so nothing was saved: %v", argv[0], err)
	}
	notes, err := handoff.ReadNotes(path)
	if err != nil {
		return nil, err
	}
	if handoff.SameNotes(task.Notes, notes) {
		return &api.TaskResult{Task: *task}, nil
	}
	// Based on the notes as they were opened: if someone else rewrote them meanwhile, theirs are kept.
	return s.Client.PatchOnTop(ctx, task, map[string]any{"notes": notes})
}
