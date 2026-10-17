// The rules for filtering and sorting (src/query.js): the cases every client must
// pass (test/fixtures/query-cases.json), that the default order is exactly the
// one lists had before sorting could be chosen, and that the dashboard can load
// the same module.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { boot } from './support/helpers.js';

const { QueryError, SORT_KEYS, parseFilter, parseSort, selectTasks, sortTasks, todayView } = await import('../src/query.js');
const REPO = path.resolve(import.meta.dirname, '..');
const QUERY_FILE = path.join(REPO, 'src', 'query.js');

// ---------- the shared cases ----------

const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'query-cases.json'), 'utf8'));
const sets = Object.fromEntries(Object.entries(fixture.taskSets).map(([name, list]) => [name, list.map((t) => ({ ...fixture.defaults, ...t }))]));
const ids = (list) => list.map((t) => t.id);

test('the shared cases', async (t) => {
  assert.ok(fixture.cases.length > 50);
  for (const c of fixture.cases) {
    await t.test(c.name, () => {
      // Backwards, so nothing can pass by leaving the tasks in the order they came.
      const tasks = [...sets[c.tasks ?? 'board']].reverse();
      const today = c.today ?? fixture.today;
      if (c.error === 'sort') return assert.throws(() => parseSort(c.sort), QueryError);
      if (c.error === 'filter') return assert.throws(() => parseFilter(c.filter), QueryError);
      assert.equal(c.error, undefined, 'an error is "sort" or "filter"');
      if (c.view === 'today') {
        const view = todayView(tasks, today);
        return assert.deepEqual({ overdue: ids(view.overdue), today: ids(view.today) }, c.expect);
      }
      assert.equal(c.view, undefined, 'the only view is "today"');
      assert.deepEqual(ids(selectTasks(tasks, { filter: c.filter, sort: c.sort }, today)), c.expect);
    });
  }
});

// ---------- the default order is the one there always was ----------

// sortTodos from store.js as it was before query.js, word for word.
const STATUS_ORDER = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (a.status === 'done') return (b.completedAt || '').localeCompare(a.completedAt || '');
    if (a.priority !== b.priority) return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due);
    return a.id - b.id;
  });
}

test('the default order is exactly the order every list had before', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const any = (list) => list[Math.floor(random() * list.length)];
  for (let round = 0; round < 20; round++) {
    // In id order, as the data file keeps them; ties among done tasks fell to that order.
    const tasks = Array.from({ length: 200 }, (_, i) => {
      const status = any(['todo', 'in_progress', 'blocked', 'done']);
      return {
        id: i + 1,
        status,
        priority: any(['high', 'medium', 'low']),
        due: any([null, '2026-09-30', '2026-10-15', '2026-10-16', '2026-11-01']),
        completedAt: status === 'done' ? any([null, '2026-10-01T09:00:00.000Z', '2026-10-15T08:30:00.000Z', '2026-10-15T08:30:00.001Z']) : null,
      };
    });
    const shuffled = [...tasks].sort(() => random() - 0.5);
    assert.deepEqual(ids(sortTasks(shuffled)), ids(sortTodos(tasks)), `round ${round}`);
    assert.deepEqual(ids(sortTasks(shuffled, 'default')), ids(sortTodos(tasks)));
  }
});

// ---------- the text forms ----------

test('a sort can be text, a list of keys, or what parseSort returned', () => {
  const want = [{ key: 'due', desc: false }, { key: 'priority', desc: true }];
  assert.deepEqual(parseSort('due,-priority'), want);
  assert.deepEqual(parseSort(['due', '-priority']), want);
  assert.deepEqual(parseSort(want), want);
  for (const nothing of [undefined, null, '', ' , ', []]) assert.deepEqual(parseSort(nothing), [{ key: 'default', desc: false }], JSON.stringify(nothing));
  assert.throws(() => parseSort([{ key: 'nope', desc: false }]), QueryError, 'a parsed sort is checked too');
});

test('a refused sort or filter says what would have been accepted', () => {
  assert.throws(() => parseSort('due,dew'), (e) => e instanceof QueryError && e.message.includes('"dew"') && SORT_KEYS.every((k) => e.message.includes(k)));
  assert.throws(() => parseFilter({ status: 'finished' }), /Invalid status "finished"\. Expected one of: open, all, todo, in_progress, blocked, done\./);
  assert.throws(() => parseFilter({ due: 'soon' }), /before:YYYY-MM-DD, after:YYYY-MM-DD/);
  assert.throws(() => parseFilter({ tagMode: 'some' }), /Expected any or all/);
});

test('a filter can take lists as well as text', () => {
  const tasks = sets.board;
  const today = fixture.today;
  const text = selectTasks(tasks, { filter: { project: 'home,work', tag: 'errands,bug', priority: 'high' } }, today);
  const lists = selectTasks(tasks, { filter: { project: ['Home', 'Work'], tag: ['#errands', 'bug'], priority: ['high'] } }, today);
  assert.deepEqual(ids(lists), ids(text));
  assert.deepEqual(ids(text), [2, 15, 1]);
  // In a list, each entry is a whole name, commas and all.
  assert.deepEqual(ids(selectTasks(sets.commas, { filter: { project: ['Q4, planning'] } }, today)), [1]);
  assert.deepEqual(ids(selectTasks(sets.commas, { filter: { project: ['', 'q4'] } }, today)), [2, 4]);
  // An empty list doesn't narrow anything.
  assert.equal(selectTasks(tasks, { filter: { status: [], project: [], tag: [] } }, today).length, tasks.length);
});

// ---------- the dashboard's copy ----------

let s;
before(async () => {
  s = await boot({ remote: false });
});
after(() => s.close());

test('the dashboard loads the rules from the server: /query.js is src/query.js', async () => {
  const res = await s.local('GET', '/query.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.body, fs.readFileSync(QUERY_FILE, 'utf8'));
  // A browser can only load it if it needs nothing that only Node has.
  assert.doesNotMatch(res.body, /^\s*import\s/m);
  assert.doesNotMatch(res.body, /\bprocess\.|\brequire\(/);
  assert.equal((await s.local('POST', '/query.js')).status, 405);
});
