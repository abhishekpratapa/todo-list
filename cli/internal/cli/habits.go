package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/habit"
)

// habits opens a session for a habit command, and refuses if the app on the
// other side is older than habits. Everything else works with such an app.
func (a *App) habits(ctx context.Context) (*Session, error) {
	s, err := a.connect(ctx)
	if err != nil {
		return nil, err
	}
	if s.Info.APIVersion.Revision < api.HabitsRevision {
		return nil, &api.VersionError{AppTooOld: true, Feature: "habits", Have: strconv.Itoa(s.Info.APIVersion.Revision), Need: strconv.Itoa(api.HabitsRevision)}
	}
	return s, nil
}

// pickHabit turns what the user typed into one of the habits. A number (3 or
// #3) is the id. Anything else is matched against names: every word must
// appear in the name, an exact name wins, and habits that are not archived are
// preferred. Several matches are offered as a choice on a terminal, and are an
// error (listing them) anywhere else.
func (a *App) pickHabit(habits []api.Habit, ref string) (*api.Habit, error) {
	ref = strings.TrimSpace(ref)
	if m := idRE.FindStringSubmatch(ref); m != nil {
		id, _ := strconv.Atoi(m[1])
		for i := range habits {
			if habits[i].ID == id {
				return &habits[i], nil
			}
		}
		return nil, &notFoundError{fmt.Sprintf("there is no habit #%d", id)}
	}
	if ref == "" {
		return nil, usagef("which habit? Give its number or some words from its name")
	}
	found := habit.Find(habits, ref)
	switch len(found) {
	case 0:
		return nil, &notFoundError{fmt.Sprintf("no habit's name matches %q", ref)}
	case 1:
		return &found[0], nil
	}
	if !a.interactive() {
		lines := make([]string, len(found))
		for i, h := range found {
			lines[i] = fmt.Sprintf("  #%d  %s", h.ID, h.Name)
		}
		return nil, usagef("%q matches %d habits; use a number:\n%s", ref, len(found), strings.Join(lines, "\n"))
	}
	options := make([]string, len(found))
	for i, h := range found {
		options[i] = fmt.Sprintf("#%d  %s", h.ID, h.Name)
	}
	choice, err := a.prompter().Choose(fmt.Sprintf("Which habit did you mean by %q?", ref), options)
	if err != nil {
		return nil, err
	}
	return &found[choice], nil
}

