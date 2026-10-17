// Nothing that existed before the command-line support and habits has changed:
// the dashboard, the API the iPhone app uses, remote access (on and off) and the
// MCP server. This runs the real 1.6.1 code (from the v1.6.1 git tag) next to the
// current code, puts both through the same requests from the same starting data,
// and compares everything they answer. The current server runs with its local
// socket open, since that is how the app runs it.
//
// Known, intended differences, each checked here rather than ignored:
//   - GET /api/v1/meta reports API revision 7 instead of 3, and the app's own
//     version from package.json instead of 1.6.1.
//   - GET /api/v1/tasks refuses an unknown `due` just as before, but the message
//     also names the values revision 7 added (tomorrow, before:, after:).
//   - The dashboard's page and its script (/, /index.html, /app.js) gained the
//     Habits section. The stylesheet is untouched: habits have their own.
//   - The MCP server offers todo_today and the habit tools after the ones it had,
//     and its instructions end with a paragraph about habits and one about
//     todo_today. todo_list takes more arguments (sort, due, lists of projects,
//     tags and priorities) and says so; every argument it took means what it did,
//     and every other tool it had is described and behaves exactly as before.
// What is new (GET /health, GET /api/v1/info, the socket and its routes,
// everything under /api/v1/habits and /api/habits, and the habit tools) is
// tested in socket.test.js, claude-session.test.js, habits-api.test.js,
// habits-dashboard.test.js and habits-mcp.test.js.
//
// When a later version changes one of the dashboard's files on purpose, add its
// path to CHANGED below; it is then compared by status and headers only.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import test, { after, before } from 'node:test';
import { OWNER, PHONE_IP, TAILNET, send, socketDir, tmp } from './support/helpers.js';

