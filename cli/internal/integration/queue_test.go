package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"todos/internal/api"
	"todos/internal/fakeserver"
	"todos/internal/queue"
)

// offline puts a gate between the command and the backend, which the test
// shuts to take the Mac away and opens to bring it back.
func offline(t *testing.T, b *backend) ([]string, *fakeserver.Gate) {
	t.Helper()
	g, err := fakeserver.NewGate(strings.TrimPrefix(b.client.Base, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Shut)
	token := b.client.Token
	writeProfile(t, b.env, "https://"+g.Addr, "", token)
	return b.env, g
}

func configDir(env []string) string {
	for _, e := range env {
		if strings.HasPrefix(e, "XDG_CONFIG_HOME=") {
			return filepath.Join(strings.TrimPrefix(e, "XDG_CONFIG_HOME="), "todos")
		}
	}
	return ""
}

func (b *backend) find(t *testing.T, title string) []api.Task {
	t.Helper()
	list, err := b.client.ListAll(context.Background(), api.ListOptions{Status: "all", Query: title})
	if err != nil {
		t.Fatal(err)
	}
	var found []api.Task
	for _, task := range list.Tasks {
		if task.Title == title {
			found = append(found, task)
		}
	}
	return found
}

func (b *backend) today(t *testing.T) time.Time {
	t.Helper()
	sum, err := b.client.Summary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	day, err := time.Parse("2006-01-02", sum.Date)
	if err != nil {
		t.Fatal(err)
	}
	return day
}

func TestOfflineQueue(t *testing.T) {
	only(t, false, func(t *testing.T, b *backend) {
		passport := b.add(t, "Renew passport")
		env, g := offline(t, b)
		g.Shut()

		r := run(t, env, "", "add", "Call the bank tomorrow")
		if r.code != 0 || r.stdout != "" || !strings.Contains(r.stderr, "saved 1 change to send when Todos answers") {
			t.Fatalf("add: exit %d, %q %q", r.code, r.stdout, r.stderr)
		}
		ok(t, env, "done", fmt.Sprint(passport.ID), "-m", "Posted")
		rows := strings.Split(strings.TrimSpace(ok(t, env, "queue")), "\n")
		if len(rows) != 2 || !strings.HasPrefix(rows[0], "1\twaiting\t") || !strings.HasSuffix(rows[1], fmt.Sprintf("\tdone\t%d\tPosted\t-", passport.ID)) {
			t.Fatalf("queue: %q", rows)
		}
		if len(b.find(t, "Call the bank")) != 0 {
			t.Fatal("nothing should have arrived yet")
		}

		g.Open()
		if out := ok(t, env, "ls"); !strings.Contains(out, "Call the bank") {
			t.Errorf("ls after coming back: %q", out)
		}
		found := b.find(t, "Call the bank")
		if len(found) != 1 || found[0].Due != b.today(t).AddDate(0, 0, 1).Format("2006-01-02") {
			t.Errorf("added: %+v", found)
		}
		if got := b.get(t, passport.ID); got.Status != "done" {
			t.Errorf("done: %+v", got)
		}
		if b.real != nil {
			task := b.get(t, found[0].ID)
			if via := task.Activity[0].Via; !strings.HasPrefix(via, "todos on ") {
				t.Errorf("made by %q", via)
			}
		}
		if out := ok(t, env, "queue"); out != "" {
			t.Errorf("queue after sending: %q", out)
		}
		// Sending it again changes nothing: the keys were used up.
		if out := ok(t, env, "queue", "send"); out != "" {
			t.Errorf("queue send with nothing waiting: %q", out)
		}
	})
}

// A line saved for later is read as of when it was typed: "tomorrow" two days
// ago is yesterday. That is the real server's reading, so only it can say.
func TestOfflineLineIsReadAsOfWhenTyped(t *testing.T) {
	b := realRemote(t)
	env, _ := offline(t, b)
	typed := time.Now().Add(-48 * time.Hour)
	q := queue.For(configDir(env), "hub")
	if _, err := q.Add(context.Background(), []queue.Item{{
		Kind: queue.KindAdd, Text: "Pay rent tomorrow", Made: typed, Key: api.NewKey(), URL: profileURL(t, env),
	}}); err != nil {
		t.Fatal(err)
	}
	ok(t, env, "ls")
	found := b.find(t, "Pay rent")
	if want := b.today(t).AddDate(0, 0, -1).Format("2006-01-02"); len(found) != 1 || found[0].Due != want {
		t.Errorf("added %+v, want due %s", found, want)
	}
}

func profileURL(t *testing.T, env []string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(configDir(env), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Profiles map[string]struct{ URL string } `json:"profiles"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg.Profiles["hub"].URL
}

// With nothing else run, the sender left in the background sends what was
// saved once the Mac is back, and then stops.
func TestBackgroundSender(t *testing.T) {
	only(t, false, func(t *testing.T, b *backend) {
		env, g := offline(t, b)
		env = setEnv(env, "TODOS_QUEUE=on")
		g.Shut()
		if r := run(t, env, "", "add", "Buy milk"); r.code != 0 {
			t.Fatalf("add: exit %d, %q", r.code, r.stderr)
		}
		time.Sleep(500 * time.Millisecond)
		g.Open()

		q := queue.For(configDir(env), "hub")
		deadline := time.Now().Add(30 * time.Second)
		for len(b.find(t, "Buy milk")) == 0 {
			if time.Now().After(deadline) {
				t.Fatal("the background sender did not send the change")
			}
			time.Sleep(200 * time.Millisecond)
		}
		// It has finished: the queue is empty, and its lock is free.
		for {
			unlock, err := q.Lock(context.Background(), "waiter", 0)
			if err == nil {
				unlock()
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the background sender is still running")
			}
			time.Sleep(200 * time.Millisecond)
		}
		if waiting, refused := q.Count(); waiting+refused != 0 || len(b.find(t, "Buy milk")) != 1 {
			t.Errorf("after the sender: %d waiting, %d refused, %d tasks", waiting, refused, len(b.find(t, "Buy milk")))
		}
	})
}
