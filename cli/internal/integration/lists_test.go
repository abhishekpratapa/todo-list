package integration

// Sorting, filters with several values and the Today view, from the built
// command, against the fake and the real server alike: the fake answers by the
// app's rules in Go (internal/query), and these keep it giving the same answers
// as the app itself.

import (
	"context"
	"strings"
	"testing"
	"time"

	"todos/internal/fakeserver"
)

// titles is the title of each row a listing printed, in order.
func titles(out string) string {
	var names []string
	for _, row := range rows(out) {
		names = append(names, row[len(row)-1])
	}
	return strings.Join(names, ", ")
}

func TestSortListsAndToday(t *testing.T) {
	everywhere(t, func(t *testing.T, b *backend) {
		if b.fake != nil {
			b.fake.Configure(func(s *fakeserver.Server) { s.Revision = 7 })
		}
		ctx := context.Background()
		sum, err := b.client.Summary(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// Days counted from the server's today, which is the one that decides.
		day := func(n int) string {
			d, _ := time.Parse("2006-01-02", sum.Date)
			return d.AddDate(0, 0, n).Format("2006-01-02")
		}
		for _, fields := range []map[string]any{
			{"title": "Pay rent", "priority": "high", "due": day(0), "tags": []string{"money"}},
			{"title": "Call mom", "due": day(-2)},
			{"title": "Renew passport", "priority": "high", "due": day(-6), "project": "Home"},
			{"title": "Order groceries", "due": day(0), "tags": []string{"errands", "money"}},
			{"title": "Archive photos", "priority": "low", "project": "home"},
		} {
			if _, err := b.client.Create(ctx, fields); err != nil {
				t.Fatal(err)
			}
		}

		for _, c := range []struct {
			args []string
			want string
		}{
			{[]string{"ls"}, "Renew passport, Pay rent, Call mom, Order groceries, Archive photos"},
			{[]string{"ls", "--sort", "due,-priority"}, "Renew passport, Call mom, Order groceries, Pay rent, Archive photos"},
			{[]string{"ls", "--sort", "-title"}, "Renew passport, Pay rent, Order groceries, Call mom, Archive photos"},
			{[]string{"ls", "--sort", "project"}, "Renew passport, Archive photos, Pay rent, Call mom, Order groceries"},
			{[]string{"ls", "--project", "HOME,"}, "Renew passport, Pay rent, Call mom, Order groceries, Archive photos"},
			{[]string{"ls", "--project", "home"}, "Renew passport, Archive photos"},
			{[]string{"ls", "--tag", "money,errands"}, "Pay rent, Order groceries"},
			{[]string{"ls", "--tag", "money,errands", "--tag-mode", "all"}, "Order groceries"},
			{[]string{"ls", "--due", "before:" + day(0)}, "Renew passport, Call mom"},
			{[]string{"ls", "--due", "after:" + day(-3)}, "Pay rent, Call mom, Order groceries"},
			{[]string{"ls", "--due", "tomorrow"}, ""},
		} {
			if got := titles(ok(t, b.env, c.args...)); got != c.want {
				t.Errorf("%v: %s\nwant %s", c.args, got, c.want)
			}
		}
		fails(t, b.env, 2, `Unknown sort key "dew"`, "ls", "--sort", "due,dew")
		fails(t, b.env, 2, `(?i)invalid tagMode "some"`, "ls", "--tag", "money", "--tag-mode", "some")

		// Today: the API's own answer, most important first, then oldest first.
		today := decode[struct {
			Overdue, Today []struct{ Title string }
			Counts         map[string]int
			Date           string
		}](t, ok(t, b.env, "today", "--json"))
		var overdue, dueToday []string
		for _, task := range today.Overdue {
			overdue = append(overdue, task.Title)
		}
		for _, task := range today.Today {
			dueToday = append(dueToday, task.Title)
		}
		if strings.Join(overdue, ", ") != "Renew passport, Call mom" || strings.Join(dueToday, ", ") != "Pay rent, Order groceries" ||
			today.Counts["overdue"] != 2 || today.Counts["today"] != 2 || today.Counts["total"] != 4 || today.Date != sum.Date {
			t.Errorf("today --json: %+v", today)
		}
		if got := titles(ok(t, b.env, "today")); got != "Renew passport, Call mom, Pay rent, Order groceries" {
			t.Errorf("today: %s", got)
		}
	})
}

func TestListsAndAnOlderApp(t *testing.T) {
	// An app from before sorting: the fake at revision 4. What needs revision 7
	// says so; `todos today` works all the same, from what /due has.
	for _, make := range []func(*testing.T) *backend{fakeSocket, fakeRemote} {
		b := make(t)
		b.add(t, "Pay rent today !high")
		b.add(t, "Water plants")
		fails(t, b.env, 8, `sorted lists \(--sort\) need a newer Todos app: this one speaks API revision 4`, "ls", "--sort", "due")
		fails(t, b.env, 8, `lists of projects \(--project a,b\) need a newer Todos app`, "ls", "--project", "home,work")
		if got := titles(ok(t, b.env, "ls")); got != "Pay rent, Water plants" {
			t.Errorf("%s: ls: %s", b.name, got)
		}
		if got := titles(ok(t, b.env, "today")); got != "Pay rent" {
			t.Errorf("%s: today: %s", b.name, got)
		}
		for _, r := range b.fake.Requests() {
			if strings.Contains(r.Path, "sort=") || strings.Contains(r.Path, "/today") {
				t.Errorf("%s: the old app was asked for %s", b.name, r.Path)
			}
		}
	}
}
