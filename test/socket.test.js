// The local socket: who can open it, what it serves, and that it needs no token
// whether remote access is on or off. Also the health check, which is the one
// thing the socket and the port both answer without any sign-in.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { OWNER, boot, send, socketDir, store } from './support/helpers.js';

const { SOCKET_PATH_MAX, socketPath } = await import('../src/socket.js');
const { API_REVISION, MIN_CLIENT_VERSIONS } = await import('../src/api-v1.js');
const REPO = path.resolve(import.meta.dirname, '..');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const HEALTH = { status: 'ok', appVersion: APP_VERSION, apiVersion: { version: 1, revision: API_REVISION } };

const mode = (file) => fs.statSync(file).mode & 0o777;
let n = 0;
const somewhere = (name = `own-${++n}.sock`) => path.join(socketDir, name);

let on; // remote access on
let off; // remote access off
before(async () => {
  on = await boot({ socket: true });
  off = await boot({ socket: true, enabled: false });
});
after(() => {
  on.close();
  off.close();
});

// ---------- where it is, and who can open it ----------

test('the path: TODOS_SOCKET, else next to the app\'s data, else a shorter place for a long home folder', () => {
  const home = '/Users/someone';
  assert.equal(socketPath({ env: {}, home, platform: 'darwin' }), '/Users/someone/Library/Application Support/Todos/todos.sock');
  assert.equal(socketPath({ env: { TODOS_SOCKET: '/tmp/mine.sock' }, home, platform: 'darwin' }), '/tmp/mine.sock');
  assert.equal(socketPath({ env: {}, home, platform: 'linux' }), '/Users/someone/.todos/todos.sock');

  // The usual place is 45 bytes longer than the home folder, so it stops fitting at 59.
  const fitsExactly = `/Users/${'x'.repeat(51)}`;
  assert.equal(Buffer.byteLength(socketPath({ env: {}, home: fitsExactly, platform: 'darwin' })), SOCKET_PATH_MAX);
  const tooLongForUsual = `/Users/${'x'.repeat(52)}`;
  assert.equal(socketPath({ env: {}, home: tooLongForUsual, platform: 'darwin' }), `${tooLongForUsual}/.todos/todos.sock`);
  // Bytes are what count, not characters.
  assert.equal(socketPath({ env: {}, home: `/Users/${'é'.repeat(26)}`, platform: 'darwin' }), `/Users/${'é'.repeat(26)}/.todos/todos.sock`);

  // Nothing fits: no socket, rather than one at a path that was quietly cut short.
  assert.equal(socketPath({ env: {}, home: `/Users/${'x'.repeat(90)}`, platform: 'darwin' }), null);
  assert.equal(socketPath({ env: { TODOS_SOCKET: `/tmp/${'x'.repeat(120)}` }, home, platform: 'darwin' }), null);
});

test('the socket is created for the owner only, and removed when the server stops', async () => {
  const s = await boot({ socket: true });
  assert.equal(s.server.socket, s.socketPath);
  assert.equal(s.server.socketProblem, null);
  assert.equal(fs.lstatSync(s.socketPath).isSocket(), true);
  assert.equal(mode(s.socketPath), 0o600);
  assert.equal(fs.statSync(s.socketPath).uid, process.getuid());
  assert.equal((await s.sock('GET', '/health')).status, 200);
  s.close();
  assert.equal(fs.existsSync(s.socketPath), false, 'removed on a clean stop');
});

test('a socket left behind by a copy that died is replaced on startup', async () => {
  const stale = somewhere();
  // A process that opens the socket and is killed before it can clean up.
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.equal(fs.lstatSync(stale).isSocket(), true, 'the dead process left its socket file');
  await assert.rejects(send(stale, 'GET', '/health'), { code: 'ECONNREFUSED' });

  const s = await boot({ socket: stale });
  try {
    assert.equal(s.server.socket, stale);
    assert.equal(mode(stale), 0o600);
    assert.deepEqual((await s.sock('GET', '/health')).body, HEALTH);
  } finally {
    s.close();
  }
});

