// How habits read in words on the Mac: the order of today's list, and the lines
// for progress, schedules and streaks. The dashboard, the menu bar, the morning
// summary and the MCP tools all take their wording from here, and it says what
// the iPhone app says (ios/TodosKit/Sources/TodosKit/HabitText.swift).
//
// Everything here takes a habit as listHabits() gives it, and works nothing out
// about streaks itself: that is streaks.js, on the server only.

import { weekday } from './streaks.js';

const DAY_MS = 864e5;
const isWeekly = (habit) => habit.schedule.kind === 'weekly';
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
// Minutes from `start` to `time`, going forward round the clock.
const minutesAfter = (time, start) => (minutes(time) - minutes(start) + 24 * 60) % (24 * 60);
const listed = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const slotOf = (habit, id) => habit.schedule.slots?.find((s) => s.id === id);
// What a slot is called. One with no name goes by its id.
export const slotName = (habit, id) => slotOf(habit, id)?.name || capital(id);
// The slots of a day still to do. A habit counted in weeks has none.
export const remaining = (day) => (day.slots || []).filter((s) => !s.done);

// "7:30 AM", or "07:30" where that is how times are written.
export function clock(time, locale) {
  const text = new Date(2001, 0, 1, Number(time.slice(0, 2)), Number(time.slice(3, 5))).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return text.replace(/ /g, ' '); // the narrow space some systems put before AM and PM
}

// ---------- today ----------

// True when something is still to do today: an open day, or for a habit counted
// in weeks, a week not yet met on a day without a check-in.
export function isDueToday(habit) {
  if (habit.paused || habit.archived) return false;
  if (isWeekly(habit)) return !habit.today.done && habit.week.state === 'open';
  return habit.today.state === 'open';
}

// True when today asks nothing more: done, or for a habit counted in weeks,
// checked in today or the week already met.
export function isDoneToday(habit) {
  if (habit.paused || habit.archived) return false;
  if (isWeekly(habit)) return habit.today.done || habit.week.state === 'met';
  return habit.today.state === 'done';
}

// When the next thing still to do today is due, in minutes after the habit's day
// start: the next open slot's reminder time, else the start of its window. Null
// when nothing has a time, or nothing is left.
export function nextDue(habit) {
  if (isWeekly(habit)) {
    const { remind } = habit.schedule;
    return remind && remind.days.includes(weekday(habit.today.day)) ? minutesAfter(remind.time, habit.dayStart) : null;
  }
  const times = remaining(habit.today).map((open) => slotOf(habit, open.id)).map((slot) => slot?.remind ?? slot?.from).filter(Boolean);
  return times.length ? Math.min(...times.map((time) => minutesAfter(time, habit.dayStart))) : null;
}

const inWindow = (time, from, until) => (from <= until ? time >= from && time < until : time >= from || time < until);

// The slot a check-in made at `time` ("21:40") would be for, by the server's own
// rule: of those still to do, the one whose window this is, else the earliest.
// Undefined when nothing is left, or the habit is counted in weeks.
export function nextSlot(habit, time) {
  const open = remaining(habit.today).map((s) => s.id);
  if (open.length < 2) return open[0];
  return open.find((id) => {
    const slot = slotOf(habit, id);
    return slot?.from && inWindow(time, slot.from, slot.until);
  }) ?? open[0];
}

// Today's list: what is still to do, soonest first (anything without a time
// last); then what is done; then what expects nothing today.
export function forToday(habits) {
  const shown = habits.filter((h) => !h.archived);
  const when = (h) => nextDue(h) ?? Infinity;
  const due = shown.filter(isDueToday).sort((a, b) => when(a) - when(b) || a.id - b.id);
  return { due, done: shown.filter((h) => !isDueToday(h) && isDoneToday(h)), off: shown.filter((h) => !isDueToday(h) && !isDoneToday(h)) };
}

// Slots (or, in weeks, visits) still to do today, across every habit.
export const leftToday = (habits) => habits.filter(isDueToday).reduce((n, h) => n + (isWeekly(h) ? 1 : remaining(h.today).length), 0);

// Habits whose streak hangs on finishing yesterday, which can be logged until today ends.
export const atRiskHabits = (habits) => habits.filter((h) => !h.archived && !h.paused && h.streak.atRisk && h.streak.current > 0);

// ---------- words ----------

// "12 days", "1 week".
export const length = (count, unit) => `${count} ${unit === 'days' ? 'day' : 'week'}${count === 1 ? '' : 's'}`;
// "12-day", "3-week": for "your 12-day streak".
const lengthAdjective = (count, unit) => `${count}-${unit === 'days' ? 'day' : 'week'}`;

// The line under a habit's name: how today stands.
export function progress(habit, locale) {
  if (habit.paused) return 'Paused';
  if (isWeekly(habit)) {
    const { state, count, target } = habit.week;
    if (state === 'met') return `${count} of ${target} this week · done`;
    if (state === 'skipped') return 'Rest week';
    if (state === 'off') return `${count} this week`;
    return `${count} of ${target} this week`;
  }
  const { state, done, total } = habit.today;
  if (state === 'off') return 'Not today';
  if (state === 'skipped') return 'Rest day';
  if (state === 'done') return total > 1 ? `${total} of ${total} · done` : 'Done today';
  // What is next: the first slot still to do, and when it is due.
  const next = slotOf(habit, remaining(habit.today)[0]?.id);
  const when = next ? [next.name, next.remind && clock(next.remind, locale)].filter(Boolean).join(' ') : '';
  return [total > 1 ? `${done} of ${total}` : '', when].filter(Boolean).join(' · ') || 'To do today';
}

