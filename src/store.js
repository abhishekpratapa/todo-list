// Shared todo store: a single JSON file that the dashboard server and every
// MCP server process (one per Claude session) read and write concurrently.
// Writes go through a mkdir-based lock and an atomic rename, so readers never
// see a half-written file and concurrent writers never clobber each other.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One canonical location shared by the app, the dev server, and every MCP process,
// regardless of where the code itself lives. Matches the Electron app's userData dir.
function defaultDataFile() {
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Todos')
    : path.join(os.homedir(), '.todos');
  return path.join(base, 'data', 'todos.json');
}

export const DATA_FILE = process.env.TODO_DATA_FILE || defaultDataFile();
export const PORT = Number(process.env.TODO_PORT || 7420);
export const DASHBOARD_URL = `http://127.0.0.1:${PORT}`;

const LOCK_DIR = `${DATA_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const PRIORITIES = ['high', 'medium', 'low'];
export const ASSIGNEES = ['me', 'claude'];
export const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
export const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
export const REPEAT_LABELS = { daily: 'daily', weekdays: 'every weekday', weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', yearly: 'yearly' };

export class TodoError extends Error {}

const emptyDb = () => ({ version: 0, nextId: 1, updatedAt: null, todos: [] });
const now = () => new Date().toISOString();

export function load() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyDb();
    throw e;
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    throw new TodoError(`Todo data file is not valid JSON: ${DATA_FILE}`);
  }
  // Fill in fields added after a todo was created (older versions, older MCP processes).
  for (const t of db.todos) {
    t.subtasks ??= [];
    t.repeat ??= null;
    t.remindAt ??= null;
    t.remindedAt ??= null;
  }
  return db;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  try {
    Atomics.wait(sleeper, 0, 0, ms);
  } catch {
    const until = Date.now() + ms; // environments that forbid Atomics.wait on the main thread
    while (Date.now() < until);
  }
}

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
        fs.rmdirSync(LOCK_DIR);
        continue;
      }
    } catch {
      continue; // lock vanished between mkdir and stat; retry immediately
    }
    if (Date.now() > deadline) throw new TodoError('Timed out waiting for the todo store lock');
    sleep(15);
  }
}

// Run fn(db) under the lock and persist the result. If fn throws, nothing is written.
export function mutate(fn) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  acquireLock();
  try {
    const db = load();
    const result = fn(db);
    db.version += 1;
    db.updatedAt = now();
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
    fs.renameSync(tmp, DATA_FILE);
    return result;
  } finally {
    fs.rmdirSync(LOCK_DIR);
  }
}

// Calls onChange() (debounced) whenever the data file is replaced. Returns an unsubscribe function.
export function watchStore(onChange) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let timer;
  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename && filename !== path.basename(DATA_FILE)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 40);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

// ---------- dates ----------

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const today = () => ymd(new Date());

// "2026-10-05 09:58" in local time.
export function localStamp(iso) {
  const d = new Date(iso);
  return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// "oct 20", "october 20th", "20 oct", optionally with a year. Without a year it
// means the next such date. Returns YYYY-MM-DD, or null if it isn't a month-day.
function parseMonthDay(v) {
  let name; let day; let year;
  let m = v.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
  if (m) [, name, day, year] = m;
  else if ((m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/))) [, day, name, year] = m;
  else return null;
  const month = MONTHS.findIndex((mo) => mo.startsWith(name));
  if (month < 0) return null;
  const make = (y) => {
    const d = new Date(y, month, Number(day));
    return d.getMonth() === month && d.getDate() === Number(day) ? d : null;
  };
  let d = make(year ? Number(year) : new Date().getFullYear());
  if (d && !year && ymd(d) < today()) d = make(d.getFullYear() + 1);
  return d ? ymd(d) : null;
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// Accepts YYYY-MM-DD, today, tomorrow, yesterday, +3d, +2w, "in 3 days", "in 2 weeks",
// "next week", a weekday name ("fri", "next friday"), or a month and day ("oct 20").
export function parseDue(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (v === '' || v === 'none' || v === 'null') return null;
  if (v === 'today') return addDays(0);
  if (v === 'tomorrow' || v === 'tmrw' || v === 'tmr') return addDays(1);
  if (v === 'yesterday') return addDays(-1);
  if (v === 'next week') return addDays(7);
  let m = v.match(/^(?:\+|in\s+)(\d+)\s*(d|days?|w|wks?|weeks?)?$/);
  if (m) return addDays(Number(m[1]) * (m[2]?.startsWith('w') ? 7 : 1));
  m = v.match(/^(?:next\s+)?([a-z]+)$/);
  if (m) {
    const idx = WEEKDAYS.findIndex((w) => m[1].length >= 3 && w.startsWith(m[1]));
    if (idx >= 0) {
      const diff = (idx - new Date().getDay() + 7) % 7 || 7;
      return addDays(diff);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, mo, d] = v.split('-').map(Number);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d) return v;
  }
  const monthDay = parseMonthDay(v);
  if (monthDay) return monthDay;
  throw new TodoError(`Unrecognized due date "${value}". Use YYYY-MM-DD, today, tomorrow, +3d, a weekday name, or a date like "oct 20".`);
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Same day-of-month n months later, clamped to the month's length (Jan 31 -> Feb 28).
function addMonths(d, n, day) {
  const out = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
}

// Next due date for a repeating task: one interval after `from` (its due date, or
// today if it had none), stepping forward until the result is in the future so a
// long-overdue task doesn't come back already overdue.
export function nextDue(from, repeat) {
  const t0 = today();
  let d = parseYmd(from || t0);
  const anchorDay = d.getDate();
  do {
    switch (repeat) {
      case 'daily': d.setDate(d.getDate() + 1); break;
      case 'weekdays': do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); break;
      case 'weekly': d.setDate(d.getDate() + 7); break;
      case 'biweekly': d.setDate(d.getDate() + 14); break;
      case 'monthly': d = addMonths(d, 1, anchorDay); break;
      case 'yearly': d = addMonths(d, 12, anchorDay); break;
      default: throw new TodoError(`Invalid repeat "${repeat}"`);
    }
  } while (ymd(d) <= t0);
  return ymd(d);
}

// Reminder time in the user's local time. Accepts "YYYY-MM-DD HH:MM", a day word plus a
// time ("today 15:00", "tomorrow 9am", "fri 14:30"), a bare time (today), a bare day
// (9:00 that day), relative offsets ("+30m", "+2h", "in 2 days"), or an ISO timestamp
// with a zone. Returns an ISO string, or null to clear.
export function parseRemind(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const v = raw.toLowerCase();
  if (v === '' || v === 'none' || v === 'null') return null;
  const bad = () => new TodoError(`Unrecognized reminder time "${value}". Use "YYYY-MM-DD HH:MM", "tomorrow 9am", "fri 14:30", or "+2h".`);

  let m = v.match(/^(?:\+|in\s+)(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/);
  if (m) {
    const ms = { m: 60e3, h: 3600e3, d: 864e5 }[m[2][0]];
    return new Date(Date.now() + Number(m[1]) * ms).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}t[\d:.]+(z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw bad();
    return d.toISOString();
  }

  let day;
  let hour = 9;
  let minute = 0;
  m = v.match(/^(.*?)(?:^|\s+at\s+|\s+|t)(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(am|pm)?$/);
  if (m && (m[3] !== undefined || m[4])) { // a colon or am/pm is what makes it a time
    try {
      day = m[1].trim() ? parseDue(m[1].trim()) : today();
    } catch {
      throw bad();
    }
    hour = Number(m[2]);
    minute = Number(m[3] || 0);
    if (m[4] === 'pm' && hour < 12) hour += 12;
    if (m[4] === 'am' && hour === 12) hour = 0;
  } else {
    try {
      day = parseDue(v);
    } catch {
      throw bad();
    }
  }
  if (!day || hour > 23 || minute > 59) throw bad();
  const d = parseYmd(day);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// ---------- validation ----------

function oneOf(field, value, allowed) {
  const v = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias = {
    med: 'medium', normal: 'medium', doing: 'in_progress', complete: 'done', completed: 'done', open: 'todo', you: 'me', user: 'me',
    every_day: 'daily', every_weekday: 'weekdays', every_week: 'weekly', every_2_weeks: 'biweekly', fortnightly: 'biweekly',
    every_month: 'monthly', every_year: 'yearly', annually: 'yearly',
  };
  const resolved = allowed.includes(v) ? v : alias[v];
  if (!allowed.includes(resolved)) throw new TodoError(`Invalid ${field} "${value}". Expected one of: ${allowed.join(', ')}`);
  return resolved;
}

function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim().replace(/^[#@]/, '').toLowerCase()).filter(Boolean))];
}

const cleanText = (v) => (v === null || v === undefined ? '' : String(v)).trim();

function cleanRepeat(v) {
  const s = cleanText(v).toLowerCase();
  return s === '' || s === 'none' || s === 'never' || s === 'null' ? null : oneOf('repeat', s, REPEATS);
}

function cleanSubtaskTitles(list) {
  if (!Array.isArray(list)) throw new TodoError('Subtasks must be a list of titles');
  return list.map((s) => cleanText(s && typeof s === 'object' ? s.title : s).slice(0, 300)).filter(Boolean);
}

// Normalizes the user-editable fields of a todo. Unknown keys are ignored.
function cleanFields(input) {
  const out = {};
  if ('title' in input) {
    const title = cleanText(input.title);
    if (!title) throw new TodoError('Title cannot be empty');
    out.title = title.slice(0, 500);
  }
  if ('notes' in input) out.notes = cleanText(input.notes);
  if ('status' in input) out.status = oneOf('status', input.status, STATUSES);
  if ('priority' in input) out.priority = oneOf('priority', input.priority, PRIORITIES);
  if ('assignee' in input) out.assignee = oneOf('assignee', input.assignee, ASSIGNEES);
  if ('due' in input) out.due = parseDue(input.due);
  if ('project' in input) out.project = cleanText(input.project) || null;
  if ('tags' in input) out.tags = cleanTags(input.tags);
  if ('repeat' in input) out.repeat = cleanRepeat(input.repeat);
  if ('remindAt' in input || 'remind_at' in input) out.remindAt = parseRemind(input.remindAt ?? input.remind_at);
  return out;
}

function findIn(db, id) {
  const n = Number(String(id).replace(/^#/, ''));
  const todo = db.todos.find((t) => t.id === n);
  if (!todo) throw new TodoError(`No todo with id #${id}`);
  return todo;
}