const REPO = path.resolve(import.meta.dirname, '..');
const BASELINE = 'v1.6.1';
const hasBaseline = (() => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${BASELINE}`], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !hasBaseline && `needs the ${BASELINE} git tag`;

const CHANGED = new Set(['/', '/index.html', '/app.js']); // dashboard files changed on purpose since the baseline

// ---------- two servers, old and new, started the same way ----------

const at = '2026-10-01T10:00:00.000Z';
const todo = (id, extra) => ({
  id, title: `Task ${id}`, notes: '', status: 'todo', priority: 'medium', due: null, project: null, tags: [], assignee: 'me',
  subtasks: [], repeat: null, remindAt: null, remindedAt: null, rev: 1, createdBy: 'me', createdAt: at, updatedAt: at, completedAt: null,
  activity: [{ at, by: 'me', kind: 'event', text: 'created this task' }], ...extra,
});
const SEED = {
  version: 7,
  nextId: 6,
  updatedAt: at,
  todos: [
    todo(1, { project: 'work', subtasks: [{ id: 1, title: 'first', done: false }, { id: 2, title: 'second', done: true }] }),
    todo(2, { repeat: 'weekly', due: '2026-10-05', notes: 'A **note** with a [link](https://example.com)' }),
    todo(3, { status: 'in_progress', assignee: 'claude', tags: ['bug'], priority: 'high' }),
    todo(4, { status: 'done', completedAt: at }),
    todo(5, { status: 'blocked', due: '2020-01-01', project: 'home' }),
  ],
};

// Starts one tree's server in a process of its own, with remote-access state the
// way the desktop app sets it up. Prints what the test needs to talk to it.
const RUNNER = `
const [root, mode, tokenFile, socketPath] = process.argv.slice(2);
const { startServer } = await import(root + '/src/server.js');
const { createRemote } = await import(root + '/src/remote.js');
const remote = createRemote({ tokenFile, enabled: mode === 'on', requireOwner: true });
remote.hosts.add(${JSON.stringify(TAILNET)});
remote.ownerLogin = ${JSON.stringify(OWNER)};
remote.deviceName = async (ip) => (ip === ${JSON.stringify(PHONE_IP)} ? 'Test iPhone' : null);
const handoff = {
  info: () => ({ target: 'desktop', folders: { work: '~/code/work' } }),
  start: async () => ({ started: true, target: 'desktop', folder: '~/code/work' }),
};
const server = await startServer({ port: 0, handoff, remote, ...(socketPath ? { socketPath } : {}) });
console.log(JSON.stringify({ port: server.port, token: mode === 'on' ? remote.token : null, appCookie: remote.appCookie() }));
`;

const running = [];
let n = 0;
async function start(root, mode, { socket = false } = {}) {
  const id = ++n;
  const dataFile = path.join(tmp, `unchanged-${id}`, 'data', 'todos.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(SEED, null, 2));
  const runner = path.join(tmp, 'runner.mjs');
  fs.writeFileSync(runner, RUNNER);
  const args = [runner, root, mode, path.join(tmp, `unchanged-${id}`, 'token'), ...(socket ? [path.join(socketDir, `unchanged-${id}.sock`)] : [])];
  const child = spawn(process.execPath, args, { env: { ...process.env, TODO_DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  running.push(child);
  const [line] = await new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    lines.once('line', (l) => resolve([l]));
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  return { ...JSON.parse(line), dataFile, cookie: null };
}
after(() => running.forEach((child) => child.kill()));

let oldRoot;
before(() => {
  if (!hasBaseline) return;
  oldRoot = path.join(tmp, BASELINE);
  fs.mkdirSync(oldRoot);
  execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', BASELINE, 'src', 'public', 'package.json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }) });
});

// ---------- asking both the same things ----------

const isWrite = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const relay = { host: TAILNET, 'x-forwarded-host': TAILNET, 'x-forwarded-proto': 'https', 'x-forwarded-for': PHONE_IP, 'tailscale-user-login': OWNER, 'tailscale-user-name': 'Owner Name' };

// The headers each kind of caller sends to server `s`.
const CALLERS = {
  // Another device, through `tailscale serve`:
  tailnet: (s, method) => ({ ...relay, ...(isWrite(method) ? { origin: `https://${TAILNET}` } : {}) }),
  browser: (s, method) => ({ ...relay, cookie: s.cookie, ...(isWrite(method) ? { origin: `https://${TAILNET}` } : {}) }),
  phone: (s) => ({ ...relay, authorization: `Bearer ${s.token}` }), // the iPhone app: a token, labelled by its device name
  client: (s) => ({ ...relay, 'x-forwarded-for': '100.64.0.9', authorization: `Bearer ${s.token}`, 'x-todos-client': 'Test client' }),
  // On the Mac itself:
  local: (s, method) => ({ host: `127.0.0.1:${s.port}`, ...(isWrite(method) ? { origin: `http://127.0.0.1:${s.port}` } : {}) }),
  app: (s, method) => ({ host: `127.0.0.1:${s.port}`, cookie: `todos_session=${s.appCookie}`, ...(isWrite(method) ? { origin: `http://127.0.0.1:${s.port}` } : {}) }),
  script: (s) => ({ host: `127.0.0.1:${s.port}`, authorization: `Bearer ${s.token}` }),
};

const stamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normalize(value, s) {
  if (typeof value === 'string') {
    let out = value.replace(stamp, '<time>').split(s.dataFile).join('<data file>').split(`127.0.0.1:${s.port}`).join('<this mac>');
    if (s.token) out = out.split(s.token).join('<token>');
    return out.replace(/todos_session=[^;]+/g, 'todos_session=<cookie>');
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, s));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, s)]));
  return value;
}

// Everything observable about a response, minus Date and the exact Content-Length.
function observe(res, s, { bodyToo = true } = {}) {
  const headers = { ...res.headers };
  delete headers.date;
  if ('content-length' in headers) headers['content-length'] = '<n>';
  return normalize({ status: res.status, headers, body: bodyToo ? res.body : '<file>' }, s);
}

const json = (body, headers) => ({ body, headers });
const text = (body) => ({ body, headers: { 'content-type': 'text/plain' } });
const STATIC = ['/', '/index.html', '/app.js', '/boot.js', '/styles.css', '/markdown.js', '/capture.html', '/capture.js', '/capture.css',
  '/login', '/login.js', '/login.css', '/manifest.webmanifest', '/icons/icon-180.png'];

