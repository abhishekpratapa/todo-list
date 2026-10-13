// Package api is the client for the Todos app's /api/v1, over the local Unix
// socket or over HTTPS to another Mac. The shapes here follow docs/openapi.json.
package api

import "encoding/json"

// RequiredRevision is the oldest API revision this client works with: the one
// that added the local socket and GET /info.
const RequiredRevision = 4

type Subtask struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

type Activity struct {
	At   string `json:"at"`
	By   string `json:"by"`
	Kind string `json:"kind"` // "event" or "comment"
	Text string `json:"text"`
	Via  string `json:"via,omitempty"`
}

// Task is a task as the API sends it. In lists the activity is left out and
// Comments says how many comments there are instead.
//
// Raw keeps the object exactly as it arrived, and is what the task marshals
// back to. So `--json` output is the server's own, including fields added after
// this client was built.
type Task struct {
	ID          int        `json:"id"`
	Title       string     `json:"title"`
	Notes       string     `json:"notes"`
	Status      string     `json:"status"`
	Priority    string     `json:"priority"`
	Due         string     `json:"due"` // YYYY-MM-DD, or empty
	Project     string     `json:"project"`
	Tags        []string   `json:"tags"`
	Assignee    string     `json:"assignee"`
	Subtasks    []Subtask  `json:"subtasks"`
	Repeat      string     `json:"repeat"`
	RemindAt    string     `json:"remindAt"`
	RemindedAt  string     `json:"remindedAt"`
	Rev         int        `json:"rev"`
	CreatedBy   string     `json:"createdBy"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
	CompletedAt string     `json:"completedAt"`
	Activity    []Activity `json:"activity,omitempty"`
	Comments    int        `json:"comments,omitempty"`

	Raw json.RawMessage `json:"-"`
}

func (t *Task) UnmarshalJSON(b []byte) error {
	type plain Task
	if err := json.Unmarshal(b, (*plain)(t)); err != nil {
		return err
	}
	t.Raw = append(json.RawMessage(nil), b...)
	return nil
}

func (t Task) MarshalJSON() ([]byte, error) {
	if t.Raw != nil {
		return t.Raw, nil
	}
	type plain Task
	return json.Marshal(plain(t))
}

// Field returns one field of the task as raw JSON, or nil if it has none.
func (t *Task) Field(name string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(t.Raw, &m) != nil {
		return nil
	}
	return m[name]
}

// SubtasksDone counts the checked subtasks.
func (t *Task) SubtasksDone() int {
	n := 0
	for _, s := range t.Subtasks {
		if s.Done {
			n++
		}
	}
	return n
}

// CommentCount is the number of comments, whichever form the task came in.
func (t *Task) CommentCount() int {
	if t.Activity == nil {
		return t.Comments
	}
	n := 0
	for _, a := range t.Activity {
		if a.Kind == "comment" {
			n++
		}
	}
	return n
}

// Counts are the numbers on the dashboard's tiles. Like Task, they marshal
// back to exactly what the server sent.
type Counts struct {
	Open       int `json:"open"`
	InProgress int `json:"in_progress"`
	Blocked    int `json:"blocked"`
	Overdue    int `json:"overdue"`
	DueToday   int `json:"due_today"`
	Claude     int `json:"claude"`
	Done7d     int `json:"done_7d"`

	Raw json.RawMessage `json:"-"`
}

func (c *Counts) UnmarshalJSON(b []byte) error {
	type plain Counts
	if err := json.Unmarshal(b, (*plain)(c)); err != nil {
		return err
	}
	c.Raw = append(json.RawMessage(nil), b...)
	return nil
}

func (c Counts) MarshalJSON() ([]byte, error) {
	if c.Raw != nil {
		return c.Raw, nil
	}
	type plain Counts
	return json.Marshal(plain(c))
}

// TaskList is what GET /tasks answers.
type TaskList struct {
	Tasks   []Task `json:"tasks"`
	Total   int    `json:"total"`
	Summary Counts `json:"summary"`
	Version int    `json:"version"`
}

// TaskResult is what every change answers: the task as it is now. Next is the
// new occurrence when a repeating task was completed. Parsed is how a captured
// line was read.
type TaskResult struct {
	Task   Task            `json:"task"`
	Next   *Task           `json:"next"`
	Parsed json.RawMessage `json:"parsed,omitempty"`
}

// Parsed is how the server read a one-line entry.
type Parsed struct {
	Title  string         `json:"title"`
	Fields map[string]any `json:"fields"`
}

// Due is what GET /due answers: open tasks grouped by when they are due.
type Due struct {
	Overdue  []Task         `json:"overdue"`
	Today    []Task         `json:"today"`
	Upcoming []Task         `json:"upcoming"`
	Undated  []Task         `json:"undated"`
	Later    []Task         `json:"later"`
	Counts   map[string]int `json:"counts"`
	Date     string         `json:"date"`
}

// Summary is what GET /summary answers. Date is today on the Mac.
type Summary struct {
	Counts Counts `json:"counts"`
	Daily  *struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Tasks []Task `json:"tasks"`
	} `json:"daily"`
	Date string `json:"date"`
}

type APIVersion struct {
	Version  int `json:"version"`
	Revision int `json:"revision"`
}

// Info is what GET /health answers, and GET /info with MinClientVersions added.
type Info struct {
	Status            string            `json:"status"`
	AppVersion        string            `json:"appVersion"`
	APIVersion        APIVersion        `json:"apiVersion"`
	MinClientVersions map[string]string `json:"minClientVersions,omitempty"`
}

// ClaudeSession is what a Claude session on a task is started with: run
// `claude <Args...> -- <Prompt>` in Folder.
type ClaudeSession struct {
	Prompt string   `json:"prompt"`
	Folder string   `json:"folder"` // empty when the app has none to suggest
	Args   []string `json:"args"`
	Claude string   `json:"claude"` // where the app found `claude`, or empty
}

// ListOptions are the filters GET /tasks takes. Empty fields are left out.
type ListOptions struct {
	Status   string // open (default), all, or statuses separated by commas
	Priority string
	Tag      string
	Project  *string // a pointer, because "" means tasks with no project
	Assignee string
	Due      string
	Query    string
	Limit    int
	Offset   int
}
