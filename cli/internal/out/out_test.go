package out

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/exp/golden"

	"todos/internal/api"
)

const today = "2026-10-13" // a Tuesday

func task(t *testing.T, js string) api.Task {
	t.Helper()
	var out api.Task
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func sample(t *testing.T) []api.Task {
	return []api.Task{
		task(t, `{"id":3,"title":"Ship the CLI","status":"in_progress","priority":"high","due":"2026-10-13","project":"todos","tags":[],"assignee":"claude","subtasks":[{"id":1,"title":"a","done":true},{"id":2,"title":"b","done":false}],"comments":2,"rev":4}`),
		task(t, `{"id":12,"title":"Renew passport","status":"todo","priority":"high","due":"2026-10-10","project":"personal","tags":["errand","gov"],"assignee":"me","subtasks":[],"repeat":null,"rev":1}`),
		task(t, `{"id":7,"title":"Tax forms","status":"blocked","priority":"medium","due":"2026-10-16","project":null,"tags":[],"assignee":"me","subtasks":[],"rev":2}`),
		task(t, `{"id":104,"title":"Water the\tplants\nevery week","status":"todo","priority":"low","due":null,"project":null,"tags":[],"assignee":"me","subtasks":[],"repeat":"weekly","rev":1}`),
		task(t, `{"id":5,"title":"Book dentist","status":"done","priority":"medium","due":"2026-10-01","project":null,"tags":[],"assignee":"me","subtasks":[],"completedAt":"2026-10-12T09:00:00.000Z","rev":3}`),
	}
}

func printer(buf *bytes.Buffer, styled bool) *Printer {
	return &Printer{W: buf, Styled: styled, Pretty: styled, Today: today, Width: 100, Dark: true, Loc: time.UTC}
}

func TestRow(t *testing.T) {
	tasks := sample(t)
	for i, want := range []string{
		"3\tin_progress\thigh\t2026-10-13\tShip the CLI",
		"12\ttodo\thigh\t2026-10-10\tRenew passport",
		"7\tblocked\tmedium\t2026-10-16\tTax forms",
		"104\ttodo\tlow\t-\tWater the plants every week", // tabs and line breaks in a title can't break the columns
		"5\tdone\tmedium\t2026-10-01\tBook dentist",
	} {
		if got := Row(&tasks[i]); got != want {
			t.Errorf("row %d: %q, want %q", i, got, want)
		}
	}
}

func TestDueLabel(t *testing.T) {
	for _, c := range []struct {
		due, label string
		late       bool
	}{
		{"", "", false},
		{"2026-10-13", "today", false},
		{"2026-10-14", "tomorrow", false},
		{"2026-10-16", "Fri", false},
		{"2026-10-19", "Mon", false},
		{"2026-10-20", "Oct 20", false},
		{"2026-12-25", "Dec 25", false},
		{"2027-01-05", "2027-01-05", false},
		{"2026-10-12", "1d overdue", true},
		{"2026-09-13", "30d overdue", true},
		{"not a date", "not a date", false},
	} {
		if label, late := DueLabel(c.due, today); label != c.label || late != c.late {
			t.Errorf("DueLabel(%q) = %q, %v; want %q, %v", c.due, label, late, c.label, c.late)
		}
	}
}

var escapes = regexp.MustCompile("\x1b\\[[0-9;]*m")

func TestTasksForAPipe(t *testing.T) {
	var buf bytes.Buffer
	printer(&buf, false).Tasks(sample(t))
	golden.RequireEqual(t, buf.Bytes())
	if bytes.ContainsRune(buf.Bytes(), '\x1b') {
		t.Error("plain output has terminal codes in it")
	}
	// Nothing at all for an empty list: a script gets zero lines, not a message.
	buf.Reset()
	printer(&buf, false).Tasks(nil)
	if buf.Len() != 0 {
		t.Errorf("an empty list printed %q", buf.String())
	}
}

func TestTasksForATerminal(t *testing.T) {
	var buf bytes.Buffer
	printer(&buf, true).Tasks(sample(t))
	golden.RequireEqual(t, buf.Bytes())
	if !bytes.ContainsRune(buf.Bytes(), '\x1b') {
		t.Error("output for a terminal should be styled")
	}
	// The columns line up once the styling is taken away.
	lines := strings.Split(strings.TrimRight(escapes.ReplaceAllString(buf.String(), ""), "\n"), "\n")
	at := strings.Index(lines[0], "In progress")
	for _, line := range lines {
		if !regexp.MustCompile(`^#\d+ +(To do|In progress|Blocked|Done)`).MatchString(line) || strings.IndexAny(line[at:], "TIBD") != 0 {
			t.Errorf("misaligned: %q", line)
		}
	}
	buf.Reset()
	printer(&buf, true).Tasks(nil)
	if !strings.Contains(buf.String(), "Nothing here.") {
		t.Errorf("an empty list on a terminal: %q", buf.String())
	}
}

const full = `{"id":12,"title":"Renew passport","notes":"# Steps\n\nBring **two** photos.\n\n- Form DS-82\n- Old passport","status":"in_progress","priority":"high",
"due":"2026-10-10","project":"personal","tags":["errand"],"assignee":"claude",
"subtasks":[{"id":1,"title":"Book appointment","done":true},{"id":2,"title":"Take photos","done":false}],
"repeat":"yearly","remindAt":"2026-10-09T14:00:00.000Z","remindedAt":"2026-10-09T14:00:03.000Z","rev":9,"createdBy":"me",
"createdAt":"2026-10-01T08:30:00.000Z","updatedAt":"2026-10-12T16:45:00.000Z","completedAt":null,
"activity":[{"at":"2026-10-01T08:30:00.000Z","by":"me","kind":"event","text":"created this task"},
{"at":"2026-10-12T16:40:00.000Z","by":"me","kind":"event","text":"moved To do → In progress","via":"iPhone"},
{"at":"2026-10-12T16:45:00.000Z","by":"claude","kind":"comment","text":"Booked for Friday at 10."}]}`

func TestDetailForAPipe(t *testing.T) {
	var buf bytes.Buffer
	one := task(t, full)
	printer(&buf, false).Detail(&one)
	golden.RequireEqual(t, buf.Bytes())
	if bytes.ContainsRune(buf.Bytes(), '\x1b') {
		t.Error("plain output has terminal codes in it")
	}
	// Notes come out as they were written, for whatever reads them next.
	if !strings.Contains(buf.String(), "Bring **two** photos.") {
		t.Error("the notes should be printed as written")
	}
}

func TestDetailForATerminal(t *testing.T) {
	var buf bytes.Buffer
	one := task(t, full)
	printer(&buf, true).Detail(&one)
	golden.RequireEqual(t, buf.Bytes())
	plain := escapes.ReplaceAllString(buf.String(), "")
	// Notes are rendered: the Markdown markers are gone, the words remain.
	if strings.Contains(plain, "**two**") || !strings.Contains(plain, "two") || !strings.Contains(plain, "Form DS-82") {
		t.Errorf("the notes should be rendered:\n%s", plain)
	}
	for _, want := range []string{"#12 Renew passport", "In progress", "high priority", "due 2026-10-10 (3d overdue)", "#personal", "@errand", "with Claude",
		"repeats yearly", "reminder Oct 9 14:00 (sent)", "rev 9", "Subtasks 1/2", "Book appointment", "you · iPhone", "“Booked for Friday at 10.”"} {
		if !strings.Contains(plain, want) {
			t.Errorf("missing %q in:\n%s", want, plain)
		}
	}
}

func TestChanged(t *testing.T) {
	tasks := sample(t)
	var buf bytes.Buffer
	printer(&buf, false).Changed("Added", &tasks[1])
	if buf.String() != Row(&tasks[1])+"\n" {
		t.Errorf("for a pipe, a change prints the task's row: %q", buf.String())
	}
	buf.Reset()
	printer(&buf, true).Changed("Added", &tasks[1])
	if plain := escapes.ReplaceAllString(buf.String(), ""); plain != "✓ Added #12 Renew passport  due 3d overdue · high · #personal @errand @gov\n" {
		t.Errorf("for a terminal: %q", plain)
	}
}

func TestValue(t *testing.T) {
	var buf bytes.Buffer
	tasks := sample(t)
	if err := printer(&buf, false).Value(map[string]any{"task": tasks[2]}); err != nil {
		t.Fatal(err)
	}
	// One line for a pipe, and the task exactly as the server sent it.
	if strings.Count(buf.String(), "\n") != 1 || !strings.Contains(buf.String(), `"project":null`) {
		t.Errorf("got %q", buf.String())
	}
	buf.Reset()
	printer(&buf, true).Value(map[string]any{"a": 1}) //nolint:errcheck
	if buf.String() != "{\n  \"a\": 1\n}\n" {
		t.Errorf("indented for a terminal: %q", buf.String())
	}
}
