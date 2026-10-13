// What the Mac says about habits (src/habit-text.js) and which reminders it would
// show (src/habit-reminders.js): the dashboard, the menu bar, the morning summary
// and the MCP tools all read from these. The habits are real ones, made and
// checked in through src/habits.js with the clock pinned.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { store } from './support/helpers.js';

const habits = await import('../src/habits.js');
const text = await import('../src/habit-text.js');
const { dueReminders, reminderKey } = await import('../src/habit-reminders.js');
const { zonedInstant } = await import('../src/streaks.js');

const CHICAGO = 'America/Chicago';
const US = 'en-US';
const at = (stamp) => zonedInstant(stamp.slice(0, 10), stamp.slice(11), CHICAGO);
const on = (stamp, fn) => store.withClock(at(stamp), fn);
function fresh() {
  fs.rmSync(habits.HABITS_FILE, { force: true });
  on('2026-01-01 12:00', () => habits.setZone(CHICAGO));
}

const TWICE = {
  kind: 'daily',
  slots: [
    { name: 'Morning', remind: '07:30', from: '05:00', until: '11:00' },
    { name: 'Evening', remind: '21:30', from: '19:00', until: '02:00', nudge: '22:30' },
  ],
};
const make = (input, stamp = '2026-10-05 06:00') => on(stamp, () => habits.createHabit(input, 'me'));
const check = (id, stamp, input = {}) => on(stamp, () => habits.checkIn(id, input, 'me'));
const both = (id, day) => {
  check(id, `${day} 07:00`, { slot: 'morning' });
  check(id, `${day} 21:00`, { slot: 'evening' });
};
const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);
const list = (stamp) => on(stamp, () => habits.listHabits().habits);
const named = (all, name) => all.find((h) => h.name === name);

// Tuesday the 13th, 8 AM. Brush teeth: a week of full days, yesterday's evening
// missing, this morning done. Floss: nothing yet today. Gym: last week met.
// Read: Mondays and Wednesdays only. Stretch: paused. Vitamins: done.
function tuesday() {
  fresh();
  const brush = make({ name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE });
  for (const day of days(5, 11)) both(brush.id, day);
  check(brush.id, '2026-10-12 07:00', { slot: 'morning' });
  check(brush.id, '2026-10-13 07:00', { slot: 'morning' });
  const floss = make({ name: 'Floss', schedule: TWICE }, '2026-10-12 06:00');
  both(floss.id, '2026-10-12');
  const gym = make({ name: 'Gym', schedule: { kind: 'weekly', target: 3, remind: { days: ['mon', 'wed', 'fri'], time: '17:30' } } });
  for (const day of ['2026-10-05', '2026-10-07', '2026-10-09']) check(gym.id, `${day} 18:00`);
  make({ name: 'Read', schedule: { kind: 'days', days: ['mon', 'wed'], slots: [{ remind: '21:00' }] } });
  const stretch = make({ name: 'Stretch', schedule: { kind: 'daily', slots: [{ name: 'Morning' }] } });
  on('2026-10-10 09:00', () => habits.updateHabit(stretch.id, { paused: true }));
  const vitamins = make({ name: 'Vitamins', schedule: { kind: 'daily', slots: [{}] } }, '2026-10-13 06:00');
  check(vitamins.id, '2026-10-13 07:10');
  return list('2026-10-13 08:00');
}

test('times read the way the reader writes them', () => {
  assert.equal(text.clock('07:30', US), '7:30 AM');
  assert.equal(text.clock('21:30', US), '9:30 PM');
  assert.equal(text.clock('21:30', 'de-DE'), '21:30');
  assert.equal(text.length(1, 'days'), '1 day');
  assert.equal(text.length(12, 'days'), '12 days');
  assert.equal(text.length(1, 'weeks'), '1 week');
  assert.equal(text.rate(0.925), '93%');
  assert.equal(text.rate(null), '–');
});

