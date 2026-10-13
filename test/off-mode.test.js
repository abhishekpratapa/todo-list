// Remote access off: the server must answer exactly as 1.3.0 did. This runs the
// real 1.3.0 server (from the v1.3.0 git tag) next to the current one, sends both
// the same requests from the same starting data, and compares the answers.
//
// Known, intended differences:
//   - todos carry a new `rev` field (ignored in the comparison);
//   - a request relayed by a proxy is refused (tested separately below);
//   - GET /health, which was a 404 like any unknown page, is the health check
//     (tested in socket.test.js).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot, send, tmp } from './support/helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasBaseline = (() => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v1.3.0'], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Starting data in the 1.3.0 format: no `rev` anywhere.
const at = '2026-10-01T10:00:00.000Z';
const todo = (id, extra) => ({
  id, title: `Task ${id}`, notes: '', status: 'todo', priority: 'medium', due: null, project: null, tags: [], assignee: 'me',
  subtasks: [], repeat: null, remindAt: null, remindedAt: null, createdBy: 'me', createdAt: at, updatedAt: at, completedAt: null,
  activity: [{ at, by: 'me', kind: 'event', text: 'created this task' }], ...extra,
});
const SEED = {
  version: 7,
  nextId: 5,
  updatedAt: at,
  todos: [
    todo(1, { project: 'work', subtasks: [{ id: 1, title: 'first', done: false }] }),
    todo(2, { repeat: 'weekly', due: '2026-10-05', notes: 'A **note** with a [link](https://example.com)' }),
    todo(3, { status: 'in_progress', assignee: 'claude', tags: ['bug'] }),
    todo(4, { status: 'done', completedAt: at }),
  ],
};
const seed = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(SEED, null, 2));
};

// The same requests, in order, for every server. `host` is filled in per server.
const json = (body) => ({ body });
const REQUESTS = [
  ['GET', '/api/health'],
  ['GET', '/api/todos'],
  ['POST', '/api/parse', json({ text: 'Renew passport fri !high #personal @errand' })],
  ['POST', '/api/parse', json({})],
  ['POST', '/api/todos', json({ title: 'Plain new task' })],
  ['POST', '/api/todos', json({ quick: 'Call dentist tomorrow 3pm @health every month', priority: 'low' })],
  ['POST', '/api/todos', json({ title: 'With everything', notes: 'n', priority: 'high', due: '2026-12-01', project: 'home', tags: ['a', '#b'], subtasks: ['one', 'two'], repeat: 'daily', comment: 'first!' })],
  ['POST', '/api/todos', json({})],
  ['POST', '/api/todos', json({ title: '   ' })],
  ['POST', '/api/todos', json({ title: 'x', due: 'someday maybe' })],
  ['POST', '/api/todos', { body: 'title=x', headers: { 'content-type': 'text/plain' } }],
  ['POST', '/api/todos', { body: '{broken', headers: { 'content-type': 'application/json' } }],
  ['PATCH', '/api/todos/1', json({ priority: 'high', comment: 'looking at this' })],
  ['PATCH', '/api/todos/1', json({ add_subtasks: ['second', 'third'], check_subtasks: [1] })],
  ['PATCH', '/api/todos/1', json({ rename_subtask: { id: 2, title: 'renamed' }, remove_subtasks: [3] })],
  ['PATCH', '/api/todos/1', json({ title: 'Renamed task', notes: 'new notes', due: 'tomorrow', project: null, tags: ['x'], assignee: 'claude', remindAt: '2027-01-01T09:00' })],
  ['PATCH', '/api/todos/1', json({ priority: 'high' })],
  ['PATCH', '/api/todos/2', json({ status: 'done', comment: 'done for this week' })],
  ['PATCH', '/api/todos/3', json({ status: 'blocked' })],
  ['PATCH', '/api/todos/1', json({ priority: 'urgent' })],
  ['PATCH', '/api/todos/1', json({ check_subtasks: [99] })],
  ['PATCH', '/api/todos/999', json({ title: 'nobody' })],
  ['PATCH', '/api/todos/abc', json({ title: 'nobody' })],
  ['DELETE', '/api/todos/4'],
  ['DELETE', '/api/todos/4'],
  ['POST', '/api/todos/1/handoff', json({})],
  ['GET', '/api/nope'],
  ['GET', '/api/v1/health'],
  ['GET', '/api/v1/tasks'],
  ['POST', '/api/v1/session', json({ token: 'anything' })],
  ['PUT', '/api/todos', json({})],
  ['POST', '/', json({})],
  ['HEAD', '/'],
  ['OPTIONS', '/api/todos'],
  ['GET', '/login'],
  ['GET', '/nope.txt'],
  ['GET', '/../src/store.js'],
  ['GET', '/%2e%2e/package.json'],
  ['GET', '/api/todos', { headers: { host: 'evil.example' } }],
  ['GET', '/api/todos', { headers: { host: 'localhost:1' } }],
  ['GET', '/api/todos', { headers: { cookie: 'todos_session=whatever', authorization: 'Bearer whatever' } }],
  ['GET', '/api/todos'],
];
// Files whose content legitimately changed between versions: compare status and headers only.
const STATIC = ['/', '/index.html', '/app.js', '/styles.css', '/markdown.js', '/capture.html', '/capture.js', '/capture.css'];

const stamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normalize(value, dataFile) {
  if (typeof value === 'string') return value.replace(stamp, '<time>').split(dataFile).join('<data file>');
  if (Array.isArray(value)) return value.map((v) => normalize(v, dataFile));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'rev').map(([k, v]) => [k, normalize(v, dataFile)]));
  }
  return value;
}

// Everything observable about a response, minus Date and the exact Content-Length.
function observe(res, dataFile, { bodyToo = true } = {}) {
  const headers = { ...res.headers };
  delete headers.date;
  if ('content-length' in headers) headers['content-length'] = '<n>';
  return { status: res.status, headers, body: bodyToo ? normalize(res.body, dataFile) : '<file>' };
}

async function exercise(port, dataFile) {
  const host = `127.0.0.1:${port}`;
  const out = [];
  for (const [method, pathname, opts = {}] of REQUESTS) {
    const res = await send(port, method, pathname, { ...opts, headers: { host, ...opts.headers } });
    out.push([`${method} ${pathname}`, observe(res, dataFile)]);
  }
  for (const pathname of STATIC) {
    out.push([`GET ${pathname}`, observe(await send(port, 'GET', pathname, { headers: { host } }), dataFile, { bodyToo: false })]);
  }
  out.push(['final data', normalize(JSON.parse(fs.readFileSync(dataFile, 'utf8')), dataFile)]);
  return out;
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let baseline;
let expected;

before(async () => {
  if (!hasBaseline) return;
  // Check out the 1.3.0 sources into a scratch folder and run its server as it was.
  const dir = path.join(tmp, 'v1.3.0');
  fs.mkdirSync(dir);
  const archive = execFileSync('git', ['archive', 'v1.3.0', 'src', 'public', 'package.json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const dataFile = path.join(tmp, 'v1.3.0-data', 'todos.json');
  seed(dataFile);
  const port = await freePort();
  baseline = spawn(process.execPath, [path.join(dir, 'src', 'server.js')], { env: { ...process.env, TODO_PORT: String(port), TODO_DATA_FILE: dataFile }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await send(port, 'GET', '/api/health', { headers: { host: `127.0.0.1:${port}` } });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expected = await exercise(port, dataFile);
});
after(() => baseline?.kill());

for (const [name, options] of [['no remote-access state at all (npm start)', { remote: false }], ['remote access present but switched off (the app)', { enabled: false }]]) {
  test(`identical to 1.3.0 with ${name}`, { skip: !hasBaseline && 'needs the v1.3.0 git tag' }, async () => {
    seed(process.env.TODO_DATA_FILE);
    const s = await boot(options);
    try {
      const actual = await exercise(s.port, process.env.TODO_DATA_FILE);
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < expected.length; i++) assert.deepEqual(actual[i], expected[i], `difference at: ${expected[i][0]}`);
    } finally {
      s.close();
    }
  });
}

test('the live-update stream opens the same way as in 1.3.0', { skip: !hasBaseline && 'needs the v1.3.0 git tag' }, async () => {
  seed(process.env.TODO_DATA_FILE);
  const s = await boot({ enabled: false });
  const live = await s.stream(s.local, '/api/events');
  assert.equal(live.status, 200);
  assert.ok(await live.sawEvent('hello'));
  live.close();
  s.close();
});

test('the one intended difference: nothing relayed by a proxy is answered while off', async () => {
  seed(process.env.TODO_DATA_FILE);
  const s = await boot({ enabled: false });
  try {
    for (const headers of [{}, { cookie: `todos_session=${s.remote.appCookie()}` }, { authorization: `Bearer ${s.remote.token}` }]) {
      const res = await s.tailnet('GET', '/api/todos', { headers });
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, { error: 'Forbidden host' });
    }
    // Even when the proxy presents a local-looking Host.
    const sneaky = await s.local('GET', '/api/todos', { headers: { 'x-forwarded-for': '100.64.0.2' } });
    assert.equal(sneaky.status, 403);
    assert.equal((await s.local('GET', '/api/todos')).status, 200);
  } finally {
    s.close();
  }
});

test('switched off, the 1 MB body limit still applies', async () => {
  seed(process.env.TODO_DATA_FILE);
  const s = await boot({ enabled: false });
  try {
    // The server stops reading partway through, so the client sees either the 400 or a dropped connection.
    const outcome = await s.local('POST', '/api/todos', { body: JSON.stringify({ title: 'x'.repeat(1_100_000) }), headers: { 'content-type': 'application/json' } })
      .then((res) => res.status, (e) => e.code);
    assert.ok(outcome === 400 || outcome === 'ECONNRESET' || outcome === 'EPIPE', String(outcome));
    assert.equal((await s.local('POST', '/api/todos', { body: { title: 'x'.repeat(400_000) } })).status, 201, 'well under 1 MB is fine, as before');
    assert.equal((await s.local('GET', '/api/todos')).body.todos.length, SEED.todos.length + 1);
  } finally {
    s.close();
  }
});

test('switched off, no token file is ever created', async () => {
  const s = await boot({ enabled: false });
  await s.local('GET', '/api/todos');
  await s.local('POST', '/api/todos', { body: { title: 'x' } });
  s.close();
  assert.equal(fs.existsSync(s.tokenFile), false);
});
