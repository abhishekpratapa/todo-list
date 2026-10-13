// The versioned API for other clients: /api/v1. On the port it is only served
// while remote access is on, and every route except health and sign-in needs a
// session (see admit() in server.js). On the local socket it is always served,
// with no sign-in (see admitLocal() there). Documented in docs/openapi.json.
//
// Conventions:
//   - Errors are always { "error": { "code", "message" } }.
//   - A task comes back as { "task": {...} } with its revision in the ETag header.
//   - Edits and deletes must say which revision they are based on (If-Match, or
//     "rev" in the body). A stale one gets 409 with the current task instead of
//     overwriting someone else's change.
//   - All changes go through the same store, and the same file lock, as the app
//     and the MCP server, and are recorded in the task's activity with the device
//     or client that made them.

import fs from 'node:fs';
import path from 'node:path';
import { clearedCookie, sessionCookie } from './auth.js';
import { RequestError, json, readJson, readJsonOrText } from './http.js';
import { parseQuickAdd } from './quickadd.js';
import {
  ASSIGNEES, PRIORITIES, ROOT, STATUSES, ConflictError, NotFoundError, TodoError,
  createTodo, dailySummary, deleteTodo, dueGroups, getTodo, load, sortTodos, summarize, today, updateTodo, withClock, ymd,
} from './store.js';

// What GET /meta reports, so a client can check it is compatible before relying on
// anything. Within v1 things are only ever added, never removed or changed, and
// each addition raises the revision, so a client needs "version 1, revision N or later".
//   1  Todos 1.4. Has no /meta: a 404 there means revision 1.
//   2  Todos 1.5. GET /meta; `version` in GET /tasks.
//   3  Todos 1.6. Idempotency-Key on every change; `at` on /capture and /capture/preview.
//   4  The release with the command-line client. GET /info; the whole API on the local
//      socket (see socket.js), where a few routes exist that are served nowhere else.
export const API_VERSION = 1;
export const API_REVISION = 4;
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// The oldest version of each kind of client that still works with this app. A
// client older than its entry should stop and ask to be updated; one that isn't
// listed has no minimum.
export const MIN_CLIENT_VERSIONS = { cli: '0.1.0', ios: '1.0' };

// What GET /health answers, on the port and on the socket: that the server is
// up, and what it speaks. Nothing about the list, so it needs no sign-in.
export const health = () => ({ status: 'ok', appVersion: APP_VERSION, apiVersion: { version: API_VERSION, revision: API_REVISION } });

const EDITABLE = ['title', 'notes', 'status', 'priority', 'due', 'project', 'tags', 'assignee', 'repeat', 'remindAt'];

const error = (res, status, code, message, extra = {}) => json(res, status, { error: { code, message, ...extra } });

// Lists leave out each task's activity log to stay small; `comments` says how many there are.
const brief = ({ activity, ...task }) => ({ ...task, comments: activity.filter((a) => a.kind === 'comment').length });

function sendTask(res, status, task, extra = {}) {
  res.setHeader('ETag', `"${task.rev}"`);
  json(res, status, { task, ...extra });
}

