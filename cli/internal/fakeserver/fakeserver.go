// Package fakeserver is a stand-in for the Todos app's server, for tests. It
// keeps a list in memory and serves the parts of /api/v1 the command-line
// client uses, the way the app does: on a Unix socket with no sign-in (where the
// local-only routes exist), and on a port where every request needs the token.
//
// It also misbehaves on request, which the real server won't: answers can be
// replaced, connections cut, and live streams dropped. The same tests run
// against the real server (see internal/integration) to keep this one honest.
package fakeserver

import (
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Subtask struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

type Activity struct {
	At   string `json:"at"`
	By   string `json:"by"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	Via  string `json:"via,omitempty"`
	Key  string `json:"key,omitempty"`
}

// Task has the fields the app's tasks have, with null where the app has null.
type Task struct {
	ID          int        `json:"id"`
	Title       string     `json:"title"`
	Notes       string     `json:"notes"`
	Status      string     `json:"status"`
	Priority    string     `json:"priority"`
	Due         *string    `json:"due"`
	Project     *string    `json:"project"`
	Tags        []string   `json:"tags"`
	Assignee    string     `json:"assignee"`
	Subtasks    []Subtask  `json:"subtasks"`
	Repeat      *string    `json:"repeat"`
	RemindAt    *string    `json:"remindAt"`
	RemindedAt  *string    `json:"remindedAt"`
	Rev         int        `json:"rev"`
	CreatedBy   string     `json:"createdBy"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
	CompletedAt *string    `json:"completedAt"`
	Activity    []Activity `json:"activity"`
}

// Request is one request the server received, kept for tests to look at.
type Request struct {
	Local  bool
	Method string
	Path   string
	Header http.Header
	Body   string
}

type failure struct {
	method, prefix string
	status         int
	body           string
}

// Server is the fake. Make one with New.
type Server struct {
	mu       sync.Mutex
	tasks    []*Task
	nextID   int
	version  int
	token    string
	streams  map[chan string]bool
	requests []Request
	failures []failure
	cuts     int
	badAuth  int
	folders  map[string]string // project -> folder remembered for Start with Claude
	closers  []func()

	// Habits (see habits.go). Served from Revision 5 on.
	habits        []*Habit
	checkins      []*Checkin
	nextHabit     int
	nextCheckin   int
	habitsVersion int

	AppVersion string
	Revision   int
	MinCLI     string
	Claude     string        // where `claude` is "found"; empty for nowhere
	Ping       time.Duration // keep-alive interval on live streams
	Now        func() time.Time
	// AuthLimit is how many wrong tokens are answered 401 before 429 sets in.
	AuthLimit int
	// Hook, if set, is called with each request before it is served. A test
	// uses it to make something happen between two of the client's requests.
	Hook func(r Request)
}

func New() *Server {
	return &Server{
		nextID:     1,
		token:      "fake-token-0123456789abcdef0123456789abcdef",
		streams:    map[chan string]bool{},
		folders:    map[string]string{},
		AppVersion: "1.6.1",
		Revision:   4,
		MinCLI:     "0.1.0",
		Claude:     "/usr/local/bin/claude",
		Ping:       25 * time.Second,
		Now:        time.Now,
		AuthLimit:  10,
	}
}

// ---------- listening ----------

// ServeUnix listens on a Unix socket at path, as the app does: mode 0600.
func (s *Server) ServeUnix(path string) error {
	old := syscall.Umask(0o177)
	l, err := net.Listen("unix", path)
	syscall.Umask(old)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: s.Handler(true)}
	go srv.Serve(l) //nolint:errcheck
	s.onClose(func() {
		srv.Close()
		os.Remove(path)
	})
	return nil
}

// ServeTCP listens on a free local port and returns its address.
func (s *Server) ServeTCP() string {
	srv := httptest.NewServer(s.Handler(false))
	s.onClose(srv.Close)
	return srv.URL
}

// ServeTCPAt listens on a given local address (127.0.0.1:port).
func (s *Server) ServeTCPAt(addr string) error {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: s.Handler(false)}
	go srv.Serve(l) //nolint:errcheck
	s.onClose(func() { srv.Close() })
	return nil
}

// ServeTLS listens with a certificate of its own, and returns the address and
// the certificate (PEM) a client must trust to connect.
func (s *Server) ServeTLS() (string, []byte) {
	srv := httptest.NewTLSServer(s.Handler(false))
	s.onClose(srv.Close)
	return srv.URL, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
}

func (s *Server) onClose(fn func()) {
	s.mu.Lock()
	s.closers = append(s.closers, fn)
	s.mu.Unlock()
}

// Close stops every listener and ends every live stream.
func (s *Server) Close() {
	s.DropStreams()
	s.mu.Lock()
	closers := s.closers
	s.closers = nil
	s.mu.Unlock()
	for _, fn := range closers {
		fn()
	}
}

// ---------- knobs for tests ----------

// Configure changes the server's settings (its exported fields) while it is
// running, safely with respect to requests being served.
func (s *Server) Configure(fn func(*Server)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s)
}

func (s *Server) Token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// RotateToken replaces the access token, as Todos → Remote Access → Rotate
// does: every client with the old one is refused, and live streams end.
func (s *Server) RotateToken(token string) {
	s.mu.Lock()
	s.token = token
	s.mu.Unlock()
	s.DropStreams()
}

// DropStreams ends every open live-update stream.
func (s *Server) DropStreams() {
	s.mu.Lock()
	for ch := range s.streams {
		close(ch)
		delete(s.streams, ch)
	}
	s.mu.Unlock()
}

// Streams is how many live-update streams are open.
func (s *Server) Streams() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)
}

// FailNext makes the next request with this method whose path starts with
// prefix get this answer instead of being served. An empty method matches any.
func (s *Server) FailNext(method, prefix string, status int, body string) {
	s.mu.Lock()
	s.failures = append(s.failures, failure{method, prefix, status, body})
	s.mu.Unlock()
}

