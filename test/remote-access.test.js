// Remote access on: every route needs authentication, including requests that
// arrive from 127.0.0.1 (which is where `tailscale serve` delivers everything).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { OWNER, TAILNET, boot, store, tmp } from './support/helpers.js';

let handoffCalls = 0;
const handoff = {
  info: () => ({ target: 'desktop', folders: { work: '~/secret/project' } }),
  start: async () => {
    handoffCalls += 1;
    return { started: true, target: 'desktop', folder: '~/secret/project' };
  },
};

let s;
let task;
before(async () => {
  s = await boot({ handoff });
  task = store.createTodo({ title: 'Existing task', project: 'work' }, 'me');
});
after(() => s.close());

// Every route the server has that is not explicitly public.
const PROTECTED = [
  ['GET', '/'],
  ['GET', '/index.html'],
  ['GET', '/app.js'],
  ['GET', '/capture.html'],
  ['GET', '/api/health'],
  ['GET', '/api/events'],
  ['GET', '/api/todos'],
  ['POST', '/api/todos', { title: 'x' }],
  ['POST', '/api/parse', { text: 'x fri' }],
  ['PATCH', '/api/todos/1', { title: 'x' }],
  ['DELETE', '/api/todos/1'],
  ['POST', '/api/todos/1/handoff', {}],
  ['GET', '/api/v1/session'],
  ['DELETE', '/api/v1/session'],
  ['GET', '/api/v1/events'],
  ['GET', '/api/v1/tasks'],
  ['GET', '/api/v1/does-not-exist'],
];

test('without credentials, every route is refused, from this Mac and from the tailnet', async () => {
  for (const as of [s.local, s.tailnet]) {
    for (const [method, path, body] of PROTECTED) {
      const res = await as(method, path, { body });
      if (path.startsWith('/api/')) {
        assert.equal(res.status, 401, `${method} ${path}`);
      } else {
        assert.equal(res.status, 302, `${method} ${path}`); // pages go to the sign-in page
        assert.equal(res.headers.location, '/login');
      }
      assert.equal(res.headers['set-cookie'], undefined);
    }
  }
  assert.equal(store.load().todos.length, 1, 'nothing was created, changed or deleted');
  assert.equal(handoffCalls, 0);
});

test('refusals use the caller\'s error shape and carry no CORS headers', async () => {
  const v1 = await s.tailnet('GET', '/api/v1/session');
  assert.deepEqual(v1.body, { error: { code: 'unauthorized', message: 'Sign in required.' } });
  const legacy = await s.tailnet('GET', '/api/todos');
  assert.deepEqual(legacy.body, { error: 'Sign in required.', code: 'unauthorized' });
  for (const res of [v1, legacy, await s.tailnet('OPTIONS', '/api/todos', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })]) {
    assert.equal(Object.keys(res.headers).some((h) => h.startsWith('access-control-')), false);
  }
});

test('health and the sign-in page are public, and health reveals nothing', async () => {
  const health = await s.tailnet('GET', '/api/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  for (const path of ['/login', '/login.js', '/login.css', '/styles.css', '/manifest.webmanifest', '/icons/icon-180.png']) {
    assert.equal((await s.tailnet('GET', path)).status, 200, path);
  }
  assert.match((await s.tailnet('GET', '/login')).body, /Access token/);
});

test('a bearer token works; a wrong one does not', async () => {
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: s.bearer() })).status, 200);
  assert.equal((await s.local('GET', '/api/todos', { headers: s.bearer() })).status, 200);
  const bad = await s.tailnet('GET', '/api/todos', { headers: { authorization: 'Bearer nope', 'x-forwarded-for': '100.64.0.50' } });
  assert.equal(bad.status, 401);
  // A valid cookie alongside a wrong bearer token does not rescue the request.
  const cookie = await s.signIn();
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie, authorization: 'Bearer nope', 'x-forwarded-for': '100.64.0.50' } })).status, 401);
});

test('signing in sets a locked-down cookie that then grants access', async () => {
  const res = await s.tailnet('POST', '/api/v1/session', { body: { token: s.remote.token } });
  assert.equal(res.status, 200);
  const setCookie = res.headers['set-cookie'][0];
  assert.match(setCookie, /^todos_session=v1\.r\./);
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=']) assert.ok(setCookie.includes(attr), attr);
  assert.ok(!setCookie.includes(s.remote.token), 'the cookie does not contain the token');

  const cookie = setCookie.split(';')[0];
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 200);
  assert.equal((await s.tailnet('GET', '/', { headers: { cookie } })).status, 200);
  assert.deepEqual((await s.tailnet('GET', '/api/v1/session', { headers: { cookie } })).body, { kind: 'remote' });

  // Over plain http on this Mac the cookie is the same, minus Secure (the browser would refuse it otherwise).
  const local = await s.local('POST', '/api/v1/session', { body: { token: s.remote.token } });
  assert.ok(!local.headers['set-cookie'][0].includes('Secure'));

  const out = await s.tailnet('DELETE', '/api/v1/session', { headers: { cookie } });
  assert.match(out.headers['set-cookie'][0], /^todos_session=;.*Max-Age=0/);
});

