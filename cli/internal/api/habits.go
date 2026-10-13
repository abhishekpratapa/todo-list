package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// HabitsRevision is the API revision that added habits. Everything else this
// client does works with RequiredRevision.
const HabitsRevision = 5

// HabitSlot is one of the times of day a habit is done at.
type HabitSlot struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Remind string `json:"remind"` // "07:30", or empty
	From   string `json:"from"`
	Until  string `json:"until"`
	Nudge  string `json:"nudge"`
}

// HabitRemind is when a habit counted in weeks reminds.
type HabitRemind struct {
	Days []string `json:"days"`
	Time string   `json:"time"`
}

// HabitSchedule is when a habit is done: every day ("daily") or on some days
// of the week ("days") at its slots, or a number of days a week ("weekly").
type HabitSchedule struct {
	Kind   string       `json:"kind"`
	Slots  []HabitSlot  `json:"slots"`
	Days   []string     `json:"days"`
	Target int          `json:"target"`
	Remind *HabitRemind `json:"remind"`
}

// HabitSlotState is how one slot of a day stands.
type HabitSlotState struct {
	ID     string `json:"id"`
	Done   bool   `json:"done"`
	At     string `json:"at"`
	By     string `json:"by"`
	Via    string `json:"via"`
	Source string `json:"source"`
}

// HabitDay is today or yesterday. A habit with slots has State, Done (how many
// slots), Total and Slots; one counted in weeks has only whether it was
// checked in that day, which arrives under the same name "done".
type HabitDay struct {
	Day       string
	State     string // open, done, skipped, off (and partial or missed, for days gone by)
	Done      int
	Total     int
	Slots     []HabitSlotState
	CheckedIn bool // a habit counted in weeks: there is a check-in that day
}