test('today\'s list: what is left soonest first, then what is done, then what asks nothing', () => {
  const all = tuesday();
  const { due, done, off } = text.forToday(all);
  assert.deepEqual(due.map((h) => h.name), ['Floss', 'Brush teeth', 'Gym'], 'a morning still open comes before an evening; a habit with no time today comes last');
  assert.deepEqual(done.map((h) => h.name), ['Vitamins']);
  assert.deepEqual(off.map((h) => h.name), ['Read', 'Stretch'], 'not one of its days, and paused');
  assert.equal(text.leftToday(all), 4, 'two for Floss, one for Brush teeth, one visit to the gym');
  assert.equal(text.nextDue(named(all, 'Floss')), 270, '7:30 is four and a half hours after a 3 AM day start');
  assert.equal(text.nextDue(named(all, 'Gym')), null, 'Tuesday is not one of its reminder days');
  assert.deepEqual(text.atRiskHabits(all).map((h) => h.name), ['Brush teeth']);
});

test('the line under a habit\'s name', () => {
  const all = tuesday();
  assert.equal(text.progress(named(all, 'Brush teeth'), US), '1 of 2 · Evening 9:30 PM');
  assert.equal(text.progress(named(all, 'Floss'), US), '0 of 2 · Morning 7:30 AM');
  assert.equal(text.progress(named(all, 'Gym'), US), '0 of 3 this week');
  assert.equal(text.progress(named(all, 'Read'), US), 'Not today');
  assert.equal(text.progress(named(all, 'Stretch'), US), 'Paused');
  assert.equal(text.progress(named(all, 'Vitamins'), US), 'Done today');

  const later = list('2026-10-13 22:00');
  assert.equal(text.progress(named(later, 'Brush teeth'), US), '1 of 2 · Evening 9:30 PM', 'still open at ten');
  check(named(later, 'Brush teeth').id, '2026-10-13 22:05');
  assert.equal(text.progress(named(list('2026-10-13 22:06'), 'Brush teeth'), US), '2 of 2 · done');
  on('2026-10-13 22:10', () => habits.skipDay(named(later, 'Floss').id, {}, 'me'));
  assert.equal(text.progress(named(list('2026-10-13 22:11'), 'Floss'), US), 'Rest day');
  check(named(later, 'Gym').id, '2026-10-13 18:00');
  assert.equal(text.progress(named(list('2026-10-13 22:11'), 'Gym'), US), '1 of 3 this week');
});

test('schedules in a line', () => {
  const all = tuesday();
  assert.equal(text.schedule(named(all, 'Brush teeth').schedule, US), 'Every day · Morning 7:30 AM, Evening 9:30 PM');
  assert.equal(text.schedule(named(all, 'Gym').schedule, US), '3 days a week · reminders Mon, Wed, Fri at 5:30 PM');
  assert.equal(text.schedule(named(all, 'Read').schedule, US), 'Mon, Wed · 9:00 PM');
  assert.equal(text.schedule(named(all, 'Vitamins').schedule, US), 'Every day');
  assert.equal(text.schedule({ kind: 'weekly', target: 1, remind: null }, US), '1 day a week');
});

test('a streak that hangs on yesterday says what to do, and by when', () => {
  const all = tuesday();
  assert.equal(text.atRisk(named(all, 'Brush teeth')), 'Log yesterday’s evening by the end of today to keep your 7-day streak.');
  assert.equal(text.atRisk(named(all, 'Floss')), null, 'yesterday was finished');
  assert.equal(text.atRisk(named(all, 'Gym')), null);
});

