// "Start with Claude": opens a Claude Code session on a todo, in a folder the user
// picks. Two places it can open:
//
//   desktop   the Claude desktop app's Code tab, through its documented link
//             (claude://code/new?folder=...&q=...). The app shows the folder and
//             the prompt filled in; nothing runs until the user sends it.
//   terminal  an interactive `claude` session in Terminal, which starts on the
//             prompt right away and asks before acting, like one started by hand.
//             Only the todo tools are pre-approved.
//
// What a session is started with, and what is recorded once it has been, come
// from src/claude-session.js. The `todos` command gets exactly the same through
// the local socket and runs `claude` itself. This file is the part only the
// desktop app does: choosing the folder and opening the session.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createSessions, sessionFor, tildify } from '../src/claude-session.js';

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Starts the session. `workDir` is where launcher files are kept (inside the app's
// data folder). Resolves once Terminal has been asked to open; rejects with a
// message suitable for showing to the user.
export function startInTerminal({ todo, session, workDir }) {
  const { claude, folder } = session;
  if (!claude) {
    return Promise.reject(new Error('Could not find the claude command. Install Claude Code, or open the Claude desktop app once so it sets up its copy.'));
  }
  fs.mkdirSync(workDir, { recursive: true });
  const base = path.join(workDir, `todo-${todo.id}`);
  // The task text goes through files, never through the script itself, so nothing
  // in a title or prompt can be interpreted by the shell. Every argument is read
  // back from a file of its own.
  const fromFile = (name, text) => {
    const file = `${base}.${name}.txt`;
    fs.writeFileSync(file, text);
    return `"$(cat ${shellQuote(file)})"`;
  };
  const script = [
    '#!/bin/zsh',
    `# Started by Todos for task #${todo.id}.`,
    `cd ${shellQuote(folder)} || { echo "Folder not found: ${tildify(folder).replace(/["$\`\\]/g, '')}"; exit 1; }`,
    `exec ${shellQuote(claude)} ${session.args.map((arg, i) => fromFile(`arg${i}`, arg)).join(' ')} -- ${fromFile('prompt', session.prompt)}`,
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
export function startInDesktop({ session }) {
  const url = `claude://code/new?folder=${encodeURIComponent(session.folder)}&q=${encodeURIComponent(session.prompt)}`;
  if (process.env.TODOS_HANDOFF_DRY_RUN) return Promise.resolve({ url });
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], (err) => {
      if (err) reject(new Error('Could not open the Claude desktop app. Is it installed? You can switch to Terminal next to the button.'));
      else resolve({ url });
    });
  });
}

// What the server is given as `handoff`: the dashboard's "Start with Claude"
// button (info and start), and the socket's claude-session routes (session and
// started). The app supplies:
//   settings       its settings: handoffTarget, projectFolders, lastFolder
//   saveSettings   writes them
//   pickFolder     (todo, startAt) asks the user for a folder; resolves to it, or to null if they cancel
//   workDir        () => where launcher files are kept
export function createHandoff({ settings, saveSettings, pickFolder, workDir }) {
  const remembered = (todo) => (todo.project && settings.projectFolders[todo.project]) || null;
  // The folder remembered for the task's project, as long as it is still there.
  const folderFor = (todo) => {
    const folder = remembered(todo);
    return folder && fs.existsSync(folder) ? folder : null;
  };
  const sessions = createSessions({
    folderFor,
    remember(todo, folder) {
      if (todo.project) settings.projectFolders[todo.project] = folder;
      settings.lastFolder = folder;
      saveSettings();
    },
  });

  return {
    ...sessions,

    // Folders remembered per project and the last-used target, shown next to the button.
    info() {
      return {
        target: settings.handoffTarget,
        folders: Object.fromEntries(Object.entries(settings.projectFolders).map(([project, folder]) => [project, tildify(folder)])),
      };
    },

    // Picks the folder (remembered for the task's project, or asked for), opens the
    // session there, and marks the task as Claude's.
    async start(todo, { chooseFolder = false, target = settings.handoffTarget } = {}) {
      if (target !== 'desktop' && target !== 'terminal') target = 'desktop';
      let folder = chooseFolder ? null : folderFor(todo);
      if (!folder) {
        folder = await pickFolder(todo, remembered(todo) || settings.lastFolder);
        if (!folder) return { started: false };
      }
      const session = sessionFor(todo, folder);
      if (target === 'terminal') await startInTerminal({ todo, session, workDir: workDir() });
      else await startInDesktop({ session });
      settings.handoffTarget = target;
      sessions.started(todo, { folder, from: target });
      return { started: true, target, folder: tildify(folder) };
    },
  };
}
