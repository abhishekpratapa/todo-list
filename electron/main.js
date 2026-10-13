// Electron shell for the Todos dashboard. Runs the dashboard server in-process,
// shows it in a native window, keeps the Dock badge and menu bar item in sync with
// what's due and which habits are left today, delivers reminder notifications,
// and provides quick capture: a global shortcut that opens a small floating panel
// for adding a task from any app.
// The bundled MCP server (src/mcp.js) is launched separately by Claude, using
// this app's binary in node mode (ELECTRON_RUN_AS_NODE=1).

import {
  app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, session, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import {
  DATA_FILE, PORT, ROOT, dailySummary, dueGroups, load, markReminded, pendingReminders, summarize, today, watchStore,
} from '../src/store.js';
import { checkIn, listHabits, watchHabits } from '../src/habits.js';
import * as habitText from '../src/habit-text.js';
import { dueReminders } from '../src/habit-reminders.js';
import { localParts } from '../src/streaks.js';
import { COOKIE } from '../src/auth.js';
import { createRemote } from '../src/remote.js';
import { socketPath } from '../src/socket.js';
import * as tailscale from '../src/tailscale.js';
import { showPairing } from './pairing.js';
import { createHandoff } from './handoff.js';
import { bundledCli, cliLink, install as linkCli, linkState, onShellPath, uninstall as unlinkCli } from './cli-install.js';
import { tildify } from '../src/claude-session.js';

// TODOS_USER_DATA keeps a second copy (one run from source, or by the tests) apart
// from the installed app: its own settings, and its own "already running" lock,
// which lives in this folder. It has to be set before the lock is asked for.
if (process.env.TODOS_USER_DATA) app.setPath('userData', process.env.TODOS_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// `open -g -a Todos --args --background` starts the app with everything running
// (server, menu bar item, reminders, notifications) but opens no window and
// leaves whatever app was in front where it is. The command-line client does
// this when it needs the app and finds it not running.
const startedInBackground = process.argv.includes('--background');
const debug = (line) => process.env.TODOS_DEBUG && console.log(line);

let win = null;
let captureWin = null;
let tray = null;
let trayMenu = null; // what the menu bar item shows, kept so the tests can choose from it
let dashboardUrl = null;
let dashboard = null; // the running server: { url, port, socket, socketProblem, close() }
let quitting = false;
let remote = null; // remote-access state, shared with the server (created once the app is ready)
let onDefaultPort = true; // false if another program had our port and we fell back to a random one

// ---------- server ----------

// Prefer the well-known port so the dashboard also works in a browser; if
// something else holds it, fall back to any free port for the app window.
// The local socket (see src/socket.js) is opened either way, so the `todos`
// command reaches the app even when the port had to change.
async function startDashboard() {
  const options = { handoff, remote, socketPath: socketPath() };
  try {
    return await startServer({ port: PORT, ...options });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    onDefaultPort = false; // `tailscale serve` points at PORT, so other devices can't reach this one
    return startServer({ port: 0, ...options });
  }
}

// Why the `todos` command can't reach this copy of the app, or null if it can.
function socketTrouble() {
  if (!dashboard || dashboard.socket) return null;
  return dashboard.socketProblem?.message || 'No place for the socket has a short enough path. Set TODOS_SOCKET to one.';
}

// ---------- window ----------

const boundsFile = () => path.join(app.getPath('userData'), 'window-state.json');

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
    return visible ? b : { width: b.width, height: b.height };
  } catch {
    return {};
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds()));
  } catch {
    // non-fatal
  }
}

function isSafeExternal(url) {
  return /^(https?|mailto):/i.test(url);
}

function createWindow() {
  const b = savedBounds();
  win = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 840,
    x: b.x,
    y: b.y,
    minWidth: 420,
    minHeight: 480,
    title: 'Todos',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131312' : '#f5f5f2',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => {
    win.show();
    debug('window: shown');
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
  });

  // Links open in the default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(dashboardUrl)) return;
    e.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });

  win.loadURL(dashboardUrl);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Runs a snippet in the dashboard page (used by menu shortcuts).
function runInPage(js) {
  showWindow();
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.executeJavaScript(js));
  else wc.executeJavaScript(js);
}

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = {
  dailySummary: true,
  lastSummaryDate: null,
  reminderNotifications: true, // off for someone who gets their reminders on the iPhone instead
  habitNotifications: false, // habit reminders come from the iPhone; on for someone who wants them here too
  habitReminded: [], // the habit reminders already shown (see src/habit-reminders.js), so none is shown twice
  captureShortcut: 'Control+Alt+T',
  showTray: true,
  claudeNotifications: true,
  projectFolders: {}, // project name -> folder Claude works in for that project
  lastFolder: null,
  handoffTarget: 'desktop', // where "Start with Claude" opens sessions: 'desktop' or 'terminal'
  remoteAccess: false, // "Allow Access from My Other Devices"
  remoteOwnerOnly: true, // relayed requests must come from this Mac's own Tailscale account
};

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    // first run: keep defaults
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // non-fatal
  }
}

