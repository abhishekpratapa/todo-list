// Package queue keeps the changes the todos command could not send, because
// the Mac could not be reached, until they can be.
//
// Each profile has a folder of its own, in the config directory, with one file
// per change, named by its number. Adding a change never rewrites another, and
// changes are sent in the order they were made. A change keeps the
// Idempotency-Key it was made with, so one that reaches the app more than once
// (a connection that dropped after the app had it) is applied once.
//
// Several todos commands can be at work at once (one adding while another
// sends), so what must not overlap is done under a lock: flock(2) on a file
// in the folder, which the system lets go of if the process dies.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"todos/internal/api"
	"todos/internal/config"
)

// The kinds of change that can wait. Each only adds to the list or to a task,
// so sending it later can't overwrite what anyone did in the meantime.
const (
	KindAdd      = "add"      // a task from one line
	KindDone     = "done"     // mark a task done
	KindComment  = "comment"  // a comment on a task
	KindSubtasks = "subtasks" // subtasks added to a task
)

// Item is one change waiting to be sent.
type Item struct {
	ID     int       `json:"id"`
	Kind   string    `json:"kind"`
	Task   int       `json:"task,omitempty"`   // the task it is for (not for an add)
	Text   string    `json:"text,omitempty"`   // the line, the comment, or the closing comment
	Titles []string  `json:"titles,omitempty"` // the subtasks
	Made   time.Time `json:"made"`             // when the command was run
	URL    string    `json:"url"`              // the address of the Todos it is for
	Key    string    `json:"key"`              // its Idempotency-Key: the same however often it is sent
	// Refused is set when the app turned it down. It stays, and is not sent
	// again, until it is removed.
	Refused *Refusal `json:"refused,omitempty"`
}

