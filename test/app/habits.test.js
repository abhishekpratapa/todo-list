// Habits, in the real app: the menu bar item lists what is left today and checks
// a habit in with a click, it follows check-ins made elsewhere, and "Habit
// Reminders on This Mac" shows nothing until it is turned on.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { ask, sandbox, skip, sleep, until } from './support.js';

let app;
let habits;
after(() => app?.cleanup());

const pad = (n) => String(n).padStart(2, '0');
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
// What the menu bar item's menu lists, as the app last logged it.
const menu = () => {
  const line = app.lines().filter((l) => l.startsWith('tray: ')).at(-1);
  return line ? JSON.parse(line.slice(line.indexOf('menu=') + 'menu='.length)) : [];
};
const menuHas = (...labels) => until(() => labels.every((label) => menu().includes(label)), 5000);
const settings = () => JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8'));
const habit = async (id) => (await ask(app.socketPath, 'GET', `/api/v1/habits/${id}`)).body.habit;

test('the menu bar item lists the habits left today', { skip }, async () => {
  app = sandbox();
  // The app's data folder, seeded before it starts. Floss has a reminder that came
  // due a minute ago; its day starts half a day from now, so that minute is today's.
  process.env.TODO_DATA_FILE = app.dataFile;
  habits = await import('../../src/habits.js');
  const now = new Date();
  habits.createHabit({
    name: 'Floss', icon: '🧵', dayStart: `${pad((now.getHours() + 12) % 24)}:00`,
    schedule: { kind: 'daily', slots: [{ name: 'Evening', remind: clock(new Date(now.getTime() - 60_000)) }] },
  }, 'me');
  habits.createHabit({ name: 'Gym', schedule: { kind: 'weekly', target: 3 } }, 'me');

  app.open(['-g'], ['--background']);
  await app.started();
  assert.ok(await menuHas('Habits · 2 left today', 'Floss · Evening', 'Gym · 0 of 3 this week'), `the menu was: ${JSON.stringify(menu())}`);
  assert.ok(menu().indexOf('Habits · 2 left today') < menu().indexOf('Open Todos'), 'above the items that close the menu');
  assert.match(app.lines().filter((l) => l.startsWith('tray: ')).at(-1), /title=""/, 'habits are listed, not counted beside the icon');
});

test('habit reminders stay quiet on the Mac until they are turned on', { skip }, async () => {
  await sleep(4500); // the app's first look for reminders comes three seconds after it starts
  assert.equal(settings().habitReminded?.length ?? 0, 0, 'off to begin with: the due reminder was not shown');
  assert.notEqual(settings().habitNotifications, true);

  await app.click('habit-reminders');
  const { today } = await habit(1);
  assert.ok(await until(() => settings().habitReminded?.includes(`habit-1-evening-${today.day}`), 5000), 'turned on, what is due now is shown at once');
  assert.equal(settings().habitNotifications, true);
  await sleep(1000);
  assert.equal(settings().habitReminded.length, 1, 'and only once');
});

test('a click on a habit in the menu checks it in', { skip }, async () => {
  await app.click('habit-1');
  const floss = await habit(1);
  const [evening] = floss.today.slots;
  assert.deepEqual([evening.done, evening.by, evening.via, evening.source], [true, 'me', undefined, 'manual'], 'by you, on the Mac itself');
  assert.ok(await menuHas('Habits · 1 left today'), `the menu was: ${JSON.stringify(menu())}`);
  assert.equal(menu().includes('Floss · Evening'), false, 'what is done is no longer offered');

  await app.click('habit-2');
  assert.equal((await habit(2)).week.count, 1);
  assert.ok(await menuHas('Habits · all done today'), `the menu was: ${JSON.stringify(menu())}`);
});

test('the menu follows a check-in made somewhere else', { skip }, async () => {
  // The `todos` command takes the gym visit back, over the local socket.
  assert.equal((await ask(app.socketPath, 'POST', '/api/v1/habits/2/undo', {})).status, 200);
  assert.ok(await menuHas('Habits · 1 left today', 'Gym · 0 of 3 this week'), `the menu was: ${JSON.stringify(menu())}`);
  assert.equal((await app.state()).window, 'none', 'and none of this opened a window');
});