// CutNext makes the next n changes take effect and then lose their answer: the
// connection is closed without a response, as when a network drops.
func (s *Server) CutNext(n int) {
	s.mu.Lock()
	s.cuts = n
	s.mu.Unlock()
}

// Requests returns what has been received so far.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// Add puts a task in the list, as if another client had created it.
func (s *Server) Add(title string, edit ...func(*Task)) Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.create(title, "me", "", "")
	for _, fn := range edit {
		fn(t)
	}
	if t.Status == "done" && t.CompletedAt == nil {
		t.CompletedAt = &t.UpdatedAt
	}
	s.changed()
	return *t
}

// Touch changes a task as another client would: its revision goes up and live
// streams hear about it.
func (s *Server) Touch(id int, by string, text string, edit func(*Task)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.find(id)
	if t == nil {
		panic(fmt.Sprintf("no task %d", id))
	}
	edit(t)
	s.bump(t, by, "event", text, "", "")
	s.changed()
}

// Remove deletes a task as another client would.
func (s *Server) Remove(id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remove(id)
	s.changed()
}

// Task returns a copy of a task, and whether it exists.
func (s *Server) Task(id int) (Task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.find(id)
	if t == nil {
		return Task{}, false
	}
	return *t, true
}

// Tasks returns a copy of the whole list.
func (s *Server) Tasks() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Task, len(s.tasks))
	for i, t := range s.tasks {
		out[i] = *t
	}
	return out
}

// Version is the list's version, which goes up with every change.
func (s *Server) Version() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.version
}

// ---------- the list (callers hold s.mu) ----------

func (s *Server) stamp() string { return s.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func (s *Server) today() string { return s.Now().Format("2006-01-02") }

func (s *Server) find(id int) *Task {
	for _, t := range s.tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (s *Server) remove(id int) {
	for i, t := range s.tasks {
		if t.ID == id {
			s.tasks = append(s.tasks[:i], s.tasks[i+1:]...)
			return
		}
	}
}

func (s *Server) create(title, by, via, key string) *Task {
	ts := s.stamp()
	t := &Task{
		ID: s.nextID, Title: title, Status: "todo", Priority: "medium", Tags: []string{}, Assignee: "me", Subtasks: []Subtask{},
		Rev: 1, CreatedBy: by, CreatedAt: ts, UpdatedAt: ts,
		Activity: []Activity{{At: ts, By: by, Kind: "event", Text: "created this task", Via: via, Key: key}},
	}
	s.nextID++
	s.tasks = append(s.tasks, t)
	return t
}

// bump records a change to t.
func (s *Server) bump(t *Task, by, kind, text, via, key string) {
	ts := s.stamp()
	t.Activity = append(t.Activity, Activity{At: ts, By: by, Kind: kind, Text: text, Via: via, Key: key})
	t.UpdatedAt = ts
	t.Rev++
}

// changed raises the list's version and tells every live stream.
func (s *Server) changed() {
	s.version++
	msg := fmt.Sprintf("event: change\ndata: {\"version\":%d}\n\n", s.version)
	for ch := range s.streams {
		select {
		case ch <- msg:
		default: // a stream that isn't keeping up misses one; the next change says the same
		}
	}
}

var (
	statusOrder   = map[string]int{"in_progress": 0, "blocked": 1, "todo": 2, "done": 3}
	priorityOrder = map[string]int{"high": 0, "medium": 1, "low": 2}
)

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// sorted orders tasks as the app does: by status, then priority, then due date.
func sorted(list []*Task) []*Task {
	out := append([]*Task(nil), list...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Status != b.Status {
			return statusOrder[a.Status] < statusOrder[b.Status]
		}
		if a.Status == "done" {
			return deref(a.CompletedAt) > deref(b.CompletedAt)
		}
		if a.Priority != b.Priority {
			return priorityOrder[a.Priority] < priorityOrder[b.Priority]
		}
		if deref(a.Due) != deref(b.Due) {
			if a.Due == nil {
				return false
			}
			if b.Due == nil {
				return true
			}
			return *a.Due < *b.Due
		}
		return a.ID < b.ID
	})
	return out
}

// brief is a task as lists show it: no activity, and a count of comments.
func brief(t *Task) map[string]any {
	b, _ := json.Marshal(t)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	delete(m, "activity")
	n := 0
	for _, a := range t.Activity {
		if a.Kind == "comment" {
			n++
		}
	}
	m["comments"] = n
	return m
}

func briefs(list []*Task) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, t := range list {
		out = append(out, brief(t))
	}
	return out
}

func (s *Server) counts() map[string]int {
	t0 := s.today()
	weekAgo := s.Now().Add(-7 * 24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	c := map[string]int{"open": 0, "in_progress": 0, "blocked": 0, "overdue": 0, "due_today": 0, "claude": 0, "done_7d": 0}
	for _, t := range s.tasks {
		if t.Status == "done" {
			if deref(t.CompletedAt) >= weekAgo {
				c["done_7d"]++
			}
			continue
		}
		c["open"]++
		if t.Status == "in_progress" || t.Status == "blocked" {
			c[t.Status]++
		}
		if t.Due != nil && *t.Due < t0 {
			c["overdue"]++
		}
		if t.Due != nil && *t.Due == t0 {
			c["due_today"]++
		}
		if t.Assignee == "claude" {
			c["claude"]++
		}
	}
	return c
}

// ---------- reading what clients send ----------

type refusal struct {
	status  int
	code    string
	message string
	extra   map[string]any
}

func (r *refusal) Error() string { return r.message }

func refuse(status int, code, format string, args ...any) *refusal {
	return &refusal{status: status, code: code, message: fmt.Sprintf(format, args...)}
}

var weekdays = []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}

