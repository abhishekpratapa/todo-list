// The versioned API for other clients: task CRUD, filters, quick capture,
// conflicts, and that the OpenAPI document matches what is served.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, store } from './support/helpers.js';

const { parseQuickAdd } = await import('../src/quickadd.js');
const { createV1, API_REVISION } = await import('../src/api-v1.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let s;
let api; // (method, path, { body, headers }) as an API client on another device, with the token
before(async () => {
  s = await boot();
  api = (method, p, { headers = {}, ...rest } = {}) =>
    s.tailnet(method, `/api/v1${p}`, { ...rest, headers: { ...s.bearer(), origin: undefined, 'x-forwarded-for': `100.64.1.${device}`, 'x-todos-client': 'Test client', ...headers } });
});
after(() => s.close());

// Each test acts as a different device, so the per-client write limit never mixes them up.
let device = 0;
beforeEach(() => {
  device += 1;
});

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return store.ymd(d);
};

test('create, read, edit, complete and delete a task', async () => {
  const created = await api('POST', '/tasks', { body: { title: 'Write the report', notes: 'Use **Q3** numbers', priority: 'high', due: 'tomorrow', project: 'Work', tags: ['writing', '@urgent'], subtasks: ['Outline', 'Draft'] } });
  assert.equal(created.status, 201);
  const { task } = created.body;
  assert.equal(created.headers.location, `/api/v1/tasks/${task.id}`);
  assert.equal(created.headers.etag, '"1"');
  assert.deepEqual(
    [task.title, task.priority, task.due, task.project, task.tags, task.subtasks.map((x) => x.title), task.status, task.rev],
    ['Write the report', 'high', day(1), 'Work', ['writing', 'urgent'], ['Outline', 'Draft'], 'todo', 1],
  );

  const read = await api('GET', `/tasks/${task.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.etag, '"1"');
  assert.deepEqual(read.body.task, task);

  const edited = await api('PATCH', `/tasks/${task.id}`, { body: { priority: 'low', due: null }, headers: { 'if-match': read.headers.etag } });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.task.priority, edited.body.task.due, edited.body.task.rev, edited.headers.etag, edited.body.next], ['low', null, 2, '"2"', null]);
  assert.equal(edited.body.task.title, 'Write the report', 'fields that were not sent are untouched');

  const done = await api('POST', `/tasks/${task.id}/complete`, { body: { comment: 'Sent to the team' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.status, 'done');
  assert.ok(done.body.task.completedAt);
  assert.equal(done.body.task.activity.at(-1).text, 'Sent to the team');

  const gone = await api('DELETE', `/tasks/${task.id}`, { headers: { 'if-match': done.headers.etag } });
  assert.equal(gone.status, 204);
  assert.equal(gone.body, '');
  assert.equal((await api('GET', `/tasks/${task.id}`)).status, 404);
});

test('an edit or delete must name the revision it is based on', async () => {
  const { task } = (await api('POST', '/tasks', { body: { title: 'Contested', notes: 'v1' } })).body;

  const none = await api('PATCH', `/tasks/${task.id}`, { body: { notes: 'blind write' } });
  assert.equal(none.status, 428);
  assert.equal(none.body.error.code, 'precondition_required');
  assert.equal((await api('DELETE', `/tasks/${task.id}`)).status, 428);

  // A Claude session (through the MCP server's store) changes the task in the meantime.
  store.updateTodo(task.id, { notes: 'v2 from Claude' }, 'Claude Code · repo');

  const stale = await api('PATCH', `/tasks/${task.id}`, { body: { notes: 'v2 from my phone' }, headers: { 'if-match': '"1"' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'conflict');
  assert.deepEqual([stale.body.error.current.notes, stale.body.error.current.rev], ['v2 from Claude', 2]);
  assert.equal(store.getTodo(task.id).notes, 'v2 from Claude', 'the other change was not overwritten');
  assert.equal((await api('DELETE', `/tasks/${task.id}`, { headers: { 'if-match': '"1"' } })).status, 409);
  assert.equal((await api('DELETE', `/tasks/${task.id}?rev=1`)).status, 409);

  // Every accepted way of naming the current revision.
  for (const [headers, extra] of [[{ 'if-match': '"2"' }, {}], [{ 'if-match': 'W/"3"' }, {}], [{ 'if-match': '4' }, {}], [{}, { rev: 5 }], [{ 'if-match': '*' }, {}]]) {
    const ok = await api('PATCH', `/tasks/${task.id}`, { body: { notes: `edit ${JSON.stringify(headers)}`, ...extra }, headers });
    assert.equal(ok.status, 200, JSON.stringify([headers, extra]));
  }
  assert.equal((await api('PATCH', `/tasks/${task.id}`, { body: { notes: 'x' }, headers: { 'if-match': 'latest' } })).status, 400);
  assert.equal((await api('DELETE', `/tasks/${task.id}?rev=${store.getTodo(task.id).rev}`)).status, 204);
});

test('additive changes need no revision and never conflict', async () => {
  const { task } = (await api('POST', '/tasks', { body: { title: 'Plan trip' } })).body;
  store.updateTodo(task.id, { priority: 'high' }, 'Claude Code'); // rev moves on; none of the calls below care

  const added = await api('POST', `/tasks/${task.id}/subtasks`, { body: { title: 'Book flights', titles: ['Reserve hotel', 'Renew passport'] } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.task.subtasks.map((x) => [x.id, x.title, x.done]), [[1, 'Book flights', false], [2, 'Reserve hotel', false], [3, 'Renew passport', false]]);

  const checked = await api('PATCH', `/tasks/${task.id}/subtasks/2`, { body: { done: true, title: 'Reserve the hotel' } });
  assert.deepEqual(checked.body.task.subtasks[1], { id: 2, title: 'Reserve the hotel', done: true });
  assert.equal((await api('PATCH', `/tasks/${task.id}/subtasks/2`, { body: { done: false } })).body.task.subtasks[1].done, false);

  const removed = await api('DELETE', `/tasks/${task.id}/subtasks/3`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.task.subtasks.map((x) => x.id), [1, 2]);

  const comment = await api('POST', `/tasks/${task.id}/comments`, { body: { text: 'Flights are cheapest on Tuesday' } });
  assert.equal(comment.status, 201);

  const history = await api('GET', `/tasks/${task.id}/activity`);
  assert.equal(history.status, 200);
  assert.ok(history.body.activity.length >= 6);
  assert.ok(history.body.activity.filter((a) => a.by === 'me').every((a) => a.via === 'Test client'), 'every API change is labelled with the client');
  assert.deepEqual((await api('GET', `/tasks/${task.id}/activity?kind=comment`)).body.activity.map((a) => a.text), ['Flights are cheapest on Tuesday']);

  for (const [method, p, body] of [['PATCH', `/tasks/${task.id}/subtasks/99`, { done: true }], ['DELETE', `/tasks/${task.id}/subtasks/99`], ['POST', '/tasks/99999/comments', { text: 'x' }], ['POST', '/tasks/99999/complete'], ['GET', '/tasks/99999/activity']]) {
    assert.equal((await api(method, p, { body })).status, 404, `${method} ${p}`);
  }
});

test('completing a repeating task returns the next occurrence', async () => {
  const { task } = (await api('POST', '/tasks', { body: { title: 'Water the plants', due: 'today', repeat: 'daily', subtasks: ['Kitchen', 'Balcony'] } })).body;
  await api('PATCH', `/tasks/${task.id}/subtasks/1`, { body: { done: true } });
  const done = await api('POST', `/tasks/${task.id}/complete`);
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.next.due, done.body.next.repeat, done.body.next.status, done.body.next.rev], [day(1), 'daily', 'todo', 1]);
  assert.deepEqual(done.body.next.subtasks.map((x) => x.done), [false, false]);
  assert.equal(done.body.task.repeat, null);
  // The same through an edit.
  const edited = await api('PATCH', `/tasks/${done.body.next.id}`, { body: { status: 'done' }, headers: { 'if-match': '*' } });
  assert.equal(edited.body.next.due, day(2));
});

test('list, filter and search', async () => {
  const mk = async (body) => (await api('POST', '/tasks', { body })).body.task;
  const tag = `f${Date.now()}`; // keeps this test's tasks apart from the others'
  const a = await mk({ title: 'Alpha budget review', tags: [tag, 'finance'], priority: 'high', due: 'yesterday', project: 'Ops' });
  const b = await mk({ title: 'Beta launch checklist', tags: [tag], priority: 'low', due: 'today', assignee: 'claude', status: 'in_progress', subtasks: ['Smoke test the budget page'] });
  const c = await mk({ title: 'Gamma offsite', tags: [tag], due: '+3d', notes: 'Venue near the lake', status: 'blocked' });
  const d = await mk({ title: 'Delta archive', tags: [tag], due: '+30d' });
  const e = await mk({ title: 'Epsilon someday', tags: [tag] });
  const f = await mk({ title: 'Zeta finished', tags: [tag], status: 'done', due: 'yesterday' });

  const ids = async (query) => {
    const res = await api('GET', `/tasks?tag=${tag}&${query}`);
    assert.equal(res.status, 200, query);
    return res.body.tasks.map((t) => t.id);
  };
  const same = (got, want, label) => assert.deepEqual([...got].sort(), want.map((t) => t.id).sort(), label);

  assert.deepEqual(await ids(''), [b.id, c.id, a.id, d.id, e.id], 'default: open tasks, in the dashboard\'s order');
  same(await ids('status=all'), [a, b, c, d, e, f], 'all');
  same(await ids('status=done'), [f], 'done');
  same(await ids('status=blocked,in_progress'), [b, c], 'several statuses');
  same(await ids('priority=high,low'), [a, b], 'priority');
  same(await ids('assignee=claude'), [b], 'assignee');
  same(await ids('project=ops'), [a], 'project, ignoring case');
  same(await ids('project='), [b, c, d, e], 'no project');
  same(await ids('due=overdue'), [a], 'overdue leaves out finished tasks');
  same(await ids('due=today'), [b], 'today');
  same(await ids('due=week'), [b, c], 'week');
  same(await ids('due=none'), [e], 'no due date');
  same(await ids('due=any'), [a, b, c, d], 'has a due date');
  same(await ids(`due=${day(3)}`), [a, b, c], 'on or before a date');
  same(await ids('q=budget'), [a, b], 'search covers titles and subtasks');
  same(await ids('q=lake+venue'), [c], 'search covers notes; every word must match');
  same(await ids('q=FINANCE'), [a], 'search covers tags, ignoring case');
  same(await ids('status=all&q=zeta'), [f], 'filters combine');

  const paged = await api('GET', `/tasks?tag=${tag}&status=all&limit=2&offset=1`);
  assert.deepEqual([paged.body.tasks.length, paged.body.total], [2, 6]);
  assert.equal('activity' in paged.body.tasks[0], false, 'lists leave out the activity log');
  assert.equal(typeof paged.body.tasks[0].comments, 'number');
  assert.equal(typeof paged.body.summary.open, 'number');

  for (const bad of ['status=nope', 'priority=urgent', 'assignee=bob', 'due=whenever', 'limit=ten', 'offset=-1']) {
    const res = await api('GET', `/tasks?${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, 'invalid');
  }
});

