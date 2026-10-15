// When a Mac starts using another Mac's list, it offers to copy its own open
// tasks there. This is the copying: each task is added to the host as a new one,
// with its fields and checklist. This Mac's own list is left as it was. Comments
// and history stay here, as do done tasks. Node built-ins only.

import crypto from 'node:crypto';

// What is copied of a task: everything the API lets a client set when adding one.
// A reminder already in the past is left out, so the host doesn't fire it at once.
function fieldsOf(todo, now) {
  const fields = {
    title: todo.title,
    notes: todo.notes,
    status: todo.status,
    priority: todo.priority,
    due: todo.due,
    project: todo.project,
    tags: todo.tags,
    assignee: todo.assignee,
    repeat: todo.repeat,
    subtasks: todo.subtasks.map((s) => s.title),
  };
  if (todo.remindAt && Date.parse(todo.remindAt) > now) fields.remindAt = todo.remindAt;
  return fields;
}

// The same task always gets the same key, so copying again (after a dropped
// connection, say) adds nothing twice.
const keyFor = (todo) => `copy-${crypto.createHash('sha256').update(`${todo.createdAt}|${todo.id}|${todo.title}`).digest('hex').slice(0, 40)}`;

// The tasks that would be offered: everything not done.
export const copyable = (todos) => todos.filter((t) => t.status !== 'done');

// Copies `todos` to the host behind `conn` (see host.js). Resolves to
// { copied, failed: [{ title, reason }] }; one task that can't be copied doesn't
// stop the rest.
export async function copyTasks(conn, todos, { now = Date.now() } = {}) {
  const result = { copied: 0, failed: [] };
  for (const todo of todos) {
    try {
      const made = await conn.request('POST', '/api/v1/tasks', { body: fieldsOf(todo, now), headers: { 'idempotency-key': keyFor(todo) } });
      if (made.status !== 201 && made.status !== 200) throw new Error(made.body?.error?.message || `${conn.name} answered ${made.status}`);
      // The checklist arrives unticked; tick what was ticked here.
      const { task } = made.body;
      for (const [i, sub] of todo.subtasks.entries()) {
        if (sub.done && task.subtasks[i] && !task.subtasks[i].done) {
          await conn.request('PATCH', `/api/v1/tasks/${task.id}/subtasks/${task.subtasks[i].id}`, { body: { done: true } });
        }
      }
      result.copied += 1;
    } catch (e) {
      result.failed.push({ title: todo.title, reason: e.message });
    }
  }
  return result;
}