// parseDue reads the dates the tests use: a date, today, tomorrow, yesterday,
// +3d, +2w, a weekday, or none. The app reads more.
func (s *Server) parseDue(v any) (*string, error) {
	if v == nil {
		return nil, nil
	}
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(v)))
	day := func(n int) (*string, error) {
		d := s.Now().AddDate(0, 0, n).Format("2006-01-02")
		return &d, nil
	}
	switch text {
	case "", "none", "null":
		return nil, nil
	case "today":
		return day(0)
	case "tomorrow", "tmrw", "tmr":
		return day(1)
	case "yesterday":
		return day(-1)
	case "next week":
		return day(7)
	}
	if m := regexp.MustCompile(`^\+(\d+)([dw])$`).FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		if m[2] == "w" {
			n *= 7
		}
		return day(n)
	}
	if len(text) >= 3 {
		for i, name := range weekdays {
			if strings.HasPrefix(name, text) {
				diff := (i - int(s.Now().Weekday()) + 7) % 7
				if diff == 0 {
					diff = 7
				}
				return day(diff)
			}
		}
	}
	if _, err := time.Parse("2006-01-02", text); err == nil {
		return &text, nil
	}
	return nil, refuse(400, "invalid", `Unrecognized due date "%v". Use YYYY-MM-DD, today, tomorrow, +3d, a weekday name, or a date like "oct 20".`, v)
}

func oneOf(field string, v any, allowed ...string) (string, error) {
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(v)))
	for _, a := range allowed {
		if a == text {
			return a, nil
		}
	}
	return "", refuse(400, "invalid", `Invalid %s "%v". Expected one of: %s`, field, v, strings.Join(allowed, ", "))
}

var editable = []string{"title", "notes", "status", "priority", "due", "project", "tags", "assignee", "repeat", "remindAt"}

func only(body map[string]any, allowed ...string) error {
	var unknown []string
	for k := range body {
		ok := false
		for _, a := range allowed {
			ok = ok || a == k
		}
		if !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return refuse(400, "unknown_field", "Unknown field: %s. Allowed: %s.", strings.Join(unknown, ", "), strings.Join(allowed, ", "))
	}
	return nil
}

// apply sets the editable fields in body on t, and returns what changed.
func (s *Server) apply(t *Task, body map[string]any) ([]string, error) {
	var changes []string
	str := func(v any) string {
		if v == nil {
			return ""
		}
		return strings.TrimSpace(fmt.Sprint(v))
	}
	optional := func(v string) *string {
		if v == "" {
			return nil
		}
		return &v
	}
	for _, key := range editable {
		v, ok := body[key]
		if !ok {
			continue
		}
		switch key {
		case "title":
			title := str(v)
			if title == "" {
				return nil, refuse(400, "invalid", "Title cannot be empty")
			}
			if title != t.Title {
				t.Title = title
				changes = append(changes, fmt.Sprintf("renamed to %q", title))
			}
		case "notes":
			if str(v) != t.Notes {
				t.Notes = str(v)
				changes = append(changes, "edited notes")
			}
		case "status":
			status, err := oneOf("status", v, "todo", "in_progress", "blocked", "done")
			if err != nil {
				return nil, err
			}
			if status != t.Status {
				changes = append(changes, fmt.Sprintf("moved %s → %s", t.Status, status))
				t.Status = status
				t.CompletedAt = nil
				if status == "done" {
					ts := s.stamp()
					t.CompletedAt = &ts
				}
			}
		case "priority":
			priority, err := oneOf("priority", v, "high", "medium", "low")
			if err != nil {
				return nil, err
			}
			if priority != t.Priority {
				t.Priority = priority
				changes = append(changes, "set priority to "+priority)
			}
		case "assignee":
			assignee, err := oneOf("assignee", v, "me", "claude")
			if err != nil {
				return nil, err
			}
			if assignee != t.Assignee {
				t.Assignee = assignee
				changes = append(changes, "assigned to "+assignee)
			}
		case "due":
			due, err := s.parseDue(v)
			if err != nil {
				return nil, err
			}
			if deref(due) != deref(t.Due) {
				t.Due = due
				changes = append(changes, "set due to "+deref(due))
			}
		case "project":
			if str(v) != deref(t.Project) {
				t.Project = optional(str(v))
				changes = append(changes, "set project to "+str(v))
			}
		case "repeat":
			repeat := strings.ToLower(str(v))
			if repeat == "none" || repeat == "never" {
				repeat = ""
			}
			if repeat != "" {
				var err error
				if repeat, err = oneOf("repeat", repeat, "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"); err != nil {
					return nil, err
				}
			}
			if repeat != deref(t.Repeat) {
				t.Repeat = optional(repeat)
				changes = append(changes, "set to repeat "+repeat)
			}
		case "remindAt":
			remind := str(v)
			if remind == "none" {
				remind = ""
			}
			if remind != "" {
				at, err := time.Parse(time.RFC3339, remind)
				if err != nil {
					if at, err = time.ParseInLocation("2006-01-02 15:04", remind, time.Local); err != nil {
						return nil, refuse(400, "invalid", `Unrecognized reminder time "%v". Use "YYYY-MM-DD HH:MM", "tomorrow 9am", "fri 14:30", or "+2h".`, v)
					}
				}
				remind = at.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			if remind != deref(t.RemindAt) {
				t.RemindAt = optional(remind)
				t.RemindedAt = nil
				changes = append(changes, "set a reminder")
			}
		case "tags":
			var tags []string
			switch list := v.(type) {
			case []any:
				for _, x := range list {
					tags = append(tags, fmt.Sprint(x))
				}
			case []string:
				tags = list
			case string:
				tags = strings.Split(list, ",")
			}
			clean := []string{}
			seen := map[string]bool{}
			for _, tag := range tags {
				tag = strings.ToLower(strings.TrimLeft(strings.TrimSpace(tag), "#@"))
				if tag != "" && !seen[tag] {
					seen[tag] = true
					clean = append(clean, tag)
				}
			}
			if strings.Join(clean, ",") != strings.Join(t.Tags, ",") {
				t.Tags = clean
				changes = append(changes, "set tags")
			}
		}
	}
	return changes, nil
}

var (
	priorityWords = map[string]string{"high": "high", "hi": "high", "h": "high", "1": "high", "medium": "medium", "med": "medium", "m": "medium", "2": "medium", "low": "low", "lo": "low", "l": "low", "3": "low"}
	nameRE        = regexp.MustCompile(`^[\w-]+$`)
)

// parseLine reads a one-line entry: !priority, #project, @tag (or @claude, @me)
// and a date word, at either end of the line. The app's parser reads more
// (times, repeats, dates mid-line); this is enough to stand in for it.
func (s *Server) parseLine(line string) (string, map[string]any) {
	words := strings.Fields(line)
	fields := map[string]any{}
	var tags []string
	marker := func(w string) bool {
		if len(w) < 2 {
			return s.dateWord(w, fields)
		}
		name := w[1:]
		switch {
		case w[0] == '!' && priorityWords[strings.ToLower(name)] != "":
			fields["priority"] = priorityWords[strings.ToLower(name)]
		case w[0] == '#' && nameRE.MatchString(name) && !regexp.MustCompile(`^\d+$`).MatchString(name):
			fields["project"] = name
		case w[0] == '@' && nameRE.MatchString(name):
			if who := strings.ToLower(name); who == "claude" || who == "me" {
				fields["assignee"] = who
			} else {
				tags = append(tags, who)
			}
		default:
			return s.dateWord(w, fields)
		}
		return true
	}
	for len(words) > 0 && marker(words[len(words)-1]) {
		words = words[:len(words)-1]
	}
	for len(words) > 0 && marker(words[0]) {
		words = words[1:]
	}
	if len(tags) > 0 {
		for i, j := 0, len(tags)-1; i < j; i, j = i+1, j-1 {
			tags[i], tags[j] = tags[j], tags[i]
		}
		fields["tags"] = tags
	}
	return strings.Join(words, " "), fields
}

func (s *Server) dateWord(w string, fields map[string]any) bool {
	lower := strings.ToLower(w)
	isDay := lower == "today" || lower == "tomorrow" || regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(lower) ||
		regexp.MustCompile(`^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$`).MatchString(lower)
	if !isDay {
		return false
	}
	due, err := s.parseDue(lower)
	if err != nil || due == nil {
		return false
	}
	fields["due"] = *due
	return true
}

// nextDue is when a repeating task comes round again.
func (s *Server) nextDue(from *string, repeat string) string {
	d := s.Now()
	if from != nil {
		if parsed, err := time.ParseInLocation("2006-01-02", *from, time.Local); err == nil {
			d = parsed
		}
	}
	today := s.today()
	for {
		switch repeat {
		case "daily":
			d = d.AddDate(0, 0, 1)
		case "weekdays":
			d = d.AddDate(0, 0, 1)
			for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
				d = d.AddDate(0, 0, 1)
			}
		case "biweekly":
			d = d.AddDate(0, 0, 14)
		case "monthly":
			d = d.AddDate(0, 1, 0)
		case "yearly":
			d = d.AddDate(1, 0, 0)
		default:
			d = d.AddDate(0, 0, 7)
		}
		if d.Format("2006-01-02") > today {
			return d.Format("2006-01-02")
		}
	}
}

