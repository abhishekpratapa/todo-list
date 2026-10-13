package tui

import (
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/exp/golden"

	"todos/internal/api"
	"todos/internal/fakeserver"
)

// keys sends named keys ("enter", "tab") or single characters to the running board.
func (r *running) keys(names ...string) {
	for _, name := range names {
		if msg, ok := special[name]; ok {
			r.Send(msg)
		} else {
			r.Type(name)
		}
		// A form moves between its fields with messages of its own. Keys sent
		// faster than a person types would overtake them.
		if f := r.latest.Load(); f != nil && f.m.edit.mode == editForm {
			time.Sleep(40 * time.Millisecond)
		}
	}
}

// flash waits for the status line to say what a change did.
func (r *running) flash(t *testing.T, text string) *frame {
	t.Helper()
	return r.until(t, "the status line to say "+text, func(f *frame) bool { return strings.Contains(f.m.flash, text) })
}

func (r *running) task(t *testing.T, id int) fakeserver.Task {
	t.Helper()
	task, ok := r.fake.Task(id)
	if !ok {
		t.Fatalf("the server has no task #%d", id)
	}
	return task
}

func comments(task fakeserver.Task) []string {
	var out []string
	for _, a := range task.Activity {
		if a.Kind == "comment" {
			out = append(out, a.Text)
		}
	}
	return out
}

func TestQuickCapture(t *testing.T) {
	r := start(t, 120, 30, func(f *fakeserver.Server) { f.Add("Already here") })
	r.waitFor(t, "Already here")
	r.keys("a")
	r.waitFor(t, "add ›")
	// Letters are text here, not commands: this line has a q, an x and a d in it.
	r.Type("Fix squeaky door tomorrow !high #home @diy")
	// The app says how it reads the line, as it is typed.
	f := r.until(t, "the preview", func(f *frame) bool { return strings.Contains(f.screen, "→ Fix squeaky door") })
	for _, want := range []string{"· due 20", "· high", "· #home", "· @diy"} {
		if !strings.Contains(f.screen, want) {
			t.Errorf("the preview should show %q:\n%s", want, f.screen)
		}
	}
	if len(r.fake.Tasks()) != 1 {
		t.Fatal("nothing is added until enter")
	}
	r.keys("enter")
	f = r.flash(t, "Added #2 Fix squeaky door")
	got := r.task(t, 2)
	if got.Title != "Fix squeaky door" || got.Priority != "high" || got.Due == nil || *got.Project != "home" || strings.Join(got.Tags, ",") != "diy" {
		t.Errorf("the server has %+v", got)
	}
	// The new card is the selected one, and it is labelled as coming from the command line.
	if s := f.m.selected(); s == nil || s.ID != 2 {
		t.Errorf("selected after adding: %+v", s)
	}
	if got.Activity[0].Via != "command line" {
		t.Errorf("labelled %q", got.Activity[0].Via)
	}

	// Esc cancels, and an empty line adds nothing.
	r.keys("a")
	r.Type("Never mind")
	r.keys("esc", "a", "enter", "esc")
	r.until(t, "the box to close", func(f *frame) bool { return !f.m.edit.active() })
	if len(r.fake.Tasks()) != 2 {
		t.Errorf("%d tasks after a cancelled capture", len(r.fake.Tasks()))
	}
}

func TestMovingCards(t *testing.T) {
	r := start(t, 120, 30, func(f *fakeserver.Server) {
		f.Add("First card")
		f.Add("Second card")
	})
	r.waitFor(t, "Second card")
	status := func(want string) {
		t.Helper()
		f := r.until(t, "the card to be "+want, func(f *frame) bool {
			return r.task(t, 1).Status == want && f.m.selected() != nil && f.m.selected().ID == 1 && f.m.selected().Status == want
		})
		if f.m.col != column(want) {
			t.Errorf("the selection should follow the card to its column: in %d, want %d", f.m.col, column(want))
		}
	}
	r.keys("L")
	status("in_progress")
	r.keys("L")
	status("blocked")
	r.keys("H")
	status("in_progress")
	r.keys("H")
	status("todo")
	r.keys("H") // already in the first column: nothing to do
	r.keys("s")
	status("in_progress")
	r.keys("b")
	status("blocked")
	r.keys("x")
	status("done")
	r.keys("H") // out of Done again
	status("blocked")
	for _, a := range r.task(t, 1).Activity[1:] {
		if a.Kind != "event" || !strings.Contains(a.Text, "moved") {
			t.Errorf("history: %+v", a)
		}
	}
}

