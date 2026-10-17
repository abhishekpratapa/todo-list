import { render as renderMarkdown, inline as inlineMarkdown } from '/markdown.js';
import { createHabits } from '/habits.js';
import { createListControls } from '/lists.js';
import { TODAY_VIEW, matches, parseFilter, sortTasks, todayView } from '/query.js';

const STATUSES = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];
const WEEK_MS = 7 * 864e5;
const REPEAT_LABELS = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' };

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 18l-1 3 4-2h9a3 3 0 003-3V8a3 3 0 00-3-3H7a3 3 0 00-3 3v7"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="3.5"/><path d="M5.5 19.5a7 7 0 0113 0"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 3l3 3-3 3M20 6H8a4 4 0 00-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 004-4v-1"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0112 0v5l1.5 2.5h-15zM10 21h4"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M3.5 7l1.7 1.7L8.5 5.5M3.5 16l1.7 1.7 3.3-3.2M12 7h8.5M12 16h8.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const state = {
  todos: [],
  summary: {},
  version: -1,
  showAllDone: false,
  openId: null,
  handoff: null, // { target, folders: { project: '~/path' } } when the desktop app can start Claude sessions
  host: null, // the other Mac whose list this is, when the app is set to use one
  handoffChoice: null, // target picked in the drawer; the app remembers it once a session is started
  editingNotes: false,
  flash: new Set(), // ids changed by Claude since the last refresh, highlighted once
};

const $ = (sel) => document.querySelector(sel);
const byId = (id) => state.todos.find((t) => t.id === id);

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymdOf(new Date());

