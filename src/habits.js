// Habits: routines to check in on (brush teeth morning and evening, the gym
// three times a week) and the check-ins themselves.
//
// They live in their own file beside the todo list, `habits.json`, written under
// its own lock the same way. The todo file is never written from here, so nothing
// that reads or writes todos, including a Claude session still running an older
// copy of the MCP server, can see, lose or damage a habit.
//
// The file holds each habit and one append-only list of events. A check-in is an
// event; so is a skipped day; undoing either is a third event naming what it
// removes. Nothing is edited in place, which is what lets a phone that was
// offline send its events late, in any order relative to other devices, and
// arrive at the same answer. Streaks are never stored: streaks.js works them out
// from the events each time someone asks.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_FILE, ConflictError, NotFoundError, TodoError, nowMs, withLock } from './store.js';
import {
  SKIP_LIMITS, SKIP_WEEKS,
  addDays, calendar, dayState, habitDay, indexEvents, isWeekly, isZone, localParts, skipRoom, summarize, weekStart, weekState,
} from './streaks.js';

export const HABITS_FILE = path.join(path.dirname(DATA_FILE), 'habits.json');
const LOCK_DIR = `${HABITS_FILE}.lock`;
// The todo file as it was before this copy of the app first wrote a habit. Habits
// never touch that file, so this is belt and braces.
const BACKUP_FILE = `${DATA_FILE}.before-habits`;
const SCHEMA = 1;

export const HABIT_KINDS = ['daily', 'days', 'weekly'];
export const HABIT_COLORS = ['red', 'orange', 'yellow', 'green', 'mint', 'teal', 'blue', 'indigo', 'purple', 'pink', 'gray'];
// How a check-in was made. Which device made it is recorded separately, as for tasks.
export const SOURCES = ['manual', 'notification', 'widget', 'shortcut', 'claude', 'health'];
const MAX_SLOTS = 6;
const DAY_START = '03:00';
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEK_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// Where this Mac is. Used until a device says where the user is (see moment()).
const SERVER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// A refusal with a code a client can act on: "too_late", "skip_limit", "archived", ...
export class HabitError extends TodoError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// An edit named the revision it was based on, and the habit has changed since.
export class HabitConflictError extends ConflictError {
  constructor(habit) {
    super(habit);
    this.message = `"${habit.name}" has changed since you loaded it (it is now at revision ${habit.rev})`;
  }
}

// ---------- the file ----------

const emptyDb = () => ({ schema: SCHEMA, version: 0, nextId: 1, nextEventId: 1, updatedAt: null, zone: null, habits: [], events: [] });
const iso = (ms) => new Date(ms).toISOString();

export function loadHabits() {
  let raw;
  try {
    raw = fs.readFileSync(HABITS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyDb();
    throw e;
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    throw new TodoError(`Habit data file is not valid JSON: ${HABITS_FILE}`);
  }
  if (db.schema > SCHEMA) throw new TodoError(`The habit data file was written by a newer version of Todos: ${HABITS_FILE}`);
  return db;
}

// One event per line: a long history stays readable, and the file stays small.
function serialize({ events, ...rest }) {
  const lines = events.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return JSON.stringify({ ...rest, events: [] }, null, 2).replace(/"events": \[\]\n\}$/, () => `"events": [${lines ? `\n${lines}\n  ` : ''}]\n}`) + '\n';
}

function backUpTodosOnce() {
  if (fs.existsSync(HABITS_FILE) || fs.existsSync(BACKUP_FILE) || !fs.existsSync(DATA_FILE)) return;
  fs.copyFileSync(DATA_FILE, BACKUP_FILE);
}

// What a change returns when there turned out to be nothing to do: the value is
// handed back and the file is left alone, so no change is announced.
class Unchanged {
  constructor(value) {
    this.value = value;
  }
}