// Remote access on. In order: the same list for both servers. [who, method, path, options]
const ON = [
  // Before signing in.
  ['tailnet', 'GET', '/api/v1/health'],
  ['tailnet', 'GET', '/'],
  ['tailnet', 'GET', '/api/todos'],
  ['tailnet', 'GET', '/api/v1/tasks'],
  ['tailnet', 'GET', '/api/v1/meta'],
  ['local', 'GET', '/api/todos'],
  ['local', 'GET', '/api/v1/tasks'],
  ['tailnet', 'POST', '/api/todos', json({ title: 'not signed in' })],
  ['tailnet', 'POST', '/api/v1/session', json({ token: 'wrong' })],
  ['tailnet', 'GET', '/api/v1/tasks', { headers: { authorization: 'Bearer wrong' } }],
  ['tailnet', 'GET', '/api/todos', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } }],
  ['tailnet', 'GET', '/api/v1/health', { headers: { 'tailscale-user-login': 'someone-else@example.com' } }],
  ['tailnet', 'GET', '/api/v1/health', { headers: { 'tailscale-funnel-request': '?1' } }],
  ['local', 'GET', '/api/todos', { headers: { host: 'localhost:1' } }],

  // The API, as the iPhone app and other clients use it.
  ['phone', 'GET', '/api/v1/session'],
  ['phone', 'GET', '/api/v1/tasks'],
  ['phone', 'GET', '/api/v1/tasks?status=all'],
  ['phone', 'GET', '/api/v1/tasks?status=done,blocked&limit=1&offset=1'],
  ['phone', 'GET', '/api/v1/tasks?project=work&assignee=me&priority=medium'],
  ['phone', 'GET', '/api/v1/tasks?tag=bug&q=task'],
  ['phone', 'GET', '/api/v1/tasks?due=overdue'],
  ['phone', 'GET', '/api/v1/tasks?due=sometime'],
  ['phone', 'GET', '/api/v1/tasks/1'],
  ['phone', 'GET', '/api/v1/tasks/999'],
  ['phone', 'GET', '/api/v1/tasks/1/activity'],
  ['phone', 'GET', '/api/v1/due'],
  ['phone', 'GET', '/api/v1/summary'],
  ['phone', 'POST', '/api/v1/tasks', json({ title: 'From the phone', notes: 'n', priority: 'high', due: '2027-03-01', project: 'home', tags: ['a', '#b'], subtasks: ['one', 'two'], repeat: 'monthly' })],
  ['phone', 'POST', '/api/v1/tasks', json({ title: 'Sent twice' }, { 'idempotency-key': 'unchanged-0001' })],
  ['phone', 'POST', '/api/v1/tasks', json({ title: 'Sent twice' }, { 'idempotency-key': 'unchanged-0001' })],
  ['phone', 'POST', '/api/v1/tasks', json({ notes: 'no title' })],
  ['phone', 'POST', '/api/v1/tasks', json({ title: 'x', colour: 'red' })],
  ['phone', 'POST', '/api/v1/tasks', { body: '{broken', headers: { 'content-type': 'application/json' } }],
  ['phone', 'POST', '/api/v1/tasks', text('title=x')],
  ['phone', 'PATCH', '/api/v1/tasks/1', json({ priority: 'high' })],
  ['phone', 'PATCH', '/api/v1/tasks/1', json({ priority: 'high', notes: 'edited on the phone' }, { 'if-match': '"1"' })],
  ['phone', 'PATCH', '/api/v1/tasks/1', json({ priority: 'low' }, { 'if-match': '"1"' })],
  ['phone', 'PATCH', '/api/v1/tasks/1', json({ title: 'Renamed', due: '2027-01-15', remindAt: '2027-01-15 09:00', rev: 2 })],
  ['phone', 'PATCH', '/api/v1/tasks/1', json({ status: 'nonsense' }, { 'if-match': '*' })],
  ['phone', 'POST', '/api/v1/tasks/1/subtasks', json({ titles: ['third', 'fourth'] })],
  ['phone', 'PATCH', '/api/v1/tasks/1/subtasks/1', json({ done: true, title: 'first, renamed' })],
  ['phone', 'PATCH', '/api/v1/tasks/1/subtasks/9', json({ done: true })],
  ['phone', 'DELETE', '/api/v1/tasks/1/subtasks/2'],
  ['phone', 'POST', '/api/v1/tasks/1/comments', json({ text: 'A comment from the phone' })],
  ['phone', 'POST', '/api/v1/tasks/1/comments', json({ text: '   ' })],
  ['phone', 'GET', '/api/v1/tasks/1/activity?kind=comment'],
  // Only one task is ever completed per walk: done tasks are listed newest first, and
  // two completed within the same millisecond would have no fixed order.
  ['phone', 'POST', '/api/v1/tasks/2/complete', json({ comment: 'done for this week' })],
  ['phone', 'POST', '/api/v1/tasks/2/complete'],
  ['phone', 'POST', '/api/v1/tasks/999/complete'],
  ['phone', 'POST', '/api/v1/capture', json({ text: 'Renew passport 2027-02-01 !high #personal @errand' })],
  ['phone', 'POST', '/api/v1/capture', json({ text: 'Typed earlier tomorrow', at: '2026-06-01T12:00:00Z' })],
  ['phone', 'POST', '/api/v1/capture', text('Water the plants every day')],
  ['phone', 'POST', '/api/v1/capture', json({ text: '!high #only @markers' })],
  ['phone', 'POST', '/api/v1/capture/preview', json({ text: 'Call the dentist 2027-04-02 15:00 !low' })],
  ['phone', 'DELETE', '/api/v1/tasks/4'],
  ['phone', 'DELETE', '/api/v1/tasks/4', { headers: { 'if-match': '"1"' } }],
  ['phone', 'DELETE', '/api/v1/tasks/4', { headers: { 'if-match': '*' } }],
  ['client', 'POST', '/api/v1/tasks/5/comments', json({ text: 'From a named client' })],
  ['script', 'POST', '/api/v1/tasks/5/comments', json({ text: 'From a script on the Mac' })],
  ['phone', 'GET', '/api/v1/nope'],
  ['phone', 'PUT', '/api/v1/tasks', json({})],
  ['phone', 'PUT', '/api/v1/session', json({})],
  ['phone', 'POST', '/api/v1/tasks/1/handoff', json({})],
  ['phone', 'POST', '/api/todos/1/handoff', json({})],
  ['phone', 'GET', '/api/v1/meta'],

  // A browser on another device: sign in, then the dashboard's own routes.
  ['tailnet', 'POST', '/api/v1/session', 'sign in'],
  ['browser', 'GET', '/api/v1/session'],
  ['browser', 'GET', '/login'],
  ['browser', 'GET', '/api/health'],
  ['browser', 'GET', '/api/todos'],
  ['browser', 'POST', '/api/parse', json({ text: 'Renew passport 2027-02-01 !high #personal @errand' })],
  ['browser', 'POST', '/api/todos', json({ title: 'From a browser', subtasks: ['a'], comment: 'first!' })],
  ['browser', 'POST', '/api/todos', json({ quick: 'Quick one 2027-05-05 !low #home', priority: 'high' })],
  ['browser', 'POST', '/api/todos', json({ title: '   ' })],
  ['browser', 'PATCH', '/api/todos/5', json({ status: 'in_progress', comment: 'picking this up' })],
  ['browser', 'PATCH', '/api/todos/5', json({ priority: 'low', rev: 1 })],
  ['browser', 'PATCH', '/api/todos/5', json({ add_subtasks: ['x', 'y'], check_subtasks: [1] })],
  ['browser', 'PATCH', '/api/todos/999', json({ title: 'nobody' })],
  ['browser', 'POST', '/api/todos/5/handoff', json({})],
  ['browser', 'POST', '/api/todos', { body: { title: 'cross-site' }, headers: { origin: 'https://evil.example' } }],
  ['browser', 'DELETE', '/api/todos/5?rev=1'],
  ['browser', 'DELETE', '/api/todos/5'],
  ['browser', 'GET', '/api/nope'],
  ['browser', 'DELETE', '/api/v1/session'],

  // The Mac app's own windows.
  ['app', 'GET', '/api/health'],
  ['app', 'GET', '/api/todos'],
  ['app', 'POST', '/api/todos', json({ title: 'From the app' })],
  ['app', 'PATCH', '/api/todos/1', json({ comment: 'from the app' })],
  ['app', 'POST', '/api/todos/1/handoff', json({})],
  ['app', 'GET', '/api/v1/session'],
  ['tailnet', 'GET', '/api/todos', 'app cookie through the relay'],
];