// ISO timestamp -> value for <input type="datetime-local"> (local time).
function toLocalInput(iso) {
  const d = new Date(iso);
  return `${ymdOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDay(ymd) {
  return new Date(ymd + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function remindText(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const diff = dayDiff(ymdOf(d));
  if (diff === 0) return time;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function dayDiff(ymd) {
  return Math.round((new Date(ymd + 'T00:00') - new Date(todayStr() + 'T00:00')) / 864e5);
}

function dueChip(t) {
  if (!t.due) return '';
  const diff = dayDiff(t.due);
  const date = new Date(t.due + 'T00:00');
  let text;
  let cls = '';
  if (t.status === 'done') text = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  else if (diff < 0) { text = diff === -1 ? 'Yesterday' : `${-diff}d overdue`; cls = 'overdue'; }
  else if (diff === 0) { text = 'Today'; cls = 'today'; }
  else if (diff === 1) text = 'Tomorrow';
  else if (diff < 7) text = date.toLocaleDateString(undefined, { weekday: 'short' });
  else text = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return `<span class="chip ${cls}" title="Due ${esc(t.due)}">${ICONS.cal}${esc(text)}</span>`;
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const actorName = (by) => (by === 'me' ? 'You' : by);
// "You · iPhone" when a change came from another device or an API client.
const who = (a) => actorName(a.by) + (a.via ? ` · ${a.via}` : '');
// Dragging cards is for a mouse or trackpad. On touch it fights with scrolling,
// and the status buttons in the detail panel do the same job.
const CAN_DRAG = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const avatar = (by) => (by === 'me' ? `<span class="avatar">${ICONS.user}</span>` : `<span class="avatar claude">${ICONS.spark}</span>`);

let toastTimer;
function toast(msg, { ms = 3500, onClick = null } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('clickable', !!onClick);
  el.onclick = () => {
    el.hidden = true;
    onClick?.();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.replace('/login'); // signed out, or the access token was rotated
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// The Habits strip above the board and the panel a habit opens in (see habits.js).
const habits = createHabits({ api, toast, esc, closeTask: () => state.openId !== null && closeDrawer() });

// Board or Today, the filters, the sort and the search box (see lists.js).
const lists = createListControls({ esc, changed: render });

async function refresh() {
  try {
    const data = await api('GET', '/api/todos');
    const before = new Map(state.todos.map((t) => [t.id, t.updatedAt]));
    if (state.version !== -1) {
      for (const t of data.todos) {
        const last = t.activity[t.activity.length - 1];
        if (before.get(t.id) !== t.updatedAt && last && last.by !== 'me') state.flash.add(t.id);
      }
    }
    state.todos = data.todos;
    state.handoff = data.handoff || null;
    state.host = data.host || null;
    if ($('#live').classList.contains('on')) showLive();
    $('#page-foot').hidden = data.session !== 'remote'; // only a signed-in browser has anything to sign out of
    state.summary = data.summary;
    state.version = data.version;
    render();
    state.flash.clear();
  } catch (e) {
    toast(e.message);
  }
}

// Applies a patch to the local copy so the UI responds before the server confirms.
function applyOptimistic(t, fields) {
  for (const key of ['title', 'notes', 'status', 'priority', 'assignee', 'due', 'project', 'tags', 'repeat']) {
    if (key in fields) t[key] = fields[key];
  }
  if (fields.status) t.completedAt = fields.status === 'done' ? new Date().toISOString() : null;

  const ids = (key) => (fields[key] || []).map(Number);
  for (const sub of t.subtasks) {
    if (ids('check_subtasks').includes(sub.id)) sub.done = true;
    if (ids('uncheck_subtasks').includes(sub.id)) sub.done = false;
    if (fields.rename_subtask?.id === sub.id) sub.title = fields.rename_subtask.title;
  }
  if (fields.remove_subtasks) t.subtasks = t.subtasks.filter((sub) => !ids('remove_subtasks').includes(sub.id));
  let nextId = Math.max(0, ...t.subtasks.map((sub) => sub.id)) + 1;
  for (const title of fields.add_subtasks || []) t.subtasks.push({ id: nextId++, title, done: false });
}

// Changes are sent one at a time, so each sees the result of the one before it.
let sending = Promise.resolve();

// `guard` is for edits that replace a value (title, notes, due date...): the change
// is refused if the task was changed somewhere else since this page last loaded it,
// instead of silently overwriting that. Additive changes (comments, checking a
// subtask, moving a card) don't need it.
function patch(id, fields, { guard = false } = {}) {
  const t = byId(id);
  if (t) applyOptimistic(t, fields);
  render();
  sending = sending.then(async () => {
    const current = byId(id);
    let draft = null;
    try {
      const { todo, next } = await api('PATCH', `/api/todos/${id}`, guard && current ? { ...fields, rev: current.rev } : fields);
      if (current && todo) current.rev = todo.rev;
      if (next) toast(`Repeats ${REPEAT_LABELS[next.repeat].toLowerCase()}. The next one is due ${fmtDay(next.due)}.`);
    } catch (e) {
      if (e.status === 409) {
        if ('notes' in fields) draft = fields.notes;
        toast(draft === null
          ? 'This task was changed somewhere else. Showing the latest version.'
          : 'These notes were changed somewhere else. Your text is still in the editor: check it and save again.', { ms: 8000 });
      } else {
        toast(e.message);
      }
    }
    await refresh();
    if (draft !== null && state.openId === id) {
      editNotes();
      $('#d-notes').value = draft;
    }
  }).catch(() => {}); // one failed change must not block the ones after it
  return sending;
}

// The "Live" badge, which also says whose list this is when it is another Mac's.
function showLive() {
  const live = $('#live');
  live.className = 'live on';
  live.textContent = state.host ? `Live · ${state.host}` : 'Live';
  live.title = state.host
    ? `This is the list on ${state.host}. Changes made there, or by Claude sessions, appear here automatically`
    : 'Changes from Claude sessions appear here automatically';
}

function connect() {
  const live = $('#live');
  const es = new EventSource('/api/events');
  const onVersion = (e) => {
    if (JSON.parse(e.data).version !== state.version) refresh();
  };
  es.addEventListener('hello', (e) => {
    showLive();
    onVersion(e);
    habits.refresh();
  });
  es.addEventListener('change', onVersion);
  es.addEventListener('habits', () => habits.refresh());
  let probed = 0;
  es.onerror = () => {
    live.className = 'live off';
    live.textContent = 'Offline';
    live.title = state.host ? `Lost connection to ${state.host}. Retrying…` : 'Lost connection to the dashboard server. Retrying…';
    // The stream also drops when this device is signed out; api() sends us to sign in then.
    if (Date.now() - probed > 10_000) {
      probed = Date.now();
      api('GET', '/api/todos').catch(() => {});
    }
  };
}

// ---------- filtering ----------

// What to show is decided by /query.js, the rules the server and the other
// clients use. The search box adds one thing of its own: "#12" finds task 12.
function searched(list) {
  const q = lists.query();
  const words = parseFilter({ q });
  const id = Number(/^#(\d+)$/.exec(q)?.[1]);
  return list.filter((t) => t.id === id || matches(t, words, todayStr()));
}

// The board: the filters, then the search.
function visibleTodos() {
  const { q, ...filter } = lists.filter();
  const f = parseFilter(filter);
  return searched(state.todos.filter((t) => matches(t, f, todayStr())));
}

// ---------- rendering ----------

function render() {
  renderStats();
  renderLists();
  renderBoard();
  renderDrawer();
}

// Each tile is a shortcut to the filter it counts (see lists.js).
function renderStats() {
  const s = state.summary;
  const active = lists.view === 'board' ? lists.tile() : null;
  const tiles = [
    { focus: '', num: s.open ?? 0, label: 'Open' },
    { focus: 'today', num: s.due_today ?? 0, label: 'Due today' },
    { focus: 'overdue', num: s.overdue ?? 0, label: 'Overdue', alert: s.overdue > 0 },
    { focus: 'claude', num: s.claude ?? 0, label: 'With Claude' },
    { focus: 'done', num: s.done_7d ?? 0, label: 'Done this week' },
  ];
  $('#stats').innerHTML = tiles.map((x) => `
    <button class="stat${active === x.focus ? ' active' : ''}${x.alert ? ' alert' : ''}" data-focus="${x.focus}" aria-pressed="${active === x.focus}">
      <span class="num">${x.num}</span>
      <span class="lbl"><i></i>${x.label}</span>
    </button>`).join('');
}

function renderLists() {
  lists.render({ todos: state.todos, summary: state.summary });
  const all = [...new Set(state.todos.map((t) => t.project).filter(Boolean))].sort();
  $('#project-list').innerHTML = all.map((p) => `<option value="${esc(p)}"></option>`).join('');
}

function subtaskChip(t) {
  if (!t.subtasks.length) return '';
  const done = t.subtasks.filter((sub) => sub.done).length;
  const pct = Math.round((done / t.subtasks.length) * 100);
  return `<span class="chip subs${done === t.subtasks.length ? ' complete' : ''}" title="${done} of ${t.subtasks.length} subtasks done">${ICONS.list}${done}/${t.subtasks.length}<span class="bar"><i style="width:${pct}%"></i></span></span>`;
}

function remindChip(t) {
  if (!t.remindAt || t.remindedAt || t.status === 'done') return '';
  const late = Date.parse(t.remindAt) < Date.now();
  return `<span class="chip${late ? ' overdue' : ''}" title="Reminder: ${esc(new Date(t.remindAt).toLocaleString())}">${ICONS.bell}${esc(remindText(t.remindAt))}</span>`;
}

// `listed`: a row in the Today list, which has no status columns, so the card
// says itself when a task is under way or stuck, and can't be dragged anywhere.
function cardHtml(t, { listed = false } = {}) {
  const last = t.activity[t.activity.length - 1];
  const comments = t.activity.filter((a) => a.kind === 'comment').length;
  const flash = state.flash.has(t.id);

  const chips = [
    listed && t.status === 'in_progress' ? '<span class="chip under-way">In progress</span>' : '',
    listed && t.status === 'blocked' ? '<span class="chip stuck">Blocked</span>' : '',
    t.priority === 'high' ? '<span class="chip prio-high">High</span>' : '',
    t.priority === 'low' ? '<span class="chip prio-low">Low</span>' : '',
    dueChip(t),
    t.repeat ? `<span class="chip" title="Repeats: ${REPEAT_LABELS[t.repeat]}">${ICONS.repeat}${REPEAT_LABELS[t.repeat]}</span>` : '',
    remindChip(t),
    subtaskChip(t),
    t.project ? `<span class="chip project">${esc(t.project)}</span>` : '',
    t.assignee === 'claude' && t.status !== 'done' ? `<span class="chip claude">${ICONS.spark}Claude</span>` : '',
    ...t.tags.map((tag) => `<span class="chip tag">@${esc(tag)}</span>`),
  ].join('');

  return `
    <article class="card prio-${t.priority}${t.status === 'done' ? ' done' : ''}${state.openId === t.id ? ' selected' : ''}${flash ? ' flash' : ''}"
             draggable="${CAN_DRAG && !listed}" data-id="${t.id}" tabindex="0" aria-label="${esc(t.title)}">
      <button class="check" data-check aria-label="${t.status === 'done' ? 'Mark not done' : 'Mark done'}">${ICONS.check}</button>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">${chips}</div>
      <div class="card-foot">
        ${last ? `${avatar(last.by)}<span class="who" title="${esc(who(last))} ${esc(last.text)}">${esc(who(last))} · ${ago(last.at)}</span>` : ''}
        ${comments ? `<span class="comments" title="${comments} comment${comments === 1 ? '' : 's'}">${ICONS.chat}${comments}</span>` : ''}
      </div>
    </article>`;
}

function renderBoard() {
  const today = lists.view === 'today';
  $('#board').classList.toggle('today-view', today);
  $('#board').innerHTML = today ? todayHtml() : boardHtml();
}

// The columns, each in the order the Sort menu says.
function boardHtml() {
  const list = visibleTodos();
  return STATUSES.map(({ key, label }) => {
    let items = sortTasks(list.filter((t) => t.status === key), lists.sort());
    let hidden = 0;
    if (key === 'done' && !state.showAllDone) {
      const recent = items.filter((t) => Date.now() - Date.parse(t.completedAt) < WEEK_MS);
      hidden = items.length - recent.length;
      items = recent;
    }
    const emptyText = { todo: 'Nothing to do 🎉', in_progress: 'Nothing in progress', blocked: 'Nothing blocked', done: 'Nothing finished this week' }[key];
    return `
      <div class="column" data-status="${key}">
        <div class="col-head"><span class="dot"></span>${label}<span class="count">${items.length}</span></div>
        ${items.length ? items.map((t) => cardHtml(t)).join('') : `<div class="empty">${emptyText}</div>`}
        ${hidden ? `<button class="pill more" data-show-done>Show ${hidden} older</button>` : ''}
        ${key === 'done' && state.showAllDone ? '<button class="pill more" data-hide-done>Show this week only</button>' : ''}
      </div>`;
  }).join('');
}

// Today: one list, overdue first, then due today, in the view's own order. The
// board's filters and sort don't apply; the search does.
function todayHtml() {
  const groups = todayView(searched(state.todos), todayStr());
  const html = TODAY_VIEW.groups.map(({ name, label }) => (groups[name].length ? `
    <section class="today-group" data-group="${name}" aria-label="${label}">
      <h2 class="today-head"><span class="dot"></span>${label}<span class="count">${groups[name].length}</span></h2>
      <div class="today-list">${groups[name].map((t) => cardHtml(t, { listed: true })).join('')}</div>
    </section>` : '')).join('');
  return html || `<div class="empty today-empty">${lists.query() ? 'Nothing overdue or due today matches the search' : 'Nothing overdue or due today 🎉'}</div>`;
}

// ---------- drawer ----------

function setField(el, value) {
  if (document.activeElement !== el && el.value !== value) el.value = value;
}

function setSeg(el, value) {
  for (const b of el.querySelectorAll('button')) b.classList.toggle('on', b.dataset.value === value);
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + el.offsetHeight - el.clientHeight + 'px';
}

function renderDrawer() {
  const drawer = $('#drawer');
  const t = state.openId !== null ? byId(state.openId) : null;
  if (!t) {
    if (state.openId !== null) state.openId = null; // deleted elsewhere
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    $('#scrim').hidden = !habits.isOpen();
    return;
  }
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;

  $('#d-id').textContent = `#${t.id}`;
  $('#d-created').textContent = `Created by ${actorName(t.createdBy)} · ${ago(t.createdAt)}`;
  setField($('#d-title'), t.title);
  autosize($('#d-title'));
  setSeg($('#d-status'), t.status);
  setSeg($('#d-priority'), t.priority);
  setSeg($('#d-assignee'), t.assignee);
  setField($('#d-due'), t.due || '');
  setField($('#d-project'), t.project || '');
  setField($('#d-tags'), t.tags.join(', '));
  // "Start with Claude" needs the desktop app, and only makes sense for unfinished tasks.
  const folder = state.handoff?.folders[t.project || ''] || '';
  $('#d-handoff').hidden = !state.handoff || t.status === 'done';
  $('#d-handoff-folder-row').hidden = !folder;
  $('#d-handoff-where').textContent = folder ? `Folder: ${folder}` : '';
  $('#d-handoff-where').title = folder;
  if (state.handoff) setField($('#d-handoff-target'), state.handoffChoice ?? state.handoff.target);
  setField($('#d-repeat'), t.repeat || '');
  setField($('#d-remind'), t.remindAt ? toLocalInput(t.remindAt) : '');
  renderSubtasks(t);
  renderNotes(t);

  $('#d-activity').innerHTML = [...t.activity].reverse().map((a) => `
    <li>
      ${avatar(a.by)}
      <div class="meta"><b>${esc(who(a))}</b> ${a.kind === 'comment' ? 'commented' : esc(a.text)}<time datetime="${esc(a.at)}" title="${esc(new Date(a.at).toLocaleString())}">${ago(a.at)}</time></div>
      ${a.kind === 'comment' ? `<div class="bubble md">${inlineMarkdown(a.text)}</div>` : ''}
    </li>`).join('');
}