// ---------- HTTP ----------

var proxyHeaders = []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-Funnel-Request"}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string, extra map[string]any) {
	e := map[string]any{"code": code, "message": message}
	for k, v := range extra {
		e[k] = v
	}
	writeJSON(w, status, map[string]any{"error": e})
}

func (s *Server) health() map[string]any {
	return map[string]any{"status": "ok", "appVersion": s.AppVersion, "apiVersion": map[string]int{"version": 1, "revision": s.Revision}}
}

// Handler serves the socket (local) or the port.
func (s *Server) Handler(local bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		received := Request{Local: local, Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: string(raw)}
		s.mu.Lock()
		hook := s.Hook
		s.mu.Unlock()
		if hook != nil {
			hook(received)
		}
		s.mu.Lock()
		s.requests = append(s.requests, received)
		var failed *failure
		for i, f := range s.failures {
			if (f.method == "" || f.method == r.Method) && strings.HasPrefix(r.URL.Path, f.prefix) {
				failed = &f
				s.failures = append(s.failures[:i], s.failures[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
		if failed != nil {
			if strings.HasPrefix(failed.body, "{") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
			}
			w.WriteHeader(failed.status)
			io.WriteString(w, failed.body) //nolint:errcheck
			return
		}

		path := r.URL.Path
		if local {
			for _, h := range proxyHeaders {
				if r.Header.Get(h) != "" {
					writeError(w, 403, "forbidden", "Relayed requests are not answered on the local socket.", nil)
					return
				}
			}
		}
		if path == "/health" && r.Method == "GET" {
			s.mu.Lock()
			health := s.health()
			s.mu.Unlock()
			writeJSON(w, 200, health)
			return
		}
		if !strings.HasPrefix(path, "/api/v1/") {
			writeError(w, 404, "not_found", "No such endpoint.", nil)
			return
		}
		path = strings.TrimPrefix(path, "/api/v1")

		if !local && !(path == "/health" && r.Method == "GET") && !s.signedIn(w, r) {
			return
		}

		// A change whose answer gets lost: do it, then hang up without replying.
		cut := false
		if r.Method != "GET" {
			s.mu.Lock()
			if s.cuts > 0 {
				s.cuts--
				cut = true
			}
			s.mu.Unlock()
		}
		if cut {
			s.route(discard{}, r, local, path, raw)
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					conn.Close()
				}
			}
			return
		}
		s.route(w, r, local, path, raw)
	})
}

type discard struct{}

func (discard) Header() http.Header         { return http.Header{} }
func (discard) Write(b []byte) (int, error) { return len(b), nil }
func (discard) WriteHeader(int)             {}

