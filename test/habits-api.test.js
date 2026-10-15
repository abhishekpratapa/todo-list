// Habits over /api/v1: the routes, who may use them, what they answer, and the
// live update. The rules themselves (what counts, streaks, limits) are tested
// with a pinned clock in habits.test.js; here the clock is the real one, so
// days are taken from what the server says today is.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before } from 'node:test';
import { boot, store } from './support/helpers.js';

const habits = await import('../src/habits.js');
const { HABITS_FILE } = habits;
const { addDays } = await import('../src/streaks.js');

const TWICE = {
  kind: 'daily',
  slots: [
    { name: 'Morning', remind: '07:30', from: '05:00', until: '11:00' },
    { name: 'Evening', remind: '21:30', from: '19:00', until: '02:00', nudge: '22:30' },
  ],
};

let s;
// The phone: over the tailnet, with the access token, naming itself.
const phone = (method, p, { headers = {}, ...rest } = {}) => s.tailnet(method, `/api/v1${p}`, { ...rest, headers: { ...s.bearer(), 'x-todos-client': 'iPhone', ...headers } });
// The `todos` command on this Mac: the local socket, with no token.
const cli = (method, p, options) => s.sock(method, `/api/v1${p}`, options);
const fresh = async () => {
  fs.rmSync(HABITS_FILE, { force: true });
  assert.equal((await phone('POST', '/habits/zone', { body: { zone: 'America/Chicago' } })).status, 200);
};
const make = async (body = { name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE }) => (await phone('POST', '/habits', { body })).body.habit;

before(async () => {
  s = await boot({ socket: true });
});
after(() => s.close());