// Updates the checklist in place, rebuilding rows only when the set of subtasks
// changes, so a click or an in-progress title edit survives live refreshes.
function renderSubtasks(t) {
  const list = $('#d-subtasks');
  const done = t.subtasks.filter((sub) => sub.done).length;
  $('#d-sub-count').textContent = t.subtasks.length ? `${done} of ${t.subtasks.length}` : '';
  const bar = $('#d-sub-progress');
  bar.hidden = !t.subtasks.length;
  bar.firstElementChild.style.width = t.subtasks.length ? `${(done / t.subtasks.length) * 100}%` : '0';

  const key = `${t.id}:${t.subtasks.map((sub) => sub.id).join(',')}`;
  if (list.dataset.key !== key) {
    const editing = list.contains(document.activeElement) && document.activeElement.matches('.sub-title')
      ? { id: document.activeElement.closest('li').dataset.sub, value: document.activeElement.value }
      : null;
    list.innerHTML = t.subtasks.map((sub) => `
      <li data-sub="${sub.id}">
        <button class="check" type="button" data-sub-check>${ICONS.check}</button>
        <input class="sub-title" aria-label="Subtask" autocomplete="off">
        <button class="icon-btn sub-remove" type="button" data-sub-remove aria-label="Remove subtask">${ICONS.x}</button>
      </li>`).join('');
    list.dataset.key = key;
    const restored = editing && list.querySelector(`li[data-sub="${editing.id}"] .sub-title`);
    if (restored) {
      restored.value = editing.value;
      restored.focus();
    }
  }
  t.subtasks.forEach((sub, i) => {
    const li = list.children[i];
    li.classList.toggle('done', sub.done);
    li.querySelector('[data-sub-check]').setAttribute('aria-label', `${sub.done ? 'Uncheck' : 'Check off'} ${sub.title}`);
    setField(li.querySelector('.sub-title'), sub.title);
  });
}