func (d *HabitDay) UnmarshalJSON(b []byte) error {
	var raw struct {
		Day   string           `json:"day"`
		State string           `json:"state"`
		Done  json.RawMessage  `json:"done"`
		Total int              `json:"total"`
		Slots []HabitSlotState `json:"slots"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*d = HabitDay{Day: raw.Day, State: raw.State, Total: raw.Total, Slots: raw.Slots}
	if json.Unmarshal(raw.Done, &d.CheckedIn) != nil {
		_ = json.Unmarshal(raw.Done, &d.Done)
	}
	return nil
}

// Remaining is the slots of the day still to do.
func (d *HabitDay) Remaining() []HabitSlotState {
	var open []HabitSlotState
	for _, s := range d.Slots {
		if !s.Done {
			open = append(open, s)
		}
	}
	return open
}

// HabitWeek is a week of a habit counted in weeks: met, skipped, open, missed or off.
type HabitWeek struct {
	Start  string   `json:"start"`
	State  string   `json:"state"`
	Count  int      `json:"count"`
	Target int      `json:"target"`
	Days   []string `json:"days"`
}

// HabitStreak is worked out by the app, never here.
type HabitStreak struct {
	Current int    `json:"current"`
	Best    int    `json:"best"`
	Unit    string `json:"unit"` // "days" or "weeks"
	// AtRisk is set while yesterday is unfinished and the streak hangs on it.
	AtRisk *struct {
		Day     string   `json:"day"`
		Missing []string `json:"missing"`
		Until   string   `json:"until"`
	} `json:"atRisk"`
}

// Habit is a habit as the API sends it. Like Task, it marshals back to exactly
// what arrived, so `--json` output is the server's own.
type Habit struct {
	ID        int           `json:"id"`
	Name      string        `json:"name"`
	Icon      string        `json:"icon"`
	Color     string        `json:"color"`
	DayStart  string        `json:"dayStart"`
	Schedule  HabitSchedule `json:"schedule"`
	Paused    bool          `json:"paused"`
	Archived  bool          `json:"archived"`
	Rev       int           `json:"rev"`
	Today     HabitDay      `json:"today"`
	Yesterday HabitDay      `json:"yesterday"`
	Week      *HabitWeek    `json:"week"`
	Streak    HabitStreak   `json:"streak"`
	SkipsLeft int           `json:"skipsLeft"`

	Raw json.RawMessage `json:"-"`
}

func (h *Habit) UnmarshalJSON(b []byte) error {
	type plain Habit
	if err := json.Unmarshal(b, (*plain)(h)); err != nil {
		return err
	}
	h.Raw = append(json.RawMessage(nil), b...)
	return nil
}

func (h Habit) MarshalJSON() ([]byte, error) {
	if h.Raw != nil {
		return h.Raw, nil
	}
	type plain Habit
	return json.Marshal(plain(h))
}

// Weekly says whether the habit is counted in weeks, with no slots.
func (h *Habit) Weekly() bool { return h.Schedule.Kind == "weekly" }

// Slot finds one of the habit's slots by id.
func (h *Habit) Slot(id string) *HabitSlot {
	for i := range h.Schedule.Slots {
		if h.Schedule.Slots[i].ID == id {
			return &h.Schedule.Slots[i]
		}
	}
	return nil
}

// HabitList is what GET /habits answers. Zone is where the app takes "today" to be.
type HabitList struct {
	Habits  []Habit `json:"habits"`
	Zone    string  `json:"zone"`
	Version int     `json:"version"`
}

// HabitResult is what a change to a habit answers: the habit as it is now, and
// what was recorded. Checkin (or Skip) is null when there was nothing to do.
// Raw is the answer exactly as it came.
type HabitResult struct {
	Habit   Habit           `json:"habit"`
	Checkin json.RawMessage `json:"checkin,omitempty"`
	Skip    json.RawMessage `json:"skip,omitempty"`

	Raw json.RawMessage `json:"-"`
}

// Recorded says whether the change recorded anything.
func (r *HabitResult) Recorded() bool {
	for _, v := range []json.RawMessage{r.Checkin, r.Skip} {
		if len(v) > 0 && string(v) != "null" {
			return true
		}
	}
	return false
}

// Slot is the slot a check-in was recorded for, or empty.
func (r *HabitResult) Slot() string {
	var c struct {
		Slot string `json:"slot"`
	}
	_ = json.Unmarshal(r.Checkin, &c)
	return c.Slot
}

func habitPath(id int, rest ...string) string {
	p := v1 + "/habits/" + strconv.Itoa(id)
	for _, r := range rest {
		p += r
	}
	return p
}

// Habits lists the habits, with those put away too if archived is set.
func (c *Client) Habits(ctx context.Context, archived bool) (*HabitList, json.RawMessage, error) {
	r := request{method: "GET", path: v1 + "/habits"}
	if archived {
		r.query = url.Values{"archived": {"true"}}
	}
	var raw json.RawMessage
	if err := c.do(ctx, r, &raw); err != nil {
		return nil, nil, err
	}
	var out HabitList
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil, err
	}
	return &out, raw, nil
}

func (c *Client) changeHabit(ctx context.Context, r request) (*HabitResult, error) {
	r.key = newKey()
	var raw json.RawMessage
	if err := c.do(ctx, r, &raw); err != nil {
		return nil, err
	}
	out := HabitResult{Raw: raw}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// habitBody is what a check-in, an undo or a skip is sent with. Empty fields
// are left out: the app then takes the slot still to do, and today.
func habitBody(slot, day string, more map[string]any) map[string]any {
	body := map[string]any{}
	if slot != "" {
		body["slot"] = slot
	}
	if day != "" {
		body["day"] = day
	}
	for k, v := range more {
		body[k] = v
	}
	return body
}

// CheckIn records that a habit was done. slot may be a slot's id or its name;
// empty means whichever is still to do. day is "", "today" or "yesterday".
func (c *Client) CheckIn(ctx context.Context, id int, slot, day string) (*HabitResult, error) {
	return c.changeHabit(ctx, request{method: "POST", path: habitPath(id, "/checkins"), body: habitBody(slot, day, nil)})
}

// UndoCheckIn takes back the check-ins of a slot that day, or with no slot,
// every check-in that day.
func (c *Client) UndoCheckIn(ctx context.Context, id int, slot, day string) (*HabitResult, error) {
	return c.changeHabit(ctx, request{method: "POST", path: habitPath(id, "/undo"), body: habitBody(slot, day, nil)})
}

// SkipHabit marks the day (for a habit counted in weeks, the week) as a rest.
func (c *Client) SkipHabit(ctx context.Context, id int, day, reason string) (*HabitResult, error) {
	more := map[string]any{}
	if reason != "" {
		more["reason"] = reason
	}
	return c.changeHabit(ctx, request{method: "POST", path: habitPath(id, "/skips"), body: habitBody("", day, more)})
}

// UndoSkip takes a rest day back.
func (c *Client) UndoSkip(ctx context.Context, id int, day string) (*HabitResult, error) {
	return c.changeHabit(ctx, request{method: "POST", path: habitPath(id, "/undo"), body: habitBody("", day, map[string]any{"skip": true})})
}
