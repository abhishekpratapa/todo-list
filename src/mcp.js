#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies.
// Each Claude session spawns its own copy; they all share the store in store.js.

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  DASHBOARD_URL, STATUS_LABELS, STATUSES, PRIORITIES, ASSIGNEES, REPEATS, REPEAT_LABELS, TodoError,
  createTodo, updateTodo, deleteTodo, getTodo, listTodos, today, localStamp,
} from './store.js';
import { HABIT_COLORS, checkIn, createHabit, deleteHabit, getHabit, habitHistory, listHabits, undo } from './habits.js';
import * as habitText from './habit-text.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `This is the user's personal todo list. The user and all of their Claude sessions (Claude Code and Cowork) share it, and the user watches it live in the Todos app on their Mac (also at ${DASHBOARD_URL} in a browser while the app is running).
- Check it when the user asks what they need to do, what's on their plate, or what to work on next.
- When the user mentions something they need to get done, offer to add it, or add it directly if they ask you to.
- When you start working on a task that's on the list, set its status to in_progress and its assignee to claude. Leave short progress comments on long tasks, and mark the task done when you finish. Then the user and other sessions can see where things stand.
- A task can have subtasks (a checklist). When you work through a task that has them, check each one off as you finish it.
- A task can repeat, and can have a reminder time that notifies the user on their Mac. Set these when the user asks ("every Monday", "remind me at 3pm").
- This list is for the user's real to-dos. Don't add your own step-by-step work items unless the user asks you to.
- The user also tracks habits here: routines such as brushing their teeth or going to the gym, each with a streak. Use habit_list to see them and how today stands, and habit_log when the user tells you they did one. Don't create or delete a habit unless the user explicitly asks you to.`;

// Label for activity entries, e.g. "Claude Code · my-repo".
let actor = 'Claude';

function actorFor(clientInfo) {
  const name = String(clientInfo?.name || '').toLowerCase();
  let label = 'Claude';
  if (name.includes('claude-code')) label = 'Claude Code';
  else if (name.includes('cowork') || name.includes('agent')) label = 'Cowork';
  else if (name) label = `Claude (${clientInfo.name})`;
  const cwd = process.cwd();
  const project = cwd === '/' || cwd === os.homedir() ? null : path.basename(cwd);
  return project ? `${label} · ${project}` : label;
}

// ---------- formatting ----------

function dueHint(due, status) {
  if (!due) return '';
  if (status === 'done') return `due ${due}`;
  const days = Math.round((new Date(due + 'T00:00') - new Date(today() + 'T00:00')) / 864e5);
  if (days < 0) return `due ${due} (OVERDUE by ${-days}d)`;
  if (days === 0) return `due ${due} (today)`;
  if (days === 1) return `due ${due} (tomorrow)`;
  return `due ${due} (in ${days}d)`;
}

function line(t) {
  const meta = [
    t.priority !== 'medium' ? `${t.priority} priority` : null,
    dueHint(t.due, t.status) || null,
    t.project ? `project: ${t.project}` : null,
    t.tags.length ? t.tags.map((x) => '@' + x).join(' ') : null,
    t.assignee === 'claude' ? 'assigned: claude' : null,
    t.subtasks.length ? `subtasks ${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length} done` : null,
    t.repeat ? `repeats ${REPEAT_LABELS[t.repeat]}` : null,
    t.remindAt && !t.remindedAt && t.status !== 'done' ? `reminder ${localStamp(t.remindAt)}` : null,
  ].filter(Boolean);
  return `#${t.id} [${STATUS_LABELS[t.status]}] ${t.title}${meta.length ? ' — ' + meta.join(' · ') : ''}`;
}

function detail(t) {
  const out = [
    line(t),
    `created ${localStamp(t.createdAt)} by ${t.createdBy === 'me' ? 'user' : t.createdBy}` +
      (t.completedAt ? ` · completed ${localStamp(t.completedAt)}` : ''),
  ];
  if (t.subtasks.length) {
    out.push('', 'Subtasks (number = subtask id):');
    for (const x of t.subtasks) out.push(`  [${x.done ? 'x' : ' '}] ${x.id}. ${x.title}`);
  }
  if (t.notes) out.push('', 'Notes:', t.notes);
  if (t.activity.length) {
    out.push('', 'Activity:');
    for (const a of t.activity.slice(-20)) {
      const who = a.by === 'me' ? 'user' : a.by;
      out.push(`- ${localStamp(a.at)} ${who}${a.kind === 'comment' ? ': ' : ' '}${a.text}`);
    }
  }
  return out.join('\n');
}

