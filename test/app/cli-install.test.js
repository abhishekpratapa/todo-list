// Install Command Line Tool and Uninstall Command Line Tool, chosen from the
// real app's menu. The link goes to a folder of the test's own (TODOS_BIN_DIR),
// never to ~/.local/bin, and dialogs are logged instead of shown.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { sandbox, skip, until } from './support.js';

let app;
let bin;
let link;
let binary;
after(() => app?.cleanup());

const dialogs = () => app.lines().filter((l) => l.startsWith('dialog: ')).map((l) => JSON.parse(l.slice('dialog: '.length)));
const logged = (text, count = 1) => until(() => app.lines().filter((l) => l === text).length >= count, 15_000);

test('the menu installs the command by linking to the copy inside the app', { skip }, async () => {
  app = sandbox({ env: { TODOS_DEBUG_DIALOGS: '1' } });
  bin = path.join(app.root, 'bin');
  link = path.join(bin, 'todos');
  // Where a copy run from source keeps the command that `npm run dist` builds.
  binary = path.join(app.sources, 'build', 'bin', 'todos');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\necho "todos, from inside the app"\n', { mode: 0o755 });
  app.open(['-g', '--env', `TODOS_BIN_DIR=${bin}`], ['--background']);
  await app.started();

  const before = await app.state();
  assert.deepEqual(before.menu, { install: true, uninstall: false }, 'both items are in the menu; only Install can be chosen');
  assert.equal(fs.existsSync(link), false);

  await app.click('install-cli');
  assert.ok(await logged('command line tool: installed'));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), binary);
  assert.equal(execFileSync(link, { encoding: 'utf8' }), 'todos, from inside the app\n', 'the installed command runs the copy inside the app');

  const said = await until(() => dialogs().find((d) => d.message === 'The todos command is installed'), 15_000);
  assert.ok(said, 'and the app says so');
  assert.match(said.detail, /now runs the copy of the command inside Todos/);
  assert.deepEqual((await app.state()).menu, { install: false, uninstall: true });
  assert.equal((await app.state()).window, 'none', 'no window was opened for any of it');
});

test('the menu uninstalls it by removing the link, and only the link', { skip }, async () => {
  await app.click('uninstall-cli');
  assert.ok(await logged('command line tool: removed'));
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(binary), true, 'the copy inside the app is untouched');
  assert.ok(await until(() => dialogs().some((d) => d.message === 'The todos command was removed'), 5000));
  assert.deepEqual((await app.state()).menu, { install: true, uninstall: false });
});

test('the menu will not replace something that is not its own', { skip }, async () => {
  fs.writeFileSync(link, '#!/bin/sh\necho "some other todos"\n', { mode: 0o755 });
  await app.click('install-cli');
  const said = await until(() => dialogs().find((d) => d.message === 'The todos command was not installed'), 5000);
  assert.ok(said);
  assert.match(said.detail, /wasn’t put there by Todos, so it has been left alone/);
  assert.equal(execFileSync(link, { encoding: 'utf8' }), 'some other todos\n');
  assert.equal(app.lines().filter((l) => l === 'command line tool: installed').length, 1, 'nothing was installed the second time');
});
