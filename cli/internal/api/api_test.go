package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"todos/internal/api"
	"todos/internal/fakeserver"
)

var ctx = context.Background()

// shortDir: a socket's path must fit in 103 bytes, and t.TempDir() is too deep on macOS.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "tda")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func socketPair(t *testing.T) (*fakeserver.Server, *api.Client) {
	t.Helper()
	f := fakeserver.New()
	path := filepath.Join(shortDir(t), "t.sock")
	if err := f.ServeUnix(path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return f, api.NewSocket(path)
}

func httpsPair(t *testing.T) (*fakeserver.Server, *api.Client) {
	t.Helper()
	f := fakeserver.New()
	url, ca := f.ServeTLS()
	t.Cleanup(f.Close)
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, ca, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := api.NewRemote(url, f.Token(), caFile)
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

func TestSocketNeedsNoTokenAndHTTPSSendsIt(t *testing.T) {
	f, c := socketPair(t)
	c.Token = "must-never-be-sent-on-the-socket"
	info, err := c.Info(ctx)
	if err != nil || info.Status != "ok" || info.APIVersion.Revision != 4 || info.MinClientVersions["cli"] == "" {
		t.Fatalf("Info over the socket: %+v, %v", info, err)
	}
	if _, err := c.Capture(ctx, "Over the socket"); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.Requests() {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("%s %s carried a token on the socket", r.Method, r.Path)
		}
	}

	f, c = httpsPair(t)
	c.Label, c.UserAgent = "todos on box", "todos-cli/9.9"
	if _, err := c.Capture(ctx, "Over HTTPS"); err != nil {
		t.Fatal(err)
	}
	last := f.Requests()[len(f.Requests())-1]
	if last.Header.Get("Authorization") != "Bearer "+f.Token() || last.Header.Get("X-Todos-Client") != "todos on box" || last.Header.Get("User-Agent") != "todos-cli/9.9" {
		t.Errorf("headers: %v", last.Header)
	}
	if key := last.Header.Get("Idempotency-Key"); len(key) < 8 {
		t.Errorf("a change carries an Idempotency-Key, got %q", key)
	}
	// The health check needs no token.
	c.Token = ""
	if _, err := c.Health(ctx); err != nil {
		t.Errorf("Health without a token: %v", err)
	}
	if _, err := c.Info(ctx); !api.IsStatus(err, 401) {
		t.Errorf("Info without a token: %v", err)
	}
}