// Remote access off: the dashboard on the Mac, and nothing for anyone else.
const OFF = [
  ['local', 'GET', '/api/health'],
  ['local', 'GET', '/api/todos'],
  ['local', 'POST', '/api/parse', json({ text: 'Renew passport 2027-02-01 !high #personal @errand' })],
  ['local', 'POST', '/api/todos', json({ title: 'Plain new task' })],
  ['local', 'POST', '/api/todos', json({ quick: 'Call dentist 2027-04-02 15:00 @health every month', priority: 'low' })],
  ['local', 'POST', '/api/todos', json({})],
  ['local', 'PATCH', '/api/todos/1', json({ priority: 'high', comment: 'looking at this' })],
  ['local', 'PATCH', '/api/todos/1', json({ add_subtasks: ['third'], check_subtasks: [1], rev: 2 })],
  ['local', 'PATCH', '/api/todos/1', json({ title: 'stale', rev: 1 })],
  ['local', 'PATCH', '/api/todos/2', json({ status: 'done', comment: 'done for this week' })],
  ['local', 'POST', '/api/todos/1/handoff', json({})],
  ['local', 'DELETE', '/api/todos/4'],
  ['local', 'DELETE', '/api/todos/4'],
  ['local', 'GET', '/api/nope'],
  ['local', 'GET', '/api/v1/health'],
  ['local', 'GET', '/api/v1/tasks'],
  ['local', 'GET', '/api/v1/meta'],
  ['local', 'POST', '/api/v1/session', json({ token: 'anything' })],
  ['local', 'PUT', '/api/todos', json({})],
  ['local', 'POST', '/', json({})],
  ['local', 'GET', '/nope.txt'],
  ['local', 'GET', '/../src/store.js'],
  ['local', 'GET', '/api/todos', { headers: { host: 'evil.example' } }],
  ['tailnet', 'GET', '/api/todos'],
  ['tailnet', 'GET', '/api/v1/health'],
  ['local', 'GET', '/api/todos', { headers: { 'x-forwarded-for': PHONE_IP } }],
  ['local', 'GET', '/api/todos'],
];

