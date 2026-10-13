package integration

import (
	"bytes"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// terminal runs the command inside a real pseudo-terminal, so it behaves as it
// does for a person: `script` makes the terminal, and `stty` gives it a size.
type terminal struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	mu    sync.Mutex
	out   bytes.Buffer
}

var controls = regexp.MustCompile("\x1b\\[[0-9;?<=>]*[a-zA-Z]|\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)|\x1b[()][A-Z0-9]|\x1b[=>78]|\r")

func openTerminal(t *testing.T, env []string, cols, rows int, args ...string) *terminal {
	t.Helper()
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("needs the `script` command to make a terminal")
	}
	line := fmt.Sprintf("stty rows %d cols %d; exec %s", rows, cols, shellJoin(append([]string{bin}, args...)))
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("script", "-q", "/dev/null", "/bin/sh", "-c", line)
	} else {
		cmd = exec.Command("script", "-qfc", line, "/dev/null")
	}
	cmd.Env = setEnv(setEnv(env, "TERM=xterm-256color"), "TODOS_THEME=dark")
	term := &terminal{cmd: cmd}
	var err error
	if term.stdin, err = cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			term.mu.Lock()
			term.out.Write(buf[:n])
			term.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		term.stdin.Close()
		if term.cmd.ProcessState == nil {
			_ = term.cmd.Process.Kill()
			_ = term.cmd.Wait()
		}
	})
	return term
}

func shellJoin(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}

// raw is everything the command has written to the terminal so far.
func (term *terminal) raw() string {
	term.mu.Lock()
	defer term.mu.Unlock()
	return term.out.String()
}

// text is that with the terminal codes taken out.
func (term *terminal) text() string { return controls.ReplaceAllString(term.raw(), "") }

func (term *terminal) waitFor(t *testing.T, want string) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if strings.Contains(term.text(), want) {
			return
		}
	}
	t.Fatalf("%q never appeared on the terminal. It showed:\n%s", want, term.text())
}

func (term *terminal) send(t *testing.T, keys string) {
	t.Helper()
	if _, err := io.WriteString(term.stdin, keys); err != nil {
		t.Fatal(err)
	}
}

// exit waits for the command to end and returns its exit code.
func (term *terminal) exit(t *testing.T) int {
	t.Helper()
	done := make(chan struct{})
	go func() { _ = term.cmd.Wait(); close(done) }()
	select {
	case <-done:
		return term.cmd.ProcessState.ExitCode()
	case <-time.After(10 * time.Second):
		t.Fatalf("the command did not exit. The terminal showed:\n%s", term.text())
	}
	return -1
}

// With no arguments on a terminal, the command opens the board.
func TestBoardOnARealTerminal(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		b.add(t, "Renew passport !high")
		b.add(t, "Water the plants")
		term := openTerminal(t, b.env, 110, 30)
		term.waitFor(t, "To do")
		term.waitFor(t, "Renew passport")
		term.waitFor(t, "In progress")
		term.waitFor(t, "live")
		if !strings.Contains(term.raw(), "\x1b[?1049h") {
			t.Error("the board should use the terminal's alternate screen")
		}
		// A change made elsewhere appears without a key being pressed.
		b.add(t, "From elsewhere")
		term.waitFor(t, "From elsewhere")

		term.send(t, "q")
		if code := term.exit(t); code != 0 {
			t.Errorf("q should end the board cleanly, got exit %d", code)
		}
		if !strings.Contains(term.raw(), "\x1b[?1049l") {
			t.Error("the terminal's own screen should be restored on the way out")
		}
	})
}

// On a terminal, plain commands are styled; the same command in a pipe is not.
func TestCommandsOnARealTerminal(t *testing.T) {
	b := fakeSocket(t)
	b.add(t, "Renew passport !high")
	term := openTerminal(t, b.env, 100, 24, "ls")
	if code := term.exit(t); code != 0 {
		t.Fatalf("exit %d: %s", code, term.text())
	}
	if !strings.Contains(term.text(), "Renew passport") || !strings.Contains(term.raw(), "\x1b[") {
		t.Errorf("ls on a terminal should be styled: %q", term.raw())
	}
	if strings.Contains(term.raw(), "\x1b[?1049h") {
		t.Error("ls should not take over the screen")
	}
	// NO_COLOR is honored on a terminal.
	term = openTerminal(t, setEnv(b.env, "NO_COLOR=1"), 100, 24, "ls")
	term.exit(t)
	if regexp.MustCompile("\x1b\\[[0-9;]*(3[0-7]|9[0-7])m").MatchString(term.raw()) {
		t.Errorf("ls with NO_COLOR on a terminal: %q", term.raw())
	}
}
