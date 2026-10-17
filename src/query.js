// Which tasks a list shows, and in what order: the rules, written down once.
// The server, the MCP server and the dashboard all use this module (the browser
// loads it as /query.js). The command-line client and the iPhone app have ports
// of it, and all three pass the same cases in test/fixtures/query-cases.json, so
// a change to a rule goes there first.
//
// Pure functions only: no I/O and no clock. "Today" (YYYY-MM-DD) is always passed
// in, so a list reads the same wherever and whenever it is worked out.
//
// A sort is an ordered list of keys, each ascending or descending. As text:
// "due,-priority,created", where a leading - means descending.
//
// A filter is a set of fields. Values within one field are OR'ed, and different
// fields are AND'ed: { priority: 'high,medium', tag: 'work' } is "high or medium,
// and tagged work". A field that is left out doesn't narrow the list at all.

export class QueryError extends Error {}

const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const OPEN = ['todo', 'in_progress', 'blocked'];
const PRIORITIES = ['high', 'medium', 'low'];
const ASSIGNEES = ['me', 'claude'];

// ---------- dates ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The day `n` days after `day`, both YYYY-MM-DD. Counted in UTC, where no day is
// ever 23 or 25 hours long.
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------- sorting ----------

// `default` is the order every list had before sorting could be chosen, and still
// has unless someone picks another: in progress, blocked, to do, then done. Open
// tasks go by priority, then due date (undated last); done tasks by most recently
// finished. Ties always go to the lower id.
export const SORT_KEYS = ['default', 'status', 'priority', 'due', 'created', 'updated', 'completed', 'title', 'project', 'id'];
export const DEFAULT_SORT = 'default';

const STATUS_RANK = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }; // so "priority" ascending is most important first

// Titles and project names compare the way a reader expects: ignoring case, in
// their own language's alphabetical order.
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' });
const byNumber = (x, y) => x - y;
const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const stamp = (iso) => (iso ? Date.parse(iso) : null);

// Each key: what to compare a task by (null when it has nothing to compare), and how.
const KEYS = {
  status: [(t) => STATUS_RANK[t.status], byNumber],
  priority: [(t) => PRIORITY_RANK[t.priority], byNumber],
  due: [(t) => t.due || null, byText],
  created: [(t) => stamp(t.createdAt), byNumber],
  updated: [(t) => stamp(t.updatedAt), byNumber],
  completed: [(t) => stamp(t.completedAt), byNumber],
  title: [(t) => t.title ?? null, collator.compare],
  project: [(t) => t.project || null, collator.compare],
  id: [(t) => t.id, byNumber],
};

// One key as a comparator. A task with nothing to compare goes last whichever
// way the key runs: undated tasks stay at the bottom of "due" and of "-due" alike.
function byKey(key, desc) {
  const [value, compare] = KEYS[key];
  return (a, b) => {
    const x = value(a);
    const y = value(b);
    const missingX = x === null || x === undefined || Number.isNaN(x);
    const missingY = y === null || y === undefined || Number.isNaN(y);
    if (missingX || missingY) return missingX - missingY;
    return desc ? compare(y, x) : compare(x, y);
  };
}

const byStatus = byKey('status', false);
const byPriority = byKey('priority', false);
const byDue = byKey('due', false);
const byCompleted = byKey('completed', true);

function byDefault(a, b) {
  return byStatus(a, b) || (a.status === 'done' ? byCompleted(a, b) : byPriority(a, b) || byDue(a, b));
}

// "due,-priority" -> [{ key: 'due', desc: false }, { key: 'priority', desc: true }].
// Also takes a list of keys as text, or a list it returned before. Nothing at all
// means the default order. Throws a QueryError naming the valid keys when a key
// isn't one of them.
export function parseSort(spec) {
  const list = Array.isArray(spec) ? spec.map((s) => (typeof s === 'string' ? s : `${s.desc ? '-' : ''}${s.key}`)) : [spec ?? ''];
  const parts = list.join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return [{ key: DEFAULT_SORT, desc: false }];
  return parts.map((part) => {
    const desc = part.startsWith('-');
    const key = desc ? part.slice(1).trim() : part;
    if (!SORT_KEYS.includes(key)) {
      throw new QueryError(`Unknown sort key "${key}". Sort by any of: ${SORT_KEYS.join(', ')}. Separate keys with commas, and put - in front of one to reverse it, as in "due,-priority".`);
    }
    if (desc && key === DEFAULT_SORT) throw new QueryError('The default order can\'t be reversed. Name the keys to sort by instead, as in "-due".');
    return { key, desc };
  });
}

// A comparator for a sort, in any form parseSort takes. The id breaks every
// remaining tie, so the same tasks come out in the same order on every client.
export function compareTasks(spec = DEFAULT_SORT) {
  const chain = [...parseSort(spec).map(({ key, desc }) => (key === DEFAULT_SORT ? byDefault : byKey(key, desc))), byKey('id', false)];
  return (a, b) => {
    for (const compare of chain) {
      const c = compare(a, b);
      if (c) return c;
    }
    return 0;
  };
}

// A sorted copy of `tasks`.
export const sortTasks = (tasks, sort = DEFAULT_SORT) => [...tasks].sort(compareTasks(sort));

// ---------- filtering ----------

// overdue: open, and due before today. week: today through 7 days out. A bare
// date is everything due on or before it; before: and after: leave that day out.
export const DUE_VALUES = ['overdue', 'today', 'tomorrow', 'week', 'none', 'any'];
const DUE_FORMS = 'overdue, today, tomorrow, week, none, any, before:YYYY-MM-DD, after:YYYY-MM-DD, or a date YYYY-MM-DD (due on or before it)';