test('a socket that is still answering is left to the copy that owns it', async () => {
  const first = await boot({ socket: true });
  const second = await boot({ socket: first.socketPath });
  try {
    assert.equal(second.server.socket, null);
    assert.equal(second.server.socketProblem.code, 'in_use');
    assert.equal((await second.local('GET', '/api/v1/health', { headers: second.bearer() })).status, 200, 'the second copy still serves its port');
    const { task } = (await first.sock('POST', '/api/v1/tasks', { body: { title: 'still the first copy' } })).body;
    assert.equal(task.title, 'still the first copy');
  } finally {
    second.close();
  }
  assert.equal(fs.lstatSync(first.socketPath).isSocket(), true, 'stopping the second copy did not remove the first one\'s socket');
  assert.equal((await first.sock('GET', '/health')).status, 200);
  first.close();
});

test('nothing else at that path is ever removed, and an unsafe place is refused', async () => {
  const file = somewhere('a-file.sock');
  fs.writeFileSync(file, 'not a socket');
  const inTheWay = await boot({ socket: file });
  assert.equal(inTheWay.server.socket, null);
  assert.equal(inTheWay.server.socketProblem.code, 'in_the_way');
  inTheWay.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a socket');

  // A folder other users can write to: they could swap the socket for their own.
  const shared = path.join(socketDir, 'shared');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  const unsafe = await boot({ socket: path.join(shared, 's.sock') });
  assert.equal(unsafe.server.socketProblem.code, 'unsafe_folder');
  assert.equal(fs.readdirSync(shared).length, 0, 'nothing was created there');
  unsafe.close();

  // Too long: refused outright, not opened at a shortened name.
  const long = path.join(socketDir, 'x'.repeat(SOCKET_PATH_MAX + 1 - Buffer.byteLength(socketDir) - 1));
  assert.equal(Buffer.byteLength(long), SOCKET_PATH_MAX + 1);
  const before = fs.readdirSync(socketDir).length;
  const tooLong = await boot({ socket: long });
  assert.equal(tooLong.server.socketProblem.code, 'too_long');
  assert.equal(fs.readdirSync(socketDir).length, before, 'no socket file under any name');
  assert.equal((await tooLong.local('GET', '/health')).status, 200, 'the server itself still runs');
  tooLong.close();

  // A path of exactly the limit works.
  const exact = path.join(socketDir, 'y'.repeat(SOCKET_PATH_MAX - Buffer.byteLength(socketDir) - 1));
  const fits = await boot({ socket: exact });
  assert.equal(fits.server.socket, exact);
  assert.equal((await fits.sock('GET', '/health')).status, 200);
  fits.close();
});

test('without a socket path, no socket is opened', async () => {
  const s = await boot();
  assert.equal(s.server.socket, null);
  assert.equal(s.server.socketProblem, null);
  s.close();
});

// ---------- what it serves ----------

for (const [name, get] of [['on', () => on], ['off', () => off]]) {
  test(`the socket serves the API without a token, with remote access ${name}`, async () => {
    const s = get();
    const created = await s.sock('POST', '/api/v1/tasks', { body: { title: `From the command line (${name})`, project: 'cli', subtasks: ['one'] } });
    assert.equal(created.status, 201);
    const { id } = created.body.task;
    assert.equal(created.headers.location, `/api/v1/tasks/${id}`);

    const read = await s.sock('GET', `/api/v1/tasks/${id}`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.etag, '"1"');

    assert.equal((await s.sock('PATCH', `/api/v1/tasks/${id}`, { body: { priority: 'high' } })).status, 428, 'the same conflict rules as everywhere');
    assert.equal((await s.sock('PATCH', `/api/v1/tasks/${id}`, { body: { priority: 'high' }, headers: { 'if-match': '"1"' } })).status, 200);
    assert.equal((await s.sock('PATCH', `/api/v1/tasks/${id}`, { body: { priority: 'low' }, headers: { 'if-match': '"1"' } })).status, 409);
    assert.equal((await s.sock('POST', `/api/v1/tasks/${id}/comments`, { body: { text: 'a note' } })).status, 201);
    assert.equal((await s.sock('PATCH', `/api/v1/tasks/${id}/subtasks/1`, { body: { done: true } })).status, 200);
    assert.equal((await s.sock('POST', '/api/v1/capture', { body: 'Captured from a terminal tomorrow !high', headers: { 'content-type': 'text/plain' } })).status, 201);
    assert.equal((await s.sock('POST', `/api/v1/tasks/${id}/complete`)).body.task.status, 'done');

    const list = await s.sock('GET', '/api/v1/tasks?status=all&project=cli');
    assert.deepEqual(list.body.tasks.map((t) => t.id), [id]);
    for (const p of ['/api/v1/due', '/api/v1/summary', '/api/v1/meta', `/api/v1/tasks/${id}/activity`, '/api/v1/capture/preview']) {
      const res = await s.sock(p.endsWith('preview') ? 'POST' : 'GET', p, p.endsWith('preview') ? { body: { text: 'x fri' } } : {});
      assert.equal(res.status, 200, p);
    }
    assert.equal((await s.sock('DELETE', `/api/v1/tasks/${id}`, { headers: { 'if-match': '*' } })).status, 204);
    assert.equal((await s.sock('GET', `/api/v1/tasks/${id}`)).status, 404);
  });
}

