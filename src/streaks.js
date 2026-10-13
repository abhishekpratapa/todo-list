// Streaks for habits, worked out from check-in events.
//
// Everything here is a pure function of a habit, its events and which day is
// "today", so every client that asks gets the same numbers and a test can pick
// any day it likes. Nothing here reads the clock or a file.
//
// Words used throughout:
//   - A habit day runs from the habit's day start (03:00 unless changed) to the
//     next one, and is named by the calendar date it starts on. Brushing at 00:30
//     counts for the evening before.
//   - A day is "open" while it can still change: today, and yesterday, whose
//     slots can be logged late until today ends. Only a day that is no longer
//     open can break a streak. A habit counted in weeks has open weeks for the
//     same reason: the current one, and last week until Monday ends.
//   - Days a habit isn't scheduled, is paused or was skipped are passed over.
//     They neither break a streak nor add to it.
//
// A habit as this file reads it (see habits.js for the rest):
//   { dayStart, schedule: { kind }, history, pauses, archivedDay }
// `history` says what counted from which day on, oldest first, so changing a
// schedule never rewrites the days before the change:
//   { from, days: null or ['mon', ...], slots: ['morning', ...] }   kinds "daily" and "days"
//   { from, target }                                                kind "weekly"

const DAY_MS = 864e5;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Rest days can't be used to keep a streak alive forever: at most this many
// skipped days in any stretch of that many days. Longer breaks are a pause.
export const SKIP_LIMITS = [{ days: 7, max: 2 }, { days: 30, max: 6 }];
// And for a habit counted in weeks: one skipped week in any four.
export const SKIP_WEEKS = { weeks: 4, max: 1 };

// ---------- dates ----------

const utc = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export const addDays = (day, n) => new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
export const weekday = (day) => WEEKDAYS[new Date(utc(day)).getUTCDay()];
// The Monday of the week a day is in.
export const weekStart = (day) => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));

const formats = new Map();

