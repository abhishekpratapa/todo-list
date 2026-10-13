// Habits through Claude: the MCP tools, and that a check-in means the same thing
// wherever it is made. The iPhone (over the tailnet, with the token), the `todos`
// command (on the local socket), the dashboard and a Claude session (its own MCP
// process, writing the data file directly) all end up with one streak.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import test, { after, before } from 'node:test';
import { boot, tmp } from './support/helpers.js';

const habits = await import('../src/habits.js');
const REPO = path.resolve(import.meta.dirname, '..');

const TWICE = {
  kind: 'daily',
  slots: [
    { name: 'Morning', remind: '07:30', from: '05:00', until: '11:00' },
    { name: 'Evening', remind: '21:30', from: '19:00', until: '02:00' },
  ],
};

// A Claude session's MCP server: its own process, on the same data folder.
function claude() {
  const cwd = path.join(tmp, 'my-repo');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp.js')], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    // Calls a tool and resolves to what it said.
    async call(name, args = {}) {
      const { result } = await request('tools/call', { name, arguments: args });
      assert.ok(!result.isError, `${name} failed: ${result.content[0].text}`);
      return result.content[0].text;
    },
    // Calls a tool that is expected to refuse, and resolves to its explanation.
    async refused(name, args = {}) {
      const { result } = await request('tools/call', { name, arguments: args });
      assert.equal(result.isError, true, `${name} should have refused, but said: ${result.content[0].text}`);
      return result.content[0].text;
    },
    close: () => child.kill(),
  };
}

let s;
let mcp;
let hello;
const phone = (method, p, { headers = {}, ...rest } = {}) => s.tailnet(method, `/api/v1${p}`, { ...rest, headers: { ...s.bearer(), 'x-todos-client': 'iPhone', ...headers } });
const cli = (method, p, options) => s.sock(method, `/api/v1${p}`, options);
const fresh = () => {
  fs.rmSync(habits.HABITS_FILE, { force: true });
  habits.setZone('America/Chicago');
};

before(async () => {
  s = await boot({ socket: true });
  mcp = claude();
  hello = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
});
after(() => {
  mcp.close();
  s.close();
});

