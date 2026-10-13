package integration

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"todos/internal/api"
)

func rows(out string) [][]string {
	var all [][]string
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line != "" {
			all = append(all, strings.Split(line, "\t"))
		}
	}
	return all
}

func decode[T any](t *testing.T, text string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatalf("not JSON (%v): %s", err, text)
	}
	return v
}

func TestStatus(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		out := ok(t, b.env, "status")
		transport := "https"
		if b.local {
			transport = "socket"
			if !strings.Contains(out, "profile  local") {
				t.Errorf("status should name the local profile:\n%s", out)
			}
		} else if !strings.Contains(out, "profile  hub") {
			t.Errorf("status should name the paired profile:\n%s", out)
		}
		got := decode[map[string]any](t, ok(t, b.env, "status", "--json"))
		if got["transport"] != transport || got["cliVersion"] == "" || got["appVersion"] == "" {
			t.Errorf("status --json: %v", got)
		}
		if rev := got["apiVersion"].(map[string]any)["revision"].(float64); rev < 4 {
			t.Errorf("API revision %v", rev)
		}
	})
}

func TestAddListShow(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		// add: the line is read by the server; the row comes back.
		added := rows(ok(t, b.env, "add", "Renew passport tomorrow !high #personal @errand"))
		if len(added) != 1 || len(added[0]) != 5 || added[0][1] != "todo" || added[0][2] != "high" || added[0][4] != "Renew passport" {
			t.Fatalf("add printed %v", added)
		}
		id := added[0][0]

		// add --json: the task and how the line was read.
		res := decode[map[string]json.RawMessage](t, ok(t, b.env, "add", "--json", "Buy", "milk", "@shop"))
		task := decode[api.Task](t, string(res["task"]))
		if task.Title != "Buy milk" || len(task.Tags) != 1 || task.Tags[0] != "shop" || res["parsed"] == nil {
			t.Fatalf("add --json: %s", res)
		}
		if _, has := res["next"]; !has {
			t.Errorf("a change's JSON always has \"next\": %v", res)
		}

		// add -: one task per line of standard input.
		r := run(t, b.env, "First from a pipe\n\nSecond from a pipe !low\n", "add", "-")
		if r.code != 0 || len(rows(r.stdout)) != 2 {
			t.Fatalf("add -: exit %d, %q %q", r.code, r.stdout, r.stderr)
		}

		// ls: open tasks, one row each, high priority first.
		list := rows(ok(t, b.env, "ls"))
		if len(list) != 4 || list[0][4] != "Renew passport" {
			t.Fatalf("ls: %v", list)
		}
		for _, row := range list {
			if len(row) != 5 {
				t.Fatalf("a row has five fields: %v", row)
			}
		}

		// Filters.
		for _, c := range []struct {
			args []string
			want int
		}{
			{[]string{"--priority", "high"}, 1},
			{[]string{"--priority", "high,low"}, 2},
			{[]string{"--tag", "errand"}, 1},
			{[]string{"--project", "personal"}, 1},
			{[]string{"--project", ""}, 3},
			{[]string{"--search", "pipe"}, 2},
			{[]string{"-s", "second pipe"}, 1},
			{[]string{"--due", "week"}, 1},
			{[]string{"--due", "none"}, 3},
			{[]string{"--due", "overdue"}, 0},
			{[]string{"--status", "done"}, 0},
			{[]string{"--status", "todo"}, 4},
			{[]string{"--all"}, 4},
			{[]string{"--assignee", "claude"}, 0},
			{[]string{"-n", "2"}, 2},
		} {
			if got := rows(ok(t, b.env, append([]string{"ls"}, c.args...)...)); len(got) != c.want {
				t.Errorf("ls %v: %d rows, want %d: %v", c.args, len(got), c.want, got)
			}
		}

		// ls --json is the API's own answer.
		listed := decode[map[string]json.RawMessage](t, ok(t, b.env, "ls", "--json"))
		for _, key := range []string{"tasks", "total", "summary", "version"} {
			if listed[key] == nil {
				t.Errorf("ls --json has no %q", key)
			}
		}
		tasks := decode[[]map[string]any](t, string(listed["tasks"]))
		for _, field := range []string{"id", "title", "notes", "status", "priority", "due", "project", "tags", "assignee", "subtasks", "repeat", "remindAt", "rev", "createdAt", "updatedAt", "completedAt", "comments"} {
			if _, has := tasks[0][field]; !has {
				t.Errorf("a listed task has no %q: %v", field, tasks[0])
			}
		}
		summary := decode[map[string]int](t, string(listed["summary"]))
		if summary["open"] != 4 {
			t.Errorf("summary: %v", summary)
		}

		// A bad filter is the server's to refuse, as a usage error.
		fails(t, b.env, 2, "Invalid", "ls", "--status", "nonsense")

		// show: by number, by #number, and by words from the title.
		for _, ref := range []string{id, "#" + id, "passport", "RENEW pass"} {
			shown := ok(t, b.env, "show", ref)
			if !strings.Contains(shown, "Renew passport") || !strings.Contains(shown, "high priority") || !strings.Contains(shown, "#personal") || !strings.Contains(shown, "@errand") {
				t.Errorf("show %s:\n%s", ref, shown)
			}
		}
		one := decode[map[string]api.Task](t, ok(t, b.env, "show", id, "--json"))["task"]
		if fmt.Sprint(one.ID) != id || len(one.Activity) == 0 {
			t.Errorf("show --json: %+v", one)
		}

		// due: what the menu bar shows. The task due tomorrow is in "upcoming".
		due := decode[map[string]json.RawMessage](t, ok(t, b.env, "due", "--json"))
		for _, key := range []string{"overdue", "today", "upcoming", "undated", "later", "counts", "date"} {
			if due[key] == nil {
				t.Errorf("due --json has no %q", key)
			}
		}
		if upcoming := decode[[]api.Task](t, string(due["upcoming"])); len(upcoming) != 1 || upcoming[0].Title != "Renew passport" {
			t.Errorf("due --json upcoming: %s", due["upcoming"])
		}
		if got := rows(ok(t, b.env, "due")); len(got) != 4 || got[0][4] != "Renew passport" {
			t.Errorf("due: %v", got)
		}
	})
}