test('a streak that ended is spoken of kindly: its length, the best, and a new start', () => {
  fresh();
  const brush = make({ name: 'Brush teeth', schedule: TWICE });
  for (const day of days(5, 9)) both(brush.id, day);
  const ended = text.ended(list('2026-10-13 08:00')[0], US);
  assert.equal(ended, 'Your 5-day streak ended after Friday. That is your best so far. Today starts a new one.');
  assert.doesNotMatch(ended, /fail|broke|lost|missed|should/i, 'no blame in it');

  // A second, shorter run after it: the best is the earlier one.
  both(brush.id, '2026-10-13');
  both(brush.id, '2026-10-14');
  assert.equal(text.ended(list('2026-10-14 23:00')[0], US), null, 'nothing has ended while a streak is running');
  assert.equal(text.ended(list('2026-10-17 08:00')[0], US), 'Your 2-day streak ended after Wednesday. Your best is 5 days. Today starts a new one.');
  assert.equal(text.ended(list('2026-11-20 08:00')[0], US), 'Your 2-day streak ended. Your best is 5 days. Today starts a new one.', 'the day is only named while it is recent');

  // One day is not a streak worth mourning.
  const once = make({ name: 'Once', schedule: TWICE }, '2026-10-05 06:00');
  both(once.id, '2026-10-05');
  assert.equal(text.ended(named(list('2026-10-13 08:00'), 'Once'), US), null);
});

test('the slot a check-in would be for, by the server\'s own rule', () => {
  const all = tuesday();
  const floss = named(all, 'Floss');
  assert.equal(text.nextSlot(floss, '08:00'), 'morning', 'in the morning\'s hours');
  assert.equal(text.nextSlot(floss, '21:40'), 'evening', 'in the evening\'s hours');
  assert.equal(text.nextSlot(floss, '01:30'), 'evening', 'which run past midnight');
  assert.equal(text.nextSlot(floss, '14:00'), 'morning', 'in nobody\'s hours, the earliest still to do');
  assert.equal(text.nextSlot(named(all, 'Brush teeth'), '08:00'), 'evening', 'the only one left');
  assert.equal(text.nextSlot(named(all, 'Gym'), '08:00'), undefined, 'a habit counted in weeks has no slots');
  // The server agrees: a check-in with no slot named, at each of those times.
  for (const [time, slot] of [['08:00', 'morning'], ['21:40', 'evening']]) {
    fresh();
    const { id } = make({ name: 'Floss', schedule: TWICE });
    assert.equal(check(id, `2026-10-13 ${time}`).checkin.slot, slot);
  }
});

test('the morning summary: which habits today asks for, and streaks at risk', () => {
  const all = tuesday();
  assert.deepEqual(text.dailyHabitSummary(all), {
    title: '3 habits today · 1 streak at risk',
    body: 'Habits: Floss, Brush teeth, Gym\nStill time for yesterday: Brush teeth (7-day streak)',
  });
  assert.deepEqual(text.dailyHabitSummary(all.filter((h) => h.name === 'Gym')), { title: '1 habit today', body: 'Habits: Gym' });
  assert.equal(text.dailyHabitSummary(all.filter((h) => ['Read', 'Stretch', 'Vitamins'].includes(h.name))), null, 'nothing to say when nothing is asked');
  assert.equal(text.dailyHabitSummary([]), null);
  const many = Array.from({ length: 6 }, (_, i) => ({ ...named(all, 'Floss'), id: 100 + i, name: `Habit ${i + 1}` }));
  assert.equal(text.dailyHabitSummary(many).body, 'Habits: Habit 1, Habit 2, Habit 3, Habit 4, and 2 more');
});

test('a habit in a line, for Claude', () => {
  const all = tuesday();
  assert.equal(text.line(named(all, 'Brush teeth')), '#1 Brush teeth — today 1 of 2 (evening still to do) · streak 7 days');
  assert.equal(text.line(named(all, 'Floss')), '#2 Floss — today 0 of 2 (morning and evening still to do) · streak 1 day');
  assert.equal(text.line(named(all, 'Gym')), '#3 Gym — 0 of 3 this week · streak 1 week');
  assert.equal(text.line(named(all, 'Read')), '#4 Read — nothing expected today · no streak yet');
  assert.equal(text.line(named(all, 'Stretch')), '#5 Stretch — paused · no streak yet');
  assert.equal(text.line(named(all, 'Vitamins')), '#6 Vitamins — today done (1 of 1) · streak 1 day');
  assert.equal(
    text.detail(named(all, 'Brush teeth'), US),
    '#1 Brush teeth — today 1 of 2 (evening still to do) · streak 7 days\n  Every day · Morning 7:30 AM, Evening 9:30 PM\n  Log yesterday’s evening by the end of today to keep your 7-day streak.',
  );
});