test('it is the same API as the one other devices get: the same answers to the same questions', async () => {
  store.createTodo({ title: 'Seen from both sides', due: 'tomorrow', tags: ['x'], subtasks: ['a', 'b'] }, 'me');
  const device = { ...on.bearer(), origin: undefined };
  for (const p of ['/tasks', '/tasks?status=all&q=both', '/due', '/summary', '/meta', '/info', '/health', '/tasks/999999', '/nope']) {
    const viaSocket = await on.sock('GET', `/api/v1${p}`);
    const viaTailnet = await on.tailnet('GET', `/api/v1${p}`, { headers: device });
    assert.equal(viaSocket.status, viaTailnet.status, p);
    assert.deepEqual(viaSocket.body, viaTailnet.body, p);
  }
});

test('on the port nothing has changed: the API still needs the token, and does not exist while remote access is off', async () => {
  assert.equal((await on.local('GET', '/api/v1/tasks')).status, 401);
  assert.equal((await on.tailnet('GET', '/api/v1/tasks')).status, 401);
  assert.equal((await on.local('GET', '/api/v1/tasks', { headers: on.bearer() })).status, 200);
  const whileOff = await off.local('GET', '/api/v1/tasks');
  assert.equal(whileOff.status, 404);
  assert.deepEqual(whileOff.body, { error: 'Not found' });
});

test('the socket serves the health check and the API, and nothing else', async () => {
  for (const s of [on, off]) {
    for (const [method, p] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/app.js'], ['GET', '/login'], ['GET', '/api/health'], ['GET', '/api/todos'], ['GET', '/api/events'],
      ['POST', '/api/todos'], ['POST', '/api/parse'], ['POST', '/api/todos/1/handoff'], ['PATCH', '/api/todos/1'], ['DELETE', '/api/todos/1'], ['GET', '/api/v1'], ['POST', '/health']]) {
      const res = await s.sock(method, p, method === 'GET' || method === 'DELETE' ? {} : { body: { title: 'x', text: 'x' } });
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.deepEqual(res.body, { error: { code: 'not_found', message: 'No such endpoint.' } }, `${method} ${p}`);
    }
  }
});

test('there is no signing in on the socket: the session says "local"', async () => {
  for (const s of [on, off]) {
    assert.deepEqual((await s.sock('GET', '/api/v1/session')).body, { kind: 'local' });
    const signIn = await s.sock('POST', '/api/v1/session', { body: { token: 'anything' } });
    assert.equal(signIn.status, 404);
    assert.equal(signIn.headers['set-cookie'], undefined);
    assert.equal((await s.sock('DELETE', '/api/v1/session')).status, 404);
    // Credentials are not looked at: a wrong token changes nothing, and is not counted against anyone.
    for (let i = 0; i < 12; i++) assert.equal((await s.sock('GET', '/api/v1/tasks', { headers: { authorization: 'Bearer wrong' } })).status, 200);
  }
  // On the port, signing in and out are still there.
  const cookie = await on.signIn();
  assert.equal((await on.tailnet('DELETE', '/api/v1/session', { headers: { cookie } })).status, 200);
});

