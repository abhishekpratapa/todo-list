package integration

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"todos/internal/fakeserver"
)

// claudeStub puts a pretend `claude` first on the PATH. It writes down where it
// was run and with what, then exits. Returns the environment and the record's path.
func claudeStub(t *testing.T, env []string) ([]string, string) {
	t.Helper()
	dir := t.TempDir()
	record := filepath.Join(dir, "ran")
	stub := "#!/bin/sh\n{ pwd -P; for arg in \"$@\"; do printf '%s\\n' \"$arg\"; done; } > " + record + "\n"
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	return setEnv(env, "PATH="+dir+":"+os.Getenv("PATH")), record
}

func ranWith(t *testing.T, record string) []string {
	t.Helper()
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("claude was not run: %v", err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

// runIn runs the command from a given folder.
func runIn(t *testing.T, dir string, env []string, args ...string) result {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Env, cmd.Dir = env, dir
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	_ = cmd.Run()
	return result{stdout.String(), stderr.String(), cmd.ProcessState.ExitCode()}
}

func TestClaudeOnTheMac(t *testing.T) {
	only(t, true, func(t *testing.T, b *backend) {
		task := b.add(t, "Fix the login page #site")
		id := fmt.Sprint(task.ID)
		env, record := claudeStub(t, b.env)
		work, _ := filepath.EvalSymlinks(t.TempDir())
		here, _ := filepath.EvalSymlinks(t.TempDir())

		// --dry-run shows what would be run, and neither runs it nor records anything.
		r := runIn(t, here, env, "claude", id, "--dir", work, "--dry-run")
		if r.code != 0 || !strings.Contains(r.stdout, "cd "+work) || !strings.Contains(r.stdout, "--allowedTools mcp__todolist -- 'Work on task #"+id) {
			t.Fatalf("--dry-run: exit %d\n%s%s", r.code, r.stdout, r.stderr)
		}
		if _, err := os.Stat(record); err == nil || b.get(t, task.ID).Assignee != "me" {
			t.Fatal("--dry-run started or recorded something")
		}

		// For real: claude runs in the folder, with the app's options and opening message.
		r = runIn(t, here, env, "claude", id, "--dir", work)
		if r.code != 0 {
			t.Fatalf("exit %d: %s", r.code, r.stderr)
		}
		ran := ranWith(t, record)
		if ran[0] != work {
			t.Errorf("claude ran in %s, want %s", ran[0], work)
		}
		args := ran[1:]
		if len(args) < 6 || args[0] != "--name" || args[1] != "Todo #"+id+": Fix the login page" || args[2] != "--allowedTools" || args[3] != "mcp__todolist" || args[4] != "--" || !strings.HasPrefix(args[5], "Work on task #"+id+" from my todo list: Fix the login page") {
			t.Errorf("claude was run with %q", args)
		}
		// The task is Claude's now, and its history says where it was started from.
		got := b.get(t, task.ID)
		last := got.Activity[len(got.Activity)-1]
		if got.Assignee != "claude" || !strings.Contains(last.Text, "Started with Claude from terminal in") || last.Via != "command line" {
			t.Errorf("after starting: assignee %s, history %+v", got.Assignee, last)
		}

		// With no --dir and nothing remembered: the folder the command was run from.
		other := b.add(t, "Another task")
		os.Remove(record)
		if r = runIn(t, here, env, "claude", fmt.Sprint(other.ID)); r.code != 0 {
			t.Fatalf("exit %d: %s", r.code, r.stderr)
		}
		if ran = ranWith(t, record); ran[0] != here {
			t.Errorf("claude ran in %s, want the current folder %s", ran[0], here)
		}

		// A folder that isn't there: nothing is run and nothing is recorded.
		third := b.add(t, "Third task")
		os.Remove(record)
		r = runIn(t, here, env, "claude", fmt.Sprint(third.ID), "--dir", filepath.Join(work, "missing"))
		if r.code != 2 || !strings.Contains(r.stderr, "is not a folder") || b.get(t, third.ID).Assignee != "me" {
			t.Errorf("a missing folder: exit %d, %s", r.code, r.stderr)
		}
		if _, err := os.Stat(record); err == nil {
			t.Error("claude was run although the folder is missing")
		}
		fails(t, env, 3, "", "claude", "999")
	})
}

func TestClaudeRemembersTheProjectFolder(t *testing.T) {
	// The app remembers one folder per project. (The fake does too; the real
	// server only does inside the desktop app.)
	b := fakeSocket(t)
	first, second := b.add(t, "First #site"), b.add(t, "Second #site")
	env, record := claudeStub(t, b.env)
	work, _ := filepath.EvalSymlinks(t.TempDir())
	here, _ := filepath.EvalSymlinks(t.TempDir())
	if r := runIn(t, here, env, "claude", fmt.Sprint(first.ID), "--dir", work); r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	os.Remove(record)
	if r := runIn(t, here, env, "claude", fmt.Sprint(second.ID)); r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	if ran := ranWith(t, record); ran[0] != work {
		t.Errorf("the second task of the project started in %s, want the remembered %s", ran[0], work)
	}
	// --dir . starts it here whatever is remembered.
	os.Remove(record)
	runIn(t, here, env, "claude", fmt.Sprint(second.ID), "--dir", ".")
	if ran := ranWith(t, record); ran[0] != here {
		t.Errorf("--dir . started in %s", ran[0])
	}
}

func TestClaudeNotFound(t *testing.T) {
	b := fakeSocket(t)
	b.fake.Configure(func(f *fakeserver.Server) { f.Claude = "" })
	task := b.add(t, "A task")
	env := setEnv(b.env, "PATH=/usr/bin:/bin") // no claude there
	r := fails(t, env, 2, "claude command was not found", "claude", fmt.Sprint(task.ID))
	if r.stdout != "" || b.get(t, task.ID).Assignee != "me" {
		t.Error("nothing should be recorded when claude can't be found")
	}
}

func TestClaudeIsRefusedFromAnotherMachine(t *testing.T) {
	only(t, false, func(t *testing.T, b *backend) {
		task := b.add(t, "Fix the login page")
		env, record := claudeStub(t, b.env)
		r := fails(t, env, 9, "only works on the Mac itself.*\"hub\" profile reaches it over the network", "claude", fmt.Sprint(task.ID))
		if r.stdout != "" {
			t.Errorf("stdout: %q", r.stdout)
		}
		if _, err := os.Stat(record); err == nil {
			t.Fatal("claude was run from a remote profile")
		}
		if b.get(t, task.ID).Assignee != "me" {
			t.Error("the task was handed to Claude from a remote profile")
		}
		if b.fake != nil {
			for _, req := range b.fake.Requests() {
				if strings.Contains(req.Path, "claude-session") {
					t.Errorf("a request was made for it: %s %s", req.Method, req.Path)
				}
			}
		}
		fails(t, env, 9, "only works on the Mac itself", "claude", fmt.Sprint(task.ID), "--dry-run")
		// The server would refuse as well: on the port, the route does not exist.
		if _, err := b.client.ClaudeSession(context.Background(), task.ID); err == nil || !strings.Contains(err.Error(), "No such endpoint") {
			t.Errorf("the server answered a remote request for a Claude session: %v", err)
		}
		// It is refused the same way when the Mac can't be reached at all: no waiting, no confusing error.
		b.stop()
		began := time.Now()
		fails(t, env, 9, "only works on the Mac itself", "claude", fmt.Sprint(task.ID))
		if time.Since(began) > 3*time.Second {
			t.Errorf("took %s to refuse", time.Since(began))
		}
	})
}

func TestNotesInTheEditor(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Plan the trip")
		id := fmt.Sprint(task.ID)
		if _, err := b.client.Patch(context.Background(), task.ID, map[string]any{"notes": "# Ideas\n\n- Tram 28"}, task.Rev); err != nil {
			t.Fatal(err)
		}
		// An "editor" that adds a line to the file it is given, as a person would.
		seen := filepath.Join(t.TempDir(), "seen")
		editor := script(t, `cp "$1" `+seen+`; printf '%s\n' '- Pastéis de Belém' >> "$1"`)
		env := setEnv(b.env, "EDITOR="+editor)

		term := openTerminal(t, env, 100, 24, "edit", id, "--editor")
		if code := term.exit(t); code != 0 {
			t.Fatalf("exit %d: %s", code, term.text())
		}
		if got := b.get(t, task.ID).Notes; got != "# Ideas\n\n- Tram 28\n- Pastéis de Belém" {
			t.Errorf("the notes are now %q", got)
		}
		if was, _ := os.ReadFile(seen); string(was) != "# Ideas\n\n- Tram 28\n" || !strings.HasSuffix(seen, "seen") {
			t.Errorf("the editor was given %q", was)
		}
		// $VISUAL is preferred, and may carry arguments. An editor that changes nothing saves nothing.
		rev := b.get(t, task.ID).Rev
		term = openTerminal(t, setEnv(env, "VISUAL=/usr/bin/true --wait"), 100, 24, "edit", id, "-e")
		if code := term.exit(t); code != 0 || b.get(t, task.ID).Rev != rev {
			t.Errorf("an edit that changed nothing: exit %d, rev %d (was %d)", code, b.get(t, task.ID).Rev, rev)
		}
		// An editor that fails saves nothing.
		term = openTerminal(t, setEnv(env, "EDITOR=/usr/bin/false"), 100, 24, "edit", id, "--editor")
		if code := term.exit(t); code != 1 || !strings.Contains(term.text(), "nothing was saved") || b.get(t, task.ID).Rev != rev {
			t.Errorf("a failing editor: exit %d, %s", code, term.text())
		}
		// Without a terminal there is no editor to open: say what to do instead.
		fails(t, env, 2, "--editor needs a terminal.*--notes -", "edit", id, "--editor")

		// The same from the board: n opens the editor, and the board comes back afterwards.
		board := openTerminal(t, env, 110, 30)
		board.waitFor(t, "Plan the trip")
		board.send(t, "n")
		waitUntil(t, "the notes to be saved from the board", func() bool {
			return strings.HasSuffix(b.get(t, task.ID).Notes, "- Pastéis de Belém\n- Pastéis de Belém")
		})
		board.waitFor(t, "Updated the notes of #"+id)
		board.send(t, "q")
		if code := board.exit(t); code != 0 {
			t.Errorf("the board after the editor: exit %d", code)
		}
	})
}

