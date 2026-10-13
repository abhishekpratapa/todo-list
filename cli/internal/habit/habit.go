// Package habit says how habits read in a terminal: the order of today's list
// and the words for progress and streaks. It follows what the app and the
// iPhone say (src/habit-text.js in the repository this sits in).
//
// Nothing about streaks is worked out here. The app does that, and what it
// answers is shown as it is.
package habit

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"todos/internal/api"
)

// Due says whether something is still to do today: an open day, or for a habit
// counted in weeks, a week not yet met on a day without a check-in.
func Due(h *api.Habit) bool {
	if h.Paused || h.Archived {
		return false
	}
	if h.Weekly() {
		return !h.Today.CheckedIn && h.Week != nil && h.Week.State == "open"
	}
	return h.Today.State == "open"
}

// Done says whether today asks nothing more: done, or for a habit counted in
// weeks, checked in today or the week already met.
func Done(h *api.Habit) bool {
	if h.Paused || h.Archived {
		return false
	}
	if h.Weekly() {
		return h.Today.CheckedIn || (h.Week != nil && h.Week.State == "met")
	}
	return h.Today.State == "done"
}

// Group is where a habit goes in today's list: "due", "done" or "off".
func Group(h *api.Habit) string {
	switch {
	case Due(h):
		return "due"
	case Done(h):
		return "done"
	}
	return "off"
}

func minutes(clock string) int {
	t, err := time.Parse("15:04", clock)
	if err != nil {
		return 0
	}
	return t.Hour()*60 + t.Minute()
}

// minutesAfter is the minutes from start to clock, going forward round the clock.
func minutesAfter(clock, start string) int {
	return (minutes(clock) - minutes(start) + 24*60) % (24 * 60)
}

const never = 24*60 + 1

// nextDue is when the next thing still to do today is due, in minutes after
// the habit's day start; never when nothing has a time, or nothing is left.
func nextDue(h *api.Habit) int {
	if h.Weekly() {
		r := h.Schedule.Remind
		if r == nil {
			return never
		}
		day, err := time.Parse("2006-01-02", h.Today.Day)
		if err != nil {
			return never
		}
		today := strings.ToLower(day.Weekday().String()[:3])
		for _, d := range r.Days {
			if d == today {
				return minutesAfter(r.Time, h.DayStart)
			}
		}
		return never
	}
	soonest := never
	for _, open := range h.Today.Remaining() {
		slot := h.Slot(open.ID)
		if slot == nil {
			continue
		}
		at := slot.Remind
		if at == "" {
			at = slot.From
		}
		if at != "" {
			soonest = min(soonest, minutesAfter(at, h.DayStart))
		}
	}
	return soonest
}

// Today is today's list: what is still to do, soonest first (anything without
// a time last); then what is done; then what expects nothing today. Archived
// habits are left out.
type Today struct {
	Due, Done, Off []api.Habit
}

// ForToday sorts habits into today's list.
func ForToday(habits []api.Habit) Today {
	var t Today
	for _, h := range habits {
		if h.Archived {
			continue
		}
		switch Group(&h) {
		case "due":
			t.Due = append(t.Due, h)
		case "done":
			t.Done = append(t.Done, h)
		default:
			t.Off = append(t.Off, h)
		}
	}
	sort.SliceStable(t.Due, func(i, j int) bool {
		a, b := nextDue(&t.Due[i]), nextDue(&t.Due[j])
		if a != b {
			return a < b
		}
		return t.Due[i].ID < t.Due[j].ID
	})
	return t
}

// All is today's list in one piece, in order.
func (t Today) All() []api.Habit {
	return append(append(append([]api.Habit{}, t.Due...), t.Done...), t.Off...)
}

// Left is how many slots (or, for habits counted in weeks, visits) are still
// to do today, across every habit.
func Left(habits []api.Habit) int {
	n := 0
	for i := range habits {
		h := &habits[i]
		switch {
		case !Due(h):
		case h.Weekly():
			n++
		default:
			n += len(h.Today.Remaining())
		}
	}
	return n
}

// SlotName is what a slot is called. One with no name goes by its id.
func SlotName(h *api.Habit, id string) string {
	if slot := h.Slot(id); slot != nil && slot.Name != "" {
		return slot.Name
	}
	if id == "" {
		return ""
	}
	return strings.ToUpper(id[:1]) + id[1:]
}