// When a habit is done, in a line: "Every day · Morning 7:30 AM, Evening 9:30 PM".
export function schedule(rule, locale) {
  const times = (slots) => slots.map((s) => [s.name, s.remind && clock(s.remind, locale)].filter(Boolean).join(' ')).filter(Boolean).join(', ');
  const days = (list) => list.map(capital).join(', ');
  if (rule.kind === 'weekly') {
    const often = rule.target === 7 ? 'Every day of the week' : `${rule.target} day${rule.target === 1 ? '' : 's'} a week`;
    return [often, rule.remind && `reminders ${days(rule.remind.days)} at ${clock(rule.remind.time, locale)}`].filter(Boolean).join(' · ');
  }
  return [rule.kind === 'days' ? days(rule.days) : 'Every day', times(rule.slots)].filter(Boolean).join(' · ');
}

// Yesterday is unfinished and a streak hangs on it: what to do about it. Null otherwise.
export function atRisk(habit) {
  const risk = habit.streak.atRisk;
  if (!risk || !habit.streak.current) return null;
  const streak = `your ${lengthAdjective(habit.streak.current, habit.streak.unit)} streak`;
  if (isWeekly(habit)) return `Log yesterday’s visit by the end of today to keep ${streak}.`;
  const slots = risk.missing.map((id) => slotName(habit, id).toLowerCase());
  const what = habit.yesterday.total > 1 && slots.length ? `yesterday’s ${listed(slots)}` : 'yesterday';
  return `Log ${what} by the end of today to keep ${streak}.`;
}

// A streak has ended: said kindly, with the best and a new start. Null unless
// nothing is running now and there is something worth mentioning behind it.
export function ended(habit, locale) {
  const { current, best, unit, previous } = habit.streak;
  if (current !== 0 || !previous || previous.length <= 1) return null;
  let first = `Your ${lengthAdjective(previous.length, unit)} streak ended`;
  if (unit === 'days' && previous.lastDay && (Date.parse(habit.today.day) - Date.parse(previous.lastDay)) / DAY_MS <= 7) {
    first += ` after ${new Date(`${previous.lastDay}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' })}`;
  }
  const most = previous.length >= best ? 'That is your best so far.' : `Your best is ${length(best, unit)}.`;
  return `${first}. ${most} ${unit === 'days' ? 'Today' : 'This week'} starts a new one.`;
}

// "93%", or a dash when nothing was expected.
export const rate = (value) => (value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`);

// ---------- the morning summary ----------

// What the daily summary says about habits: { title, body }, or null when no
// habit asks anything today and no streak is at risk.
export function dailyHabitSummary(habits) {
  const { due } = forToday(habits);
  const risky = atRiskHabits(habits);
  if (!due.length && !risky.length) return null;
  const names = (list) => list.slice(0, 4).map((h) => h.name).join(', ') + (list.length > 4 ? `, and ${list.length - 4} more` : '');
  const lines = [];
  if (due.length) lines.push(`Habits: ${names(due)}`);
  if (risky.length) lines.push(`Still time for yesterday: ${risky.slice(0, 3).map((h) => `${h.name} (${lengthAdjective(h.streak.current, h.streak.unit)} streak)`).join(', ')}`);
  const title = [due.length && `${due.length} habit${due.length === 1 ? '' : 's'} today`, risky.length && `${risky.length} streak${risky.length === 1 ? '' : 's'} at risk`].filter(Boolean).join(' · ');
  return { title, body: lines.join('\n') };
}

// ---------- for Claude ----------

// One habit in a line, for the MCP tools:
// "#1 Brush teeth — today 1 of 2 (evening still to do) · streak 12 days (best 30)".
export function line(habit) {
  const { current, best, unit } = habit.streak;
  let today;
  if (habit.paused) today = 'paused';
  else if (isWeekly(habit)) {
    const { state, count, target } = habit.week;
    today = `${count} of ${target} this week${state === 'met' ? ' (done)' : state === 'skipped' ? ' (rest week)' : ''}${habit.today.done ? ', checked in today' : ''}`;
  } else {
    const { state, done, total } = habit.today;
    const open = remaining(habit.today).map((s) => slotName(habit, s.id).toLowerCase());
    if (state === 'off') today = 'nothing expected today';
    else if (state === 'skipped') today = 'rest day';
    else if (state === 'done') today = `today done (${done} of ${total})`;
    else today = `today ${done} of ${total}${total > 1 && open.length ? ` (${listed(open)} still to do)` : ''}`;
  }
  const parts = [
    today,
    current || best ? `streak ${length(current, unit)}${best > current ? ` (best ${best})` : ''}` : 'no streak yet',
    habit.archived ? 'archived' : null,
  ];
  return `#${habit.id} ${habit.name} — ${parts.filter(Boolean).join(' · ')}`;
}

// A habit in full, for the MCP tools: its line, its schedule, and anything about its streak worth saying.
export function detail(habit, locale) {
  return [line(habit), `  ${schedule(habit.schedule, locale)}`, ...[atRisk(habit), ended(habit, locale)].filter(Boolean).map((text) => `  ${text}`)].join('\n');
}