// A JSON object containing only the fields this endpoint accepts.
function only(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'invalid', 'Expected a JSON object.');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new RequestError(400, 'unknown_field', `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  return body;
}

// The revision a change is based on: If-Match ("3", W/"3" or 3), or `rev` in the
// body or query. `If-Match: *` means "overwrite whatever is there" and returns
// null. Leaving it out altogether is refused, so nothing is overwritten by accident.
function expectedRev(req, fallback) {
  const header = req.headers['if-match'];
  const raw = header !== undefined ? String(header).trim() : fallback;
  if (raw === undefined || raw === null || raw === '') {
    throw new RequestError(428, 'precondition_required', 'Say which revision you are changing: send If-Match with the task\'s rev (or "rev" in the body). If-Match: * overwrites regardless.');
  }
  if (raw === '*') return null;
  const m = String(raw).match(/^(?:W\/)?"?(\d+)"?$/);
  if (!m) throw new RequestError(400, 'invalid', 'The revision must be the task\'s rev, for example If-Match: "3".');
  return Number(m[1]);
}

// A client that might send the same change twice (a retry after the answer was lost,
// or a change queued while offline) names it with an Idempotency-Key header. The
// second time nothing is done again, and the answer is the task as it is now.
function idempotencyKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  const key = String(raw).trim();
  if (!/^[\w-]{8,64}$/.test(key)) throw new RequestError(400, 'invalid', 'Idempotency-Key must be 8 to 64 letters, digits, hyphens or underscores.');
  return key;
}

// When a captured line was typed, if the client says. Relative dates in the line
// ("tomorrow", "fri", "3pm") are then read from that moment instead of from now.
function capturedAt(at) {
  if (at === undefined || at === null) return null;
  const time = typeof at === 'string' ? Date.parse(at) : NaN;
  if (Number.isNaN(time)) throw new RequestError(400, 'invalid', '"at" must be a timestamp, for example 2026-10-12T18:30:00Z.');
  if (time > Date.now() + 5 * 60_000) throw new RequestError(400, 'invalid', '"at" is when the line was typed, so it cannot be in the future.');
  return time;
}

const readLine = (text, at) => {
  const time = capturedAt(at);
  return time === null ? parseQuickAdd(text) : withClock(time, () => parseQuickAdd(text));
};

// ---------- listing ----------

function oneOrMore(q, name, allowed) {
  const raw = q.get(name);
  if (raw === null || raw === '') return null;
  const values = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = values.find((v) => !allowed.includes(v));
  if (bad) throw new RequestError(400, 'invalid', `Invalid ${name} "${bad}". Expected one of: ${allowed.join(', ')}.`);
  return values;
}

function wholeNumber(q, name, fallback, max) {
  const raw = q.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new RequestError(400, 'invalid', `${name} must be a whole number.`);
  return Math.min(Number(raw), max);
}

function listTasks(q) {
  let statuses = oneOrMore(q, 'status', ['open', 'all', ...STATUSES]) || ['open'];
  if (statuses.includes('all')) statuses = STATUSES;
  else if (statuses.includes('open')) statuses = [...new Set([...statuses.filter((s) => s !== 'open'), 'todo', 'in_progress', 'blocked'])];
  const priorities = oneOrMore(q, 'priority', PRIORITIES);
  const assignees = oneOrMore(q, 'assignee', ASSIGNEES);
  const project = q.get('project');
  const tag = (q.get('tag') || '').replace(/^[#@]/, '').toLowerCase();
  const words = (q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const due = (q.get('due') || '').toLowerCase();
  if (due && !['overdue', 'today', 'week', 'none', 'any'].includes(due) && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new RequestError(400, 'invalid', 'Invalid due. Expected overdue, today, week, none, any, or a date (YYYY-MM-DD) to list what is due on or before it.');
  }
  const limit = wholeNumber(q, 'limit', 200, 500);
  const offset = wholeNumber(q, 'offset', 0, Number.MAX_SAFE_INTEGER);

  const t0 = today();
  const weekOut = new Date();
  weekOut.setDate(weekOut.getDate() + 7);
  const week = ymd(weekOut);
  const dueOk = (t) => {
    switch (due) {
      case '': return true;
      case 'overdue': return !!t.due && t.due < t0 && t.status !== 'done';
      case 'today': return t.due === t0;
      case 'week': return !!t.due && t.due >= t0 && t.due <= week;
      case 'none': return !t.due;
      case 'any': return !!t.due;
      default: return !!t.due && t.due <= due;
    }
  };

  const db = load();
  const all = db.todos;
  const matching = sortTodos(all.filter((t) =>
    statuses.includes(t.status)
    && (!priorities || priorities.includes(t.priority))
    && (!assignees || assignees.includes(t.assignee))
    && (project === null || (t.project || '').toLowerCase() === project.toLowerCase())
    && (!tag || t.tags.includes(tag))
    && dueOk(t)
    && words.every((w) => [t.title, t.notes, t.project || '', ...t.tags, ...t.subtasks.map((s) => s.title)].join('\n').toLowerCase().includes(w))));
  // `version` is the list's version, the same number live updates announce.
  return { tasks: matching.slice(offset, offset + limit).map(brief), total: matching.length, summary: summarize(all), version: db.version };
}

function subtaskOf(taskId, subtaskId) {
  const task = getTodo(taskId);
  if (!task.subtasks.some((s) => s.id === Number(subtaskId))) throw new NotFoundError(`Task #${task.id} has no subtask ${subtaskId}`);
  return task;
}

// ---------- routes ----------