// ---------- hand off to Claude ----------

// Behind the dashboard's "Start with Claude" button, and behind what the `todos`
// command asks for on the local socket (see src/server.js and electron/handoff.js).
const handoff = createHandoff({
  settings,
  saveSettings,
  workDir: () => path.join(app.getPath('userData'), 'handoff'),
  async pickFolder(todo, startAt) {
    showWindow();
    const picked = await dialog.showOpenDialog(win, {
      title: 'Start with Claude',
      message: `Choose the folder Claude should work in for “${clip(todo.title, 60)}”`,
      buttonLabel: 'Start Here',
      defaultPath: startAt || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return picked.canceled ? null : picked.filePaths[0] || null;
  },
});

// ---------- remote access ----------

// What the Remote Access menu shows. Only refreshed from Tailscale while the setting is on.
const NO_REMOTE_INFO = { tailscale: null, mapped: false, funnel: false, url: null, reachable: null };
let remoteInfo = NO_REMOTE_INFO;

const remoteAddress = (dnsName, httpsPort) => `https://${dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
// With TODOS_DEBUG_DIALOGS set (the app's own tests do), a dialog is written to
// the log and answered with its default button instead of being shown.
function box(options) {
  if (process.env.TODOS_DEBUG_DIALOGS) {
    console.log(`dialog: ${JSON.stringify({ message: options.message, detail: options.detail, buttons: options.buttons })}`);
    return Promise.resolve({ response: options.defaultId ?? 0 });
  }
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
const tell = (message, detail) => box({ type: 'info', buttons: ['OK'], message, detail });

// The app's own windows get a session cookie signed with a key only this process
// has, so they keep working, with no sign-in, once everything else needs one.
function giveWindowsTheirCookie() {
  return session.defaultSession.cookies
    .set({ url: dashboardUrl, name: COOKIE, value: remote.appCookie(), httpOnly: true, sameSite: 'strict' })
    .catch((e) => console.error(`Could not set the window session cookie: ${e.message}`));
}

// Reads Tailscale's state: which names and account the server should accept, and
// whether the serve mapping is in place and actually answering.
async function refreshRemote() {
  let next = NO_REMOTE_INFO;
  if (settings.remoteAccess) {
    const ts = await tailscale.status();
    remote.hosts.clear();
    if (ts.dnsName) remote.hosts.add(ts.dnsName);
    remote.ownerLogin = ts.ownerLogin || null;
    const serve = ts.running ? await tailscale.serveStatus(PORT) : { mapped: false, funnel: false };
    const url = serve.mapped && ts.dnsName ? remoteAddress(ts.dnsName, serve.httpsPort) : null;
    // Ask our own public address for the health check, the way another device would.
    const reachable = url && onDefaultPort
      ? await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok, () => false)
      : null;
    next = { tailscale: ts, mapped: serve.mapped, funnel: serve.funnel, url, reachable };
  }
  const changed = JSON.stringify(next) !== JSON.stringify(remoteInfo);
  remoteInfo = next;
  if (changed) buildMenu();
  if (changed && process.env.TODOS_DEBUG) console.log(`remote access: ${remoteStatusLine()}`);
  // A new address can take up to a minute to answer the first time, while Tailscale
  // gets its certificate. Look again soon instead of waiting for the regular check.
  clearTimeout(recheck);
  if (next.mapped && next.reachable === false) recheck = setTimeout(refreshRemote, 10_000);
}
let recheck = null;

function remoteStatusLine() {
  if (!settings.remoteAccess) return 'Off';
  if (!onDefaultPort) return `Port ${PORT} is in use, so other devices can’t connect`;
  const { tailscale: ts, mapped, funnel, url, reachable } = remoteInfo;
  if (!ts) return 'Checking Tailscale…';
  if (!ts.installed) return 'Tailscale isn’t installed on this Mac';
  if (!ts.running) return 'Tailscale isn’t running';
  if (!mapped) return ts.httpsEnabled ? 'Not set up yet: choose Set Up Tailscale Serve' : 'HTTPS isn’t enabled for your tailnet yet';
  if (funnel) return 'Warning: Tailscale Funnel is on for this address';
  if (reachable === false) return 'Set up. Waiting for the address to answer…';
  return `On at ${url.replace('https://', '')}`;
}

async function setRemoteAccess(on) {
  settings.remoteAccess = on;
  saveSettings();
  if (on) await giveWindowsTheirCookie();
  remote.setEnabled(on);
  buildMenu();
  await refreshRemote();
  if (on && remoteInfo.tailscale?.running && !remoteInfo.mapped) setUpServe();
}

// The "Set Up Tailscale Serve" button: shows the one command, and runs it only on confirmation.
async function setUpServe() {
  const ts = await tailscale.status();
  if (!ts.installed) return tell('Tailscale isn’t installed', 'Install Tailscale on this Mac and sign in, then choose Set Up Tailscale Serve again.');
  if (!ts.running || !ts.dnsName) return tell('Tailscale isn’t running', 'Open Tailscale on this Mac and connect, then choose Set Up Tailscale Serve again.');
  const plan = await tailscale.planServe(PORT);
  if (plan.already) {
    await refreshRemote();
    return tell('Tailscale Serve is already set up', `Your other devices can open ${remoteAddress(ts.dnsName, plan.httpsPort)}`);
  }
  if (!plan.httpsPort) return tell('No free port', 'Tailscale Serve is already using ports 443, 8443 and 10000 for other things. Free one up and try again.');

  const address = remoteAddress(ts.dnsName, plan.httpsPort);
  const { response } = await box({
    type: 'question',
    buttons: ['Set Up', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Set up Tailscale Serve?',
    detail: `Todos will run this command once:\n\n${tailscale.serveCommand(PORT, plan.httpsPort)}\n\nIt makes Todos on this Mac available at ${address}, to devices on your tailnet only. Tailscale keeps this setting until you remove it.`,
  });
  if (response !== 0) return;

  const result = await tailscale.serveOn(PORT);
  await refreshRemote();
  if (!result.ok) return tell('Tailscale Serve could not be set up', result.error || 'The tailscale command failed.');
  const done = await box({
    type: 'info',
    buttons: ['Copy Address', 'OK'],
    defaultId: 0,
    message: 'Tailscale Serve is set up',
    detail: `On another device, open ${address} and enter your access token (Todos → Remote Access → Copy Access Token).`
      + (remoteInfo.reachable === false ? '\n\nThe address isn’t answering yet. The first time, Tailscale can take up to a minute to get its certificate. The Remote Access menu will say “On at …” when it’s ready.' : ''),
  });
  if (done.response === 0) clipboard.writeText(address);
}

async function removeServe() {
  const { response } = await box({
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Remove the Tailscale Serve mapping?',
    detail: 'Your other devices will no longer reach Todos on this Mac. Other Tailscale Serve mappings are left alone.',
  });
  if (response !== 0) return;
  const result = await tailscale.serveOff(PORT);
  await refreshRemote();
  if (!result.ok) tell('The mapping could not be removed', result.error || 'The tailscale command failed.');
}

async function showToken() {
  const { response } = await box({
    type: 'info',
    buttons: ['Copy', 'Done'],
    defaultId: 1,
    message: 'Access token',
    detail: `${remote.token}\n\nEnter it once on each device, or send it as a bearer token from scripts. Anyone on your tailnet with this token can read and change your todos.`,
  });
  if (response === 0) clipboard.writeText(remote.token);
}

async function rotateToken() {
  const { response } = await box({
    type: 'warning',
    buttons: ['Rotate', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Create a new access token?',
    detail: 'Every other device and script is signed out and needs the new token. This Mac’s own Todos window is not affected.',
  });
  if (response !== 0) return;
  remote.rotate();
  tell('New access token created', 'Use Todos → Remote Access → Copy Access Token to get it.');
}

function remoteMenu() {
  const on = settings.remoteAccess;
  const { tailscale: ts, mapped, url } = remoteInfo;
  return {
    label: 'Remote Access',
    submenu: [
      { label: 'Allow Access from My Other Devices', type: 'checkbox', checked: on, click: (item) => setRemoteAccess(item.checked) },
      { label: remoteStatusLine(), enabled: false },
      { label: 'Copy Address', enabled: !!url, click: () => clipboard.writeText(url) },
      mapped
        ? { label: 'Remove Tailscale Serve Mapping…', click: removeServe }
        : { label: 'Set Up Tailscale Serve…', enabled: on, click: setUpServe },
      { type: 'separator' },
      { label: 'Pair iPhone…', enabled: on && !!url, click: () => showPairing({ url, remote, dark: nativeTheme.shouldUseDarkColors, parent: win }) },
      { label: 'Copy Access Token', enabled: on, click: () => clipboard.writeText(remote.token) },
      { label: 'Show Access Token…', enabled: on, click: showToken },
      { label: 'Rotate Access Token…', enabled: on, click: rotateToken },
      { type: 'separator' },
      {
        label: `Only My Tailscale Account${ts?.ownerLogin ? ` (${ts.ownerLogin})` : ''}`,
        type: 'checkbox',
        checked: settings.remoteOwnerOnly,
        click: (item) => {
          settings.remoteOwnerOnly = item.checked;
          remote.requireOwner = item.checked;
          saveSettings();
        },
      },
    ],
  };
}

// ---------- command line tool ----------

// The `todos` command ships inside the app. "Install Command Line Tool" links it
// into a folder on the PATH, and "Uninstall" removes that link (see cli-install.js).
const cliPaths = () => ({ link: cliLink(), binary: bundledCli({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: ROOT }) });

function cliState() {
  const { link, binary } = cliPaths();
  try {
    return linkState(link, binary);
  } catch {
    return 'foreign'; // can't even look at it: not ours to touch
  }
}

// The line that puts `dir` on the PATH, and the file a login shell reads it from.
function pathAdvice(dir) {
  const home = app.getPath('home');
  const entry = dir.startsWith(`${home}/`) ? `$HOME${dir.slice(home.length)}` : dir;
  const shell = path.basename(process.env.SHELL || 'zsh');
  const file = { zsh: '~/.zprofile', bash: '~/.bash_profile' }[shell] || 'your shell’s startup file';
  return { line: `export PATH="${entry}:$PATH"`, file };
}

async function installCommandLineTool() {
  const { link, binary } = cliPaths();
  try {
    linkCli(link, binary);
  } catch (e) {
    const detail = e.code === 'in_the_way'
      ? `${tildify(link)} already exists and wasn’t put there by Todos, so it has been left alone. Move or remove it, then choose Install Command Line Tool again.`
      : e.message;
    return box({ type: 'warning', buttons: ['OK'], message: 'The todos command was not installed', detail });
  }
  buildMenu();
  debug('command line tool: installed');

  // Would a new terminal window find it? The shell's startup files say, without running anything.
  const installed = `${tildify(link)} now runs the copy of the command inside Todos.`;
  if (onShellPath(path.dirname(link))) {
    await tell('The todos command is installed', `${installed}\n\nOpen a new terminal window and type: todos`);
    return;
  }
  const { line, file } = pathAdvice(path.dirname(link));
  const { response } = await box({
    type: 'info',
    buttons: ['Copy Line', 'OK'],
    defaultId: 1,
    message: 'The todos command is installed',
    detail: `${installed}\n\n${tildify(path.dirname(link))} doesn’t seem to be on your PATH. If a new terminal window can’t find todos, add this line to ${file} and open another:\n\n${line}`,
  });
  if (response === 0) clipboard.writeText(line);
}

async function uninstallCommandLineTool() {
  const { link, binary } = cliPaths();
  try {
    unlinkCli(link, binary);
  } catch (e) {
    return box({ type: 'warning', buttons: ['OK'], message: 'The todos command was not removed', detail: e.message });
  }
  buildMenu();
  debug('command line tool: removed');
  await tell('The todos command was removed', `${tildify(link)} is gone. The copy inside Todos is untouched, and you can install it again at any time.`);
}

function commandLineMenu() {
  const state = cliState();
  const items = [
    { id: 'install-cli', label: 'Install Command Line Tool', enabled: state !== 'ours' && fs.existsSync(cliPaths().binary), click: installCommandLineTool },
    { id: 'uninstall-cli', label: 'Uninstall Command Line Tool', enabled: state === 'ours' || state === 'stale', click: uninstallCommandLineTool },
  ];
  // Only when something is wrong: the command reaches the app through the local socket.
  if (socketTrouble()) {
    items.push({ id: 'cli-trouble', label: 'Why the todos Command Can’t Connect…', click: () => tell('The todos command can’t reach this copy of Todos', socketTrouble()) });
  }
  return items;
}

// ---------- quick capture ----------

const CAPTURE_SIZE = { width: 680, height: 126 };
const SHORTCUTS = [
  { accelerator: 'Control+Alt+T', keys: '⌃⌥T' },
  { accelerator: 'Alt+Shift+Space', keys: '⌥⇧Space' },
  { accelerator: 'Control+Alt+N', keys: '⌃⌥N' },
];
let shortcutRegistered = false;

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    ...CAPTURE_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A panel takes keyboard focus without activating Todos, so the app you were
    // working in stays frontmost and gets focus back when the panel closes.
    type: 'panel',
    title: 'Quick Capture',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1d1b' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, 'electron', 'capture-preload.cjs'),
    },
  });
  captureWin.setAlwaysOnTop(true, 'floating');
  captureWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  captureWin.on('blur', hideCapture);
  captureWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // keep it loaded so it reopens instantly
    hideCapture();
  });
  captureWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  captureWin.webContents.on('will-navigate', (e) => e.preventDefault());
  captureWin.loadURL(`${dashboardUrl}/capture.html`);
}

function showCapture() {
  if (!captureWin || captureWin.isDestroyed()) createCaptureWindow();
  // Upper middle of whichever screen the pointer is on.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  captureWin.setPosition(
    Math.round(workArea.x + (workArea.width - CAPTURE_SIZE.width) / 2),
    Math.round(workArea.y + workArea.height * 0.22),
  );
  captureWin.show();
  captureWin.focus();
  captureWin.webContents.executeJavaScript('window.resetCapture?.()').catch(() => {});
}

function hideCapture() {
  if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) captureWin.hide();
}

function toggleCapture() {
  if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) hideCapture();
  else showCapture();
}

ipcMain.on('capture:hide', (event) => {
  if (captureWin && !captureWin.isDestroyed() && event.sender === captureWin.webContents) hideCapture();
});

// (Re)registers the global shortcut from settings. Registration fails if another app owns the keys.
function registerShortcut() {
  globalShortcut.unregisterAll();
  shortcutRegistered = false;
  if (settings.captureShortcut) {
    try {
      shortcutRegistered = globalShortcut.register(settings.captureShortcut, toggleCapture);
    } catch {
      shortcutRegistered = false;
    }
  }
  if (process.env.TODOS_DEBUG) console.log(`capture shortcut ${settings.captureShortcut || 'off'}: ${shortcutRegistered ? 'registered' : 'not registered'}`);
}

// ---------- Dock badge and menu bar item ----------

const clip = (text, max = 52) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// What the menu bar menu lists: overdue, due today, the next 7 days, then undated tasks.
function trayTaskItems(todos) {
  const due = dueGroups(todos);
  const dayName = (day) => new Date(day + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' });
  const groups = [['Overdue', due.overdue], ['Due today', due.today], ['Next 7 days', due.upcoming], ['No due date', due.undated]];

  const items = [];
  let room = 12; // keep the menu a glanceable length
  for (const [label, list] of groups) {
    if (!list.length || room <= 0) continue;
    items.push({ label, enabled: false });
    for (const t of list.slice(0, room)) {
      const suffix = label === 'Next 7 days' ? `  (${dayName(t.due)})` : '';
      items.push({ label: clip(t.title) + suffix, click: () => runInPage(`window.todos.open(${t.id})`) });
    }
    if (list.length > room) items.push({ label: `${list.length - room} more…`, click: showWindow });
    room -= Math.min(list.length, room);
    items.push({ type: 'separator' });
  }
  if (!items.length) items.push({ label: 'Nothing to do', enabled: false }, { type: 'separator' });
  return items;
}

// A slot's name for a menu item. One with no name adds nothing to the habit's own.
const slotLabel = (habit, id) => habit.schedule.slots?.find((s) => s.id === id)?.name || '';

// Habits still to do today, each checked in with a click, and yesterday's where a
// streak hangs on it. A click names the slot it showed, so the two always agree.
function trayHabitItems({ habits, zone }) {
  const { due, done } = habitText.forToday(habits);
  const risky = habitText.atRiskHabits(habits);
  if (!due.length && !done.length && !risky.length) return [];
  const log = (habit, input) => () => {
    try {
      checkIn(habit.id, input, 'me');
    } catch (e) {
      console.error(`Could not check in ${habit.name}: ${e.message}`);
    }
    refreshIndicators();
  };
  const left = habitText.leftToday(habits);
  const items = [{ label: left ? `Habits · ${left} left today` : 'Habits · all done today', enabled: false }];
  const { time } = localParts(Date.now(), zone);
  for (const h of due.slice(0, 8)) {
    const slot = habitText.nextSlot(h, time);
    const what = slot ? slotLabel(h, slot) : habitText.progress(h);
    items.push({ id: `habit-${h.id}`, label: [clip(h.name, 36), what].filter(Boolean).join(' · '), click: log(h, { slot }) });
  }
  if (due.length > 8) items.push({ label: `${due.length - 8} more…`, click: showWindow });
  if (risky.length) {
    items.push({ label: 'Still time for yesterday', enabled: false });
    for (const h of risky.slice(0, 4)) {
      const missing = h.streak.atRisk.missing;
      items.push({
        id: `habit-${h.id}-yesterday`,
        label: [clip(h.name, 36), missing.map((id) => slotLabel(h, id)).filter(Boolean).join(', ')].filter(Boolean).join(' · '),
        click: () => (missing.length ? missing : [undefined]).forEach((slot) => log(h, { slot, day: 'yesterday' })()),
      });
    }
  }
  items.push({ type: 'separator' });
  return items;
}

function updateTray(todos, habits) {
  if (!settings.showTray) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'electron', 'assets', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Todos');
  }
  const s = summarize(todos);
  const attention = s.overdue + s.due_today;
  tray.setTitle(attention ? ` ${attention}` : '');
  const template = [
    { label: 'New Task…', accelerator: shortcutRegistered ? settings.captureShortcut : undefined, registerAccelerator: false, click: showCapture },
    { type: 'separator' },
    ...trayTaskItems(todos),
    ...trayHabitItems(habits),
    { label: 'Open Todos', click: showWindow },
    { label: 'Quit Todos', click: () => app.quit() },
  ];
  trayMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(trayMenu);
  if (process.env.TODOS_DEBUG) console.log(`tray: title="${tray.getTitle()}" menu=${JSON.stringify(template.map((item) => item.label || '---'))}`);
}

// Habits as they stand now, or none if their file can't be read at the moment.
function habitsNow() {
  try {
    return listHabits();
  } catch {
    return { habits: [], zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
}

// Dock badge and menu bar count both show overdue + due today. Habits are listed
// in the menu but not counted: an evening habit is not something to do all day.
function refreshIndicators() {
  let todos;
  try {
    todos = load().todos;
  } catch {
    return; // data file mid-edit or unreadable; the next change will retry
  }
  const s = summarize(todos);
  const attention = s.overdue + s.due_today;
  app.dock?.setBadge(attention ? String(attention) : '');
  updateTray(todos, habitsNow());
  notifyClaudeUpdates(todos);
}

// ---------- notifications ----------

const SUMMARY_HOUR = 9;
const shown = new Set(); // holds notifications until dismissed so their click handlers stay alive

function notify({ title, body, onClick }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  shown.add(n);
  n.on('show', () => {
    if (process.env.TODOS_DEBUG) console.log(`notification shown: ${title}`);
  });
  n.on('click', () => {
    shown.delete(n);
    onClick?.();
  });
  n.on('close', () => shown.delete(n));
  n.on('failed', (_event, error) => {
    shown.delete(n);
    console.error(`Notification failed: ${error}`);
  });
  n.show();
}

function dueLabel(due, t0) {
  if (!due) return '';
  if (due < t0) return ' · overdue';
  if (due === t0) return ' · due today';
  return ` · due ${new Date(due + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

// Shows the habit reminders that have come due (see src/habit-reminders.js), each
// once. Only while "Habit Reminders on This Mac" is on.
function checkHabitReminders() {
  if (!settings.habitNotifications) return;
  const due = dueReminders(habitsNow().habits, Date.now(), settings.habitReminded);
  if (!due.length) return;
  settings.habitReminded = [...settings.habitReminded, ...due.map((r) => r.key)].slice(-60); // first, so none can be shown twice
  saveSettings();
  for (const r of due) notify({ title: r.title, body: r.body, onClick: () => runInPage(`window.todos.openHabit(${r.habit})`) });
}

// Delivers reminders whose time has come (including ones missed while the app was
// closed), and once a day from 9:00 a summary of what's due today or overdue,
// which habits today asks for, and any streak that hangs on finishing yesterday.
function checkReminders() {
  let todos;
  try {
    todos = load().todos;
  } catch {
    return; // data file unreadable right now; the next tick will retry
  }
  const t0 = today();
  checkHabitReminders();

  const due = pendingReminders(todos);
  if (due.length) {
    markReminded(due.map((t) => t.id)); // first, so a crash can't deliver the same reminder twice
    // With "Reminder Notifications on This Mac" off, the reminder is still marked as
    // delivered and still shows in the window, but nothing pops up or bounces here.
    const announce = settings.reminderNotifications;
    if (due.length <= 3) {
      for (const t of due) {
        if (announce) notify({ title: t.title, body: `Reminder${dueLabel(t.due, t0)}`, onClick: () => runInPage(`window.todos.open(${t.id})`) });
        // Also show it in the window, in case system notifications are turned off.
        if (win) win.webContents.executeJavaScript(`window.todos?.remind(${t.id}, ${JSON.stringify(t.title)})`).catch(() => {});
      }
    } else if (announce) {
      notify({ title: `${due.length} reminders`, body: due.map((t) => t.title).join(', '), onClick: showWindow });
    }
    if (announce) app.dock?.bounce('informational');
  }

  if (settings.dailySummary && settings.lastSummaryDate !== t0 && new Date().getHours() >= SUMMARY_HOUR) {
    settings.lastSummaryDate = t0;
    saveSettings();
    const parts = [dailySummary(todos), habitText.dailyHabitSummary(habitsNow().habits)].filter(Boolean);
    if (parts.length) notify({ title: parts.map((s) => s.title).join(' · '), body: parts.map((s) => s.body).join('\n'), onClick: showWindow });
  }
}

// ---------- notifications for Claude's updates ----------

// What we have already seen of each todo (status and number of activity entries),
// so only new activity from Claude sessions notifies. Null until the first load.
let seen = null;

// Notifies when a Claude session comments on a task, finishes it, or marks it blocked.
function notifyClaudeUpdates(todos) {
  const before = seen;
  seen = new Map(todos.map((t) => [t.id, { status: t.status, activity: t.activity.length }]));
  if (!before || !settings.claudeNotifications) return;
  if (win && win.isFocused()) return; // you're already looking at the board, where the card flashes

  const updates = [];
  for (const t of todos) {
    const prev = before.get(t.id);
    if (!prev) continue; // a task Claude just added: no need to announce it
    const fresh = t.activity.slice(prev.activity).filter((a) => a.by !== 'me');
    if (!fresh.length) continue;
    const who = fresh[fresh.length - 1].by.split(' · ')[0]; // "Claude Code · repo" -> "Claude Code"
    const comment = fresh.filter((a) => a.kind === 'comment').pop()?.text;
    const moved = (label) => prev.status !== t.status && fresh.some((a) => a.kind === 'event' && a.text.includes(`→ ${label}`));
    if (moved('Done')) updates.push({ t, title: `${who} finished: ${t.title}`, body: comment || 'Marked done.' });
    else if (moved('Blocked')) updates.push({ t, title: `${who} is blocked: ${t.title}`, body: comment || 'Marked blocked.' });
    else if (comment) updates.push({ t, title: `${who} commented: ${t.title}`, body: comment });
  }

  if (updates.length > 3) {
    notify({ title: `Claude updated ${updates.length} tasks`, body: updates.map((u) => u.t.title).join(', '), onClick: showWindow });
  } else {
    for (const u of updates) notify({ title: u.title, body: clip(u.body, 180), onClick: () => runInPage(`window.todos.open(${u.t.id})`) });
  }
}

// ---------- menu ----------

function mcpCommand() {
  const script = path.join(ROOT, 'src', 'mcp.js');
  return `claude mcp add todolist --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${process.execPath}" "${script}"`;
}

function setCaptureShortcut(accelerator) {
  settings.captureShortcut = accelerator;
  saveSettings();
  registerShortcut();
  buildMenu(); // both menus show the shortcut
  refreshIndicators();
}

function buildMenu() {
  const focusSearch = "document.getElementById('search').focus(); document.getElementById('search').select();";
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        {
          label: 'Reminder Notifications on This Mac',
          type: 'checkbox',
          checked: settings.reminderNotifications,
          click: (item) => {
            settings.reminderNotifications = item.checked;
            saveSettings();
          },
        },
        {
          id: 'habit-reminders',
          label: 'Habit Reminders on This Mac',
          type: 'checkbox',
          checked: settings.habitNotifications,
          click: (item) => {
            settings.habitNotifications = item.checked;
            saveSettings();
            if (item.checked) checkReminders(); // what is due right now, without waiting for the next look
          },
        },
        {
          label: 'Daily Summary at 9 AM',
          type: 'checkbox',
          checked: settings.dailySummary,
          click: (item) => {
            settings.dailySummary = item.checked;
            saveSettings();
          },
        },
        {
          label: 'Notify About Claude’s Updates',
          type: 'checkbox',
          checked: settings.claudeNotifications,
          click: (item) => {
            settings.claudeNotifications = item.checked;
            saveSettings();
          },
        },
        {
          label: 'Send Test Notification',
          click: () => notify({ title: 'Todos notifications are working', body: 'Reminders and the daily summary will look like this.', onClick: showWindow }),
        },
        { type: 'separator' },
        {
          label: 'Show in Menu Bar',
          type: 'checkbox',
          checked: settings.showTray,
          click: (item) => {
            settings.showTray = item.checked;
            saveSettings();
            refreshIndicators();
          },
        },
        {
          label: 'Quick Capture Shortcut',
          submenu: [
            ...SHORTCUTS.map(({ accelerator, keys }) => ({
              label: keys + (settings.captureShortcut === accelerator && !shortcutRegistered ? '  (in use by another app)' : ''),
              type: 'radio',
              checked: settings.captureShortcut === accelerator,
              click: () => setCaptureShortcut(accelerator),
            })),
            { label: 'Off', type: 'radio', checked: !settings.captureShortcut, click: () => setCaptureShortcut(null) },
          ],
        },
        remoteMenu(),
        ...commandLineMenu(),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Task', accelerator: 'CmdOrCtrl+N', click: () => runInPage("document.getElementById('qa-title').focus()") },
        // The accelerator is shown for reference; the global shortcut itself is registered separately.
        { label: 'Quick Capture', accelerator: shortcutRegistered ? settings.captureShortcut : undefined, registerAccelerator: false, click: showCapture },
        { type: 'separator' },
        { label: 'Open in Browser', accelerator: 'CmdOrCtrl+Shift+O', click: () => shell.openExternal(dashboardUrl) },
        { label: 'Show Data File in Finder', click: () => shell.showItemInFolder(DATA_FILE) },
        { label: 'Copy Claude Code Setup Command', click: () => clipboard.writeText(mcpCommand()) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => runInPage(focusSearch) },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------

// With TODOS_DEBUG set, SIGUSR2 prints what is open and whether the app is in
// front. The app's own tests ask this instead of guessing from the outside.
if (process.env.TODOS_DEBUG) {
  const windowState = (w) => (!w || w.isDestroyed() ? 'none' : w.isVisible() ? 'visible' : 'hidden');
  const enabled = (id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled ?? null;
  process.on('SIGUSR2', () => {
    // A menu item named in <settings folder>/debug-click is chosen first, as if from
    // the menu (the application's, or the menu bar item's).
    const request = path.join(app.getPath('userData'), 'debug-click');
    if (fs.existsSync(request)) {
      const id = fs.readFileSync(request, 'utf8').trim();
      fs.rmSync(request);
      (Menu.getApplicationMenu()?.getMenuItemById(id) ?? trayMenu?.getMenuItemById(id))?.click();
      console.log(`clicked: ${id}`);
    }
    console.log(`state: ${JSON.stringify({
      active: app.isActive(), window: windowState(win), capture: windowState(captureWin), tray: !!tray, socket: dashboard?.socket || null,
      menu: { install: enabled('install-cli'), uninstall: enabled('uninstall-cli') },
    })}`);
  });
}

app.setAboutPanelOptions({
  applicationName: 'Todos',
  applicationVersion: app.getVersion(),
  credits: 'A todo list shared between you and your Claude sessions.',
});

// `open -a Todos --args --capture` opens quick capture, so other launchers can trigger it too.
// A second copy started with --background wanted the app running, and it is.
app.on('second-instance', (_event, argv) => {
  if (argv.includes('--capture')) showCapture();
  else if (!argv.includes('--background')) showWindow();
});
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
});
// Stops the server, which also removes the local socket's file.
app.on('will-quit', () => dashboard?.close());
// The command line items say what is on disk now, which can change while the app is in the background.
app.on('did-become-active', () => dashboardUrl && buildMenu());

// macOS sends this when the app is opened while it is already running: a Dock
// click, Spotlight, `open -a Todos`. It sends the very same thing for `open -g`,
// which asks for nothing to come to the front, and by then any --args are gone
// (they only reach a copy that is being started). What tells the two apart is
// whether the app was made active: an ordinary open activates it just before
// this arrives, and `open -g` never does. So the window is shown only once the
// app is active, with a moment's grace in case activation is still on its way.
let reopening = null;
app.on('activate', () => {
  if (!dashboardUrl) return;
  if (app.isActive()) return showWindow();
  if (reopening) return;
  const onActive = () => {
    clearTimeout(reopening.timer);
    reopening = null;
    showWindow();
  };
  reopening = {
    timer: setTimeout(() => {
      app.removeListener('did-become-active', onActive);
      reopening = null;
      debug('reopen: ignored, the app was opened in the background');
    }, 500),
  };
  app.once('did-become-active', onActive);
});
app.on('window-all-closed', () => {
  // macOS convention: stay running (server and Dock badge stay live) until Quit.
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(async () => {
  loadSettings();
  remote = createRemote({
    tokenFile: path.join(app.getPath('userData'), 'remote-access-token'),
    enabled: settings.remoteAccess,
    requireOwner: settings.remoteOwnerOnly,
  });
  remote.deviceName = tailscale.deviceName;
  try {
    dashboard = await startDashboard();
    dashboardUrl = dashboard.url;
  } catch (e) {
    dialog.showErrorBox('Todos could not start', `The dashboard server failed to start:\n\n${e.message}`);
    app.quit();
    return;
  }
  await giveWindowsTheirCookie(); // before any window loads; harmless while remote access is off
  if (settings.remoteAccess) refreshRemote(); // not awaited: Tailscale may be slow, and the windows don't depend on it
  setInterval(() => settings.remoteAccess && refreshRemote(), 60_000);
  if (socketTrouble()) console.error(`No local socket for the todos command: ${socketTrouble()}`);
  debug(`started: pid=${process.pid} background=${startedInBackground} port=${dashboard.port} socket=${dashboard.socket || 'none'}`);
  registerShortcut();
  buildMenu();
  if (!startedInBackground) createWindow(); // otherwise the window waits until the app is opened in the usual way
  createCaptureWindow();
  refreshIndicators();
  watchStore(refreshIndicators);
  watchHabits(refreshIndicators);
  setInterval(refreshIndicators, 60_000); // "due today" rolls over at midnight
  if (process.argv.includes('--capture')) showCapture();

  setTimeout(checkReminders, 3_000);
  setInterval(checkReminders, 20_000);
  powerMonitor.on('resume', checkReminders); // catch up right after waking from sleep
});