// A comma-separated string, or a list. Each value trimmed and lowercased.
const values = (v) => (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s ?? '').trim().toLowerCase());
const given = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);

// A field that is given but names nothing (",") matches nothing, as the API's
// filters always have.
function oneOf(field, v, allowed) {
  if (!given(v)) return null;
  const list = values(v).filter(Boolean);
  const bad = list.find((x) => !allowed.includes(x));
  if (bad !== undefined) throw new QueryError(`Invalid ${field} "${bad}". Expected one of: ${allowed.join(', ')}.`);
  return [...new Set(list)];
}

function statuses(v) {
  const list = oneOf('status', v, ['open', 'all', ...STATUSES]);
  if (!list) return null;
  const wanted = new Set(list.flatMap((s) => (s === 'all' ? STATUSES : s === 'open' ? OPEN : [s])));
  return STATUSES.filter((s) => wanted.has(s));
}

// Projects as text are separated by commas, and an empty one means "no project".
// A name with a comma in it still matches as a whole, as it did when this took
// a single name. In a list, each entry is one whole name.
function projects(v) {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return null;
  const list = values(v);
  if (!Array.isArray(v) && String(v).includes(',')) list.push(String(v).trim().toLowerCase());
  return [...new Set(list)];
}

function tags(v) {
  if (!given(v)) return null;
  return [...new Set(values(v).map((t) => t.replace(/^[#@]/, '')).filter(Boolean))];
}

function due(v) {
  if (!given(v)) return null;
  const d = String(v).trim().toLowerCase();
  const m = d.match(/^(?:before|after):(.*)$/);
  if (DUE_VALUES.includes(d) || DATE.test(m ? m[1] : d)) return d;
  throw new QueryError(`Invalid due "${v}". Expected ${DUE_FORMS}.`);
}

// A filter as a client sends it, checked and put in one shape. Fields:
//   status    open, all, todo, in_progress, blocked, done
//   priority  high, medium, low
//   assignee  me, claude
//   project   project names, ignoring case; "" means no project
//   tag       tags, with or without a leading # or @
//   tagMode   any (the default: any of the tags) or all (every one of them)
//   due       one of DUE_FORMS
//   q         words that must all appear in the title, notes, project, tags or subtasks
// Every field but due, tagMode and q takes a comma-separated string or a list.
// Throws a QueryError saying what is wrong with a value.
export function parseFilter(input = {}) {
  const tagMode = given(input.tagMode) ? String(input.tagMode).trim().toLowerCase() : 'any';
  if (tagMode !== 'any' && tagMode !== 'all') throw new QueryError(`Invalid tagMode "${input.tagMode}". Expected any or all.`);
  const words = given(input.q) ? values([].concat(input.q).join(' ').split(/\s+/)).filter(Boolean) : [];
  return {
    status: statuses(input.status),
    priority: oneOf('priority', input.priority, PRIORITIES),
    assignee: oneOf('assignee', input.assignee, ASSIGNEES),
    project: projects(input.project),
    tag: tags(input.tag),
    tagMode,
    due: due(input.due),
    q: words.length ? words : null,
  };
}

function dueMatches(t, d, today) {
  switch (d) {
    case 'overdue': return !!t.due && t.due < today && t.status !== 'done';
    case 'today': return t.due === today;
    case 'tomorrow': return t.due === addDays(today, 1);
    case 'week': return !!t.due && t.due >= today && t.due <= addDays(today, 7);
    case 'none': return !t.due;
    case 'any': return !!t.due;
    default: {
      if (!t.due) return false;
      if (d.startsWith('before:')) return t.due < d.slice(7);
      if (d.startsWith('after:')) return t.due > d.slice(6);
      return t.due <= d;
    }
  }
}

const searchText = (t) => [t.title, t.notes, t.project || '', ...(t.tags || []), ...(t.subtasks || []).map((s) => s.title)].join('\n').toLowerCase();

function tagsMatch(t, f) {
  const has = (tag) => (t.tags || []).includes(tag);
  return f.tagMode === 'all' ? f.tag.every(has) : f.tag.some(has);
}

// Whether one task passes a filter that parseFilter has already checked.
export function matches(t, f, today) {
  return (!f.status || f.status.includes(t.status))
    && (!f.priority || f.priority.includes(t.priority))
    && (!f.assignee || f.assignee.includes(t.assignee))
    && (!f.project || f.project.includes((t.project || '').toLowerCase()))
    && (!f.tag || tagsMatch(t, f))
    && (!f.due || dueMatches(t, f.due, today))
    && (!f.q || f.q.every((w) => searchText(t).includes(w)));
}

export function filterTasks(tasks, filter, today) {
  const f = parseFilter(filter);
  return tasks.filter((t) => matches(t, f, today));
}

// A filter and a sort together: the tasks a list shows, in its order.
export const selectTasks = (tasks, { filter = {}, sort = DEFAULT_SORT } = {}, today) => sortTasks(filterTasks(tasks, filter, today), sort);

// ---------- views ----------

// Today: open tasks that are overdue or due today, in two groups, each most
// important first and then oldest first. Between them they are what the Dock,
// the menu bar and the iPhone's widget count as due now (dueGroups in store.js
// takes its first two groups from here).
export const TODAY_VIEW = {
  sort: 'priority,due',
  groups: [
    { name: 'overdue', label: 'Overdue', filter: { status: 'open', due: 'overdue' } },
    { name: 'today', label: 'Today', filter: { status: 'open', due: 'today' } },
  ],
};

// { overdue: [...], today: [...] }. `sort` replaces the view's own order.
export function todayView(tasks, today, sort = TODAY_VIEW.sort) {
  return Object.fromEntries(TODAY_VIEW.groups.map((g) => [g.name, selectTasks(tasks, { filter: g.filter, sort }, today)]));
}
