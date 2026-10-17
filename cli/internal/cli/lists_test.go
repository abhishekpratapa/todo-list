package cli

// Sorting, filters with several values and the Today view from the command
// line: what is asked of the app, what an app from before them says, the sort
// in config.json, and `todos today`.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"todos/internal/fakeserver"
)

// lists makes a harness whose app speaks API revision rev, with a few tasks.
func lists(t *testing.T, tty bool, rev int) *harness {
	t.Helper()
	h := newHarness(t, tty, true)
	h.fake.Configure(func(s *fakeserver.Server) { s.Revision = rev })
	day := func(n int) *string { d := time.Now().AddDate(0, 0, n).Format("2006-01-02"); return &d }
	h.fake.Add("Pay rent", func(t *fakeserver.Task) { t.Priority, t.Due, t.Tags = "high", day(0), []string{"money"} })
	h.fake.Add("Call mom", func(t *fakeserver.Task) { t.Due = day(-2) })
	h.fake.Add("Renew passport", func(t *fakeserver.Task) { t.Priority, t.Due, t.Project = "high", day(-6), str("Home") })
	h.fake.Add("Order groceries", func(t *fakeserver.Task) { t.Due, t.Tags = day(0), []string{"errands", "money"} })
	h.fake.Add("Archive photos", func(t *fakeserver.Task) { t.Priority, t.Project = "low", str("home") })
	return h
}

// asked is every listing the app was asked for, as path and query.
func asked(h *harness, path string) []string {
	var out []string
	for _, r := range h.fake.Requests() {
		if strings.HasPrefix(r.Path, path) {
			out = append(out, r.Path)
		}
	}
	return out
}

func titles(out string) []string {
	var got []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if fields := strings.Split(line, "\t"); len(fields) == 5 {
			got = append(got, fields[4])
		}
	}
	return got
}

func TestListSortsAndTakesLists(t *testing.T) {
	h := lists(t, false, 7)
	if code := h.run("ls", "--sort", "due,-priority"); code != 0 {
		t.Fatalf("ls --sort: exit %d %q", code, h.err.String())
	}
	if got := strings.Join(titles(h.out.String()), ", "); got != "Renew passport, Call mom, Order groceries, Pay rent, Archive photos" {
		t.Errorf("ls --sort due,-priority: %s", got)
	}
	if q := asked(h, "/api/v1/tasks?"); len(q) != 1 || !strings.Contains(q[0], "sort=due%2C-priority") {
		t.Errorf("the sort goes to the app: %v", q)
	}

	// The usual order needs nothing from the app, so it isn't asked for.
	h.run("ls", "--sort", "default")
	if q := asked(h, "/api/v1/tasks?"); strings.Contains(q[len(q)-1], "sort=") {
		t.Errorf("--sort default sent %s", q[len(q)-1])
	}

	for _, c := range []struct {
		args  []string
		param string
		want  string
	}{
		{[]string{"--project", "home,"}, "project=home%2C", "Renew passport, Pay rent, Call mom, Order groceries, Archive photos"},
		{[]string{"--tag", "money,errands"}, "tag=money%2Cerrands", "Pay rent, Order groceries"},
		{[]string{"--tag", "money,errands", "--tag-mode", "all"}, "tagMode=all", "Order groceries"},
		{[]string{"--due", "before:" + time.Now().Format("2006-01-02")}, "due=before%3A", "Renew passport, Call mom"},
	} {
		if code := h.run(append([]string{"ls"}, c.args...)...); code != 0 {
			t.Fatalf("ls %v: exit %d %q", c.args, code, h.err.String())
		}
		if got := strings.Join(titles(h.out.String()), ", "); got != c.want {
			t.Errorf("ls %v: %s, want %s", c.args, got, c.want)
		}
		if q := asked(h, "/api/v1/tasks?"); !strings.Contains(q[len(q)-1], c.param) {
			t.Errorf("ls %v asked %s", c.args, q[len(q)-1])
		}
	}

	// A key that isn't one is said here, before the app is asked anything.
	before := len(h.fake.Requests())
	if code := h.run("ls", "--sort", "due,dew"); code != ExitUsage || !strings.Contains(h.err.String(), `Unknown sort key "dew"`) || !strings.Contains(h.err.String(), "default, status, priority") {
		t.Errorf("ls --sort due,dew: exit %d %q", code, h.err.String())
	}
	if len(h.fake.Requests()) != before {
		t.Errorf("a bad sort reached the app")
	}
}

