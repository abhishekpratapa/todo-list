package fakeserver

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Habits, as much of them as the command-line client uses: the list, checking
// in, taking that back and rest days, from API revision 5 on. The fake keeps no
// history and works no streaks out: a habit's streak is what the test gave it,
// plus one once today is complete. The rules themselves are the app's, and the
// client is run against the real one in internal/integration.

// HabitSlot is one of the times of day a habit is done at.
type HabitSlot struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Remind *string `json:"remind"`
	From   *string `json:"from"`
	Until  *string `json:"until"`
	Nudge  *string `json:"nudge"`
}

// Checkin is one recorded check-in.
type Checkin struct {
	ID     int    `json:"id"`
	Habit  int    `json:"habit"`
	Kind   string `json:"kind"`
	Slot   any    `json:"slot"` // the slot's id, or null
	Day    string `json:"day"`
	At     string `json:"at"`
	By     string `json:"by"`
	Via    string `json:"via,omitempty"`
	Source string `json:"source,omitempty"`
	Key    string `json:"key,omitempty"`
	Undone bool   `json:"-"`
}

// Habit is a habit in the fake. Slots is empty for one counted in weeks, which
// has Target instead. Streak and Best are as of yesterday.
type Habit struct {
	ID       int
	Name     string
	Icon     string
	Color    string
	DayStart string
	Slots    []HabitSlot
	Days     []string // the days of the week it is scheduled on; empty for every day
	Target   int      // days a week, for a habit counted in weeks
	Week     int      // days already checked in this week, before today
	Streak   int
	Best     int
	AtRisk   []string // yesterday's slots still missing, with the streak hanging on them
	Paused   bool
	Archived bool
	Skips    int // rest days still allowed
	Rev      int
}

func (h *Habit) weekly() bool { return len(h.Slots) == 0 }

// AddHabit puts a habit in the fake: done at the named times of day, or with
// no slots, counted in weeks (three days, unless edit says otherwise).
func (s *Server) AddHabit(name string, slots []string, edit ...func(*Habit)) Habit {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextHabit++
	h := &Habit{ID: s.nextHabit, Name: name, Color: "indigo", DayStart: "03:00", Skips: 2, Rev: 1}
	for _, slot := range slots {
		h.Slots = append(h.Slots, HabitSlot{ID: strings.ToLower(slot), Name: slot})
	}
	if h.weekly() {
		h.Target = 3
	}
	for _, fn := range edit {
		fn(h)
	}
	s.habits = append(s.habits, h)
	s.habitsChanged()
	return *h
}

// CheckInElsewhere records a check-in as another client would: live streams hear of it.
func (s *Server) CheckInElsewhere(id int, slot, by, via string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.findHabit(id); h != nil {
		s.record(h, "done", slot, s.today(), by, via, "manual", "")
		s.habitsChanged()
	}
}

// CheckedInYesterday records yesterday's check-ins for a habit, as part of
// setting a scene: nothing is announced.
func (s *Server) CheckedInYesterday(id int, slots ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.findHabit(id); h != nil {
		for _, slot := range slots {
			s.record(h, "done", slot, s.yesterday(), "me", "", "manual", "")
		}
	}
}

// Checkins returns what has been recorded for a habit and not taken back.
func (s *Server) Checkins(id int) []Checkin {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Checkin
	for _, c := range s.checkins {
		if c.Habit == id && !c.Undone {
			out = append(out, *c)
		}
	}
	return out
}

// HabitsVersion goes up with every change to the habits.
func (s *Server) HabitsVersion() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.habitsVersion
}

func (s *Server) findHabit(id int) *Habit {
	for _, h := range s.habits {
		if h.ID == id {
			return h
		}
	}
	return nil
}

func (s *Server) yesterday() string { return s.Now().AddDate(0, 0, -1).Format("2006-01-02") }

