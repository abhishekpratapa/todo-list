// "Install Command Line Tool": puts the `todos` command on the PATH by linking
// ~/.local/bin/todos to the copy inside the app bundle. A link, not a copy, so
// the command is always the one that came with the installed app. No admin
// password is involved, and nothing here runs anything as root.
//
// The menu items and their dialogs are in main.js. This is the part that touches
// the disk, kept free of Electron so it can be tested. Node built-ins only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A link into some copy of Todos.app: this one, or one that has since been moved or replaced.
const INSIDE_TODOS = /\/Todos[^/]*\.app\/Contents\/Resources\/bin\/todos$/;

// Where this app's own copy of the command is: inside the bundle once packaged,
// and where `npm run dist` stages it when run from source.
export function bundledCli({ packaged, resourcesPath, root }) {
  return packaged ? path.join(resourcesPath, 'bin', 'todos') : path.join(root, 'build', 'bin', 'todos');
}

// Where the link goes. TODOS_BIN_DIR picks a different folder on the PATH.
export function cliLink({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.TODOS_BIN_DIR ? path.resolve(env.TODOS_BIN_DIR) : path.join(home, '.local', 'bin'), 'todos');
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// What is at `link` now:
//   none     nothing
//   ours     a link to `binary`, this app's copy
//   stale    a link into another copy of Todos.app (the app was moved or replaced)
//   foreign  anything else: someone else's link, or a real file. Never touched.
export function linkState(link, binary) {
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch (e) {
    if (e.code === 'ENOENT') return 'none';
    throw e;
  }
  if (!stat.isSymbolicLink()) return 'foreign';
  const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  if (target === binary) return 'ours';
  return INSIDE_TODOS.test(target) ? 'stale' : 'foreign';
}

// Why the command could not be installed or removed. `code` is no_binary or in_the_way.
export class CliInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Links `link` to `binary`. Replaces a link left by another copy of Todos, and
// refuses to replace anything else.
export function install(link, binary) {
  if (!isExecutable(binary)) throw new CliInstallError('no_binary', `This copy of Todos has no command-line tool inside it (expected at ${binary}).`);
  const state = linkState(link, binary);
  if (state === 'ours') return;
  if (state === 'foreign') throw new CliInstallError('in_the_way', `${link} already exists and was not put there by Todos.`);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  // Made under another name and moved into place, so there is never a moment with no command.
  const fresh = `${link}.${process.pid}.new`;
  fs.rmSync(fresh, { force: true });
  fs.symlinkSync(binary, fresh);
  fs.renameSync(fresh, link);
}

// Removes the link, if it is one Todos made. The copy inside the app is untouched.
export function uninstall(link, binary) {
  const state = linkState(link, binary);
  if (state === 'none') return;
  if (state === 'foreign') throw new CliInstallError('in_the_way', `${link} was not put there by Todos, so it has been left alone.`);
  fs.unlinkSync(link);
}

// What typing `todos` in a new terminal would run: the path the user's own login
// shell finds, null if it finds none, or undefined if the shell couldn't be asked.
export function resolvedByShell({ shell = process.env.SHELL || '/bin/zsh', timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(shell, ['-ilc', 'command -v todos'], { timeout }, (err, stdout) => {
      const found = String(stdout).trim().split('\n').filter((line) => line.startsWith('/')).pop();
      if (found) resolve(found);
      else resolve(err && (err.killed || err.code === 'ENOENT') ? undefined : null);
    });
    child.stdin?.end();
  });
}
