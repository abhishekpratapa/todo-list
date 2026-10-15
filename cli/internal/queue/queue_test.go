package queue

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestNumberingOrderAndRemoval(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	if items, err := q.List(); err != nil || len(items) != 0 {
		t.Fatalf("a queue never used: %v %v", items, err)
	}
	saved, err := q.Add(ctx, []Item{{Kind: KindAdd, Text: "Buy milk"}, {Kind: KindDone, Task: 12}})
	if err != nil || saved[0].ID != 1 || saved[1].ID != 2 {
		t.Fatalf("first numbers: %+v %v", saved, err)
	}
	more, _ := q.Add(ctx, []Item{{Kind: KindComment, Task: 12, Text: "Sent"}})
	if more[0].ID != 3 {
		t.Errorf("numbers carry on: %d", more[0].ID)
	}
	items, _ := q.List()
	if len(items) != 3 || items[0].Text != "Buy milk" || items[1].Task != 12 || items[2].Kind != KindComment {
		t.Errorf("listed: %+v", items)
	}
	// The folder and the files are only the user's.
	for _, path := range []string{q.Dir, filepath.Join(q.Dir, "000001.json")} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s: %v %v", path, info.Mode(), err)
		}
	}

	if removed, err := q.Remove(2); !removed || err != nil {
		t.Errorf("remove 2: %v %v", removed, err)
	}
	if removed, _ := q.Remove(2); removed {
		t.Error("removing twice")
	}
	more, _ = q.Add(ctx, []Item{{Kind: KindAdd, Text: "Post letter"}})
	if more[0].ID != 4 {
		t.Errorf("numbers carry on from the highest: %d", more[0].ID)
	}
	for _, id := range []int{1, 3, 4} {
		q.Remove(id) //nolint:errcheck
	}
	more, _ = q.Add(ctx, []Item{{Kind: KindAdd, Text: "Again"}})
	if more[0].ID != 1 {
		t.Errorf("an emptied queue starts again at 1: %d", more[0].ID)
	}
}

func TestRefusedStaysAndIsCounted(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	saved, _ := q.Add(ctx, []Item{{Kind: KindAdd, Text: "!high", Key: "k1"}, {Kind: KindAdd, Text: "Buy milk", Key: "k2"}})
	if err := q.Refuse(ctx, saved[0], Refusal{Status: 400, Code: "invalid", Message: "That line has no title"}); err != nil {
		t.Fatal(err)
	}
	items, _ := q.List()
	if items[0].Waiting() || items[0].Refused.Message != "That line has no title" || !items[1].Waiting() {
		t.Errorf("after refusing: %+v", items)
	}
	if waiting, refused := q.Count(); waiting != 1 || refused != 1 {
		t.Errorf("count: %d waiting, %d refused", waiting, refused)
	}
	if err := q.Refuse(ctx, Item{ID: 9, Key: "k9"}, Refusal{Message: "x"}); err != nil {
		t.Errorf("refusing one already gone: %v", err)
	}
	// One saved since under the same number is not the one refused.
	if err := q.Refuse(ctx, Item{ID: 2, Key: "not-k2"}, Refusal{Message: "x"}); err != nil {
		t.Fatal(err)
	}
	if items, _ := q.List(); !items[1].Waiting() {
		t.Error("refused the wrong change")
	}
}

func TestSentRemovesOnlyThatChange(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	saved, _ := q.Add(ctx, []Item{{Kind: KindAdd, Text: "Buy milk", Key: "k1"}})
	// Removed and saved again under the same number while it was being sent.
	q.Remove(1)                                                         //nolint:errcheck
	q.Add(ctx, []Item{{Kind: KindAdd, Text: "Post letter", Key: "k2"}}) //nolint:errcheck
	if err := q.Sent(ctx, saved[0]); err != nil {
		t.Fatal(err)
	}
	if items, _ := q.List(); len(items) != 1 || items[0].Text != "Post letter" {
		t.Errorf("left: %+v", items)
	}
	if err := q.Sent(ctx, Item{ID: 1, Key: "k2"}); err != nil {
		t.Fatal(err)
	}
	if items, _ := q.List(); len(items) != 0 {
		t.Errorf("left: %+v", items)
	}
}

func TestTheNumberIsTheFileName(t *testing.T) {
	q := For(t.TempDir(), "hub")
	os.MkdirAll(q.Dir, 0o700)                                                                                 //nolint:errcheck
	os.WriteFile(filepath.Join(q.Dir, "000007.json"), []byte(`{"id": 3, "kind": "add", "text": "x"}`), 0o600) //nolint:errcheck
	if items, _ := q.List(); len(items) != 1 || items[0].ID != 7 {
		t.Errorf("listed: %+v", items)
	}
}