func TestCleanURL(t *testing.T) {
	for in, want := range map[string]string{
		"my-mac.tail1234.ts.net":             "https://my-mac.tail1234.ts.net",
		"https://My-Mac.Tail1234.ts.net/":    "https://my-mac.tail1234.ts.net",
		"https://my-mac.ts.net:8443/api/v1/": "https://my-mac.ts.net:8443",
		" https://my-mac.ts.net ":            "https://my-mac.ts.net",
		"http://127.0.0.1:7442":              "http://127.0.0.1:7442",
		"http://localhost:7442/":             "http://localhost:7442",
	} {
		if got, err := api.CleanURL(in); err != nil || got != want {
			t.Errorf("CleanURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "http://my-mac.ts.net", "ftp://my-mac.ts.net", "https://user:pw@my-mac.ts.net", "https://", "http://192.168.1.5:7420"} {
		if got, err := api.CleanURL(bad); err == nil {
			t.Errorf("CleanURL(%q) = %q, want an error", bad, got)
		}
	}
}

func TestWhatWentWrong(t *testing.T) {
	kind := func(err error) api.ConnKind {
		var c *api.ConnError
		if errors.As(err, &c) {
			return c.Kind
		}
		return 0
	}

	// No socket file: the app is not running.
	_, err := api.NewSocket(filepath.Join(shortDir(t), "none.sock")).Health(ctx)
	if kind(err) != api.NotRunning {
		t.Errorf("no socket: %v", err)
	}
	// A socket file nobody listens on (the app crashed): the same.
	stale := filepath.Join(shortDir(t), "stale.sock")
	l, _ := net.Listen("unix", stale)
	l.(*net.UnixListener).SetUnlinkOnClose(false)
	l.Close()
	if _, err = api.NewSocket(stale).Health(ctx); kind(err) != api.NotRunning {
		t.Errorf("stale socket: %v", err)
	}
	// Something there that is not a socket.
	file := filepath.Join(shortDir(t), "file")
	os.WriteFile(file, nil, 0o600) //nolint:errcheck
	if _, err = api.NewSocket(file).Health(ctx); kind(err) != api.NotRunning {
		t.Errorf("not a socket: %v", err)
	}

	answering := func(status int, body string) *api.Client {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			fmt.Fprint(w, body)
		}))
		t.Cleanup(srv.Close)
		c, _ := api.NewRemote(srv.URL, "t", "")
		// Trust the test server's certificate.
		return api.WithHTTPClient(c, srv.Client())
	}
	// `tailscale serve` answering for an app that is not running.
	if _, err = answering(502, "").Info(ctx); kind(err) != api.AppDown {
		t.Errorf("502 from a proxy: %v", err)
	}
	// The app's answer to relayed requests while Remote Access is off.
	if _, err = answering(403, `{"error":"Forbidden host"}`).Info(ctx); kind(err) != api.RemoteOff {
		t.Errorf("403 Forbidden host: %v", err)
	}
	// Some other web server.
	if _, err = answering(404, "<html>nginx</html>").Health(ctx); kind(err) != api.RemoteOff {
		t.Errorf("404 from something that is not Todos: %v", err)
	}
	// The app's own refusals stay what they are.
	_, err = answering(401, `{"error":{"code":"unauthorized","message":"That access token is not valid."}}`).Info(ctx)
	var refused *api.Error
	if !errors.As(err, &refused) || refused.Code != "unauthorized" || kind(err) != 0 {
		t.Errorf("401: %v", err)
	}
	_, err = answering(429, `{"error":{"code":"rate_limited","message":"Slow down."}}`).Info(ctx)
	if !errors.As(err, &refused) || refused.Status != 429 {
		t.Errorf("429: %v", err)
	}

	// A certificate nobody vouches for.
	f := fakeserver.New()
	url, _ := f.ServeTLS()
	t.Cleanup(f.Close)
	c, _ := api.NewRemote(url, f.Token(), "")
	if _, err = c.Health(ctx); kind(err) != api.Refused || !strings.Contains(err.Error(), "can't trust") {
		t.Errorf("untrusted certificate: %v", err)
	}
	// Nothing listening.
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := closed.Addr().String()
	closed.Close()
	c, _ = api.NewRemote("https://"+addr, "t", "")
	if _, err = c.Health(ctx); kind(err) != api.RemoteOff {
		t.Errorf("connection refused: %v", err)
	}
	// A tailnet name that does not resolve.
	c, _ = api.NewRemote("https://no-such-mac.example.ts.net", "t", "")
	if _, err = c.Health(ctx); kind(err) != api.TailscaleDown {
		t.Errorf("unresolvable .ts.net name: %v", err)
	}
}

func TestALostAnswerIsNotAppliedTwice(t *testing.T) {
	for name, pair := range map[string]func(*testing.T) (*fakeserver.Server, *api.Client){"socket": socketPair, "https": httpsPair} {
		t.Run(name, func(t *testing.T) {
			f, c := pair(t)
			// The server adds the task, then the connection drops before the answer.
			f.CutNext(1)
			res, err := c.Capture(ctx, "Added once")
			if err != nil {
				t.Fatalf("the change should be sent again: %v", err)
			}
			if n := len(f.Tasks()); n != 1 || res.Task.Title != "Added once" {
				t.Fatalf("%d tasks after a retried add, want 1", n)
			}

			f.CutNext(2)
			if _, err := c.Comment(ctx, res.Task.ID, "Said once"); err != nil {
				t.Fatal(err)
			}
			task, _ := f.Task(res.Task.ID)
			comments := 0
			for _, a := range task.Activity {
				if a.Kind == "comment" {
					comments++
				}
			}
			if comments != 1 {
				t.Errorf("%d comments after a twice-retried comment, want 1", comments)
			}

			// A delete that went through, whose answer was lost: the retry finds nothing, which is success.
			f.CutNext(1)
			if err := c.Delete(ctx, res.Task.ID, api.AnyRev); err != nil {
				t.Errorf("delete: %v", err)
			}
			// After three lost answers in a row it gives up and says so.
			f.CutNext(5)
			if _, err := c.Capture(ctx, "Never confirmed"); !api.IsConn(err, api.Interrupted) {
				t.Errorf("want an Interrupted error, got %v", err)
			}
			f.CutNext(0)
		})
	}
}

