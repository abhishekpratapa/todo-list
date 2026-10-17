// Using another Mac's list: this Mac's server passes what its window and its
// socket ask for on to the host, and answers from the host's list; this Mac's own
// list is left alone. The host here is a real server in a process of its own, with
// its own data and remote access on, reached over plain HTTP on 127.0.0.1 (the app
// itself only accepts HTTPS, which `tailscale serve` provides).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import test, { after, before } from 'node:test';
import { send, socketDir, store, tmp } from './support/helpers.js';

const STUB = path.join(tmp, 'claude-stub');
const RAN = path.join(tmp, 'claude-ran');
fs.writeFileSync(STUB, `#!/bin/sh\npwd -P > '${RAN}.cwd'\n: > '${RAN}.args'\nfor a in "$@"; do printf '%s\\0' "$a" >> '${RAN}.args'; done\n`, { mode: 0o755 });
process.env.TODOS_CLAUDE_BIN = STUB;
process.env.TODOS_HANDOFF_DRY_RUN = '1';

const { startServer } = await import('../src/server.js');
const { HostError, MIN_HOST_REVISION, createHost, hostAddress, hostName, onTailnet, recordOnHost } = await import('../src/host.js');
const { createHandoff } = await import('../electron/handoff.js');
const { tildify } = await import('../src/claude-session.js');
const REPO = path.resolve(import.meta.dirname, '..');
const LABEL = 'Test MacBook';

// ---------- the host: another Mac's Todos, in a process of its own ----------

const HOST_DIR = path.join(tmp, 'host');
const HOST_DATA = path.join(HOST_DIR, 'data', 'todos.json');
fs.mkdirSync(path.dirname(HOST_DATA), { recursive: true });
const RUNNER = path.join(tmp, 'host-runner.mjs');
fs.writeFileSync(RUNNER, `
const [root, tokenFile, port] = process.argv.slice(2);
const { startServer } = await import(root + '/src/server.js');
const { createRemote } = await import(root + '/src/remote.js');
const remote = createRemote({ tokenFile, enabled: true, requireOwner: true });
const server = await startServer({ port: Number(port), remote });
const say = (o) => console.log(JSON.stringify(o));
say({ port: server.port, token: remote.token });
// Commands from the test, one a line.
for await (const line of (await import('node:readline')).createInterface({ input: process.stdin })) {
  if (line === 'rotate') say({ token: remote.rotate() });
}
`);

let hostProcess = null;
let hostPort = 0;
let token = null;
async function startHost() {
  hostProcess = spawn(process.execPath, [RUNNER, REPO, path.join(HOST_DIR, 'token'), String(hostPort)], { env: { ...process.env, TODO_DATA_FILE: HOST_DATA }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: hostProcess.stdout });
  hostProcess.next = () => new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));
  ({ port: hostPort, token } = await hostProcess.next());
}
function stopHost() {
  const stopping = hostProcess;
  hostProcess = null;
  return new Promise((resolve) => {
    stopping.once('exit', resolve);
    stopping.kill();
  });
}

// Asks the host directly, as another device with its token would.
const atHost = (method, p, { body, headers = {} } = {}) => send(hostPort, method, p, { body, headers: { host: `127.0.0.1:${hostPort}`, authorization: `Bearer ${token}`, ...headers } });
const hostList = () => JSON.parse(fs.readFileSync(HOST_DATA, 'utf8')).todos;
const hostTask = (id) => hostList().find((t) => t.id === id);

// ---------- this Mac, using the host's list ----------

const settings = { handoffTarget: 'terminal', projectFolders: {}, lastFolder: null };
const workFolder = path.join(tmp, 'work', 'alpha');
fs.mkdirSync(workFolder, { recursive: true });
let host;
let client;
let localData;
const window = (method, p, { body, headers = {} } = {}) => send(client.port, method, p, { body, headers: { host: `127.0.0.1:${client.port}`, ...(method !== 'GET' ? { origin: `http://127.0.0.1:${client.port}` } : {}), ...headers } });
const sock = (method, p, { body, headers = {} } = {}) => send(client.socket, method, p, { body, headers: { host: 'todos', ...headers } });

