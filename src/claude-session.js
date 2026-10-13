// "Start with Claude": what a Claude Code session on a task is started with, and
// what is recorded once one has been. There is one implementation, used by the
// desktop app's button (electron/handoff.js, which opens the session itself) and
// by the socket's claude-session routes (api-v1.js, for the `todos` command,
// which runs `claude` in the user's own terminal). Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateTodo } from './store.js';

const HOME = os.homedir();

export const tildify = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p);

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Newest copy of the CLI that the Claude desktop app keeps for its own use.
function bundledClaude() {
  const root = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 6) walk(full, depth + 1);
      else if (entry.name === 'claude' && isExecutable(full)) found.push(full);
    }
  };
  walk(root, 0);
  // Paths look like .../claude-code/2.1.295/<build>/claude.app/...; compare by version.
  const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  return found.sort(byVersion).pop() || null;
}

// Where the `claude` command lives: the usual install locations first, then the desktop app's copy.
// Set TODOS_CLAUDE_BIN to point at a specific one.
export function findClaude() {
  if (process.env.TODOS_CLAUDE_BIN) return isExecutable(process.env.TODOS_CLAUDE_BIN) ? process.env.TODOS_CLAUDE_BIN : null;
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    path.join(HOME, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find(isExecutable) || bundledClaude();
}

// The opening message for the session. The todolist tools carry the rest of the
// instructions (how to report progress), so this stays short.
export function promptFor(todo) {
  return [
    `Work on task #${todo.id} from my todo list: ${todo.title}`,
    '',
    `Start by calling todo_get for #${todo.id} to read its notes and subtasks. Keep the todo updated as you go: `
      + 'mark it in progress, check off subtasks as you finish them, and leave short progress comments. '
      + 'When the work is finished, mark it done with a comment saying what you did. '
      + 'If you need a decision or anything else from me, mark it blocked and say what you need in a comment.',
  ].join('\n');
}

// What the session is called in Claude's own list. No trailing line break: the
// app's launcher reads each argument back from a file, which would drop one.
const sessionName = (todo) => `Todo #${todo.id}: ${todo.title}`.slice(0, 80).replace(/\n+$/, '');

// Everything a session on `todo` is started with. To start one, run
// `claude <args...> -- <prompt>` in `folder`:
//   prompt   the opening message
//   folder   where Claude should work, or null when that is still to be chosen
//   args     the options `claude` is given. --allowedTools lets the session update
//            the todo list without asking; everything else still asks.
//   claude   where the `claude` command was found on this Mac, or null
export function sessionFor(todo, folder = null) {
  return {
    prompt: promptFor(todo),
    folder,
    args: ['--name', sessionName(todo), '--allowedTools', 'mcp__todolist'],
    claude: findClaude(),
  };
}

// What the task's activity says once a session has been started, by where it was started from.
const STARTED = {
  desktop: (folder) => `Handed this to Claude in ${tildify(folder)} (the Claude app).`,
  terminal: (folder) => `Handed this to Claude in ${tildify(folder)} (Terminal).`,
  'command line': (folder) => (folder ? `Started with Claude from terminal in ${tildify(folder)}.` : 'Started with Claude from terminal.'),
};

// The two things Start with Claude does that don't depend on how the session is
// opened. Whoever runs the server says where folders are remembered:
//   folderFor(todo)         the folder to suggest for a task, or null
//   remember(todo, folder)  called with the folder a session was started in
// The desktop app remembers one per project. Without it there is nothing to remember.
export function createSessions({ folderFor = () => null, remember = () => {} } = {}) {
  return {
    // What a session on this task would be started with.
    session: (todo) => sessionFor(todo, folderFor(todo)),

    // Records that one was started: the task becomes Claude's, its activity says
    // so, and the folder is remembered. `from` is 'desktop', 'terminal' (the app's
    // button) or 'command line'. Returns { todo, next } like any other change.
    started(todo, { folder = null, from = 'command line', via, key } = {}) {
      if (folder) remember(todo, folder);
      return updateTodo(todo.id, { assignee: 'claude', comment: STARTED[from](folder) }, 'me', { via, key });
    },
  };
}