func TestRevisionsAndConflicts(t *testing.T) {
	f, c := socketPair(t)
	task := f.Add("Shared")
	f.Touch(task.ID, "claude", "moved todo → in_progress", func(t *fakeserver.Task) { t.Status = "in_progress" })

	_, err := c.Patch(ctx, task.ID, map[string]any{"title": "Mine"}, task.Rev)
	var refused *api.Error
	if !errors.As(err, &refused) || refused.Status != 409 || refused.Current == nil || refused.Current.Status != "in_progress" || refused.Current.Rev != task.Rev+1 {
		t.Fatalf("a stale revision: %v (%+v)", err, refused)
	}
	if got, _ := f.Task(task.ID); got.Title != "Shared" {
		t.Errorf("the task was overwritten")
	}
	res, err := c.Patch(ctx, task.ID, map[string]any{"title": "Mine"}, refused.Current.Rev)
	if err != nil || res.Task.Title != "Mine" {
		t.Fatalf("the current revision: %v", err)
	}
	if _, err := c.Patch(ctx, task.ID, map[string]any{"title": "Forced"}, api.AnyRev); err != nil {
		t.Errorf("AnyRev: %v", err)
	}
	if err := c.Delete(ctx, task.ID, 1); !api.IsStatus(err, 409) {
		t.Errorf("delete at a stale revision: %v", err)
	}
}

func TestTasksKeepWhatTheServerSent(t *testing.T) {
	// A field this client has never heard of survives being read and written back out.
	raw := `{"id":7,"title":"T","due":null,"tags":["a"],"rev":3,"somethingNew":{"x":[1,2]}}`
	var task api.Task
	if err := json.Unmarshal([]byte(raw), &task); err != nil {
		t.Fatal(err)
	}
	if task.ID != 7 || task.Due != "" || task.Rev != 3 {
		t.Errorf("decoded: %+v", task)
	}
	out, _ := json.Marshal(map[string]any{"task": task})
	if string(out) != `{"task":`+raw+`}` {
		t.Errorf("re-encoded as %s", out)
	}
	if string(task.Field("somethingNew")) != `{"x":[1,2]}` || task.Field("nope") != nil {
		t.Errorf("Field: %s", task.Field("somethingNew"))
	}
}

func TestListAllPages(t *testing.T) {
	f, c := socketPair(t)
	for i := 0; i < 1203; i++ {
		f.Add(fmt.Sprintf("Task %04d", i))
	}
	all, err := c.ListAll(ctx, api.ListOptions{})
	if err != nil || len(all.Tasks) != 1203 || all.Total != 1203 {
		t.Fatalf("ListAll: %d of %d, %v", len(all.Tasks), all.Total, err)
	}
	seen := map[int]bool{}
	for _, task := range all.Tasks {
		seen[task.ID] = true
	}
	if len(seen) != 1203 {
		t.Errorf("%d distinct tasks", len(seen))
	}
	for _, limit := range []int{1, 499, 500, 501, 1000, 2000} {
		got, err := c.ListAll(ctx, api.ListOptions{Limit: limit})
		if want := min(limit, 1203); err != nil || len(got.Tasks) != want {
			t.Errorf("limit %d: %d tasks, %v", limit, len(got.Tasks), err)
		}
	}
	none := ""
	if got, _ := c.ListAll(ctx, api.ListOptions{Project: &none, Query: "0007"}); len(got.Tasks) != 1 {
		t.Errorf("filters are passed on: %d", len(got.Tasks))
	}
}

func TestVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"0.1.0", "0.1.0", 0}, {"0.1.0", "0.2", -1}, {"1.0", "0.9.9", 1}, {"0.10.0", "0.9.0", 1}, {"v1.2.3", "1.2.3", 0}, {"0.1.0-dev", "0.1.0", 0}, {"1", "1.0.0", 0}, {"1.0.1", "1", 1}} {
		if got := api.CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	info := &api.Info{APIVersion: api.APIVersion{Version: 1, Revision: 4}, MinClientVersions: map[string]string{"cli": "0.1.0", "ios": "9.0"}}
	if err := api.CheckVersions(info, "0.1.0"); err != nil {
		t.Errorf("0.1.0 against a minimum of 0.1.0: %v", err)
	}
	var v *api.VersionError
	if err := api.CheckVersions(info, "0.0.9"); !errors.As(err, &v) || v.AppTooOld || !strings.Contains(err.Error(), "0.1.0 or later") {
		t.Errorf("an old client: %v", err)
	}
	info.APIVersion.Revision = 3
	if err := api.CheckVersions(info, "0.1.0"); !errors.As(err, &v) || !v.AppTooOld {
		t.Errorf("an old app: %v", err)
	}
	// A client kind the app has no minimum for.
	info = &api.Info{APIVersion: api.APIVersion{Version: 1, Revision: 5}, MinClientVersions: map[string]string{"ios": "1.0"}}
	if err := api.CheckVersions(info, "0.0.1"); err != nil {
		t.Errorf("no minimum for cli: %v", err)
	}
}