async function walk(s, requests, pagesAs) {
  const out = [];
  for (const [who, method, pathname, options = {}] of requests) {
    let opts = options;
    // Two steps need something only this server has: its own token, and its app's cookie.
    if (options === 'sign in') opts = json({ token: s.token });
    if (options === 'app cookie through the relay') opts = { headers: { cookie: `todos_session=${s.appCookie}` } };
    const res = await send(s.port, method, pathname, { body: opts.body, headers: { ...CALLERS[who](s, method), ...opts.headers } });
    if (options === 'sign in') s.cookie = String(res.headers['set-cookie']?.[0]).split(';')[0];
    out.push([`${who}: ${method} ${pathname}`, observe(res, s)]);
  }
  for (const pathname of STATIC) {
    const res = await send(s.port, 'GET', pathname, { headers: CALLERS[pagesAs](s, 'GET') });
    out.push([`${pagesAs}: GET ${pathname}`, observe(res, s, { bodyToo: !CHANGED.has(pathname) })]);
  }
  out.push(['the data file afterwards', normalize(JSON.parse(fs.readFileSync(s.dataFile, 'utf8')), s)]);
  return out;
}

function same(actual, expected, differences = {}) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const [label, now] = actual[i];
    const [, was] = expected[i];
    if (differences[label]) differences[label](now, was);
    else assert.deepEqual(now, was, `difference at: ${label}`);
  }
}