func TestListsNeedANewerApp(t *testing.T) {
	// An app from before sorting (revision 6) is told what is needed, never
	// given a sort or a list it would read as one name; the rest works as it did.
	h := lists(t, false, 6)
	for _, c := range []struct {
		args []string
		says string
	}{
		{[]string{"--sort", "due"}, "sorted lists (--sort) need a newer Todos app"},
		{[]string{"--tag", "money,errands"}, "lists of tags (--tag a,b) and --tag-mode need a newer Todos app"},
		{[]string{"--tag", "money", "--tag-mode", "all"}, "--tag-mode need a newer Todos app"},
		{[]string{"--project", "home,work"}, "lists of projects (--project a,b) need a newer Todos app"},
		{[]string{"--due", "tomorrow"}, "--due tomorrow, before: and after: need a newer Todos app"},
		{[]string{"--due", "after:2030-01-01"}, "--due tomorrow, before: and after: need a newer Todos app"},
	} {
		if code := h.run(append([]string{"ls"}, c.args...)...); code != ExitVersion || !strings.Contains(h.err.String(), c.says) || !strings.Contains(h.err.String(), "revision 6") {
			t.Errorf("ls %v against revision 6: exit %d %q", c.args, code, h.err.String())
		}
	}
	if q := asked(h, "/api/v1/tasks"); len(q) != 0 {
		t.Errorf("the old app was asked %v", q)
	}
	for _, args := range [][]string{{"ls"}, {"ls", "--sort", "default"}, {"ls", "--tag", "money", "--project", "home", "--due", "week"}} {
		if code := h.run(args...); code != 0 {
			t.Errorf("%v against revision 6: exit %d %q", args, code, h.err.String())
		}
	}
}

func TestSortInConfig(t *testing.T) {
	h := lists(t, false, 7)
	dir := filepath.Join(h.env["XDG_CONFIG_HOME"], "todos")
	write := func(sort string) {
		b, _ := json.Marshal(map[string]any{"profiles": map[string]any{}, "sort": sort})
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "config.json"), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("-id")
	if code := h.run("ls"); code != 0 || strings.Join(titles(h.out.String()), ", ") != "Archive photos, Order groceries, Renew passport, Call mom, Pay rent" {
		t.Errorf("ls with \"sort\": \"-id\": exit %d %q %q", code, h.out.String(), h.err.String())
	}
	if code := h.run("ls", "--sort", "id"); code != 0 || titles(h.out.String())[0] != "Pay rent" {
		t.Errorf("--sort wins over config.json: %q", h.out.String())
	}

	write("dew")
	if code := h.run("ls"); code != ExitUsage || !strings.Contains(h.err.String(), "config.json") || !strings.Contains(h.err.String(), `Unknown sort key "dew"`) {
		t.Errorf("a bad sort in config.json: exit %d %q", code, h.err.String())
	}

	write("due")
	h.fake.Configure(func(s *fakeserver.Server) { s.Revision = 6 })
	if code := h.run("ls"); code != ExitVersion || !strings.Contains(h.err.String(), `sorted lists ("sort" in config.json) need a newer Todos app`) {
		t.Errorf("config.json's sort against revision 6: exit %d %q", code, h.err.String())
	}
}

func TestToday(t *testing.T) {
	for _, rev := range []int{7, 4} {
		h := lists(t, true, rev)
		if code := h.run("today"); code != 0 {
			t.Fatalf("revision %d: today: exit %d %q", rev, code, h.err.String())
		}
		got := plain(h.out.String())
		overdue, today := strings.Index(got, "Overdue (2)"), strings.Index(got, "Today (2)")
		if overdue < 0 || today < overdue {
			t.Fatalf("revision %d: today printed:\n%s", rev, got)
		}
		// Most important first, then oldest first.
		order := []string{"Renew passport", "Call mom", "Pay rent", "Order groceries"}
		for i := 1; i < len(order); i++ {
			if strings.Index(got, order[i-1]) > strings.Index(got, order[i]) {
				t.Errorf("revision %d: %q should come before %q:\n%s", rev, order[i-1], order[i], got)
			}
		}
		if strings.Contains(got, "Archive photos") {
			t.Errorf("revision %d: a task with no due date is not for today:\n%s", rev, got)
		}

		// --json: the API's answer, or one made in its shape from /due by an older app.
		if code := h.run("today", "--json"); code != 0 {
			t.Fatalf("revision %d: today --json: exit %d", rev, code)
		}
		var answer struct {
			Overdue, Today []struct{ Title string }
			Counts         map[string]int
			Date           string
		}
		if err := json.Unmarshal(h.out.Bytes(), &answer); err != nil {
			t.Fatalf("revision %d: %v\n%s", rev, err, h.out.String())
		}
		if len(answer.Overdue) != 2 || answer.Overdue[0].Title != "Renew passport" || answer.Today[0].Title != "Pay rent" ||
			answer.Counts["total"] != 4 || answer.Date != time.Now().Format("2006-01-02") {
			t.Errorf("revision %d: today --json: %s", rev, h.out.String())
		}
		if rev < 7 && len(asked(h, "/api/v1/today")) > 0 {
			t.Errorf("revision %d was asked for /today", rev)
		}
		if rev >= 7 && len(asked(h, "/api/v1/due")) > 0 {
			t.Errorf("revision %d was asked for /due", rev)
		}
	}
}