func TestLiveUpdates(t *testing.T) {
	for name, pair := range map[string]func(*testing.T) (*fakeserver.Server, *api.Client){"socket": socketPair, "https": httpsPair} {
		t.Run(name, func(t *testing.T) {
			f, c := pair(t)
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			var mu sync.Mutex
			var events []api.Event
			var states []api.FollowState
			done := make(chan error, 1)
			go func() {
				done <- c.Follow(ctx, func(e api.Event) {
					mu.Lock()
					events = append(events, e)
					mu.Unlock()
				}, func(s api.FollowState) {
					mu.Lock()
					states = append(states, s)
					mu.Unlock()
				})
			}()
			count := func(kind string) int {
				mu.Lock()
				defer mu.Unlock()
				n := 0
				for _, e := range events {
					if e.Type == kind {
						n++
					}
				}
				return n
			}
			wait := func(what string, cond func() bool) {
				t.Helper()
				for i := 0; i < 400; i++ {
					if cond() {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("timed out waiting for %s", what)
			}

			wait("hello", func() bool { return count("hello") == 1 })
			f.Add("One")
			f.Add("Two")
			wait("two changes", func() bool { return count("change") == 2 })
			mu.Lock()
			if last := events[len(events)-1]; last.Version != f.Version() {
				t.Errorf("the change carries version %d, the list is at %d", last.Version, f.Version())
			}
			mu.Unlock()

			// The stream drops: it is opened again, and says hello again with the version now.
			f.DropStreams()
			f.Add("Three, while nobody was listening")
			wait("a second hello", func() bool { return count("hello") == 2 })
			mu.Lock()
			var hello api.Event
			for _, e := range events {
				if e.Type == "hello" {
					hello = e
				}
			}
			sawDrop := false
			for _, s := range states {
				sawDrop = sawDrop || (!s.Connected && s.Err != nil)
			}
			mu.Unlock()
			if hello.Version != f.Version() || !sawDrop {
				t.Errorf("after reconnecting: hello at %d (list at %d), drop reported: %v", hello.Version, f.Version(), sawDrop)
			}

			cancel()
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Errorf("Follow ended with %v", err)
			}
		})
	}
}

func TestLiveUpdatesStopOnARejectedToken(t *testing.T) {
	f, c := httpsPair(t)
	f.RotateToken("another-token-0123456789abcdef0123456789abcdef")
	done := make(chan error, 1)
	go func() { done <- c.Follow(ctx, func(api.Event) {}, nil) }()
	select {
	case err := <-done:
		if !api.IsStatus(err, 401) {
			t.Errorf("Follow ended with %v, want the 401", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Follow kept going with a rejected token")
	}
	if n := len(f.Requests()); n != 1 {
		t.Errorf("%d requests were made with the rejected token, want 1", n)
	}
}

func TestAQuietStreamIsTakenForDead(t *testing.T) {
	// A connection that stays open but carries nothing (a Mac that went to sleep
	// without closing it) is given up on once the keep-alives stop.
	restore := api.SetStreamIdle(300 * time.Millisecond)
	defer restore()
	f, c := socketPair(t)
	f.Configure(func(f *fakeserver.Server) { f.Ping = time.Hour }) // no keep-alives
	began := time.Now()
	err := c.Events(ctx, func(api.Event) error { return nil })
	if !api.IsConn(err, api.Interrupted) || !strings.Contains(err.Error(), "quiet") {
		t.Errorf("Events ended with %v", err)
	}
	if took := time.Since(began); took < 250*time.Millisecond || took > 3*time.Second {
		t.Errorf("gave up after %s", took)
	}

	// With keep-alives arriving it stays up.
	f.Configure(func(f *fakeserver.Server) { f.Ping = 50 * time.Millisecond })
	ctx2, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := c.Events(ctx2, func(api.Event) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("with keep-alives, Events ended early with %v", err)
	}
}