test('creating, reading, editing and deleting a habit', async () => {
  await fresh();
  const created = await phone('POST', '/habits', { body: { name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE }, headers: { 'idempotency-key': 'create-brush-0001' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.location, '/api/v1/habits/1');
  assert.equal(created.headers.etag, '"1"');
  const { habit } = created.body;
  assert.deepEqual(
    Object.keys(habit).sort(),
    ['archived', 'color', 'createdAt', 'dayStart', 'icon', 'id', 'name', 'paused', 'rates', 'rev', 'schedule', 'skipsLeft', 'streak', 'today', 'updatedAt', 'yesterday'],
    'what is stored to work streaks out (the schedule\'s history, pauses, keys) is not sent',
  );
  assert.deepEqual([habit.name, habit.today.state, habit.today.total, habit.streak.current, habit.streak.unit], ['Brush teeth', 'open', 2, 0, 'days']);
  assert.equal((await phone('POST', '/habits', { body: { name: 'Brush teeth', schedule: TWICE }, headers: { 'idempotency-key': 'create-brush-0001' } })).body.habit.id, 1, 'a repeat with the same key makes nothing new');

  const list = await phone('GET', '/habits');
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.habits.length, list.body.zone, typeof list.body.version], [1, 'America/Chicago', 'number']);
  assert.deepEqual(list.body.habits[0], (await phone('GET', '/habits/1')).body.habit);
  assert.equal((await phone('GET', '/habits/1')).headers.etag, '"1"');

  // Edits say which revision they are based on, exactly as for tasks.
  const blind = await phone('PATCH', '/habits/1', { body: { name: 'Brush' } });
  assert.deepEqual([blind.status, blind.body.error.code], [428, 'precondition_required']);
  assert.match(blind.body.error.message, /habit's rev/);
  const edited = await phone('PATCH', '/habits/1', { body: { name: 'Brush', color: 'teal' }, headers: { 'if-match': '"1"' } });
  assert.deepEqual([edited.status, edited.body.habit.name, edited.body.habit.color, edited.body.habit.rev, edited.headers.etag], [200, 'Brush', 'teal', 2, '"2"']);
  const stale = await phone('PATCH', '/habits/1', { body: { name: 'Teeth' }, headers: { 'if-match': '"1"' } });
  assert.deepEqual([stale.status, stale.body.error.code, stale.body.error.current.name, stale.body.error.current.rev], [409, 'conflict', 'Brush', 2]);
  assert.equal((await phone('PATCH', '/habits/1', { body: { paused: true, rev: 2 } })).body.habit.paused, true, 'the revision can ride in the body');
  const resumed = (await phone('PATCH', '/habits/1', { body: { paused: false }, headers: { 'if-match': '*' } })).body.habit;
  assert.deepEqual([resumed.paused, resumed.rev], [false, 4]);

  assert.equal((await phone('DELETE', '/habits/1')).status, 428);
  assert.equal((await phone('DELETE', '/habits/1', { headers: { 'if-match': '"1"' } })).status, 409);
  assert.equal((await phone('DELETE', '/habits/1?rev=4')).status, 204);
  assert.deepEqual([(await phone('GET', '/habits/1')).status, (await phone('GET', '/habits')).body.habits.length], [404, 0]);
});

test('checking in, undoing and skipping', async () => {
  await fresh();
  const habit = await make();
  const { day } = habit.today;

  const first = await phone('POST', '/habits/1/checkins', { body: { slot: 'morning', source: 'widget' }, headers: { 'idempotency-key': 'checkin-morning-01' } });
  assert.equal(first.status, 201);
  assert.equal(first.headers.etag, '"1"', 'a check-in does not move the habit\'s revision');
  const { checkin } = first.body;
  assert.deepEqual(
    { habit: checkin.habit, kind: checkin.kind, slot: checkin.slot, day: checkin.day, zone: checkin.zone, by: checkin.by, via: checkin.via, source: checkin.source, key: checkin.key },
    { habit: 1, kind: 'done', slot: 'morning', day, zone: 'America/Chicago', by: 'me', via: 'iPhone', source: 'widget', key: 'checkin-morning-01' },
  );
  assert.deepEqual(first.body.habit.today.slots[0], { id: 'morning', done: true, at: checkin.at, by: 'me', via: 'iPhone', source: 'widget', checkins: [checkin.id] });
  const again = await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' }, headers: { 'idempotency-key': 'checkin-morning-01' } });
  assert.deepEqual(again.body.checkin, checkin, 'the same key again changes nothing');

  // With no body at all: now, and whatever is left.
  const rest = await cli('POST', '/habits/1/checkins');
  assert.deepEqual([rest.status, rest.body.checkin.slot, rest.body.checkin.via, rest.body.checkin.source], [201, 'evening', 'command line', 'manual']);
  assert.deepEqual([rest.body.habit.today.state, rest.body.habit.streak.current], ['done', 1]);
  const nothing = await cli('POST', '/habits/1/checkins');
  assert.deepEqual([nothing.status, nothing.body.checkin, nothing.body.habit.today.state], [200, null, 'done']);

  // A relayed request that doesn't name itself is labelled with its Tailscale device.
  const unnamed = await s.tailnet('POST', '/api/v1/habits/1/checkins', { body: { slot: 'evening' }, headers: s.bearer() });
  assert.equal(unnamed.body.checkin.via, 'Test iPhone');
  assert.equal(unnamed.body.habit.today.slots[1].checkins.length, 2, 'both are kept');
  assert.equal(unnamed.body.habit.today.done, 2, 'and the slot counts once');

  // Undo: by the ids a slot lists, by key, by slot.
  let undone = await phone('POST', '/habits/1/undo', { body: { checkins: unnamed.body.habit.today.slots[1].checkins } });
  assert.deepEqual([undone.status, undone.body.habit.today.slots[1].done, undone.body.habit.today.state], [200, false, 'open']);
  undone = await phone('POST', '/habits/1/undo', { body: { keys: ['checkin-morning-01'] }, headers: { 'idempotency-key': 'undo-morning-0001' } });
  assert.equal(undone.body.habit.today.slots[0].done, false);
  assert.equal((await phone('POST', '/habits/1/undo', { body: { slot: 'morning' } })).status, 200, 'undoing what is not there is not an error');

  // Late logging and its limit; the refusals carry a code and words for the user.
  const late = await phone('POST', '/habits/1/checkins', { body: { slot: 'evening', day: 'yesterday' } });
  assert.deepEqual([late.status, late.body.checkin.day, late.body.checkin.backfilled], [201, addDays(day, -1), true]);
  const tooLate = await phone('POST', '/habits/1/checkins', { body: { slot: 'evening', day: addDays(day, -2) } });
  assert.deepEqual([tooLate.status, tooLate.body.error.code], [400, 'too_late']);
  assert.match(tooLate.body.error.message, /until the end of today/);
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { slot: 'lunch' } })).body.error.code, 'no_such_slot');
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { source: 'telepathy' } })).body.error.code, 'invalid');
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { zone: 'Not/AZone' } })).body.error.code, 'invalid');
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { when: 'now' } })).body.error.code, 'unknown_field');
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' }, headers: { 'idempotency-key': 'short' } })).body.error.code, 'invalid');
  assert.equal((await phone('POST', '/habits/9/checkins')).status, 404);

  // Skipping: today and yesterday, then the limit.
  const skipped = await phone('POST', '/habits/1/skips', { body: { reason: 'flu' } });
  assert.deepEqual([skipped.status, skipped.body.skip.kind, skipped.body.skip.day, skipped.body.skip.reason, skipped.body.habit.today.state, skipped.body.habit.skipsLeft], [201, 'skip', day, 'flu', 'skipped', 1]);
  const twice = await phone('POST', '/habits/1/skips');
  assert.deepEqual([twice.status, twice.body.skip, twice.body.habit.today.state], [200, null, 'skipped'], 'skipping a skipped day changes nothing');
  await phone('POST', '/habits/1/undo', { body: { day: 'yesterday' } });
  assert.equal((await phone('POST', '/habits/1/skips', { body: { day: 'yesterday' } })).status, 201);
  const back = await phone('POST', '/habits/1/undo', { body: { skip: true } });
  assert.deepEqual([back.body.habit.today.state, back.body.habit.yesterday.state], ['open', 'skipped'], 'a skip is taken back like a check-in');

  await phone('PATCH', '/habits/1', { body: { archived: true }, headers: { 'if-match': '*' } });
  assert.equal((await phone('POST', '/habits/1/checkins')).body.error.code, 'archived');
  assert.deepEqual([(await phone('GET', '/habits')).body.habits.length, (await phone('GET', '/habits?archived=true')).body.habits.length], [0, 1]);
  assert.equal((await phone('GET', '/habits?archived=maybe')).status, 400);
});