func TestNotFoundAndAmbiguous(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		b.add(t, "Call the bank")
		b.add(t, "Call the dentist")
		fails(t, b.env, 3, `(?i)no todo with id #999|no such`, "show", "999")
		fails(t, b.env, 3, "no task's title matches", "show", "nothing like this")
		r := fails(t, b.env, 2, `"call" matches 2 tasks`, "done", "call")
		if !strings.Contains(r.stderr, "Call the bank") || !strings.Contains(r.stderr, "Call the dentist") {
			t.Errorf("the candidates should be listed: %s", r.stderr)
		}
		// With --json the error is an object on stderr, and nothing on stdout.
		r = run(t, b.env, "", "show", "999", "--json")
		if r.code != 3 || r.stdout != "" {
			t.Fatalf("exit %d, stdout %q", r.code, r.stdout)
		}
		e := decode[map[string]map[string]any](t, r.stderr)["error"]
		if e["code"] != "not_found" || e["message"] == "" {
			t.Errorf("error object: %v", e)
		}
		// An exact title is not ambiguous even when it is part of another.
		b.add(t, "Call")
		ok(t, b.env, "done", "call")
	})
}

func TestStatusChanges(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		a, c := b.add(t, "Write the report"), b.add(t, "Send the report")
		id := fmt.Sprint(a.ID)

		if got := rows(ok(t, b.env, "start", id)); got[0][1] != "in_progress" {
			t.Errorf("start: %v", got)
		}
		if got := rows(ok(t, b.env, "block", id, "-m", "Waiting for numbers")); got[0][1] != "blocked" {
			t.Errorf("block: %v", got)
		}
		blocked := b.get(t, a.ID)
		if last := blocked.Activity[len(blocked.Activity)-1]; last.Kind != "comment" || last.Text != "Waiting for numbers" {
			t.Errorf("block -m should leave a comment: %+v", last)
		}
		if got := rows(ok(t, b.env, "reopen", id)); got[0][1] != "todo" {
			t.Errorf("reopen: %v", got)
		}

		// Several at once: one row each, or one JSON object a line.
		lines := strings.Split(strings.TrimSpace(ok(t, b.env, "done", id, fmt.Sprint(c.ID), "-m", "Both sent", "--json")), "\n")
		if len(lines) != 2 {
			t.Fatalf("done with two tasks prints two objects: %v", lines)
		}
		for _, line := range lines {
			if res := decode[api.TaskResult](t, line); res.Task.Status != "done" {
				t.Errorf("done: %s", line)
			}
		}
		if got := rows(ok(t, b.env, "ls")); len(got) != 0 {
			t.Errorf("nothing should be open: %v", got)
		}
		if got := rows(ok(t, b.env, "ls", "--status", "done")); len(got) != 2 {
			t.Errorf("two should be done: %v", got)
		}

		// How changes are labelled in the task's history.
		done := b.get(t, a.ID)
		via := done.Activity[len(done.Activity)-1].Via
		if b.local && via != "command line" {
			t.Errorf("a change through the socket is labelled %q, want \"command line\"", via)
		}
		if !b.local && !strings.HasPrefix(via, "todos on ") {
			t.Errorf("a change from another machine is labelled %q, want \"todos on <host>\"", via)
		}
	})
}

