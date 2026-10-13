// Habits on the dashboard: the routes its page uses (/api/habits), who may use
// them, and the page's own files. The rules behind them are tested with a pinned
// clock in habits.test.js, and the wording in habit-text.test.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before } from 'node:test';
import { boot } from './support/helpers.js';

const habits = await import('../src/habits.js');

const TWICE = {
  kind: 'daily',
  slots: [
    { name: 'Morning', remind: '07:30', from: '05:00', until: '11:00' },
    { name: 'Evening', remind: '21:30', from: '19:00', until: '02:00' },
  ],
};

let off; // remote access off: the dashboard on the Mac, with no sign-in
let on; // remote access on: the app's own window, and a browser on another device
before(async () => {
  off = await boot({ enabled: false });
  on = await boot();
});
after(() => {
  off.close();
  on.close();
});

function fresh() {
  fs.rmSync(habits.HABITS_FILE, { force: true });
  habits.setZone('America/Chicago');
  const brush = habits.createHabit({ name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE }, 'me');
  const gym = habits.createHabit({ name: 'Gym', schedule: { kind: 'weekly', target: 3 } }, 'me');
  return { brush, gym };
}
const named = (res, name) => res.body.habits.find((h) => h.name === name);

test('the list comes in the order of today, with the lines that describe each habit', async () => {
  fresh();
  const res = await off.local('GET', '/api/habits');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['habits', 'left', 'version', 'zone']);
  assert.deepEqual([res.body.left, res.body.zone], [3, 'America/Chicago']);
  assert.deepEqual(res.body.habits.map((h) => [h.name, h.group]), [['Brush teeth', 'due'], ['Gym', 'due']]);
  const brush = named(res, 'Brush teeth');
  assert.deepEqual(Object.keys(brush.text).sort(), ['atRisk', 'ended', 'progress', 'schedule']);
  assert.match(brush.text.progress, /^0 of 2 · Morning /);
  assert.match(brush.text.schedule, /^Every day · Morning .+, Evening /);
  assert.equal(named(res, 'Gym').text.progress, '0 of 3 this week');
  assert.deepEqual([brush.today.total, brush.streak.current, brush.rev], [2, 0, 1], 'the habit itself is as /api/v1 gives it');
});

test('checking in, taking it back, a rest day and pausing each answer with the list as it now stands', async () => {
  const { brush, gym } = fresh();
  let res = await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'morning' } });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.left, named(res, 'Brush teeth').today.done], [2, 1]);
  const [morning] = named(res, 'Brush teeth').today.slots;
  assert.deepEqual([morning.done, morning.by, morning.via, morning.source], [true, 'me', undefined, 'manual'], 'made on the Mac itself, so it names no device');

  res = await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'Evening' } });
  assert.deepEqual([named(res, 'Brush teeth').group, named(res, 'Brush teeth').streak.current, res.body.habits[0].name], ['done', 1, 'Gym'], 'done, with a streak, and now listed after what is left');

  res = await off.local('POST', `/api/habits/${brush.id}/undo`, { body: { slot: 'evening' } });
  assert.deepEqual([named(res, 'Brush teeth').today.done, named(res, 'Brush teeth').group, named(res, 'Brush teeth').streak.current], [1, 'due', 0]);

  // A habit counted in weeks is checked in with nothing named.
  res = await off.local('POST', `/api/habits/${gym.id}/checkins`, { body: {} });
  assert.deepEqual([named(res, 'Gym').today.done, named(res, 'Gym').week.count], [true, 1]);
  res = await off.local('POST', `/api/habits/${gym.id}/undo`, { body: {} });
  assert.equal(named(res, 'Gym').week.count, 0);

  // A rest day, and taking it back.
  res = await off.local('POST', `/api/habits/${brush.id}/undo`, { body: {} });
  res = await off.local('POST', `/api/habits/${brush.id}/skips`, { body: {} });
  assert.deepEqual([named(res, 'Brush teeth').today.state, named(res, 'Brush teeth').text.progress, named(res, 'Brush teeth').group], ['skipped', 'Rest day', 'off']);
  res = await off.local('POST', `/api/habits/${brush.id}/undo`, { body: { skip: true } });
  assert.equal(named(res, 'Brush teeth').today.state, 'open');

  // Pausing and resuming.
  res = await off.local('PATCH', `/api/habits/${gym.id}`, { body: { paused: true } });
  assert.deepEqual([named(res, 'Gym').paused, named(res, 'Gym').text.progress, named(res, 'Gym').group, res.body.left], [true, 'Paused', 'off', 2]);
  res = await off.local('PATCH', `/api/habits/${gym.id}`, { body: { paused: false } });
  assert.equal(named(res, 'Gym').paused, false);
  // Only pausing is offered here: a new name in the same request is not taken.
  res = await off.local('PATCH', `/api/habits/${gym.id}`, { body: { paused: false, name: 'Renamed' } });
  assert.equal(res.body.habits.some((h) => h.name === 'Renamed'), false);
});

