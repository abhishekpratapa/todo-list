// Package query is the Todos app's rules for which tasks a list shows and in
// what order (src/query.js in the app), in Go: for the fake server the tests
// use, the board, which sorts and filters what it has loaded, and checking
// --sort before it is sent. The app's rules, this package and the iPhone app's
// all pass the same cases, test/fixtures/query-cases.json in the repository.
//
// A sort is a list of keys, each ascending or descending; as text,
// "due,-priority,created". A filter is a set of fields: values within a field
// are OR'ed, and different fields are AND'ed.
//
// One difference from the app: titles and project names are compared by their
// lowercase letters, not in the reader's language's alphabetical order. The two
// only part for letters outside plain ASCII, which the shared cases avoid.
package query

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Error is a sort or filter the rules don't accept. Its message is the app's own.
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

func errorf(format string, args ...any) error { return &Error{fmt.Sprintf(format, args...)} }

// Task is what the rules look at in a task.
type Task struct {
	ID                                int
	Title, Notes                      string
	Status, Priority, Assignee        string
	Due                               string // YYYY-MM-DD, or empty
	Project                           string // empty for none
	Tags                              []string
	Subtasks                          []string // their titles
	CreatedAt, UpdatedAt, CompletedAt string   // ISO timestamps, or empty
}

var (
	statuses   = []string{"todo", "in_progress", "blocked", "done"}
	open       = []string{"todo", "in_progress", "blocked"}
	priorities = []string{"high", "medium", "low"}
	assignees  = []string{"me", "claude"}
)

// ---------- dates ----------

var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// AddDays is the day n days after day, both YYYY-MM-DD.
func AddDays(day string, n int) string {
	d, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return d.AddDate(0, 0, n).Format("2006-01-02")
}

// ---------- sorting ----------

// Default is the order every list had before sorting could be chosen, and still
// has unless another is picked: in progress, blocked, to do, then done. Open
// tasks go by priority, then due date (undated last); done tasks by most
// recently finished. Ties always go to the lower id.
const Default = "default"

// Keys are what a list can be sorted by.
var Keys = []string{Default, "status", "priority", "due", "created", "updated", "completed", "title", "project", "id"}

// Key is one key of a sort, and which way it runs.
type Key struct {
	Name string
	Desc bool
}

// Sort is an ordered list of keys.
type Sort []Key

// DefaultSort is the default order.
var DefaultSort = Sort{{Name: Default}}

var (
	statusRank   = map[string]int{"in_progress": 0, "blocked": 1, "todo": 2, "done": 3}
	priorityRank = map[string]int{"high": 0, "medium": 1, "low": 2} // so "priority" ascending is most important first
)

// ParseSort reads "due,-priority". Nothing at all is the default order. A key
// that isn't one of Keys is refused, naming the ones there are.
func ParseSort(text string) (Sort, error) {
	var out Sort
	for _, part := range strings.Split(text, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part == "" {
			continue
		}
		desc := strings.HasPrefix(part, "-")
		name := part
		if desc {
			name = strings.TrimSpace(part[1:])
		}
		if !contains(Keys, name) {
			return nil, errorf(`Unknown sort key %q. Sort by any of: %s. Separate keys with commas, and put - in front of one to reverse it, as in "due,-priority".`, name, strings.Join(Keys, ", "))
		}
		if desc && name == Default {
			return nil, errorf(`The default order can't be reversed. Name the keys to sort by instead, as in "-due".`)
		}
		out = append(out, Key{name, desc})
	}
	if len(out) == 0 {
		return DefaultSort, nil
	}
	return out, nil
}

// String is the text form, as ParseSort reads it.
func (s Sort) String() string {
	parts := make([]string, len(s))
	for i, k := range s {
		parts[i] = k.Name
		if k.Desc {
			parts[i] = "-" + k.Name
		}
	}
	return strings.Join(parts, ",")
}

// IsDefault says whether s is the default order.
func (s Sort) IsDefault() bool { return len(s) == 0 || (len(s) == 1 && s[0].Name == Default) }

// value is what a task has for one key: a number or text, or nothing.
type value struct {
	n  int64
	s  string
	ok bool
}

func stamp(iso string) value {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if iso == "" || err != nil {
		return value{}
	}
	return value{n: t.UnixMilli(), ok: true}
}

func valueOf(name string, t Task) value {
	switch name {
	case "status":
		r, ok := statusRank[t.Status]
		return value{n: int64(r), ok: ok}
	case "priority":
		r, ok := priorityRank[t.Priority]
		return value{n: int64(r), ok: ok}
	case "due":
		return value{s: t.Due, ok: t.Due != ""}
	case "created":
		return stamp(t.CreatedAt)
	case "updated":
		return stamp(t.UpdatedAt)
	case "completed":
		return stamp(t.CompletedAt)
	case "title":
		return value{s: strings.ToLower(t.Title), ok: true}
	case "project":
		return value{s: strings.ToLower(t.Project), ok: t.Project != ""}
	}
	return value{n: int64(t.ID), ok: true}
}