test('wrong tokens are refused, then rate limited; the right token still works', async () => {
  const from = { 'x-forwarded-for': '100.64.0.77' };
  for (let i = 0; i < 10; i++) {
    const res = await s.tailnet('POST', '/api/v1/session', { body: { token: `wrong-${i}` }, headers: from });
    assert.equal(res.status, 401);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  const limited = await s.tailnet('POST', '/api/v1/session', { body: { token: 'wrong-again' }, headers: from });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await s.tailnet('POST', '/api/v1/session', { body: { token: s.remote.token }, headers: from })).status, 200);
});

test('tampered, forged and expired cookies are refused', async () => {
  const cookie = await s.signIn();
  const value = cookie.split('=')[1];
  const parts = value.split('.');
  const forged = [
    `${value.slice(0, -2)}xx`, // signature altered
    [parts[0], 'a', ...parts.slice(2)].join('.'), // remote cookie relabelled as the app's
    [parts[0], parts[1], (Date.now() + 1e12).toString(36), ...parts.slice(3)].join('.'), // expiry extended
    'v1.r.zzzz.id.sig',
    '',
  ];
  for (const bad of forged) {
    assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie: `todos_session=${bad}` } })).status, 401, bad);
  }
});

test('Host must be this Mac: bad or missing hosts are refused before anything else', async () => {
  const auth = s.bearer();
  const cases = [
    [s.local, { host: 'evil.example' }],
    [s.local, { host: `evil.example:${s.port}` }],
    [s.local, { host: TAILNET }], // the tailnet name is only valid on relayed requests
    [s.tailnet, { host: 'evil.example', 'x-forwarded-host': 'evil.example' }],
    [s.tailnet, { 'x-forwarded-host': 'evil.example' }],
    [s.tailnet, { host: 'evil.example' }],
  ];
  for (const [as, headers] of cases) {
    const res = await as('GET', '/api/todos', { headers: { ...auth, ...headers } });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.body.code, 'forbidden_host');
  }
  // No Host at all never reaches the app: Node answers 400 for HTTP/1.1 without one.
  assert.equal((await s.local('GET', '/api/todos', { headers: { ...auth, host: undefined } })).status, 400);
  // `tailscale serve` on a non-default port: the name with a port is still this Mac.
  const ported = await s.tailnet('GET', '/api/todos', { headers: { ...auth, host: `${TAILNET}:8443`, 'x-forwarded-host': `${TAILNET}:8443` } });
  assert.equal(ported.status, 200);
});

test('browser writes must come from our own origin', async () => {
  const cookie = await s.signIn();
  const write = (headers) => s.tailnet('POST', '/api/parse', { body: { text: 'x' }, headers: { cookie, ...headers } });
  assert.equal((await write({})).status, 200);
  for (const headers of [
    { origin: 'https://evil.example' },
    { origin: `http://${TAILNET}` }, // right host, wrong scheme
    { origin: `https://${TAILNET}:8443` }, // right host, wrong port
    { origin: undefined }, // a cookie alone is not enough
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const res = await write(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.body.code, 'forbidden_origin');
  }
  // API clients are not browsers and send no Origin, but a wrong one is still refused.
  assert.equal((await s.tailnet('POST', '/api/parse', { body: { text: 'x' }, headers: { ...s.bearer(), origin: undefined } })).status, 200);
  assert.equal((await s.tailnet('POST', '/api/parse', { body: { text: 'x' }, headers: { ...s.bearer(), origin: 'https://evil.example' } })).status, 403);
  // Sign-in itself cannot be driven from another site either.
  assert.equal((await s.tailnet('POST', '/api/v1/session', { body: { token: s.remote.token }, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('relayed requests must come from the owner\'s Tailscale account', async () => {
  const auth = s.bearer();
  for (const headers of [{ 'tailscale-user-login': 'someone-else@example.com' }, { 'tailscale-user-login': undefined }, { 'tailscale-user-login': '' }]) {
    const res = await s.tailnet('GET', '/api/todos', { headers: { ...auth, ...headers } });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.body.code, 'forbidden_user');
  }
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { ...auth, 'tailscale-user-login': OWNER.toUpperCase() } })).status, 200);

  // If the owner is unknown (Tailscale state could not be read), relayed requests fail closed.
  s.remote.ownerLogin = null;
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: auth })).status, 403);
  s.remote.ownerLogin = OWNER;

  // With the check turned off, other accounts get as far as needing the token.
  s.remote.requireOwner = false;
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { 'tailscale-user-login': 'someone-else@example.com' } })).status, 401);
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { ...auth, 'tailscale-user-login': 'someone-else@example.com' } })).status, 200);
  s.remote.requireOwner = true;
});

