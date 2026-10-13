// Install Command Line Tool: the link it makes, what it will and won't replace,
// and what uninstalling removes. The menu items themselves are exercised in the
// real app by test/app/cli-install.test.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmp } from './support/helpers.js';

const { CliInstallError, bundledCli, cliLink, install, linkState, resolvedByShell, uninstall } = await import('../electron/cli-install.js');

// A stand-in for the app bundle with its command inside, and a folder on the PATH.
let n = 0;
function setup() {
  const root = path.join(tmp, `install-${++n}`);
  const binary = path.join(root, 'Todos.app', 'Contents', 'Resources', 'bin', 'todos');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\necho "todos from the bundle"\n', { mode: 0o755 });
  return { root, binary, link: path.join(root, 'home', '.local', 'bin', 'todos') };
}
const refused = (fn, code) => assert.throws(fn, (e) => e instanceof CliInstallError && e.code === code);

test('where things are: the copy inside the bundle, and ~/.local/bin', () => {
  assert.equal(bundledCli({ packaged: true, resourcesPath: '/Applications/Todos.app/Contents/Resources', root: '/src' }), '/Applications/Todos.app/Contents/Resources/bin/todos');
  assert.equal(bundledCli({ packaged: false, resourcesPath: '/elsewhere', root: '/src' }), '/src/build/bin/todos');
  assert.equal(cliLink({ env: {}, home: '/Users/someone' }), '/Users/someone/.local/bin/todos');
  assert.equal(cliLink({ env: { TODOS_BIN_DIR: '/opt/homebrew/bin' }, home: '/Users/someone' }), '/opt/homebrew/bin/todos');
});

test('installing links the command to the copy inside the app, creating the folder if needed', () => {
  const { binary, link } = setup();
  assert.equal(linkState(link, binary), 'none');
  install(link, binary);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), binary);
  assert.equal(linkState(link, binary), 'ours');
  install(link, binary); // again: nothing to do, nothing goes wrong
  assert.deepEqual(fs.readdirSync(path.dirname(link)), ['todos'], 'no leftovers next to it');
});

test('uninstalling removes the link and nothing else', () => {
  const { binary, link } = setup();
  install(link, binary);
  uninstall(link, binary);
  assert.equal(linkState(link, binary), 'none');
  assert.equal(fs.existsSync(binary), true, 'the copy inside the app is untouched');
  assert.equal(fs.existsSync(path.dirname(link)), true, 'the folder stays');
  uninstall(link, binary); // nothing there: nothing to do
});

test('a link left by a copy of Todos that has moved is replaced, and can be removed', () => {
  const { binary, link } = setup();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync('/Applications/Old Folder/Todos.app/Contents/Resources/bin/todos', link); // dangling
  assert.equal(linkState(link, binary), 'stale');
  install(link, binary);
  assert.equal(fs.readlinkSync(link), binary);

  fs.unlinkSync(link);
  fs.symlinkSync('/Volumes/Todos/Todos.app/Contents/Resources/bin/todos', link);
  uninstall(link, binary);
  assert.equal(linkState(link, binary), 'none');
});

test('anything Todos did not put there is never replaced or removed', () => {
  const { root, binary, link } = setup();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const other = path.join(root, 'someone-elses-todos');
  fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });

  // A real file, a link to something else, and a folder.
  const inTheWay = [
    () => fs.writeFileSync(link, 'a different program', { mode: 0o755 }),
    () => fs.symlinkSync(other, link),
    () => fs.symlinkSync('/usr/local/bin/todos', link),
    () => fs.mkdirSync(link),
  ];
  for (const put of inTheWay) {
    put();
    const before = fs.lstatSync(link);
    assert.equal(linkState(link, binary), 'foreign');
    refused(() => install(link, binary), 'in_the_way');
    refused(() => uninstall(link, binary), 'in_the_way');
    const after = fs.lstatSync(link);
    assert.deepEqual([after.ino, after.size, after.mode], [before.ino, before.size, before.mode], 'left exactly as it was');
    fs.rmSync(link, { recursive: true });
  }
});

test('a copy of the app with no command inside installs nothing', () => {
  const { binary, link } = setup();
  fs.rmSync(binary);
  refused(() => install(link, binary), 'no_binary');
  fs.writeFileSync(binary, 'not runnable', { mode: 0o644 });
  refused(() => install(link, binary), 'no_binary');
  assert.equal(fs.existsSync(path.dirname(link)), false, 'not even the folder was made');
});

test('the user\'s own shell is asked what `todos` would run', async () => {
  const shell = (script) => {
    const file = path.join(tmp, `shell-${++n}`);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  };
  // Found, with the noise a login shell prints first.
  assert.equal(await resolvedByShell({ shell: shell('echo "Welcome back!"; echo /Users/someone/.local/bin/todos') }), '/Users/someone/.local/bin/todos');
  // Not on the PATH: `command -v` prints nothing and fails.
  assert.equal(await resolvedByShell({ shell: shell('exit 1') }), null);
  // Couldn't ask: no such shell, or it never answers.
  assert.equal(await resolvedByShell({ shell: path.join(tmp, 'no-such-shell') }), undefined);
  assert.equal(await resolvedByShell({ shell: shell('sleep 5'), timeout: 200 }), undefined);
  // It is asked the way a new terminal window would be: as an interactive login shell.
  const args = path.join(tmp, 'shell-args');
  await resolvedByShell({ shell: shell(`echo "$@" > '${args}'`) });
  assert.equal(fs.readFileSync(args, 'utf8').trim(), '-ilc command -v todos');
});