// Notes show as rendered Markdown; clicking them (or Edit) swaps in the textarea.
function renderNotes(t) {
  const view = $('#d-notes-view');
  const editor = $('#d-notes');
  view.hidden = state.editingNotes;
  editor.hidden = !state.editingNotes;
  $('#d-notes-edit').textContent = state.editingNotes ? 'Done' : 'Edit';
  setField(editor, t.notes);
  if (!state.editingNotes) {
    view.innerHTML = t.notes ? renderMarkdown(t.notes) : '<p class="placeholder">Add details, links, context…</p>';
  }
}

function editNotes() {
  if (state.openId === null) return;
  state.editingNotes = true;
  renderDrawer();
  const editor = $('#d-notes');
  autosize(editor);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

function openDrawer(id) {
  // Leaving a field saves it against the task that is still open.
  if (state.openId !== id && $('#drawer').contains(document.activeElement)) document.activeElement.blur();
  habits.close();
  state.editingNotes = false;
  state.openId = id;
  render();
}

function closeDrawer() {
  if (document.activeElement && $('#drawer').contains(document.activeElement)) document.activeElement.blur();
  state.openId = null;
  render();
}

// Saves a text field from the drawer if its value differs from the stored one.
function saveField(key, raw) {
  const t = byId(state.openId);
  if (!t) return;
  let value = raw;
  if (key === 'tags') value = raw.split(',').map((s) => s.trim().replace(/^[#@]/, '').toLowerCase()).filter(Boolean);
  if (key === 'due' || key === 'project') value = raw.trim() || null;
  if (key === 'title') {
    value = raw.trim();
    if (!value) return render();
  }
  if (JSON.stringify(t[key]) === JSON.stringify(value)) return;
  patch(t.id, { [key]: value }, { guard: true });
}

// ---------- events ----------

$('#stats').addEventListener('click', (e) => {
  const tile = e.target.closest('.stat');
  if (tile) lists.pickTile(tile.dataset.focus);
});

$('#quickadd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#qa-title').value.trim();
  if (!title) return;
  // While the board is filtered to one project, or to Claude's tasks, a new task joins them.
  const { project, assignee } = lists.filter();
  const body = {
    quick: title, // one-line entry: dates, !priority, #project, @tag are parsed on the server
    priority: $('#qa-priority').value,
    project: $('#qa-project').value.trim() || (project.length === 1 && project[0]) || null,
    due: $('#qa-due').value || null,
  };
  if (assignee === 'claude') body.assignee = 'claude';
  try {
    await api('POST', '/api/todos', body);
    $('#qa-title').value = '';
    $('#qa-due').value = '';
    $('#qa-priority').value = 'medium';
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

const board = $('#board');

board.addEventListener('click', (e) => {
  if (e.target.closest('[data-show-done]')) { state.showAllDone = true; return render(); }
  if (e.target.closest('[data-hide-done]')) { state.showAllDone = false; return render(); }
  const card = e.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.closest('[data-check]')) {
    const t = byId(id);
    return patch(id, { status: t.status === 'done' ? 'todo' : 'done' });
  }
  openDrawer(id);
});

board.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDrawer(Number(card.dataset.id));
  }
});

board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => card.classList.add('dragging'));
});
board.addEventListener('dragend', (e) => e.target.closest('.card')?.classList.remove('dragging'));
board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  for (const c of board.querySelectorAll('.column.drop')) if (c !== col) c.classList.remove('drop');
  col.classList.add('drop');
});
board.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop');
});
board.addEventListener('drop', (e) => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drop');
  const id = Number(e.dataTransfer.getData('text/plain'));
  const t = byId(id);
  if (t && t.status !== col.dataset.status) patch(id, { status: col.dataset.status });
});

