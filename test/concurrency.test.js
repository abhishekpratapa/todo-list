// Many writers at once: API clients on other devices, Claude sessions through the
// MCP server (separate processes), and the Mac app. All of them go through the
// same store and file lock, so every single change must survive.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, store } from './support/helpers.js';

const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');

// Runs a Claude session's MCP server as its own process and makes the given tool calls.
function mcpSession(name, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env }, cwd: path.dirname(MCP), stdio: ['pipe', 'pipe', 'inherit'] });
    const results = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
        const msg = JSON.parse(buffer.slice(0, i));
        if (msg.id > 0) results.push(msg.result);
        if (results.length === calls.length) child.stdin.end();
      }
    });
    child.on('error', reject);
    child.on('exit', () => resolve(results));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `claude-code-${name}`, version: '1' } } })}\n`);
    calls.forEach(([tool, args], i) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: tool, arguments: args } })}\n`));
  });
}

// Runs the given request functions with a few in flight at a time, as one device would.
async function inFlight(limit, starters) {
  const queue = [...starters];
  await Promise.all(Array.from({ length: limit }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await next();
  }));
}

let s;
before(async () => {
  s = await boot();
});
after(() => s.close());

test('API, MCP and app writes at the same time lose nothing', async () => {
  const shared = store.createTodo({ title: 'Shared task everyone edits' }, 'me');
  const before = store.load();
  const N = 25; // changes per writer, per kind

  const api = (device) => (method, p, body) =>
    s.tailnet(method, `/api/v1${p}`, { body, headers: { ...s.bearer(), origin: undefined, 'x-forwarded-for': `100.64.2.${device}`, 'x-todos-client': `phone-${device}` } });
  const app = (method, p, body) => s.local(method, p, { body, headers: { cookie: s.appCookie() } });

  const jobs = [];
  const expect = { comments: [], subtasks: [], created: [] };
  const note = (kind, text) => {
    expect[kind].push(text);
    return text;
  };

  // Three devices using the API, each with several requests in flight.
  for (const device of [1, 2, 3]) {
    const call = api(device);
    const requests = [];
    for (let i = 0; i < N; i++) {
      const comment = note('comments', `api-${device} comment ${i}`);
      const subtask = note('subtasks', `api-${device} subtask ${i}`);
      const title = note('created', `api-${device} task ${i}`);
      requests.push(() => call('POST', `/tasks/${shared.id}/comments`, { text: comment }).then((r) => assert.equal(r.status, 201)));
      requests.push(() => call('POST', `/tasks/${shared.id}/subtasks`, { title: subtask }).then((r) => assert.equal(r.status, 201)));
      requests.push(() => call('POST', '/capture', { text: `${title} tomorrow !high` }).then((r) => assert.equal(r.status, 201)));
    }
    jobs.push(inFlight(4, requests));
  }
  // The Mac app's own window, through the dashboard's routes.
  const appRequests = [];
  for (let i = 0; i < N; i++) {
    const comment = note('comments', `app comment ${i}`);
    const subtask = note('subtasks', `app subtask ${i}`);
    const title = note('created', `app task ${i}`);
    appRequests.push(() => app('PATCH', `/api/todos/${shared.id}`, { comment }).then((r) => assert.equal(r.status, 200)));
    appRequests.push(() => app('PATCH', `/api/todos/${shared.id}`, { add_subtasks: [subtask] }).then((r) => assert.equal(r.status, 200)));
    appRequests.push(() => app('POST', '/api/todos', { title }).then((r) => assert.equal(r.status, 201)));
  }
  jobs.push(inFlight(4, appRequests));
  // Three Claude sessions, each its own MCP server process.
  for (const session of ['a', 'b', 'c']) {
    const calls = [];
    for (let i = 0; i < N; i++) {
      calls.push(['todo_update', { id: shared.id, comment: note('comments', `mcp-${session} comment ${i}`) }]);
      calls.push(['todo_update', { id: shared.id, add_subtasks: [note('subtasks', `mcp-${session} subtask ${i}`)] }]);
      calls.push(['todo_add', { title: note('created', `mcp-${session} task ${i}`) }]);
    }
    jobs.push(mcpSession(session, calls).then((results) => {
      assert.equal(results.length, calls.length);
      assert.ok(results.every((r) => r && !r.isError), 'no MCP call failed');
    }));
  }
  await Promise.all(jobs);

  const after = store.load();
  const task = after.todos.find((t) => t.id === shared.id);
  const sorted = (list) => [...list].sort();

  const comments = task.activity.filter((a) => a.kind === 'comment').map((a) => a.text);
  assert.equal(comments.length, expect.comments.length, 'every comment is there, once');
  assert.deepEqual(sorted(comments), sorted(expect.comments));

  assert.deepEqual(sorted(task.subtasks.map((x) => x.title)), sorted(expect.subtasks), 'every subtask is there, once');
  assert.equal(new Set(task.subtasks.map((x) => x.id)).size, task.subtasks.length, 'subtask ids are unique');

  const created = after.todos.filter((t) => t.id > shared.id).map((t) => t.title);
  assert.deepEqual(sorted(created), sorted(expect.created), 'every new task is there, once');
  assert.equal(new Set(after.todos.map((t) => t.id)).size, after.todos.length, 'task ids are unique');
  assert.equal(after.nextId, Math.max(...after.todos.map((t) => t.id)) + 1);

  // Exactly one revision and one data-file version per change: nothing was applied twice or skipped.
  assert.equal(task.rev, shared.rev + expect.comments.length + expect.subtasks.length);
  const total = expect.comments.length + expect.subtasks.length + expect.created.length;
  assert.equal(after.version, before.version + total);
  assert.equal(total, 7 * N * 3, 'seven writers, three kinds of change each');

  // Who did what is recorded correctly, and the lock left nothing behind.
  assert.ok(task.activity.filter((a) => a.text.startsWith('api-2 comment')).every((a) => a.by === 'me' && a.via === 'phone-2'));
  assert.ok(task.activity.filter((a) => a.text.startsWith('app comment')).every((a) => a.by === 'me' && !a.via));
  assert.ok(task.activity.filter((a) => a.text.startsWith('mcp-a comment')).every((a) => a.by.startsWith('Claude')));
  const leftovers = fs.readdirSync(path.dirname(process.env.TODO_DATA_FILE)).filter((f) => f !== 'todos.json');
  assert.deepEqual(leftovers, [], 'no lock or temp files remain');
});

