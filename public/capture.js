// Quick-capture panel. Type one line, see what it will become, press Enter.
// The desktop app shows this in a small floating window (see electron/main.js);
// `window.captureWindow.hide()` is provided by the preload script there.

const HINT = 'Try:  Renew passport fri !high #personal   ·   Call dentist tomorrow 3pm   ·   Water plants every day';
const REPEAT_LABELS = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' };
const ICONS = {
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0112 0v5l1.5 2.5h-15zM10 21h4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 3l3 3-3 3M20 6H8a4 4 0 00-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 004-4v-1"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
};

const input = document.querySelector('#text');
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function dayText(ymd) {
  const date = new Date(ymd + 'T00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

function chips(f) {
  const time = f.remindAt ? new Date(f.remindAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  return [
    f.due ? `<span class="chip">${ICONS.cal}${esc(dayText(f.due))}</span>` : '',
    time ? `<span class="chip">${ICONS.bell}${esc(time)}</span>` : '',
    f.repeat ? `<span class="chip">${ICONS.repeat}${REPEAT_LABELS[f.repeat]}</span>` : '',
    f.priority === 'high' ? '<span class="chip prio-high">High</span>' : '',
    f.priority === 'low' ? '<span class="chip prio-low">Low</span>' : '',
    f.priority === 'medium' ? '<span class="chip">Medium</span>' : '',
    f.project ? `<span class="chip project">${esc(f.project)}</span>` : '',
    f.assignee === 'claude' ? `<span class="chip claude">${ICONS.spark}Claude</span>` : '',
    ...(f.tags || []).map((tag) => `<span class="chip tag">@${esc(tag)}</span>`),
  ].join('');
}

function showHint() {
  preview.className = 'preview';
  preview.textContent = HINT;
}

let seq = 0; // drops out-of-order responses while typing

async function refreshPreview() {
  const text = input.value;
  const mine = ++seq;
  if (!text.trim()) return showHint();
  try {
    const { title, fields } = await api('/api/parse', { text });
    if (mine !== seq) return;
    const found = chips(fields);
    preview.className = 'preview';
    // Show the cleaned-up title only when something was taken out of it.
    preview.innerHTML = found ? `<span class="title">${esc(title || 'Add a title')}</span>${found}` : '';
  } catch {
    // preview is best-effort; adding still reports errors
  }
}

async function add(keepOpen) {
  const text = input.value.trim();
  if (!text) return;
  try {
    const todo = await api('/api/todos', { quick: text });
    seq++;
    input.value = '';
    showHint();
    status.textContent = `Added “${todo.title}”`;
    if (keepOpen) input.focus();
    else setTimeout(close, 450); // long enough to see the confirmation
  } catch (e) {
    preview.className = 'preview error';
    preview.textContent = e.message;
  }
}

function close() {
  if (window.captureWindow) window.captureWindow.hide();
}

// Called by the app each time the panel is shown.
window.resetCapture = () => {
  seq++;
  input.value = '';
  status.textContent = '';
  showHint();
  input.focus();
};

input.addEventListener('input', () => {
  status.textContent = '';
  refreshPreview();
});
document.querySelector('#capture').addEventListener('submit', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    add(e.metaKey || e.ctrlKey);
  }
});

showHint();
