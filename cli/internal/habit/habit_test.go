package habit

import (
	"bytes"
	"encoding/json"
	"testing"

	"todos/internal/api"
)

func parse(t *testing.T, js string) api.Habit {
	t.Helper()
	var h api.Habit
	if err := json.Unmarshal([]byte(js), &h); err != nil {
		t.Fatal(err)
	}
	return h
}

const twice = `"dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"morning","name":"Morning","remind":"07:30","from":"05:00","until":"11:00","nudge":null},{"id":"evening","name":"Evening","remind":"21:30","from":"19:00","until":"02:00","nudge":"22:30"}]}`

// The habits of a Tuesday, as the app sends them (see src/habits.js).
func day(t *testing.T) []api.Habit {
	return []api.Habit{
		parse(t, `{"id":1,"name":"Brush teeth",`+twice+`,"today":{"day":"2026-10-13","state":"open","done":1,"total":2,"slots":[{"id":"morning","done":true,"at":"2026-10-13T12:00:00.000Z","by":"me","via":"iPhone","source":"widget"},{"id":"evening","done":false}]},
			"yesterday":{"day":"2026-10-12","state":"open","done":1,"total":2,"slots":[{"id":"morning","done":true},{"id":"evening","done":false}]},
			"streak":{"current":7,"best":7,"unit":"days","atRisk":{"day":"2026-10-12","missing":["evening"],"until":"2026-10-14T08:00:00.000Z"}}}`),
		parse(t, `{"id":2,"name":"Floss",`+twice+`,"today":{"day":"2026-10-13","state":"open","done":0,"total":2,"slots":[{"id":"morning","done":false},{"id":"evening","done":false}]},
			"yesterday":{"day":"2026-10-12","state":"done","done":2,"total":2,"slots":[{"id":"morning","done":true},{"id":"evening","done":true}]},"streak":{"current":1,"best":1,"unit":"days","atRisk":null}}`),
		parse(t, `{"id":3,"name":"Gym","dayStart":"03:00","schedule":{"kind":"weekly","target":3,"remind":{"days":["mon","wed","fri"],"time":"17:30"}},
			"today":{"day":"2026-10-13","done":false,"checkins":[]},"yesterday":{"day":"2026-10-12","done":true,"checkins":[9]},
			"week":{"start":"2026-10-12","state":"open","count":1,"target":3,"days":["2026-10-12"]},"streak":{"current":1,"best":1,"unit":"weeks","atRisk":null}}`),
		parse(t, `{"id":4,"name":"Read","dayStart":"03:00","schedule":{"kind":"days","days":["mon","wed"],"slots":[{"id":"once","name":"","remind":"21:00","from":null,"until":null,"nudge":null}]},
			"today":{"day":"2026-10-13","state":"off","done":0,"total":0,"slots":[]},"yesterday":{"day":"2026-10-12","state":"done","done":1,"total":1,"slots":[{"id":"once","done":true}]},"streak":{"current":0,"best":0,"unit":"days","atRisk":null}}`),
		parse(t, `{"id":5,"name":"Stretch","paused":true,"dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"morning","name":"Morning","remind":null,"from":null,"until":null,"nudge":null}]},
			"today":{"day":"2026-10-13","state":"off","done":0,"total":0,"slots":[]},"yesterday":{"day":"2026-10-12","state":"off","done":0,"total":0,"slots":[]},"streak":{"current":0,"best":3,"unit":"days","atRisk":null}}`),
		parse(t, `{"id":6,"name":"Vitamins","dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"once","name":"","remind":null,"from":null,"until":null,"nudge":null}]},
			"today":{"day":"2026-10-13","state":"done","done":1,"total":1,"slots":[{"id":"once","done":true}]},"yesterday":{"day":"2026-10-12","state":"off","done":0,"total":0,"slots":[]},"streak":{"current":1,"best":1,"unit":"days","atRisk":null}}`),
		parse(t, `{"id":7,"name":"Old habit","archived":true,"dayStart":"03:00","schedule":{"kind":"daily","slots":[{"id":"once","name":"","remind":null,"from":null,"until":null,"nudge":null}]},
			"today":{"day":"2026-10-13","state":"off","done":0,"total":0,"slots":[]},"yesterday":{"day":"2026-10-12","state":"off","done":0,"total":0,"slots":[]},"streak":{"current":0,"best":0,"unit":"days","atRisk":null}}`),
	}
}

func names(list []api.Habit) []string {
	out := make([]string, len(list))
	for i, h := range list {
		out[i] = h.Name
	}
	return out
}