func TestCommentsAndSubtasks(t *testing.T) {
	r := start(t, 130, 34, func(f *fakeserver.Server) { f.Add("Renew passport") })
	r.waitFor(t, "Renew passport")

	// A comment from the board.
	r.keys("c")
	r.waitFor(t, "comment ›")
	r.Type("Called them")
	r.keys("enter")
	r.flash(t, "Commented on #1")

	// The rest from the open task.
	r.keys("enter")
	r.waitFor(t, "“Called them”")
	for _, title := range []string{"Book appointment", "Take photos", "Fill in the form"} {
		r.keys("+")
		r.waitFor(t, "subtask ›")
		r.Type(title)
		r.keys("enter")
		r.waitFor(t, title)
	}
	r.waitFor(t, "Subtasks 0/3")
	r.keys("space") // checks off the next one
	r.waitFor(t, "Subtasks 1/3")
	r.keys("3") // by number
	r.waitFor(t, "Subtasks 2/3")
	r.keys("1") // and off again
	r.waitFor(t, "Subtasks 1/3")
	r.keys("space", "9") // the next unchecked one; and a number no subtask has
	f := r.waitFor(t, "Subtasks 2/3")
	got := r.task(t, 1)
	if !got.Subtasks[0].Done || got.Subtasks[1].Done || !got.Subtasks[2].Done || len(got.Subtasks) != 3 {
		t.Errorf("subtasks on the server: %+v", got.Subtasks)
	}
	if c := comments(got); len(c) != 1 || c[0] != "Called them" {
		t.Errorf("comments: %v", c)
	}
	if f.m.detail == nil {
		t.Error("the task should still be open")
	}
	// Finished from the detail.
	r.keys("x")
	r.until(t, "it to be done", func(*frame) bool { return r.task(t, 1).Status == "done" })
}

func TestDeleting(t *testing.T) {
	r := start(t, 120, 30, func(f *fakeserver.Server) {
		f.Add("Keep me")
		f.Add("Delete me")
	})
	r.waitFor(t, "Delete me")
	r.keys("j", "d")
	r.waitFor(t, "Delete #2 “Delete me”?")
	r.keys("n")
	r.until(t, "the question to go", func(f *frame) bool { return !f.m.edit.active() })
	if _, still := r.fake.Task(2); !still {
		t.Fatal("answering n deleted it")
	}
	// Any other key is not a yes.
	r.keys("d", "x", "enter", "esc")
	r.until(t, "the question to go", func(f *frame) bool { return !f.m.edit.active() })
	if _, still := r.fake.Task(2); !still {
		t.Fatal("only y deletes")
	}

	// It changes between the question and the answer: it is not deleted.
	var once sync.Once
	r.fake.Configure(func(f *fakeserver.Server) {
		f.Hook = func(req fakeserver.Request) {
			if req.Method == "DELETE" {
				once.Do(func() {
					r.fake.Touch(2, "claude", "edited notes", func(t *fakeserver.Task) { t.Notes = "I still need this" })
				})
			}
		}
	})
	r.keys("d", "y")
	r.until(t, "the refusal", func(f *frame) bool { return strings.Contains(f.m.notice, "was not deleted") })
	if _, still := r.fake.Task(2); !still {
		t.Fatal("a task that changed after the question was deleted anyway")
	}

	r.until(t, "the list to be current", func(f *frame) bool { s := f.m.selected(); return s != nil && s.ID == 2 && s.Rev == 2 && !f.m.loading })
	r.keys("d", "y")
	f := r.flash(t, "Deleted #2 Delete me")
	if _, still := r.fake.Task(2); still {
		t.Error("y should delete")
	}
	if strings.Contains(strings.Join(strings.Split(f.screen, "\n")[:6], "\n"), "Delete me") {
		t.Errorf("the card should be gone at once:\n%s", f.screen)
	}
	if s := f.m.selected(); s == nil || s.ID != 1 {
		t.Errorf("the selection should land on what is left: %+v", s)
	}
}