// ---------- operations ----------

export function getTodo(id) {
  return findIn(load(), id);
}

export function createTodo(input, by) {
  if (!('title' in input)) throw new TodoError('Title is required');
  const fields = cleanFields(input);
  const subtasks = cleanSubtaskTitles(input.subtasks ?? []);
  return mutate((db) => {
    const ts = now();
    const todo = {
      id: db.nextId++,
      title: fields.title,
      notes: '',
      status: 'todo',
      priority: 'medium',
      due: null,
      project: null,
      tags: [],
      assignee: 'me',
      subtasks: subtasks.map((title, i) => ({ id: i + 1, title, done: false })),
      repeat: null,
      remindAt: null,
      remindedAt: null,
      createdBy: by,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
      activity: [{ at: ts, by, kind: 'event', text: 'created this task' }],
      ...fields,
    };
    if (todo.status === 'done') todo.completedAt = ts;
    const comment = cleanText(input.comment);
    if (comment) todo.activity.push({ at: ts, by, kind: 'comment', text: comment });
    db.todos.push(todo);
    return todo;
  });
}

function describeChange(key, from, to) {
  switch (key) {
    case 'status': return `moved ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`;
    case 'notes': return 'edited notes';
    case 'title': return `renamed to "${to}"`;
    case 'tags': return to.length ? `set tags ${to.map((t) => '@' + t).join(' ')}` : 'cleared tags';
    case 'assignee': return `assigned to ${to === 'me' ? 'you' : 'Claude'}`;
    case 'repeat': return to ? `set to repeat ${REPEAT_LABELS[to]}` : 'stopped repeating';
    case 'remindAt': return to ? `set a reminder for ${localStamp(to)}` : 'cleared the reminder';
    default: return to === null ? `cleared ${key}` : `set ${key} to ${to}`;
  }
}