for (const segId of ['d-status', 'd-priority', 'd-assignee']) {
  $(`#${segId}`).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || state.openId === null) return;
    const key = segId.slice(2);
    if (byId(state.openId)[key] !== b.dataset.value) patch(state.openId, { [key]: b.dataset.value }, { guard: key !== 'status' });
  });
}

const dTitle = $('#d-title');
dTitle.addEventListener('input', () => autosize(dTitle));
dTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); dTitle.blur(); }
});
dTitle.addEventListener('blur', () => saveField('title', dTitle.value));

$('#d-due').addEventListener('change', (e) => saveField('due', e.target.value));
$('#d-due-clear').addEventListener('click', () => { $('#d-due').value = ''; saveField('due', ''); });
for (const key of ['project', 'tags']) {
  const el = $(`#d-${key}`);
  el.addEventListener('change', () => saveField(key, el.value));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
}
async function startWithClaude(chooseFolder) {
  const t = byId(state.openId);
  if (!t) return;
  const button = $('#d-handoff-start');
  button.disabled = true;
  try {
    const result = await api('POST', `/api/todos/${t.id}/handoff`, { chooseFolder, target: $('#d-handoff-target').value });
    if (result.started) {
      toast(result.target === 'terminal'
        ? `Claude session started in Terminal, in ${result.folder}`
        : `Opened in the Claude app with ${result.folder}. Check it there and press Enter to start.`, { ms: 9000 });
    }
  } catch (e) {
    toast(e.message, { ms: 8000 });
  }
  button.disabled = false;
  refresh();
}
$('#d-handoff-target').addEventListener('change', (e) => {
  state.handoffChoice = e.target.value;
});
$('#d-handoff-start').addEventListener('click', () => startWithClaude(false));
$('#d-handoff-folder').addEventListener('click', () => startWithClaude(true));

