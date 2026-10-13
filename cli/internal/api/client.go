package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AnyRev overwrites whatever revision the task is at (If-Match: *).
const AnyRev = -1

// Client talks to one Todos server.
type Client struct {
	Local     bool   // over the Unix socket, where local-only routes exist
	Base      string // scheme and host, no trailing slash
	Token     string // access token; never sent on the socket
	Label     string // how changes are labelled in a task's activity (X-Todos-Client)
	UserAgent string

	http   *http.Client // ordinary requests
	stream *http.Client // live updates: no overall time limit
	host   string
}

const (
	requestTimeout = 20 * time.Second
	dialTimeout    = 5 * time.Second
)

// NewSocket returns a client for the app's local socket at path.
func NewSocket(path string) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: dialTimeout}
			return d.DialContext(ctx, "unix", path)
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}
	return &Client{
		Local:  true,
		Base:   "http://todos",
		http:   &http.Client{Transport: tr, Timeout: requestTimeout},
		stream: &http.Client{Transport: tr},
	}
}

// CleanURL turns what the user typed into the hub's address: scheme and host
// only. Plain http is accepted for this machine alone (a test server, or an SSH
// tunnel); everything else must be https.
func CleanURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("the address is empty")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("%q is not an address like https://my-mac.my-tailnet.ts.net", raw)
	}
	if u.User != nil {
		return "", errors.New("the address must not contain a username or password")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if h := u.Hostname(); h != "localhost" && h != "127.0.0.1" && h != "::1" {
			return "", errors.New("the address must be https (plain http is only accepted for localhost)")
		}
	default:
		return "", fmt.Errorf("the address must be https, not %s", u.Scheme)
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

// NewRemote returns a client for another Mac at base (see CleanURL), signing in
// with token. caFile, if not empty, names extra certificate authorities to trust.
func NewRemote(base, token, caFile string) (*Client, error) {
	base, err := CleanURL(base)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(base)
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("can't read the certificate file: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s holds no certificates", caFile)
		}
		tlsConfig.RootCAs = pool
	}
	// No proxy: a tailnet address is only reachable directly.
	tr := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   dialTimeout,
		ResponseHeaderTimeout: requestTimeout,
		MaxIdleConns:          4,
		IdleConnTimeout:       60 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &Client{
		Base:   base,
		Token:  token,
		http:   &http.Client{Transport: tr, Timeout: requestTimeout, CheckRedirect: noRedirects},
		stream: &http.Client{Transport: tr, CheckRedirect: noRedirects},
		host:   u.Hostname(),
	}, nil
}

// A redirect would carry the token to wherever it points. The API never sends one.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Host is the hub's hostname, or "" for the local socket.
func (c *Client) Host() string { return c.host }

// Close drops idle connections.
func (c *Client) Close() {
	c.http.CloseIdleConnections()
}

type request struct {
	method string
	path   string // from the server's root, e.g. /api/v1/tasks
	query  url.Values
	body   any    // marshalled as JSON; nil for none
	rev    int    // 0: none; AnyRev: "*"; else the revision in If-Match
	key    string // Idempotency-Key
	stream bool
}

func (c *Client) newRequest(ctx context.Context, r request) (*http.Request, error) {
	u := c.Base + r.path
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	var body io.Reader
	contentType := ""
	if r.body != nil {
		b, err := json.Marshal(r.body)
		if err != nil {
			return nil, err
		}
		body, contentType = bytes.NewReader(b), "application/json"
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	if r.stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" && !c.Local {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.Label != "" {
		req.Header.Set("X-Todos-Client", c.Label)
	}
	switch {
	case r.rev == AnyRev:
		req.Header.Set("If-Match", "*")
	case r.rev > 0:
		req.Header.Set("If-Match", `"`+strconv.Itoa(r.rev)+`"`)
	}
	if r.key != "" {
		req.Header.Set("Idempotency-Key", r.key)
	}
	return req, nil
}

// do sends a request and decodes a JSON answer into out (which may be nil).
// A request cut off partway is sent again: reads are always safe to repeat, and
// changes carry an Idempotency-Key that makes them so.
func (c *Client) do(ctx context.Context, r request, out any) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 250 * time.Millisecond):
			}
		}
		err = c.once(ctx, r, out)
		// A delete has no key. If the first try did go through, the second finds nothing left.
		if attempt > 0 && r.method == http.MethodDelete && IsStatus(err, http.StatusNotFound) {
			return nil
		}
		if !IsConn(err, Interrupted) {
			return err
		}
	}
	return err
}