test('requests that came through Tailscale Funnel (the public internet) are refused', async () => {
  const res = await s.tailnet('GET', '/api/todos', { headers: { ...s.bearer(), 'tailscale-funnel-request': '?1' } });
  assert.equal(res.status, 403);
});

test('the app\'s own cookie works on this Mac only', async () => {
  const cookie = s.appCookie();
  const snap = await s.local('GET', '/api/todos', { headers: { cookie } });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.session, 'app');
  assert.equal((await s.local('PATCH', `/api/todos/${task.id}`, { body: { comment: 'from the app' }, headers: { cookie } })).status, 200);
  // The same cookie presented through the relay is ignored.
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 401);
});

test('Start with Claude and folder paths stay on the Mac', async () => {
  const remoteCookie = await s.signIn();
  const localBrowser = await s.signIn(s.local); // a browser on the Mac that signed in with the token
  for (const [as, headers] of [[s.tailnet, { cookie: remoteCookie }], [s.tailnet, s.bearer()], [s.local, { cookie: localBrowser }], [s.local, s.bearer()]]) {
    const res = await as('POST', `/api/todos/${task.id}/handoff`, { body: {}, headers });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'local_only');
    const snap = await as('GET', '/api/todos', { headers });
    assert.equal(snap.body.handoff, null, 'no folder paths for other clients');
    assert.equal(JSON.stringify(snap.body).includes('secret/project'), false);
    assert.equal('dataFile' in (await as('GET', '/api/health', { headers })).body, false, 'no data file path either');
  }
  assert.equal(handoffCalls, 0);

  const app = { cookie: s.appCookie() };
  assert.deepEqual((await s.local('GET', '/api/todos', { headers: app })).body.handoff.folders, { work: '~/secret/project' });
  assert.equal((await s.local('POST', `/api/todos/${task.id}/handoff`, { body: {}, headers: app })).status, 200);
  assert.equal(handoffCalls, 1);
});

test('changes from other devices are labelled, and the app\'s own are not', async () => {
  const cookie = await s.signIn();
  const latest = () => store.getTodo(task.id).activity.at(-1);

  await s.tailnet('PATCH', `/api/todos/${task.id}`, { body: { comment: 'from my phone' }, headers: { cookie } });
  assert.deepEqual([latest().by, latest().via], ['me', 'Test iPhone']); // device name from Tailscale

  await s.tailnet('PATCH', `/api/todos/${task.id}`, { body: { comment: 'unknown device' }, headers: { cookie, 'x-forwarded-for': '100.64.0.9' } });
  assert.equal(latest().via, 'Owner Name'); // falls back to the Tailscale user name

  await s.tailnet('PATCH', `/api/todos/${task.id}`, { body: { comment: 'shortcut' }, headers: { ...s.bearer(), 'x-todos-client': 'iOS Shortcut <script>' } });
  assert.equal(latest().via, 'iOS Shortcut script'); // clients may name themselves; the label is sanitized

  await s.local('PATCH', `/api/todos/${task.id}`, { body: { comment: 'local script' }, headers: s.bearer() });
  assert.equal(latest().via, 'API on this Mac');

  await s.local('PATCH', `/api/todos/${task.id}`, { body: { comment: 'the app' }, headers: { cookie: s.appCookie() } });
  assert.equal('via' in latest(), false);

  const created = await s.tailnet('POST', '/api/todos', { body: { quick: 'Buy stamps tomorrow' }, headers: { cookie } });
  assert.equal(created.body.activity[0].via, 'Test iPhone');
});