// byKey compares two tasks by one key. A task with nothing to compare goes last
// whichever way the key runs: undated tasks stay at the bottom of "due" and of
// "-due" alike.
func byKey(name string, desc bool, a, b Task) int {
	x, y := valueOf(name, a), valueOf(name, b)
	if !x.ok || !y.ok {
		return boolInt(!x.ok) - boolInt(!y.ok)
	}
	c := strings.Compare(x.s, y.s)
	if x.n != y.n {
		c = -1
		if x.n > y.n {
			c = 1
		}
	}
	if desc {
		return -c
	}
	return c
}

func byDefault(a, b Task) int {
	if c := byKey("status", false, a, b); c != 0 {
		return c
	}
	if a.Status == "done" {
		return byKey("completed", true, a, b)
	}
	if c := byKey("priority", false, a, b); c != 0 {
		return c
	}
	return byKey("due", false, a, b)
}

// Compare orders two tasks: below zero when a comes first. The id breaks every
// remaining tie, so the same tasks come out in the same order on every client.
func (s Sort) Compare(a, b Task) int {
	for _, k := range s {
		c := 0
		if k.Name == Default {
			c = byDefault(a, b)
		} else {
			c = byKey(k.Name, k.Desc, a, b)
		}
		if c != 0 {
			return c
		}
	}
	return byKey("id", false, a, b)
}

// Sorted is a sorted copy of items. view says what each item is as a task.
func Sorted[T any](items []T, view func(T) Task, s Sort) []T {
	out := append([]T(nil), items...)
	sort.SliceStable(out, func(i, j int) bool { return s.Compare(view(out[i]), view(out[j])) < 0 })
	return out
}

// ---------- filtering ----------

// DueValues are the words due takes. overdue: open, and due before today.
// week: today through 7 days out. A bare date is everything due on or before
// it; before: and after: leave that day out.
var DueValues = []string{"overdue", "today", "tomorrow", "week", "none", "any"}

// Filter is a filter that ParseFilter has checked. A nil list doesn't narrow
// anything; an empty one matches nothing.
type Filter struct {
	Status, Priority, Assignee, Project, Tag []string
	TagMode                                  string // "any" or "all"
	Due                                      string // empty for any
	Words                                    []string
}

// FilterFields are the fields of a filter, as GET /api/v1/tasks names them.
var FilterFields = []string{"status", "priority", "assignee", "project", "tag", "tagMode", "due", "q"}

// ParseFilter reads a filter given as text, the way GET /api/v1/tasks takes
// it. A field that is missing, or empty, doesn't narrow the list, except
// project, where "" means no project. A field that is given but names nothing
// (",") matches nothing, as the API's filters always have.
func ParseFilter(fields map[string]string) (Filter, error) {
	f := Filter{TagMode: "any"}
	given := func(name string) (string, bool) {
		v, ok := fields[name]
		return v, ok && v != ""
	}
	var err error
	if v, ok := given("status"); ok {
		var list []string
		if list, err = oneOf("status", v, append([]string{"open", "all"}, statuses...)); err != nil {
			return f, err
		}
		f.Status = []string{}
		for _, s := range statuses {
			for _, x := range list {
				if x == s || x == "all" || (x == "open" && contains(open, s)) {
					f.Status = append(f.Status, s)
					break
				}
			}
		}
	}
	if v, ok := given("priority"); ok {
		if f.Priority, err = oneOf("priority", v, priorities); err != nil {
			return f, err
		}
	}
	if v, ok := given("assignee"); ok {
		if f.Assignee, err = oneOf("assignee", v, assignees); err != nil {
			return f, err
		}
	}
	// Projects are separated by commas, and an empty one means "no project". A
	// name with a comma in it still matches as a whole, as it did when this took
	// a single name.
	if v, ok := fields["project"]; ok {
		f.Project = values(v)
		if strings.Contains(v, ",") {
			f.Project = append(f.Project, strings.ToLower(strings.TrimSpace(v)))
		}
	}
	if v, ok := given("tag"); ok {
		f.Tag = []string{}
		for _, tag := range values(v) {
			if strings.HasPrefix(tag, "#") || strings.HasPrefix(tag, "@") {
				tag = tag[1:]
			}
			if tag != "" {
				f.Tag = append(f.Tag, tag)
			}
		}
	}
	if v, ok := given("tagMode"); ok {
		f.TagMode = strings.ToLower(strings.TrimSpace(v))
		if f.TagMode != "any" && f.TagMode != "all" {
			return f, errorf(`Invalid tagMode %q. Expected any or all.`, v)
		}
	}
	if v, ok := given("due"); ok {
		d := strings.ToLower(strings.TrimSpace(v))
		date := d
		if rest, cut := strings.CutPrefix(d, "before:"); cut {
			date = rest
		} else if rest, cut := strings.CutPrefix(d, "after:"); cut {
			date = rest
		}
		if !contains(DueValues, d) && !dateRE.MatchString(date) {
			return f, errorf(`Invalid due %q. Expected overdue, today, tomorrow, week, none, any, before:YYYY-MM-DD, after:YYYY-MM-DD, or a date YYYY-MM-DD (due on or before it).`, v)
		}
		f.Due = d
	}
	if v, ok := given("q"); ok {
		f.Words = strings.Fields(strings.ToLower(v))
	}
	return f, nil
}