// habitsChanged raises the habits' version and tells every live stream, under
// the habits' own name. The task list's version rides along, unchanged.
func (s *Server) habitsChanged() {
	s.habitsVersion++
	msg := fmt.Sprintf("event: habits\ndata: {\"version\":%d,\"habits\":%d}\n\n", s.version, s.habitsVersion)
	for ch := range s.streams {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (s *Server) record(h *Habit, kind, slot, day, by, via, source, key string) *Checkin {
	s.nextCheckin++
	c := &Checkin{ID: s.nextCheckin, Habit: h.ID, Kind: kind, Day: day, At: s.stamp(), By: by, Via: via, Source: source, Key: key}
	if slot != "" {
		c.Slot = slot
	}
	s.checkins = append(s.checkins, c)
	return c
}

// standing is the check-ins of a kind for a habit on a day that have not been taken back.
func (s *Server) standing(h *Habit, kind, day string) []*Checkin {
	var out []*Checkin
	for _, c := range s.checkins {
		if c.Habit == h.ID && c.Kind == kind && c.Day == day && !c.Undone {
			out = append(out, c)
		}
	}
	return out
}

func (s *Server) slotDone(h *Habit, slot, day string) *Checkin {
	for _, c := range s.standing(h, "done", day) {
		if c.Slot == slot {
			return c
		}
	}
	return nil
}

// dayView is a day of a habit with slots, as the API shows it.
func (s *Server) dayView(h *Habit, day string) map[string]any {
	slots := []map[string]any{}
	done := 0
	for _, slot := range h.Slots {
		if c := s.slotDone(h, slot.ID, day); c != nil {
			done++
			slots = append(slots, map[string]any{"id": slot.ID, "done": true, "at": c.At, "by": c.By, "via": c.Via, "source": c.Source, "checkins": []int{c.ID}})
		} else {
			slots = append(slots, map[string]any{"id": slot.ID, "done": false})
		}
	}
	state := "open"
	switch {
	case h.Paused:
		state, slots = "off", []map[string]any{}
	case done == len(h.Slots):
		state = "done"
	case len(s.standing(h, "skip", day)) > 0:
		state = "skipped"
	}
	return map[string]any{"day": day, "state": state, "done": done, "total": len(slots), "slots": slots}
}

func (s *Server) habitView(h *Habit) map[string]any {
	today, yesterday := s.today(), s.yesterday()
	streak := map[string]any{"current": h.Streak, "best": max(h.Best, h.Streak), "unit": "days", "atRisk": nil, "previous": nil}
	out := map[string]any{
		"id": h.ID, "name": h.Name, "icon": h.Icon, "color": h.Color, "dayStart": h.DayStart,
		"paused": h.Paused, "archived": h.Archived, "rev": h.Rev, "skipsLeft": h.Skips,
		"rates": map[string]any{"d7": nil, "d30": nil, "d365": nil},
	}
	if h.Icon == "" {
		out["icon"] = nil
	}
	if h.weekly() {
		visited := len(s.standing(h, "done", today)) > 0
		count := h.Week
		if visited {
			count++
		}
		state := "open"
		switch {
		case h.Paused:
			state = "off"
		case count >= h.Target:
			state = "met"
		case len(s.standing(h, "skip", today)) > 0:
			state = "skipped"
		}
		streak["unit"] = "weeks"
		if state == "met" {
			streak["current"], streak["best"] = h.Streak+1, max(h.Best, h.Streak+1)
		}
		out["schedule"] = map[string]any{"kind": "weekly", "target": h.Target, "remind": nil}
		out["today"] = map[string]any{"day": today, "done": visited, "checkins": []int{}}
		out["yesterday"] = map[string]any{"day": yesterday, "done": len(s.standing(h, "done", yesterday)) > 0, "checkins": []int{}}
		out["week"] = map[string]any{"start": today, "state": state, "count": count, "target": h.Target, "days": []string{}, "whole": true}
		out["lastWeek"] = nil
	} else {
		kind, schedule := "daily", map[string]any{"slots": h.Slots}
		if len(h.Days) > 0 {
			kind, schedule["days"] = "days", h.Days
		}
		schedule["kind"] = kind
		out["schedule"] = schedule
		t, y := s.dayView(h, today), s.dayView(h, yesterday)
		if t["state"] == "done" {
			streak["current"], streak["best"] = h.Streak+1, max(h.Best, h.Streak+1)
		}
		var missing []string
		for _, id := range h.AtRisk {
			if s.slotDone(h, id, yesterday) == nil {
				missing = append(missing, id)
			}
		}
		if len(missing) > 0 {
			streak["atRisk"] = map[string]any{"day": yesterday, "missing": missing, "until": s.stamp()}
		}
		out["today"], out["yesterday"] = t, y
	}
	out["streak"] = streak
	return out
}

var habitRE = regexp.MustCompile(`^/habits/(\d+)/(checkins|undo|skips)$`)

// routeHabits serves /habits. Called with the lock held.
func (s *Server) routeHabits(w http.ResponseWriter, r *http.Request, path, via, key string, body func(...string) (map[string]any, error), fail func(error)) {
	if s.Revision < 5 {
		writeError(w, 404, "not_found", "No such endpoint.", nil) // an app from before habits
		return
	}
	if path == "/habits" && r.Method == "GET" {
		list := []map[string]any{}
		for _, h := range s.habits {
			if !h.Archived || r.URL.Query().Get("archived") == "true" {
				list = append(list, s.habitView(h))
			}
		}
		writeJSON(w, 200, map[string]any{"habits": list, "zone": "America/Chicago", "version": s.habitsVersion})
		return
	}
	m := habitRE.FindStringSubmatch(path)
	if m == nil || r.Method != "POST" {
		writeError(w, 404, "not_found", "No such endpoint.", nil)
		return
	}
	id, _ := strconv.Atoi(m[1])
	h := s.findHabit(id)
	if h == nil {
		fail(refuse(404, "not_found", "No habit with id #%d", id))
		return
	}
	in, err := body("slot", "day", "skip", "reason", "at", "zone", "source", "checkins", "keys")
	if err != nil {
		fail(err)
		return
	}
	day := s.today()
	switch asked, _ := in["day"].(string); asked {
	case "", "today", day:
	case "yesterday", s.yesterday():
		day = s.yesterday()
	default:
		fail(refuse(400, "too_late", "You can log yesterday until the end of today, but no further back."))
		return
	}
	// The slot that was named, by id or by name.
	slot := ""
	if asked, _ := in["slot"].(string); asked != "" {
		for _, known := range h.Slots {
			if known.ID == strings.ToLower(asked) || strings.EqualFold(known.Name, asked) {
				slot = known.ID
			}
		}
		if slot == "" {
			ids := make([]string, len(h.Slots))
			for i, known := range h.Slots {
				ids[i] = known.ID
			}
			if h.weekly() {
				fail(refuse(400, "no_such_slot", "%q has no slots.", h.Name))
			} else {
				fail(refuse(400, "no_such_slot", "%q has no slot %q. It has: %s.", h.Name, asked, strings.Join(ids, ", ")))
			}
			return
		}
	}
	for _, c := range s.checkins {
		if key != "" && c.Key == key { // sent before: answer as then, and change nothing
			writeJSON(w, 200, map[string]any{"habit": s.habitView(h), map[bool]string{true: "skip", false: "checkin"}[c.Kind == "skip"]: c})
			return
		}
	}

	switch m[2] {
	case "checkins":
		if h.Archived {
			fail(refuse(400, "archived", "%q is archived. Bring it back to check in.", h.Name))
			return
		}
		if slot == "" && !h.weekly() {
			for _, known := range h.Slots { // whichever is still to do
				if s.slotDone(h, known.ID, day) == nil {
					slot = known.ID
					break
				}
			}
			if slot == "" {
				writeJSON(w, 200, map[string]any{"habit": s.habitView(h), "checkin": nil})
				return
			}
		}
		source, _ := in["source"].(string)
		if source == "" {
			source = "manual"
		}
		c := s.record(h, "done", slot, day, "me", via, source, key)
		s.habitsChanged()
		writeJSON(w, 201, map[string]any{"habit": s.habitView(h), "checkin": c})
	case "undo":
		kind := "done"
		if skip, _ := in["skip"].(bool); skip {
			kind = "skip"
		}
		changed := false
		for _, c := range s.standing(h, kind, day) {
			if slot == "" || c.Slot == slot {
				c.Undone, changed = true, true
				if kind == "skip" {
					h.Skips++
				}
			}
		}
		if changed {
			s.habitsChanged()
		}
		writeJSON(w, 200, map[string]any{"habit": s.habitView(h)})
	case "skips":
		state := "open"
		if h.weekly() {
			state, _ = s.habitView(h)["week"].(map[string]any)["state"].(string)
		} else {
			state, _ = s.dayView(h, day)["state"].(string)
		}
		if state != "open" {
			writeJSON(w, 200, map[string]any{"habit": s.habitView(h), "skip": nil})
			return
		}
		if h.Skips == 0 {
			fail(refuse(400, "skip_limit", "You can skip 2 days in any 7 and 6 days in any 30. For a longer break, pause %q: its streak waits for you.", h.Name))
			return
		}
		h.Skips--
		c := s.record(h, "skip", "", day, "me", via, "", key)
		s.habitsChanged()
		writeJSON(w, 201, map[string]any{"habit": s.habitView(h), "skip": c})
	}
}
