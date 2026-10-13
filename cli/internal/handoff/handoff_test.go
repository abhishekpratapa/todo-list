package handoff

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"todos/internal/api"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestEditor(t *testing.T) {
	for _, c := range []struct {
		vars map[string]string
		want []string
	}{
		{nil, []string{"vi", "/tmp/n.md"}},
		{map[string]string{"EDITOR": "nano"}, []string{"nano", "/tmp/n.md"}},
		{map[string]string{"EDITOR": "nano", "VISUAL": "code --wait"}, []string{"code", "--wait", "/tmp/n.md"}},
		{map[string]string{"EDITOR": "  ", "VISUAL": ""}, []string{"vi", "/tmp/n.md"}},
		{map[string]string{"EDITOR": "emacsclient -t -a ''"}, []string{"emacsclient", "-t", "-a", "''", "/tmp/n.md"}},
	} {
		if got := Editor(env(c.vars), "/tmp/n.md"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: %v, want %v", c.vars, got, c.want)
		}
	}
}

func TestNotesFile(t *testing.T) {
	path, err := NotesFile(12, "# Steps\n\n- one")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if !strings.Contains(filepath.Base(path), "todos-12-") || !strings.HasSuffix(path, ".md") {
		t.Errorf("the file is %s", path)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("notes are private: the file is %v", info.Mode().Perm())
	}
	if b, _ := os.ReadFile(path); string(b) != "# Steps\n\n- one\n" {
		t.Errorf("written as %q", b)
	}
	// Unedited, they read back as they were: the final line break is the file's, not the notes'.
	if got, _ := ReadNotes(path); got != "# Steps\n\n- one" || !SameNotes("# Steps\n\n- one", got) {
		t.Errorf("read back as %q", got)
	}
	os.WriteFile(path, []byte("# Steps\n\n- one\n- two\n\n\n"), 0o600) //nolint:errcheck
	if got, _ := ReadNotes(path); got != "# Steps\n\n- one\n- two" || SameNotes("# Steps\n\n- one", got) {
		t.Errorf("after editing: %q", got)
	}
	empty, _ := NotesFile(3, "")
	defer os.Remove(empty)
	if b, _ := os.ReadFile(empty); len(b) != 0 {
		t.Errorf("no notes is an empty file, not %q", b)
	}
	if !SameNotes("", "\n") || !SameNotes("a\n", "a") || SameNotes("a", "a b") {
		t.Error("SameNotes")
	}
}

func TestPlan(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	remembered, here, asked := filepath.Join(root, "remembered"), filepath.Join(root, "here"), filepath.Join(root, "asked")
	for _, dir := range []string{remembered, here, asked} {
		os.MkdirAll(dir, 0o755) //nolint:errcheck
	}
	program := func(name string) string {
		path := filepath.Join(root, name)
		os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755) //nolint:errcheck
		return path
	}
	onPath, fromApp, fromEnv := program("claude-on-path"), program("claude-from-app"), program("claude-from-env")
	found := func(string) (string, error) { return onPath, nil }
	missing := func(string) (string, error) { return "", errors.New("not found") }
	session := &api.ClaudeSession{Prompt: "Work on task #12 from my todo list: Fix login", Folder: remembered, Args: []string{"--name", "Todo #12: Fix login", "--allowedTools", "mcp__todolist"}, Claude: fromApp}

	// Where it starts: the folder asked for, else the one the app remembers, else here.
	for _, c := range []struct {
		dir, remembered, want string
	}{
		{"", remembered, remembered}, {"", "", here}, {asked, remembered, asked}, {".", remembered, here}, {"../asked", remembered, asked},
	} {
		s := *session
		s.Folder = c.remembered
		plan, err := Plan(&s, c.dir, here, env(nil), found)
		if err != nil || plan.Dir != c.want {
			t.Errorf("--dir %q, remembered %q: %+v, %v; want %s", c.dir, c.remembered, plan, err, c.want)
		}
	}
	if _, err := Plan(session, filepath.Join(root, "nowhere"), here, env(nil), found); err == nil || !strings.Contains(err.Error(), "is not a folder") {
		t.Errorf("a folder that isn't there: %v", err)
	}

	// Which claude: TODOS_CLAUDE_BIN, else the one on the PATH, else the one the app found.
	plan, _ := Plan(session, "", here, env(nil), found)
	if plan.Bin != onPath {
		t.Errorf("on the PATH: %s", plan.Bin)
	}
	if plan, _ = Plan(session, "", here, env(nil), missing); plan.Bin != fromApp {
		t.Errorf("not on the PATH: %s", plan.Bin)
	}
	if plan, _ = Plan(session, "", here, env(map[string]string{"TODOS_CLAUDE_BIN": fromEnv}), found); plan.Bin != fromEnv {
		t.Errorf("with TODOS_CLAUDE_BIN: %s", plan.Bin)
	}
	nowhere := *session
	nowhere.Claude = ""
	if _, err := Plan(&nowhere, "", here, env(nil), missing); err == nil || !strings.Contains(err.Error(), "claude command was not found") {
		t.Errorf("no claude anywhere: %v", err)
	}
	if _, err := Plan(session, "", here, env(map[string]string{"TODOS_CLAUDE_BIN": remembered}), found); err == nil {
		t.Error("a folder is not a program")
	}

	// What it runs: the app's options, then --, then the opening message as one argument.
	plan, _ = Plan(session, "", here, env(nil), found)
	want := []string{"--name", "Todo #12: Fix login", "--allowedTools", "mcp__todolist", "--", "Work on task #12 from my todo list: Fix login"}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Errorf("args %q", plan.Args)
	}
	if cmd := plan.Command(); cmd.Path != onPath || cmd.Dir != remembered || !reflect.DeepEqual(cmd.Args[1:], want) {
		t.Errorf("command: %s in %s: %q", cmd.Path, cmd.Dir, cmd.Args)
	}
	if len(session.Args) != 4 {
		t.Error("the session's own arguments must not be changed")
	}
}