// Progress is the line beside a habit's name: how today stands.
func Progress(h *api.Habit) string {
	if h.Paused {
		return "Paused"
	}
	if h.Weekly() {
		if h.Week == nil {
			return ""
		}
		w := h.Week
		switch w.State {
		case "met":
			return fmt.Sprintf("%d of %d this week · done", w.Count, w.Target)
		case "skipped":
			return "Rest week"
		case "off":
			return fmt.Sprintf("%d this week", w.Count)
		}
		return fmt.Sprintf("%d of %d this week", w.Count, w.Target)
	}
	d := h.Today
	switch d.State {
	case "off":
		return "Not today"
	case "skipped":
		return "Rest day"
	case "done":
		if d.Total > 1 {
			return fmt.Sprintf("%d of %d · done", d.Total, d.Total)
		}
		return "Done today"
	}
	// What is next: the first slot still to do, and when it is due.
	var parts []string
	if d.Total > 1 {
		parts = append(parts, fmt.Sprintf("%d of %d", d.Done, d.Total))
	}
	if open := d.Remaining(); len(open) > 0 {
		if slot := h.Slot(open[0].ID); slot != nil {
			if when := strings.TrimSpace(slot.Name + " " + slot.Remind); when != "" {
				parts = append(parts, when)
			}
		}
	}
	if len(parts) == 0 {
		return "To do today"
	}
	return strings.Join(parts, " · ")
}

// Count is today's progress as numbers: "1/2", or for a habit counted in
// weeks, days this week out of the target.
func Count(h *api.Habit) string {
	if h.Weekly() {
		if h.Week == nil {
			return "0/0"
		}
		return fmt.Sprintf("%d/%d", h.Week.Count, h.Week.Target)
	}
	return fmt.Sprintf("%d/%d", h.Today.Done, h.Today.Total)
}

// Length is a streak in words: "12 days", "1 week".
func Length(count int, unit string) string {
	word := "day"
	if unit == "weeks" {
		word = "week"
	}
	if count != 1 {
		word += "s"
	}
	return fmt.Sprintf("%d %s", count, word)
}

// Streak is a streak as one short word for a pipe: "12d", "3w".
func Streak(h *api.Habit) string {
	unit := "d"
	if h.Streak.Unit == "weeks" {
		unit = "w"
	}
	return fmt.Sprintf("%d%s", h.Streak.Current, unit)
}

// AtRisk says what to do when yesterday is unfinished and a streak hangs on
// it, or "" when nothing does.
func AtRisk(h *api.Habit) string {
	risk := h.Streak.AtRisk
	if risk == nil || h.Streak.Current == 0 || h.Paused || h.Archived {
		return ""
	}
	unit := "day"
	if h.Streak.Unit == "weeks" {
		unit = "week"
	}
	streak := fmt.Sprintf("your %d-%s streak", h.Streak.Current, unit)
	if h.Weekly() {
		return "Log yesterday’s visit by the end of today to keep " + streak + "."
	}
	what := "yesterday"
	if h.Yesterday.Total > 1 && len(risk.Missing) > 0 {
		names := make([]string, len(risk.Missing))
		for i, id := range risk.Missing {
			names[i] = strings.ToLower(SlotName(h, id))
		}
		what = "yesterday’s " + strings.Join(names, " and ")
	}
	return "Log " + what + " by the end of today to keep " + streak + "."
}

// Find matches what the user typed against habits' names: every word must
// appear in the name, an exact name wins, and habits not archived are
// preferred. It returns the candidates; one means found.
func Find(habits []api.Habit, ref string) []api.Habit {
	words := strings.Fields(strings.ToLower(ref))
	var current, archived, exact []api.Habit
	for _, h := range habits {
		name := strings.ToLower(h.Name)
		matches := len(words) > 0
		for _, w := range words {
			matches = matches && strings.Contains(name, w)
		}
		if !matches {
			continue
		}
		if name == strings.ToLower(strings.TrimSpace(ref)) && !h.Archived {
			exact = append(exact, h)
		}
		if h.Archived {
			archived = append(archived, h)
		} else {
			current = append(current, h)
		}
	}
	switch {
	case len(exact) == 1:
		return exact
	case len(current) > 0:
		return current
	}
	return archived
}
