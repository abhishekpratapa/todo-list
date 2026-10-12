// "Start with Claude": opens a Claude Code session on a todo, in a folder the user
// picks. Two places it can open:
//
//   desktop   the Claude desktop app's Code tab, through its documented link
//             (claude://code/new?folder=...&q=...). The app shows the folder and
//             the prompt filled in; nothing runs until the user sends it.
//   terminal  an interactive `claude` session in Terminal, which starts on the
//             prompt right away and asks before acting, like one started by hand.
//             Only the todo tools are pre-approved.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Starts the session. `workDir` is where launcher files are kept (inside the app's
// data folder). Resolves once Terminal has been asked to open; rejects with a
// message suitable for showing to the user.
export function startInTerminal({ todo, folder, workDir }) {
  const claude = findClaude();
  if (!claude) {
    return Promise.reject(new Error('Could not find the claude command. Install Claude Code, or open the Claude desktop app once so it sets up its copy.'));
  }
  fs.mkdirSync(workDir, { recursive: true });
  const base = path.join(workDir, `todo-${todo.id}`);
  // The task text goes through files, never through the script itself, so nothing
  // in a title or prompt can be interpreted by the shell.
  fs.writeFileSync(`${base}.prompt.txt`, promptFor(todo));
  fs.writeFileSync(`${base}.name.txt`, `Todo #${todo.id}: ${todo.title}`.slice(0, 80));
  const script = [
    '#!/bin/zsh',
    `# Started by Todos for task #${todo.id}.`,
    `cd ${shellQuote(folder)} || { echo "Folder not found: ${tildify(folder).replace(/["$\`\\]/g, '')}"; exit 1; }`,
    // --allowedTools lets the session update the todo list without asking; everything else still asks.
    `exec ${shellQuote(claude)} --name "$(cat ${shellQuote(`${base}.name.txt`)})" --allowedTools mcp__todolist -- "$(cat ${shellQuote(`${base}.prompt.txt`)})"`,
    '',
  ].join('\n');
  const launcher = `${base}.command`;
  fs.writeFileSync(launcher, script, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);

  if (process.env.TODOS_HANDOFF_DRY_RUN) return Promise.resolve({ claude, launcher }); // tests: write the launcher, don't open it

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', 'Terminal', launcher], (err) => {
      if (err) reject(new Error(`Could not open Terminal: ${err.message}`));
      else resolve({ claude, launcher });
    });
  });
}

// Opens the Claude desktop app on a new Code session with the folder and prompt
// filled in. Rejects if no app handles claude:// links.
export function startInDesktop({ todo, folder }) {
  const url = `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(promptFor(todo))}`;
  if (process.env.TODOS_HANDOFF_DRY_RUN) return Promise.resolve({ url });
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], (err) => {
      if (err) reject(new Error('Could not open the Claude desktop app. Is it installed? You can switch to Terminal next to the button.'));
      else resolve({ url });
    });
  });
}