// The first thing a live-update connection says. The version in it is the last one
// the server's file watcher has reported, which trails the file by a moment, so
// only its presence is compared.
function firstEvent(s, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'GET', path: pathname, headers, setHost: false, agent: false }, (res) => {
      const head = { ...res.headers };
      delete head.date;
      res.setEncoding('utf8');
      res.once('data', (chunk) => {
        req.destroy();
        resolve({ status: res.statusCode, headers: head, first: chunk.replace(/"version":\d+/, '"version":<n>') });
      });
      if (res.statusCode !== 200) resolve({ status: res.statusCode, headers: head, first: null });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- the comparisons ----------

test('with remote access on, the API, the dashboard and every refusal are what 1.6.1 answered', { skip }, async () => {
  const was = await start(oldRoot, 'on');
  const now = await start(REPO, 'on', { socket: true });
  const expected = await walk(was, ON, 'browser');
  const actual = await walk(now, ON, 'browser');
  same(actual, expected, {
    // The API's revision went from 3 to 7.
    'phone: GET /api/v1/meta': (after, earlier) => {
      assert.equal(earlier.body.api.revision, 3);
      assert.equal(after.body.api.revision, 7);
      assert.equal(earlier.body.app.version, '1.6.1');
      assert.equal(after.body.app.version, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
      assert.deepEqual({ ...after, body: { api: { ...after.body.api, revision: 3 }, app: { ...after.body.app, version: '1.6.1' } } }, earlier);
    },
    // Refused the same way; only the message has more to list.
    'phone: GET /api/v1/tasks?due=sometime': (after, earlier) => {
      for (const form of ['overdue', 'today', 'week', 'none', 'any', 'YYYY-MM-DD', 'tomorrow', 'before:', 'after:']) assert.ok(after.body.error.message.includes(form), form);
      assert.deepEqual({ ...after, body: { error: { ...after.body.error, message: earlier.body.error.message } } }, earlier);
    },
  });
  // Enough was exercised for this to mean something.
  const statuses = new Set(expected.filter(([, o]) => o.status).map(([, o]) => o.status));
  for (const status of [200, 201, 204, 302, 400, 401, 403, 404, 405, 409, 415, 428]) assert.ok(statuses.has(status), `the walk saw a ${status}`);

  // Live updates start the same way, for the iPhone app's kind of client and for a browser.
  for (const [pathname, who] of [['/api/v1/events', 'phone'], ['/api/events', 'browser'], ['/api/v1/events', 'tailnet']]) {
    assert.deepEqual(await firstEvent(now, pathname, CALLERS[who](now, 'GET')), await firstEvent(was, pathname, CALLERS[who](was, 'GET')), `${who}: ${pathname}`);
  }
});

test('with remote access off, the dashboard and every refusal are what 1.6.1 answered', { skip }, async () => {
  const was = await start(oldRoot, 'off');
  const now = await start(REPO, 'off', { socket: true });
  same(await walk(now, OFF, 'local'), await walk(was, OFF, 'local'));
  assert.deepEqual(await firstEvent(now, '/api/events', CALLERS.local(now, 'GET')), await firstEvent(was, '/api/events', CALLERS.local(was, 'GET')));
  for (const s of [was, now]) assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(s.dataFile)), 'token')), false, 'and no access token was ever created');
});

// ---------- the MCP server ----------