test('Claude is told about habits, and that making or deleting one needs the user\'s say-so', async () => {
  assert.match(hello.result.instructions, /habit_list.+habit_log/s);
  assert.match(hello.result.instructions, /Don't create or delete a habit unless the user explicitly asks you to\./);
  const { tools } = (await mcp.request('tools/list')).result;
  const tool = (name) => tools.find((t) => t.name === name);
  assert.deepEqual(tools.map((t) => t.name).filter((n) => n.startsWith('habit_')), ['habit_list', 'habit_log', 'habit_undo', 'habit_add', 'habit_delete']);
  assert.equal(tool('habit_list').annotations.readOnlyHint, true);
  assert.match(tool('habit_add').description, /Only use this when the user explicitly asks/);
  assert.match(tool('habit_delete').description, /Only use this when the user explicitly asks/);
  assert.equal(tool('habit_delete').annotations.destructiveHint, true);
  assert.deepEqual(tool('habit_log').inputSchema.required, ['id']);
});

test('the same check-in from the iPhone, the todos command and Claude is one check-in, and one streak everywhere', async () => {
  fresh();
  const { id } = (await phone('POST', '/habits', { body: { name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE } })).body.habit;

  // This morning, three times over: the phone's widget, the command line, and Claude.
  assert.equal((await phone('POST', `/habits/${id}/checkins`, { body: { slot: 'morning', source: 'widget' }, headers: { 'idempotency-key': 'phone-morning-0001' } })).status, 201);
  assert.equal((await cli('POST', `/habits/${id}/checkins`, { body: { slot: 'morning' } })).status, 201);
  const logged = await mcp.call('habit_log', { id, slot: 'Morning' });
  assert.match(logged, /^Logged Brush teeth \(morning\)\.\n#1 Brush teeth — today 1 of 2 \(evening still to do\) · no streak yet\n  Every day · Morning .+, Evening .+$/);
  // And this evening, by Claude alone.
  assert.match(await mcp.call('habit_log', { id }), /^Logged Brush teeth \(evening\)\.\n#1 Brush teeth — today done \(2 of 2\) · streak 1 day/);

  // Everyone is shown the same thing.
  const onPhone = (await phone('GET', `/habits/${id}`)).body.habit;
  const onCli = (await cli('GET', `/habits/${id}`)).body.habit;
  const onDashboard = (await s.local('GET', '/api/habits', { headers: { cookie: s.appCookie() } })).body.habits[0];
  assert.deepEqual(onCli, onPhone);
  for (const key of ['today', 'yesterday', 'streak', 'rates']) assert.deepEqual(onDashboard[key], onPhone[key], key);
  assert.deepEqual([onPhone.today.state, onPhone.today.done, onPhone.today.total, onPhone.streak.current, onPhone.streak.best], ['done', 2, 2, 1, 1]);
  assert.match(await mcp.call('habit_list'), /^1 habit · nothing left today\n\nDone today:\n#1 Brush teeth — today done \(2 of 2\) · streak 1 day\n/);

  // The morning was recorded three times and counts once; each record says where it came from.
  const [morning, evening] = onPhone.today.slots;
  assert.equal(morning.checkins.length, 3);
  const { events } = (await phone('GET', `/habits/${id}/history`)).body;
  assert.deepEqual(
    events.map((e) => [e.slot, e.by, e.via ?? null, e.source]),
    [['morning', 'me', 'iPhone', 'widget'], ['morning', 'me', 'command line', 'manual'], ['morning', 'Claude Code · my-repo', null, 'claude'], ['evening', 'Claude Code · my-repo', null, 'claude']],
  );
  assert.deepEqual([evening.by, evening.source], ['Claude Code · my-repo', 'claude']);

  // The phone sends its check-in again (it never heard the answer): nothing changes.
  const again = await phone('POST', `/habits/${id}/checkins`, { body: { slot: 'morning', source: 'widget' }, headers: { 'idempotency-key': 'phone-morning-0001' } });
  assert.equal(again.body.habit.today.slots[0].checkins.length, 3);
  assert.equal(again.body.habit.streak.current, 1);
});

test('Claude takes back only what a Claude session logged', async () => {
  fresh();
  const { id } = (await phone('POST', '/habits', { body: { name: 'Floss', schedule: TWICE } })).body.habit;
  await phone('POST', `/habits/${id}/checkins`, { body: { slot: 'morning' } });
  await mcp.call('habit_log', { id, slot: 'morning' });
  await mcp.call('habit_log', { id, slot: 'evening' });

  // The evening was Claude's alone: taking it back opens it again.
  assert.match(await mcp.call('habit_undo', { id, slot: 'Evening' }), /^Took back the check-in: Floss \(evening\)\.\n#1 Floss — today 1 of 2 \(evening still to do\)/);
  // The morning was also logged on the phone: Claude's goes, the phone's stands.
  assert.match(await mcp.call('habit_undo', { id, slot: 'morning' }), /^Took back the check-in: Floss \(morning\)\.\n#1 Floss — today 1 of 2/);
  let habit = (await phone('GET', `/habits/${id}`)).body.habit;
  assert.deepEqual([habit.today.slots[0].done, habit.today.slots[0].via, habit.today.slots[0].checkins.length], [true, 'iPhone', 1]);
  // Nothing of Claude's is left, and the phone's is not Claude's to take back.
  const nothing = await mcp.call('habit_undo', { id });
  assert.match(nothing, /^Nothing to take back: no Claude session logged Floss\. It is checked in, but not by a Claude session, so it was left as it is\./);
  habit = (await phone('GET', `/habits/${id}`)).body.habit;
  assert.equal(habit.today.slots[0].done, true);
  assert.match(await mcp.refused('habit_undo', { id, slot: 'noon' }), /has no slot "noon"/);
});

test('logging: yesterday, a habit counted in weeks, and what is refused', async () => {
  fresh();
  const added = await mcp.call('habit_add', { name: 'Gym', icon: '🏋️', color: 'orange', schedule: { kind: 'weekly', target: 3, remind: { days: ['mon', 'wed', 'fri'], time: '17:30' } }, day_start: '04:00' });
  assert.match(added, /^Added habit #1 Gym — 0 of 3 this week · no streak yet\n  3 days a week · reminders Mon, Wed, Fri at /);
  const created = habits.getHabit(1);
  assert.deepEqual([created.dayStart, created.color, created.icon], ['04:00', 'orange', '🏋️']);

  assert.match(await mcp.call('habit_log', { id: 1 }), /^Logged Gym\.\n#1 Gym — /);
  assert.match(await mcp.call('habit_log', { id: 1 }), /^Nothing to log: Gym is already checked in for today\./, 'one visit a day');
  assert.match(await mcp.call('habit_log', { id: 1, day: 'yesterday' }), /^Logged Gym for yesterday\./);
  assert.deepEqual([habits.getHabit(1).today.done, habits.getHabit(1).yesterday.done], [true, true]);

  for (const [args, message] of [
    [{ id: 99 }, /No habit with id #99/],
    [{ id: 1, slot: 'morning' }, /has no slots/],
    [{ id: 1, day: 'last week' }, /"day" must be a date/],
  ]) {
    assert.match(await mcp.refused('habit_log', args), message);
  }
  assert.match(await mcp.refused('habit_add', { name: 'No schedule' }), /needs a schedule/);

  assert.equal(await mcp.call('habit_delete', { id: 1 }), 'Deleted habit #1 Gym');
  assert.equal(await mcp.call('habit_list'), '(no habits yet)');
  assert.match(await mcp.refused('habit_delete', { id: 1 }), /No habit with id #1/);
});

test('what Claude does reaches the phone and the dashboard as it happens', async () => {
  fresh();
  const { id } = (await phone('POST', '/habits', { body: { name: 'Floss', schedule: TWICE } })).body.habit;
  await new Promise((r) => setTimeout(r, 200)); // let the announcement of the setup above pass
  const live = await s.stream(s.tailnet, '/api/v1/events', s.bearer());
  assert.ok(await live.sawEvent('hello'));
  await mcp.call('habit_log', { id, slot: 'morning' });
  assert.ok(await live.sawEvent('habits', 3000), 'a check-in by another process is announced');
  live.close();
});