func same(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestBothShapesOfADay(t *testing.T) {
	all := day(t)
	if d := all[0].Today; d.Done != 1 || d.Total != 2 || d.CheckedIn || len(d.Remaining()) != 1 || d.Remaining()[0].ID != "evening" || d.Slots[0].Via != "iPhone" {
		t.Errorf("a day with slots: %+v", d)
	}
	if gym := all[2]; gym.Today.CheckedIn || !gym.Yesterday.CheckedIn || gym.Today.Done != 0 || !gym.Weekly() || gym.Week.Count != 1 {
		t.Errorf("a day of a habit counted in weeks: %+v %+v", gym.Today, gym.Yesterday)
	}
	// What arrived is what goes back out.
	var sent bytes.Buffer
	_ = json.Compact(&sent, all[2].Raw)
	if b, _ := json.Marshal(all[2]); string(b) != sent.String() {
		t.Errorf("a habit should marshal to what the app sent:\n%s\n%s", b, sent.String())
	}
}

func TestTodaysOrder(t *testing.T) {
	today := ForToday(day(t))
	if got, want := names(today.Due), []string{"Floss", "Brush teeth", "Gym"}; !same(got, want) {
		t.Errorf("still to do: %v, want %v (a morning before an evening; no time today last)", got, want)
	}
	if got := names(today.Done); !same(got, []string{"Vitamins"}) {
		t.Errorf("done: %v", got)
	}
	if got := names(today.Off); !same(got, []string{"Read", "Stretch"}) {
		t.Errorf("nothing today: %v (and never an archived habit)", got)
	}
	if got := names(today.All()); len(got) != 6 || got[0] != "Floss" || got[5] != "Stretch" {
		t.Errorf("all: %v", got)
	}
	if left := Left(day(t)); left != 4 {
		t.Errorf("%d left, want 4: two for Floss, one for Brush teeth, one visit", left)
	}
}

func TestWords(t *testing.T) {
	all := day(t)
	for i, want := range []string{"1 of 2 · Evening 21:30", "0 of 2 · Morning 07:30", "1 of 3 this week", "Not today", "Paused", "Done today", "Not today"} {
		if got := Progress(&all[i]); got != want {
			t.Errorf("%s: %q, want %q", all[i].Name, got, want)
		}
	}
	for i, want := range []string{"1/2", "0/2", "1/3", "0/0", "0/0", "1/1"} {
		if got := Count(&all[i]); got != want {
			t.Errorf("%s: count %q, want %q", all[i].Name, got, want)
		}
	}
	if Streak(&all[0]) != "7d" || Streak(&all[2]) != "1w" || Length(1, "weeks") != "1 week" || Length(7, "days") != "7 days" || Length(1, "days") != "1 day" {
		t.Errorf("streaks: %s %s", Streak(&all[0]), Streak(&all[2]))
	}
	if got, want := AtRisk(&all[0]), "Log yesterday’s evening by the end of today to keep your 7-day streak."; got != want {
		t.Errorf("at risk: %q, want %q", got, want)
	}
	if AtRisk(&all[1]) != "" || AtRisk(&all[2]) != "" {
		t.Error("nothing is at risk for a finished yesterday")
	}
	if SlotName(&all[0], "evening") != "Evening" || SlotName(&all[3], "once") != "Once" || SlotName(&all[2], "") != "" {
		t.Error("slot names")
	}
	met := parse(t, `{"id":8,"name":"Run","schedule":{"kind":"weekly","target":2},"today":{"day":"2026-10-13","done":true},"week":{"state":"met","count":2,"target":2},"streak":{"current":3,"unit":"weeks"}}`)
	if Progress(&met) != "2 of 2 this week · done" || Group(&met) != "done" {
		t.Errorf("a week that is met: %q %s", Progress(&met), Group(&met))
	}
}

func TestFind(t *testing.T) {
	all := append(day(t), parse(t, `{"id":9,"name":"Brush the dog","schedule":{"kind":"daily","slots":[]}}`))
	for _, c := range []struct {
		ref  string
		want []string
	}{
		{"floss", []string{"Floss"}},
		{"FLOSS", []string{"Floss"}},
		{"brush", []string{"Brush teeth", "Brush the dog"}},
		{"brush teeth", []string{"Brush teeth"}},
		{"teeth brush", []string{"Brush teeth"}}, // every word, in any order
		{"old", []string{"Old habit"}},           // an archived habit, when nothing else matches
		{"piano", nil},
		{"   ", nil},
	} {
		if got := names(Find(all, c.ref)); !same(got, c.want) {
			t.Errorf("Find(%q) = %v, want %v", c.ref, got, c.want)
		}
	}
	// An exact name wins over longer names that contain it.
	all = append(all, parse(t, `{"id":10,"name":"Brush","schedule":{"kind":"daily","slots":[]}}`))
	if got := names(Find(all, "brush")); !same(got, []string{"Brush"}) {
		t.Errorf("an exact name: %v", got)
	}
}
