// Electron shell for the Todos dashboard. Runs the dashboard server in-process,
// shows it in a native window, keeps the Dock badge and menu bar item in sync with
// what's due, delivers reminder notifications, and provides quick capture: a global
// shortcut that opens a small floating panel for adding a task from any app.
// The bundled MCP server (src/mcp.js) is launched separately by Claude, using
// this app's binary in node mode (ELECTRON_RUN_AS_NODE=1).

import {
  app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, session, shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import {
  DATA_FILE, PORT, ROOT, dailySummary, dueGroups, load, markReminded, pendingReminders, summarize, today, updateTodo, watchStore,
} from '../src/store.js';
import { COOKIE } from '../src/auth.js';
import { createRemote } from '../src/remote.js';
import * as tailscale from '../src/tailscale.js';
import { showPairing } from './pairing.js';
import { startInDesktop, startInTerminal, tildify } from './handoff.js';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let captureWin = null;
let tray = null;
let dashboardUrl = null;
let quitting = false;
let remote = null; // remote-access state, shared with the server (created once the app is ready)
let onDefaultPort = true; // false if another program had our port and we fell back to a random one

// ---------- server ----------

// Prefer the well-known port so the dashboard also works in a browser; if
// something else holds it, fall back to any free port for the app window.
async function startDashboard() {
  try {
    return await startServer({ port: PORT, handoff, remote });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    onDefaultPort = false; // `tailscale serve` points at PORT, so other devices can't reach this one
    return startServer({ port: 0, handoff, remote });
  }
}

// ---------- hand off to Claude ----------

// Behind the dashboard's "Start with Claude" button (see src/server.js).
const handoff = {
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
    const remembered = todo.project ? settings.projectFolders[todo.project] : null;
    let folder = !chooseFolder && remembered && fs.existsSync(remembered) ? remembered : null;
    if (!folder) {
      showWindow();
      const picked = await dialog.showOpenDialog(win, {
        title: 'Start with Claude',
        message: `Choose the folder Claude should work in for “${clip(todo.title, 60)}”`,
        buttonLabel: 'Start Here',
        defaultPath: remembered || settings.lastFolder || app.getPath('home'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) return { started: false };
      [folder] = picked.filePaths;
    }
    if (target === 'terminal') await startInTerminal({ todo, folder, workDir: path.join(app.getPath('userData'), 'handoff') });
    else await startInDesktop({ todo, folder });
    if (todo.project) settings.projectFolders[todo.project] = folder;
    settings.lastFolder = folder;
    settings.handoffTarget = target;
    saveSettings();
    const where = target === 'terminal' ? 'Terminal' : 'the Claude app';
    updateTodo(todo.id, { assignee: 'claude', comment: `Handed this to Claude in ${tildify(folder)} (${where}).` }, 'me');
    return { started: true, target, folder: tildify(folder) };
  },
};

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
  win.once('ready-to-show', () => win.show());
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

// ---------- remote access ----------

// What the Remote Access menu shows. Only refreshed from Tailscale while the setting is on.
const NO_REMOTE_INFO = { tailscale: null, mapped: false, funnel: false, url: null, reachable: null };
let remoteInfo = NO_REMOTE_INFO;

const remoteAddress = (dnsName, httpsPort) => `https://${dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
const box = (options) => (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
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

function updateTray(todos) {
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
    { label: 'Open Todos', click: showWindow },
    { label: 'Quit Todos', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  if (process.env.TODOS_DEBUG) console.log(`tray: title="${tray.getTitle()}" menu=${JSON.stringify(template.map((item) => item.label || '---'))}`);
}

// Dock badge and menu bar count both show overdue + due today.
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
  updateTray(todos);
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

// Delivers reminders whose time has come (including ones missed while the app was
// closed), and once a day from 9:00 a summary of what's due today or overdue.
function checkReminders() {
  let todos;
  try {
    todos = load().todos;
  } catch {
    return; // data file unreadable right now; the next tick will retry
  }
  const t0 = today();

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
    const summary = dailySummary(todos);
    if (summary) notify({ title: summary.title, body: summary.body, onClick: showWindow });
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

app.setAboutPanelOptions({
  applicationName: 'Todos',
  applicationVersion: app.getVersion(),
  credits: 'A todo list shared between you and your Claude sessions.',
});

// `open -a Todos --args --capture` opens quick capture, so other launchers can trigger it too.
app.on('second-instance', (_event, argv) => (argv.includes('--capture') ? showCapture() : showWindow()));
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
});
app.on('activate', () => {
  if (dashboardUrl) showWindow();
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
    ({ url: dashboardUrl } = await startDashboard());
  } catch (e) {
    dialog.showErrorBox('Todos could not start', `The dashboard server failed to start:\n\n${e.message}`);
    app.quit();
    return;
  }
  await giveWindowsTheirCookie(); // before any window loads; harmless while remote access is off
  if (settings.remoteAccess) refreshRemote(); // not awaited: Tailscale may be slow, and the windows don't depend on it
  setInterval(() => settings.remoteAccess && refreshRemote(), 60_000);
  registerShortcut();
  buildMenu();
  createWindow();
  createCaptureWindow();
  refreshIndicators();
  watchStore(refreshIndicators);
  setInterval(refreshIndicators, 60_000); // "due today" rolls over at midnight
  if (process.argv.includes('--capture')) showCapture();

  setTimeout(checkReminders, 3_000);
  setInterval(checkReminders, 20_000);
  powerMonitor.on('resume', checkReminders); // catch up right after waking from sleep
});