func TestRepeatingTask(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Water the plants")
		id := fmt.Sprint(task.ID)
		ok(t, b.env, "edit", id, "--repeat", "weekly", "--due", "today")
		res := decode[api.TaskResult](t, ok(t, b.env, "done", id, "--json"))
		if res.Next == nil || res.Next.Status != "todo" || res.Next.Due == "" || res.Next.Repeat != "weekly" {
			t.Fatalf("finishing a repeating task makes the next one: %+v", res.Next)
		}
		if got := rows(ok(t, b.env, "ls")); len(got) != 1 || got[0][0] != fmt.Sprint(res.Next.ID) {
			t.Errorf("the next occurrence should be open: %v", got)
		}
	})
}

func TestEdit(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Plan the trip")
		id := fmt.Sprint(task.ID)

		row := rows(ok(t, b.env, "edit", id, "--title", "Plan the Lisbon trip", "--due", "2031-05-06", "--priority", "low",
			"--project", "travel", "--tags", "fun, summer", "--assignee", "claude", "--status", "in_progress"))[0]
		if row[1] != "in_progress" || row[2] != "low" || row[3] != "2031-05-06" || row[4] != "Plan the Lisbon trip" {
			t.Errorf("edit: %v", row)
		}
		got := b.get(t, task.ID)
		if got.Project != "travel" || strings.Join(got.Tags, ",") != "fun,summer" || got.Assignee != "claude" {
			t.Errorf("after edit: %+v", got)
		}

		// Notes from standard input; an empty value clears a field.
		r := run(t, b.env, "# Ideas\n\n- Tram 28\n", "edit", id, "--notes", "-", "--due", "", "--tags", "")
		if r.code != 0 {
			t.Fatalf("edit --notes -: %d %s", r.code, r.stderr)
		}
		got = b.get(t, task.ID)
		if got.Notes != "# Ideas\n\n- Tram 28" || got.Due != "" || len(got.Tags) != 0 {
			t.Errorf("after edit --notes -: %+v", got)
		}
		if shown := ok(t, b.env, "show", id); !strings.Contains(shown, "- Tram 28") {
			t.Errorf("show should print the notes as written when piped:\n%s", shown)
		}

		// The server reads dates, so it is the one to refuse a bad one.
		fails(t, b.env, 2, "(?i)due date", "edit", id, "--due", "not a date at all")
		fails(t, b.env, 2, "nothing to change", "edit", id)
		fails(t, b.env, 2, "--priority", "edit", id, "--priority")
	})
}

func TestConflicts(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Shared task")
		id := fmt.Sprint(task.ID)

		// Based on a revision that has since moved on: refused, nothing changed.
		ok(t, b.env, "edit", id, "--priority", "high") // now at a later revision
		stale := fmt.Sprint(task.Rev)
		r := fails(t, b.env, 4, "changed", "edit", id, "--title", "Mine", "--rev", stale)
		if r.stdout != "" {
			t.Errorf("a refused change prints nothing on stdout: %q", r.stdout)
		}
		if got := b.get(t, task.ID); got.Title != "Shared task" {
			t.Errorf("the title was overwritten: %q", got.Title)
		}

		// With --json the error carries the task as it is now.
		r = run(t, b.env, "", "edit", id, "--title", "Mine", "--rev", stale, "--json")
		if r.code != 4 {
			t.Fatalf("exit %d: %s", r.code, r.stderr)
		}
		e := decode[map[string]map[string]json.RawMessage](t, r.stderr)["error"]
		if current := decode[api.Task](t, string(e["current"])); current.Priority != "high" || string(e["code"]) != `"conflict"` {
			t.Errorf("conflict error: %s", r.stderr)
		}

		// The same goes for the status commands and for deleting.
		fails(t, b.env, 4, "changed", "start", id, "--rev", stale)
		// --force overwrites, and says so by succeeding.
		ok(t, b.env, "edit", id, "--title", "Forced", "--force")
		if got := b.get(t, task.ID); got.Title != "Forced" || got.Priority != "high" {
			t.Errorf("after --force: %+v", got)
		}
		// With the right revision it goes through.
		current := b.get(t, task.ID)
		ok(t, b.env, "edit", id, "--title", "Based on the latest", "--rev", fmt.Sprint(current.Rev))
	})
}