// signedIn checks the token on the port, counting wrong ones as the app does.
func (s *Server) signedIn(w http.ResponseWriter, r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		writeError(w, 401, "unauthorized", "Sign in required.", nil)
		return false
	}
	s.mu.Lock()
	ok := auth == "Bearer "+s.token
	if !ok {
		s.badAuth++
	}
	limited := !ok && s.badAuth > s.AuthLimit
	s.mu.Unlock()
	switch {
	case ok:
		return true
	case limited:
		w.Header().Set("Retry-After", "120")
		writeError(w, 429, "rate_limited", "Too many failed attempts. Try again later.", nil)
	default:
		writeError(w, 401, "unauthorized", "That access token is not valid.", nil)
	}
	return false
}

var (
	taskRE    = regexp.MustCompile(`^/tasks/(\d+)$`)
	taskSubRE = regexp.MustCompile(`^/tasks/(\d+)/(complete|subtasks|comments|activity|claude-session)$`)
	subtaskRE = regexp.MustCompile(`^/tasks/(\d+)/subtasks/(\d+)$`)
)

func (s *Server) route(w http.ResponseWriter, r *http.Request, local bool, path string, raw []byte) {
	fail := func(err error) {
		if ref, ok := err.(*refusal); ok {
			writeError(w, ref.status, ref.code, ref.message, ref.extra)
			return
		}
		writeError(w, 500, "internal", err.Error(), nil)
	}
	notFound := func() { writeError(w, 404, "not_found", "No such endpoint.", nil) }
	body := func(allowed ...string) (map[string]any, error) {
		if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			return nil, refuse(415, "unsupported_media_type", "Expected Content-Type: application/json")
		}
		m := map[string]any{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, refuse(400, "invalid_json", "Invalid JSON body")
			}
		}
		return m, only(m, allowed...)
	}
	via := strings.TrimSpace(r.Header.Get("X-Todos-Client"))
	if via == "" {
		via = "API on this Mac"
		if local {
			via = "command line"
		}
	}
	key := r.Header.Get("Idempotency-Key")
	if key != "" && !regexp.MustCompile(`^[\w-]{8,64}$`).MatchString(key) {
		fail(refuse(400, "invalid", "Idempotency-Key must be 8 to 64 letters, digits, hyphens or underscores."))
		return
	}
	sendTask := func(status int, t *Task, extra map[string]any) {
		w.Header().Set("ETag", fmt.Sprintf(`"%d"`, t.Rev))
		out := map[string]any{"task": t}
		for k, v := range extra {
			out[k] = v
		}
		writeJSON(w, status, out)
	}

	if path == "/events" && r.Method == "GET" {
		s.events(w, r)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.HasPrefix(path, "/habits") {
		s.routeHabits(w, r, path, via, key, body, fail)
		return
	}

	// already says whether this change was made before, under the same key.
	already := func(t *Task) bool {
		if key == "" {
			return false
		}
		for _, a := range t.Activity {
			if a.Key == key {
				return true
			}
		}
		return false
	}
	// expectedRev reads If-Match (or ?rev=): the revision, or -1 for "*".
	expectedRev := func(fallback string) (int, error) {
		rawRev := strings.TrimSpace(r.Header.Get("If-Match"))
		if rawRev == "" {
			rawRev = fallback
		}
		if rawRev == "" {
			return 0, refuse(428, "precondition_required", `Say which revision you are changing: send If-Match with the task's rev (or "rev" in the body). If-Match: * overwrites regardless.`)
		}
		if rawRev == "*" {
			return -1, nil
		}
		m := regexp.MustCompile(`^(?:W/)?"?(\d+)"?$`).FindStringSubmatch(rawRev)
		if m == nil {
			return 0, refuse(400, "invalid", `The revision must be the task's rev, for example If-Match: "3".`)
		}
		return strconv.Atoi(m[1])
	}
	task := func(id string) (*Task, error) {
		n, _ := strconv.Atoi(id)
		if t := s.find(n); t != nil {
			return t, nil
		}
		return nil, refuse(404, "not_found", "No todo with id #%s", id)
	}
	// complete marks t done and, for a repeating task, makes its next occurrence.
	complete := func(t *Task, comment string) *Task {
		var next *Task
		if t.Status != "done" {
			was := t.Status
			ts := s.stamp()
			t.Status, t.CompletedAt = "done", &ts
			text := fmt.Sprintf("moved %s → done", was)
			if t.Repeat != nil {
				next = s.create(t.Title, "me", via, "")
				due := s.nextDue(t.Due, *t.Repeat)
				next.Due, next.Repeat, next.Priority, next.Project, next.Tags, next.Notes = &due, t.Repeat, t.Priority, t.Project, t.Tags, t.Notes
				for _, sub := range t.Subtasks {
					next.Subtasks = append(next.Subtasks, Subtask{ID: sub.ID, Title: sub.Title})
				}
				t.Repeat = nil
				text += fmt.Sprintf(" · next occurrence is #%d, due %s", next.ID, due)
			}
			s.bump(t, "me", "event", text, via, key)
			if comment != "" {
				t.Activity = append(t.Activity, Activity{At: s.stamp(), By: "me", Kind: "comment", Text: comment, Via: via, Key: key})
			}
			s.changed()
		} else if comment != "" {
			s.bump(t, "me", "comment", comment, via, key)
			s.changed()
		}
		return next
	}

	switch {
	case path == "/health" && r.Method == "GET":
		writeJSON(w, 200, map[string]string{"status": "ok"})

	case path == "/meta" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"api": map[string]int{"version": 1, "revision": s.Revision}, "app": map[string]string{"name": "Todos", "version": s.AppVersion}})

	case path == "/info" && r.Method == "GET":
		if s.Revision < 4 {
			notFound()
			return
		}
		info := s.health()
		info["minClientVersions"] = map[string]string{"cli": s.MinCLI, "ios": "1.0"}
		writeJSON(w, 200, info)

	case path == "/session" && r.Method == "GET":
		kind := "api"
		if local {
			kind = "local"
		}
		writeJSON(w, 200, map[string]string{"kind": kind})

	case path == "/tasks" && r.Method == "GET":
		list, err := s.list(r)
		if err != nil {
			fail(err)
			return
		}
		writeJSON(w, 200, list)

	case path == "/tasks" && r.Method == "POST":
		in, err := body(append(editable, "subtasks")...)
		if err != nil {
			fail(err)
			return
		}
		if _, ok := in["title"]; !ok {
			fail(refuse(400, "invalid", "A task needs a title."))
			return
		}
		t, err := s.createFrom(in, via, key)
		if err != nil {
			fail(err)
			return
		}
		w.Header().Set("Location", fmt.Sprintf("/api/v1/tasks/%d", t.ID))
		sendTask(201, t, nil)

	case path == "/capture" && r.Method == "POST", path == "/capture/preview" && r.Method == "POST":
		in, err := body("text", "at")
		if err != nil {
			fail(err)
			return
		}
		text, _ := in["text"].(string)
		title, fields := s.parseLine(text)
		parsed := map[string]any{"title": title, "fields": fields}
		if path == "/capture/preview" {
			writeJSON(w, 200, parsed)
			return
		}
		if strings.TrimSpace(text) == "" {
			fail(refuse(400, "invalid", `Send the line to capture as "text".`))
			return
		}
		if title == "" {
			fail(refuse(400, "invalid", "That line has no title, only dates and markers."))
			return
		}
		in = map[string]any{"title": title}
		for k, v := range fields {
			in[k] = v
		}
		t, err := s.createFrom(in, via, key)
		if err != nil {
			fail(err)
			return
		}
		w.Header().Set("Location", fmt.Sprintf("/api/v1/tasks/%d", t.ID))
		sendTask(201, t, map[string]any{"parsed": parsed})

	case path == "/due" && r.Method == "GET":
		writeJSON(w, 200, s.due())

	case path == "/summary" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"counts": s.counts(), "daily": nil, "date": s.today()})

	case taskRE.MatchString(path):
		t, err := task(taskRE.FindStringSubmatch(path)[1])
		if err != nil {
			fail(err)
			return
		}
		switch r.Method {
		case "GET":
			sendTask(200, t, nil)
		case "PATCH":
			in, err := body(append(editable, "rev")...)
			if err != nil {
				fail(err)
				return
			}
			fallback := ""
			if v, ok := in["rev"]; ok {
				fallback = fmt.Sprint(v)
				delete(in, "rev")
			}
			rev, err := expectedRev(fallback)
			if err != nil {
				fail(err)
				return
			}
			if already(t) {
				sendTask(200, t, map[string]any{"next": nil})
				return
			}
			if rev != -1 && rev != t.Rev {
				fail(&refusal{409, "conflict", fmt.Sprintf("Todo #%d has changed since you loaded it (it is now at revision %d)", t.ID, t.Rev), map[string]any{"current": t}})
				return
			}
			var next *Task
			if in["status"] == "done" && t.Status != "done" {
				// Completing goes the same way as POST /complete, so a repeat carries on.
				before := *t
				delete(in, "status")
				if _, err := s.apply(t, in); err != nil {
					*t = before
					fail(err)
					return
				}
				next = complete(t, "")
			} else {
				changes, err := s.apply(t, in)
				if err != nil {
					fail(err)
					return
				}
				if len(changes) > 0 {
					s.bump(t, "me", "event", strings.Join(changes, " · "), via, key)
					s.changed()
				}
			}
			sendTask(200, t, map[string]any{"next": next})
		case "DELETE":
			rev, err := expectedRev(r.URL.Query().Get("rev"))
			if err != nil {
				fail(err)
				return
			}
			if rev != -1 && rev != t.Rev {
				fail(&refusal{409, "conflict", fmt.Sprintf("Todo #%d has changed since you loaded it (it is now at revision %d)", t.ID, t.Rev), map[string]any{"current": t}})
				return
			}
			s.remove(t.ID)
			s.changed()
			w.WriteHeader(204)
		default:
			w.Header().Set("Allow", "GET, PATCH, DELETE")
			writeError(w, 405, "method_not_allowed", r.Method+" is not supported here.", nil)
		}

	case subtaskRE.MatchString(path):
		m := subtaskRE.FindStringSubmatch(path)
		t, err := task(m[1])
		if err != nil {
			fail(err)
			return
		}
		subID, _ := strconv.Atoi(m[2])
		index := -1
		for i, sub := range t.Subtasks {
			if sub.ID == subID {
				index = i
			}
		}
		if index < 0 {
			fail(refuse(404, "not_found", "Task #%d has no subtask %d", t.ID, subID))
			return
		}
		sub := &t.Subtasks[index]
		switch r.Method {
		case "PATCH":
			in, err := body("title", "done")
			if err != nil {
				fail(err)
				return
			}
			if already(t) {
				sendTask(200, t, nil)
				return
			}
			var changes []string
			if title, ok := in["title"].(string); ok && strings.TrimSpace(title) != "" && title != sub.Title {
				changes = append(changes, fmt.Sprintf("renamed subtask %q to %q", sub.Title, title))
				sub.Title = strings.TrimSpace(title)
			}
			if v, ok := in["done"]; ok {
				done, isBool := v.(bool)
				if !isBool {
					fail(refuse(400, "invalid", `"done" must be true or false.`))
					return
				}
				if done != sub.Done {
					sub.Done = done
					verb := "unchecked"
					if done {
						verb = "checked off"
					}
					changes = append(changes, fmt.Sprintf("%s %q", verb, sub.Title))
				}
			}
			if len(changes) > 0 {
				s.bump(t, "me", "event", strings.Join(changes, " · "), via, key)
				s.changed()
			}
			sendTask(200, t, nil)
		case "DELETE":
			if !already(t) {
				title := sub.Title
				t.Subtasks = append(t.Subtasks[:index], t.Subtasks[index+1:]...)
				s.bump(t, "me", "event", fmt.Sprintf("removed subtask %q", title), via, key)
				s.changed()
			}
			sendTask(200, t, nil)
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			writeError(w, 405, "method_not_allowed", r.Method+" is not supported here.", nil)
		}

	case taskSubRE.MatchString(path):
		m := taskSubRE.FindStringSubmatch(path)
		// Start with Claude exists on the socket only. On the port the path is not there at all.
		if m[2] == "claude-session" && !local {
			notFound()
			return
		}
		t, err := task(m[1])
		if err != nil {
			fail(err)
			return
		}
		switch {
		case m[2] == "complete" && r.Method == "POST":
			comment := ""
			if len(raw) > 0 {
				in, err := body("comment")
				if err != nil {
					fail(err)
					return
				}
				comment, _ = in["comment"].(string)
			}
			var next *Task
			if !already(t) {
				next = complete(t, comment)
			}
			sendTask(200, t, map[string]any{"next": next})

		case m[2] == "subtasks" && r.Method == "POST":
			in, err := body("title", "titles")
			if err != nil {
				fail(err)
				return
			}
			var titles []string
			if title, ok := in["title"].(string); ok && strings.TrimSpace(title) != "" {
				titles = append(titles, strings.TrimSpace(title))
			}
			if list, ok := in["titles"].([]any); ok {
				for _, x := range list {
					if title, ok := x.(string); ok && strings.TrimSpace(title) != "" {
						titles = append(titles, strings.TrimSpace(title))
					}
				}
			}
			if len(titles) == 0 {
				fail(refuse(400, "invalid", `Send "title", or "titles" as a list.`))
				return
			}
			if !already(t) {
				next := 1
				for _, sub := range t.Subtasks {
					if sub.ID >= next {
						next = sub.ID + 1
					}
				}
				for _, title := range titles {
					t.Subtasks = append(t.Subtasks, Subtask{ID: next, Title: title})
					next++
				}
				s.bump(t, "me", "event", "added subtasks", via, key)
				s.changed()
			}
			sendTask(201, t, nil)

		case m[2] == "comments" && r.Method == "POST":
			in, err := body("text")
			if err != nil {
				fail(err)
				return
			}
			text, _ := in["text"].(string)
			if strings.TrimSpace(text) == "" {
				fail(refuse(400, "invalid", `A comment needs "text".`))
				return
			}
			if !already(t) {
				s.bump(t, "me", "comment", strings.TrimSpace(text), via, key)
				s.changed()
			}
			sendTask(201, t, nil)

		case m[2] == "activity" && r.Method == "GET":
			kind := r.URL.Query().Get("kind")
			out := []Activity{}
			for _, a := range t.Activity {
				if kind == "" || a.Kind == kind {
					out = append(out, a)
				}
			}
			writeJSON(w, 200, map[string]any{"activity": out})

		case m[2] == "claude-session" && r.Method == "GET":
			var folder, claude any
			if f := s.folders[deref(t.Project)]; f != "" {
				folder = f
			}
			if s.Claude != "" {
				claude = s.Claude
			}
			title := fmt.Sprintf("Todo #%d: %s", t.ID, t.Title)
			writeJSON(w, 200, map[string]any{
				"prompt": fmt.Sprintf("Work on task #%d from my todo list: %s\n\nStart by calling todo_get for #%d to read its notes and subtasks.", t.ID, t.Title, t.ID),
				"folder": folder,
				"args":   []string{"--name", title, "--allowedTools", "mcp__todolist"},
				"claude": claude,
			})

		case m[2] == "claude-session" && r.Method == "POST":
			folder := ""
			if len(raw) > 0 {
				in, err := body("folder")
				if err != nil {
					fail(err)
					return
				}
				if v, ok := in["folder"]; ok {
					folder, _ = v.(string)
					if info, err := os.Stat(folder); err != nil || !info.IsDir() || !strings.HasPrefix(folder, "/") {
						fail(refuse(400, "invalid", `"folder" must be the full path of an existing folder.`))
						return
					}
				}
			}
			if !already(t) {
				text := "Started with Claude from terminal."
				if folder != "" {
					text = fmt.Sprintf("Started with Claude from terminal in %s.", folder)
					if t.Project != nil {
						s.folders[*t.Project] = folder
					}
				}
				t.Assignee = "claude"
				s.bump(t, "me", "comment", text, via, key)
				s.changed()
			}
			sendTask(200, t, nil)

		default:
			writeError(w, 405, "method_not_allowed", r.Method+" is not supported here.", nil)
		}

	default:
		notFound()
	}
}

