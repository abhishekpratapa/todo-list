// Habits on the dashboard: a strip above the board with today's habits, each
// checked in with one click, and a panel for one habit with its streak, today
// and yesterday, and a calendar of the last half year.
//
// Everything shown comes from the server as it is: which habits are due, the
// streaks, and the lines that describe them (see src/habit-text.js). Nothing
// about streaks is worked out here.

const WEEKS = 26; // how far back the calendar goes

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  flame: '<svg class="flame" viewBox="0 0 24 24"><path d="M12 2.5c.6 3.4 4.6 5.6 4.6 10.4a4.6 4.6 0 01-9.2 0c0-1.7.7-3 1.7-4 .2 1.3.9 2.2 1.8 2.6C10.4 8.6 11 5.6 12 2.5z"/></svg>',
};

const DAY_MS = 864e5;
const utc = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, n) => new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
// Monday of the week a day is in.
const weekStart = (day) => addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));
const fmtDay = (day, options = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(utc(day)).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// "07:30" as the reader writes times.
const fmtClock = (time) => new Date(2001, 0, 1, Number(time.slice(0, 2)), Number(time.slice(3, 5))).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const percent = (value) => (value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createHabits({ api, toast, esc, closeTask }) {
  const section = document.querySelector('#habits');
  const panel = document.querySelector('#habit-drawer');
  const scrim = document.querySelector('#scrim');
  const state = { habits: [], left: 0, openId: null, history: null };

  const byId = (id) => state.habits.find((h) => h.id === id);
  const isWeekly = (h) => h.schedule.kind === 'weekly';
  const slotOf = (h, id) => h.schedule.slots?.find((s) => s.id === id);
  const slotName = (h, id) => slotOf(h, id)?.name || id.charAt(0).toUpperCase() + id.slice(1);
  const actor = (slot) => (slot.by === 'me' ? 'You' : slot.by) + (slot.via ? ` · ${slot.via}` : '');

  // ---------- talking to the server ----------

  function take(data) {
    state.habits = data.habits;
    state.left = data.left;
    render();
  }

  async function refresh() {
    try {
      take(await api('GET', '/api/habits'));
      if (state.openId !== null) loadHistory();
    } catch (e) {
      toast(e.message);
    }
  }

  // A change answers with the whole list again, since one check-in can reorder it.
  async function send(method, url, body) {
    try {
      take(await api(method, url, body || {}));
      if (state.openId !== null) loadHistory();
    } catch (e) {
      toast(e.message, { ms: 7000 });
      refresh();
    }
  }

  const toggle = (id, { slot, day, done }) => send('POST', `/api/habits/${id}/${done ? 'undo' : 'checkins'}`, { slot, day });

  async function loadHistory() {
    const habit = byId(state.openId);
    if (!habit) return;
    const today = habit.today.day;
    const from = addDays(weekStart(today), -7 * (WEEKS - 1));
    try {
      const history = await api('GET', `/api/habits/${habit.id}/history?from=${from}&to=${today}`);
      if (state.openId === habit.id) {
        state.history = { id: habit.id, ...history };
        renderCalendar();
      }
    } catch {
      // the panel is still useful without its calendar; the next change tries again
    }
  }

  // ---------- the strip ----------

  // A round button for each time of day (one, for a habit counted in weeks).
  function slotButtons(h, which, { labelled = false } = {}) {
    const shown = h[which];
    const disabled = h.paused || h.archived ? ' disabled' : '';
    const button = (done, name, slot, detail) => `
      <button class="slot${done ? ' done' : ''}" type="button" data-toggle="${which}" data-slot="${esc(slot ?? '')}" data-done="${done}"${disabled}
              title="${esc(`${name}: ${done ? 'done. Click to take it back.' : 'click to check in.'}`)}"
              aria-label="${esc(`${h.name}, ${name}${which === 'yesterday' ? ', yesterday' : ''}`)}" aria-pressed="${done}">${ICONS.check}</button>
      ${labelled ? `<span class="slot-name">${esc(name)}</span><span class="slot-detail">${esc(detail)}</span>` : ''}`;
    if (isWeekly(h)) {
      return button(shown.done, which === 'today' ? 'Today' : 'Yesterday', null, shown.done ? 'Checked in' : '');
    }
    return shown.slots.map((s) => {
      const slot = slotOf(h, s.id);
      const detail = s.done ? `${actor(s)}, ${fmtTime(s.at)}` : slot?.remind ? fmtClock(slot.remind) : '';
      // A habit done once a day with no name for when: the day is all there is to say.
      const name = slot?.name || (shown.slots.length === 1 ? (which === 'today' ? 'Today' : 'Yesterday') : slotName(h, s.id));
      return button(s.done, name, s.id, detail);
    }).join('');
  }

  const icon = (h) => `<span class="habit-icon" aria-hidden="true">${h.icon ? esc(h.icon) : ICONS.flame}</span>`;

  function streak(h) {
    if (!h.streak.current) return '';
    const risk = h.streak.atRisk ? ' risk' : '';
    return `<span class="streak${risk}" title="${esc(`Streak: ${plural(h.streak.current, h.streak.unit === 'days' ? 'day' : 'week')}${risk ? ', at risk' : ''}`)}">${ICONS.flame}${h.streak.current}</span>`;
  }

  function cardHtml(h) {
    return `
      <article class="habit tint-${esc(h.color)} ${h.group}${state.openId === h.id ? ' selected' : ''}" data-habit="${h.id}" tabindex="0" aria-label="${esc(h.name)}">
        ${icon(h)}
        <div class="habit-main">
          <div class="habit-name">${esc(h.name)}</div>
          <div class="habit-line">${esc(h.text.progress)}</div>
        </div>
        ${streak(h)}
        <div class="habit-slots">${slotButtons(h, 'today')}</div>
      </article>`;
  }

  // Yesterday is unfinished and a streak hangs on it: offered at the top until today ends.
  function riskHtml(h) {
    return `
      <div class="habit-risk tint-${esc(h.color)}" data-habit="${h.id}">
        ${icon(h)}
        <span class="habit-risk-text"><b>${esc(h.name)}</b> ${esc(h.text.atRisk)}</span>
        <div class="habit-slots">${slotButtons(h, 'yesterday')}</div>
      </div>`;
  }

  function renderStrip() {
    section.hidden = !state.habits.length;
    if (section.hidden) return;
    const risky = state.habits.filter((h) => h.text.atRisk);
    section.innerHTML = `
      <div class="habits-head">
        <span class="section-label">Habits</span>
        <span class="habits-left${state.left ? '' : ' clear'}">${state.left ? `${state.left} left today` : 'All done today'}</span>
      </div>
      ${risky.map(riskHtml).join('')}
      <div class="habit-grid">${state.habits.map(cardHtml).join('')}</div>`;
  }

  // ---------- the panel ----------

  function renderPanel() {
    const h = state.openId !== null ? byId(state.openId) : null;
    if (!h) {
      state.openId = null; // closed, or deleted elsewhere
      state.history = null;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      if (!document.querySelector('#drawer.open')) scrim.hidden = true;
      return;
    }
    panel.className = `drawer habit-drawer open tint-${h.color}`;
    panel.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;

    const unit = h.streak.unit === 'days' ? 'day' : 'week';
    const tiles = [
      [`${ICONS.flame}${h.streak.current}`, `${unit}${h.streak.current === 1 ? '' : 's'} in a row`, h.streak.current ? 'now' : 'now none'],
      [h.streak.best, 'best', ''],
      [percent(h.rates.d7), '7 days', ''],
      [percent(h.rates.d30), '30 days', ''],
      [percent(h.rates.d365), '365 days', ''],
    ];
    const day = (which, label, note) => `
      <div class="section-row"><span class="section-label">${label}</span><span class="section-count">${esc(fmtDay(h[which].day))}${note ? ` · ${note}` : ''}</span></div>
      <div class="habit-day">${dayHtml(h, which)}</div>`;
    const weekly = isWeekly(h) ? `<div class="habit-week">This week: <b>${h.week.count} of ${h.week.target}</b>${h.week.state === 'met' ? ' · done' : h.week.state === 'skipped' ? ' · rest week' : ''}</div>` : '';
    const rested = isWeekly(h) ? h.week.state === 'skipped' : h.today.state === 'skipped';
    const canRest = isWeekly(h) ? h.week.state === 'open' : h.today.state === 'open';
    const rest = isWeekly(h) ? 'Rest Week' : 'Rest Day';

    panel.querySelector('#h-body').innerHTML = `
      <div class="habit-title">${icon(h)}<h2>${esc(h.name)}</h2></div>
      <div class="habit-schedule">${esc(h.text.schedule)}${h.paused ? ' · <b>Paused</b>' : ''}</div>
      <div class="habit-tiles">${tiles.map(([num, label, cls]) => `<div class="habit-tile ${cls}"><span class="num">${num}</span><span class="lbl">${label}</span></div>`).join('')}</div>
      ${h.text.atRisk ? `<p class="habit-note risk">${esc(h.text.atRisk)}</p>` : ''}
      ${h.text.ended ? `<p class="habit-note">${esc(h.text.ended)}</p>` : ''}
      ${weekly}
      ${day('today', 'Today', '')}
      ${day('yesterday', 'Yesterday', (isWeekly(h) ? h.yesterday.done : h.yesterday.state !== 'open') ? '' : 'can be logged until today ends')}
      <div class="section-row"><span class="section-label">Last ${WEEKS} weeks</span></div>
      <div class="habit-calendar" id="h-calendar"></div>
      <div class="habit-actions">
        ${rested ? `<button class="btn" type="button" data-unrest>Take Back the ${rest}</button>` : `<button class="btn" type="button" data-rest${canRest && !h.paused ? '' : ' disabled'} title="${esc(`Neither breaks the streak nor adds to it. ${plural(h.skipsLeft, 'more')} can be taken for now.`)}">${rest}</button>`}
        <button class="btn" type="button" data-pause="${!h.paused}" title="${h.paused ? '' : 'While paused, nothing is expected and the streak waits.'}">${h.paused ? 'Resume' : 'Pause'}</button>
      </div>
      <p class="habit-foot">Habits are made and edited in Todos on the iPhone.</p>`;
    renderCalendar();
  }

  function dayHtml(h, which) {
    if (!isWeekly(h) && !h[which].slots.length) return `<span class="habit-empty">${h[which].state === 'skipped' ? 'Rest day' : 'Nothing expected'}</span>`;
    if (!isWeekly(h) && h[which].state === 'skipped') return '<span class="habit-empty">Rest day</span>';
    return slotButtons(h, which, { labelled: true });
  }

  const MARKS = { d: 'done', p: 'partly done', x: 'not done', s: 'rest', o: 'still open', '.': 'nothing expected', _: '' };

  // Weeks run left to right, Monday at the top, the current week last.
  function renderCalendar() {
    const el = panel.querySelector('#h-calendar');
    const history = state.history;
    if (!el) return;
    if (!history || history.id !== state.openId) {
      el.innerHTML = '';
      return;
    }
    const cells = [];
    const months = [];
    const end = addDays(weekStart(history.to), 6);
    for (let day = history.from, i = 0; day <= end; day = addDays(day, 1), i++) {
      const mark = history.days[i] ?? '_';
      const title = mark === '_' ? '' : ` title="${esc(`${fmtDay(day)}: ${MARKS[mark]}`)}"`;
      cells.push(`<i class="m-${mark === '.' ? 'off' : mark === '_' ? 'future' : mark}"${title}></i>`);
      if (i % 7 === 0) {
        const last = addDays(day, 6);
        // A week is labelled with a month when that month's first day falls in it.
        months.push(`<span>${last.slice(8) <= '07' ? esc(fmtDay(last, { month: 'short' })) : ''}</span>`);
      }
    }
    el.innerHTML = `
      <div class="cal-months">${months.join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-legend"><i class="m-d"></i>Done<i class="m-p"></i>Partly<i class="m-x"></i>Not done<i class="m-s"></i>Rest</div>`;
  }

  function render() {
    renderStrip();
    renderPanel();
  }

  // ---------- opening and closing ----------

  function open(id) {
    if (!byId(id)) return;
    closeTask();
    state.openId = id;
    state.history = null;
    render();
    loadHistory();
  }

  function close() {
    if (state.openId === null) return;
    state.openId = null;
    render();
  }

  // ---------- events ----------

  function onToggle(e, id) {
    const button = e.target.closest('[data-toggle]');
    if (!button) return false;
    toggle(id, { slot: button.dataset.slot || undefined, day: button.dataset.toggle, done: button.dataset.done === 'true' });
    return true;
  }

  section.addEventListener('click', (e) => {
    const row = e.target.closest('[data-habit]');
    if (!row) return;
    const id = Number(row.dataset.habit);
    if (!onToggle(e, id)) open(id);
  });
  section.addEventListener('keydown', (e) => {
    const card = e.target.closest('.habit');
    if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open(Number(card.dataset.habit));
    }
  });

  panel.addEventListener('click', (e) => {
    const id = state.openId;
    if (id === null) return;
    if (e.target.closest('#h-close')) return close();
    if (onToggle(e, id)) return;
    if (e.target.closest('[data-rest]')) return send('POST', `/api/habits/${id}/skips`);
    if (e.target.closest('[data-unrest]')) return send('POST', `/api/habits/${id}/undo`, { skip: true });
    const pause = e.target.closest('[data-pause]');
    if (pause) send('PATCH', `/api/habits/${id}`, { paused: pause.dataset.pause === 'true' });
  });

  return { refresh, open, close, isOpen: () => state.openId !== null };
}