// Subtask edits, applied inside a mutation. Keys on the patch:
//   add_subtasks: [titles]   check_subtasks / uncheck_subtasks / remove_subtasks: [ids]
//   rename_subtask: { id, title }
function applySubtaskOps(todo, patch, changes) {
  const quoted = (list) => list.map((s) => `"${s.title}"`).join(', ');
  const pick = (ids) => (Array.isArray(ids) ? ids : [ids]).map((id) => {
    const sub = todo.subtasks.find((s) => s.id === Number(id));
    if (!sub) throw new TodoError(`Todo #${todo.id} has no subtask ${id}`);
    return sub;
  });

  if (patch.add_subtasks) {
    let nextId = Math.max(0, ...todo.subtasks.map((s) => s.id)) + 1;
    const added = cleanSubtaskTitles(patch.add_subtasks).map((title) => ({ id: nextId++, title, done: false }));
    todo.subtasks.push(...added);
    if (added.length) changes.push(`added subtask${added.length > 1 ? 's' : ''} ${quoted(added)}`);
  }
  if (patch.rename_subtask) {
    const [sub] = pick(patch.rename_subtask.id);
    const title = cleanText(patch.rename_subtask.title).slice(0, 300);
    if (!title) throw new TodoError('Subtask title cannot be empty');
    if (title !== sub.title) {
      changes.push(`renamed subtask "${sub.title}" to "${title}"`);
      sub.title = title;
    }
  }
  for (const [key, done, verb] of [['check_subtasks', true, 'checked off'], ['uncheck_subtasks', false, 'unchecked']]) {
    if (!patch[key]) continue;
    const hit = pick(patch[key]).filter((s) => s.done !== done);
    for (const sub of hit) sub.done = done;
    if (hit.length) changes.push(`${verb} ${quoted(hit)}`);
  }
  if (patch.remove_subtasks) {
    const gone = pick(patch.remove_subtasks);
    todo.subtasks = todo.subtasks.filter((s) => !gone.includes(s));
    if (gone.length) changes.push(`removed subtask${gone.length > 1 ? 's' : ''} ${quoted(gone)}`);
  }
}

