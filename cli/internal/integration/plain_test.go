package integration

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Output that is not going to a terminal has no color or cursor codes in it,
// and nothing ever waits for an answer: a script gets plain text or a failure.
func TestPipedOutputIsPlainAndNeverPrompts(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Renew passport tomorrow !high #personal @errand")
		id := fmt.Sprint(task.ID)
		if _, err := b.client.Patch(context.Background(), task.ID, map[string]any{"notes": "# Heading\n\n**bold** and a [link](https://example.com)\n\n- one\n- two"}, task.Rev); err != nil {
			t.Fatal(err)
		}
		if _, err := b.client.AddSubtasks(context.Background(), task.ID, []string{"Photos"}); err != nil {
			t.Fatal(err)
		}

		// Everything that would tempt a program to use color anyway.
		env := b.env
		for _, kv := range []string{"TERM=xterm-256color", "COLORTERM=truecolor", "CLICOLOR_FORCE=1", "FORCE_COLOR=1"} {
			env = setEnv(env, kv)
		}

		// Standard input is a pipe that never closes and never has anything in it.
		// A command that waited for an answer would wait forever.
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		defer writer.Close()

		for _, c := range []struct {
			args []string
			code int
		}{
			{[]string{}, 0}, // no arguments, no terminal: the list
			{[]string{"ls"}, 0},
			{[]string{"ls", "--all"}, 0},
			{[]string{"ls", "--json"}, 0},
			{[]string{"due"}, 0},
			{[]string{"due", "--json"}, 0},
			{[]string{"show", id}, 0},
			{[]string{"show", id, "--json"}, 0},
			{[]string{"status"}, 0},
			{[]string{"profiles"}, 0},
			{[]string{"version"}, 0},
			{[]string{"--help"}, 0},
			{[]string{"add", "--help"}, 0},
			{[]string{"add", "Another one"}, 0},
			{[]string{"start", id}, 0},
			{[]string{"sub", "done", id, "1"}, 0},
			{[]string{"comment", id, "Noted"}, 0},
			{[]string{"edit", id, "--priority", "low"}, 0},
			{[]string{"done", id}, 0},
			// These need an answer and there is nobody to give one: fail, don't ask.
			{[]string{"add"}, 2},
			{[]string{"rm", id}, 2},
			{[]string{"pair", "https://127.0.0.1:1"}, 2},
			{[]string{"show", "999"}, 3},
			{[]string{"nonsense"}, 2},
		} {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			cmd := exec.CommandContext(ctx, bin, c.args...)
			cmd.Env = env
			cmd.Stdin = reader
			var stdout, stderr strings.Builder
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			timedOut := ctx.Err() != nil
			cancel()
			name := "todos " + strings.Join(c.args, " ")
			if timedOut {
				t.Fatalf("%s: still running after 15s (waiting for input?)", name)
			}
			if code := cmd.ProcessState.ExitCode(); code != c.code {
				t.Errorf("%s: exit %d (%v), want %d\n%s%s", name, code, err, c.code, stdout.String(), stderr.String())
			}
			for stream, text := range map[string]string{"stdout": stdout.String(), "stderr": stderr.String()} {
				if ansi.MatchString(text) {
					t.Errorf("%s: %s has terminal codes in it: %q", name, stream, text)
				}
			}
			if c.code == 0 && stderr.Len() > 0 {
				t.Errorf("%s: wrote to stderr on success: %q", name, stderr.String())
			}
			if c.code != 0 && stdout.Len() > 0 {
				t.Errorf("%s: wrote to stdout on failure: %q", name, stdout.String())
			}
		}

		// NO_COLOR is harmless here too.
		if out := ok(t, setEnv(env, "NO_COLOR=1"), "ls", "--all"); ansi.MatchString(out) {
			t.Errorf("ls with NO_COLOR: %q", out)
		}
	})
}
