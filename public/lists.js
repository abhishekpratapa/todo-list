// What the board shows and in what order: the bar above it (Board or Today, the
// filters, the sort), the chips that say what is filtered, and the search box.
// The choices are remembered on this device.
//
// What a choice means is up to /query.js, the server's own rules (src/query.js),
// so the board lists what the API, the todos command and the iPhone app would
// for the same choices. This file only collects them.

import { parseFilter, parseSort } from '/query.js';

const STORE_KEY = 'todos.lists';
const MAX_KEYS = 3;

// The keys the board can be sorted by, with each direction in words. Status isn't
// one: the columns already are. `desc` is the direction a key starts in.
const SORTS = {
  default: { label: 'Default' },
  due: { label: 'Due date', up: 'Earliest first', down: 'Latest first' },
  priority: { label: 'Priority', up: 'High first', down: 'Low first' },
  created: { label: 'Created', up: 'Oldest first', down: 'Newest first', desc: true },
  updated: { label: 'Updated', up: 'Oldest first', down: 'Newest first', desc: true },
  completed: { label: 'Completed', up: 'Oldest first', down: 'Newest first', desc: true },
  title: { label: 'Title', up: 'A to Z', down: 'Z to A' },
  project: { label: 'Project', up: 'A to Z', down: 'Z to A' },
};

const PRIORITIES = [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
const ASSIGNEES = [['', 'Anyone'], ['me', 'Me'], ['claude', 'Claude']];
const DUES = [['', 'Any time'], ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['any', 'Has a due date'], ['none', 'No due date']];
const DUE_CHIPS = { overdue: 'Overdue', today: 'Due today', tomorrow: 'Due tomorrow', week: 'Due in the next 7 days', any: 'Has a due date', none: 'No due date' };

// The stat tiles, as the filters they stand for. A tile replaces whatever the
// other tiles had set, as picking one always has; projects, priorities and tags stay.
const TILES = { today: { due: 'today' }, overdue: { due: 'overdue' }, claude: { assignee: 'claude' }, done: { status: 'done' } };
const TILE_FIELDS = ['due', 'assignee', 'status'];

const blank = () => ({ project: [], priority: [], tag: [], tagMode: 'any', assignee: '', due: '', status: '' });
const DEFAULT = [{ key: 'default', desc: false }];

const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// What this device chose last time. Anything unreadable, or no longer a valid
// choice, is left at its default, one field at a time.
function remembered() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    // no storage here (a private window, or blocked), or something unreadable in it
  }
  const prefs = { view: saved.view === 'today' ? 'today' : 'board', sort: DEFAULT, filter: blank() };
  try {
    const sort = parseSort(saved.sort).filter((s) => s.key in SORTS).slice(0, MAX_KEYS);
    if (sort.length && sort[0].key !== 'default') prefs.sort = sort.filter((s) => s.key !== 'default');
  } catch {
    // a key this version doesn't know: the default order
  }
  for (const [field, value] of Object.entries(saved.filter && typeof saved.filter === 'object' ? saved.filter : {})) {
    const empty = blank()[field];
    const fits = Array.isArray(empty) ? Array.isArray(value) && value.every((v) => typeof v === 'string') : typeof value === 'string';
    if (!fits) continue;
    try {
      parseFilter({ [field]: value });
      prefs.filter[field] = value;
    } catch {
      // not a value the rules accept (any more)
    }
  }
  return prefs;
}

const sortText = (sort) => sort.map((s) => `${s.desc ? '-' : ''}${s.key}`).join(',');