$('#d-repeat').addEventListener('change', (e) => {
  if (state.openId !== null) patch(state.openId, { repeat: e.target.value || null }, { guard: true });
});

// Saved on blur, not change: a datetime field fires change for every segment typed.
const dRemind = $('#d-remind');
dRemind.addEventListener('blur', () => {
  const t = byId(state.openId);
  if (t && dRemind.value !== (t.remindAt ? toLocalInput(t.remindAt) : '')) patch(t.id, { remindAt: dRemind.value || null }, { guard: true });
});
$('#d-remind-clear').addEventListener('click', () => {
  dRemind.value = '';
  if (byId(state.openId)?.remindAt) patch(state.openId, { remindAt: null }, { guard: true });
});

const subList = $('#d-subtasks');
subList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-sub]');
  if (!li || state.openId === null) return;
  const id = Number(li.dataset.sub);
  if (e.target.closest('[data-sub-check]')) {
    patch(state.openId, { [li.classList.contains('done') ? 'uncheck_subtasks' : 'check_subtasks']: [id] });
  } else if (e.target.closest('[data-sub-remove]')) {
    patch(state.openId, { remove_subtasks: [id] });
  }
});
subList.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.sub-title')) e.target.blur();
});
subList.addEventListener('focusout', (e) => {
  if (!e.target.matches('.sub-title')) return;
  const t = byId(state.openId);
  const sub = t?.subtasks.find((x) => x.id === Number(e.target.closest('li').dataset.sub));
  if (!sub) return;
  const title = e.target.value.trim();
  if (!title || title === sub.title) e.target.value = sub.title;
  else patch(t.id, { rename_subtask: { id: sub.id, title } });
});
$('#d-sub-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#d-sub-new');
  const title = input.value.trim();
  if (!title || state.openId === null) return;
  input.value = '';
  patch(state.openId, { add_subtasks: [title] });
});

