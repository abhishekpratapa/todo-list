package out

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"

	"todos/internal/api"
	"todos/internal/habit"
)

// habitState is where a habit stands today, in one word: due, done, off,
// paused or archived.
func habitState(h *api.Habit) string {
	switch {
	case h.Archived:
		return "archived"
	case h.Paused:
		return "paused"
	}
	return habit.Group(h)
}

// HabitRow is a habit as one plain line: id, where it stands today (due, done,
// off, paused or archived), today's count (slots done of slots, or for a habit
// counted in weeks, days this week of the target), its streak (12d, 3w) and
// its name, separated by tabs.
func HabitRow(h *api.Habit) string {
	return fmt.Sprintf("%d\t%s\t%s\t%s\t%s", h.ID, habitState(h), habit.Count(h), habit.Streak(h), oneLine(h.Name))
}

func (p *Printer) streakCell(h *api.Habit) string {
	if h.Streak.Current == 0 {
		return ""
	}
	text := habit.Length(h.Streak.Current, h.Streak.Unit)
	if h.Streak.AtRisk != nil {
		return p.style(yellow, text+", at risk")
	}
	return p.style(orange, text)
}

// Habits prints today's list: one HabitRow per habit for a pipe, in the order
// of the day; on a terminal, what is left, what is done and what asks nothing
// today under headings, each habit with how today stands and its streak.
func (p *Printer) Habits(habits []api.Habit) {
	today := habit.ForToday(habits)
	var archived []api.Habit
	for _, h := range habits {
		if h.Archived {
			archived = append(archived, h)
		}
	}
	if !p.Styled {
		for _, list := range [][]api.Habit{today.Due, today.Done, today.Off, archived} {
			for i := range list {
				fmt.Fprintln(p.W, HabitRow(&list[i]))
			}
		}
		return
	}
	if len(habits) == 0 {
		fmt.Fprintln(p.W, p.style(faint, "No habits yet. Make one in Todos on the iPhone."))
		return
	}
	groups := []struct {
		title string
		list  []api.Habit
	}{
		{fmt.Sprintf("To do today (%d)", habit.Left(habits)), today.Due},
		{fmt.Sprintf("Done (%d)", len(today.Done)), today.Done},
		{"Not today", today.Off},
		{"Archived", archived},
	}
	var wID, wName, wProgress int
	for i := range habits {
		h := &habits[i]
		wID = max(wID, len(fmt.Sprintf("#%d", h.ID)))
		wName = max(wName, lipgloss.Width(oneLine(h.Name)))
		wProgress = max(wProgress, lipgloss.Width(habit.Progress(h)))
	}
	printed := false
	for _, g := range groups {
		if len(g.list) == 0 {
			continue
		}
		if printed {
			fmt.Fprintln(p.W)
		}
		printed = true
		fmt.Fprintln(p.W, p.style(bold, g.title))
		for i := range g.list {
			h := &g.list[i]
			name := oneLine(h.Name)
			if habit.Due(h) {
				name = p.style(bold, name)
			} else {
				name = p.style(faint, name)
			}
			line := pad(p.style(faint, fmt.Sprintf("#%d", h.ID)), wID) + "  " + pad(name, wName) + "  " + pad(habit.Progress(h), wProgress)
			if streak := p.streakCell(h); streak != "" {
				line += "  " + streak
			}
			fmt.Fprintln(p.W, strings.TrimRight(line, " "))
			if risk := habit.AtRisk(h); risk != "" {
				fmt.Fprintln(p.W, p.style(faint, strings.Repeat(" ", wID+2)+risk))
			}
		}
	}
}

// HabitChanged prints the result of a change to one habit: its HabitRow for a
// pipe, or a line saying what happened on a terminal. what names the slot or
// the day, if there is one to name: "evening", "yesterday".
func (p *Printer) HabitChanged(verb string, h *api.Habit, what string, happened bool) {
	if !p.Styled {
		fmt.Fprintln(p.W, HabitRow(h))
		return
	}
	mark := p.style(green, "✓")
	if !happened {
		mark = p.style(faint, "·")
	}
	line := fmt.Sprintf("%s %s %s", mark, verb, p.style(faint, fmt.Sprintf("#%d", h.ID))+" "+p.style(bold, oneLine(h.Name)))
	if what != "" {
		line += " " + p.style(faint, "("+what+")")
	}
	details := []string{habit.Progress(h)}
	if h.Streak.Current > 0 {
		details = append(details, habit.Length(h.Streak.Current, h.Streak.Unit)+" in a row")
	}
	fmt.Fprintln(p.W, line+"  "+p.style(faint, strings.Join(details, " · ")))
}