func TestEditingFields(t *testing.T) {
	r := start(t, 120, 34, func(f *fakeserver.Server) {
		f.Add("Plan the trip", func(t *fakeserver.Task) { project := "travel"; t.Project = &project; t.Tags = []string{"fun"} })
	})
	r.waitFor(t, "Plan the trip")
	r.keys("e")
	f := r.waitFor(t, "Edit #1")
	for _, want := range []string{"Title", "Plan the trip", "Due", "Priority", "medium", "Project", "travel", "Tags", "fun", "Repeats", "never", "Reminder"} {
		if !strings.Contains(f.screen, want) {
			t.Errorf("the form should show %q:\n%s", want, f.screen)
		}
	}
	r.Type(" to Lisbon") // the title
	r.keys("tab")        // due
	time.Sleep(40 * time.Millisecond)
	r.Type("tomorrow")    // read by the app, not here
	r.keys("tab", "left") // priority: medium -> high
	r.keys("tab", "tab")  // project, tags
	time.Sleep(40 * time.Millisecond)
	r.Type(", summer")            //
	r.keys("tab", "tab", "right") // with; repeats: never -> daily
	r.keys("tab", "enter")        // reminder (left empty); save
	r.flash(t, "Updated #1 Plan the trip to Lisbon")
	got := r.task(t, 1)
	if got.Title != "Plan the trip to Lisbon" || got.Priority != "high" || got.Due == nil || strings.Join(got.Tags, ",") != "fun,summer" || got.Repeat == nil || *got.Repeat != "daily" || *got.Project != "travel" {
		t.Errorf("the server has %+v (due %v, repeat %v)", got, got.Due, got.Repeat)
	}
	// Only what was changed was sent: a field left alone is not in the request.
	var sent string
	for _, req := range r.fake.Requests() {
		if req.Method == "PATCH" {
			sent = req.Body
		}
	}
	if strings.Contains(sent, "project") || strings.Contains(sent, "assignee") || !strings.Contains(sent, `"due":"tomorrow"`) {
		t.Errorf("the request carried: %s", sent)
	}

	// Esc leaves without saving; saving with nothing changed sends nothing.
	patches := func() int {
		n := 0
		for _, req := range r.fake.Requests() {
			if req.Method == "PATCH" {
				n++
			}
		}
		return n
	}
	before := patches()
	r.keys("e")
	r.waitFor(t, "Edit #1")
	r.Type("zzz")
	r.keys("esc")
	r.until(t, "the form to close", func(f *frame) bool { return !f.m.edit.active() })
	r.keys("e")
	r.waitFor(t, "Edit #1")
	r.keys("enter", "enter", "enter", "enter", "enter", "enter", "enter", "enter")
	r.flash(t, "Nothing was changed")
	if patches() != before || r.task(t, 1).Title != "Plan the trip to Lisbon" {
		t.Errorf("%d requests were sent for edits that changed nothing", patches()-before)
	}

	// A title can't be emptied.
	r.keys("e")
	r.waitFor(t, "Edit #1")
	for i := 0; i < 30; i++ {
		r.keys("backspace")
	}
	r.keys("enter")
	r.waitFor(t, "a task needs a title")
}

// editing opens the form on task 1 and types a new ending for its title.
func editing(t *testing.T, r *running, typed string) {
	t.Helper()
	r.keys("e")
	r.waitFor(t, "Edit #1")
	r.Type(typed)
}

func submit(r *running) {
	r.keys("enter", "enter", "enter", "enter", "enter", "enter", "enter", "enter")
}