test('the skip limit is refused with a code and an explanation', async () => {
  await fresh();
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  // A habit that began ten days ago. The server runs in this process, so the store can be told so.
  const habit = store.withClock(Date.now() - 10 * 864e5, () => habits.createHabit({ name: 'Brush teeth', schedule: TWICE }, 'me'));
  // Skips sent late, as from a phone that was offline: each is judged as of when it was tapped.
  assert.equal((await phone('POST', '/habits/1/skips', { body: { at: ago(2), zone: 'America/Chicago' } })).status, 201);
  assert.equal((await phone('POST', '/habits/1/skips', { body: { at: ago(1), zone: 'America/Chicago' } })).status, 201);
  const third = await phone('POST', '/habits/1/skips');
  assert.deepEqual([third.status, third.body.error.code], [400, 'skip_limit']);
  assert.match(third.body.error.message, /pause "Brush teeth"/);
  assert.equal((await phone('GET', '/habits/1')).body.habit.skipsLeft, 0);
  assert.equal(habit.skipsLeft, 2);
});

test('a history for a calendar', async () => {
  await fresh();
  const { today } = await make();
  await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' } });
  const year = await phone('GET', '/habits/1/history');
  assert.equal(year.status, 200);
  assert.deepEqual([year.body.to, year.body.today, year.body.days.length, year.body.days.slice(-2)], [today.day, today.day, 365, '.o']);
  assert.deepEqual(year.body.events.map((e) => [e.kind, e.slot, e.undone]), [['done', 'morning', false]]);
  const week = await phone('GET', `/habits/1/history?from=${addDays(today.day, -2)}&to=${addDays(today.day, 2)}`);
  assert.equal(week.body.days, '..o__');
  assert.equal((await phone('GET', '/habits/1/history?from=yesterday')).status, 400);
  assert.equal((await phone('GET', '/habits/7/history')).status, 404);
});