// values splits text at commas: each value trimmed and lowercased.
func values(v string) []string {
	parts := strings.Split(v, ",")
	for i, p := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(p))
	}
	return parts
}

func oneOf(field, v string, allowed []string) ([]string, error) {
	out := []string{}
	for _, x := range values(v) {
		if x == "" {
			continue
		}
		if !contains(allowed, x) {
			return nil, errorf("Invalid %s %q. Expected one of: %s.", field, x, strings.Join(allowed, ", "))
		}
		out = append(out, x)
	}
	return out, nil
}

func (f Filter) dueMatches(t Task, today string) bool {
	switch f.Due {
	case "overdue":
		return t.Due != "" && t.Due < today && t.Status != "done"
	case "today":
		return t.Due == today
	case "tomorrow":
		return t.Due == AddDays(today, 1)
	case "week":
		return t.Due != "" && t.Due >= today && t.Due <= AddDays(today, 7)
	case "none":
		return t.Due == ""
	case "any":
		return t.Due != ""
	}
	if t.Due == "" {
		return false
	}
	if day, ok := strings.CutPrefix(f.Due, "before:"); ok {
		return t.Due < day
	}
	if day, ok := strings.CutPrefix(f.Due, "after:"); ok {
		return t.Due > day
	}
	return t.Due <= f.Due
}

func searchText(t Task) string {
	parts := append([]string{t.Title, t.Notes, t.Project}, t.Tags...)
	return strings.ToLower(strings.Join(append(parts, t.Subtasks...), "\n"))
}

func (f Filter) tagsMatch(t Task) bool {
	for _, tag := range f.Tag {
		has := contains(t.Tags, tag)
		if f.TagMode == "all" && !has {
			return false
		}
		if f.TagMode != "all" && has {
			return true
		}
	}
	return f.TagMode == "all"
}

// Matches says whether a task passes the filter, with today as YYYY-MM-DD.
func (f Filter) Matches(t Task, today string) bool {
	if (f.Status != nil && !contains(f.Status, t.Status)) ||
		(f.Priority != nil && !contains(f.Priority, t.Priority)) ||
		(f.Assignee != nil && !contains(f.Assignee, t.Assignee)) ||
		(f.Project != nil && !contains(f.Project, strings.ToLower(t.Project))) ||
		(f.Tag != nil && !f.tagsMatch(t)) ||
		(f.Due != "" && !f.dueMatches(t, today)) {
		return false
	}
	if len(f.Words) > 0 {
		text := searchText(t)
		for _, w := range f.Words {
			if !strings.Contains(text, w) {
				return false
			}
		}
	}
	return true
}

// Select is the items that pass the filter, in the sort's order.
func Select[T any](items []T, view func(T) Task, f Filter, s Sort, today string) []T {
	var out []T
	for _, item := range items {
		if f.Matches(view(item), today) {
			out = append(out, item)
		}
	}
	return Sorted(out, view, s)
}

// ---------- views ----------

// TodaySort is the Today view's order: most important first, then oldest first.
var TodaySort = Sort{{Name: "priority"}, {Name: "due"}}

var (
	overdueNow = Filter{Status: open, TagMode: "any", Due: "overdue"}
	dueNow     = Filter{Status: open, TagMode: "any", Due: "today"}
)

// Today is the Today view: open tasks that are overdue, and open tasks due
// today, each in sort's order (TodaySort for the view's own). Between them they
// are what the Mac's Dock badge and menu bar count as due now.
func Today[T any](items []T, view func(T) Task, today string, s Sort) (overdue, dueToday []T) {
	return Select(items, view, overdueNow, s, today), Select(items, view, dueNow, s, today)
}

// InToday says whether a task is in the Today view.
func InToday(t Task, today string) bool {
	return overdueNow.Matches(t, today) || dueNow.Matches(t, today)
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