export function createV1({ remote, openStream, viaLabel }) {
  // What every change records: who it came through, and its idempotency key if it has one.
  const write = async (req, ctx) => ({ key: idempotencyKey(req), via: await viaLabel(req, ctx) });

  // [method, path template, handler({ req, res, ctx, url, params }), where]
  // `where` limits a route to one listener: 'port' or 'socket'. Elsewhere the path
  // is answered exactly as one that does not exist. Most routes are on both.
  const ROUTES = [
    // Reveals nothing: that something answers here is already visible from the connection itself.
    ['GET', '/health', ({ res }) => json(res, 200, { status: 'ok' })],

    // Sign in: exchange the access token for a session cookie. There is nothing to
    // sign in to on the socket.
    ['POST', '/session', async ({ req, res, ctx }) => {
      const { token } = only(await readJson(req, ctx.bodyLimit), ['token']);
      if (typeof token !== 'string' || !remote.checkToken(token.trim())) return ctx.refuseBadToken();
      res.setHeader('Set-Cookie', sessionCookie(remote.issueSession(), { secure: ctx.secure }));
      return json(res, 200, { ok: true });
    }, 'port'],
    ['GET', '/session', ({ res, ctx }) => json(res, 200, { kind: ctx.session.kind })],
    ['DELETE', '/session', ({ res, ctx }) => {
      res.setHeader('Set-Cookie', clearedCookie({ secure: ctx.secure }));
      return json(res, 200, { ok: true });
    }, 'port'],

    ['GET', '/meta', ({ res }) => json(res, 200, { api: { version: API_VERSION, revision: API_REVISION }, app: { name: 'Todos', version: APP_VERSION } })],
    // The health check's answer, plus how old a client may be and still work.
    ['GET', '/info', ({ res }) => json(res, 200, { ...health(), minClientVersions: MIN_CLIENT_VERSIONS })],

    ['GET', '/events', ({ req, res, ctx }) => openStream(req, res, ctx)],

    ['GET', '/tasks', ({ res, url }) => json(res, 200, listTasks(url.searchParams))],
    ['POST', '/tasks', async ({ req, res, ctx }) => {
      const body = only(await readJson(req, ctx.bodyLimit), [...EDITABLE, 'subtasks']);
      if (!('title' in body)) throw new RequestError(400, 'invalid', 'A task needs a title.');
      const task = createTodo(body, 'me', await write(req, ctx));
      res.setHeader('Location', `/api/v1/tasks/${task.id}`);
      return sendTask(res, 201, task);
    }],

    ['GET', '/tasks/{id}', ({ res, params }) => sendTask(res, 200, getTodo(params.id))],
    ['PATCH', '/tasks/{id}', async ({ req, res, ctx, params }) => {
      const { rev, ...patch } = only(await readJson(req, ctx.bodyLimit), [...EDITABLE, 'rev']);
      const { todo, next } = updateTodo(params.id, patch, 'me', { ifRev: expectedRev(req, rev), ...(await write(req, ctx)) });
      return sendTask(res, 200, todo, { next });
    }],
    ['DELETE', '/tasks/{id}', ({ req, res, url, params }) => {
      deleteTodo(params.id, { ifRev: expectedRev(req, url.searchParams.get('rev')) });
      res.writeHead(204);
      return res.end();
    }],

    // Additive changes below need no revision: they can't overwrite anyone else's work.
    ['POST', '/tasks/{id}/complete', async ({ req, res, ctx, params }) => {
      const body = req.headers['content-length'] > 0 ? only(await readJson(req, ctx.bodyLimit), ['comment']) : {};
      const { todo, next } = updateTodo(params.id, { status: 'done', comment: body.comment }, 'me', await write(req, ctx));
      return sendTask(res, 200, todo, { next });
    }],

    ['POST', '/tasks/{id}/subtasks', async ({ req, res, ctx, params }) => {
      const body = only(await readJson(req, ctx.bodyLimit), ['title', 'titles']);
      const titles = [body.title, ...(Array.isArray(body.titles) ? body.titles : [])].filter((t) => typeof t === 'string' && t.trim());
      if (!titles.length) throw new RequestError(400, 'invalid', 'Send "title", or "titles" as a list.');
      return sendTask(res, 201, updateTodo(params.id, { add_subtasks: titles }, 'me', await write(req, ctx)).todo);
    }],
    ['PATCH', '/tasks/{id}/subtasks/{subtaskId}', async ({ req, res, ctx, params }) => {
      const body = only(await readJson(req, ctx.bodyLimit), ['title', 'done']);
      subtaskOf(params.id, params.subtaskId);
      const id = Number(params.subtaskId);
      const patch = {};
      if ('title' in body) patch.rename_subtask = { id, title: body.title };
      if (body.done === true) patch.check_subtasks = [id];
      else if (body.done === false) patch.uncheck_subtasks = [id];
      else if ('done' in body) throw new RequestError(400, 'invalid', '"done" must be true or false.');
      return sendTask(res, 200, updateTodo(params.id, patch, 'me', await write(req, ctx)).todo);
    }],
    ['DELETE', '/tasks/{id}/subtasks/{subtaskId}', async ({ req, res, ctx, params }) => {
      subtaskOf(params.id, params.subtaskId);
      return sendTask(res, 200, updateTodo(params.id, { remove_subtasks: [Number(params.subtaskId)] }, 'me', await write(req, ctx)).todo);
    }],

    ['POST', '/tasks/{id}/comments', async ({ req, res, ctx, params }) => {
      const { text } = only(await readJson(req, ctx.bodyLimit), ['text']);
      if (typeof text !== 'string' || !text.trim()) throw new RequestError(400, 'invalid', 'A comment needs "text".');
      return sendTask(res, 201, updateTodo(params.id, { comment: text }, 'me', await write(req, ctx)).todo);
    }],
    ['GET', '/tasks/{id}/activity', ({ res, url, params }) => {
      const kind = url.searchParams.get('kind');
      if (kind && kind !== 'comment' && kind !== 'event') throw new RequestError(400, 'invalid', 'kind must be comment or event.');
      const { activity } = getTodo(params.id);
      return json(res, 200, { activity: kind ? activity.filter((a) => a.kind === kind) : activity });
    }],

    // Quick capture: one line, parsed exactly as the app's capture box and add bar parse it.
    // Takes JSON { "text": "...", "at"?: when it was typed } or the bare line as text/plain.
    ['POST', '/capture', async ({ req, res, ctx }) => {
      const { text, at } = only(await readJsonOrText(req, ctx.bodyLimit), ['text', 'at']);
      if (typeof text !== 'string' || !text.trim()) throw new RequestError(400, 'invalid', 'Send the line to capture as "text".');
      const parsed = readLine(text, at);
      if (!parsed.title) throw new RequestError(400, 'invalid', 'That line has no title, only dates and markers.');
      const task = createTodo({ ...parsed.fields, title: parsed.title }, 'me', await write(req, ctx));
      res.setHeader('Location', `/api/v1/tasks/${task.id}`);
      return sendTask(res, 201, task, { parsed });
    }],
    ['POST', '/capture/preview', async ({ req, res, ctx }) => {
      const { text, at } = only(await readJsonOrText(req, ctx.bodyLimit), ['text', 'at']);
      return json(res, 200, readLine(typeof text === 'string' ? text : '', at));
    }],

    // What the Mac's menu bar item lists, plus tasks due later than a week out.
    ['GET', '/due', ({ res }) => {
      const groups = dueGroups(load().todos);
      const counts = Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, list.length]));
      return json(res, 200, { ...Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, list.map(brief)])), counts, date: today() });
    }],
    // The counts on the dashboard's tiles, and what the 9 AM notification would say right now.
    ['GET', '/summary', ({ res }) => {
      const { todos } = load();
      const daily = dailySummary(todos);
      return json(res, 200, { counts: summarize(todos), daily: daily && { title: daily.title, body: daily.body, tasks: daily.tasks.map(brief) }, date: today() });
    }],
  ].map(([method, template, handler, where]) => ({
    method,
    template,
    handler,
    where,
    names: [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    pattern: new RegExp(`^${template.replace(/\{\w+\}/g, '(\\d+)')}$`),
  }));

  async function v1(req, res, ctx, url) {
    const path = url.pathname.slice('/api/v1'.length);
    const here = ctx.local ? 'socket' : 'port';
    const matching = ROUTES.filter((r) => r.pattern.test(path) && (!r.where || r.where === here));
    const route = matching.find((r) => r.method === req.method);
    // Something served only on the other listener does not exist on this one.
    const elsewhere = !route && ROUTES.some((r) => r.pattern.test(path) && r.method === req.method);
    if (!matching.length || elsewhere) return error(res, 404, 'not_found', 'No such endpoint.');
    if (!route) {
      res.setHeader('Allow', matching.map((r) => r.method).join(', '));
      return error(res, 405, 'method_not_allowed', `${req.method} is not supported here.`);
    }
    const values = path.match(route.pattern).slice(1);
    const params = Object.fromEntries(route.names.map((name, i) => [name, values[i]]));
    return route.handler({ req, res, ctx, url, params });
  }

  // Turns a thrown error into a response.
  v1.fail = (res, e) => {
    if (e instanceof ConflictError) return error(res, 409, 'conflict', e.message, { current: e.current });
    if (e instanceof NotFoundError) return error(res, 404, 'not_found', e.message);
    if (e instanceof RequestError) return error(res, e.status, e.code, e.message);
    if (e instanceof TodoError) return error(res, 400, 'invalid', e.message);
    console.error(e);
    return error(res, 500, 'internal', 'Internal error');
  };

  // For the test that keeps docs/openapi.json in step with what is actually served.
  v1.routes = ROUTES.map(({ method, template, where }) => ({ method, path: template, ...(where ? { where } : {}) }));

  return v1;
}