func (c *Client) once(ctx context.Context, r request, out any) error {
	req, err := c.newRequest(ctx, r)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return classify(err, c.Local, c.host)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return classify(err, c.Local, c.host)
	}
	if res.StatusCode >= 400 {
		return c.refusal(res, body)
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = body
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("Todos sent an answer that could not be read: %w", err)
	}
	return nil
}

// refusal reads an error response. Ones that did not come from Todos itself (a
// proxy in front of it saying it is not there) become ConnErrors.
func (c *Client) refusal(res *http.Response, body []byte) error {
	e := &Error{Status: res.StatusCode}
	if n, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil {
		e.RetryAfter = n
	}
	var v1 struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Current *Task  `json:"current"`
		} `json:"error"`
	}
	var old struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	fromTodos := false
	if json.Unmarshal(body, &v1) == nil && v1.Error.Code != "" {
		e.Code, e.Message, e.Current = v1.Error.Code, v1.Error.Message, v1.Error.Current
		fromTodos = true
	} else if json.Unmarshal(body, &old) == nil && old.Error != "" {
		e.Code, e.Message = old.Code, old.Error
		fromTodos = true
	}

	if !c.Local {
		switch {
		case !fromTodos && (res.StatusCode == 502 || res.StatusCode == 503 || res.StatusCode == 504):
			// `tailscale serve` answers for the Mac when the app behind it is not running.
			return &ConnError{AppDown, fmt.Sprintf("%s is on, but Todos isn't running there", c.host), e}
		case res.StatusCode == 403 && e.Code == "" && strings.Contains(e.Message, "Forbidden host"):
			// The answer the app gives relayed requests while Remote Access is off.
			return &ConnError{RemoteOff, fmt.Sprintf("Remote Access is turned off in Todos on %s", c.host), e}
		case res.StatusCode == 403 && e.Code == "forbidden_host":
			e.Message = fmt.Sprintf("the Mac doesn't answer to the name %s: use the address shown in Todos → Remote Access", c.host)
		case !fromTodos && res.StatusCode == 404:
			return &ConnError{RemoteOff, fmt.Sprintf("nothing at %s answers like Todos: check the address, and that Remote Access is on", c.host), e}
		}
	}
	if e.Message == "" {
		e.Message = fmt.Sprintf("Todos answered %s", res.Status)
	}
	return e
}

func newKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on the platforms this runs on
	}
	return hex.EncodeToString(b)
}

const v1 = "/api/v1"

func taskPath(id int, rest ...string) string {
	return v1 + "/tasks/" + strconv.Itoa(id) + strings.Join(rest, "")
}

// ---------- health and versions ----------