const nextLine = (next) => (next ? `\nIt repeats, so the next occurrence was created: ${line(next)}` : '');

function summaryLine(s) {
  const parts = [`${s.open} open`, `${s.in_progress} in progress`];
  if (s.blocked) parts.push(`${s.blocked} blocked`);
  if (s.overdue) parts.push(`${s.overdue} overdue`);
  if (s.due_today) parts.push(`${s.due_today} due today`);
  parts.push(`${s.done_7d} done in last 7d`);
  return `${parts.join(' · ')}  (today is ${today()})`;
}

// ---------- tools ----------

const fieldProps = {
  notes: { type: 'string', description: 'Longer description, context, links, acceptance criteria. Markdown is fine.' },
  status: { type: 'string', enum: STATUSES },
  priority: { type: 'string', enum: PRIORITIES },
  due: { type: ['string', 'null'], description: 'Due date: YYYY-MM-DD, "today", "tomorrow", "+3d", or a weekday like "fri". null clears it.' },
  project: { type: ['string', 'null'], description: 'Project or area this belongs to, e.g. a repo name, "work", "personal".' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. ["bug", "errand"]. Replaces existing tags.' },
  assignee: { type: 'string', enum: ASSIGNEES, description: '"me" = the user does it; "claude" = a Claude session is doing it.' },
  repeat: { type: 'string', enum: [...REPEATS, 'none'], description: 'Makes the task repeat. When it is completed, the next occurrence is created automatically with the next due date. "none" stops it repeating.' },
  remind_at: { type: ['string', 'null'], description: 'When to notify the user on their Mac, in their local time: "YYYY-MM-DD HH:MM", "tomorrow 9am", "fri 14:30", or relative like "+2h". null clears it.' },
};

const subtaskIds = (what) => ({ type: 'array', items: { type: 'integer' }, description: `Ids of subtasks to ${what} (see todo_get).` });

const TOOLS = [
  {
    name: 'todo_list',
    title: 'List todos',
    description: 'List the user\'s todos with a summary (open, overdue, due today...). By default shows open items (to do, in progress, blocked), sorted by status, then priority, then due date.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'all', ...STATUSES], description: 'Default "open" (everything not done).' },
        project: { type: 'string' },
        tag: { type: 'string' },
        assignee: { type: 'string', enum: ASSIGNEES },
        query: { type: 'string', description: 'Case-insensitive text search over titles and notes.' },
        overdue: { type: 'boolean', description: 'Only overdue items.' },
        limit: { type: 'integer', minimum: 1, description: 'Max items to return (default 100).' },
      },
    },
    annotations: { readOnlyHint: true },
    run(args) {
      const { todos, total, summary } = listTodos({ limit: 100, ...args });
      const body = todos.length ? todos.map(line).join('\n') : '(no matching todos)';
      const more = total > todos.length ? `\n…and ${total - todos.length} more (raise limit or narrow filters)` : '';
      return `${summaryLine(summary)}\n\n${body}${more}`;
    },
  },
  {
    name: 'todo_get',
    title: 'Get todo details',
    description: 'Get one todo with its full notes and activity history.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
    run: ({ id }) => detail(getTodo(id)),
  },
  {
    name: 'todo_add',
    title: 'Add todo',
    description: 'Add a new item to the user\'s todo list. Write the title as a short imperative ("Renew passport"), and put details in notes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        ...fieldProps,
        subtasks: { type: 'array', items: { type: 'string' }, description: 'Checklist of steps, in order.' },
        comment: { type: 'string', description: 'Optional first activity comment.' },
      },
      required: ['title'],
    },
    run(args) {
      const t = createTodo(args, actor);
      return `Added ${line(t)}`;
    },
  },
  {
    name: 'todo_update',
    title: 'Update todo',
    description: 'Change fields on a todo, like status, priority, due date, notes, or assignee; add, check off, or remove subtasks; and/or leave a progress comment. Only the fields you pass change. Use comment to post progress updates the user will see on the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        ...fieldProps,
        add_subtasks: { type: 'array', items: { type: 'string' }, description: 'Titles of subtasks to append to the checklist.' },
        check_subtasks: subtaskIds('check off'),
        uncheck_subtasks: subtaskIds('uncheck'),
        remove_subtasks: subtaskIds('remove'),
        comment: { type: 'string', description: 'Progress note added to the activity log, e.g. "Opened PR #42, waiting on review".' },
      },
      required: ['id'],
    },
    run({ id, ...patch }) {
      const { todo, next } = updateTodo(id, patch, actor);
      return `Updated ${line(todo)}${nextLine(next)}`;
    },
  },
  {
    name: 'todo_complete',
    title: 'Complete todos',
    description: 'Mark one or more todos as done, with an optional closing comment such as what was done or a link to the result. Completing a repeating todo creates its next occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        comment: { type: 'string' },
      },
      required: ['ids'],
    },
    run({ ids, comment }) {
      return ids.map((id) => {
        try {
          const { todo, next } = updateTodo(id, { status: 'done', comment }, actor);
          return `Completed ${line(todo)}${nextLine(next)}`;
        } catch (e) {
          if (e instanceof TodoError) return `Error on #${id}: ${e.message}`;
          throw e;
        }
      }).join('\n');
    },
  },
  {
    name: 'todo_delete',
    title: 'Delete todo',
    description: 'Permanently delete a todo. Only use this when the user asks, or for an item that was added by mistake or is a duplicate. To close a finished item, use todo_complete.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    annotations: { destructiveHint: true },
    run({ id }) {
      const t = deleteTodo(id);
      return `Deleted #${t.id} ${t.title}`;
    },
  },
];