func TestAnUnreadableFileIsSetAside(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	q.Add(ctx, []Item{{Kind: KindAdd, Text: "Buy milk"}}) //nolint:errcheck
	bad := filepath.Join(q.Dir, "000002.json")
	os.WriteFile(bad, []byte("{not json"), 0o600) //nolint:errcheck
	items, err := q.List()
	if err != nil || len(items) != 1 {
		t.Fatalf("listed: %+v %v", items, err)
	}
	if _, err := os.Stat(bad + ".unreadable"); err != nil || q.SetAside() != 1 {
		t.Errorf("not set aside: %v", err)
	}
}

func TestChanges(t *testing.T) {
	made := time.Date(2026, 10, 14, 22, 30, 0, 0, time.FixedZone("CDT", -5*3600))
	for _, c := range []struct {
		item       Item
		method     string
		path       string
		body       map[string]any
		verb, what string
	}{
		{Item{Kind: KindAdd, Text: "Call the bank tomorrow", Made: made, Key: "k1"}, "POST", "/api/v1/capture",
			map[string]any{"text": "Call the bank tomorrow", "at": "2026-10-15T03:30:00.000Z"}, "Added", "add “Call the bank tomorrow”"},
		{Item{Kind: KindDone, Task: 12, Key: "k2"}, "POST", "/api/v1/tasks/12/complete", nil, "Done", "done #12"},
		{Item{Kind: KindDone, Task: 12, Text: "Sent both", Key: "k3"}, "POST", "/api/v1/tasks/12/complete",
			map[string]any{"comment": "Sent both"}, "Done", "done #12, “Sent both”"},
		{Item{Kind: KindComment, Task: 7, Text: "Waiting on them", Key: "k4"}, "POST", "/api/v1/tasks/7/comments",
			map[string]any{"text": "Waiting on them"}, "Commented on", "comment on #7, “Waiting on them”"},
		{Item{Kind: KindSubtasks, Task: 7, Titles: []string{"Photos", "Form"}, Key: "k5"}, "POST", "/api/v1/tasks/7/subtasks",
			map[string]any{"titles": []string{"Photos", "Form"}}, "Updated", "subtasks on #7, “Photos”, “Form”"},
	} {
		ch, err := c.item.Change()
		if err != nil {
			t.Fatal(err)
		}
		if ch.Method != c.method || ch.Path != c.path || !reflect.DeepEqual(ch.Body, c.body) || ch.Key != c.item.Key {
			t.Errorf("%s: %+v", c.item.Kind, ch)
		}
		if c.item.Verb() != c.verb || c.item.Describe() != c.what {
			t.Errorf("%s: %q %q", c.item.Kind, c.item.Verb(), c.item.Describe())
		}
	}
	// One saved by a newer command is left for that command.
	if _, err := (&Item{ID: 3, Kind: "rename"}).Change(); err == nil {
		t.Error("an unknown kind should not be sent")
	}
}

func TestLocks(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	unlock, err := q.Lock(ctx, "send", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Lock(ctx, "send", 0); !errors.Is(err, ErrBusy) {
		t.Errorf("a held lock: %v", err)
	}
	if _, err := q.Lock(ctx, "send", 120*time.Millisecond); !errors.Is(err, ErrBusy) {
		t.Errorf("waiting for a held lock: %v", err)
	}
	other, err := q.Lock(ctx, "waiter", 0)
	if err != nil {
		t.Errorf("locks are separate: %v", err)
	} else {
		other()
	}
	go func() { time.Sleep(100 * time.Millisecond); unlock() }()
	again, err := q.Lock(ctx, "send", 2*time.Second)
	if err != nil {
		t.Fatalf("a lock let go of: %v", err)
	}
	again()
}

func TestAddingAtOnce(t *testing.T) {
	ctx := context.Background()
	q := For(t.TempDir(), "hub")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := q.Add(ctx, []Item{{Kind: KindAdd, Text: "x"}, {Kind: KindAdd, Text: "y"}}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	items, _ := q.List()
	if len(items) != 16 {
		t.Fatalf("%d saved, want 16", len(items))
	}
	for i, it := range items {
		if it.ID != i+1 {
			t.Fatalf("numbers %d at %d: every change gets its own", it.ID, i)
		}
	}
}

func TestGone(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "todos")
	q := For(dir, "hub")
	q.Add(context.Background(), []Item{{Kind: KindAdd, Text: "x"}}) //nolint:errcheck
	if q.Gone() {
		t.Fatal("there")
	}
	os.RemoveAll(dir)
	if !q.Gone() {
		t.Error("the config directory was removed")
	}
}