// habitArgs completes habit arguments with the habits' names.
func (a *App) habitArgs(cmd *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Second)
	defer cancel()
	var out []string
	if s, err := a.connect(ctx, connectOptions{noStart: true}); err == nil && s.Info.APIVersion.Revision >= api.HabitsRevision {
		if list, _, err := s.Client.Habits(ctx, false); err == nil {
			for _, h := range habit.ForToday(list.Habits).All() {
				out = append(out, fmt.Sprintf("%d\t%s", h.ID, h.Name))
			}
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp | cobra.ShellCompDirectiveKeepOrder
}

// eachHabit runs fn for every habit named in refs, in order, stopping at the
// first failure. fn is given the habit as it stood before, and answers with
// what to say about the change and whether anything happened.
func (a *App) eachHabit(ctx context.Context, refs []string, fn func(*Session, *api.Habit) (res *api.HabitResult, verb, what string, happened bool, err error)) error {
	s, err := a.habits(ctx)
	if err != nil {
		return err
	}
	list, _, err := s.Client.Habits(ctx, true)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		h, err := a.pickHabit(list.Habits, ref)
		if err != nil {
			return err
		}
		res, verb, what, happened, err := fn(s, h)
		if err != nil {
			return err
		}
		p := a.p()
		switch {
		case a.json && len(refs) > 1:
			err = p.Line(res.Raw) // several results: one object to a line
		case a.json:
			err = p.Value(res.Raw)
		default:
			p.HabitChanged(verb, &res.Habit, what, happened)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// alreadyDone says whether a check-in would add nothing: the slot that was
// named (by id or name) is done that day, or for a habit counted in weeks, the
// day has its visit. The app would record a second check-in and count it once;
// there is no need to send one.
func alreadyDone(h *api.Habit, slot string, yesterday bool) bool {
	day := h.Today
	if yesterday {
		day = h.Yesterday
	}
	if h.Weekly() {
		return slot == "" && day.CheckedIn
	}
	wanted := strings.ToLower(strings.TrimSpace(slot))
	if wanted == "" {
		return false // the app says so itself, when nothing is left
	}
	for _, s := range h.Schedule.Slots {
		if s.ID != wanted && strings.ToLower(s.Name) != wanted {
			continue
		}
		for _, state := range day.Slots {
			if state.ID == s.ID {
				return state.Done
			}
		}
	}
	return false
}

// dayOf is the day a command is about, as the API names it.
func dayOf(yesterday bool) string {
	if yesterday {
		return "yesterday"
	}
	return ""
}

// about is what a result line says in brackets: the slot, and yesterday if so.
func about(h *api.Habit, slot string, yesterday bool) string {
	var parts []string
	if slot != "" {
		if name := habit.SlotName(h, slot); h.Slot(slot) == nil || h.Slot(slot).Name != "" {
			parts = append(parts, strings.ToLower(name))
		}
	}
	if yesterday {
		parts = append(parts, "yesterday")
	}
	return strings.Join(parts, ", ")
}

func (a *App) habitCommand() *cobra.Command {
	cmd := a.habitLsCmd()
	cmd.Use = "habit"
	cmd.Aliases = []string{"habits"}
	cmd.Short = "Habits: what is left today, check-ins and streaks"
	cmd.Long = "Habits are routines you check in on, each with a streak: brushing your teeth\n" +
		"morning and evening, the gym three times a week. On its own, `todos habit` lists\n" +
		"them as `todos habit ls` does.\n\n" +
		"Streaks are worked out by the app and shown here as they are. Habits are made\n" +
		"and edited in Todos on the iPhone."
	cmd.Example = "todos habit\ntodos habit done brush --slot evening\ntodos habit done gym --yesterday\ntodos habit skip floss -m \"travelling\""
	cmd.Args = func(cmd *cobra.Command, args []string) error {
		if len(args) > 0 {
			return usagef("unknown command %q (see `todos habit --help`)", args[0])
		}
		return nil
	}
	cmd.AddCommand(a.habitLsCmd(), a.habitDoneCmd(), a.habitUndoCmd(), a.habitSkipCmd())
	return cmd
}

func (a *App) habitLsCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List habits: how today stands, and streaks",
		Long: "List habits in the order of the day: what is still to do (soonest first), what\n" +
			"is done, then what asks nothing today.\n\n" +
			"For a pipe, each habit is one line of tab-separated fields: id, where it stands\n" +
			"today (due, done, off, paused or archived), today's count (1/2: slots done of\n" +
			"slots; for a habit counted in weeks, days this week of its target), its streak\n" +
			"(12d, 3w) and its name. With --json the output is the API's own:\n" +
			"{\"habits\": [...], \"zone\": \"...\", \"version\": n}.",
		Example: "todos habit ls\ntodos habit ls --json | jq -r '.habits[] | select(.today.state == \"open\") | .name'",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s, err := a.habits(cmd.Context())
			if err != nil {
				return err
			}
			list, raw, err := s.Client.Habits(cmd.Context(), all)
			if err != nil {
				return err
			}
			p := a.p()
			if a.json {
				return p.Value(raw)
			}
			p.Habits(list.Habits)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&all, "all", "a", false, "include archived habits")
	return cmd
}

func (a *App) habitDoneCmd() *cobra.Command {
	var slot string
	var yesterday bool
	cmd := &cobra.Command{
		Use:   "done <habit>...",
		Short: "Check in a habit",
		Long: "Check in a habit: record that you did it. A habit is named by its number or by\n" +
			"words from its name.\n\n" +
			"For a habit done at several times of day, --slot says which (by name: morning,\n" +
			"evening). Without it the app takes whichever is still to do: the one whose hours\n" +
			"it is now, else the earliest. Yesterday can be logged until today ends, and\n" +
			"nothing further back.\n\n" +
			"Checking in something already done changes nothing and is not an error.\n" +
			"With --json: {\"habit\": {...}, \"checkin\": {...}}, where checkin is null if there\n" +
			"was nothing left to check in.",
		Example:           "todos habit done floss\ntodos habit done brush --slot evening\ntodos habit done gym --yesterday",
		Args:              atLeast(1, "which habit?"),
		ValidArgsFunction: a.habitArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.eachHabit(cmd.Context(), args, func(s *Session, h *api.Habit) (*api.HabitResult, string, string, bool, error) {
				if alreadyDone(h, slot, yesterday) {
					raw, _ := json.Marshal(map[string]any{"habit": h, "checkin": nil})
					return &api.HabitResult{Habit: *h, Raw: raw}, "Already checked in", about(h, "", yesterday), false, nil
				}
				res, err := s.Client.CheckIn(cmd.Context(), h.ID, slot, dayOf(yesterday))
				if err != nil {
					return nil, "", "", false, err
				}
				if !res.Recorded() {
					return res, "Already checked in", about(h, "", yesterday), false, nil
				}
				return res, "Checked in", about(h, res.Slot(), yesterday), true, nil
			})
		},
	}
	cmd.Flags().StringVar(&slot, "slot", "", "which time of day, by `name`: morning, evening…")
	cmd.Flags().BoolVar(&yesterday, "yesterday", false, "log it for yesterday, which is possible until today ends")
	return cmd
}