const notesView = $('#d-notes-view');
const notesEditor = $('#d-notes');
notesView.addEventListener('click', (e) => {
  // Let links open and text selections stand; any other click starts editing.
  if (!e.target.closest('a') && !String(window.getSelection()).trim()) editNotes();
});
notesView.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target === notesView) {
    e.preventDefault();
    editNotes();
  }
});
// Keep focus in the editor on mousedown so its blur doesn't race this button's click.
$('#d-notes-edit').addEventListener('mousedown', (e) => e.preventDefault());
$('#d-notes-edit').addEventListener('click', () => (state.editingNotes ? notesEditor.blur() : editNotes()));
notesEditor.addEventListener('input', () => autosize(notesEditor));
notesEditor.addEventListener('blur', () => {
  state.editingNotes = false;
  saveField('notes', notesEditor.value);
  renderDrawer();
});

$('#d-comment').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#d-comment-text');
  const text = input.value.trim();
  if (!text || state.openId === null) return;
  input.value = '';
  patch(state.openId, { comment: text });
});

$('#d-delete').addEventListener('click', async () => {
  const t = byId(state.openId);
  if (!t || !confirm(`Delete "${t.title}"? This can't be undone.`)) return;
  try {
    await api('DELETE', `/api/todos/${t.id}`);
    state.openId = null;
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('#d-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', () => {
  habits.close();
  closeDrawer();
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (typing) return document.activeElement.blur();
    if (habits.isOpen()) return habits.close();
    if (state.openId !== null) return closeDrawer();
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#qa-title').focus(); }
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); lists.toggleView(); }
});

$('#signout').addEventListener('click', async () => {
  await fetch('/api/v1/session', { method: 'DELETE' }).catch(() => {});
  location.replace('/login');
});

// Hooks for the desktop app shell: notification clicks open the task they are about,
// and reminders also show in the window in case system notifications are off.
window.todos = {
  async open(id) {
    if (!byId(id)) await refresh();
    if (byId(id)) openDrawer(id);
  },
  remind(id, title) {
    toast(`Reminder: ${title}`, { ms: 20_000, onClick: () => window.todos.open(id) });
  },
  async openHabit(id) {
    await habits.refresh();
    habits.open(id);
  },
};

// Keep relative timestamps and date-based counts (today/overdue) fresh, and
// habits too: their day turns over at its own hour.
setInterval(() => {
  refresh();
  habits.refresh();
}, 60_000);

refresh();
connect();
