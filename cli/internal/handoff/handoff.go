// Package handoff works out how to run other programs from the terminal: the
// user's editor on a task's notes, and `claude` on a task.
package handoff

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"todos/internal/api"
)

// Editor is the command that opens path in the user's editor: $VISUAL, then
// $EDITOR, then vi. The variable may carry arguments ("code --wait").
func Editor(getenv func(string) string, path string) []string {
	for _, name := range []string{"VISUAL", "EDITOR"} {
		if fields := strings.Fields(getenv(name)); len(fields) > 0 {
			return append(fields, path)
		}
	}
	return []string{"vi", path}
}

// NotesFile writes a task's notes to a temporary Markdown file for editing,
// readable only by the user. The caller removes it.
func NotesFile(id int, notes string) (string, error) {
	f, err := os.CreateTemp("", fmt.Sprintf("todos-%d-*.md", id))
	if err != nil {
		return "", err
	}
	defer f.Close()
	if notes != "" && !strings.HasSuffix(notes, "\n") {
		notes += "\n" // editors expect a final line break, and add one if it is missing
	}
	if _, err := f.WriteString(notes); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// ReadNotes reads the file back. The line break at the end is the editor's, not the notes'.
func ReadNotes(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(b), "\n"), nil
}

// SameNotes says whether an edit changed anything that matters.
func SameNotes(before, after string) bool {
	return strings.TrimRight(before, "\n") == strings.TrimRight(after, "\n")
}

// Claude is a session ready to start: run Bin with Args in Dir.
type Claude struct {
	Bin  string
	Args []string // the options, then "--", then the opening message
	Dir  string
}

// Plan works out how to start the session the app describes.
//
// The folder is the one asked for (dir); otherwise the one the app remembers
// for the task's project; otherwise the current one (cwd). The `claude` command
// is TODOS_CLAUDE_BIN if set; otherwise the one on the PATH; otherwise the one
// the app found.
func Plan(s *api.ClaudeSession, dir, cwd string, getenv func(string) string, lookPath func(string) (string, error)) (*Claude, error) {
	folder := dir
	switch {
	case folder != "":
		if !filepath.IsAbs(folder) {
			folder = filepath.Join(cwd, folder)
		}
	case s.Folder != "":
		folder = s.Folder
	default:
		folder = cwd
	}
	folder = filepath.Clean(folder)
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", folder)
	}

	bin := getenv("TODOS_CLAUDE_BIN")
	if bin == "" {
		if found, err := lookPath("claude"); err == nil {
			bin = found
		} else {
			bin = s.Claude
		}
	}
	if bin == "" {
		return nil, errors.New("the claude command was not found: install Claude Code, or set TODOS_CLAUDE_BIN to where it is")
	}
	if info, err := os.Stat(bin); err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
		return nil, fmt.Errorf("%s is not a program that can be run", bin)
	}
	args := append(append([]string{}, s.Args...), "--", s.Prompt)
	return &Claude{Bin: bin, Args: args, Dir: folder}, nil
}

// Command is the session as a command to run and wait for.
func (c *Claude) Command() *exec.Cmd {
	cmd := exec.Command(c.Bin, c.Args...)
	cmd.Dir = c.Dir
	return cmd
}