test('yesterday can be logged from the dashboard, and nothing older', async () => {
  const { brush } = fresh();
  let res = await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'evening', day: 'yesterday' } });
  assert.equal(res.status, 200);
  assert.equal(named(res, 'Brush teeth').yesterday.slots.find((s) => s.id === 'evening').done, true);
  res = await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'evening', day: '2020-01-01' } });
  assert.deepEqual([res.status, res.body.code], [400, 'too_late']);
  assert.match(res.body.error, /yesterday until the end of today/);
});

test('a habit\'s past, for its calendar', async () => {
  const { brush } = fresh();
  await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'morning' } });
  const today = (await off.local('GET', '/api/habits')).body.habits[0].today.day;
  const res = await off.local('GET', `/api/habits/${brush.id}/history?from=${today}&to=${today}`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.from, res.body.to, res.body.today, res.body.days], [today, today, today, 'o']);
  assert.equal((await off.local('GET', `/api/habits/${brush.id}/history`)).body.days.length, 365, 'a year unless told otherwise');
  assert.equal((await off.local('GET', `/api/habits/${brush.id}/history?from=tomorrow`)).status, 400);
});

test('refusals: no such habit, no such slot, and nothing else is served under /api/habits', async () => {
  const { brush } = fresh();
  assert.equal((await off.local('POST', '/api/habits/99/checkins', { body: {} })).status, 404);
  assert.equal((await off.local('GET', '/api/habits/99/history')).status, 404);
  const slot = await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'noon' } });
  assert.deepEqual([slot.status, slot.body.code], [400, 'no_such_slot']);
  // Making, renaming and deleting habits is not the dashboard's: that is /api/v1/habits.
  assert.equal((await off.local('POST', '/api/habits', { body: { name: 'New', schedule: TWICE } })).status, 404);
  assert.equal((await off.local('DELETE', `/api/habits/${brush.id}`)).status, 404);
  assert.equal((await off.local('GET', `/api/habits/${brush.id}`)).status, 404);
  assert.equal(habits.listHabits().habits.length, 2, 'and nothing was made or removed');
});

test('with remote access on: the app and a signed-in browser may, anyone else may not', async () => {
  const { brush } = fresh();
  assert.equal((await on.tailnet('GET', '/api/habits')).status, 401, 'not signed in');
  assert.equal((await on.local('GET', '/api/habits')).status, 401, 'nor on the Mac without the app\'s own cookie');
  assert.equal((await on.tailnet('POST', `/api/habits/${brush.id}/checkins`, { body: {} })).status, 401);

  const app = { cookie: on.appCookie() };
  assert.equal((await on.local('GET', '/api/habits', { headers: app })).status, 200);
  let res = await on.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'morning' }, headers: app });
  assert.equal(named(res, 'Brush teeth').today.slots[0].via, undefined, 'the app itself stays unlabelled');

  // A browser on the phone: signed in, same origin. Its check-in says where it came from.
  const cookie = await on.signIn();
  res = await on.tailnet('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'evening' }, headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual([named(res, 'Brush teeth').today.slots[1].by, named(res, 'Brush teeth').today.slots[1].via], ['me', 'Test iPhone']);
  const crossSite = await on.tailnet('POST', `/api/habits/${brush.id}/undo`, { body: {}, headers: { cookie, origin: 'https://evil.example' } });
  assert.deepEqual([crossSite.status, crossSite.body.code], [403, 'forbidden_origin']);
  assert.equal(named(await on.tailnet('GET', '/api/habits', { headers: { cookie } }), 'Brush teeth').today.done, 2, 'and the cross-site request changed nothing');
});

test('the page\'s own files are served, and only to those who may see the dashboard', async () => {
  for (const [file, type] of [['/habits.js', 'text/javascript; charset=utf-8'], ['/habits.css', 'text/css; charset=utf-8']]) {
    const res = await off.local('GET', file);
    assert.deepEqual([res.status, res.headers['content-type']], [200, type]);
    assert.equal((await on.tailnet('GET', file)).status, 302, 'someone not signed in is sent to sign in');
  }
  const page = (await off.local('GET', '/')).body;
  assert.match(page, /<link rel="stylesheet" href="\/habits\.css">/);
  assert.match(page, /<section class="habits" id="habits" aria-label="Habits" hidden>/, 'hidden until there is a habit to show');
  assert.match((await off.local('GET', '/app.js')).body, /from '\/habits\.js'/);
});

test('a change made here is announced to every open page under "habits"', async () => {
  const { brush } = fresh();
  await new Promise((r) => setTimeout(r, 200)); // let the announcement of the setup above pass
  const stream = await off.stream(off.local, '/api/events');
  assert.ok(await stream.sawEvent('hello'));
  await off.local('POST', `/api/habits/${brush.id}/checkins`, { body: { slot: 'morning' } });
  assert.ok(await stream.sawEvent('habits', 3000), 'the dashboard hears of it');
  assert.equal(stream.events.includes('change'), false, 'and the task list is not reloaded for it');
  stream.close();
});
