// "Install Command Line Tool": puts the `todos` command on the PATH by linking
// ~/.local/bin/todos to the copy inside the app bundle. A link, not a copy, so
// the command is always the one that came with the installed app. No admin
// password is involved, and nothing here runs anything as root.
//
// The menu items and their dialogs are in main.js. This is the part that touches
// the disk, kept free of Electron so it can be tested. Node built-ins only.

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

// Whether a new terminal window is likely to find commands in `dir`: true if one
// of the shell's startup files, or the system's own list of paths, mentions the
// folder. The files are only read. Asking the shell itself would mean running
// the user's startup files from inside the app, and whatever those do would be
// done in the app's name: macOS then asks whether "Todos" may read the folders
// they happen to touch.
const STARTUP_FILES = {
  zsh: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'],
  bash: ['.bash_profile', '.bash_login', '.profile', '.bashrc'],
  fish: ['.config/fish/config.fish'],
};

export function onShellPath(dir, { home = os.homedir(), shell = process.env.SHELL || '/bin/zsh', systemPaths = ['/etc/paths', '/etc/paths.d'] } = {}) {
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  // The ways the folder is usually written: in full, or from the home folder.
  const rest = dir.startsWith(`${home}/`) ? dir.slice(home.length) : null;
  const spellings = [dir, ...(rest ? [`$HOME${rest}`, `\${HOME}${rest}`, `~${rest}`] : [])];
  const startup = (STARTUP_FILES[path.basename(shell)] || ['.profile']).map((file) => read(path.join(home, file)));
  if (startup.some((text) => spellings.some((spelling) => text.includes(spelling)))) return true;

  // /etc/paths and the files in /etc/paths.d list one folder a line, for every shell.
  const lists = systemPaths.flatMap((entry) => {
    try {
      return fs.statSync(entry).isDirectory() ? fs.readdirSync(entry).map((name) => path.join(entry, name)) : [entry];
    } catch {
      return [];
    }
  });
  return lists.some((file) => read(file).split('\n').some((line) => line.trim() === dir));
}