// Run fn(db) under the lock and persist the result. If fn throws, nothing is written.
function mutate(fn) {
  fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true });
  return withLock(LOCK_DIR, () => {
    const db = loadHabits();
    const result = fn(db);
    if (result instanceof Unchanged) return result.value;
    backUpTodosOnce();
    db.version += 1;
    db.updatedAt = iso(Date.now());
    const tmp = `${HABITS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serialize(db));
    fs.renameSync(tmp, HABITS_FILE);
    return result;
  });
}

// The file's version, or null when it can't be read right now.
export function habitsVersion() {
  return habitsState()?.version ?? null;
}

// The file's version and when it was last written, or null when it can't be read
// right now. The two together say whether it has changed: a file put back from a
// copy can carry a version number seen before.
export function habitsState() {
  try {
    const { version, updatedAt } = loadHabits();
    return { version, updatedAt };
  } catch {
    return null;
  }
}

// Calls onChange() (debounced) whenever the habit file is replaced. Returns an unsubscribe function.
export function watchHabits(onChange) {
  const dir = path.dirname(HABITS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let timer;
  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename && filename !== path.basename(HABITS_FILE)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 40);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

// ---------- validation ----------

const cleanText = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function oneOf(field, value, allowed) {
  const v = cleanText(value).toLowerCase();
  if (!allowed.includes(v)) throw new TodoError(`Invalid ${field} "${value}". Expected one of: ${allowed.join(', ')}`);
  return v;
}

function onlyKeys(what, object, allowed) {
  const unknown = Object.keys(object).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new TodoError(`Unknown ${what} field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

// A time of day, "07:30". Times are floating: 07:30 wherever the user is.
function cleanTime(field, value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new TodoError(`A ${field} is needed, for example 07:30.`);
    return null;
  }
  const m = cleanText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new TodoError(`Invalid ${field} "${value}". Use a time like 07:30 or 21:00.`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function cleanDays(value) {
  const list = Array.isArray(value) ? value : [];
  const days = new Set(list.map((d) => {
    const name = cleanText(d).toLowerCase();
    const i = WEEK_NAMES.findIndex((full) => name.length >= 3 && full.startsWith(name)); // "mon", "monday"
    if (i < 0) throw new TodoError(`Invalid day "${d}". Use mon, tue, wed, thu, fri, sat or sun.`);
    return WEEK[i];
  }));
  if (!days.size) throw new TodoError('Say which days, for example ["mon", "wed", "fri"].');
  return WEEK.filter((d) => days.has(d));
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const SLOT_FIELDS = ['id', 'name', 'remind', 'from', 'until', 'nudge'];

// The times of day a habit is done at. `remind` is when to be reminded, `from`
// and `until` the window it belongs in (it may run past midnight), and `nudge`
// when to be reminded again if it still isn't done.
function cleanSlots(value) {
  if (!Array.isArray(value) || !value.length) throw new TodoError('A habit needs at least one slot, for example [{ "name": "Morning", "remind": "07:30" }].');
  if (value.length > MAX_SLOTS) throw new TodoError(`A habit can have at most ${MAX_SLOTS} slots.`);
  const seen = new Set();
  return value.map((raw, i) => {
    if (!isObject(raw)) throw new TodoError('Each slot must be an object, for example { "name": "Morning", "remind": "07:30" }.');
    onlyKeys('slot', raw, SLOT_FIELDS);
    const name = cleanText(raw.name).slice(0, 40);
    const id = cleanText(raw.id).toLowerCase() || slug(name) || (value.length === 1 ? 'once' : `slot-${i + 1}`);
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) throw new TodoError(`Invalid slot id "${raw.id}". Use lower-case letters, digits and hyphens.`);
    if (seen.has(id)) throw new TodoError(`Two slots are called "${id}".`);
    seen.add(id);
    const slot = { id, name, remind: cleanTime('reminder time', raw.remind), from: cleanTime('window start', raw.from), until: cleanTime('window end', raw.until), nudge: cleanTime('nudge time', raw.nudge) };
    if ((slot.from === null) !== (slot.until === null)) throw new TodoError('A window needs both "from" and "until".');
    return slot;
  });
}

// One of:
//   { kind: "daily", slots }                 every day
//   { kind: "days", days, slots }            on those days of the week
//   { kind: "weekly", target, remind }       `target` days a week, whichever they are;
//                                            `remind` is { days, time } or null
function cleanSchedule(input) {
  if (!isObject(input)) throw new TodoError('A habit needs a schedule, for example { "kind": "daily", "slots": [{ "name": "Morning", "remind": "07:30" }] }.');
  const kind = oneOf('schedule kind', input.kind, HABIT_KINDS);
  if (kind === 'weekly') {
    onlyKeys('schedule', input, ['kind', 'target', 'remind']);
    if (!Number.isInteger(input.target) || input.target < 1 || input.target > 7) throw new TodoError('"target" is how many days a week, a whole number from 1 to 7.');
    let remind = null;
    if (input.remind !== undefined && input.remind !== null) {
      if (!isObject(input.remind)) throw new TodoError('"remind" must be { "days": [...], "time": "17:30" } or null.');
      onlyKeys('reminder', input.remind, ['days', 'time']);
      remind = { days: cleanDays(input.remind.days), time: cleanTime('reminder time', input.remind.time, true) };
    }
    return { kind, target: input.target, remind };
  }
  onlyKeys('schedule', input, kind === 'days' ? ['kind', 'days', 'slots'] : ['kind', 'slots']);
  const slots = cleanSlots(input.slots ?? [{}]);
  return kind === 'days' ? { kind, days: cleanDays(input.days), slots } : { kind, slots };
}

// The part of a schedule that decides whether a day (or week) counts.
const counted = (s) => (s.kind === 'weekly' ? { target: s.target } : { days: s.kind === 'days' ? s.days : null, slots: s.slots.map((slot) => slot.id) });

function cleanFlag(field, value) {
  if (typeof value !== 'boolean') throw new TodoError(`"${field}" must be true or false.`);
  return value;
}

// Normalizes the user-editable fields of a habit. Unknown keys are ignored.
function cleanFields(input) {
  const out = {};
  if ('name' in input) {
    const name = cleanText(input.name);
    if (!name) throw new TodoError('A habit needs a name');
    out.name = name.slice(0, 80);
  }
  if ('icon' in input) out.icon = [...cleanText(input.icon)].slice(0, 8).join('') || null; // an emoji can be several characters
  if ('color' in input) out.color = oneOf('color', input.color, HABIT_COLORS);
  if ('dayStart' in input) out.dayStart = cleanTime('day start', input.dayStart, true);
  if ('schedule' in input) out.schedule = cleanSchedule(input.schedule);
  if ('paused' in input) out.paused = cleanFlag('paused', input.paused);
  if ('archived' in input) out.archived = cleanFlag('archived', input.archived);
  return out;
}

function findIn(db, id) {
  const n = Number(String(id).replace(/^#/, ''));
  const habit = db.habits.find((h) => h.id === n);
  if (!habit) throw new NotFoundError(`No habit with id #${id}`);
  return habit;
}

const eventsOf = (db, habit) => db.events.filter((e) => e.habit === habit.id);

// ---------- where and when ----------

// The time zone the user is in, as far as anyone has said: the one named by the
// most recent check-in or zone report, else this Mac's. Every client is shown
// "today" by this one zone, so they all show the same day and the same numbers.
const currentZone = (db) => db.zone?.name ?? SERVER_ZONE;

// When and where something happened: what the client says, or here and now. A
// phone that was offline sends when its user actually tapped, and the change is
// judged as of then, so a check-in made on Monday and delivered on Thursday is
// Monday's.
function moment(db, { at, zone }) {
  const now = nowMs();
  let when = now;
  if (at !== undefined && at !== null) {
    when = typeof at === 'string' ? Date.parse(at) : NaN;
    if (Number.isNaN(when)) throw new TodoError('"at" must be a timestamp, for example 2026-10-12T18:30:00Z.');
    if (when > now + 5 * 60_000) throw new TodoError('"at" is when it happened, so it cannot be in the future.');
  }
  const named = zone !== undefined && zone !== null;
  if (named && !isZone(zone)) throw new TodoError(`Unknown time zone "${zone}". Use a name like America/Chicago.`);
  return { when, zone: named ? zone : currentZone(db), named };
}

// A device said where it is. Later news wins; something delivered late doesn't
// move the user back to where they were.
function noteZone(db, zone, when) {
  if (db.zone && Date.parse(db.zone.at) > when) return;
  db.zone = { name: zone, at: iso(when) };
}

// Which habit day a change is for. It is the day it happened unless `asked` says
// yesterday, which is allowed until today ends and no further back.
function countedDay(habit, when, zone, asked) {
  const day = habitDay(when, zone, habit.dayStart);
  if (asked === undefined || asked === null || asked === 'today' || asked === day) return { day, today: day, backfilled: false };
  const yesterday = addDays(day, -1);
  if (asked === 'yesterday' || asked === yesterday) return { day: yesterday, today: day, backfilled: true };
  if (typeof asked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asked)) throw new TodoError('"day" must be a date (YYYY-MM-DD), "today" or "yesterday".');
  if (asked > day) throw new HabitError('too_early', 'That day hasn’t come yet.');
  throw new HabitError('too_late', 'You can log yesterday until the end of today, but no further back.');
}

const inWindow = (time, from, until) => (from <= until ? time >= from && time < until : time >= from || time < until);

// The slot a check-in is for. Named, it is that one. Not named, it is the one
// still to do: if several are, the one whose window this is, else the earliest.
// Undefined when there is nothing left to check in.
function pickSlot(habit, index, day, asked, when, zone) {
  const known = [...habit.schedule.slots, ...habit.retired];
  const that = dayState(habit, index, day, day);
  const ids = that.slots.length ? that.slots.map((s) => s.id) : habit.schedule.slots.map((s) => s.id);
  if (asked !== undefined && asked !== null) {
    const wanted = cleanText(asked).toLowerCase();
    const id = ids.find((x) => x === wanted) ?? ids.find((x) => known.find((s) => s.id === x)?.name.toLowerCase() === wanted);
    if (!id) throw new HabitError('no_such_slot', `"${habit.name}" has no slot "${asked}". It has: ${ids.join(', ')}.`);
    return id;
  }
  const open = ids.filter((id) => !index.done.get(day)?.get(id)?.length);
  if (open.length < 2) return open[0];
  const { time } = localParts(when, zone);
  return open.find((id) => {
    const slot = known.find((s) => s.id === id);
    return slot?.from && inWindow(time, slot.from, slot.until);
  }) ?? open[0];
}

// ---------- what clients are shown ----------

const slotView = ({ id, checkins }) => {
  const [first] = checkins;
  if (!first) return { id, done: false };
  return { id, done: true, at: first.at, by: first.by, ...(first.via ? { via: first.via } : {}), source: first.source, checkins: checkins.map((e) => e.id) };
};
const dayView = (d) => ({ day: d.day, state: d.state, done: d.done, total: d.total, slots: d.slots.map(slotView) });
const sessionView = (d) => ({ day: d.day, done: d.done, checkins: d.checkins.map((e) => e.id) });

// A habit as the API and the MCP tools show it: what it is, how today stands,
// and its streak. `checkins` are the ids an undo would name.
function view(db, habit) {
  const zone = currentZone(db);
  const s = summarize(habit, eventsOf(db, habit), habitDay(nowMs(), zone, habit.dayStart), zone);
  const shown = {
    id: habit.id,
    name: habit.name,
    icon: habit.icon,
    color: habit.color,
    dayStart: habit.dayStart,
    schedule: habit.schedule,
    paused: habit.pauses.some((p) => p.to === null),
    archived: !!habit.archivedAt,
    rev: habit.rev,
    createdAt: habit.createdAt,
    updatedAt: habit.updatedAt,
  };
  const numbers = { streak: s.streak, rates: s.rates, skipsLeft: s.skipsLeft };
  if (isWeekly(habit)) return { ...shown, today: sessionView(s.today), yesterday: sessionView(s.yesterday), week: s.week, lastWeek: s.lastWeek, ...numbers };
  return { ...shown, today: dayView(s.today), yesterday: dayView(s.yesterday), ...numbers };
}

// ---------- reading ----------

// Options: `archived` includes habits that have been put away.
export function listHabits({ archived = false } = {}) {
  const db = loadHabits();
  return { habits: db.habits.filter((h) => archived || !h.archivedAt).map((h) => view(db, h)), zone: currentZone(db), version: db.version };
}

export function getHabit(id) {
  const db = loadHabits();
  return view(db, findIn(db, id));
}

const MAX_HISTORY_DAYS = 800;

// A stretch of a habit's past for a calendar: one character per day (see
// calendar() in streaks.js) and the check-ins and skips behind them. The last
// 365 days unless `from` and `to` say otherwise.
export function habitHistory(id, { from, to } = {}) {
  const db = loadHabits();
  const habit = findIn(db, id);
  const today = habitDay(nowMs(), currentZone(db), habit.dayStart);
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value !== undefined && value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TodoError(`"${name}" must be a date, YYYY-MM-DD.`);
  }
  const end = to ?? today;
  const start = from ?? addDays(end, -364);
  if (start > end) throw new TodoError('"from" must not be after "to".');
  if (addDays(start, MAX_HISTORY_DAYS) < end) throw new TodoError(`Ask for at most ${MAX_HISTORY_DAYS} days at a time.`);
  const events = eventsOf(db, habit);
  const undone = new Set(events.flatMap((e) => (e.kind === 'undo' ? e.targets : [])));
  return {
    from: start,
    to: end,
    today,
    ...calendar(habit, events, start, end, today),
    events: events.filter((e) => e.kind !== 'undo' && e.day >= start && e.day <= end).map((e) => ({ ...e, undone: undone.has(e.id) })),
  };
}

// ---------- habits ----------

const KEYS_KEPT = 20;
const remember = (habit, key) => {
  if (key) habit.keys = [...habit.keys, key].slice(-KEYS_KEPT);
};

// Options: `via` names the device or client; `key` makes the call safe to
// repeat (a second call with the same key returns the habit already created).
export function createHabit(input, by, { via, key } = {}) {
  const fields = cleanFields(input);
  if (!fields.name) throw new TodoError('A habit needs a name');
  if (!fields.schedule) throw new TodoError('A habit needs a schedule, for example { "kind": "daily", "slots": [{ "name": "Morning", "remind": "07:30" }] }.');
  return mutate((db) => {
    const repeated = key && db.habits.find((h) => h.keys.includes(key));
    if (repeated) return new Unchanged(view(db, repeated));
    const ts = iso(nowMs());
    const dayStart = fields.dayStart ?? DAY_START;
    const today = habitDay(nowMs(), currentZone(db), dayStart);
    const habit = {
      id: db.nextId++,
      name: fields.name,
      icon: fields.icon ?? null,
      color: fields.color ?? 'indigo',
      dayStart,
      schedule: fields.schedule,
      retired: [], // slots the schedule used to have, so the days they counted on still read properly
      history: [{ from: today, ...counted(fields.schedule) }],
      pauses: fields.paused ? [{ from: today, to: null }] : [],
      archivedAt: null,
      archivedDay: null,
      rev: 1,
      createdBy: by,
      ...(via ? { createdVia: via } : {}),
      createdAt: ts,
      updatedAt: ts,
      keys: key ? [key] : [],
    };
    db.habits.push(habit);
    return view(db, habit);
  });
}

// A changed schedule counts from today on; the days before keep the schedule
// they had. A new weekly target counts from next week, so the week under way is
// judged by the target it began with.
function applySchedule(habit, next, today) {
  const was = habit.schedule;
  if (isWeekly(habit) !== (next.kind === 'weekly')) {
    throw new HabitError('invalid', 'A habit counted in days can’t become one counted in weeks, or the other way round: its streak would mean nothing. Make a new habit instead.');
  }
  if (next.kind !== 'weekly') {
    const kept = new Set(next.slots.map((s) => s.id));
    habit.retired = [...habit.retired, ...was.slots].filter((s, i, all) => !kept.has(s.id) && all.findIndex((x) => x.id === s.id) === i);
  }
  habit.schedule = next;
  const from = next.kind === 'weekly' && habit.history[0].from < weekStart(today) ? addDays(weekStart(today), 7) : today;
  const earlier = habit.history.filter((rule) => rule.from < from);
  const rule = counted(next);
  const { from: _, ...last } = earlier[earlier.length - 1] ?? {};
  habit.history = JSON.stringify(last) === JSON.stringify(rule) ? earlier : [...earlier, { from: earlier.length ? from : habit.history[0].from, ...rule }];
}

function setPaused(habit, on, today) {
  const open = habit.pauses.find((p) => p.to === null);
  if (on === !!open) return false;
  if (on) habit.pauses.push({ from: today, to: null });
  else if (open.from === today) habit.pauses = habit.pauses.filter((p) => p !== open); // paused and resumed the same day: as if never
  else open.to = today;
  return true;
}

// An archived habit is out of sight with its history kept. If it comes back,
// the time away reads as a pause.
function setArchived(habit, on, today, ts) {
  if (on === !!habit.archivedAt) return false;
  if (on) {
    habit.archivedAt = ts;
    habit.archivedDay = today;
  } else {
    if (habit.archivedDay < today) habit.pauses.push({ from: habit.archivedDay, to: today });
    habit.archivedAt = null;
    habit.archivedDay = null;
  }
  return true;
}

// Options: `ifRev` refuses the write (HabitConflictError) unless the habit is
// still at that revision; `key` makes the call safe to repeat.
export function updateHabit(id, patch, { ifRev, key } = {}) {
  const fields = cleanFields(patch);
  return mutate((db) => {
    const habit = findIn(db, id);
    if (key && habit.keys.includes(key)) return new Unchanged(view(db, habit));
    if (ifRev !== undefined && ifRev !== null && Number(ifRev) !== habit.rev) throw new HabitConflictError(view(db, habit));
    let changed = false;
    for (const field of ['name', 'icon', 'color', 'dayStart']) {
      if (!(field in fields) || fields[field] === habit[field]) continue;
      habit[field] = fields[field];
      changed = true;
    }
    const today = habitDay(nowMs(), currentZone(db), habit.dayStart);
    if (fields.schedule && JSON.stringify(fields.schedule) !== JSON.stringify(habit.schedule)) {
      applySchedule(habit, fields.schedule, today);
      changed = true;
    }
    if ('paused' in fields && setPaused(habit, fields.paused, today)) changed = true;
    if ('archived' in fields && setArchived(habit, fields.archived, today, iso(nowMs()))) changed = true;
    if (!changed) return new Unchanged(view(db, habit));
    habit.rev += 1;
    habit.updatedAt = iso(nowMs());
    remember(habit, key);
    return view(db, habit);
  });
}

// Deletes a habit and everything it recorded. To stop without losing the
// history, archive it instead.
export function deleteHabit(id, { ifRev } = {}) {
  return mutate((db) => {
    const habit = findIn(db, id);
    if (ifRev !== undefined && ifRev !== null && Number(ifRev) !== habit.rev) throw new HabitConflictError(view(db, habit));
    db.habits = db.habits.filter((h) => h !== habit);
    db.events = db.events.filter((e) => e.habit !== habit.id);
    return { id: habit.id, name: habit.name };
  });
}

// ---------- check-ins ----------

// Records that a habit (or one slot of it) was done. Input: `slot` (optional,
// see pickSlot), `at` and `zone` (when and where; here and now if left out),
// `day` ("yesterday" to log late), `source`. Returns { habit, checkin }; `checkin`
// is null when everything was already checked in and no slot was named.
//
// A slot that is checked in twice, by two devices that didn't know about each
// other, keeps both check-ins and counts once.
export function checkIn(id, input, by, { via, key } = {}) {
  return mutate((db) => {
    const habit = findIn(db, id);
    const repeated = key && db.events.find((e) => e.key === key);
    if (repeated) return new Unchanged({ habit: view(db, habit), checkin: repeated });
    if (habit.archivedAt) throw new HabitError('archived', `"${habit.name}" is archived. Bring it back to check in.`);
    const { when, zone, named } = moment(db, input);
    const { day, backfilled } = countedDay(habit, when, zone, input.day);
    const source = input.source === undefined || input.source === null ? 'manual' : oneOf('source', input.source, SOURCES);
    let slot = null;
    if (isWeekly(habit)) {
      if (input.slot !== undefined && input.slot !== null) throw new HabitError('no_such_slot', `"${habit.name}" has no slots.`);
    } else {
      slot = pickSlot(habit, indexEvents(eventsOf(db, habit)), day, input.slot, when, zone);
      if (slot === undefined) return new Unchanged({ habit: view(db, habit), checkin: null });
    }
    // Someone who starts a habit today and logs last night's brushing started yesterday.
    if (day < habit.history[0].from) habit.history[0].from = day;
    const checkin = {
      id: db.nextEventId++, habit: habit.id, kind: 'done', slot, day, at: iso(when), zone, by,
      ...(via ? { via } : {}), source, ...(backfilled ? { backfilled: true } : {}), ...(key ? { key } : {}),
    };
    db.events.push(checkin);
    if (named) noteZone(db, zone, when);
    return { habit: view(db, habit), checkin };
  });
}

const listOf = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Takes check-ins (or a skip) back. Input is one of:
//   { checkins: [ids], keys: [idempotency keys] }   exactly those, whatever day they are for
//   { slot, day }                                    every check-in of that slot today or yesterday
//   { day }                                          every check-in that day
//   { skip: true, day }                              that day's skip
// A device that was offline names what it saw, so its undo can't remove a
// check-in made somewhere else in the meantime.
export function undo(id, input, by, { via, key } = {}) {
  return mutate((db) => {
    const habit = findIn(db, id);
    if (key && db.events.some((e) => e.key === key)) return new Unchanged({ habit: view(db, habit) });
    const { when, zone } = moment(db, input);
    const events = eventsOf(db, habit);
    const undone = new Set(events.flatMap((e) => (e.kind === 'undo' ? e.targets : [])));
    const standing = events.filter((e) => e.kind !== 'undo' && !undone.has(e.id));
    let targets;
    if (input.checkins !== undefined || input.keys !== undefined) {
      const ids = listOf(input.checkins).map(Number);
      const keys = listOf(input.keys).map(String);
      targets = standing.filter((e) => ids.includes(e.id) || (e.key && keys.includes(e.key)));
    } else {
      const { day } = countedDay(habit, when, zone, input.day);
      if (input.skip) {
        targets = standing.filter((e) => e.kind === 'skip' && e.day === (isWeekly(habit) ? weekStart(day) : day));
      } else {
        const slot = input.slot === undefined || input.slot === null || isWeekly(habit) ? null : pickSlot(habit, indexEvents(events), day, input.slot, when, zone);
        targets = standing.filter((e) => e.kind === 'done' && e.day === day && (slot === null || e.slot === slot));
      }
    }
    if (!targets.length) return new Unchanged({ habit: view(db, habit) });
    db.events.push({ id: db.nextEventId++, habit: habit.id, kind: 'undo', targets: targets.map((e) => e.id), at: iso(when), by, ...(via ? { via } : {}), ...(key ? { key } : {}) });
    return { habit: view(db, habit) };
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const skipLimit = (habit) => (isWeekly(habit)
  ? `You can skip ${plural(SKIP_WEEKS.max, 'week')} in any ${SKIP_WEEKS.weeks}. For a longer break, pause "${habit.name}": its streak waits for you.`
  : `You can skip ${SKIP_LIMITS.map((l) => `${plural(l.max, 'day')} in any ${l.days}`).join(' and ')}. For a longer break, pause "${habit.name}": its streak waits for you.`);

// Marks a day (for a habit counted in weeks, a week) as a rest: it neither
// breaks the streak nor adds to it. Today or yesterday only, and within the
// limits in streaks.js. Returns { habit, skip }; `skip` is null when there was
// nothing to skip (the day is done, off, or skipped already).
export function skipDay(id, input, by, { via, key } = {}) {
  return mutate((db) => {
    const habit = findIn(db, id);
    const repeated = key && db.events.find((e) => e.key === key);
    if (repeated) return new Unchanged({ habit: view(db, habit), skip: repeated });
    if (habit.archivedAt) throw new HabitError('archived', `"${habit.name}" is archived. Bring it back first.`);
    const { when, zone, named } = moment(db, input);
    const asked = countedDay(habit, when, zone, input.day);
    const index = indexEvents(eventsOf(db, habit));
    const day = isWeekly(habit) ? weekStart(asked.day) : asked.day;
    const { state } = isWeekly(habit) ? weekState(habit, index, day, asked.today) : dayState(habit, index, day, asked.today);
    if (state !== 'open') return new Unchanged({ habit: view(db, habit), skip: null });
    if (!skipRoom(habit, index, day, asked.today)) throw new HabitError('skip_limit', skipLimit(habit));
    const reason = cleanText(input.reason).slice(0, 200);
    const skip = {
      id: db.nextEventId++, habit: habit.id, kind: 'skip', slot: null, day, at: iso(when), zone, by,
      ...(via ? { via } : {}), ...(reason ? { reason } : {}), ...(key ? { key } : {}),
    };
    db.events.push(skip);
    if (named) noteZone(db, zone, when);
    return { habit: view(db, habit), skip };
  });
}

// A device reports the time zone it is in, so "today" follows the user when
// they travel even before their next check-in.
export function setZone(zone) {
  if (!isZone(zone)) throw new TodoError(`Unknown time zone "${zone}". Use a name like America/Chicago.`);
  return mutate((db) => {
    if (db.zone?.name === zone) return new Unchanged({ zone });
    noteZone(db, zone, nowMs());
    return { zone: currentZone(db) };
  });
}