func TestRemove(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Delete me")
		id := fmt.Sprint(task.ID)
		// No terminal to ask on: refuse, rather than wait or delete.
		fails(t, b.env, 2, "--yes", "rm", id)
		b.get(t, task.ID)

		res := decode[map[string]map[string]any](t, ok(t, b.env, "rm", id, "--yes", "--json"))
		if res["deleted"]["title"] != "Delete me" || fmt.Sprint(res["deleted"]["id"]) != id {
			t.Errorf("rm --json: %v", res)
		}
		fails(t, b.env, 3, "", "show", id)
		fails(t, b.env, 3, "", "rm", id, "--yes")

		other := b.add(t, "Delete me too")
		if out := strings.TrimSpace(ok(t, b.env, "rm", "-y", "delete me too")); out != fmt.Sprint(other.ID) {
			t.Errorf("rm prints the id it deleted, got %q", out)
		}
	})
}

func TestSubtasksAndComments(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		task := b.add(t, "Renew passport")
		id := fmt.Sprint(task.ID)

		ok(t, b.env, "sub", "add", id, "Book appointment", "Take photos", "Fill in form")
		if got := b.get(t, task.ID); len(got.Subtasks) != 3 || got.Subtasks[1].Title != "Take photos" {
			t.Fatalf("after sub add: %+v", got.Subtasks)
		}
		ok(t, b.env, "sub", "done", id, "1", "photos") // by number and by title
		if got := b.get(t, task.ID); !got.Subtasks[0].Done || !got.Subtasks[1].Done || got.Subtasks[2].Done {
			t.Errorf("after sub done: %+v", got.Subtasks)
		}
		ok(t, b.env, "sub", "undo", id, "1")
		ok(t, b.env, "sub", "rm", id, "form")
		got := b.get(t, task.ID)
		if len(got.Subtasks) != 2 || got.Subtasks[0].Done || !got.Subtasks[1].Done {
			t.Errorf("after undo and rm: %+v", got.Subtasks)
		}
		shown := ok(t, b.env, "show", id)
		if !strings.Contains(shown, "Subtasks 1/2") || !strings.Contains(shown, "[x] 2 Take photos") || !strings.Contains(shown, "[ ] 1 Book appointment") {
			t.Errorf("show:\n%s", shown)
		}

		fails(t, b.env, 3, "no subtask", "sub", "done", id, "9")
		fails(t, b.env, 3, "no subtask matching", "sub", "done", id, "nothing")
		// A mistyped subtask means none of them is changed.
		fails(t, b.env, 3, "no subtask", "sub", "done", id, "1", "9")
		if got := b.get(t, task.ID); got.Subtasks[0].Done {
			t.Errorf("subtask 1 was checked although the command failed")
		}

		ok(t, b.env, "comment", id, "Called", "them,", "waiting")
		r := run(t, b.env, "From a pipe\n", "comment", id, "-")
		if r.code != 0 {
			t.Fatalf("comment -: %d %s", r.code, r.stderr)
		}
		got = b.get(t, task.ID)
		var comments []string
		for _, entry := range got.Activity {
			if entry.Kind == "comment" {
				comments = append(comments, entry.Text)
			}
		}
		if strings.Join(comments, "|") != "Called them, waiting|From a pipe" {
			t.Errorf("comments: %v", comments)
		}
		if shown := ok(t, b.env, "show", id); !strings.Contains(shown, "“Called them, waiting”") {
			t.Errorf("show should list comments:\n%s", shown)
		}
		fails(t, b.env, 2, "", "comment", id)
	})
}

func TestUsageErrors(t *testing.T) {
	b := fakeSocket(t)
	fails(t, b.env, 2, "unknown command", "frobnicate")
	fails(t, b.env, 2, "unknown flag", "ls", "--nope")
	fails(t, b.env, 2, "takes no arguments", "ls", "extra")
	fails(t, b.env, 2, "which task", "show")
	fails(t, b.env, 2, "nothing to add", "add")
	if out := ok(t, b.env, "version"); !strings.HasPrefix(out, "todos 0.") {
		t.Errorf("version: %q", out)
	}
	if out := ok(t, b.env, "--version"); !strings.Contains(out, "0.") {
		t.Errorf("--version: %q", out)
	}
	if out := ok(t, b.env, "--help"); !strings.Contains(out, "add") || !strings.Contains(out, "pair") {
		t.Errorf("--help:\n%s", out)
	}
}