func TestTheTaskChangesWhileItIsBeingEdited(t *testing.T) {
	seed := func(f *fakeserver.Server) { f.Add("Shared task") }

	t.Run("a different field: both changes stand", func(t *testing.T) {
		r := start(t, 120, 34, seed)
		r.waitFor(t, "Shared task")
		editing(t, r, " (mine)")
		r.fake.Touch(1, "claude", "set priority to high", func(t *fakeserver.Task) { t.Priority = "high" })
		// The form says so, and offers to load the new version.
		r.waitFor(t, "#1 was changed elsewhere while you edit. ctrl+r loads the new version")
		submit(r)
		r.flash(t, "Updated #1 Shared task (mine)")
		if got := r.task(t, 1); got.Title != "Shared task (mine)" || got.Priority != "high" {
			t.Errorf("both changes should stand: %+v", got)
		}
	})

	t.Run("the same field: nothing is overwritten until a choice is made", func(t *testing.T) {
		for choice, want := range map[string]string{"t": "Theirs", "o": "Shared task (mine)"} {
			r := start(t, 120, 34, seed)
			r.waitFor(t, "Shared task")
			editing(t, r, " (mine)")
			r.fake.Touch(1, "me", "renamed", func(t *fakeserver.Task) { t.Title = "Theirs"; t.Priority = "low" })
			r.waitFor(t, "was changed elsewhere")
			submit(r)
			f := r.waitFor(t, "was changed by someone else while you were changing it")
			if got := r.task(t, 1).Title; got != "Theirs" {
				t.Fatalf("the title was overwritten before any choice was made: %q", got)
			}
			for _, wantText := range []string{"Nothing has been saved", "yours", "theirs (as it is now)", "Shared task (mine)", "Theirs", "save mine over theirs", "keep theirs"} {
				if !strings.Contains(f.screen, wantText) {
					t.Errorf("the conflict should show %q:\n%s", wantText, f.screen)
				}
			}
			r.keys(choice)
			r.until(t, "the choice to take effect", func(f *frame) bool { return !f.m.edit.active() && !f.m.loading && r.task(t, 1).Title == want })
			// Either way, their change to the other field is kept.
			if got := r.task(t, 1); got.Priority != "low" {
				t.Errorf("after %q: priority %q, want theirs (low)", choice, got.Priority)
			}
		}
	})

	t.Run("keep editing: the form reopens on their version with my text", func(t *testing.T) {
		r := start(t, 120, 34, seed)
		r.waitFor(t, "Shared task")
		editing(t, r, " (mine)")
		r.fake.Touch(1, "me", "renamed", func(t *fakeserver.Task) { t.Title = "Theirs" })
		r.waitFor(t, "was changed elsewhere")
		submit(r)
		r.waitFor(t, "was changed by someone else")
		r.keys("e")
		f := r.until(t, "the form again", func(f *frame) bool {
			return f.m.edit.mode == editForm && strings.Contains(f.screen, "Shared task (mine)")
		})
		if f.m.edit.target.Rev != 2 || f.m.edit.initial.Title != "Theirs" {
			t.Errorf("the form should be based on their version: rev %d, %q", f.m.edit.target.Rev, f.m.edit.initial.Title)
		}
		r.Type("!")
		submit(r)
		r.flash(t, "Updated #1 Shared task (mine)!")
	})

	t.Run("ctrl+r loads the new version and drops my edit", func(t *testing.T) {
		r := start(t, 120, 34, seed)
		r.waitFor(t, "Shared task")
		editing(t, r, " (mine)")
		r.fake.Touch(1, "me", "renamed", func(t *fakeserver.Task) { t.Title = "Theirs" })
		r.waitFor(t, "was changed elsewhere")
		r.Send(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
		f := r.until(t, "the form on their version", func(f *frame) bool { return f.m.edit.mode == editForm && f.m.edit.values.Title == "Theirs" })
		if strings.Contains(f.screen, "(mine)") || strings.Contains(f.screen, "changed elsewhere") {
			t.Errorf("after reloading:\n%s", f.screen)
		}
		// ctrl+r does nothing when there is nothing newer to load.
		r.Type(" again")
		r.Send(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
		submit(r)
		r.flash(t, "Updated #1 Theirs again")
	})

	t.Run("deleted while editing", func(t *testing.T) {
		r := start(t, 120, 34, seed)
		r.waitFor(t, "Shared task")
		editing(t, r, " (mine)")
		r.fake.Remove(1)
		r.waitFor(t, "#1 was deleted elsewhere while you were editing it")
		submit(r)
		r.until(t, "the save to be refused", func(f *frame) bool { return strings.Contains(f.m.notice, "#1 no longer exists") })
		if len(r.fake.Tasks()) != 0 {
			t.Error("saving brought a deleted task back")
		}
	})

	t.Run("moving a card that was just moved elsewhere", func(t *testing.T) {
		r := start(t, 120, 34, seed)
		r.waitFor(t, "Shared task")
		// Between the key press and the request, someone finishes the task.
		var once sync.Once
		r.fake.Configure(func(f *fakeserver.Server) {
			f.Hook = func(req fakeserver.Request) {
				if req.Method == "PATCH" {
					once.Do(func() {
						r.fake.Touch(1, "claude", "moved todo → done", func(t *fakeserver.Task) { t.Status = "done" })
					})
				}
			}
		})
		r.keys("s")
		f := r.waitFor(t, "was changed by someone else")
		if !strings.Contains(f.screen, "In progress") || !strings.Contains(f.screen, "Done") || r.task(t, 1).Status != "done" {
			t.Errorf("the conflict should show both statuses, and theirs should stand:\n%s", f.screen)
		}
		r.keys("t")
		r.flash(t, "Kept #1 as it is")
		if r.task(t, 1).Status != "done" {
			t.Error("keeping theirs changed it")
		}
	})
}

func TestEditViews(t *testing.T) {
	// How the things that open over the board are drawn.
	m := board(t, 120, 30)
	one := task(t, full)

	capture := m.ask(editCapture, nil, "add › ", "Renew passport fri !high #personal")
	capture.edit.input.SetValue("Fix the door tomorrow !high")
	capture.edit.preview = "→ Fix the door · due 2026-10-14 · high"
	wellFormed(t, capture)
	t.Run("capture", func(t *testing.T) { golden.RequireEqual(t, []byte(plain(capture))) })

	asking := press(m, "d")
	wellFormed(t, asking)
	t.Run("delete", func(t *testing.T) { golden.RequireEqual(t, []byte(plain(asking))) })

	theirs := task(t, strings.NewReplacer(`"title":"Renew passport"`, `"title":"Renew the passport"`, `"due":"2026-10-16"`, `"due":"2026-10-20"`, `"rev":3`, `"rev":4`).Replace(full))
	clash := send(m, savedMsg{verb: "Updated", id: 41, base: &one, fields: map[string]any{"title": "Renew my passport", "due": "fri", "tags": []string{"errand", "gov"}},
		err: &api.Error{Status: 409, Code: "conflict", Message: "changed", Current: &theirs}})
	wellFormed(t, clash)
	t.Run("conflict", func(t *testing.T) { golden.RequireEqual(t, []byte(plain(clash))) })
	text := plain(clash)
	// What both sides changed is marked; what only I changed is not.
	for _, line := range strings.Split(text, "\n") {
		marked := strings.Contains(line, "←")
		switch {
		case strings.Contains(line, "  title "), strings.Contains(line, "  due "):
			if !marked {
				t.Errorf("should be marked as changed by both: %q", line)
			}
		case strings.Contains(line, "  tags "):
			if marked {
				t.Errorf("only I changed the tags: %q", line)
			}
		}
	}

	form, _ := m.openForm(&one, nil)
	editing := form.(Model)
	editing.edit.changed = true
	for _, size := range [][2]int{{120, 30}, {60, 20}, {40, 12}} {
		wellFormed(t, send(editing, tea.WindowSizeMsg{Width: size[0], Height: size[1]}))
	}
	if screen := plain(editing); !strings.Contains(screen, "Edit #41") || !strings.Contains(screen, "2026-10-15 14:00") || !strings.Contains(screen, "ctrl+r loads the new version") {
		t.Errorf("the form:\n%s", screen)
	}

	// The help lists the editing keys.
	help := plain(press(m, "?"))
	for _, want := range []string{"add", "edit", "comment", "delete", "done", "start", "block", "move card left", "move card right", "check subtask", "add subtask"} {
		if !strings.Contains(help, want) {
			t.Errorf("the help should list %q:\n%s", want, help)
		}
	}
}

func TestFormValues(t *testing.T) {
	one := task(t, full)
	initial := valuesOf(&one, time.UTC)
	if initial.Remind != "2026-10-15 14:00" || initial.Tags != "errand" || initial.Repeat != "yearly" {
		t.Errorf("values of the task: %+v", initial)
	}
	if got := initial.changes(initial); len(got) != 0 {
		t.Errorf("nothing changed: %v", got)
	}
	edited := initial
	edited.Title, edited.Due, edited.Tags, edited.Repeat, edited.Remind, edited.Project = "New", "", " errand , gov ", "", "tomorrow 9am", "  personal "
	got := edited.changes(initial)
	if len(got) != 5 || got["title"] != "New" || got["due"] != "" || got["repeat"] != "" || got["remindAt"] != "tomorrow 9am" || strings.Join(got["tags"].([]string), "|") != "errand|gov" {
		t.Errorf("changes: %v", got)
	}
	if _, has := got["project"]; has {
		t.Error("spaces around a value are not a change")
	}
	// An edit that was refused is carried into the reopened form.
	again := initial
	again.apply(got)
	if again.Title != "New" || again.Due != "" || again.Tags != "errand, gov" || again.Remind != "tomorrow 9am" {
		t.Errorf("applied: %+v", again)
	}
}