before(async () => {
  await startHost();
  // This Mac's own list, which must come through all of this untouched.
  store.createTodo({ title: 'This Mac\'s own task', project: 'alpha' }, 'me');
  localData = fs.readFileSync(process.env.TODO_DATA_FILE, 'utf8');

  host = createHost({ url: hostAddress(`http://127.0.0.1:${hostPort}`), token, label: LABEL });
  const handoff = createHandoff({
    settings,
    saveSettings: () => {},
    pickFolder: async () => null,
    workDir: () => path.join(tmp, 'handoff'),
    record: recordOnHost(host),
  });
  client = await startServer({ port: 0, handoff, socketPath: path.join(socketDir, 'client.sock'), host });
});
after(async () => {
  client?.close();
  host?.close();
  if (hostProcess) await stopHost();
  assert.equal(fs.readFileSync(process.env.TODO_DATA_FILE, 'utf8'), localData, 'this Mac\'s own list was never touched');
});

// The events a live-update stream sends, as they arrive.
function listen(to, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...(typeof to === 'number' ? { host: '127.0.0.1', port: to } : { socketPath: to }), path: p, headers, agent: false }, (res) => {
      const events = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
          const name = buffer.slice(0, i).match(/^event: (.+)$/m);
          if (name) events.push(name[1]);
        }
      });
      let ended = false;
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      const wait = async (check, ms) => {
        for (const start = Date.now(); Date.now() - start < ms; await new Promise((r) => setTimeout(r, 20))) if (check()) return true;
        return check();
      };
      const until = (name, ms = 3000) => wait(() => events.includes(name), ms);
      resolve({ status: res.statusCode, events, until, endedByServer: (ms = 2000) => wait(() => ended, ms), close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- the window ----------

test('the window shows the host\'s list, and the page itself comes from this Mac', async () => {
  await atHost('POST', '/api/v1/tasks', { body: { title: 'On the host', project: 'alpha' } });
  const list = await window('GET', '/api/todos');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.todos.map((t) => t.title), ['On the host']);
  assert.equal(list.body.host, hostName(host.url));
  assert.equal('session' in list.body, false);
  assert.deepEqual(list.body.handoff, { target: 'terminal', folders: {} }, 'Start with Claude is offered, with this Mac\'s folders');
  assert.ok(list.body.summary && list.body.version >= 1);

  const page = await window('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<html/i);
  assert.equal((await window('GET', '/app.js')).status, 200);
});

test('changes from the window are made on the host, and labelled with this Mac', async () => {
  const added = await window('POST', '/api/todos', { body: { quick: 'Added from the other Mac tomorrow !high #alpha' } });
  assert.equal(added.status, 201);
  const { id } = added.body;
  assert.equal(hostTask(id).title, 'Added from the other Mac');
  assert.equal(hostTask(id).priority, 'high');
  assert.deepEqual(hostTask(id).activity.map((a) => [a.by, a.via]), [['me', LABEL]]);

  const edited = await window('PATCH', `/api/todos/${id}`, { body: { notes: 'from the window', rev: 1 } });
  assert.equal(edited.status, 200);
  assert.equal(hostTask(id).notes, 'from the window');
  const stale = await window('PATCH', `/api/todos/${id}`, { body: { notes: 'too late', rev: 1 } });
  assert.equal(stale.status, 409, 'the host\'s conflict check still applies');
  assert.equal(stale.body.code, 'conflict');

  assert.deepEqual((await window('POST', '/api/parse', { body: { text: 'Call mum fri !low' } })).body.fields.priority, 'low');
  assert.equal((await window('DELETE', `/api/todos/${id}`)).status, 200);
  assert.equal(hostTask(id), undefined);
  assert.equal((await window('PATCH', '/api/todos/9999', { body: { title: 'x' } })).status, 404);
});

test('habits on the window are the host\'s too', async () => {
  const made = await atHost('POST', '/api/v1/habits', { body: { name: 'Stretch', schedule: { kind: 'daily', slots: [{ name: '' }] } } });
  assert.equal(made.status, 201);
  const { id } = made.body.habit;
  const habits = await window('GET', '/api/habits');
  assert.deepEqual(habits.body.habits.map((h) => h.name), ['Stretch']);
  const checked = await window('POST', `/api/habits/${id}/checkins`, { body: {} });
  assert.equal(checked.status, 200);
  const history = (await atHost('GET', `/api/v1/habits/${id}/history`)).body;
  assert.ok(JSON.stringify(history).includes(LABEL), 'the check-in reached the host, labelled with this Mac');
  assert.equal((await window('POST', `/api/habits/${id}/undo`, { body: {} })).status, 200);
});

test('the host\'s live updates reach the window', async () => {
  const live = await listen(client.port, '/api/events', { host: `127.0.0.1:${client.port}` });
  assert.equal(live.status, 200);
  assert.ok(await live.until('hello'));
  for (let i = 0; i < 10 && !live.events.includes('change'); i++) {
    await atHost('POST', '/api/v1/tasks', { body: { title: `Seen live ${i}` } });
    await live.until('change', 300);
  }
  assert.ok(live.events.includes('change'));
  live.close();
});

test('the window\'s own health check and the API at the port stay this Mac\'s', async () => {
  assert.equal((await window('GET', '/health')).body.status, 'ok');
  assert.equal((await window('GET', '/api/health')).body.app, 'todos');
  // /api/v1 at the port exists only with remote access on, as before; it is not passed on.
  assert.equal((await window('GET', '/api/v1/tasks')).status, 404);
});

// ---------- the socket ----------

test('the todos command on this Mac works on the host\'s list', async () => {
  const listed = await sock('GET', '/api/v1/tasks?status=all');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.tasks.map((t) => t.title).sort(), hostList().map((t) => t.title).sort());
  assert.equal(listed.body.tasks.some((t) => t.title === 'This Mac\'s own task'), false);

  const captured = await sock('POST', '/api/v1/capture', { body: 'Captured on the other Mac tomorrow', headers: { 'content-type': 'text/plain' } });
  assert.equal(captured.status, 201);
  assert.equal(captured.headers.location, `/api/v1/tasks/${captured.body.task.id}`);
  assert.equal(hostTask(captured.body.task.id).activity[0].via, `${LABEL} (command line)`);
  const named = await sock('POST', `/api/v1/tasks/${captured.body.task.id}/comments`, { body: { text: 'hi' }, headers: { 'x-todos-client': 'todos 0.1.0' } });
  assert.equal(named.body.task.activity.at(-1).via, `${LABEL} (todos 0.1.0)`);

  // The host's rules pass through unchanged: revisions, keys, errors.
  assert.equal((await sock('PATCH', `/api/v1/tasks/${captured.body.task.id}`, { body: { priority: 'low' } })).status, 428);
  const etag = (await sock('GET', `/api/v1/tasks/${captured.body.task.id}`)).headers.etag;
  assert.equal((await sock('PATCH', `/api/v1/tasks/${captured.body.task.id}`, { body: { priority: 'low' }, headers: { 'if-match': etag } })).status, 200);
  const key = { 'idempotency-key': 'other-mac-0001' };
  const first = await sock('POST', '/api/v1/tasks', { body: { title: 'Only once' }, headers: key });
  const again = await sock('POST', '/api/v1/tasks', { body: { title: 'Only once' }, headers: key });
  assert.equal(again.body.task.id, first.body.task.id);
  assert.equal((await sock('PUT', '/api/v1/tasks', { body: {} })).headers.allow, 'GET, POST');
  assert.equal((await sock('GET', '/api/v1/nope')).body.error.code, 'not_found');
});

test('on the socket, "who am I" and the health check are this Mac\'s; what the API speaks is the host\'s', async () => {
  assert.deepEqual((await sock('GET', '/api/v1/session')).body, { kind: 'local' });
  assert.equal((await sock('POST', '/api/v1/session', { body: { token } })).status, 404);
  assert.equal((await sock('GET', '/health')).body.status, 'ok');
  const info = await sock('GET', '/api/v1/info');
  assert.deepEqual(info.body, (await atHost('GET', '/api/v1/info')).body);
});

test('live updates reach the todos command too', async () => {
  const live = await listen(client.socket, '/api/v1/events', { host: 'todos' });
  assert.ok(await live.until('hello'));
  for (let i = 0; i < 10 && !live.events.includes('change'); i++) {
    await atHost('POST', '/api/v1/tasks', { body: { title: `Seen by the command ${i}` } });
    await live.until('change', 300);
  }
  assert.ok(live.events.includes('change'));
  live.close();
});

// ---------- Claude ----------

test('a Claude session on this Mac is credited with its changes on the host', async () => {
  const { task } = (await atHost('POST', '/api/v1/tasks', { body: { title: 'For Claude' } })).body;
  const claude = { 'x-todos-claude-session': 'Claude Code · my-repo', 'x-todos-client': 'Claude Code' };
  await sock('POST', `/api/v1/tasks/${task.id}/comments`, { body: { text: 'Looking into it' }, headers: claude });
  await sock('POST', `/api/v1/tasks/${task.id}/complete`, { headers: claude });
  const entries = hostTask(task.id).activity.slice(1);
  assert.deepEqual(entries.map((a) => [a.by, a.via]), [['Claude Code · my-repo', LABEL], ['Claude Code · my-repo', LABEL]], 'the session names itself; the label is this Mac');
});

test('the marker only ever names a Claude session, and changes nothing else', async () => {
  const { task } = (await atHost('POST', '/api/v1/tasks', { body: { title: 'Marked' } })).body;
  const by = async (value) => {
    await atHost('POST', `/api/v1/tasks/${task.id}/comments`, { body: { text: 'x' }, headers: { 'x-todos-claude-session': value } });
    return hostTask(task.id).activity.at(-1).by;
  };
  assert.equal(await by('Claude Code · my-repo'), 'Claude Code · my-repo');
  assert.equal(await by('Cowork · notes'), 'Cowork · notes');
  assert.equal(await by('Claude'), 'Claude');
  assert.equal(await by('me'), 'me', 'not a Claude session: it counts as yours');
  assert.equal(await by('Someone Else'), 'me');
  assert.equal(await by('Claude Code <script>'), 'Claude Code script', 'cleaned like any label');
  assert.equal(await by('Claudette'), 'me', 'a name that only starts the same');
  assert.equal((await by(`Claude ${'x'.repeat(200)}`)).length, 60);
  // On habits as well.
  const habit = (await atHost('POST', '/api/v1/habits', { body: { name: 'Marked habit', schedule: { kind: 'daily', slots: [{ name: '' }] } }, headers: { 'x-todos-claude-session': 'Claude Code' } })).body.habit;
  await atHost('POST', `/api/v1/habits/${habit.id}/checkins`, { body: {}, headers: { 'x-todos-claude-session': 'Claude Code' } });
  assert.match(JSON.stringify((await atHost('GET', `/api/v1/habits/${habit.id}/history`)).body), /Claude Code/);
});

test('Start with Claude on this Mac opens the session here and records it on the host', async () => {
  settings.projectFolders.alpha = workFolder;
  const { task } = (await atHost('POST', '/api/v1/tasks', { body: { title: 'Fix the login page', project: 'alpha' } })).body;
  const session = (await sock('GET', `/api/v1/tasks/${task.id}/claude-session`)).body;
  assert.equal(session.folder, workFolder, 'the folder is this Mac\'s');
  assert.match(session.prompt, new RegExp(`task #${task.id} from my todo list: Fix the login page`));

  // The window's button.
  const pressed = await window('POST', `/api/todos/${task.id}/handoff`, { body: { target: 'terminal' } });
  assert.deepEqual(pressed.body, { started: true, target: 'terminal', folder: tildify(workFolder) });
  execFileSync('/bin/zsh', [path.join(tmp, 'handoff', `todo-${task.id}.command`)]);
  assert.equal(fs.readFileSync(`${RAN}.cwd`, 'utf8').trimEnd(), workFolder);
  assert.deepEqual(fs.readFileSync(`${RAN}.args`, 'utf8').split('\0').slice(0, -1), [...session.args, '--', session.prompt]);
  const recorded = hostTask(task.id);
  assert.equal(recorded.assignee, 'claude');
  assert.deepEqual(recorded.activity.slice(-2).map((a) => [a.kind, a.text, a.via]), [
    ['event', 'assigned to Claude', LABEL],
    ['comment', `Handed this to Claude in ${tildify(workFolder)} (Terminal).`, LABEL],
  ]);

  // The todos command's claude-session route, with a key: recorded once.
  const key = { 'idempotency-key': 'start-on-other-mac-1' };
  const started = await sock('POST', `/api/v1/tasks/${task.id}/claude-session`, { body: { folder: workFolder }, headers: key });
  assert.equal(started.status, 200);
  assert.equal(started.body.task.activity.at(-1).text, `Started with Claude from terminal in ${tildify(workFolder)}.`);
  assert.equal(started.body.task.activity.at(-1).via, `${LABEL} (command line)`);
  await sock('POST', `/api/v1/tasks/${task.id}/claude-session`, { body: { folder: workFolder }, headers: key });
  assert.equal(hostTask(task.id).activity.filter((a) => a.text.startsWith('Started with Claude')).length, 1);
  assert.equal((await sock('POST', `/api/v1/tasks/${task.id}/claude-session`, { body: { folder: 'relative' } })).body.error.code, 'invalid');
  assert.equal((await sock('GET', '/api/v1/tasks/99999/claude-session')).status, 404);
});

// ---------- copying this Mac's tasks, and switching lists ----------

test('this Mac\'s open tasks can be copied to the host, once each, with their checklists', async () => {
  const { copyTasks, copyable } = await import('../src/host-copy.js');
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const at = '2026-10-01T10:00:00.000Z';
  const todo = (id, extra) => ({ id, createdAt: at, title: `Task ${id}`, notes: '', status: 'todo', priority: 'medium', due: null, project: null, tags: [], assignee: 'me', repeat: null, remindAt: null, subtasks: [], ...extra });
  const mine = [
    todo(101, { title: 'Copied with everything', notes: 'some notes', status: 'in_progress', priority: 'high', due: '2027-01-02', project: 'alpha', tags: ['x', 'y'], assignee: 'claude', repeat: 'weekly', remindAt: soon, subtasks: [{ id: 1, title: 'one', done: true }, { id: 2, title: 'two', done: false }] }),
    todo(102, { title: 'Its reminder is long past', remindAt: past }),
    todo(103, { title: 'Already done', status: 'done' }),
    todo(104, { title: '   ' }), // the host turns this one down
  ];
  const offered = copyable(mine);
  assert.deepEqual(offered.map((t) => t.id), [101, 102, 104], 'done tasks are not offered');

  const result = await copyTasks(host, offered);
  assert.equal(result.copied, 2);
  assert.deepEqual(result.failed.map((f) => f.title), ['   ']);
  const copied = hostList().find((t) => t.title === 'Copied with everything');
  assert.deepEqual(
    [copied.notes, copied.status, copied.priority, copied.due, copied.project, copied.tags, copied.assignee, copied.repeat, copied.remindAt],
    ['some notes', 'in_progress', 'high', '2027-01-02', 'alpha', ['x', 'y'], 'claude', 'weekly', soon],
  );
  assert.deepEqual(copied.subtasks.map((st) => [st.title, st.done]), [['one', true], ['two', false]]);
  assert.equal(copied.activity[0].via, LABEL);
  assert.equal(hostList().find((t) => t.title === 'Its reminder is long past').remindAt, null, 'not fired the moment it arrives');

  // Copying again (a retry) adds nothing twice.
  await copyTasks(host, offered);
  assert.equal(hostList().filter((t) => t.title === 'Copied with everything').length, 1);
  assert.equal(hostList().filter((t) => t.title === 'Its reminder is long past').length, 1);
});

test('the server switches between the host\'s list and this Mac\'s own while it runs', async () => {
  const s = await startServer({ port: 0, host });
  const ask = (p) => send(s.port, 'GET', p, { headers: { host: `127.0.0.1:${s.port}` } });
  try {
    assert.equal((await ask('/api/todos')).body.host, hostName(host.url));
    s.setHost(null);
    const own = await ask('/api/todos');
    assert.deepEqual(own.body.todos.map((t) => t.title), ['This Mac\'s own task']);
    assert.equal('host' in own.body, false);
    // A live connection to the old list is ended, so the page reconnects to the new one.
    const live = await listen(s.port, '/api/events', { host: `127.0.0.1:${s.port}` });
    assert.ok(await live.until('hello'));
    s.setHost(host);
    assert.ok(await live.endedByServer());
    assert.equal((await ask('/api/todos')).body.host, hostName(host.url));
  } finally {
    s.close();
  }
});

// ---------- Claude sessions on this Mac ----------

// A Claude Code session's MCP server on this Mac, started in `cwd` as Claude starts it.
// `settings` is what the app's settings say; `data` is the file this Mac's own list is in.
async function mcpSession({ settings, socket = client.socket, data = process.env.TODO_DATA_FILE }) {
  const userData = fs.mkdtempSync(path.join(tmp, 'mcp-user-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const cwd = path.join(tmp, 'my-repo');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp.js')], { cwd, env: { ...process.env, TODO_DATA_FILE: data, TODOS_USER_DATA: userData, TODOS_SOCKET: socket }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const ask = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
  return {
    // A tool's answer: { text, error }.
    async call(name, args = {}) {
      const { result } = await ask('tools/call', { name, arguments: args });
      return { text: result.content[0].text, error: !!result.isError };
    },
    close: () => child.kill(),
  };
}

test('Claude sessions on this Mac work on the host\'s list, and are credited with what they do there', async () => {
  const claude = await mcpSession({ settings: { host: { url: host.url.origin, name: hostName(host.url) } } });
  const ACTOR = 'Claude Code · my-repo';
  try {
    const added = await claude.call('todo_add', { title: 'From Claude on the other Mac', priority: 'high', subtasks: ['first', 'second'], comment: 'Starting on it', remind_at: '+2h' });
    assert.equal(added.error, false, added.text);
    const id = Number(added.text.match(/#(\d+)/)[1]);
    const made = hostTask(id);
    assert.equal(made.title, 'From Claude on the other Mac');
    assert.equal(made.createdBy, ACTOR);
    assert.ok(made.remindAt);
    assert.deepEqual(made.activity.map((a) => [a.by, a.kind, a.via]), [[ACTOR, 'event', LABEL], [ACTOR, 'comment', LABEL]]);

    const listed = (await claude.call('todo_list', { query: 'other Mac' })).text;
    assert.match(listed, new RegExp(`#${id} \\[To do\\] From Claude on the other Mac`));
    assert.doesNotMatch((await claude.call('todo_list', { status: 'all' })).text, /This Mac's own task/);
    assert.match((await claude.call('todo_get', { id })).text, /Starting on it/);

    const updated = await claude.call('todo_update', { id, status: 'in_progress', assignee: 'claude', check_subtasks: [1], add_subtasks: ['third'], comment: 'Halfway' });
    assert.equal(updated.error, false, updated.text);
    const after = hostTask(id);
    assert.deepEqual([after.status, after.assignee], ['in_progress', 'claude']);
    assert.deepEqual(after.subtasks.map((st) => [st.title, st.done]), [['first', true], ['second', false], ['third', false]]);
    assert.deepEqual(after.activity.slice(-1).map((a) => [a.by, a.text]), [[ACTOR, 'Halfway']]);

    assert.match((await claude.call('todo_complete', { ids: [id, 999999], comment: 'All done' })).text, /Completed #\d+ \[Done\][\s\S]*Error on #999999/);
    assert.equal(hostTask(id).status, 'done');
    const extra = Number((await claude.call('todo_add', { title: 'Added by mistake' })).text.match(/#(\d+)/)[1]);
    assert.match((await claude.call('todo_delete', { id: extra })).text, /Deleted #\d+ Added by mistake/);
    assert.equal(hostTask(extra), undefined);
    assert.equal((await claude.call('todo_get', { id: 999999 })).error, true);

    // Habits too.
    const habit = await claude.call('habit_add', { name: 'Floss', schedule: { kind: 'daily', slots: [{ name: '' }] } });
    assert.equal(habit.error, false, habit.text);
    const habitId = (await atHost('GET', '/api/v1/habits')).body.habits.find((h) => h.name === 'Floss').id;
    assert.match((await claude.call('habit_log', { id: habitId })).text, /^Logged Floss/);
    assert.equal((await atHost('GET', `/api/v1/habits/${habitId}`)).body.habit.today.state, 'done');
    assert.match((await claude.call('habit_list')).text, /Floss/);
    assert.match((await claude.call('habit_undo', { id: habitId })).text, /^Took back the check-in: Floss/);
    assert.notEqual((await atHost('GET', `/api/v1/habits/${habitId}`)).body.habit.today.state, 'done');
    assert.match((await claude.call('habit_delete', { id: habitId })).text, /Deleted habit #\d+ Floss/);
  } finally {
    claude.close();
  }
});

test('on this Mac\'s own list, the MCP server works on this Mac\'s files, as it always has', async () => {
  const data = path.join(tmp, 'own-list', 'data', 'todos.json');
  const claude = await mcpSession({ settings: { host: null }, data });
  try {
    assert.match((await claude.call('todo_add', { title: 'Kept on this Mac' })).text, /^Added #1/);
    assert.equal(JSON.parse(fs.readFileSync(data, 'utf8')).todos[0].title, 'Kept on this Mac');
    assert.equal(hostList().some((t) => t.title === 'Kept on this Mac'), false);
  } finally {
    claude.close();
  }
});

test('when the app on this Mac isn\'t answering, a Claude session is told, and nothing is written here', async () => {
  const claude = await mcpSession({ settings: { host: { url: host.url.origin, name: 'the-host' } }, socket: path.join(socketDir, 'nobody.sock') });
  try {
    const answer = await claude.call('todo_add', { title: 'Nowhere to go' });
    assert.equal(answer.error, true);
    assert.match(answer.text, /uses the todo list on the-host, through the Todos app, which isn't running/);
  } finally {
    claude.close();
  }
});

// ---------- what can go wrong ----------

test('nothing from anywhere else goes through this Mac to the host', async () => {
  const { createRemote } = await import('../src/remote.js');
  const remote = createRemote({ tokenFile: path.join(tmp, 'client-token'), enabled: true });
  remote.hosts.add('client-mac.example.ts.net');
  remote.ownerLogin = 'owner@example.com';
  const exposed = await startServer({ port: 0, remote, host });
  try {
    const relayed = await send(exposed.port, 'GET', '/api/todos', {
      headers: { host: 'client-mac.example.ts.net', 'x-forwarded-host': 'client-mac.example.ts.net', 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'owner@example.com', authorization: `Bearer ${remote.token}` },
    });
    assert.equal(relayed.status, 403);
    assert.equal(relayed.body.code, 'not_here');
  } finally {
    exposed.close();
  }
});

test('the access token never comes back from this Mac', async () => {
  const answers = await Promise.all([window('GET', '/api/todos'), window('GET', '/api/health'), sock('GET', '/api/v1/info'), sock('GET', '/api/v1/session'), sock('GET', '/health')]);
  assert.equal(JSON.stringify(answers).includes(token), false);
});

test('when the host can\'t be reached, the window and the command say so, and nothing is kept here', async () => {
  const seen = [];
  const stopFollowing = host.follow((name) => seen.push(name));
  try {
    await whileUnreachable(seen);
  } finally {
    stopFollowing();
  }
});

async function whileUnreachable(seen) {
  const hellos = () => seen.filter((e) => e === 'hello').length;
  for (let i = 0; i < 100 && !hellos(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen[0], 'hello', 'the host\'s live updates can be followed');
  await stopHost();
  const listed = await window('GET', '/api/todos');
  assert.equal(listed.status, 502);
  assert.equal(listed.body.code, 'host_unreachable');
  const added = await window('POST', '/api/todos', { body: { title: 'While the host is away' } });
  assert.equal(added.status, 502);
  const viaSocket = await sock('POST', '/api/v1/tasks', { body: { title: 'While the host is away' } });
  assert.equal(viaSocket.status, 502);
  assert.equal(viaSocket.body.error.code, 'host_unreachable');
  assert.match(viaSocket.body.error.message, /Can't reach Todos on/);
  assert.equal((await window('GET', '/api/events')).status, 502, 'the page shows Offline and tries again by itself');
  assert.equal(host.state, 'unreachable');

  await startHost(); // the same port, data and token
  assert.equal((await window('GET', '/api/todos')).status, 200);
  assert.equal(host.state, 'ok');
  // Following picks up again by itself once the host is back.
  for (let i = 0; i < 400 && hellos() < 2; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(hellos(), 2);
  assert.equal(hostList().some((t) => t.title === 'While the host is away'), false);
}

test('a token rotated on the host is refused, and the connection says it needs the new one', async () => {
  const states = [];
  const off = host.onState((s) => states.push(s));
  hostProcess.stdin.write('rotate\n');
  const { token: fresh } = await hostProcess.next();
  // Not a 401: the page would look for a sign-in page, and the command would ask to be paired.
  const listed = await window('GET', '/api/todos');
  assert.equal(listed.status, 502);
  assert.equal(listed.body.code, 'host_token_refused');
  assert.match(listed.body.error, /Reconnect to/);
  const added = await window('POST', '/api/todos', { body: { title: 'x' } });
  assert.deepEqual([added.status, added.body.code], [502, 'host_token_refused']);
  const viaSocket = await sock('GET', '/api/v1/tasks');
  assert.deepEqual([viaSocket.status, viaSocket.body.error.code], [502, 'host_token_refused']);
  assert.equal((await sock('GET', '/api/v1/tasks/1/claude-session')).body.error.code, 'host_token_refused');
  assert.equal(host.state, 'unauthorized');
  assert.deepEqual(states, ['unauthorized']);
  off();
  token = fresh;
});

// ---------- checking a host before using it ----------

test('an address is read as Tailscale gives it, and only HTTPS is accepted beyond this machine', () => {
  assert.equal(hostAddress('my-mac.tail1234.ts.net:10000').href, 'https://my-mac.tail1234.ts.net:10000/');
  assert.equal(hostAddress(' https://my-mac.tail1234.ts.net/ ').href, 'https://my-mac.tail1234.ts.net/');
  assert.equal(hostName(hostAddress('https://my-mac.tail1234.ts.net:10000')), 'my-mac');
  assert.equal(hostAddress('http://127.0.0.1:8123').href, 'http://127.0.0.1:8123/');
  for (const bad of ['http://my-mac.tail1234.ts.net', 'https://my-mac.tail1234.ts.net/api', 'https://my-mac.tail1234.ts.net?x=1', 'https://user:pw@my-mac.ts.net', 'not an address at all', '']) {
    assert.throws(() => hostAddress(bad), (e) => e instanceof HostError && e.code === 'bad_address', bad);
  }
});

// A stand-in host that answers each path with a canned response.
async function standIn(answers) {
  const server = http.createServer((req, res) => {
    const [status, body] = answers[req.url] || [404, { error: { code: 'not_found' } }];
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: hostAddress(`http://127.0.0.1:${server.address().port}`), close: () => server.close() };
}

test('a host is checked before it is used: Todos, letting this Mac in, new enough, and the right token', async () => {
  // The token was rotated above: the connection made before then is turned away, a new one isn't.
  await assert.rejects(host.check(), (e) => e.code === 'unauthorized');
  const current = createHost({ url: host.url, token, label: LABEL });
  const info = await current.check();
  assert.equal(info.apiVersion.revision >= MIN_HOST_REVISION, true);
  current.close();

  const wrong = createHost({ url: host.url, token: 'not-the-token', label: LABEL });
  await assert.rejects(wrong.check(), (e) => e.code === 'unauthorized' && /Copy Access Token/.test(e.message));
  wrong.close();

  const health = { status: 'ok', appVersion: '1.6.2', apiVersion: { version: 1, revision: 6 } };
  const cases = [
    [{ '/health': [200, '<html>a different program</html>'] }, 'not_todos'],
    [{ '/health': [403, { error: 'Forbidden host' }] }, 'remote_off'],
    [{ '/health': [200, health], '/api/v1/info': [403, { error: { code: 'forbidden_user', message: 'This Tailscale account is not allowed.' } }] }, 'not_allowed'],
    [{ '/health': [200, health], '/api/v1/info': [200, { ...health, apiVersion: { version: 1, revision: 5 }, appVersion: '1.6.1' }] }, 'too_old'],
  ];
  for (const [answers, code] of cases) {
    const fake = await standIn(answers);
    const candidate = createHost({ url: fake.url, token: 'x' });
    await assert.rejects(candidate.check(), (e) => e instanceof HostError && e.code === code, code);
    candidate.close();
    fake.close();
  }
  const nowhere = createHost({ url: hostAddress('http://127.0.0.1:9'), token: 'x' });
  await assert.rejects(nowhere.check(), (e) => e.code === 'unreachable');
  nowhere.close();
});

test('when it is this Mac\'s own Tailscale that is off, the command is told that, not to go check the other Mac', async () => {
  let asked = 0;
  const off = async () => {
    asked++;
    return { reason: 'Tailscale is turned off on this Mac', fix: 'Turn Tailscale on, then try again.' };
  };
  const nowhere = createHost({ url: hostAddress('http://127.0.0.1:9'), token: 'x', whyOffTailnet: off });
  await assert.rejects(nowhere.check(), (e) => e.code === 'unreachable' && e.message === 'Tailscale is turned off on this Mac, so Todos on localhost:9 can\'t be reached. Turn Tailscale on, then try again.');
  const s = await startServer({ port: 0, socketPath: path.join(socketDir, 'offts.sock'), host: nowhere });
  try {
    const added = await send(s.socket, 'POST', '/api/v1/tasks', { body: { title: 'While Tailscale is off' }, headers: { host: 'todos' } });
    assert.equal(added.status, 502);
    assert.equal(added.body.error.code, 'host_unreachable', 'still the code the command saves changes for later on');
    assert.match(added.body.error.message, /^Tailscale is turned off on this Mac, so Todos on localhost:9 can't be reached/);
  } finally {
    s.close();
    nowhere.close();
  }
  assert.equal(asked, 1, 'Tailscale is asked once for failures that come close together');

  // Tailscale is fine here: the other Mac gets the blame, as before.
  const fine = createHost({ url: hostAddress('http://127.0.0.1:9'), token: 'x', whyOffTailnet: async () => null });
  await assert.rejects(fine.check(), (e) => e.message === 'Can\'t reach Todos on localhost:9. Check that the Mac is awake, on Tailscale, and running Todos.');
  fine.close();

  // Only a host on the tailnet is a reason to ask this Mac's Tailscale.
  for (const address of ['my-mac.tail1234.ts.net:10000', 'https://My-Mac.Tail1234.TS.NET', 'https://100.108.213.110', 'https://[fd7a:115c:a1e0::454e:d56f]:10000']) assert.equal(onTailnet(hostAddress(address)), true, address);
  for (const address of ['http://127.0.0.1:9', 'https://todos.example.com', 'https://192.168.1.20:10000']) assert.equal(onTailnet(hostAddress(address)), false, address);
});