// ---------- reminders on the Mac ----------

// A moment on this machine's own clock, which is what the Mac's reminders go by.
const local = (day, time) => new Date(`${day}T${time}:00`).getTime();

test('a reminder is due from its time until its slot\'s hours end, only for something still to do', () => {
  const all = tuesday();
  const due = (time, shown = [], day = '2026-10-13') => dueReminders(all, local(day, time), shown);
  const keys = (list) => list.map((r) => r.key);

  assert.deepEqual(keys(due('07:29')), [], 'not before its time');
  assert.deepEqual(due('07:30'), [{ key: 'habit-2-morning-2026-10-13', habit: 2, slot: 'morning', title: 'Floss', body: 'Morning · Keeps your 1-day streak going.' }]);
  assert.deepEqual(keys(due('10:59')), ['habit-2-morning-2026-10-13'], 'still worth saying while the morning lasts');
  assert.deepEqual(keys(due('11:00')), [], 'and not once its hours are over');
  assert.deepEqual(keys(due('07:31', ['habit-2-morning-2026-10-13'])), [], 'one that was shown is not shown again');
  assert.equal(reminderKey(2, 'morning', '2026-10-13'), 'habit-2-morning-2026-10-13', 'named as the iPhone names its own');

  // The evening: Brush teeth (morning done) and Floss, then their second reminders.
  assert.deepEqual(keys(due('21:30')), ['habit-1-evening-2026-10-13', 'habit-2-evening-2026-10-13']);
  const nudges = due('22:30', ['habit-1-evening-2026-10-13', 'habit-2-evening-2026-10-13']);
  assert.deepEqual(keys(nudges), ['habit-1-evening-2026-10-13-nudge', 'habit-2-evening-2026-10-13-nudge']);
  assert.deepEqual([nudges[0].title, nudges[0].body], ['🪥 Brush teeth', 'Evening is still open, and so is your 7-day streak.']);
  // Past midnight is still Tuesday's evening, until its hours end at two.
  assert.deepEqual(keys(dueReminders(all, local('2026-10-14', '01:59'))).filter((k) => !k.endsWith('-nudge')), ['habit-1-evening-2026-10-13', 'habit-2-evening-2026-10-13']);
  assert.deepEqual(keys(dueReminders(all, local('2026-10-14', '02:00'))), []);

  // Nothing for what is done, paused, or not expected today.
  assert.equal(keys(due('07:45')).some((k) => /^habit-(1-morning|4|5|6)-/.test(k)), false);
});

test('a habit counted in weeks reminds on its days, until the week is met', () => {
  fresh();
  const gym = make({ name: 'Gym', icon: '🏋️', schedule: { kind: 'weekly', target: 2, remind: { days: ['mon', 'wed'], time: '17:30' } } });
  const reminders = (stamp, now) => dueReminders(list(stamp), local(stamp.slice(0, 10), now));
  assert.deepEqual(reminders('2026-10-05 17:00', '17:30'), [{ key: 'habit-1-visit-2026-10-05', habit: 1, slot: null, title: '🏋️ Gym', body: '0 of 2 this week' }]);
  assert.deepEqual(reminders('2026-10-05 17:00', '19:29').length, 1, 'for two hours, having no hours of its own');
  assert.deepEqual(reminders('2026-10-05 17:00', '19:30'), []);
  assert.deepEqual(reminders('2026-10-06 17:00', '17:30'), [], 'Tuesday is not one of its days');
  check(gym.id, '2026-10-05 18:00');
  assert.deepEqual(reminders('2026-10-05 18:30', '18:31'), [], 'checked in today');
  check(gym.id, '2026-10-06 18:00');
  assert.deepEqual(reminders('2026-10-07 17:00', '17:30'), [], 'the week is met');
  assert.equal(reminders('2026-10-12 17:00', '17:30')[0].body, '0 of 2 this week · 1 week so far');
});
