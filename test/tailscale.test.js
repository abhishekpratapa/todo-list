// The Tailscale integration, exercised against a stand-in for the `tailscale`
// command so the tests never touch the real Tailscale configuration.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { tmp } from './support/helpers.js';

const dir = path.join(tmp, 'fake-tailscale');
const log = path.join(dir, 'calls.log');
const put = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const reset = () => fs.rmSync(log, { force: true });

let ts;
before(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, 'tailscale');
  fs.writeFileSync(cli, `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "status --json") cat "${dir}/status.json" ;;
  "serve status") cat "${dir}/serve.json" ;;
  "whois --json") cat "${dir}/whois.json" ;;
  serve\\ --*) if [ -f "${dir}/serve-fails" ]; then cat "${dir}/serve-fails" >&2; exit 1; fi ;;
esac
`, { mode: 0o755 });
  process.env.TODOS_TAILSCALE_BIN = cli;
  ts = await import('../src/tailscale.js');
  put('status.json', {
    BackendState: 'Running',
    Self: { DNSName: 'My-Mac.Tail1234.ts.net.', UserID: 42 },
    User: { 42: { LoginName: 'owner@example.com' }, 7: { LoginName: 'other@example.com' } },
    CertDomains: ['my-mac.tail1234.ts.net'],
  });
  put('serve.json', {});
});

const HOST = 'my-mac.tail1234.ts.net';
const mapping = (httpsPort, proxy, funnel = false) => ({
  TCP: { [httpsPort]: { HTTPS: true } },
  Web: { [`${HOST}:${httpsPort}`]: { Handlers: { '/': { Proxy: proxy } } } },
  ...(funnel ? { AllowFunnel: { [`${HOST}:${httpsPort}`]: true } } : {}),
});

test('reads this Mac\'s name, owner and HTTPS state', async () => {
  assert.deepEqual(await ts.status(), { installed: true, running: true, dnsName: HOST, ownerLogin: 'owner@example.com', httpsEnabled: true });
  put('status.json', { BackendState: 'Stopped', Self: {} });
  const stopped = await ts.status();
  assert.equal(stopped.running, false);
  assert.equal(stopped.dnsName, null);
  put('status.json', 'not json at all');
  assert.deepEqual(await ts.status(), { installed: true, running: false });
});

test('recognizes its own serve mapping and nobody else\'s', async () => {
  put('serve.json', {});
  assert.deepEqual(await ts.serveStatus(7420), { mapped: false, httpsPort: null, funnel: false, taken: [] });
  put('serve.json', mapping(443, 'http://127.0.0.1:7420'));
  assert.deepEqual(await ts.serveStatus(7420), { mapped: true, httpsPort: 443, funnel: false, taken: [443] });
  put('serve.json', mapping(8443, 'http://localhost:7420', true));
  assert.deepEqual(await ts.serveStatus(7420), { mapped: true, httpsPort: 8443, funnel: true, taken: [8443] });
  for (const other of ['http://127.0.0.1:3000', 'http://127.0.0.1:74200', 'http://127.0.0.1:7420/sub', 'http://10.0.0.5:7420']) {
    put('serve.json', mapping(443, other));
    const s = await ts.serveStatus(7420);
    assert.equal(s.mapped, false, other);
    assert.deepEqual(s.taken, [443]);
  }
});

test('setting up runs exactly one serve command, on a free HTTPS port', async () => {
  put('serve.json', {});
  reset();
  assert.deepEqual(await ts.serveOn(7420), { ok: true, httpsPort: 443 });
  assert.deepEqual(calls(), ['serve status --json', 'serve --bg --yes --https=443 http://127.0.0.1:7420']);
  assert.equal(ts.serveCommand(7420, 443), 'tailscale serve --bg --https=443 http://127.0.0.1:7420');

  // 443 already serves something else: leave it alone and use the next port.
  put('serve.json', mapping(443, 'http://127.0.0.1:3000'));
  reset();
  assert.deepEqual(await ts.serveOn(7420), { ok: true, httpsPort: 8443 });
  assert.equal(calls().at(-1), 'serve --bg --yes --https=8443 http://127.0.0.1:7420');

  // Already set up: nothing to run.
  put('serve.json', mapping(443, 'http://127.0.0.1:7420'));
  reset();
  assert.deepEqual(await ts.serveOn(7420), { ok: true, httpsPort: 443 });
  assert.deepEqual(calls(), ['serve status --json']);
});

test('a failed setup reports Tailscale\'s own message', async () => {
  put('serve.json', {});
  put('serve-fails', 'Serve is not enabled on your tailnet.\nTo enable, visit:\n  https://login.tailscale.com/f/serve?node=abc\n');
  const r = await ts.serveOn(7420);
  assert.equal(r.ok, false);
  assert.match(r.error, /Serve is not enabled.*https:\/\/login\.tailscale\.com/);
  fs.rmSync(path.join(dir, 'serve-fails'));
});

test('removing only ever touches our own mapping', async () => {
  put('serve.json', mapping(443, 'http://127.0.0.1:3000'));
  reset();
  assert.deepEqual(await ts.serveOff(7420), { ok: true });
  assert.deepEqual(calls(), ['serve status --json'], 'someone else\'s mapping: nothing was run');

  put('serve.json', mapping(8443, 'http://127.0.0.1:7420'));
  reset();
  assert.deepEqual(await ts.serveOff(7420), { ok: true });
  assert.equal(calls().at(-1), 'serve --yes --https=8443 off');
});

test('device names come from whois, are cached, and only addresses are passed along', async () => {
  put('whois.json', { Node: { ComputedName: 'iPhone', Name: 'iphone.tail1234.ts.net.' }, UserProfile: { LoginName: 'owner@example.com' } });
  reset();
  assert.equal(await ts.deviceName('100.64.0.2'), 'iPhone');
  assert.equal(await ts.deviceName('100.64.0.2'), 'iPhone');
  assert.deepEqual(calls(), ['whois --json 100.64.0.2'], 'second lookup came from the cache');
  put('whois.json', { Node: { Name: 'work-laptop.tail1234.ts.net.' } });
  assert.equal(await ts.deviceName('fd7a:115c:a1e0::1'), 'work-laptop');
  reset();
  for (const bad of ['100.64.0.2; rm -rf ~', '--json', 'tailnet', '$(whoami)', '']) assert.equal(await ts.deviceName(bad), null, bad);
  assert.deepEqual(calls(), [], 'nothing that is not an address reaches the command line');
});

test('without the command installed, everything degrades quietly', async () => {
  const saved = process.env.TODOS_TAILSCALE_BIN;
  process.env.TODOS_TAILSCALE_BIN = path.join(dir, 'does-not-exist');
  assert.equal((await ts.status()).running, false);
  assert.equal((await ts.serveStatus(7420)).mapped, false);
  assert.equal((await ts.serveOn(7420)).ok, false);
  process.env.TODOS_TAILSCALE_BIN = saved;
});