func TestClaudeFromTheBoard(t *testing.T) {
	only(t, true, func(t *testing.T, b *backend) {
		task := b.add(t, "Fix the login page")
		env, record := claudeStub(t, b.env)
		board := openTerminal(t, env, 110, 30)
		board.waitFor(t, "Fix the login")
		board.send(t, "C")
		waitUntil(t, "claude to be run", func() bool { _, err := os.Stat(record); return err == nil })
		waitUntil(t, "the task to be Claude's", func() bool { return b.get(t, task.ID).Assignee == "claude" })
		if ran := ranWith(t, record); len(ran) < 6 || ran[1] != "--name" {
			t.Errorf("claude was run with %q", ran)
		}
		// When claude exits, the board is back and shows the task as Claude's.
		board.waitFor(t, "claude")
		board.send(t, "q")
		if code := board.exit(t); code != 0 {
			t.Errorf("exit %d", code)
		}
	})
	// From another machine the key says why not, and runs nothing.
	b := fakeRemote(t)
	task := b.add(t, "Fix the login page")
	env, record := claudeStub(t, b.env)
	board := openTerminal(t, env, 110, 30)
	board.waitFor(t, "Fix the login")
	board.send(t, "C")
	board.waitFor(t, "can only be started on the Mac itself")
	if _, err := os.Stat(record); err == nil || b.get(t, task.ID).Assignee != "me" {
		t.Error("claude was started from a remote profile")
	}
}

