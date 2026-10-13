// Habit reminders shown by the Mac itself, for someone who wants them here as
// well as (or instead of) on the iPhone. The app shows them only while "Habit
// Reminders on This Mac" is on, which it is not to begin with.
//
// The iPhone lays its reminders out days ahead, because it may not be running
// when one is due. The Mac app is running, so it just looks every few seconds
// for what has come due and is still open. Times are this Mac's own clock:
// 07:30 is 07:30 wherever the Mac is.

import { addDays, weekday } from './streaks.js';
import { length } from './habit-text.js';

const GRACE_MS = 2 * 3600e3; // how long after its time a reminder is still worth showing, when its slot has no window

// The same names the iPhone gives its notifications.
export const reminderKey = (habit, slot, day, nudge = false) => `habit-${habit}-${slot ?? 'visit'}-${day}${nudge ? '-nudge' : ''}`;

// When `time` falls on habit day `day`, on this Mac's clock. A time before the
// habit's day start belongs to the calendar day after: 01:00 on the 13th is the 12th's.
function moment(day, time, dayStart) {
  const [y, m, d] = (time < dayStart ? addDays(day, 1) : day).split('-').map(Number);
  return new Date(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5))).getTime();
}

// The reminders that are due at `now` and whose keys are not in `shown`:
// [{ key, habit, slot, title, body }]. A reminder is due from its time until its
// slot's window closes (or for two hours, where there is no window), and never
// past the end of the habit's day; only for something still to do.
export function dueReminders(habits, now = Date.now(), shown = []) {
  const seen = new Set(shown);
  const due = [];
  for (const habit of habits) {
    if (habit.paused || habit.archived) continue;
    const { day } = habit.today;
    const dayEnd = moment(addDays(day, 1), habit.dayStart, habit.dayStart);
    const title = [habit.icon, habit.name].filter(Boolean).join(' ');
    const streak = habit.streak.current;
    const add = (slot, time, until, nudge, body) => {
      const from = moment(day, time, habit.dayStart);
      const to = Math.min(until ?? from + GRACE_MS, dayEnd);
      const key = reminderKey(habit.id, slot, day, nudge);
      if (now >= from && now < to && !seen.has(key)) due.push({ key, habit: habit.id, slot, title, body });
    };

    if (habit.schedule.kind === 'weekly') {
      const { remind } = habit.schedule;
      if (!remind || !remind.days.includes(weekday(day)) || habit.week.state !== 'open' || habit.today.done) continue;
      const progress = `${habit.week.count} of ${habit.week.target} this week`;
      add(null, remind.time, null, false, streak > 0 ? `${progress} · ${length(streak, 'weeks')} so far` : progress);
      continue;
    }

    if (habit.today.state !== 'open') continue;
    for (const slot of habit.schedule.slots) {
      if (habit.today.slots.find((s) => s.id === slot.id)?.done !== false) continue; // done, or not one of today's
      const until = slot.until ? moment(day, slot.until, habit.dayStart) : null;
      if (slot.remind) {
        const keeps = streak > 0 ? `Keeps your ${streak}-day streak going.` : null;
        add(slot.id, slot.remind, until, false, [slot.name, keeps].filter(Boolean).join(' · ') || 'Time to check in.');
      }
      if (slot.nudge) {
        const open = slot.name ? `${slot.name} is still open` : 'Still open today';
        add(slot.id, slot.nudge, until, true, streak > 0 ? `${open}, and so is your ${streak}-day streak.` : `${open}.`);
      }
    }
  }
  return due;
}
