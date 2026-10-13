// Install Command Line Tool: the link it makes, what it will and won't replace,
// and what uninstalling removes. The menu items themselves are exercised in the
// real app by test/app/cli-install.test.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmp } from './support/helpers.js';

const { CliInstallError, bundledCli, cliLink, install, linkState, onShellPath, uninstall } = await import('../electron/cli-install.js');

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

test('whether a terminal would find the command is read from the shell\'s startup files, and nothing is run', () => {
  const home = path.join(tmp, `home-${++n}`);
  fs.mkdirSync(home);
  const dir = path.join(home, '.local', 'bin');
  const none = path.join(tmp, 'no-system-paths');
  const ask = (shell = '/bin/zsh', folder = dir) => onShellPath(folder, { home, shell, systemPaths: [none] });

  assert.equal(ask(), false, 'no startup files at all');
  // A startup file that would give itself away if it were ever run.
  const canary = path.join(tmp, 'startup-file-was-run');
  fs.writeFileSync(path.join(home, '.zshrc'), `touch '${canary}'\nexport PATH="/somewhere/else:$PATH"\n`);
  assert.equal(ask(), false, 'a PATH line for some other folder');

  // However the folder is written.
  for (const line of ['export PATH="$HOME/.local/bin:$PATH"', 'path=(~/.local/bin $path)', `PATH=${dir}:$PATH`, 'export PATH="${HOME}/.local/bin:$PATH"']) {
    fs.writeFileSync(path.join(home, '.zprofile'), `${line}\n`);
    assert.equal(ask(), true, line);
  }
  assert.equal(fs.existsSync(canary), false, 'the startup files were read, not run');

  // Each shell has its own files.
  assert.equal(ask('/bin/bash'), false, 'bash does not read .zprofile');
  fs.writeFileSync(path.join(home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(ask('/bin/bash'), true);

  // A folder every shell gets from the system's own lists.
  const etc = path.join(tmp, `etc-${n}`);
  fs.mkdirSync(path.join(etc, 'paths.d'), { recursive: true });
  fs.writeFileSync(path.join(etc, 'paths'), '/usr/local/bin\n/usr/bin\n');
  fs.writeFileSync(path.join(etc, 'paths.d', 'extra'), '/opt/extra/bin\n');
  const system = (folder) => onShellPath(folder, { home, shell: '/bin/zsh', systemPaths: [path.join(etc, 'paths'), path.join(etc, 'paths.d')] });
  assert.equal(system('/usr/local/bin'), true);
  assert.equal(system('/opt/extra/bin'), true);
  assert.equal(system('/usr/local'), false, 'the folder itself, not one that merely starts the same');
});

test('nothing in the install code starts another program', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'electron', 'cli-install.js'), 'utf8');
  assert.equal(/child_process|execFile|spawn/.test(source.replace(/^\s*\/\/.*$/gm, '')), false);
});