// ---------- habit tools ----------

const habitId = { type: 'integer', description: 'The habit\'s id (see habit_list).' };
const habitSlot = { type: 'string', description: 'For a habit done at several times of day, which one: its name, e.g. "Morning" or "Evening" (see habit_list). Left out, it is whichever is still to do.' };
const habitDayArg = { type: 'string', enum: ['today', 'yesterday'], description: 'Default "today". Yesterday can be logged until today ends; nothing further back can.' };

// "Brush teeth (evening)", "Gym for yesterday".
const logged = (habit, slot, day) => `${habit.name}${slot ? ` (${habitText.slotName(habit, slot).toLowerCase()})` : ''}${day === 'yesterday' ? ' for yesterday' : ''}`;

function habitList({ archived = false } = {}) {
  const { habits } = listHabits({ archived });
  if (!habits.length) return '(no habits yet)';
  const current = habits.filter((h) => !h.archived);
  const { due, done, off } = habitText.forToday(current);
  const left = habitText.leftToday(current);
  const sections = [['To do today', due], ['Done today', done], ['Nothing today', off], ['Archived', habits.filter((h) => h.archived)]]
    .filter(([, list]) => list.length)
    .map(([label, list]) => `${label}:\n${list.map((h) => habitText.detail(h)).join('\n')}`);
  return `${current.length} habit${current.length === 1 ? '' : 's'} · ${left ? `${left} check-in${left === 1 ? '' : 's'} left today` : 'nothing left today'}\n\n${sections.join('\n\n')}`;
}

