package query

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The cases the app's rules (src/query.js) and the iPhone app's pass too.
const fixture = "../../../test/fixtures/query-cases.json"

type fixtureCase struct {
	Name   string            `json:"name"`
	Tasks  string            `json:"tasks"`
	Today  string            `json:"today"`
	Filter map[string]string `json:"filter"`
	Sort   string            `json:"sort"`
	View   string            `json:"view"`
	Error  string            `json:"error"`
	Expect json.RawMessage   `json:"expect"`
}

// A task as the fixture writes it: the app's JSON, with null where it has none.
type fixtureTask struct {
	ID       int      `json:"id"`
	Title    string   `json:"title"`
	Notes    string   `json:"notes"`
	Status   string   `json:"status"`
	Priority string   `json:"priority"`
	Due      *string  `json:"due"`
	Project  *string  `json:"project"`
	Tags     []string `json:"tags"`
	Assignee string   `json:"assignee"`
	Subtasks []struct {
		Title string `json:"title"`
	} `json:"subtasks"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
	CompletedAt *string `json:"completedAt"`
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (f fixtureTask) task() Task {
	t := Task{ID: f.ID, Title: f.Title, Notes: f.Notes, Status: f.Status, Priority: f.Priority, Assignee: f.Assignee,
		Due: deref(f.Due), Project: deref(f.Project), Tags: f.Tags, CreatedAt: f.CreatedAt, UpdatedAt: f.UpdatedAt, CompletedAt: deref(f.CompletedAt)}
	for _, s := range f.Subtasks {
		t.Subtasks = append(t.Subtasks, s.Title)
	}
	return t
}

func load(t *testing.T) (map[string][]Task, string, []fixtureCase) {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(fixture))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Today    string                      `json:"today"`
		Defaults map[string]any              `json:"defaults"`
		Sets     map[string][]map[string]any `json:"taskSets"`
		Cases    []fixtureCase               `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	sets := map[string][]Task{}
	for name, list := range file.Sets {
		for _, own := range list {
			merged := map[string]any{}
			for k, v := range file.Defaults {
				merged[k] = v
			}
			for k, v := range own {
				merged[k] = v
			}
			raw, _ := json.Marshal(merged)
			var ft fixtureTask
			if err := json.Unmarshal(raw, &ft); err != nil {
				t.Fatal(err)
			}
			sets[name] = append(sets[name], ft.task())
		}
	}
	return sets, file.Today, file.Cases
}

func ids(list []Task) []int {
	out := []int{}
	for _, t := range list {
		out = append(out, t.ID)
	}
	return out
}

func same(t Task) Task { return t }

func TestSharedCases(t *testing.T) {
	sets, today, cases := load(t)
	if len(cases) < 50 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			set := c.Tasks
			if set == "" {
				set = "board"
			}
			// Backwards, so nothing can pass by leaving the tasks in the order they came.
			tasks := slices.Clone(sets[set])
			slices.Reverse(tasks)
			day := c.Today
			if day == "" {
				day = today
			}
			var refused *Error
			switch c.Error {
			case "sort":
				if _, err := ParseSort(c.Sort); !errors.As(err, &refused) {
					t.Fatalf("sort %q: want an error, got %v", c.Sort, err)
				}
				return
			case "filter":
				if _, err := ParseFilter(c.Filter); !errors.As(err, &refused) {
					t.Fatalf("filter %v: want an error, got %v", c.Filter, err)
				}
				return
			case "":
			default:
				t.Fatalf("an error is \"sort\" or \"filter\", not %q", c.Error)
			}
			if c.View == "today" {
				var want struct{ Overdue, Today []int }
				if err := json.Unmarshal(c.Expect, &want); err != nil {
					t.Fatal(err)
				}
				overdue, dueToday := Today(tasks, same, day, TodaySort)
				if got := ids(overdue); !slices.Equal(got, want.Overdue) {
					t.Errorf("overdue: got %v, want %v", got, want.Overdue)
				}
				if got := ids(dueToday); !slices.Equal(got, want.Today) {
					t.Errorf("today: got %v, want %v", got, want.Today)
				}
				return
			}
			if c.View != "" {
				t.Fatalf("the only view is \"today\", not %q", c.View)
			}
			var want []int
			if err := json.Unmarshal(c.Expect, &want); err != nil {
				t.Fatal(err)
			}
			sort, err := ParseSort(c.Sort)
			if err != nil {
				t.Fatal(err)
			}
			filter, err := ParseFilter(c.Filter)
			if err != nil {
				t.Fatal(err)
			}
			if got := ids(Select(tasks, same, filter, sort, day)); !slices.Equal(got, want) {
				t.Errorf("got %v, want %v", got, want)
			}
		})
	}
}

func TestSortText(t *testing.T) {
	s, err := ParseSort(" Due , -PRIORITY ")
	if err != nil || s.String() != "due,-priority" || s.IsDefault() {
		t.Errorf("ParseSort: %v %v", s, err)
	}
	if s, _ := ParseSort(""); !s.IsDefault() || s.String() != "default" {
		t.Errorf("nothing is the default order: %v", s)
	}
	_, err = ParseSort("due,dew")
	if err == nil || err.Error() != `Unknown sort key "dew". Sort by any of: default, status, priority, due, created, updated, completed, title, project, id. Separate keys with commas, and put - in front of one to reverse it, as in "due,-priority".` {
		t.Errorf("the refusal is the app's own: %v", err)
	}
}

func TestInTodayIsTheViewsGroups(t *testing.T) {
	sets, today, _ := load(t)
	overdue, dueToday := Today(sets["board"], same, today, TodaySort)
	in := map[int]bool{}
	for _, task := range append(overdue, dueToday...) {
		in[task.ID] = true
	}
	for _, task := range sets["board"] {
		if InToday(task, today) != in[task.ID] {
			t.Errorf("#%d: InToday says %v", task.ID, !in[task.ID])
		}
	}
}