// Creates the next occurrence of a repeating todo that was just completed. The
// completed one stops repeating (it stays in Done as history); the copy carries
// the repeat forward with a fresh checklist and a shifted reminder.
function spawnNext(db, todo, ts, by) {
  const due = nextDue(todo.due, todo.repeat);
  let remindAt = null;
  if (todo.remindAt) {
    const shifted = new Date(todo.remindAt);
    const days = Math.round((parseYmd(due) - parseYmd(todo.due || today())) / 864e5);
    shifted.setDate(shifted.getDate() + days);
    if (shifted.getTime() > Date.now()) remindAt = shifted.toISOString();
  }
  const next = {
    ...structuredClone(todo),
    id: db.nextId++,
    status: 'todo',
    due,
    subtasks: todo.subtasks.map((s) => ({ ...s, done: false })),
    remindAt,
    remindedAt: null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    activity: [{ at: ts, by, kind: 'event', text: `created this task (repeats ${REPEAT_LABELS[todo.repeat]}, follows #${todo.id})` }],
  };
  db.todos.push(next);
  todo.repeat = null;
  return next;
}

// Returns { todo, next }: `next` is the new occurrence when completing a repeating todo, else null.
export function updateTodo(id, patch, by) {
  const fields = cleanFields(patch);
  const comment = cleanText(patch.comment);
  return mutate((db) => {
    const todo = findIn(db, id);
    const ts = now();
    const changes = [];
    const becameDone = fields.status === 'done' && todo.status !== 'done';
    for (const [key, value] of Object.entries(fields)) {
      if (JSON.stringify(todo[key]) === JSON.stringify(value)) continue;
      changes.push(describeChange(key, todo[key], value));
      if (key === 'status') todo.completedAt = value === 'done' ? ts : null;
      if (key === 'remindAt') todo.remindedAt = null;
      todo[key] = value;
    }
    applySubtaskOps(todo, patch, changes);
    let next = null;
    if (becameDone && todo.repeat) {
      next = spawnNext(db, todo, ts, by);
      changes.push(`next occurrence is #${next.id}, due ${next.due}`);
    }
    if (changes.length) todo.activity.push({ at: ts, by, kind: 'event', text: changes.join(' · ') });
    if (comment) todo.activity.push({ at: ts, by, kind: 'comment', text: comment });
    if (changes.length || comment) todo.updatedAt = ts;
    return { todo, next };
  });
}

