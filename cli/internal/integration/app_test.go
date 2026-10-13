package integration

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"todos/internal/realserver"
)

// The real app, started by the command itself.
//
// This is the one test that runs Todos as an app (Electron) rather than its
// server on its own, so it is the one that shows what happens on a Mac when the
// command finds the app not running: it starts it in the background, with no
// window and without taking the front, waits for its socket, and carries on.
//
// It is off unless asked for, because it puts an icon in the Dock for a few
// seconds:
//
//	TODOS_TEST_ELECTRON=/path/to/Electron.app   runs this repository's sources
//	TODOS_TEST_APP=/path/to/Todos.app           runs a packaged app, and uses the
//	                                            todos command inside it
//
// Either way the app gets its own settings, data, socket and port (7442). The
// installed app, and whatever it is doing, is not touched.
func TestTheRealApp(t *testing.T) {
	electron, packaged := os.Getenv("TODOS_TEST_ELECTRON"), os.Getenv("TODOS_TEST_APP")
	if electron == "" && packaged == "" {
		t.Skip("set TODOS_TEST_ELECTRON or TODOS_TEST_APP to run the command against the real app")
	}
	repo := realserver.Repo()
	if packaged == "" && repo == "" {
		t.Skip("the app's sources are not next to this module")
	}

	root := realserver.ShortDir(t)
	userData, socket, log := filepath.Join(root, "user"), filepath.Join(root, "t.sock"), filepath.Join(root, "app.log")
	if err := os.MkdirAll(userData, 0o700); err != nil {
		t.Fatal(err)
	}
	// Quiet: no global shortcut to fight the installed app for, and nothing that pops up.
	quiet := `{"captureShortcut":null,"dailySummary":false,"reminderNotifications":false,"claudeNotifications":false}`
	if err := os.WriteFile(filepath.Join(userData, "settings.json"), []byte(quiet), 0o600); err != nil {
		t.Fatal(err)
	}
	// A copy of the bundle with a path of its own, so `open` can't take another
	// running copy for this one. On APFS the copy is a clone and takes no space.
	source, name := electron, "Electron.app"
	if packaged != "" {
		source, name = packaged, "Todos.app"
	}
	bundle := filepath.Join(root, name)
	if out, err := exec.Command("/bin/cp", "-Rc", source, bundle).CombinedOutput(); err != nil {
		t.Fatalf("copying %s: %v\n%s", source, err, out)
	}

	open := []string{"/usr/bin/open", "-g", "-n", "-a", bundle,
		"--env", "TODOS_USER_DATA=" + userData,
		"--env", "TODO_DATA_FILE=" + filepath.Join(root, "data", "todos.json"),
		"--env", fmt.Sprintf("TODO_PORT=%d", realserver.Port),
		"--env", "TODOS_SOCKET=" + socket,
		"--env", "TODOS_DEBUG=1",
		"--stdout", log, "--stderr", log, "--args"}
	if packaged == "" {
		open = append(open, repo)
	}
	open = append(open, "--background")

	todos := bin
	if packaged != "" {
		todos = filepath.Join(bundle, "Contents", "Resources", "bin", "todos")
	}
	env := setEnv(setEnv(setEnv(baseEnv(t), "TODOS_SOCKET="+socket), "TODOS_LAUNCH_CMD="+shellJoin(open)), "TODOS_START_TIMEOUT=45")
	env = setEnv(env, fmt.Sprintf("TODO_PORT=%d", realserver.Port))
	runApp := func(args ...string) result {
		cmd := exec.Command(todos, args...)
		cmd.Env = env
		var stdout, stderr strings.Builder
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		_ = cmd.Run()
		return result{stdout.String(), stderr.String(), cmd.ProcessState.ExitCode()}
	}
	lines := func() []string {
		b, _ := os.ReadFile(log)
		return strings.Split(string(b), "\n")
	}
	pid := func() int {
		for _, line := range lines() {
			if m := regexp.MustCompile(`^started: pid=(\d+)`).FindStringSubmatch(line); m != nil {
				n, _ := strconv.Atoi(m[1])
				return n
			}
		}
		return 0
	}
	t.Cleanup(func() {
		if p := pid(); p > 0 {
			_ = syscall.Kill(p, syscall.SIGTERM)
			for i := 0; i < 100 && syscall.Kill(p, 0) == nil; i++ {
				time.Sleep(50 * time.Millisecond)
			}
			_ = syscall.Kill(p, syscall.SIGKILL)
		}
		_ = exec.Command("/usr/bin/pkill", "-9", "-f", root+"/").Run() // any helper processes of this copy
	})

	// The app is not running. The command starts it, waits, and adds the task.
	began := time.Now()
	r := runApp("add", "Added by the command !high")
	took := time.Since(began)
	if r.code != 0 {
		t.Fatalf("todos add: exit %d\n%s\nthe app's log:\n%s", r.code, r.stderr, strings.Join(lines(), "\n"))
	}
	t.Logf("starting the app and adding a task took %s", took.Round(10*time.Millisecond))
	if !strings.Contains(r.stdout, "Added by the command") {
		t.Errorf("add printed %q", r.stdout)
	}

	// It started in the background: no window, and not in front.
	started := ""
	for _, line := range lines() {
		if strings.HasPrefix(line, "started: ") {
			started = line
		}
	}
	if !strings.Contains(started, "background=true") || !strings.Contains(started, "socket="+socket) {
		t.Errorf("the app says it started as: %q", started)
	}
	if err := syscall.Kill(pid(), syscall.SIGUSR2); err != nil {
		t.Fatal(err)
	}
	var state struct {
		Active bool
		Window string
		Tray   bool
		Socket string
	}
	waitUntil(t, "the app to report its state", func() bool {
		for _, line := range lines() {
			if strings.HasPrefix(line, "state: ") {
				return json.Unmarshal([]byte(strings.TrimPrefix(line, "state: ")), &state) == nil
			}
		}
		return false
	})
	if state.Window != "none" || state.Active || !state.Tray || state.Socket != socket {
		t.Errorf("after a background start the app is: %+v (want no window, not in front, menu bar item there)", state)
	}

	// Now that it is running, commands just work, and nothing is started twice.
	began = time.Now()
	if got := rows(runApp("ls").stdout); len(got) != 1 || got[0][2] != "high" {
		t.Errorf("ls: %v", got)
	}
	if again := time.Since(began); again > 3*time.Second {
		t.Errorf("a command with the app running took %s", again)
	}
	status := decode[map[string]any](t, runApp("status", "--json").stdout)
	if status["transport"] != "socket" || status["appVersion"] == "" {
		t.Errorf("status: %v", status)
	}
	if r = runApp("done", "1", "-m", "Finished from the terminal"); r.code != 0 {
		t.Errorf("done: exit %d: %s", r.code, r.stderr)
	}
	// Start with Claude, as far as the command line: what the app would start a session with.
	runApp("add", "Hand this to Claude")
	dry := runApp("claude", "2", "--dry-run", "--dir", root)
	if dry.code == 0 && !strings.Contains(dry.stdout, "--allowedTools mcp__todolist") {
		t.Errorf("claude --dry-run: %q", dry.stdout)
	}
	if dry.code != 0 && !strings.Contains(dry.stderr, "claude command was not found") {
		t.Errorf("claude --dry-run: exit %d: %s", dry.code, dry.stderr)
	}
	count := 0
	for _, line := range lines() {
		if strings.HasPrefix(line, "started: ") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("the app was started %d times", count)
	}

	// Quit the app: its socket goes, and the command says it is not running.
	if err := syscall.Kill(pid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the socket to be removed", func() bool { _, err := os.Stat(socket); return err != nil })
	fails(t, setEnv(env, "TODOS_LAUNCH_CMD=false"), 7, "could not start Todos", "ls")
}
