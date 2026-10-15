package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"todos/internal/fakeserver"
	"todos/internal/queue"
)

// paired is a harness whose default profile reaches the fake over HTTPS
// through a gate, which a test shuts to make the Mac unreachable. It records
// the background senders the command would start instead of starting them.
func paired(t *testing.T, tty bool) (*harness, *fakeserver.Gate, *[][]string) {
	t.Helper()
	h := newHarness(t, tty, false)
	h.env["TODOS_SOCKET"] = filepath.Join(shortDir(t), "absent.sock")
	url, ca := h.fake.ServeTLS()
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, ca, 0o600); err != nil {
		t.Fatal(err)
	}
	h.env["TODOS_CA_FILE"] = caFile
	g, err := fakeserver.NewGate(strings.TrimPrefix(url, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Shut)
	writeHub(t, h, "https://"+g.Addr)
	spawned := &[][]string{}
	h.App.Spawn = func(argv []string) error { *spawned = append(*spawned, argv); return nil }
	return h, g, spawned
}

// writeHub saves the "hub" profile, the default, at url, and with an SSH host
// if one is given.
func writeHub(t *testing.T, h *harness, url string, ssh ...string) {
	t.Helper()
	dir := filepath.Join(h.env["XDG_CONFIG_HOME"], "todos")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	profile := map[string]string{"url": url, "tokenStore": "file"}
	if len(ssh) > 0 {
		profile["ssh"] = ssh[0]
	}
	cfg, _ := json.Marshal(map[string]any{"default": "hub", "profiles": map[string]any{"hub": profile}})
	creds, _ := json.Marshal(map[string]string{"hub": h.fake.Token()})
	for name, data := range map[string][]byte{"config.json": cfg, "credentials.json": creds} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func (h *harness) queued(t *testing.T) []queue.Item {
	t.Helper()
	items, err := queue.For(filepath.Join(h.env["XDG_CONFIG_HOME"], "todos"), "hub").List()
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func changesReceived(f *fakeserver.Server) []fakeserver.Request {
	var out []fakeserver.Request
	for _, r := range f.Requests() {
		if r.Method != "GET" {
			out = append(out, r)
		}
	}
	return out
}

func TestOfflineChangesAreSavedAndSentLater(t *testing.T) {
	h, g, spawned := paired(t, true)
	h.fake.Add("Renew passport")
	g.Shut()

	if code := h.run("add", "Call the bank tomorrow"); code != 0 {
		t.Fatalf("add: exit %d, %q", code, h.err.String())
	}
	out := plain(h.out.String())
	if !strings.Contains(h.out.String(), "Saved for later") || !strings.Contains(out, "add “Call the bank tomorrow”") ||
		!strings.Contains(out, "nothing is serving Todos there") || !strings.Contains(out, "todos queue") {
		t.Errorf("add said: %q", out)
	}
	if want := [][]string{{"/usr/local/bin/todos", "queue", "send", "--background", "--profile", "hub"}}; !reflect.DeepEqual(*spawned, want) {
		t.Errorf("background sender: %v", *spawned)
	}
	for _, args := range [][]string{{"done", "1", "-m", "Sent"}, {"comment", "#1", "Called them"}, {"sub", "add", "1", "Photos", "Form"}} {
		if code := h.run(args...); code != 0 || !strings.Contains(h.out.String(), "Saved for later") {
			t.Fatalf("%v: exit %d, %q %q", args, code, h.out.String(), h.err.String())
		}
	}
	// A task named by words can't be looked up, so that isn't saved.
	if code := h.run("done", "passport"); code != ExitUnreachable || !strings.Contains(h.err.String(), "only for a task named by its number") {
		t.Errorf("done by words: exit %d, %q", code, h.err.String())
	}
	if code := h.run("queue"); code != 0 {
		t.Fatal(h.err.String())
	}
	list := plain(h.out.String())
	for _, want := range []string{"1  ", "add “Call the bank tomorrow”", "done #1, “Sent”", "comment on #1, “Called them”", "subtasks on #1, “Photos”, “Form”"} {
		if !strings.Contains(list, want) {
			t.Errorf("queue lacks %q:\n%s", want, list)
		}
	}
	if got := changesReceived(h.fake); len(got) != 0 {
		t.Fatalf("nothing should have reached Todos: %+v", got)
	}
	saved := h.queued(t)

	// Back again: the next command sends them first, in order, each with its own key.
	g.Open()
	h.App.ErrTTY = true
	if code := h.run("ls"); code != 0 || !strings.Contains(h.out.String(), "Call the bank") {
		t.Fatalf("ls: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	if said := plain(h.err.String()); !strings.Contains(said, "Sent 4 changes saved while Todos couldn't be reached") || !strings.Contains(said, "Added #2 Call the bank") {
		t.Errorf("said: %q", said)
	}
	got := changesReceived(h.fake)
	paths := []string{"/api/v1/capture", "/api/v1/tasks/1/complete", "/api/v1/tasks/1/comments", "/api/v1/tasks/1/subtasks"}
	if len(got) != len(paths) {
		t.Fatalf("received %+v", got)
	}
	for i, r := range got {
		if r.Path != paths[i] || r.Header.Get("Idempotency-Key") != saved[i].Key {
			t.Errorf("change %d: %s %s with key %q, want %s with %q", i, r.Method, r.Path, r.Header.Get("Idempotency-Key"), paths[i], saved[i].Key)
		}
	}
	var capture map[string]string
	json.Unmarshal([]byte(got[0].Body), &capture) //nolint:errcheck
	if at, err := time.Parse(time.RFC3339, capture["at"]); err != nil || time.Since(at) > time.Minute {
		t.Errorf("the line should be read as of when it was typed: %q", got[0].Body)
	}
	task, _ := h.fake.Task(1)
	if task.Status != "done" || len(task.Subtasks) != 2 {
		t.Errorf("task 1: %+v", task)
	}
	if len(h.queued(t)) != 0 {
		t.Error("the queue should be empty")
	}
	if h.run("queue"); !strings.Contains(h.out.String(), "Nothing is waiting") {
		t.Errorf("empty queue: %q", h.out.String())
	}
	// Sent now, a line is read as of now, without "at".
	if code := h.run("add", "Post letter"); code != 0 {
		t.Fatal(h.err.String())
	}
	if last := changesReceived(h.fake); strings.Contains(last[len(last)-1].Body, `"at"`) {
		t.Errorf("sent at once: %s", last[len(last)-1].Body)
	}
}

func TestOfflineInAScript(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	if code := h.run("add", "Buy milk"); code != 0 || h.out.String() != "" ||
		!strings.Contains(h.err.String(), "saved 1 change to send when Todos answers") {
		t.Fatalf("add: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	h.App.In = strings.NewReader("Post letter fri\nWater plants\n")
	if code := h.run("add", "-"); code != 0 || !strings.Contains(h.err.String(), "saved 2 changes") {
		t.Fatalf("add -: exit %d, %q", code, h.err.String())
	}
	if code := h.run("queue"); code != 0 {
		t.Fatal(h.err.String())
	}
	row := regexp.MustCompile(`^1\twaiting\t\d{4}-\d\d-\d\dT[\d:]+Z\tadd\t-\tBuy milk\t-$`)
	lines := strings.Split(strings.TrimSpace(h.out.String()), "\n")
	if len(lines) != 3 || !row.MatchString(lines[0]) || !strings.HasPrefix(lines[2], "3\twaiting") {
		t.Errorf("queue rows: %q", h.out.String())
	}

	if code := h.run("--json", "done", "4"); code != 0 {
		t.Fatal(h.err.String())
	}
	var one struct {
		Queued queue.Item `json:"queued"`
	}
	if err := json.Unmarshal(h.out.Bytes(), &one); err != nil || one.Queued.ID != 4 || one.Queued.Kind != "done" || one.Queued.Task != 4 || h.err.String() != "" {
		t.Errorf("--json: %q %v", h.out.String(), err)
	}
	if code := h.run("--json", "queue"); code != 0 {
		t.Fatal(h.err.String())
	}
	var all struct {
		Profile string       `json:"profile"`
		Changes []queue.Item `json:"changes"`
	}
	if err := json.Unmarshal(h.out.Bytes(), &all); err != nil || all.Profile != "hub" || len(all.Changes) != 4 {
		t.Errorf("queue --json: %q %v", h.out.String(), err)
	}

	// A command that can't wait fails as before, and says what is waiting.
	if code := h.run("ls"); code != ExitUnreachable || !strings.Contains(h.err.String(), "(4 changes saved for later are waiting to be sent: `todos queue`)") {
		t.Errorf("ls: exit %d, %q", code, h.err.String())
	}
}

func TestQueueModes(t *testing.T) {
	h, g, spawned := paired(t, false)
	g.Shut()
	h.env["TODOS_QUEUE"] = "off"
	if code := h.run("add", "Buy milk"); code != ExitUnreachable || len(h.queued(t)) != 0 || len(*spawned) != 0 {
		t.Errorf("off: exit %d, %d saved, %v", code, len(h.queued(t)), *spawned)
	}
	h.env["TODOS_QUEUE"] = "manual"
	if code := h.run("add", "Buy milk"); code != 0 || len(h.queued(t)) != 1 || len(*spawned) != 0 {
		t.Errorf("manual: exit %d, %d saved, %v", code, len(h.queued(t)), *spawned)
	}
}

func TestLocalProfileNeverQueues(t *testing.T) {
	h := newHarness(t, true, false) // the app on this Mac, not running and failing to start
	h.App.Spawn = func([]string) error { t.Error("no sender for the local profile"); return nil }
	if code := h.run("add", "Buy milk"); code != ExitStart {
		t.Errorf("add: exit %d, %q", code, h.err.String())
	}
	if code := h.run("queue"); code != 0 || !strings.Contains(h.out.String(), "nothing is ever saved for later") {
		t.Errorf("queue: exit %d, %q", code, h.out.String())
	}
}

func TestTurnedDownChangesStay(t *testing.T) {
	h, g, _ := paired(t, false)
	h.fake.Add("Renew passport")
	h.fake.Add("Gone soon")
	g.Shut()
	for _, args := range [][]string{{"add", "!high"}, {"done", "2"}, {"add", "Buy milk"}} {
		if code := h.run(args...); code != 0 {
			t.Fatalf("%v: %q", args, h.err.String())
		}
	}
	h.fake.Remove(2)
	g.Open()

	// The command does its work; what was turned down is said, and the rest go.
	if code := h.run("ls"); code != 0 || !strings.Contains(h.out.String(), "Buy milk") {
		t.Fatalf("ls: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	for _, want := range []string{"add “!high”: That line has no title", "done #2: task #2 is no longer there", "`todos queue rm 1`"} {
		if !strings.Contains(h.err.String(), want) {
			t.Errorf("stderr lacks %q: %q", want, h.err.String())
		}
	}
	items := h.queued(t)
	if len(items) != 2 || items[0].Waiting() || items[1].Waiting() || items[0].Refused.Status != 400 || items[1].Refused.Status != 404 {
		t.Fatalf("queue: %+v", items)
	}
	// They aren't sent again, and on a terminal each command mentions them.
	before := len(changesReceived(h.fake))
	h.App.ErrTTY = true
	if h.run("ls"); !strings.Contains(h.err.String(), "2 changes saved while Todos couldn't be reached were turned down: see `todos queue`") {
		t.Errorf("reminder: %q", h.err.String())
	}
	if len(changesReceived(h.fake)) != before {
		t.Error("a change turned down was sent again")
	}
	if h.run("status"); !strings.Contains(h.out.String(), "queue    0 waiting, 2 turned down") {
		t.Errorf("status: %q", h.out.String())
	}
	if h.run("queue"); !regexp.MustCompile(`^1\trefused\t[^\t]+\tadd\t-\t!high\tThat line has no title.*\n2\trefused\t[^\t]+\tdone\t2\t-\ttask #2 is no longer there\n$`).MatchString(h.out.String()) {
		t.Errorf("queue: %q", h.out.String())
	}

	if code := h.run("queue", "rm", "1"); code != 0 || len(h.queued(t)) != 1 {
		t.Errorf("rm 1: exit %d", code)
	}
	if code := h.run("queue", "rm", "1"); code != ExitNotFound {
		t.Errorf("rm 1 again: exit %d", code)
	}
	if code := h.run("queue", "rm"); code != ExitUsage {
		t.Errorf("rm with nothing: exit %d", code)
	}
	if code := h.run("queue", "rm", "--all"); code != 0 || len(h.queued(t)) != 0 {
		t.Errorf("rm --all: exit %d, %d left", code, len(h.queued(t)))
	}
}

func TestADroppedChangeIsSavedAndMadeOnce(t *testing.T) {
	h, _, _ := paired(t, false)
	// Every try reaches the app and loses its answer (and Go tries a change
	// with a key more than once itself).
	h.fake.CutNext(10)
	if code := h.run("add", "Buy milk"); code != 0 || !strings.Contains(h.err.String(), "dropped") || !strings.Contains(h.err.String(), "saved 1 change") {
		t.Fatalf("add: exit %d, %q", code, h.err.String())
	}
	h.fake.CutNext(0)
	if code := h.run("ls"); code != 0 {
		t.Fatal(h.err.String())
	}
	if n := len(h.fake.Tasks()); n != 1 || strings.Count(h.out.String(), "Buy milk") != 1 {
		t.Errorf("%d tasks, listed %q: sent again with the same key, it must be made once", n, h.out.String())
	}
}

func TestSavedForAnotherAddress(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	// Paired again, with the same name, at another address (which happens to
	// lead to the same server).
	g.Open()
	other, err := fakeserver.NewGate(g.Addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(other.Shut)
	writeHub(t, h, "https://"+other.Addr)
	if code := h.run("ls"); code != 0 || !strings.Contains(h.err.String(), "it was saved for https://"+g.Addr) {
		t.Errorf("ls: exit %d, %q", code, h.err.String())
	}
	if len(h.fake.Tasks()) != 0 {
		t.Error("a change saved for one address went to another")
	}
}

func TestSendingWhenItAnswers(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	if code := h.run("queue", "send"); code != ExitUnreachable {
		t.Errorf("send while unreachable: exit %d", code)
	}

	// --wait keeps trying.
	go func() { time.Sleep(500 * time.Millisecond); g.Open() }()
	if code := h.run("queue", "send", "--wait"); code != 0 || !strings.Contains(h.out.String(), "\tBuy milk") {
		t.Fatalf("send --wait: exit %d, %q %q", code, h.out.String(), h.err.String())
	}

	// So does the sender left in the background, and only one runs at a time.
	g.Shut()
	h.run("add", "Post letter")
	q := queue.For(filepath.Join(h.env["XDG_CONFIG_HOME"], "todos"), "hub")
	unlock, err := q.Lock(context.Background(), "waiter", 0)
	if err != nil {
		t.Fatal(err)
	}
	if code := h.run("queue", "send", "--background"); code != 0 || len(h.queued(t)) != 1 {
		t.Errorf("a second sender should leave it to the first: exit %d", code)
	}
	unlock()
	done := make(chan int, 1)
	go func() { done <- h.run("queue", "send", "--background") }()
	time.Sleep(300 * time.Millisecond)
	g.Open()
	select {
	case code := <-done:
		if code != 0 || len(h.queued(t)) != 0 {
			t.Errorf("background: exit %d, %d left", code, len(h.queued(t)))
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the background sender did not finish")
	}
	titles := []string{}
	for _, task := range h.fake.Tasks() {
		titles = append(titles, task.Title)
	}
	if !reflect.DeepEqual(titles, []string{"Buy milk", "Post letter"}) {
		t.Errorf("tasks: %v", titles)
	}
}

// A change saved by a newer todos command, of a kind this one doesn't know,
// is left for that one: not sent, not refused, and not tried for ever.
func TestAChangeFromANewerCommandIsLeftAlone(t *testing.T) {
	h, g, _ := paired(t, false)
	q := queue.For(filepath.Join(h.env["XDG_CONFIG_HOME"], "todos"), "hub")
	if _, err := q.Add(context.Background(), []queue.Item{{Kind: "rename", Task: 1, Text: "x", Key: "k-0123456789", URL: "https://" + g.Addr, Made: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() { done <- h.run("queue", "send", "--background") }()
	select {
	case code := <-done:
		if code != 0 {
			t.Errorf("background: exit %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the background sender kept trying a change it can't send")
	}
	if code := h.run("ls"); code != 0 {
		t.Fatal(h.err.String())
	}
	if items := h.queued(t); len(items) != 1 || !items[0].Waiting() || len(changesReceived(h.fake)) != 0 {
		t.Errorf("queue: %+v, received %+v", items, changesReceived(h.fake))
	}
}

// The Mac is there but Todos isn't, and starting it over SSH fails (a Mac at
// the login window): the change waits for it.
func TestAppDownAndNotStartedOverSSH(t *testing.T) {
	h, g, _ := paired(t, false)
	writeHub(t, h, "https://"+g.Addr, "mac")
	h.fake.FailNext("GET", "/api/v1/info", 502, "") // what `tailscale serve` says with the app down
	if code := h.run("add", "Buy milk"); code != 0 || len(h.queued(t)) != 1 || !strings.Contains(h.err.String(), "Starting it over SSH (mac) did not work") {
		t.Errorf("add: exit %d, %d saved, %q", code, len(h.queued(t)), h.err.String())
	}
	if len(h.ran) != 1 || h.ran[0][0] != "ssh" {
		t.Errorf("ran %v", h.ran)
	}
}

// A machine whose clock is ahead of the Mac's: the app says the line was typed
// in the future, so it is read as of now, with the same key.
func TestAClockAheadOfTheMacs(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	g.Open()
	h.fake.FailNext("POST", "/api/v1/capture", 400, `{"error":{"code":"invalid","message":"\"at\" is when the line was typed, so it cannot be in the future."}}`)
	if code := h.run("ls"); code != 0 || !strings.Contains(h.out.String(), "Buy milk") || len(h.queued(t)) != 0 {
		t.Fatalf("ls: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
	got := changesReceived(h.fake)
	if len(got) != 2 || !strings.Contains(got[0].Body, `"at"`) || strings.Contains(got[1].Body, `"at"`) ||
		got[0].Header.Get("Idempotency-Key") != got[1].Header.Get("Idempotency-Key") {
		t.Errorf("received %+v", got)
	}
}

// What stops the queue at the start of a command is said, and the rest are
// left to the background.
func TestWhatStopsTheQueueIsSaid(t *testing.T) {
	h, g, spawned := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	h.run("add", "Post letter")
	g.Open()
	*spawned = nil

	// Something wrong at the app: said wherever, and the command goes on.
	h.fake.FailNext("POST", "/api/v1/capture", 500, `{"error":{"code":"internal","message":"Something went wrong."}}`)
	if code := h.run("ls"); code != 0 || !strings.Contains(h.err.String(), "2 changes saved while Todos couldn't be reached are still waiting: Something went wrong.") {
		t.Errorf("after a 500: exit %d, %q", code, h.err.String())
	}
	if len(*spawned) != 0 {
		t.Errorf("a sender for something waiting won't mend: %v", *spawned)
	}
	// Busy: the rest go in the background, and a terminal is told.
	h.App.ErrTTY = true
	h.fake.FailNext("POST", "/api/v1/capture", 429, `{"error":{"code":"rate_limited","message":"Too many changes."}}`)
	if code := h.run("ls"); code != 0 || !strings.Contains(h.err.String(), "2 changes saved while Todos couldn't be reached are still waiting: Too many changes.") {
		t.Errorf("after a 429: exit %d, %q", code, h.err.String())
	}
	if len(*spawned) != 1 {
		t.Errorf("the rest should go in the background: %v", *spawned)
	}
	if h.run("ls"); len(h.queued(t)) != 0 {
		t.Errorf("then they go: %+v", h.queued(t))
	}
}

// `todos queue rm` waits for a send in progress, so what it removes isn't sent.
func TestRemovingWaitsForASend(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	q := queue.For(filepath.Join(h.env["XDG_CONFIG_HOME"], "todos"), "hub")
	unlock, err := q.Lock(context.Background(), "send", 0)
	if err != nil {
		t.Fatal(err)
	}
	go func() { time.Sleep(300 * time.Millisecond); unlock() }()
	began := time.Now()
	if code := h.run("queue", "rm", "1"); code != 0 || len(h.queued(t)) != 0 || time.Since(began) < 250*time.Millisecond {
		t.Errorf("rm: exit %d after %s, %d left", code, time.Since(began), len(h.queued(t)))
	}
}

func TestSetAsideFilesAreMentioned(t *testing.T) {
	h, g, _ := paired(t, false)
	g.Shut()
	h.run("add", "Buy milk")
	dir := filepath.Join(h.env["XDG_CONFIG_HOME"], "todos", "queue", "hub")
	os.WriteFile(filepath.Join(dir, "000009.json"), []byte("{not json"), 0o600) //nolint:errcheck
	if code := h.run("queue"); code != 0 || strings.Count(h.out.String(), "\n") != 1 || !strings.Contains(h.err.String(), "1 file in") || !strings.Contains(h.err.String(), "set aside") {
		t.Errorf("queue: exit %d, %q %q", code, h.out.String(), h.err.String())
	}
}