// ---------- reminders ----------

// Open todos whose reminder time has passed and hasn't been delivered yet.
export function pendingReminders(todos, at = Date.now()) {
  return todos.filter((t) => t.status !== 'done' && t.remindAt && !t.remindedAt && Date.parse(t.remindAt) <= at);
}

// Records that reminders were delivered. Deliberately leaves updatedAt and the activity log alone.
export function markReminded(ids) {
  return mutate((db) => {
    const ts = now();
    for (const t of db.todos) if (ids.includes(t.id)) t.remindedAt = ts;
  });
}

export function deleteTodo(id) {
  return mutate((db) => {
    const todo = findIn(db, id);
    db.todos = db.todos.filter((t) => t !== todo);
    return todo;
  });
}

// ---------- queries ----------

const STATUS_ORDER = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

export function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (a.status === 'done') return (b.completedAt || '').localeCompare(a.completedAt || '');
    if (a.priority !== b.priority) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due);
    return a.id - b.id;
  });
}

// filters: { status: 'open'|'all'|'done'|<status>|[statuses], project, tag, assignee, query, overdue, limit }
export function listTodos(filters = {}) {
  const db = load();
  const { project, tag, assignee, query } = filters;
  let statuses;
  const s = filters.status ?? 'open';
  if (s === 'all') statuses = STATUSES;
  else if (s === 'open') statuses = ['todo', 'in_progress', 'blocked'];
  else statuses = (Array.isArray(s) ? s : [s]).map((x) => oneOf('status', x, STATUSES));

  const t0 = today();
  let list = db.todos.filter((t) => statuses.includes(t.status));
  if (project) list = list.filter((t) => (t.project || '').toLowerCase() === String(project).toLowerCase());
  if (tag) list = list.filter((t) => t.tags.includes(String(tag).replace(/^[#@]/, '').toLowerCase()));
  if (assignee) {
    const a = oneOf('assignee', assignee, ASSIGNEES);
    list = list.filter((t) => t.assignee === a);
  }
  if (query) {
    const q = String(query).toLowerCase();
    list = list.filter((t) => [t.title, t.notes, ...t.subtasks.map((x) => x.title)].join('\n').toLowerCase().includes(q));
  }
  if (filters.overdue) list = list.filter((t) => t.due && t.due < t0 && t.status !== 'done');
  list = sortTodos(list);
  const total = list.length;
  if (filters.limit) list = list.slice(0, Number(filters.limit));
  return { todos: list, total, summary: summarize(db.todos) };
}

export function summarize(todos) {
  const t0 = today();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const open = todos.filter((t) => t.status !== 'done');
  return {
    open: open.length,
    in_progress: open.filter((t) => t.status === 'in_progress').length,
    blocked: open.filter((t) => t.status === 'blocked').length,
    overdue: open.filter((t) => t.due && t.due < t0).length,
    due_today: open.filter((t) => t.due === t0).length,
    claude: open.filter((t) => t.assignee === 'claude').length,
    done_7d: todos.filter((t) => t.status === 'done' && t.completedAt >= weekAgo).length,
  };
}