test('an edit based on a stale copy is refused instead of overwriting', async () => {
  const cookie = await s.signIn();
  const mine = store.createTodo({ title: 'Shared task', notes: 'original' }, 'me');
  store.updateTodo(mine.id, { notes: 'edited by Claude' }, 'Claude Code'); // someone else gets there first

  const stale = await s.tailnet('PATCH', `/api/todos/${mine.id}`, { body: { notes: 'edited on my phone', rev: mine.rev }, headers: { cookie } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  assert.equal(stale.body.current.notes, 'edited by Claude');
  assert.equal(store.getTodo(mine.id).notes, 'edited by Claude', 'nothing was overwritten');

  const fresh = await s.tailnet('PATCH', `/api/todos/${mine.id}`, { body: { notes: 'merged', rev: stale.body.current.rev }, headers: { cookie } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.todo.rev, stale.body.current.rev + 1);

  assert.equal((await s.tailnet('DELETE', `/api/todos/${mine.id}?rev=1`, { headers: { cookie } })).status, 409);
  assert.equal((await s.tailnet('DELETE', `/api/todos/${mine.id}?rev=${fresh.body.todo.rev}`, { headers: { cookie } })).status, 200);
});

test('live updates work with the cookie and are refused without it', async () => {
  assert.equal((await s.stream(s.tailnet, '/api/events')).status, 401);
  const cookie = await s.signIn();
  for (const path of ['/api/events', '/api/v1/events']) {
    const live = await s.stream(s.tailnet, path, { cookie });
    assert.equal(live.status, 200);
    assert.ok(await live.sawEvent('hello'));
    store.updateTodo(task.id, { comment: `ping ${path}` }, 'Claude Code'); // e.g. a Claude session, via the store
    assert.ok(await live.sawEvent('change'), `change event on ${path}`);
    live.close();
  }
  // The Mac's own window keeps getting updates when the change comes from another device.
  const appWindow = await s.stream(s.local, '/api/events', { cookie: s.appCookie() });
  await appWindow.sawEvent('hello');
  await s.tailnet('PATCH', `/api/todos/${task.id}`, { body: { comment: 'from the phone' }, headers: { cookie } });
  assert.ok(await appWindow.sawEvent('change'));
  appWindow.close();
});

test('rotating the token signs out every other device, but not the app', async () => {
  const cookie = await s.signIn();
  const oldBearer = s.bearer();
  const live = await s.stream(s.tailnet, '/api/events', { cookie });
  const appWindow = await s.stream(s.local, '/api/events', { cookie: s.appCookie() });
  const oldToken = s.remote.token;

  s.remote.rotate();
  assert.notEqual(s.remote.token, oldToken);
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 401);
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { ...oldBearer, 'x-forwarded-for': '100.64.0.60' } })).status, 401);
  assert.ok(await live.closedByServer(), 'the open live connection was dropped');
  assert.equal((await s.local('GET', '/api/todos', { headers: { cookie: s.appCookie() } })).status, 200);
  assert.equal(await appWindow.closedByServer(300), false, 'the app window stays connected');
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: s.bearer() })).status, 200, 'the new token works');
  appWindow.close();
});

test('the token is long, random and stored for the owner only', () => {
  assert.ok(s.remote.token.length >= 43, '256 bits, base64url');
  const files = fs.readdirSync(tmp).filter((f) => f.startsWith('token-'));
  assert.ok(files.length > 0);
  for (const name of files) assert.equal(fs.statSync(path.join(tmp, name)).mode & 0o777, 0o600, name);
  // A token file left readable by others is tightened the next time it is loaded.
  fs.chmodSync(path.join(tmp, files[0]), 0o644);
  s.remote.rotate();
  assert.equal(fs.statSync(path.join(tmp, files[0])).mode & 0o777, 0o600);
});

test('responses carry hardening headers', async () => {
  const res = await s.tailnet('GET', '/login');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('oversized and malformed bodies are refused', async () => {
  const headers = s.bearer();
  assert.equal((await s.tailnet('POST', '/api/todos', { body: JSON.stringify({ title: 'x'.repeat(300_000) }), headers: { ...headers, 'content-type': 'application/json' } })).status, 400);
  assert.equal((await s.tailnet('POST', '/api/todos', { body: '{not json', headers: { ...headers, 'content-type': 'application/json' } })).status, 400);
  assert.equal((await s.tailnet('POST', '/api/todos', { body: 'title=x', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' } })).status, 400);
});

test('writes are rate limited per client', async () => {
  const cookie = await s.signIn();
  let limited = null;
  for (let i = 0; i < 125 && !limited; i++) {
    const res = await s.tailnet('POST', '/api/parse', { body: { text: 'x' }, headers: { cookie } });
    if (res.status === 429) limited = { after: i, retry: Number(res.headers['retry-after']) };
    else assert.equal(res.status, 200);
  }
  assert.deepEqual(limited && limited.after, 120);
  assert.ok(limited.retry > 0);
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 200, 'reads are not limited');
  const other = await s.signIn();
  assert.equal((await s.tailnet('POST', '/api/parse', { body: { text: 'x' }, headers: { cookie: other } })).status, 200, 'another session has its own allowance');
});

test('turning the setting off drops other devices at once', async () => {
  const cookie = await s.signIn();
  const live = await s.stream(s.tailnet, '/api/events', { cookie });
  s.remote.setEnabled(false);
  assert.ok(await live.closedByServer());
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 403, 'relayed requests are refused outright');
  assert.equal((await s.tailnet('GET', '/api/v1/health')).status, 403);
  assert.equal((await s.local('GET', '/api/todos')).status, 200, 'and the Mac is back to working without sign-in');
  s.remote.setEnabled(true);
  assert.equal((await s.tailnet('GET', '/api/todos', { headers: { cookie } })).status, 200, 'turning it back on restores existing sign-ins');
});