func TestCompletions(t *testing.T) {
	b := fakeSocket(t)
	b.add(t, "Renew passport")
	b.add(t, "Water the plants")
	for shell, want := range map[string]string{"zsh": "#compdef todos", "bash": "__start_todos", "fish": "complete -c todos"} {
		if out := ok(t, b.env, "completion", shell); !strings.Contains(out, want) || len(out) < 500 {
			t.Errorf("completion %s: %d bytes, missing %q", shell, len(out), want)
		}
	}
	// What the shell asks the command as the user presses tab.
	for _, c := range []struct {
		args []string
		want []string
	}{
		{[]string{"done", ""}, []string{"1\tRenew passport", "2\tWater the plants"}},
		{[]string{"show", ""}, []string{"1\tRenew passport"}},
		{[]string{"claude", ""}, []string{"2\tWater the plants"}},
		{[]string{"ls", "--due", ""}, []string{"today", "week", "overdue"}},
		{[]string{"edit", "1", "--priority", ""}, []string{"high", "medium", "low"}},
		{[]string{"--profile", ""}, []string{"local"}},
		{[]string{""}, []string{"add", "ls", "done", "claude", "pair"}},
	} {
		out := ok(t, b.env, append([]string{"__complete"}, c.args...)...)
		for _, want := range c.want {
			if !strings.Contains(out, want) {
				t.Errorf("completing %q: missing %q in:\n%s", c.args, want, out)
			}
		}
	}
	// Pressing tab never starts the app, and never waits long for one that isn't there.
	down := baseEnv(t)
	marker := filepath.Join(t.TempDir(), "started")
	down = setEnv(down, "TODOS_LAUNCH_CMD=touch "+marker)
	began := time.Now()
	out := ok(t, down, "__complete", "done", "")
	if _, err := os.Stat(marker); err == nil || strings.Contains(out, "\t") || time.Since(began) > 3*time.Second {
		t.Errorf("completion with the app not running: started %v, took %s, printed %q", err == nil, time.Since(began), out)
	}
}