func (s *Server) createFrom(in map[string]any, via, key string) (*Task, error) {
	if key != "" {
		for _, t := range s.tasks {
			for _, a := range t.Activity {
				if a.Key == key {
					return t, nil
				}
			}
		}
	}
	title := strings.TrimSpace(fmt.Sprint(in["title"]))
	if title == "" || in["title"] == nil {
		return nil, refuse(400, "invalid", "Title cannot be empty")
	}
	// Check the fields on a scratch copy first, so a bad one adds nothing.
	scratch := &Task{Status: "todo", Priority: "medium", Assignee: "me"}
	if _, err := s.apply(scratch, in); err != nil {
		return nil, err
	}
	t := s.create(title, "me", via, key)
	_, _ = s.apply(t, in)
	if list, ok := in["subtasks"].([]any); ok {
		for i, x := range list {
			if sub, ok := x.(string); ok && strings.TrimSpace(sub) != "" {
				t.Subtasks = append(t.Subtasks, Subtask{ID: i + 1, Title: strings.TrimSpace(sub)})
			}
		}
	}
	s.changed()
	return t, nil
}

func (s *Server) list(r *http.Request) (map[string]any, error) {
	q := r.URL.Query()
	many := func(name string, allowed ...string) ([]string, error) {
		rawValue := q.Get(name)
		if rawValue == "" {
			return nil, nil
		}
		var out []string
		for _, given := range strings.Split(rawValue, ",") {
			v, err := oneOf(name, given, allowed...)
			if err != nil {
				return nil, refuse(400, "invalid", "Invalid %s %q. Expected one of: %s.", name, strings.TrimSpace(given), strings.Join(allowed, ", "))
			}
			out = append(out, v)
		}
		return out, nil
	}
	has := func(list []string, v string) bool {
		for _, x := range list {
			if x == v {
				return true
			}
		}
		return false
	}
	statuses, err := many("status", "open", "all", "todo", "in_progress", "blocked", "done")
	if err != nil {
		return nil, err
	}
	switch {
	case statuses == nil:
		statuses = []string{"todo", "in_progress", "blocked"}
	case has(statuses, "all"):
		statuses = []string{"todo", "in_progress", "blocked", "done"}
	case has(statuses, "open"):
		statuses = append(statuses, "todo", "in_progress", "blocked")
	}
	priorities, err := many("priority", "high", "medium", "low")
	if err != nil {
		return nil, err
	}
	assignees, err := many("assignee", "me", "claude")
	if err != nil {
		return nil, err
	}
	due := strings.ToLower(q.Get("due"))
	isDate := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(due)
	if due != "" && !isDate && !has([]string{"overdue", "today", "week", "none", "any"}, due) {
		return nil, refuse(400, "invalid", "Invalid due. Expected overdue, today, week, none, any, or a date (YYYY-MM-DD) to list what is due on or before it.")
	}
	number := func(name string, fallback, max int) (int, error) {
		rawValue := q.Get(name)
		if rawValue == "" {
			return fallback, nil
		}
		n, err := strconv.Atoi(rawValue)
		if err != nil || n < 0 {
			return 0, refuse(400, "invalid", "%s must be a whole number.", name)
		}
		if n > max {
			n = max
		}
		return n, nil
	}
	limit, err := number("limit", 200, 500)
	if err != nil {
		return nil, err
	}
	offset, err := number("offset", 0, 1<<30)
	if err != nil {
		return nil, err
	}

	t0 := s.today()
	week := s.Now().AddDate(0, 0, 7).Format("2006-01-02")
	tag := strings.ToLower(strings.TrimLeft(q.Get("tag"), "#@"))
	words := strings.Fields(strings.ToLower(q.Get("q")))
	_, byProject := q["project"]
	project := strings.ToLower(q.Get("project"))

	var matching []*Task
	for _, t := range s.tasks {
		d := deref(t.Due)
		dueOK := true
		switch {
		case due == "overdue":
			dueOK = d != "" && d < t0 && t.Status != "done"
		case due == "today":
			dueOK = d == t0
		case due == "week":
			dueOK = d != "" && d >= t0 && d <= week
		case due == "none":
			dueOK = d == ""
		case due == "any":
			dueOK = d != ""
		case isDate:
			dueOK = d != "" && d <= due
		}
		text := strings.ToLower(strings.Join(append([]string{t.Title, t.Notes, deref(t.Project)}, t.Tags...), "\n"))
		for _, sub := range t.Subtasks {
			text += "\n" + strings.ToLower(sub.Title)
		}
		wordsOK := true
		for _, word := range words {
			wordsOK = wordsOK && strings.Contains(text, word)
		}
		if has(statuses, t.Status) && (priorities == nil || has(priorities, t.Priority)) && (assignees == nil || has(assignees, t.Assignee)) &&
			(!byProject || strings.ToLower(deref(t.Project)) == project) && (tag == "" || has(t.Tags, tag)) && dueOK && wordsOK {
			matching = append(matching, t)
		}
	}
	matching = sorted(matching)
	total := len(matching)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return map[string]any{"tasks": briefs(matching[offset:end]), "total": total, "summary": s.counts(), "version": s.version}, nil
}