test('nothing relayed by a proxy is answered on the socket', async () => {
  for (const s of [on, off]) {
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-funnel-request']) {
      for (const p of ['/health', '/api/v1/tasks', '/api/v1/info']) {
        const res = await s.sock('GET', p, { headers: { [header]: header === 'tailscale-user-login' ? OWNER : '100.64.0.2' } });
        assert.equal(res.status, 403, `${header} ${p}`);
        assert.equal(res.body.error.code, 'forbidden');
      }
    }
    // Exactly what `tailscale serve` would forward, token and all.
    const relayed = await send(s.socketPath, 'GET', '/api/v1/tasks', {
      headers: { host: 'test-mac.example.ts.net', 'x-forwarded-host': 'test-mac.example.ts.net', 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': OWNER, ...s.bearer() },
    });
    assert.equal(relayed.status, 403);
  }
});

test('the Host header means nothing on the socket', async () => {
  for (const host of ['todos', 'localhost', 'evil.example', '127.0.0.1:7420', '']) {
    assert.equal((await send(on.socketPath, 'GET', '/api/v1/tasks', { headers: { host } })).status, 200, JSON.stringify(host));
  }
});

test('errors on the socket have the API\'s shape', async () => {
  const bad = await on.sock('POST', '/api/v1/tasks', { body: '{broken', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_json');
  assert.equal((await on.sock('POST', '/api/v1/tasks', { body: 'title=x', headers: { 'content-type': 'text/plain' } })).body.error.code, 'unsupported_media_type');
  assert.equal((await on.sock('POST', '/api/v1/tasks', { body: { title: 'x', nope: 1 } })).body.error.code, 'unknown_field');
  const wrongMethod = await on.sock('PUT', '/api/v1/tasks', { body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');
  const big = await on.sock('POST', '/api/v1/tasks', { body: { title: 'x', notes: 'n'.repeat(1_100_000) } }).then((res) => res.status, (e) => e.code);
  assert.ok(big === 413 || big === 'ECONNRESET' || big === 'EPIPE', String(big));
  assert.equal((await on.sock('POST', '/api/v1/tasks', { body: { title: 'x', notes: 'n'.repeat(400_000) } })).status, 201, 'well under 1 MB is fine');
});

// ---------- how changes made there are recorded and announced ----------

test('changes made through the socket are labelled, and the app\'s own still are not', async () => {
  const { task } = (await on.sock('POST', '/api/v1/tasks', { body: { title: 'Labelled' } })).body;
  assert.deepEqual(task.activity.map((a) => [a.by, a.via]), [['me', 'command line']]);
  const named = (await on.sock('POST', `/api/v1/tasks/${task.id}/comments`, { body: { text: 'hi' }, headers: { 'x-todos-client': 'todos 0.1.0 <script>' } })).body.task;
  assert.equal(named.activity.at(-1).via, 'todos 0.1.0 script', 'the client may name itself, cleaned up as for any client');
  await on.local('PATCH', `/api/todos/${task.id}`, { body: { comment: 'from the app' }, headers: { cookie: on.appCookie() } });
  assert.equal('via' in store.getTodo(task.id).activity.at(-1), false);
});

test('a change sent twice through the socket with the same key is made once', async () => {
  const key = { 'idempotency-key': 'socket-retry-0001' };
  const first = await on.sock('POST', '/api/v1/tasks', { body: { title: 'Only once' }, headers: key });
  const again = await on.sock('POST', '/api/v1/tasks', { body: { title: 'Only once' }, headers: key });
  assert.equal(again.body.task.id, first.body.task.id);
  assert.equal(store.load().todos.filter((t) => t.title === 'Only once').length, 1);
});

test('changes through the socket are not rate limited', async () => {
  const { task } = (await on.sock('POST', '/api/v1/tasks', { body: { title: 'Busy' } })).body;
  for (let i = 0; i < 130; i++) {
    assert.equal((await on.sock('POST', `/api/v1/tasks/${task.id}/comments`, { body: { text: `note ${i}` } })).status, 201, `change ${i}`);
  }
});

test('live updates work on the socket, and outlast a token rotation and switching remote access off', async () => {
  const s = await boot({ socket: true });
  const viaSocket = await s.stream(s.sock, '/api/v1/events');
  const viaTailnet = await s.stream(s.tailnet, '/api/v1/events', s.bearer());
  assert.equal(viaSocket.status, 200);
  assert.ok(await viaSocket.sawEvent('hello'));
  store.createTodo({ title: 'Seen live' }, 'me');
  assert.ok(await viaSocket.sawEvent('change'));

  s.remote.rotate();
  assert.ok(await viaTailnet.closedByServer(), 'another device is dropped, as before');
  s.remote.setEnabled(false);
  assert.equal(await viaSocket.closedByServer(300), false, 'the socket\'s connection never depended on either');
  viaSocket.events.length = 0;
  store.createTodo({ title: 'Still seen live' }, 'me');
  assert.ok(await viaSocket.sawEvent('change'));
  viaSocket.close();
  s.close();
});

// ---------- the health check, on both listeners ----------

test('the health check says the server is up and what it speaks, and nothing else', async () => {
  store.createTodo({ title: 'Private health-check canary', notes: 'canary notes', project: 'canary-project' }, 'me');
  const everyone = [
    ['socket, remote access on', () => on.sock('GET', '/health')],
    ['socket, remote access off', () => off.sock('GET', '/health')],
    ['this Mac, no sign-in, remote access on', () => on.local('GET', '/health')],
    ['another device, no sign-in', () => on.tailnet('GET', '/health')],
    ['another device, wrong token', () => on.tailnet('GET', '/health', { headers: { authorization: 'Bearer wrong' } })],
    ['another device, signed in', () => on.tailnet('GET', '/health', { headers: on.bearer() })],
    ['this Mac, remote access off', () => off.local('GET', '/health')],
  ];
  for (const [who, ask] of everyone) {
    const res = await ask();
    if (who.includes('wrong token')) {
      assert.equal(res.status, 401, 'a wrong token is still a wrong token');
      continue;
    }
    assert.equal(res.status, 200, who);
    assert.deepEqual(res.body, HEALTH, who);
    assert.equal(res.headers['set-cookie'], undefined, who);
    const raw = JSON.stringify([res.body, res.headers]);
    for (const secret of ['canary', process.env.TODO_DATA_FILE, on.remote.token, on.socketPath, 'dataFile']) {
      assert.equal(raw.includes(secret), false, `${who}: ${secret}`);
    }
  }
  assert.deepEqual(Object.keys(HEALTH), ['status', 'appVersion', 'apiVersion']);
});

test('the health check keeps to the rules about who is answered at all', async () => {
  // Remote access off: nothing relayed is answered, the health check included.
  const relayedWhileOff = await off.tailnet('GET', '/health');
  assert.equal(relayedWhileOff.status, 403);
  assert.deepEqual(relayedWhileOff.body, { error: 'Forbidden host' });
  assert.equal((await off.local('GET', '/health', { headers: { host: 'evil.example' } })).status, 403);

  // Remote access on: the Host, the Tailscale account and Funnel are still checked first.
  assert.equal((await on.tailnet('GET', '/health', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } })).status, 403);
  assert.equal((await on.tailnet('GET', '/health', { headers: { 'tailscale-user-login': 'someone-else@example.com' } })).status, 403);
  assert.equal((await on.tailnet('GET', '/health', { headers: { 'tailscale-funnel-request': '?1' } })).status, 403);

  // Only GET is the health check. Anything else there is what it always was.
  assert.equal((await off.local('POST', '/health', { body: {} })).status, 405);
  assert.equal((await on.tailnet('POST', '/health', { body: {} })).status, 302);

  // The API's own health check is untouched.
  assert.deepEqual((await on.tailnet('GET', '/api/v1/health')).body, { status: 'ok' });
  assert.deepEqual((await on.sock('GET', '/api/v1/health')).body, { status: 'ok' });
});

test('info adds how old a client may be; on the port it needs the token like the rest of the API', async () => {
  const expected = { ...HEALTH, minClientVersions: MIN_CLIENT_VERSIONS };
  assert.ok(MIN_CLIENT_VERSIONS.cli, 'the command-line client has an entry');
  for (const s of [on, off]) assert.deepEqual((await s.sock('GET', '/api/v1/info')).body, expected);

  assert.equal((await on.tailnet('GET', '/api/v1/info')).status, 401);
  assert.equal((await on.local('GET', '/api/v1/info')).status, 401);
  assert.deepEqual((await on.tailnet('GET', '/api/v1/info', { headers: on.bearer() })).body, expected);
  const whileOff = await off.local('GET', '/api/v1/info');
  assert.equal(whileOff.status, 404);
  assert.deepEqual(whileOff.body, { error: 'Not found' });
});