// Health asks GET /health: is the server there, and what does it speak. It
// needs no token.
func (c *Client) Health(ctx context.Context) (*Info, error) {
	var out Info
	if err := c.do(ctx, request{method: "GET", path: "/health"}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Info asks GET /info: the health check plus how old a client may be. An app
// from before the command-line client has no such route; that is reported as a
// VersionError rather than "not found".
func (c *Client) Info(ctx context.Context) (*Info, error) {
	var out Info
	err := c.do(ctx, request{method: "GET", path: v1 + "/info"}, &out)
	if IsStatus(err, http.StatusNotFound) {
		return nil, &VersionError{AppTooOld: true, Have: c.revision(ctx), Need: strconv.Itoa(RequiredRevision)}
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// The API revision an older app reports, for the message. "an older one" if it won't say.
func (c *Client) revision(ctx context.Context) string {
	var meta struct {
		API APIVersion `json:"api"`
	}
	if c.do(ctx, request{method: "GET", path: v1 + "/meta"}, &meta) == nil && meta.API.Revision > 0 {
		return strconv.Itoa(meta.API.Revision)
	}
	return "an older one"
}

// ---------- reading ----------

func (o ListOptions) values() url.Values {
	q := url.Values{}
	set := func(k, v string) {
		if v != "" {
			q.Set(k, v)
		}
	}
	set("status", o.Status)
	set("priority", o.Priority)
	set("tag", o.Tag)
	set("assignee", o.Assignee)
	set("due", o.Due)
	set("q", o.Query)
	if o.Project != nil {
		q.Set("project", *o.Project)
	}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	if o.Offset > 0 {
		q.Set("offset", strconv.Itoa(o.Offset))
	}
	return q
}

// List fetches one page of tasks.
func (c *Client) List(ctx context.Context, o ListOptions) (*TaskList, error) {
	var out TaskList
	if err := c.do(ctx, request{method: "GET", path: v1 + "/tasks", query: o.values()}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

const pageSize = 500 // the most the server gives at once

// ListAll fetches every matching task, a page at a time. With o.Limit set it
// stops there instead.
func (c *Client) ListAll(ctx context.Context, o ListOptions) (*TaskList, error) {
	var all *TaskList
	offset := o.Offset
	for {
		page := o
		page.Offset, page.Limit = offset, pageSize
		if o.Limit > 0 && all != nil && o.Limit-len(all.Tasks) < pageSize {
			page.Limit = o.Limit - len(all.Tasks)
		} else if o.Limit > 0 && o.Limit < pageSize {
			page.Limit = o.Limit
		}
		got, err := c.List(ctx, page)
		if err != nil {
			return nil, err
		}
		if all == nil {
			all = got
		} else {
			all.Tasks = append(all.Tasks, got.Tasks...)
			all.Total, all.Summary, all.Version = got.Total, got.Summary, got.Version
		}
		offset += len(got.Tasks)
		if len(got.Tasks) < page.Limit || offset >= got.Total || (o.Limit > 0 && len(all.Tasks) >= o.Limit) {
			return all, nil
		}
	}
}

func (c *Client) Get(ctx context.Context, id int) (*Task, error) {
	var out TaskResult
	if err := c.do(ctx, request{method: "GET", path: taskPath(id)}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Due(ctx context.Context) (*Due, json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.do(ctx, request{method: "GET", path: v1 + "/due"}, &raw); err != nil {
		return nil, nil, err
	}
	var out Due
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil, fmt.Errorf("Todos sent an answer that could not be read: %w", err)
	}
	return &out, raw, nil
}

func (c *Client) Summary(ctx context.Context) (*Summary, error) {
	var out Summary
	if err := c.do(ctx, request{method: "GET", path: v1 + "/summary"}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Activity(ctx context.Context, id int) ([]Activity, error) {
	var out struct {
		Activity []Activity `json:"activity"`
	}
	if err := c.do(ctx, request{method: "GET", path: taskPath(id, "/activity")}, &out); err != nil {
		return nil, err
	}
	return out.Activity, nil
}

// ---------- changing ----------

func (c *Client) change(ctx context.Context, r request) (*TaskResult, error) {
	r.key = newKey()
	var out TaskResult
	if err := c.do(ctx, r, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Capture adds a task from one line, read by the server exactly as the app's
// own capture box reads it.
func (c *Client) Capture(ctx context.Context, line string) (*TaskResult, error) {
	return c.change(ctx, request{method: "POST", path: v1 + "/capture", body: map[string]any{"text": line}})
}

// Preview shows how a line would be read, without adding anything.
func (c *Client) Preview(ctx context.Context, line string) (*Parsed, error) {
	var out Parsed
	if err := c.do(ctx, request{method: "POST", path: v1 + "/capture/preview", body: map[string]any{"text": line}}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create adds a task from separate fields. Dates and repeats are sent as typed;
// the server reads them.
func (c *Client) Create(ctx context.Context, fields map[string]any) (*TaskResult, error) {
	return c.change(ctx, request{method: "POST", path: v1 + "/tasks", body: fields})
}

// Patch changes fields of a task that is still at revision rev (or AnyRev). A
// task that has moved on is refused with an *Error whose Current is the task now.
func (c *Client) Patch(ctx context.Context, id int, fields map[string]any, rev int) (*TaskResult, error) {
	return c.change(ctx, request{method: "PATCH", path: taskPath(id), body: fields, rev: rev})
}

// PatchOnTop changes fields of a task that was read as `base`, without
// overwriting anyone else's change. If the task has moved on since, the change
// is tried once more only when none of these fields were among what moved:
// then both changes stand. If the same fields changed, the conflict is returned
// (an *Error with Current set) and nothing is done.
func (c *Client) PatchOnTop(ctx context.Context, base *Task, fields map[string]any) (*TaskResult, error) {
	res, err := c.Patch(ctx, base.ID, fields, base.Rev)
	var refused *Error
	if !errors.As(err, &refused) || refused.Status != http.StatusConflict || refused.Current == nil {
		return res, err
	}
	if len(Overlap(base, refused.Current, fields)) > 0 {
		return nil, err
	}
	return c.Patch(ctx, base.ID, fields, refused.Current.Rev)
}

// Overlap lists which of fields differ between two readings of a task: the
// fields a change based on the first would overwrite in the second.
func Overlap(base, current *Task, fields map[string]any) []string {
	var names []string
	for name := range fields {
		if !bytes.Equal(base.Field(name), current.Field(name)) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func (c *Client) Delete(ctx context.Context, id int, rev int) error {
	return c.do(ctx, request{method: "DELETE", path: taskPath(id), rev: rev}, nil)
}

func (c *Client) Complete(ctx context.Context, id int, comment string) (*TaskResult, error) {
	r := request{method: "POST", path: taskPath(id, "/complete")}
	if comment != "" {
		r.body = map[string]any{"comment": comment}
	}
	return c.change(ctx, r)
}

func (c *Client) Comment(ctx context.Context, id int, text string) (*TaskResult, error) {
	return c.change(ctx, request{method: "POST", path: taskPath(id, "/comments"), body: map[string]any{"text": text}})
}

func (c *Client) AddSubtasks(ctx context.Context, id int, titles []string) (*TaskResult, error) {
	return c.change(ctx, request{method: "POST", path: taskPath(id, "/subtasks"), body: map[string]any{"titles": titles}})
}

func (c *Client) PatchSubtask(ctx context.Context, id, sub int, fields map[string]any) (*TaskResult, error) {
	return c.change(ctx, request{method: "PATCH", path: taskPath(id, "/subtasks/", strconv.Itoa(sub)), body: fields})
}

func (c *Client) DeleteSubtask(ctx context.Context, id, sub int) (*TaskResult, error) {
	return c.change(ctx, request{method: "DELETE", path: taskPath(id, "/subtasks/", strconv.Itoa(sub))})
}

// ---------- Start with Claude (local socket only) ----------

func (c *Client) ClaudeSession(ctx context.Context, id int) (*ClaudeSession, error) {
	var out ClaudeSession
	if err := c.do(ctx, request{method: "GET", path: taskPath(id, "/claude-session")}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClaudeStarted records that a session was started on the task in folder.
func (c *Client) ClaudeStarted(ctx context.Context, id int, folder string) (*TaskResult, error) {
	r := request{method: "POST", path: taskPath(id, "/claude-session")}
	if folder != "" {
		r.body = map[string]any{"folder": folder}
	}
	return c.change(ctx, r)
}

// ---------- versions ----------

// VersionError says one side is too old for the other.
type VersionError struct {
	AppTooOld bool   // otherwise this client is
	Have      string // what the old side is
	Need      string // what the other side needs
}

func (e *VersionError) Error() string {
	if e.AppTooOld {
		return fmt.Sprintf("the Todos app is too old for this todos command (it speaks API revision %s; %s or later is needed): update Todos on the Mac", e.Have, e.Need)
	}
	return fmt.Sprintf("this todos command (%s) is too old for the Todos app, which needs %s or later: update it", e.Have, e.Need)
}

// CheckVersions compares both sides: the app must speak a new enough API, and
// this client (at `version`) must be at least what the app asks of "cli".
func CheckVersions(info *Info, version string) error {
	if info.APIVersion.Version != 1 || info.APIVersion.Revision < RequiredRevision {
		return &VersionError{AppTooOld: true, Have: strconv.Itoa(info.APIVersion.Revision), Need: strconv.Itoa(RequiredRevision)}
	}
	if min := info.MinClientVersions["cli"]; min != "" && CompareVersions(version, min) < 0 {
		return &VersionError{Have: version, Need: min}
	}
	return nil
}

// CompareVersions compares dotted versions number by number: -1, 0 or 1.
// Anything after the numbers ("-dev", "+build") is ignored.
func CompareVersions(a, b string) int {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	var out []int
	for _, part := range strings.Split(v, ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			break
		}
		out = append(out, n)
	}
	return out
}