test('meta says what the server speaks, so a client can check before relying on it', async () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const res = await api('GET', '/meta');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { api: { version: 1, revision: API_REVISION }, app: { name: 'Todos', version } });
  assert.ok(API_REVISION >= 2, 'revision 1 is Todos 1.4, which has no /meta');

  // Unlike the health check, it needs the token.
  assert.equal((await s.tailnet('GET', '/api/v1/meta')).status, 401);
  assert.equal((await api('GET', '/meta', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('a list carries the version that live updates announce', async () => {
  const before = (await api('GET', '/tasks')).body.version;
  assert.equal(before, store.load().version);
  await api('POST', '/tasks', { body: { title: 'One more change' } });
  const after = await api('GET', '/tasks?status=done&limit=1');
  assert.equal(after.body.version, before + 1, 'it is the whole list\'s version, whatever the filter');
  assert.equal(after.body.version, store.load().version);
});

test('quick capture reads a line exactly as the app does', async () => {
  const lines = [
    'Renew passport fri !high #personal',
    'Call dentist tomorrow 3pm @health',
    'Water plants every day',
    'Team sync every monday 10am #work @meeting',
    'Reply to @sam about PR #42',
    'Buy stamps',
    'Pay rent every month nov 1 !low',
  ];
  for (const line of lines) {
    const expected = JSON.parse(JSON.stringify(parseQuickAdd(line))); // what ⌃⌥T and the add bar would do
    const preview = await api('POST', '/capture/preview', { body: { text: line } });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, expected, line);

    const res = await api('POST', '/capture', { body: { text: line } });
    assert.equal(res.status, 201, line);
    assert.deepEqual(res.body.parsed, expected);
    const { task } = res.body;
    assert.equal(task.title, expected.title);
    for (const [key, value] of Object.entries(expected.fields)) assert.deepEqual(task[key], value, `${line}: ${key}`);
    assert.equal(task.activity[0].via, 'Test client');
    assert.equal(res.headers.location, `/api/v1/tasks/${task.id}`);
  }

  // The dashboard's own parse route gives the same answer.
  const viaDashboard = await s.tailnet('POST', '/api/parse', { body: { text: lines[0] }, headers: s.bearer() });
  assert.deepEqual(viaDashboard.body, (await api('POST', '/capture/preview', { body: { text: lines[0] } })).body);
});

test('quick capture accepts a bare line of text, for Shortcuts and scripts', async () => {
  const before = store.load().todos.length;
  const res = await api('POST', '/capture', { body: 'Pick up dry cleaning tomorrow !high #errands', headers: { 'content-type': 'text/plain; charset=utf-8', 'x-todos-client': 'iOS Shortcut' } });
  assert.equal(res.status, 201);
  assert.deepEqual([res.body.task.title, res.body.task.priority, res.body.task.project, res.body.task.due], ['Pick up dry cleaning', 'high', 'errands', day(1)]);
  assert.equal(res.body.task.activity[0].via, 'iOS Shortcut');
  assert.equal(store.load().todos.length, before + 1);

  for (const [body, headers] of [[{ text: '#work tomorrow' }, {}], [{ text: '   ' }, {}], [{}, {}], ['', { 'content-type': 'text/plain' }], [{ text: 42 }, {}]]) {
    const bad = await api('POST', '/capture', { body, headers });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal(store.load().todos.length, before + 1, 'nothing was created by the bad lines');
  assert.equal((await api('POST', '/capture/preview', { body: { text: '#work tomorrow' } })).body.title, '', 'preview shows an empty title rather than failing');
});

test('a captured line can say when it was typed, and relative dates are read from then', async () => {
  // Noon on a Tuesday some months ago, in this machine's own time zone.
  const typed = new Date(2026, 2, 10, 12, 0, 0);
  const at = typed.toISOString();
  const on = (y, m, d) => store.ymd(new Date(y, m - 1, d));

  const preview = await api('POST', '/capture/preview', { body: { text: 'Call dentist tomorrow 3pm', at } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, { title: 'Call dentist', fields: { due: on(2026, 3, 11), remindAt: new Date(2026, 2, 11, 15, 0, 0).toISOString() } });

  const cases = [
    ['Renew passport fri !high', { due: on(2026, 3, 13), priority: 'high' }],
    ['Pay rent today', { due: on(2026, 3, 10) }],
    ['Stretch 9am', { due: on(2026, 3, 11), remindAt: new Date(2026, 2, 11, 9, 0, 0).toISOString() }], // 9am had passed when it was typed
    ['Stretch 6pm', { due: on(2026, 3, 10), remindAt: new Date(2026, 2, 10, 18, 0, 0).toISOString() }], // still ahead when it was typed
    ['Review in 3 days', { due: on(2026, 3, 13) }],
    ['Taxes apr 15', { due: on(2026, 4, 15) }],
    ['Water plants every friday', { repeat: 'weekly', due: on(2026, 3, 13) }],
  ];
  for (const [text, fields] of cases) {
    const res = await api('POST', '/capture', { body: { text, at } });
    assert.equal(res.status, 201, text);
    assert.deepEqual(res.body.parsed.fields, fields, text);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(res.body.task[key], value, `${text}: ${key}`);
    assert.ok(Date.now() - Date.parse(res.body.task.createdAt) < 5000, 'the task itself is created now');
  }

  // Without it, a line is read from now, as before.
  assert.equal((await api('POST', '/capture', { body: { text: 'Pay rent today' } })).body.task.due, day(0));
  assert.equal(store.today(), day(0), 'and reading an old line leaves the clock alone');

  for (const bad of ['yesterday', 12345, '', new Date(Date.now() + 3600_000).toISOString()]) {
    const res = await api('POST', '/capture', { body: { text: 'x', at: bad } });
    assert.deepEqual([res.status, res.body.error.code], [400, 'invalid'], `at: ${JSON.stringify(bad)}`);
  }
});

test('a change sent twice with the same Idempotency-Key is only made once', async () => {
  const key = (name) => ({ 'idempotency-key': `test-${name}-${Date.now()}` });
  const count = async () => (await api('GET', '/tasks?status=all&limit=500')).body.total;

  // Capture: the retry returns the task the first attempt made.
  const before = await count();
  const capture = key('capture');
  const first = await api('POST', '/capture', { body: { text: 'Only once fri' }, headers: capture });
  const again = await api('POST', '/capture', { body: { text: 'Only once fri' }, headers: capture });
  assert.equal(first.status, 201);
  assert.equal(again.body.task.id, first.body.task.id);
  assert.equal(await count(), before + 1);
  const { id } = first.body.task;

  // Creating a task directly behaves the same way.
  const create = key('create');
  const made = await api('POST', '/tasks', { body: { title: 'Made once' }, headers: create });
  assert.equal((await api('POST', '/tasks', { body: { title: 'Made once' }, headers: create })).body.task.id, made.body.task.id);
  assert.equal(await count(), before + 2);

  // A comment, a subtask and a checked subtask are not repeated either.
  const comment = key('comment');
  await api('POST', `/tasks/${id}/comments`, { body: { text: 'Said once' }, headers: comment });
  await api('POST', `/tasks/${id}/comments`, { body: { text: 'Said once' }, headers: comment });
  const subtask = key('subtask');
  await api('POST', `/tasks/${id}/subtasks`, { body: { title: 'Step one' }, headers: subtask });
  await api('POST', `/tasks/${id}/subtasks`, { body: { title: 'Step one' }, headers: subtask });
  let { task } = (await api('GET', `/tasks/${id}`)).body;
  assert.equal(task.activity.filter((a) => a.text === 'Said once').length, 1);
  assert.deepEqual(task.subtasks.map((x) => x.title), ['Step one']);

  // An edit whose answer was lost: the retry is based on a revision the first
  // attempt has already moved past. It is recognised, not refused as a conflict.
  const edit = key('edit');
  const patched = await api('PATCH', `/tasks/${id}`, { body: { priority: 'high' }, headers: { 'if-match': `"${task.rev}"`, ...edit } });
  assert.equal(patched.status, 200);
  const retried = await api('PATCH', `/tasks/${id}`, { body: { priority: 'high' }, headers: { 'if-match': `"${task.rev}"`, ...edit } });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body.task, patched.body.task, 'nothing changed the second time, not even the revision');
  // The same stale edit without the key is a conflict, as always.
  assert.equal((await api('PATCH', `/tasks/${id}`, { body: { priority: 'low' }, headers: { 'if-match': `"${task.rev}"` } })).status, 409);

  // Completing a repeating task twice must not create two next occurrences.
  const repeating = (await api('POST', '/tasks', { body: { title: 'Daily thing', repeat: 'daily', due: 'today' } })).body.task;
  const complete = key('complete');
  const done = await api('POST', `/tasks/${repeating.id}/complete`, { headers: complete });
  const doneAgain = await api('POST', `/tasks/${repeating.id}/complete`, { headers: complete });
  assert.ok(done.body.next);
  assert.equal(doneAgain.body.next, null);
  assert.equal((await api('GET', '/tasks?q=Daily+thing&status=all')).body.total, 2, 'the finished one and exactly one next occurrence');

  // A repeat announces no change: the list's version does not move.
  const version = store.load().version;
  await api('POST', '/capture', { body: { text: 'Only once fri' }, headers: capture });
  assert.equal(store.load().version, version);

  // Keys are opaque but must look like keys.
  for (const bad of ['short', 'has spaces in it', 'x'.repeat(65), 'semi;colon-key']) {
    const res = await api('POST', '/capture', { body: { text: 'x' }, headers: { 'idempotency-key': bad } });
    assert.deepEqual([res.status, res.body.error.code], [400, 'invalid'], bad);
  }
  // Without a key, sending twice makes two, as it always has.
  await api('POST', '/capture', { body: { text: 'Twice' } });
  await api('POST', '/capture', { body: { text: 'Twice' } });
  assert.equal((await api('GET', '/tasks?q=Twice&status=all')).body.total, 2);
});

test('due groups match what the menu bar lists, and the summary matches the 9 AM notification', async () => {
  const due = await api('GET', '/due');
  assert.equal(due.status, 200);
  const groups = store.dueGroups(store.load().todos);
  for (const name of ['overdue', 'today', 'upcoming', 'undated', 'later']) {
    assert.deepEqual(due.body[name].map((t) => t.id), groups[name].map((t) => t.id), name);
    assert.equal(due.body.counts[name], groups[name].length);
  }
  assert.ok(due.body.overdue.length > 0 && due.body.today.length > 0 && due.body.undated.length > 0, 'the earlier tests left tasks in these groups');
  assert.equal(due.body.date, store.today());
  assert.ok(due.body.overdue.every((t) => t.status !== 'done'));

  const summary = await api('GET', '/summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.counts, store.summarize(store.load().todos));
  const daily = store.dailySummary(store.load().todos);
  assert.deepEqual([summary.body.daily.title, summary.body.daily.body], [daily.title, daily.body]);
  assert.match(summary.body.daily.title, /due today|overdue/);
});

test('bad input is refused with a clear, consistently shaped error', async () => {
  const { task } = (await api('POST', '/tasks', { body: { title: 'Target' } })).body;
  const any = { 'if-match': '*' };
  const cases = [
    ['POST', '/tasks', { body: {} }, 400, 'invalid'],
    ['POST', '/tasks', { body: { title: '  ' } }, 400, 'invalid'],
    ['POST', '/tasks', { body: { title: 'x', colour: 'red' } }, 400, 'unknown_field'],
    ['POST', '/tasks', { body: { title: 'x', priority: 'urgent' } }, 400, 'invalid'],
    ['POST', '/tasks', { body: { title: 'x', due: 'someday' } }, 400, 'invalid'],
    ['POST', '/tasks', { body: [1, 2] }, 400, 'invalid'],
    ['POST', '/tasks', { body: '{oops', headers: { 'content-type': 'application/json' } }, 400, 'invalid_json'],
    ['POST', '/tasks', { body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415, 'unsupported_media_type'],
    ['POST', '/tasks', { body: JSON.stringify({ title: 'x', notes: 'n'.repeat(300_000) }), headers: { 'content-type': 'application/json' } }, 413, 'too_large'],
    ['PATCH', `/tasks/${task.id}`, { body: { status: 'finished' }, headers: any }, 400, 'invalid'],
    ['PATCH', `/tasks/${task.id}`, { body: { comment: 'not here' }, headers: any }, 400, 'unknown_field'],
    ['PATCH', `/tasks/${task.id}`, { body: { remindAt: 'whenever' }, headers: any }, 400, 'invalid'],
    ['PATCH', '/tasks/99999', { body: { title: 'x' }, headers: any }, 404, 'not_found'],
    ['GET', '/tasks/abc', {}, 404, 'not_found'],
    ['GET', '/nothing-here', {}, 404, 'not_found'],
    ['POST', `/tasks/${task.id}/comments`, { body: { text: '' } }, 400, 'invalid'],
    ['POST', `/tasks/${task.id}/subtasks`, { body: {} }, 400, 'invalid'],
    ['PATCH', `/tasks/${task.id}/subtasks/1`, { body: { done: 'yes' } }, 404, 'not_found'],
    ['PUT', `/tasks/${task.id}`, { body: { title: 'x' } }, 405, 'method_not_allowed'],
    ['DELETE', '/tasks', {}, 405, 'method_not_allowed'],
    ['GET', '/capture', {}, 405, 'method_not_allowed'],
  ];
  for (const [method, p, opts, status, code] of cases) {
    const res = await api(method, p, opts);
    assert.equal(res.status, status, `${method} ${p} ${JSON.stringify(opts.body ?? '').slice(0, 40)}`);
    assert.deepEqual(Object.keys(res.body), ['error'], 'always { error: ... }');
    assert.equal(res.body.error.code, code);
    assert.equal(typeof res.body.error.message, 'string');
  }
  assert.equal((await api('PUT', `/tasks/${task.id}`, { body: {} })).headers.allow, 'GET, PATCH, DELETE');
  assert.deepEqual(store.getTodo(task.id).title, 'Target', 'none of it changed anything');
});

test('nothing that runs programs or reveals local paths exists in the API', async () => {
  const { task } = (await api('POST', '/tasks', { body: { title: 'Hand me off' } })).body;
  for (const p of [`/tasks/${task.id}/handoff`, `/tasks/${task.id}/claude-session`, '/handoff', '/settings', '/token', '/files']) {
    assert.equal((await api('POST', p, { body: {} })).status, 404, p);
  }
  // What the command-line client asks the local socket for is not here either.
  assert.equal((await api('GET', `/tasks/${task.id}/claude-session`)).status, 404);
  const everything = JSON.stringify([(await api('GET', '/tasks?status=all')).body, (await api('GET', '/summary')).body, (await api('GET', '/due')).body, (await api('GET', '/session')).body, (await api('GET', '/meta')).body]);
  assert.equal(everything.includes(process.env.TODO_DATA_FILE), false, 'no data file path');
  assert.equal(everything.includes(s.remote.token), false, 'no token');
});

test('the OpenAPI document describes exactly the routes that are served', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'openapi.json'), 'utf8'));
  const documented = Object.entries(doc.paths)
    .flatMap(([p, item]) => Object.keys(item).filter((k) => k !== 'parameters').map((method) => `${method.toUpperCase()} ${p}`))
    .sort();
  const served = createV1({ remote: null, openStream: null, viaLabel: null }).routes.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(documented, served);
  assert.equal(doc.openapi.startsWith('3.'), true);
  // Every operation documents its failure responses.
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      assert.ok(op.summary, `${method} ${p} has a summary`);
      if (!(op.security && op.security.length === 0)) assert.ok(op.responses['401'], `${method} ${p} documents 401`);
    }
  }
});

test('with remote access off, the API does not exist', async () => {
  s.remote.setEnabled(false);
  for (const [method, p] of [['GET', '/api/v1/health'], ['GET', '/api/v1/tasks'], ['POST', '/api/v1/capture']]) {
    const res = await s.local(method, p, { body: method === 'POST' ? { text: 'x' } : undefined, headers: s.bearer() });
    assert.equal(res.status, 404, `${method} ${p}`);
    assert.deepEqual(res.body, { error: 'Not found' }, 'the same answer 1.3.0 gives for any unknown /api path');
  }
  s.remote.setEnabled(true);
});