// Runs one tree's MCP server through a conversation and returns its answers by request id.
async function converse(root, messages) {
  const dataFile = path.join(tmp, `unchanged-mcp-${++n}`, 'data', 'todos.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(SEED, null, 2));
  const cwd = path.join(tmp, 'my-repo');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'src', 'mcp.js')], { cwd, env: { ...process.env, TODO_DATA_FILE: dataFile }, stdio: ['pipe', 'pipe', 'inherit'] });
  running.push(child);
  const answers = [];
  const lines = readline.createInterface({ input: child.stdout });
  const expected = messages.filter((m) => 'id' in m).length;
  const done = new Promise((resolve) => {
    lines.on('line', (line) => {
      answers.push(JSON.parse(line));
      if (answers.length === expected) resolve();
    });
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  await done;
  child.kill();
  const localStamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g; // "2026-10-12 21:48", in activity lines
  const clean = (v) => JSON.parse(JSON.stringify(v).replace(stamp, '<time>').replace(localStamp, '<stamp>').split(dataFile).join('<data file>'));
  return { answers: clean(answers), data: clean(JSON.parse(fs.readFileSync(dataFile, 'utf8'))) };
}

test('the MCP server says and does what 1.6.1\'s did', { skip }, async () => {
  let id = 0;
  const call = (name, args) => ({ id: ++id, method: 'tools/call', params: { name, arguments: args } });
  const messages = [
    { id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } } },
    { method: 'notifications/initialized' },
    { id: ++id, method: 'tools/list' },
    call('todo_list', {}),
    call('todo_list', { status: 'all', project: 'work' }),
    call('todo_get', { id: 1 }),
    call('todo_add', { title: 'Added by Claude', notes: 'with notes', priority: 'high', due: '2027-02-03', project: 'work', tags: ['x'], subtasks: ['one', 'two'], repeat: 'weekly', remind_at: '2027-02-03 09:00' }),
    call('todo_update', { id: 1, status: 'in_progress', assignee: 'claude', comment: 'Starting on this', check_subtasks: [1], add_subtasks: ['a third'] }),
    call('todo_update', { id: 999, status: 'done' }),
    call('todo_update', { id: 1, priority: 'urgent' }),
    call('todo_complete', { ids: [2], comment: 'Finished for this week' }), // one only: see the note in ON
    call('todo_delete', { id: 4 }),
    call('todo_list', { status: 'all' }),
    call('no_such_tool', {}),
    { id: ++id, method: 'no/such/method' },
  ];
  const was = await converse(oldRoot, messages);
  const now = await converse(REPO, messages);
  assert.equal(now.answers.length, was.answers.length);
  // The intended differences: what it says about itself, and the tools it lists.
  const differences = {
    1: (after, earlier) => {
      assert.ok(after.result.instructions.startsWith(`${earlier.result.instructions}\n- The user also tracks habits here`), 'the instructions it had, then one more paragraph');
      assert.deepEqual({ ...after, result: { ...after.result, instructions: earlier.result.instructions } }, earlier);
    },
    2: (after, earlier) => {
      const had = earlier.result.tools.length;
      const [listNow, ...othersNow] = after.result.tools.slice(0, had);
      const [listWas, ...othersWas] = earlier.result.tools;
      assert.deepEqual(othersNow, othersWas, 'every other tool it had, described as before');
      // todo_list: what it said, and more; every argument it took, taking what it took.
      assert.equal(listNow.name, 'todo_list');
      assert.ok(listNow.description.startsWith(listWas.description));
      for (const [name, was] of Object.entries(listWas.inputSchema.properties)) {
        const now = listNow.inputSchema.properties[name];
        assert.ok(now && [].concat(now.type).includes(was.type), `todo_list still takes ${name} as a ${was.type}`);
        if (was.enum) assert.deepEqual(now.enum, was.enum, name);
      }
      assert.deepEqual({ ...listNow, description: listWas.description, inputSchema: listWas.inputSchema }, listWas);
      // After them, todo_today, then only habit tools.
      assert.equal(after.result.tools[had].name, 'todo_today');
      assert.ok(after.result.tools.length > had + 1 && after.result.tools.slice(had + 1).every((t) => t.name.startsWith('habit_')), 'and after it, only habit tools');
    },
  };
  for (let i = 0; i < was.answers.length; i++) {
    const { id } = was.answers[i];
    if (differences[id]) differences[id](now.answers[i], was.answers[i]);
    else assert.deepEqual(now.answers[i], was.answers[i], `answer to request ${id}`);
  }
  assert.deepEqual(now.data, was.data, 'and the list ends up the same');
  assert.ok(was.answers.some((a) => a.result?.isError) && was.answers.some((a) => a.error), 'failures were exercised too');
});