export function isZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// What a clock on the wall says at an instant in a time zone: { date: 'YYYY-MM-DD', time: 'HH:MM' }.
export function localParts(ms, zone) {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formats.set(zone, format);
  }
  const part = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${part.year}-${part.month}-${part.day}`, time: `${part.hour}:${part.minute}` };
}

// The habit day an instant belongs to.
export function habitDay(ms, zone, dayStart) {
  const { date, time } = localParts(ms, zone);
  return time < dayStart ? addDays(date, -1) : date;
}

// The instant a wall-clock time on a calendar date happens in a zone. Where the
// clocks skip that time (a spring change), the answer is the instant they skip at.
export function zonedInstant(date, time, zone) {
  const wanted = utc(date) + minutes(time) * 60_000; // that wall-clock reading, as if it were UTC
  let at = wanted;
  for (let i = 0; i < 3; i++) {
    const shown = localParts(at, zone);
    const reading = utc(shown.date) + minutes(shown.time) * 60_000;
    if (reading === wanted) break;
    at += wanted - reading;
  }
  return at;
}

// When a habit day ends: its day start on the next calendar date.
export const dayEnd = (day, zone, dayStart) => zonedInstant(addDays(day, 1), dayStart, zone);

// ---------- events ----------

// The check-ins and skips that still stand (an undo names the ones it removes), by day.
export function indexEvents(events) {
  const undone = new Set(events.flatMap((e) => (e.kind === 'undo' ? e.targets : [])));
  const done = new Map(); // day -> Map(slot, or '' when the habit has none -> [check-ins, oldest first])
  const skips = new Map(); // day, or the Monday of a skipped week -> the skip
  for (const e of events) {
    if (undone.has(e.id)) continue;
    if (e.kind === 'done') {
      if (!done.has(e.day)) done.set(e.day, new Map());
      const slots = done.get(e.day);
      const slot = e.slot ?? '';
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(e);
    } else if (e.kind === 'skip' && !skips.has(e.day)) {
      skips.set(e.day, e);
    }
  }
  return { done, skips };
}

const ruleOn = (habit, day) => habit.history.findLast((rule) => rule.from <= day) ?? null;
const pausedOn = (habit, day) =>
  (habit.archivedDay != null && day >= habit.archivedDay) || habit.pauses.some((p) => p.from <= day && (p.to == null || day < p.to));

// ---------- habits with slots ----------

// One day: { state, done, total, missing, slots }, where `slots` pairs each slot
// that counted that day with the check-ins it has.
//   off      not scheduled, paused, or before the habit began
//   done     every slot has a check-in
//   skipped  a rest day, and not done anyway
//   open     not done, and still loggable (today or yesterday)
//   partial  some slots, and too late for the rest
//   missed   none
export function dayState(habit, index, day, today) {
  const rule = ruleOn(habit, day);
  if (!rule || pausedOn(habit, day) || (rule.days && !rule.days.includes(weekday(day)))) return { state: 'off', done: 0, total: 0, missing: [], slots: [] };
  const checked = index.done.get(day);
  const slots = rule.slots.map((id) => ({ id, checkins: checked?.get(id) ?? [] }));
  const missing = slots.filter((s) => !s.checkins.length).map((s) => s.id);
  const total = slots.length;
  const done = total - missing.length;
  let state;
  if (!missing.length) state = 'done';
  else if (index.skips.has(day)) state = 'skipped';
  else if (day >= addDays(today, -1)) state = 'open';
  else state = done ? 'partial' : 'missed';
  return { state, done, total, missing, slots };
}

// Counts runs over days or weeks, oldest first. `watch` is a key to report the
// run as it stood just before: what is at stake while that day is still open.
function countRuns(items, counts, breaks, watch) {
  let run = 0;
  let best = 0;
  let last = null;
  let previous = null;
  let atWatch = 0;
  for (const { key, state } of items) {
    if (key === watch) atWatch = run;
    if (counts.includes(state)) {
      run += 1;
      last = key;
      best = Math.max(best, run);
    } else if (breaks.includes(state) && run) {
      previous = { length: run, last };
      run = 0;
    }
  }
  return { current: run, best, previous, atWatch };
}

const ratio = (num, den) => (den ? Math.round((num / den) * 1e4) / 1e4 : null);
const WINDOWS = { d7: 7, d30: 30, d365: 365 };

function daySummary(habit, index, today, zone) {
  const items = [];
  for (let day = habit.history[0].from; day <= today; day = addDays(day, 1)) items.push({ key: day, ...dayState(habit, index, day, today) });
  const yesterday = addDays(today, -1);
  const on = (day) => ({ day, ...dayState(habit, index, day, today) });
  const runs = countRuns(items, ['done'], ['missed', 'partial'], yesterday);
  const y = on(yesterday);

  const rates = {};
  for (const [name, days] of Object.entries(WINDOWS)) {
    const since = addDays(today, -(days - 1));
    let num = 0;
    let den = 0;
    for (const item of items) {
      if (item.key < since || item.state === 'off' || item.state === 'skipped') continue;
      num += item.done;
      den += item.state === 'open' ? item.done : item.total; // an open day can't count against you yet
    }
    rates[name] = ratio(num, den);
  }

  return {
    today: on(today),
    yesterday: y,
    streak: {
      current: runs.current,
      best: runs.best,
      unit: 'days',
      // Yesterday is unfinished and there is a streak behind it: it survives if yesterday is completed before today ends.
      atRisk: y.state === 'open' && runs.atWatch > 0 ? { day: yesterday, missing: y.missing, until: new Date(dayEnd(today, zone, habit.dayStart)).toISOString() } : null,
      previous: runs.previous && { length: runs.previous.length, lastDay: runs.previous.last },
    },
    rates,
    skipsLeft: skipsLeft(habit, index, today, items[items.length - 1]?.state),
  };
}

// ---------- habits counted in weeks ----------

// One week, named by its Monday: { state, count, target, days }, where `days`
// are the days with a check-in. More than one check-in on a day counts once.
//   met      enough days
//   skipped  a rest week, and not met anyway
//   open     not met, and still loggable (this week, or last week until Monday ends)
//   missed   not met
//   off      before the habit began or paused throughout; also a week it began or
//            was paused partway through and didn't meet, which is held against no one
export function weekState(habit, index, week, today) {
  const rule = ruleOn(habit, addDays(week, 6));
  const days = [];
  let active = 0;
  for (let i = 0; i < 7; i++) {
    const day = addDays(week, i);
    if (day >= habit.history[0].from && !pausedOn(habit, day)) active += 1;
    if (index.done.get(day)?.size) days.push(day);
  }
  const count = days.length;
  const target = rule?.target ?? 0;
  let state;
  if (!rule || !active) state = 'off';
  else if (count >= target) state = 'met';
  else if (index.skips.has(week)) state = 'skipped';
  else if (today <= addDays(week, 7)) state = 'open';
  else state = active === 7 ? 'missed' : 'off';
  return { state, count, target, days };
}

function weekSummary(habit, index, today, zone) {
  const items = [];
  const thisWeek = weekStart(today);
  for (let week = weekStart(habit.history[0].from); week <= thisWeek; week = addDays(week, 7)) items.push({ key: week, ...weekState(habit, index, week, today) });
  const lastWeek = addDays(thisWeek, -7);
  const runs = countRuns(items, ['met'], ['missed'], lastWeek);
  const last = items.find((i) => i.key === lastWeek);
  const sunday = addDays(lastWeek, 6);
  // Last week is one day short and yesterday (its Sunday) has no check-in yet: logging it today saves the streak.
  const savable = last && last.state === 'open' && runs.atWatch > 0 && last.count === last.target - 1 && !last.days.includes(sunday);

  const rates = {};
  for (const [name, days] of Object.entries(WINDOWS)) {
    const since = addDays(today, -(days - 1));
    let num = 0;
    let den = 0;
    for (const item of items) {
      if (addDays(item.key, 6) < since || item.state === 'off' || item.state === 'skipped') continue;
      const counted = Math.min(item.count, item.target);
      num += counted;
      den += item.state === 'open' ? counted : item.target;
    }
    rates[name] = ratio(num, den);
  }

  const day = (d) => ({ day: d, done: !!index.done.get(d)?.size, checkins: [...(index.done.get(d)?.values() ?? [])].flat() });
  const week = (item) => ({ start: item.key, state: item.state, count: item.count, target: item.target, days: item.days });
  const current = items[items.length - 1];
  return {
    today: day(today),
    yesterday: day(addDays(today, -1)),
    week: week(current),
    lastWeek: last ? week(last) : null, // still open until Monday ends
    streak: {
      current: runs.current,
      best: runs.best,
      unit: 'weeks',
      atRisk: savable ? { day: sunday, week: lastWeek, missing: [], until: new Date(dayEnd(today, zone, habit.dayStart)).toISOString() } : null,
      previous: runs.previous && { length: runs.previous.length, lastWeek: runs.previous.last },
    },
    rates,
    skipsLeft: skipsLeft(habit, index, today, current.state),
  };
}

// ---------- what clients are shown ----------

export const isWeekly = (habit) => habit.schedule.kind === 'weekly';

// Today, yesterday, the streak, completion rates and how many skips are left.
export function summarize(habit, events, today, zone) {
  const index = indexEvents(events);
  return isWeekly(habit) ? weekSummary(habit, index, today, zone) : daySummary(habit, index, today, zone);
}

// How many rest days (or weeks) could be taken at `day`, leaving aside whether
// it is one already: the least room any limit leaves. Only skips that are doing
// something count: a skipped day that was done anyway used nothing up.
export function skipRoom(habit, index, day, today) {
  if (isWeekly(habit)) {
    const week = weekStart(day);
    const skipped = [...index.skips.keys()].filter((w) => w !== week && weekState(habit, index, w, today).state === 'skipped');
    let worst = 0;
    for (let i = 0; i < SKIP_WEEKS.weeks; i++) {
      const from = addDays(week, -7 * i);
      const to = addDays(from, 7 * (SKIP_WEEKS.weeks - 1));
      worst = Math.max(worst, skipped.filter((w) => w >= from && w <= to).length);
    }
    return Math.max(0, SKIP_WEEKS.max - worst);
  }
  const skipped = [...index.skips.keys()].filter((d) => d !== day && dayState(habit, index, d, today).state === 'skipped');
  let room = Infinity;
  for (const { days, max } of SKIP_LIMITS) {
    let worst = 0;
    for (let i = 0; i < days; i++) {
      const from = addDays(day, -i);
      const to = addDays(from, days - 1);
      worst = Math.max(worst, skipped.filter((d) => d >= from && d <= to).length);
    }
    room = Math.min(room, max - worst);
  }
  return Math.max(0, room);
}

// How many more could be skipped as of today: one fewer if today is a rest day already.
const skipsLeft = (habit, index, today, state) => Math.max(0, skipRoom(habit, index, today, today) - (state === 'skipped' ? 1 : 0));

// One character per day from `from` to `to`, for drawing a calendar:
//   d done   p partial   x missed   s skipped   o open   . nothing expected   _ still to come
// For a habit counted in weeks, d marks a day with a check-in and s the other
// days of a skipped week; `weeks` then says how each week in the range went.
export function calendar(habit, events, from, to, today) {
  const index = indexEvents(events);
  const codes = { done: 'd', partial: 'p', missed: 'x', skipped: 's', open: 'o', off: '.' };
  let days = '';
  if (!isWeekly(habit)) {
    for (let day = from; day <= to; day = addDays(day, 1)) days += day > today ? '_' : codes[dayState(habit, index, day, today).state];
    return { days };
  }
  const weeks = [];
  for (let week = weekStart(from); week <= to; week = addDays(week, 7)) {
    if (week > today) break;
    const { state, count, target } = weekState(habit, index, week, today);
    weeks.push({ start: week, state, count, target });
  }
  const stateOf = new Map(weeks.map((w) => [w.start, w.state]));
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (day > today) days += '_';
    else if (index.done.get(day)?.size) days += 'd';
    else days += stateOf.get(weekStart(day)) === 'skipped' ? 's' : '.';
  }
  return { days, weeks };
}
