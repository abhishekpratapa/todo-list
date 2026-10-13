// The app as `npm run dist` packaged it: it starts in the background, carries the
// command-line tool at Contents/Resources/bin/todos, and its menu installs and
// removes a link to exactly that copy. Skipped until the app has been built here.
//
// Only a cold start is tried. The installed app has the same identifier, so
// "open it again" is left to the tests that run from source.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { ask, packagedApp, sandbox, skip, until } from './support.js';

const needsBuild = skip || (!packagedApp && 'needs a packaged app: npm run dist');
let app;
after(() => app?.cleanup());

test('the packaged app starts in the background with the command-line tool inside it', { skip: needsBuild }, async () => {
  app = sandbox({ packaged: packagedApp, env: { TODOS_DEBUG_DIALOGS: '1' } });
  const bin = path.join(app.root, 'bin');
  const inside = path.join(app.bundle, 'Contents', 'Resources', 'bin', 'todos');
  assert.match(execFileSync('/usr/bin/file', [inside], { encoding: 'utf8' }), /Mach-O 64-bit executable arm64/);
  assert.equal(fs.statSync(inside).mode & 0o111, 0o111, 'it is executable');

  app.open(['-g', '--env', `TODOS_BIN_DIR=${bin}`], ['--background']);
  assert.match(await app.started(), /background=true/);
  const state = await app.state();
  assert.equal(state.window, 'none');
  assert.equal(state.active, false);
  assert.deepEqual(state.menu, { install: true, uninstall: false });

  const version = JSON.parse(fs.readFileSync(path.join(app.bundle, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).version;
  const health = (await ask(app.socketPath, 'GET', '/health')).body;
  assert.equal(health.status, 'ok');
  assert.equal(health.appVersion, version);

  // Install from the menu: the link points into this bundle, and the command runs.
  const link = path.join(bin, 'todos');
  await app.click('install-cli');
  assert.ok(await until(() => app.lines().includes('command line tool: installed'), 15_000));
  assert.equal(fs.readlinkSync(link), inside);
  // Run through the link, it reaches this copy of the app. It is pointed at this
  // copy's socket and a config folder of its own: left to itself it would ask
  // the installed app, which these tests never touch.
  const own = { encoding: 'utf8', env: { ...process.env, TODOS_SOCKET: app.socketPath, XDG_CONFIG_HOME: path.join(app.root, 'config') } };
  assert.equal(execFileSync(link, ['version'], own), execFileSync(inside, ['version'], own));
  const status = JSON.parse(execFileSync(link, ['status', '--json'], own));
  assert.deepEqual([status.profile, status.transport, status.address, status.appVersion], ['local', 'socket', app.socketPath, version]);
  assert.deepEqual((await app.state()).menu, { install: false, uninstall: true });

  await app.click('uninstall-cli');
  assert.ok(await until(() => app.lines().includes('command line tool: removed'), 15_000));
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(inside), true);

  assert.equal(await app.quit(), true);
  assert.equal(fs.existsSync(app.socketPath), false);
});