test('a habit counted in weeks', async () => {
  await fresh();
  const gym = await make({ name: 'Gym', schedule: { kind: 'weekly', target: 3, remind: { days: ['mon', 'wed', 'fri'], time: '17:30' } } });
  assert.deepEqual([gym.streak.unit, gym.week.count, gym.week.target, gym.today.done], ['weeks', 0, 3, false]);
  const done = await phone('POST', '/habits/1/checkins', { body: { source: 'shortcut' } });
  assert.deepEqual([done.status, done.body.checkin.slot, done.body.habit.week.count, done.body.habit.today.done], [201, null, 1, true]);
  assert.deepEqual(done.body.habit.today.checkins, [done.body.checkin.id]);
  assert.equal((await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' } })).body.error.code, 'no_such_slot');
  const changed = await phone('PATCH', '/habits/1', { body: { schedule: TWICE }, headers: { 'if-match': '*' } });
  assert.deepEqual([changed.status, changed.body.error.code], [400, 'invalid']);
  assert.match(changed.body.error.message, /Make a new habit instead/);
});

test('the same rules of admission as the rest of the API', async () => {
  await fresh();
  await make();
  // No token, a wrong token, another origin.
  assert.equal((await s.tailnet('GET', '/api/v1/habits')).status, 401);
  assert.equal((await s.tailnet('GET', '/api/v1/habits', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await s.tailnet('POST', '/api/v1/habits/1/checkins', { headers: { cookie: await s.signIn(), origin: 'https://elsewhere.example' } })).status, 403);
  // A browser signed in on another device may use them, as it may the tasks.
  const cookie = await s.signIn();
  assert.equal((await s.tailnet('POST', '/api/v1/habits/1/checkins', { headers: { cookie }, body: { slot: 'morning' } })).status, 201);
  // Bodies are checked the same way.
  assert.equal((await phone('POST', '/habits', { body: { name: 'x', schedule: TWICE, streak: 99 } })).body.error.code, 'unknown_field');
  assert.equal((await phone('POST', '/habits', { body: '{ not json', headers: { 'content-type': 'application/json' } })).body.error.code, 'invalid_json');
  assert.equal((await phone('POST', '/habits', { body: 'name=x', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await phone('POST', '/habits/zone', { body: { zone: 'Mars/Olympus' } })).status, 400);
  assert.equal((await phone('PUT', '/habits/1')).status, 405);
  assert.equal((await phone('GET', '/habits/zone')).status, 405);
  assert.equal((await phone('GET', '/habits/brush')).status, 404);

  // With remote access off the port has no API at all, and the socket still has all of it.
  s.remote.setEnabled(false);
  assert.equal((await s.local('GET', '/api/v1/habits', { headers: s.bearer() })).status, 404);
  assert.equal((await s.local('GET', '/api/habits')).body.habits.length, 1, 'the dashboard has routes of its own for habits (see habits-dashboard.test.js)');
  const viaSocket = await cli('GET', '/habits');
  assert.deepEqual([viaSocket.status, viaSocket.body.habits.length], [200, 1]);
  assert.equal((await cli('POST', '/habits/1/checkins', { body: { slot: 'evening' }, headers: { 'x-todos-client': 'todos 0.2.0' } })).body.checkin.via, 'todos 0.2.0');
  s.remote.setEnabled(true);
});

test('habits are announced on the live updates under their own name, and tasks under theirs', async () => {
  await fresh();
  await make();
  await new Promise((r) => setTimeout(r, 200)); // let the changes so far be announced before anyone is listening
  const live = await s.stream(s.tailnet, '/api/v1/events', s.bearer());
  const local = await s.stream(s.sock, '/api/v1/events');
  assert.equal(await live.sawEvent('hello'), true);
  assert.equal(await local.sawEvent('hello'), true);
  const listVersion = store.load().version;
  assert.deepEqual(live.messages[0], { event: 'hello', data: { version: listVersion } }, 'the greeting is as it always was');

  const { body } = await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' } });
  assert.equal(body.checkin.slot, 'morning');
  assert.equal(await live.sawEvent('habits', 5000), true);
  assert.equal(await local.sawEvent('habits', 5000), true);
  const announced = live.messages.find((m) => m.event === 'habits');
  assert.deepEqual(announced.data, { version: listVersion, habits: (await phone('GET', '/habits')).body.version }, 'it carries the list\'s version unchanged, and the habits\' own');
  assert.equal(live.events.includes('change'), false, 'a client that knows nothing of habits is not told to reload the list');
  assert.equal(store.load().version, listVersion);

  // Reading, and a change that changes nothing, announce nothing.
  const count = live.events.length;
  await phone('GET', '/habits');
  await phone('POST', '/habits/1/undo', { body: { slot: 'evening' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(live.events.length, count);

  // And a task still says `change`, not `habits`.
  await phone('POST', '/tasks', { body: { title: 'An ordinary task' } });
  assert.equal(await live.sawEvent('change', 5000), true);
  assert.equal(live.events.filter((e) => e === 'habits').length, 1);
  live.close();
  local.close();
});

test('a habits file put back with a version seen before is still announced', async () => {
  await fresh();
  await make();
  const copy = fs.readFileSync(HABITS_FILE, 'utf8');
  await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' } });
  await phone('POST', '/habits/1/undo', { body: { slot: 'morning' } });
  await new Promise((r) => setTimeout(r, 200));
  const live = await s.stream(s.sock, '/api/v1/events');
  assert.equal(await live.sawEvent('hello'), true);
  // Two more changes took the version to 4. Now the earlier file comes back, and then changes twice: version 4 again.
  fs.writeFileSync(HABITS_FILE, copy);
  await phone('POST', '/habits/1/checkins', { body: { slot: 'evening' } });
  await phone('POST', '/habits/1/checkins', { body: { slot: 'morning' } });
  assert.equal((await phone('GET', '/habits')).body.version, 4);
  assert.equal(await live.sawEvent('habits', 5000), true);
  live.close();
});

test('the version the API reports, and that older clients are still welcome', async () => {
  const meta = (await phone('GET', '/meta')).body;
  assert.equal(meta.api.version, 1);
  assert.ok(meta.api.revision >= 5, 'habits came in revision 5');
  const info = (await phone('GET', '/info')).body;
  assert.deepEqual(info.minClientVersions, { cli: '0.1.0', ios: '1.0' }, 'habits ask nothing new of the clients already out there');
});