// `changed()` is called after every choice, to draw the board again.
export function createListControls({ esc, changed }) {
  const bar = document.querySelector('#listbar');
  const chips = document.querySelector('#active-filters');
  const search = document.querySelector('#search');
  const prefs = remembered();
  const f = prefs.filter;
  let query = '';

  function remember() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ view: prefs.view, sort: sortText(prefs.sort), filter: f }));
    } catch {
      // storage unavailable: the choices last until the page is closed
    }
  }

  function update() {
    remember();
    changed();
  }

  // Which tile the filters amount to: '' (Open) when no tile's filter is set,
  // null when they are set some other way.
  function tile() {
    const set = TILE_FIELDS.filter((k) => f[k]);
    if (!set.length) return '';
    if (set.length > 1) return null;
    return Object.keys(TILES).find((name) => TILES[name][set[0]] === f[set[0]]) ?? null;
  }

  const filtering = () => !!(f.project.length || f.priority.length || f.tag.length || f.assignee || f.due || f.status || query);

  // ---------- the bar ----------

  const menu = (name, label) => `
    <details class="menu" data-menu="${name}">
      <summary data-k="menu:${name}"><span class="menu-text">${label}<span class="menu-value"></span></span></summary>
      <div class="menu-pop" role="group" aria-label="${label}"></div>
    </details>`;

  bar.innerHTML = `
    <div class="seg small view-seg" role="group" aria-label="View">
      <button type="button" data-view="board" title="The board, by status">Board</button>
      <button type="button" data-view="today" title="What is overdue or due today (T)">Today<span class="count"></span></button>
    </div>
    <div class="menus" role="group" aria-label="Filters">
      ${menu('project', 'Project')}${menu('priority', 'Priority')}${menu('tag', 'Tag')}${menu('assignee', 'Assignee')}${menu('due', 'Due')}
    </div>
    <details class="menu sort-menu" data-menu="sort">
      <summary data-k="menu:sort"><span class="menu-text">Sort<span class="menu-value"></span></span></summary>
      <div class="menu-pop sort-pop" role="group" aria-label="Sort"></div>
    </details>`;

  // Replaces a menu's contents only when they change, and keeps the focus on the
  // same choice, so a live update or a click doesn't throw the keyboard out.
  const drawn = new WeakMap();
  function fill(pop, html) {
    if (drawn.get(pop) === html) return;
    const k = pop.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    pop.innerHTML = html;
    drawn.set(pop, html);
    if (k) pop.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
  }

  const option = (type, field, value, label, { checked, count } = {}) => `
    <label class="opt">
      <input type="${type}" name="f-${field}" data-field="${field}" value="${esc(value)}" data-k="${esc(`${field}:${value}`)}"${checked ? ' checked' : ''}>
      <span class="opt-label">${esc(label)}</span>
      ${count === undefined ? '' : `<span class="count">${count}</span>`}
    </label>`;

  // Values a list of open tasks has for one field, with how many of them have each.
  // Names that differ only in case are one project, as the filter treats them, and
  // it is listed the way most of its tasks spell it.
  function tally(todos, valuesOf) {
    const seen = new Map();
    for (const t of todos) {
      if (t.status === 'done') continue;
      for (const v of valuesOf(t)) {
        const key = v.toLowerCase();
        const entry = seen.get(key) || { name: v, count: 0, spellings: new Map() };
        entry.count += 1;
        entry.spellings.set(v, (entry.spellings.get(v) || 0) + 1);
        if (entry.spellings.get(v) > entry.spellings.get(entry.name)) entry.name = v;
        seen.set(key, entry);
      }
    }
    return seen;
  }

  // Selected values stay in the menu even once nothing has them, so they can be unticked.
  function choices(seen, selected) {
    for (const v of selected) if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), { name: v, count: 0 });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }));
  }

  const has = (list, v) => list.some((x) => x.toLowerCase() === v.toLowerCase());

  function projectMenu(todos) {
    const named = choices(tally(todos, (t) => (t.project ? [t.project] : [])), f.project);
    const none = todos.filter((t) => t.status !== 'done' && !t.project).length;
    const rows = named.map((p) => option('checkbox', 'project', p.name, p.name, { checked: has(f.project, p.name), count: p.count }));
    if (none || f.project.includes('')) rows.push(option('checkbox', 'project', '', 'No project', { checked: f.project.includes(''), count: none }));
    return rows.join('') || '<p class="menu-empty">No projects yet</p>';
  }

  function tagMenu(todos) {
    const tags = choices(tally(todos, (t) => t.tags), f.tag);
    if (!tags.length) return '<p class="menu-empty">No tags yet</p>';
    // Below the tags, so ticking a second one doesn't move the rest.
    const mode = f.tag.length > 1
      ? `<label class="opt opt-mode"><input type="checkbox" data-mode value="all" data-k="tag-mode"${f.tagMode === 'all' ? ' checked' : ''}><span class="opt-label">Only tasks with every one</span></label>`
      : '';
    return tags.map((x) => option('checkbox', 'tag', x.name, `@${x.name}`, { checked: f.tag.includes(x.name), count: x.count })).join('') + mode;
  }

  function priorityMenu(todos) {
    return PRIORITIES.map(([value, label]) =>
      option('checkbox', 'priority', value, label, { checked: f.priority.includes(value), count: todos.filter((t) => t.status !== 'done' && t.priority === value).length })).join('');
  }

  const oneOfMenu = (field, values) => values.map(([value, label]) => option('radio', field, value, label, { checked: f[field] === value })).join('');

  function sortMenu() {
    const rows = prefs.sort.map((s, i) => {
      const used = prefs.sort.filter((_, j) => j !== i).map((x) => x.key);
      const keys = Object.keys(SORTS).filter((k) => (i === 0 || k !== 'default') && !used.includes(k));
      const words = SORTS[s.key];
      return `
        <div class="sort-row">
          <span class="sort-lead">${i ? 'then by' : 'Sort by'}</span>
          <select data-sort-key="${i}" data-k="key:${i}" aria-label="${i ? 'Then by' : 'Sort by'}">
            ${keys.map((k) => `<option value="${k}"${k === s.key ? ' selected' : ''}>${SORTS[k].label}</option>`).join('')}
          </select>
          ${s.key === 'default' ? '' : `<button type="button" class="sort-dir" data-sort-dir="${i}" data-k="dir:${i}" title="Reverse">${s.desc ? words.down : words.up}</button>`}
          ${i ? `<button type="button" class="icon-btn sort-remove" data-sort-remove="${i}" data-k="remove:${i}" aria-label="Stop sorting by ${SORTS[s.key].label.toLowerCase()}">${X}</button>` : ''}
        </div>`;
    }).join('');
    const custom = prefs.sort[0].key !== 'default';
    const hint = custom
      ? 'Sorts the tasks in each column.'
      : 'In each column, the most important first, then by due date. Done: the most recently finished first.';
    return `${rows}<p class="sort-hint">${hint}</p>
      ${custom && prefs.sort.length < MAX_KEYS ? '<button type="button" class="link-btn sort-add" data-sort-add data-k="add">+ Then by…</button>' : ''}
      ${custom ? '<button type="button" class="link-btn sort-reset" data-sort-reset data-k="reset">Back to default</button>' : ''}`;
  }

  // What a menu's button says beside its name once something is chosen.
  function summarize(name) {
    const label = (pairs, v) => pairs.find(([value]) => value === v)?.[1];
    switch (name) {
      case 'project':
      case 'priority':
      case 'tag': return f[name].length === 1 ? (name === 'project' ? f.project[0] || 'None' : name === 'tag' ? `@${f.tag[0]}` : label(PRIORITIES, f.priority[0])) : f[name].length ? String(f[name].length) : '';
      case 'assignee': return f.assignee ? label(ASSIGNEES, f.assignee) : '';
      case 'due': return f.due ? label(DUES, f.due) : '';
      case 'sort': return `${SORTS[prefs.sort[0].key].label}${prefs.sort.length > 1 ? ` +${prefs.sort.length - 1}` : ''}`;
      default: return '';
    }
  }

  function renderChips() {
    const list = [
      ...f.project.map((p) => ['project', p, p ? p : 'No project']),
      ...f.priority.map((p) => ['priority', p, `${PRIORITIES.find(([v]) => v === p)[1]} priority`]),
      ...f.tag.map((t) => ['tag', t, `@${t}`]),
      f.assignee && ['assignee', f.assignee, f.assignee === 'claude' ? 'With Claude' : 'Mine'],
      f.due && ['due', f.due, DUE_CHIPS[f.due]],
      f.status && ['status', f.status, 'Done'],
    ].filter(Boolean);
    const mode = f.tag.length > 1
      ? `<button type="button" class="fmode" data-tag-mode title="Switch between any and every tag">${f.tagMode === 'all' ? 'with every tag' : 'with any of these tags'}</button>`
      : '';
    const html = list.map(([field, value, label]) => `
      <button type="button" class="fchip" data-remove="${field}" data-value="${esc(value)}" aria-label="Remove filter: ${esc(label)}">
        ${esc(label)}${X}
      </button>`).join('') + mode + (filtering() ? '<button type="button" class="clear-filters" data-clear>Clear filters</button>' : '');
    chips.hidden = prefs.view === 'today' || !filtering();
    if (drawn.get(chips) !== html) {
      chips.innerHTML = html;
      drawn.set(chips, html);
    }
  }

  function render({ todos, summary }) {
    bar.classList.toggle('today', prefs.view === 'today');
    for (const b of bar.querySelectorAll('[data-view]')) {
      const on = b.dataset.view === prefs.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    const now = (summary.overdue ?? 0) + (summary.due_today ?? 0);
    bar.querySelector('[data-view="today"] .count').textContent = now ? now : '';

    const pops = {
      project: () => projectMenu(todos),
      priority: () => priorityMenu(todos),
      tag: () => tagMenu(todos),
      assignee: () => oneOfMenu('assignee', ASSIGNEES),
      due: () => oneOfMenu('due', DUES),
      sort: sortMenu,
    };
    for (const [name, html] of Object.entries(pops)) {
      const el = bar.querySelector(`[data-menu="${name}"]`);
      const value = summarize(name);
      el.classList.toggle('set', name === 'sort' ? prefs.sort[0].key !== 'default' : !!value);
      el.querySelector('.menu-value').textContent = value ? (name === 'sort' ? `: ${value}` : ` · ${value}`) : '';
      fill(el.querySelector('.menu-pop'), html());
    }
    renderChips();
  }

  // ---------- choices ----------

  const closeMenus = (except) => {
    for (const d of bar.querySelectorAll('details[open]')) if (d !== except) d.open = false;
  };

  function setView(view) {
    if (view === prefs.view) return;
    prefs.view = view;
    closeMenus();
    update();
  }

  bar.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) return setView(view.dataset.view);
    const dir = e.target.closest('[data-sort-dir]');
    if (dir) {
      const s = prefs.sort[Number(dir.dataset.sortDir)];
      prefs.sort = prefs.sort.map((x) => (x === s ? { ...x, desc: !x.desc } : x));
      return update();
    }
    const remove = e.target.closest('[data-sort-remove]');
    if (remove) {
      prefs.sort = prefs.sort.filter((_, i) => i !== Number(remove.dataset.sortRemove));
      return update();
    }
    if (e.target.closest('[data-sort-add]')) {
      const key = Object.keys(SORTS).find((k) => k !== 'default' && !prefs.sort.some((s) => s.key === k));
      prefs.sort = [...prefs.sort, { key, desc: !!SORTS[key].desc }];
      return update();
    }
    if (e.target.closest('[data-sort-reset]')) {
      prefs.sort = DEFAULT;
      return update();
    }
  });

  bar.addEventListener('change', (e) => {
    const input = e.target;
    if (input.matches('[data-sort-key]')) {
      const i = Number(input.dataset.sortKey);
      const key = input.value;
      prefs.sort = key === 'default' ? DEFAULT : prefs.sort.map((s, j) => (j === i ? { key, desc: !!SORTS[key].desc } : s));
    } else if (input.matches('[data-mode]')) {
      f.tagMode = input.checked ? 'all' : 'any';
    } else if (input.type === 'radio') {
      f[input.dataset.field] = input.value;
    } else if (input.type === 'checkbox') {
      const field = input.dataset.field;
      const others = f[field].filter((v) => v.toLowerCase() !== input.value.toLowerCase());
      f[field] = input.checked ? [...others, input.value] : others;
      if (field === 'tag' && f.tag.length < 2) f.tagMode = 'any';
    }
    update();
  });

  // One menu open at a time; a click anywhere else, or Escape, closes it.
  bar.addEventListener('toggle', (e) => {
    if (e.target.open) closeMenus(e.target);
  }, true);
  // By the path the click took: a choice redraws its menu, and the button that
  // was clicked may no longer be in it by the time the click gets here.
  document.addEventListener('click', (e) => {
    for (const d of bar.querySelectorAll('details[open]')) if (!e.composedPath().includes(d)) d.open = false;
  });
  bar.addEventListener('keydown', (e) => {
    const open = e.target.closest('details[open]');
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    open.open = false;
    open.querySelector('summary').focus();
  });

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-remove]');
    if (chip) {
      const { remove: field, value } = chip.dataset;
      if (Array.isArray(f[field])) f[field] = f[field].filter((v) => v !== value);
      else f[field] = '';
      if (f.tag.length < 2) f.tagMode = 'any';
    } else if (e.target.closest('[data-tag-mode]')) {
      f.tagMode = f.tagMode === 'all' ? 'any' : 'all';
    } else if (e.target.closest('[data-clear]')) {
      Object.assign(f, blank());
      query = '';
      search.value = '';
    } else {
      return;
    }
    update();
  });

  search.addEventListener('input', () => {
    query = search.value.trim();
    changed(); // what is typed isn't remembered: an old search would hide tasks without saying why
  });

  return {
    get view() {
      return prefs.view;
    },
    toggleView: () => setView(prefs.view === 'today' ? 'board' : 'today'),
    // The board's filter, as /query.js takes it.
    filter: () => ({ ...f, q: query }),
    sort: () => prefs.sort,
    query: () => query,
    tile,
    // A stat tile was clicked: show what it counts, on the board. A second click undoes it.
    pickTile(name) {
      const again = tile() === name;
      for (const k of TILE_FIELDS) f[k] = '';
      if (!again && TILES[name]) Object.assign(f, TILES[name]);
      prefs.view = 'board';
      update();
    },
    render,
  };
}