// Refusal is why the app turned a change down.
type Refusal struct {
	Status  int       `json:"status"`
	Code    string    `json:"code,omitempty"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

// Waiting says whether the change is still to be sent.
func (it *Item) Waiting() bool { return it.Refused == nil }

// Change is the request that makes the change. An added line is read as of
// when it was typed.
func (it *Item) Change() (api.Change, error) {
	switch it.Kind {
	case KindAdd:
		return api.CaptureChange(it.Text, it.Made, it.Key), nil
	case KindDone:
		return api.CompleteChange(it.Task, it.Text, it.Key), nil
	case KindComment:
		return api.CommentChange(it.Task, it.Text, it.Key), nil
	case KindSubtasks:
		return api.SubtasksChange(it.Task, it.Titles, it.Key), nil
	}
	return api.Change{}, fmt.Errorf("change %d is of a kind this todos command doesn't know (%q): it was saved by a newer one", it.ID, it.Kind)
}

// Verb is what the change did, for the line printed once it has been made.
func (it *Item) Verb() string {
	switch it.Kind {
	case KindAdd:
		return "Added"
	case KindDone:
		return "Done"
	case KindComment:
		return "Commented on"
	}
	return "Updated"
}

// Describe says what the change is, in a few words.
func (it *Item) Describe() string {
	switch it.Kind {
	case KindAdd:
		return "add “" + it.Text + "”"
	case KindDone:
		if it.Text != "" {
			return fmt.Sprintf("done #%d, “%s”", it.Task, it.Text)
		}
		return fmt.Sprintf("done #%d", it.Task)
	case KindComment:
		return fmt.Sprintf("comment on #%d, “%s”", it.Task, it.Text)
	case KindSubtasks:
		return fmt.Sprintf("subtasks on #%d, “%s”", it.Task, strings.Join(it.Titles, "”, “"))
	}
	return it.Kind
}

// Queue is one profile's changes.
type Queue struct {
	Dir string
}

// For is the queue of the profile `name`, under the config directory.
func For(configDir, name string) *Queue {
	return &Queue{Dir: filepath.Join(configDir, "queue", name)}
}

var fileRE = regexp.MustCompile(`^(\d{6,})\.json$`)

func fileName(id int) string { return fmt.Sprintf("%06d.json", id) }

// List returns the changes, oldest first. A queue never used is empty. A file
// that isn't a change is set aside (renamed, never deleted) so the rest still
// go; one that can't be read just now is left for next time.
func (q *Queue) List() ([]Item, error) {
	entries, err := os.ReadDir(q.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var items []Item
	for _, e := range entries {
		m := fileRE.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		id, _ := strconv.Atoi(m[1])
		it, ok, err := q.Get(id)
		if err != nil || !ok {
			continue // sent and removed in the meantime, or not readable now
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

// Get reads one change, and says whether it is there. Its number is the one
// in its file's name, whatever the file says.
func (q *Queue) Get(id int) (Item, bool, error) {
	path := filepath.Join(q.Dir, fileName(id))
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Item{}, false, nil
	}
	if err != nil {
		return Item{}, false, err
	}
	var it Item
	if err := json.Unmarshal(b, &it); err != nil || it.Kind == "" {
		_ = os.Rename(path, path+".unreadable")
		return Item{}, false, nil
	}
	it.ID = id
	return it, true, nil
}

// SetAside counts the files that were set aside because they weren't changes.
func (q *Queue) SetAside() int {
	matches, _ := filepath.Glob(filepath.Join(q.Dir, "*.unreadable"))
	return len(matches)
}

// Count says how many changes are waiting, and how many were refused.
func (q *Queue) Count() (waiting, refused int) {
	items, _ := q.List()
	for _, it := range items {
		if it.Waiting() {
			waiting++
		} else {
			refused++
		}
	}
	return waiting, refused
}

// Add saves changes, in order, and returns them with their numbers. Numbers
// carry on from the highest one there, and start again at 1 once the queue
// has emptied.
func (q *Queue) Add(ctx context.Context, items []Item) ([]Item, error) {
	unlock, err := q.Lock(ctx, "edit", 10*time.Second)
	if err != nil {
		return nil, err
	}
	defer unlock()
	have, err := q.List()
	if err != nil {
		return nil, err
	}
	next := 1
	if len(have) > 0 {
		next = have[len(have)-1].ID + 1
	}
	out := make([]Item, len(items))
	for i, it := range items {
		it.ID = next + i
		if err := q.write(it); err != nil {
			return out[:i], err
		}
		out[i] = it
	}
	return out, nil
}

func (q *Queue) write(it Item) error {
	b, err := json.MarshalIndent(it, "", "  ")
	if err != nil {
		return err
	}
	return config.WritePrivate(q.Dir, fileName(it.ID), append(b, '\n'))
}

// Remove takes a change out of the queue. It says whether there was one.
func (q *Queue) Remove(id int) (bool, error) {
	err := os.Remove(filepath.Join(q.Dir, fileName(id)))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// Sent takes out a change that has been made: the one with that number, if it
// is still that change (the same key) and not one saved since under the
// number, which is used again once the queue has emptied.
func (q *Queue) Sent(ctx context.Context, it Item) error {
	unlock, err := q.Lock(ctx, "edit", 10*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	cur, ok, err := q.Get(it.ID)
	if err != nil || !ok || cur.Key != it.Key {
		return err
	}
	_, err = q.Remove(it.ID)
	return err
}

// Refuse records that the app turned a change down. It stays in the queue,
// and is no longer sent, until it is removed. A change removed in the
// meantime (or replaced by one saved since under its number) is left alone.
func (q *Queue) Refuse(ctx context.Context, it Item, r Refusal) error {
	unlock, err := q.Lock(ctx, "edit", 10*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	cur, ok, err := q.Get(it.ID)
	if err != nil || !ok || cur.Key != it.Key {
		return err
	}
	cur.Refused = &r
	return q.write(cur)
}

// Gone says whether the queue's folder has disappeared (or its config
// directory with it), which tells a background sender to stop.
func (q *Queue) Gone() bool {
	_, err := os.Stat(filepath.Dir(filepath.Dir(q.Dir)))
	return errors.Is(err, os.ErrNotExist)
}

// ErrBusy means another todos command holds the lock.
var ErrBusy = errors.New("another todos command is using the queue")

// Lock takes one of the queue's locks, waiting up to `wait` for it (0: not at
// all), and returns what lets go of it.
//
//	edit    numbering and rewriting changes (held for a moment)
//	send    sending: one command at a time, so changes go in order
//	waiter  the background sender: there is only ever one
func (q *Queue) Lock(ctx context.Context, name string, wait time.Duration) (func(), error) {
	if err := os.MkdirAll(q.Dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(q.Dir, "."+name+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
				f.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			f.Close()
			return nil, err
		}
		if !time.Now().Before(deadline) {
			f.Close()
			return nil, ErrBusy
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// ParseID reads a change's number as typed: 3 or #3.
func ParseID(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(s), "#"))
	return n, err == nil && n > 0
}