func (a *App) habitUndoCmd() *cobra.Command {
	var slot string
	var yesterday bool
	cmd := &cobra.Command{
		Use:   "undo <habit>...",
		Short: "Take a check-in back",
		Long: "Take back a habit's check-ins for today (or yesterday): those of one time of day\n" +
			"with --slot, otherwise all of them.\n\n" +
			"With --json: {\"habit\": {...}}.",
		Example:           "todos habit undo floss --slot evening",
		Args:              atLeast(1, "which habit?"),
		ValidArgsFunction: a.habitArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.eachHabit(cmd.Context(), args, func(s *Session, h *api.Habit) (*api.HabitResult, string, string, bool, error) {
				res, err := s.Client.UndoCheckIn(cmd.Context(), h.ID, slot, dayOf(yesterday))
				if err != nil {
					return nil, "", "", false, err
				}
				was, is := h.Today, res.Habit.Today
				if yesterday {
					was, is = h.Yesterday, res.Habit.Yesterday
				}
				if was.Done == is.Done && was.CheckedIn == is.CheckedIn {
					return res, "Nothing to take back for", about(h, "", yesterday), false, nil
				}
				return res, "Took back", about(h, "", yesterday), true, nil
			})
		},
	}
	cmd.Flags().StringVar(&slot, "slot", "", "which time of day, by `name`: morning, evening…")
	cmd.Flags().BoolVar(&yesterday, "yesterday", false, "take back yesterday's")
	return cmd
}

func (a *App) habitSkipCmd() *cobra.Command {
	var yesterday, undo bool
	var reason string
	cmd := &cobra.Command{
		Use:   "skip <habit>...",
		Short: "Take a rest day",
		Long: "Mark today (or yesterday) as a rest day for a habit: it neither breaks the\n" +
			"streak nor adds to it. For a habit counted in weeks, it is the week that rests.\n\n" +
			"The app allows 2 rest days in any 7 and 6 in any 30 (one week in any 4), and\n" +
			"refuses beyond that; for a longer break, pause the habit in the app. A day that\n" +
			"is done, or asks nothing, has nothing to rest: that changes nothing and is not\n" +
			"an error. --undo takes a rest day back.\n\n" +
			"With --json: {\"habit\": {...}, \"skip\": {...}}, where skip is null if there was\n" +
			"nothing to rest ({\"habit\": {...}} with --undo).",
		Example:           "todos habit skip floss -m \"travelling\"\ntodos habit skip floss --undo",
		Args:              atLeast(1, "which habit?"),
		ValidArgsFunction: a.habitArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.eachHabit(cmd.Context(), args, func(s *Session, h *api.Habit) (*api.HabitResult, string, string, bool, error) {
				rest := "rest day"
				if h.Weekly() {
					rest = "rest week"
				}
				if undo {
					res, err := s.Client.UndoSkip(cmd.Context(), h.ID, dayOf(yesterday))
					if err != nil {
						return nil, "", "", false, err
					}
					return res, "Took back the " + rest + " for", about(h, "", yesterday), true, nil
				}
				res, err := s.Client.SkipHabit(cmd.Context(), h.ID, dayOf(yesterday), reason)
				if err != nil {
					return nil, "", "", false, err
				}
				if !res.Recorded() {
					return res, "Nothing to rest for", about(h, "", yesterday), false, nil
				}
				return res, strings.ToUpper(rest[:1]) + rest[1:] + " for", about(h, "", yesterday), true, nil
			})
		},
	}
	f := cmd.Flags()
	f.BoolVar(&yesterday, "yesterday", false, "rest yesterday instead, which is possible until today ends")
	f.BoolVar(&undo, "undo", false, "take the rest day back")
	f.StringVarP(&reason, "message", "m", "", "why, kept with the rest day")
	return cmd
}