func (s *Server) due() map[string]any {
	t0 := s.today()
	week := s.Now().AddDate(0, 0, 7).Format("2006-01-02")
	groups := map[string][]*Task{"overdue": {}, "today": {}, "upcoming": {}, "undated": {}, "later": {}}
	for _, t := range sorted(s.tasks) {
		if t.Status == "done" {
			continue
		}
		d := deref(t.Due)
		switch {
		case d == "":
			groups["undated"] = append(groups["undated"], t)
		case d < t0:
			groups["overdue"] = append(groups["overdue"], t)
		case d == t0:
			groups["today"] = append(groups["today"], t)
		case d <= week:
			groups["upcoming"] = append(groups["upcoming"], t)
		default:
			groups["later"] = append(groups["later"], t)
		}
	}
	for _, name := range []string{"upcoming", "later"} {
		list := groups[name]
		sort.SliceStable(list, func(i, j int) bool { return *list[i].Due < *list[j].Due })
	}
	out := map[string]any{"date": t0}
	counts := map[string]int{}
	for name, list := range groups {
		out[name] = briefs(list)
		counts[name] = len(list)
	}
	out["counts"] = counts
	return out
}

// events serves the live-update stream.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, "internal", "streaming is not supported", nil)
		return
	}
	ch := make(chan string, 16)
	s.mu.Lock()
	s.streams[ch] = true
	hello := fmt.Sprintf("event: hello\ndata: {\"version\":%d}\n\n", s.version)
	ping := s.Ping
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.streams, ch)
		s.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	io.WriteString(w, hello) //nolint:errcheck
	flusher.Flush()
	tick := time.NewTicker(ping)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, open := <-ch:
			if !open {
				// Dropped by the server: hang up mid-stream, as a lost connection would.
				if hj, ok := w.(http.Hijacker); ok {
					if conn, _, err := hj.Hijack(); err == nil {
						conn.Close()
					}
				}
				return
			}
			io.WriteString(w, msg) //nolint:errcheck
			flusher.Flush()
		case <-tick.C:
			io.WriteString(w, ": ping\n\n") //nolint:errcheck
			flusher.Flush()
		}
	}
}