test('when several clients edit the same revision at once, exactly one wins', async () => {
  const task = store.createTodo({ title: 'Race me', notes: 'start' }, 'me');
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    s.tailnet('PATCH', `/api/v1/tasks/${task.id}`, { body: { notes: `writer ${i}` }, headers: { ...s.bearer(), origin: undefined, 'if-match': `"${task.rev}"`, 'x-forwarded-for': `100.64.3.${i}` } })));
  const winners = attempts.filter((r) => r.status === 200);
  const losers = attempts.filter((r) => r.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 11);
  const final = store.getTodo(task.id);
  assert.equal(final.notes, winners[0].body.task.notes, 'the stored notes are the winner\'s');
  assert.equal(final.rev, task.rev + 1);
  assert.ok(losers.every((r) => r.body.error.current.notes === final.notes), 'every loser is shown what won');
});

test('a Claude session and a phone editing the same task: the later one is told, not obeyed', async () => {
  const task = store.createTodo({ title: 'Plan', notes: 'draft' }, 'me');
  const phoneSaw = (await s.tailnet('GET', `/api/v1/tasks/${task.id}`, { headers: s.bearer() })).headers.etag;
  const [claude] = await mcpSession('x', [['todo_update', { id: task.id, notes: 'rewritten by Claude' }]]);
  assert.ok(!claude.isError);
  const phone = await s.tailnet('PATCH', `/api/v1/tasks/${task.id}`, { body: { notes: 'rewritten on the phone' }, headers: { ...s.bearer(), origin: undefined, 'if-match': phoneSaw } });
  assert.equal(phone.status, 409);
  assert.equal(phone.body.error.current.notes, 'rewritten by Claude');
  assert.equal(store.getTodo(task.id).notes, 'rewritten by Claude');
});