TOOLS.push(
  {
    name: 'habit_list',
    title: 'List habits',
    description: 'List the user\'s habits: what is still to do today, what is done, each habit\'s schedule and its streak. Streaks are worked out by the Todos app; report them as given.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean', description: 'Also list habits the user has archived.' } } },
    annotations: { readOnlyHint: true },
    run: habitList,
  },
  {
    name: 'habit_log',
    title: 'Log a habit',
    description: 'Check in one of the user\'s habits: record that they did it. Use this when the user tells you they did something they track as a habit ("I just flossed", "log the gym for yesterday"). Don\'t log a habit on a guess.',
    inputSchema: { type: 'object', properties: { id: habitId, slot: habitSlot, day: habitDayArg }, required: ['id'] },
    run({ id, slot, day }) {
      const already = (habit) => `Nothing to log: ${habit.name} is already checked in${day === 'yesterday' ? ' for yesterday' : ' for today'}.\n${habitText.line(habit)}`;
      // A habit counted in weeks takes one visit a day. A second would be recorded and count for nothing.
      const before = getHabit(id);
      const which = { today: 'today', yesterday: 'yesterday' }[day ?? 'today']; // anything else is for checkIn to refuse
      if (before.schedule.kind === 'weekly' && (slot === undefined || slot === null) && which && before[which].done) return already(before);
      const { habit, checkin } = checkIn(id, { slot, day, source: 'claude' }, actor);
      if (!checkin) return already(habit);
      return `Logged ${logged(habit, checkin.slot, day)}.\n${habitText.detail(habit)}`;
    },
  },
  {
    name: 'habit_undo',
    title: 'Take back a habit check-in',
    description: 'Take back a check-in that a Claude session logged, for one logged by mistake. Check-ins the user made themselves (in the app, on their iPhone, from the command line) are left alone: those are theirs to take back.',
    inputSchema: { type: 'object', properties: { id: habitId, slot: habitSlot, day: habitDayArg }, required: ['id'] },
    run({ id, slot, day }) {
      const habit = getHabit(id);
      const on = habit[day === 'yesterday' ? 'yesterday' : 'today'].day;
      const wanted = slot === undefined || slot === null ? null : String(slot).trim().toLowerCase();
      const known = habit.schedule.slots?.find((s) => s.id === wanted || s.name.toLowerCase() === wanted);
      if (wanted !== null && !known) throw new TodoError(`"${habit.name}" has no slot "${slot}".`);
      const standing = habitHistory(id, { from: on, to: on }).events.filter((e) => e.kind === 'done' && !e.undone && (!known || e.slot === known.id));
      const ours = standing.filter((e) => e.source === 'claude');
      if (!ours.length) {
        const others = standing.length ? ' It is checked in, but not by a Claude session, so it was left as it is.' : '';
        return `Nothing to take back: no Claude session logged ${logged(habit, known?.id, day)}.${others}\n${habitText.line(habit)}`;
      }
      const after = undo(id, { checkins: ours.map((e) => e.id) }, actor).habit;
      return `Took back the check-in: ${logged(habit, known?.id, day)}.\n${habitText.line(after)}`;
    },
  },
  {
    name: 'habit_add',
    title: 'Add habit',
    description: 'Create a new habit. Only use this when the user explicitly asks you to create one, and confirm its schedule with them first if they did not give it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short, e.g. "Brush teeth".' },
        icon: { type: 'string', description: 'One emoji.' },
        color: { type: 'string', enum: HABIT_COLORS },
        schedule: {
          type: 'object',
          description: 'When it is done. One of: {"kind":"daily","slots":[...]} every day; {"kind":"days","days":["mon","wed","fri"],"slots":[...]} on those days of the week; {"kind":"weekly","target":3,"remind":{"days":["mon","wed","fri"],"time":"17:30"}} a number of days a week, whichever they are (remind is optional). A slot is a time of day: {"name":"Morning","remind":"07:30","from":"05:00","until":"11:00","nudge":"08:30"}, where only name is needed, remind is when to be reminded, from and until the hours it belongs in, and nudge a second reminder. Times are 24-hour, in the user\'s local time.',
        },
        day_start: { type: 'string', description: 'When the habit\'s day begins, default "03:00", so a late evening still counts for the day before.' },
      },
      required: ['name', 'schedule'],
    },
    run({ day_start: dayStart, ...input }) {
      const habit = createHabit(dayStart === undefined ? input : { ...input, dayStart }, actor);
      return `Added habit ${habitText.detail(habit)}`;
    },
  },
  {
    name: 'habit_delete',
    title: 'Delete habit',
    description: 'Permanently delete a habit together with its whole history and streak. Only use this when the user explicitly asks you to delete it. To stop a habit and keep its history, the user can pause or archive it in the Todos app instead.',
    inputSchema: { type: 'object', properties: { id: habitId }, required: ['id'] },
    annotations: { destructiveHint: true },
    run({ id }) {
      const habit = deleteHabit(id);
      return `Deleted habit #${habit.id} ${habit.name}`;
    },
  },
);

// ---------- JSON-RPC plumbing ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      actor = actorFor(params.clientInfo);
      const requested = params.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'todolist', title: 'Todo List', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ run, ...def }) => def) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
      try {
        return reply(id, { content: [{ type: 'text', text: tool.run(params.arguments || {}) }] });
      } catch (e) {
        if (!(e instanceof TodoError)) console.error(e);
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (text) => {
  if (!text.trim()) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
});
rl.on('close', () => process.exit(0));
