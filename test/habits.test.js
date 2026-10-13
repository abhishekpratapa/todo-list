// Habits and their streaks: the rules in src/streaks.js and the store in
// src/habits.js, with the clock pinned so each test says exactly what day it is.
// The API on top of them is tested in habits-api.test.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { store } from './support/helpers.js';

const habits = await import('../src/habits.js');
const { addDays, calendar, habitDay, localParts, weekStart, weekday, zonedInstant } = await import('../src/streaks.js');
const { HABITS_FILE, HabitConflictError, HabitError } = habits;

const CHICAGO = 'America/Chicago';
const TOKYO = 'Asia/Tokyo';
const LA = 'America/Los_Angeles';

// "2026-10-05 07:00" on a clock in `zone`, as an instant.
const at = (stamp, zone = CHICAGO) => zonedInstant(stamp.slice(0, 10), stamp.slice(11), zone);
// Runs fn as if it were that moment.
const on = (stamp, fn, zone = CHICAGO) => store.withClock(at(stamp, zone), fn);

// A clean slate, with the user in Chicago since before anything happens.
function fresh() {
  fs.rmSync(HABITS_FILE, { force: true });
  on('2026-01-01 12:00', () => habits.setZone(CHICAGO));
}

const TWICE = {
  kind: 'daily',
  slots: [
    { name: 'Morning', remind: '07:30', from: '05:00', until: '11:00' },
    { name: 'Evening', remind: '21:30', from: '19:00', until: '02:00', nudge: '22:30' },
  ],
};
const brush = (stamp = '2026-10-05 06:00') => on(stamp, () => habits.createHabit({ name: 'Brush teeth', icon: '🪥', color: 'blue', schedule: TWICE }, 'me'));
const gym = (stamp = '2026-10-05 06:00', target = 3) => on(stamp, () => habits.createHabit({ name: 'Gym', schedule: { kind: 'weekly', target } }, 'me'));
const check = (id, stamp, input = {}, options = {}) => on(stamp, () => habits.checkIn(id, input, 'me', options));
const both = (id, day) => {
  check(id, `${day} 07:00`, { slot: 'morning' });
  check(id, `${day} 21:00`, { slot: 'evening' });
};
const see = (id, stamp) => on(stamp, () => habits.getHabit(id));
const refused = (code) => (e) => e instanceof HabitError && e.code === code;

// ---------- dates ----------

test('a habit day runs from the day start, and is named for the date it starts on', () => {
  assert.equal(habitDay(at('2026-10-13 00:30'), CHICAGO, '03:00'), '2026-10-12', 'after midnight is still the evening before');
  assert.equal(habitDay(at('2026-10-13 02:59'), CHICAGO, '03:00'), '2026-10-12');
  assert.equal(habitDay(at('2026-10-13 03:00'), CHICAGO, '03:00'), '2026-10-13');
  assert.equal(habitDay(at('2026-10-13 00:30'), CHICAGO, '00:00'), '2026-10-13', 'a habit can keep calendar days instead');
  assert.equal(habitDay(at('2026-10-13 00:30', TOKYO), TOKYO, '03:00'), '2026-10-12', 'by the clock where the user is');
  assert.equal(habitDay(at('2026-10-13 00:30'), TOKYO, '03:00'), '2026-10-13', 'the same instant is mid-afternoon in Tokyo');
  assert.deepEqual(localParts(Date.parse('2026-10-13T05:30:00Z'), CHICAGO), { date: '2026-10-13', time: '00:30' });
  assert.deepEqual(localParts(Date.parse('2026-10-13T05:30:00Z'), TOKYO), { date: '2026-10-13', time: '14:30' });
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(weekday('2026-10-13'), 'tue');
  assert.equal(weekStart('2026-10-13'), '2026-10-12', 'weeks start on Monday');
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekStart('2026-10-18'), '2026-10-12', 'and Sunday ends them');
});

// ---------- slots ----------

test('a day counts when every slot is checked in; a partial day shows its progress and does not', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  check(id, '2026-10-06 07:00', { slot: 'morning' });

  let h = see(id, '2026-10-06 22:00');
  assert.deepEqual([h.today.day, h.today.state, h.today.done, h.today.total], ['2026-10-06', 'open', 1, 2]);
  assert.deepEqual(h.today.slots.map((s) => [s.id, s.done]), [['morning', true], ['evening', false]]);
  assert.deepEqual([h.streak.current, h.streak.best, h.streak.unit], [1, 1, 'days'], 'Monday counted; an unfinished today neither adds nor breaks');
  assert.equal(h.streak.atRisk, null);

  // Wednesday: Tuesday can still be finished, so nothing is broken yet.
  h = see(id, '2026-10-07 12:00');
  assert.equal(h.yesterday.state, 'open');
  assert.equal(h.streak.current, 1);
  assert.deepEqual(h.streak.atRisk, { day: '2026-10-06', missing: ['evening'], until: new Date(at('2026-10-08 03:00')).toISOString() });

  // Thursday: Tuesday is closed with one slot of two. The streak is over, kindly.
  h = see(id, '2026-10-08 12:00');
  assert.deepEqual([h.streak.current, h.streak.best], [0, 1]);
  assert.deepEqual(h.streak.previous, { length: 1, lastDay: '2026-10-05' });
  assert.equal(h.streak.atRisk, null, 'nothing left to lose');
  // Monday 2 of 2 and Tuesday 1 of 2 are settled; Wednesday and Thursday are still open, so they can't count against.
  assert.equal(h.rates.d7, 0.75);
});

test('a streak grows a day at a time and remembers its best', () => {
  fresh();
  const { id } = brush();
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) both(id, day);
  let h = see(id, '2026-10-08 23:00');
  assert.deepEqual([h.streak.current, h.streak.best, h.today.state], [4, 4, 'done']);
  assert.deepEqual(h.rates, { d7: 1, d30: 1, d365: 1 });

  // Two days missed outright, then a fresh start.
  both(id, '2026-10-11');
  h = see(id, '2026-10-11 23:00');
  assert.deepEqual([h.streak.current, h.streak.best], [1, 4]);
  assert.deepEqual(h.streak.previous, { length: 4, lastDay: '2026-10-08' });
  // 5th to 11th: five days done in full; the 9th missed; the 10th, yesterday, is still open and empty.
  assert.equal(h.rates.d7, 0.8333);
});

test('with no slot named, a check-in goes to the slot whose time it is, then to whatever is left', () => {
  fresh();
  const { id } = brush();
  assert.equal(check(id, '2026-10-05 21:10').checkin.slot, 'evening', 'the evening window is open, though morning is not done either');
  assert.equal(check(id, '2026-10-05 21:20').checkin.slot, 'morning', 'only morning is left');
  const nothing = check(id, '2026-10-05 21:30');
  assert.equal(nothing.checkin, null, 'everything is done: nothing is recorded');
  assert.equal(nothing.habit.today.state, 'done');

  assert.equal(check(id, '2026-10-06 14:00').checkin.slot, 'morning', 'outside both windows: the earliest');
  assert.equal(check(id, '2026-10-07 07:00', { slot: 'Evening' }).checkin.slot, 'evening', 'a slot can be named by its name');
  assert.throws(() => check(id, '2026-10-07 07:00', { slot: 'noon' }), refused('no_such_slot'));
});

// ---------- the day boundary ----------

test('brushing after midnight counts for the evening before', () => {
  fresh();
  const { id } = brush();
  check(id, '2026-10-05 07:00', { slot: 'morning' });
  const late = check(id, '2026-10-06 00:30'); // 12:30 AM on Tuesday
  assert.deepEqual([late.checkin.day, late.checkin.slot, late.checkin.backfilled], ['2026-10-05', 'evening', undefined]);
  assert.equal(late.habit.today.day, '2026-10-05', 'it is still Monday as far as this habit goes');
  assert.equal(late.habit.today.state, 'done');
  assert.equal(late.habit.streak.current, 1);

  const next = check(id, '2026-10-06 03:00');
  assert.deepEqual([next.checkin.day, next.checkin.slot], ['2026-10-06', 'morning'], 'at the day start it is Tuesday');
});

test('a habit can have its own day start', () => {
  fresh();
  const { id } = on('2026-10-05 06:00', () => habits.createHabit({ name: 'Journal', dayStart: '00:00', schedule: { kind: 'daily' } }, 'me'));
  const h = see(id, '2026-10-05 06:00');
  assert.deepEqual(h.schedule.slots, [{ id: 'once', name: '', remind: null, from: null, until: null, nudge: null }], 'one unnamed slot unless slots are given');
  assert.equal(check(id, '2026-10-06 00:30').checkin.day, '2026-10-06');
});

// ---------- late logging ----------

test('yesterday can be logged until today ends, and no further back', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  check(id, '2026-10-06 07:00', { slot: 'morning' });

  // Wednesday morning: Tuesday evening was forgotten.
  const late = check(id, '2026-10-07 09:00', { slot: 'evening', day: 'yesterday' });
  assert.deepEqual([late.checkin.day, late.checkin.backfilled], ['2026-10-06', true]);
  assert.equal(late.habit.yesterday.state, 'done');
  assert.equal(late.habit.streak.current, 2);
  assert.equal(late.habit.streak.atRisk, null);

  assert.throws(() => check(id, '2026-10-08 09:00', { slot: 'evening', day: '2026-10-06' }), refused('too_late'));
  assert.throws(() => check(id, '2026-10-08 09:00', { day: '2026-10-09' }), refused('too_early'));
  assert.throws(() => check(id, '2026-10-08 09:00', { day: 'last week' }), /must be a date/);
  assert.equal(check(id, '2026-10-08 09:00', { slot: 'morning', day: '2026-10-08' }).checkin.backfilled, undefined, 'today by its date is just today');
});

test('a check-in made offline is judged as of when it was tapped, not when it arrived', () => {
  fresh();
  const { id } = brush();
  // Tapped on Monday with no connection; delivered on Thursday.
  const sent = (stamp, slot) => ({ slot, at: new Date(at(stamp)).toISOString(), zone: CHICAGO });
  const first = on('2026-10-08 18:00', () => habits.checkIn(id, sent('2026-10-05 07:05', 'morning'), 'me', { via: 'iPhone', key: 'key-monday-am' }));
  assert.deepEqual([first.checkin.day, first.checkin.backfilled, first.checkin.at], ['2026-10-05', undefined, new Date(at('2026-10-05 07:05')).toISOString()]);
  on('2026-10-08 18:00', () => habits.checkIn(id, sent('2026-10-05 21:40', 'evening'), 'me', { via: 'iPhone', key: 'key-monday-pm' }));
  const history = on('2026-10-08 18:00', () => habits.habitHistory(id, { from: '2026-10-05', to: '2026-10-08' }));
  assert.equal(history.days, 'dxoo', 'Monday is done; Tuesday is missed; Wednesday and Thursday are still open');
  assert.throws(() => on('2026-10-08 18:00', () => habits.checkIn(id, { at: '2026-10-08T23:30:00-05:00' }, 'me')), /cannot be in the future/);
  assert.throws(() => on('2026-10-08 18:00', () => habits.checkIn(id, { at: 'noon' }, 'me')), /must be a timestamp/);
});

test('someone who starts a habit and logs last night began yesterday', () => {
  fresh();
  const { id } = brush('2026-10-06 08:00');
  check(id, '2026-10-06 08:01', { slot: 'morning', day: 'yesterday' });
  check(id, '2026-10-06 08:02', { slot: 'evening', day: 'yesterday' });
  both(id, '2026-10-06');
  assert.equal(see(id, '2026-10-06 22:00').streak.current, 2);
});

// ---------- undo ----------

test('undo takes a check-in back, by id, by key, or by slot', () => {
  fresh();
  const { id } = brush();
  const a = check(id, '2026-10-05 07:00', { slot: 'morning' }, { key: 'key-aaaaaaaa' });
  let h = on('2026-10-05 07:01', () => habits.undo(id, { checkins: [a.checkin.id] }, 'me')).habit;
  assert.equal(h.today.slots[0].done, false);

  check(id, '2026-10-05 07:02', { slot: 'morning' }, { key: 'key-bbbbbbbb' });
  h = on('2026-10-05 07:03', () => habits.undo(id, { keys: ['key-bbbbbbbb'] }, 'me')).habit;
  assert.equal(h.today.slots[0].done, false);

  both(id, '2026-10-05');
  h = on('2026-10-05 21:05', () => habits.undo(id, { slot: 'evening' }, 'me')).habit;
  assert.deepEqual(h.today.slots.map((s) => s.done), [true, false]);
  h = on('2026-10-05 21:06', () => habits.undo(id, {}, 'me')).habit;
  assert.deepEqual(h.today.slots.map((s) => s.done), [false, false], 'with nothing named, the whole day');

  // Undoing what isn't there changes nothing, and announces nothing.
  const before = habits.loadHabits().version;
  on('2026-10-05 21:07', () => habits.undo(id, { checkins: [a.checkin.id, 9999] }, 'me'));
  on('2026-10-05 21:07', () => habits.undo(id, { keys: ['key-never-sent'] }, 'me'));
  assert.equal(habits.loadHabits().version, before);

  const history = on('2026-10-05 22:00', () => habits.habitHistory(id));
  assert.equal(history.events.length, 4, 'nothing is erased: the check-ins are all still in the history');
  assert.ok(history.events.every((e) => e.undone));
});

test('an undo that arrives late cannot remove a check-in made elsewhere in the meantime', () => {
  fresh();
  const { id } = brush();
  const stamp = (s) => new Date(at(s)).toISOString();
  // On the phone, offline: a slip of the thumb at 7:00, undone at 7:01.
  // On the Mac at 7:30: the real one. The phone's two changes arrive at 8:00.
  check(id, '2026-10-05 07:30', { slot: 'morning' });
  on('2026-10-05 08:00', () => habits.checkIn(id, { slot: 'morning', at: stamp('2026-10-05 07:00'), zone: CHICAGO }, 'me', { via: 'iPhone', key: 'key-phone-tap' }));
  const after = on('2026-10-05 08:00', () => habits.undo(id, { keys: ['key-phone-tap'], at: stamp('2026-10-05 07:01') }, 'me', { via: 'iPhone', key: 'key-phone-undo' }));
  assert.equal(after.habit.today.slots[0].done, true, 'the Mac\'s check-in stands');
  assert.equal(after.habit.today.slots[0].checkins.length, 1);
  assert.equal(after.habit.today.slots[0].via, undefined, 'and it is the Mac\'s, not the phone\'s');
});

// ---------- two devices ----------

test('the same slot checked in on two devices counts once, and both are kept', () => {
  fresh();
  const { id } = brush();
  check(id, '2026-10-05 07:00', { slot: 'morning' }, { via: 'iPhone', key: 'key-from-phone' });
  const second = check(id, '2026-10-05 07:20', { slot: 'morning' }, { via: 'command line', key: 'key-from-cli' });
  const morning = second.habit.today.slots[0];
  assert.deepEqual([second.habit.today.done, morning.checkins.length, morning.via], [1, 2, 'iPhone'], 'one slot done, two check-ins, shown as the first');
  check(id, '2026-10-05 21:00', { slot: 'evening' });
  assert.equal(see(id, '2026-10-05 22:00').streak.current, 1);

  // Taking one back leaves the other; the slot is not undone until both are.
  let h = on('2026-10-05 22:01', () => habits.undo(id, { checkins: [morning.checkins[0]] }, 'me')).habit;
  assert.deepEqual([h.today.slots[0].done, h.today.slots[0].via], [true, 'command line']);
  h = on('2026-10-05 22:02', () => habits.undo(id, { slot: 'morning' }, 'me')).habit;
  assert.equal(h.today.slots[0].done, false);
});

test('a check-in sent twice with the same key is recorded once', () => {
  fresh();
  const { id } = brush();
  const first = check(id, '2026-10-05 07:00', { slot: 'morning' }, { key: 'key-sent-twice' });
  const version = habits.loadHabits().version;
  const again = check(id, '2026-10-05 07:05', { slot: 'morning' }, { key: 'key-sent-twice' });
  assert.deepEqual(again.checkin, first.checkin);
  assert.equal(habits.loadHabits().version, version, 'nothing was written the second time');
  assert.equal(habits.loadHabits().events.length, 1);
});

// ---------- skipping and pausing ----------

test('a skipped day neither breaks a streak nor adds to it', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  const skipped = on('2026-10-06 20:00', () => habits.skipDay(id, { reason: 'flu' }, 'me'));
  assert.deepEqual([skipped.skip.day, skipped.skip.reason, skipped.habit.today.state], ['2026-10-06', 'flu', 'skipped']);
  both(id, '2026-10-07');
  let h = see(id, '2026-10-07 23:00');
  assert.equal(h.streak.current, 2, 'Monday and Wednesday, with Tuesday passed over');
  assert.equal(h.rates.d7, 1, 'a rest day is not held against the rate either');

  // Yesterday can be skipped after the fact; the day before cannot.
  on('2026-10-09 09:00', () => habits.skipDay(id, { day: 'yesterday' }, 'me'));
  assert.throws(() => on('2026-10-10 09:00', () => habits.skipDay(id, { day: '2026-10-07' }, 'me')), refused('too_late'));
  both(id, '2026-10-09');
  h = see(id, '2026-10-09 23:00');
  assert.equal(h.streak.current, 3);

  // Taking a skip back makes the day an ordinary one again.
  on('2026-10-09 23:10', () => habits.undo(id, { skip: true, day: 'yesterday' }, 'me'));
  assert.equal(see(id, '2026-10-09 23:20').yesterday.state, 'open');
  assert.equal(see(id, '2026-10-10 12:00').streak.current, 1, 'and once it closes unfinished, it breaks the streak after all');
});

test('skips are limited: two days in any seven, six in any thirty', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  assert.equal(see(id, '2026-10-06 08:00').skipsLeft, 2);
  on('2026-10-06 20:00', () => habits.skipDay(id, {}, 'me'));
  assert.equal(see(id, '2026-10-07 08:00').skipsLeft, 1);
  on('2026-10-07 20:00', () => habits.skipDay(id, {}, 'me'));
  both(id, '2026-10-08');
  assert.equal(see(id, '2026-10-09 08:00').skipsLeft, 0);
  assert.throws(() => on('2026-10-09 20:00', () => habits.skipDay(id, {}, 'me')), (e) => refused('skip_limit')(e) && /2 days in any 7 and 6 days in any 30/.test(e.message) && /pause "Brush teeth"/.test(e.message));
  both(id, '2026-10-09');

  // A skip already there changes nothing; nor does skipping a day that is done.
  const version = habits.loadHabits().version;
  assert.equal(on('2026-10-09 22:00', () => habits.skipDay(id, {}, 'me')).skip, null);
  assert.equal(habits.loadHabits().version, version);

  // On the 13th the skip of the 6th has dropped out of every week that holds the 13th; the 7th has not.
  for (const day of ['2026-10-10', '2026-10-11', '2026-10-12']) both(id, day);
  assert.equal(see(id, '2026-10-13 08:00').skipsLeft, 1);
  const rest = on('2026-10-13 20:00', () => habits.skipDay(id, {}, 'me'));
  assert.equal(rest.habit.skipsLeft, 0, 'the 7th and the 13th are two in seven days');

  // A skipped day that gets done anyway used nothing up.
  both(id, '2026-10-13');
  assert.equal(see(id, '2026-10-14 08:00').skipsLeft, 2);

  // Thirty days: two more pairs, a week apart, make six. A seventh is refused though its own week is clear.
  const rests = ['2026-10-14', '2026-10-15', '2026-10-22', '2026-10-23'];
  for (let day = '2026-10-14'; day <= '2026-11-02'; day = addDays(day, 1)) {
    if (rests.includes(day)) on(`${day} 20:00`, () => habits.skipDay(id, {}, 'me'));
    else both(id, day);
  }
  const h = see(id, '2026-11-02 23:00');
  assert.equal(h.streak.current, 23, '29 days from 5 October, less six rest days');
  assert.equal(h.skipsLeft, 0, 'six skips in the thirty days back to 6 October');
  assert.throws(() => on('2026-11-03 20:00', () => habits.skipDay(id, {}, 'me')), refused('skip_limit'));
  both(id, '2026-11-03');
  both(id, '2026-11-04');
  assert.equal(see(id, '2026-11-05 08:00').skipsLeft, 1, 'once the 6th is more than thirty days back, there is room for one');
});

test('a paused habit expects nothing, and its streak waits', () => {
  fresh();
  const { id } = brush();
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07']) both(id, day);
  let h = on('2026-10-08 09:00', () => habits.updateHabit(id, { paused: true }));
  assert.deepEqual([h.paused, h.today.state, h.today.total, h.rev], [true, 'off', 0, 2]);
  h = see(id, '2026-10-20 09:00');
  assert.deepEqual([h.streak.current, h.today.state], [3, 'off'], 'twelve days on, nothing has been lost');

  h = on('2026-10-21 09:00', () => habits.updateHabit(id, { paused: false }));
  assert.deepEqual([h.paused, h.today.state], [false, 'open']);
  both(id, '2026-10-21');
  h = see(id, '2026-10-21 23:00');
  assert.equal(h.streak.current, 4);
  assert.equal(h.rates.d30, 1, 'the days away are not counted as missed');
  assert.equal(on('2026-10-21 23:00', () => habits.habitHistory(id, { from: '2026-10-05', to: '2026-10-21' })).days, 'ddd.............d');

  // Pausing and resuming the same day is as if it never happened.
  on('2026-10-22 09:00', () => habits.updateHabit(id, { paused: true }));
  on('2026-10-22 10:00', () => habits.updateHabit(id, { paused: false }));
  assert.equal(see(id, '2026-10-22 11:00').today.state, 'open');
});

test('an archived habit is put away with its history, and comes back with its streak', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  on('2026-10-06 09:00', () => habits.updateHabit(id, { archived: true }));
  assert.deepEqual(on('2026-10-07 09:00', () => habits.listHabits()).habits, []);
  assert.equal(on('2026-10-07 09:00', () => habits.listHabits({ archived: true })).habits[0].archived, true);
  assert.throws(() => check(id, '2026-10-07 09:00'), refused('archived'));
  assert.throws(() => on('2026-10-07 09:00', () => habits.skipDay(id, {}, 'me')), refused('archived'));

  const back = on('2026-10-10 09:00', () => habits.updateHabit(id, { archived: false }));
  assert.deepEqual([back.archived, back.streak.current, back.today.state], [false, 1, 'open']);
  both(id, '2026-10-10');
  assert.equal(see(id, '2026-10-10 23:00').streak.current, 2);
});

// ---------- changing a schedule ----------

test('changing the schedule counts from today on, and never rewrites the days before', () => {
  fresh();
  const { id } = brush();
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07']) both(id, day);

  // On Thursday a third slot is added.
  const three = { kind: 'daily', slots: [...on('2026-10-08 06:00', () => habits.getHabit(id)).schedule.slots, { name: 'Noon', remind: '12:30' }] };
  let h = on('2026-10-08 06:00', () => habits.updateHabit(id, { schedule: three }));
  assert.deepEqual([h.today.total, h.streak.current, h.rev], [3, 3, 2], 'three slots from today; the three days of two still count');
  both(id, '2026-10-08');
  assert.equal(see(id, '2026-10-08 23:00').today.state, 'open', 'two of three is not the day');
  check(id, '2026-10-08 23:05', { slot: 'noon' });
  assert.equal(see(id, '2026-10-08 23:10').streak.current, 4);

  // Friday: only on weekdays from now on, and the noon slot goes again.
  const weekdays = { kind: 'days', days: ['monday', 'tue', 'wed', 'thu', 'fri'], slots: three.slots.slice(0, 2) };
  h = on('2026-10-09 06:00', () => habits.updateHabit(id, { schedule: weekdays }));
  assert.deepEqual(h.schedule.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  both(id, '2026-10-09');
  h = see(id, '2026-10-10 12:00');
  assert.deepEqual([h.today.state, h.today.total, h.streak.current], ['off', 0, 5], 'Saturday expects nothing');
  both(id, '2026-10-12');
  h = see(id, '2026-10-12 23:00');
  assert.equal(h.streak.current, 6, 'Friday to Monday is no gap');
  assert.equal(on('2026-10-12 23:00', () => habits.habitHistory(id, { from: '2026-10-05', to: '2026-10-13' })).days, 'ddddd..d_');

  // Changing it back the same day leaves no trace; a reminder time is not a change to what counts.
  const stored = () => habits.loadHabits().habits[0].history.length;
  const before = stored();
  on('2026-10-13 06:00', () => habits.updateHabit(id, { schedule: three }));
  on('2026-10-13 06:05', () => habits.updateHabit(id, { schedule: weekdays }));
  assert.equal(stored(), before);
  const moved = { ...weekdays, slots: weekdays.slots.map((s) => ({ ...s, remind: '08:00' })) };
  h = on('2026-10-13 06:10', () => habits.updateHabit(id, { schedule: moved }));
  assert.equal(h.schedule.slots[0].remind, '08:00');
  assert.equal(stored(), before);

  assert.throws(() => on('2026-10-13 07:00', () => habits.updateHabit(id, { schedule: { kind: 'weekly', target: 3 } })), /Make a new habit instead/);
});

// ---------- habits counted in weeks ----------

test('N times a week: the streak is counted in weeks that met the target', () => {
  fresh();
  const { id } = gym(); // Monday 5 October, three times a week
  for (const day of ['2026-10-05', '2026-10-07', '2026-10-09']) check(id, `${day} 18:00`);
  let h = see(id, '2026-10-09 19:00');
  assert.deepEqual(h.week, { start: '2026-10-05', state: 'met', count: 3, target: 3, days: ['2026-10-05', '2026-10-07', '2026-10-09'], whole: true });
  assert.equal(h.lastWeek, null, 'it began this week');
  assert.deepEqual([h.streak.current, h.streak.unit, h.today.done], [1, 'weeks', true]);

  // Twice in one day is one day.
  check(id, '2026-10-12 07:00');
  check(id, '2026-10-12 18:00');
  check(id, '2026-10-13 18:00');
  h = see(id, '2026-10-18 20:00'); // Sunday evening, one short
  assert.deepEqual([h.week.count, h.week.state, h.streak.current], [2, 'open', 1], 'an unfinished week neither adds nor breaks');
  assert.equal(h.streak.atRisk, null);

  // Monday: last week can still be saved by logging Sunday.
  h = see(id, '2026-10-19 10:00');
  assert.deepEqual(h.streak.atRisk, { day: '2026-10-18', week: '2026-10-12', missing: [], until: new Date(at('2026-10-20 03:00')).toISOString() });
  assert.deepEqual([h.week.start, h.week.count], ['2026-10-19', 0]);
  assert.deepEqual(h.lastWeek, { start: '2026-10-12', state: 'open', count: 2, target: 3, days: ['2026-10-12', '2026-10-13'], whole: true });
  const saved = check(id, '2026-10-19 10:05', { day: 'yesterday' });
  assert.equal(saved.habit.lastWeek.state, 'met');
  assert.deepEqual([saved.checkin.day, saved.checkin.slot, saved.checkin.backfilled], ['2026-10-18', null, true]);
  assert.deepEqual([saved.habit.streak.current, saved.habit.streak.atRisk], [2, null]);
  assert.throws(() => check(id, '2026-10-19 10:06', { slot: 'morning' }), refused('no_such_slot'));
});

test('N times a week: a week that falls short ends the streak once Monday is over', () => {
  fresh();
  const { id } = gym();
  for (const day of ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13']) check(id, `${day} 18:00`);
  const h = see(id, '2026-10-20 10:00'); // Tuesday
  assert.deepEqual([h.streak.current, h.streak.best], [0, 1]);
  assert.deepEqual(h.streak.previous, { length: 1, lastWeek: '2026-10-05' });
  const history = on('2026-10-20 10:00', () => habits.habitHistory(id, { from: '2026-10-05', to: '2026-10-20' }));
  assert.equal(history.days, 'd.d.d..dd.......');
  assert.deepEqual(history.weeks.map((w) => [w.start, w.state, w.count]), [['2026-10-05', 'met', 3], ['2026-10-12', 'missed', 2], ['2026-10-19', 'open', 0]]);
  // Two settled weeks: 3 of 3, then 2 of 3. The open week has nothing in it yet.
  assert.equal(h.rates.d30, 0.8333);
});

test('N times a week: the week a habit begins in counts if it is met and is held against no one if not', () => {
  fresh();
  const late = gym('2026-10-08 06:00'); // a Thursday
  check(late.id, '2026-10-09 18:00');
  for (const day of ['2026-10-12', '2026-10-14', '2026-10-16']) check(late.id, `${day} 18:00`);
  assert.equal(see(late.id, '2026-10-09 19:00').week.whole, false, 'a week it began partway through');
  let h = see(late.id, '2026-10-21 10:00');
  assert.deepEqual([h.streak.current, h.streak.previous], [1, null], 'one check-in in a three-day first week is not a miss');

  const keen = on('2026-10-08 06:00', () => habits.createHabit({ name: 'Run', schedule: { kind: 'weekly', target: 2 } }, 'me'));
  for (const day of ['2026-10-08', '2026-10-10', '2026-10-13', '2026-10-15']) check(keen.id, `${day} 18:00`);
  h = see(keen.id, '2026-10-16 10:00');
  assert.equal(h.streak.current, 2, 'but a first week that was met counts');
});

test('N times a week: a new target starts with next week, and a rest week can be skipped', () => {
  fresh();
  const { id } = gym();
  for (const day of ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']) check(id, `${day} 18:00`);
  // Wednesday of week two: up to four a week.
  let h = on('2026-10-14 19:00', () => habits.updateHabit(id, { schedule: { kind: 'weekly', target: 4, remind: { days: ['mon', 'wed', 'fri'], time: '17:30' } } }));
  assert.deepEqual([h.schedule.target, h.week.target, h.week.state], [4, 3, 'met'], 'this week is judged by the target it began with');
  assert.deepEqual(h.schedule.remind, { days: ['mon', 'wed', 'fri'], time: '17:30' });
  h = see(id, '2026-10-19 09:00');
  assert.deepEqual([h.week.target, h.streak.current], [4, 2]);

  // Week three is a rest week.
  assert.equal(h.skipsLeft, 1);
  const skipped = on('2026-10-21 09:00', () => habits.skipDay(id, { reason: 'travelling' }, 'me'));
  assert.deepEqual([skipped.skip.day, skipped.habit.week.state, skipped.habit.skipsLeft], ['2026-10-19', 'skipped', 0]);
  for (const day of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']) check(id, `${day} 18:00`);
  h = see(id, '2026-10-30 09:00');
  assert.equal(h.streak.current, 3, 'weeks one, two and four, with three passed over');
  assert.equal(h.skipsLeft, 0);
  // One week in any four: the week after next can't be skipped as well.
  assert.throws(() => on('2026-11-04 09:00', () => habits.skipDay(id, {}, 'me')), (e) => refused('skip_limit')(e) && /1 week in any 4/.test(e.message));
  assert.equal(see(id, '2026-11-04 09:00').skipsLeft, 0);
  assert.equal(see(id, '2026-11-16 09:00').skipsLeft, 1, 'four weeks on, there is room again');
});

// ---------- travel ----------

test('a check-in counts for the date where it was made, and "today" follows the user', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-12');
  // Tuesday 13 October, 5 PM in Chicago is 7 AM on Wednesday in Tokyo.
  const instant = at('2026-10-13 17:00');
  assert.equal(instant, at('2026-10-14 07:00', TOKYO));
  assert.equal(store.withClock(instant, () => habits.getHabit(id)).today.day, '2026-10-13', 'as far as anyone knows, the user is at home');

  const tokyo = store.withClock(instant, () => habits.checkIn(id, { slot: 'morning', zone: TOKYO }, 'me', { via: 'iPhone' }));
  assert.deepEqual([tokyo.checkin.day, tokyo.checkin.zone], ['2026-10-14', TOKYO]);
  assert.equal(tokyo.habit.today.day, '2026-10-14', 'the phone said where it is, so today is Tokyo\'s for every client');
  assert.equal(store.withClock(instant, () => habits.listHabits()).zone, TOKYO);

  // Something from the old zone, delivered late, doesn't move the user back.
  store.withClock(instant, () => habits.checkIn(id, { slot: 'morning', at: new Date(at('2026-10-13 07:00')).toISOString(), zone: CHICAGO }, 'me', { via: 'iPhone', key: 'key-left-home' }));
  assert.equal(store.withClock(instant, () => habits.listHabits()).zone, TOKYO);
  // A change that names no zone is read where the user is: Claude, on the Mac, logging "now".
  const claude = store.withClock(at('2026-10-14 21:00', TOKYO), () => habits.checkIn(id, { source: 'claude' }, 'Claude Code · repo'));
  assert.deepEqual([claude.checkin.day, claude.checkin.zone, claude.checkin.slot, claude.checkin.by], ['2026-10-14', TOKYO, 'evening', 'Claude Code · repo']);
});

test('a device can report its zone before the next check-in', () => {
  fresh();
  const { id } = brush();
  const landed = at('2026-10-14 07:00', TOKYO);
  assert.deepEqual(store.withClock(landed, () => habits.setZone(TOKYO)), { zone: TOKYO });
  assert.equal(store.withClock(landed, () => habits.getHabit(id)).today.day, '2026-10-14');
  const version = habits.loadHabits().version;
  store.withClock(landed + 60_000, () => habits.setZone(TOKYO));
  assert.equal(habits.loadHabits().version, version, 'saying the same again changes nothing');
  assert.throws(() => habits.setZone('Mars/Olympus'), /Unknown time zone/);
  assert.throws(() => check(id, '2026-10-14 07:00', { zone: 'Not/AZone' }), /Unknown time zone/);
});

test('flying east over the date line gives the same date twice, and it counts once', () => {
  fresh();
  const { id } = brush();
  const tokyo = (stamp, slot) => store.withClock(at(stamp, TOKYO), () => habits.checkIn(id, { slot, zone: TOKYO }, 'me', { via: 'iPhone' }));
  const la = (stamp, slot) => store.withClock(at(stamp, LA), () => habits.checkIn(id, { slot, zone: LA }, 'me', { via: 'iPhone' }));
  store.withClock(at('2026-10-12 06:00', TOKYO), () => habits.setZone(TOKYO));
  tokyo('2026-10-12 07:00', 'morning');
  tokyo('2026-10-12 22:00', 'evening');
  tokyo('2026-10-13 07:00', 'morning');
  tokyo('2026-10-13 16:00', 'evening'); // before an evening flight
  // Ten hours in the air, and it is Tuesday the 13th again in Los Angeles.
  const again = la('2026-10-13 21:00', 'evening');
  assert.equal(again.checkin.day, '2026-10-13');
  assert.equal(again.habit.today.slots[1].checkins.length, 2, 'the second evening of the 13th is kept');
  assert.deepEqual([again.habit.today.done, again.habit.streak.current], [2, 2], 'and counts once');
  la('2026-10-14 07:00', 'morning');
  la('2026-10-14 21:00', 'evening');
  assert.equal(store.withClock(at('2026-10-14 22:00', LA), () => habits.getHabit(id)).streak.current, 3);
});

test('flying west over the date line cuts a date short; skipping it keeps the streak', () => {
  fresh();
  const { id } = brush();
  const la = (stamp, slot) => store.withClock(at(stamp, LA), () => habits.checkIn(id, { slot, zone: LA }, 'me', { via: 'iPhone' }));
  const tokyo = (stamp, fn) => store.withClock(at(stamp, TOKYO), fn);
  store.withClock(at('2026-10-11 06:00', LA), () => habits.setZone(LA));
  la('2026-10-11 07:00', 'morning');
  la('2026-10-11 21:00', 'evening');
  la('2026-10-12 07:00', 'morning'); // then a midday flight; Monday evening happens over the Pacific
  // Landing at 5 PM on Tuesday in Tokyo: Monday can still be logged, and Tuesday morning never happened.
  tokyo('2026-10-13 17:00', () => habits.checkIn(id, { slot: 'evening', day: 'yesterday', zone: TOKYO }, 'me', { via: 'iPhone' }));
  tokyo('2026-10-13 22:00', () => habits.checkIn(id, { slot: 'evening', zone: TOKYO }, 'me', { via: 'iPhone' }));
  tokyo('2026-10-13 22:01', () => habits.skipDay(id, { zone: TOKYO, reason: 'in the air' }, 'me', { via: 'iPhone' }));
  tokyo('2026-10-14 07:00', () => habits.checkIn(id, { slot: 'morning', zone: TOKYO }, 'me'));
  tokyo('2026-10-14 22:00', () => habits.checkIn(id, { slot: 'evening', zone: TOKYO }, 'me'));
  const h = tokyo('2026-10-14 23:00', () => habits.getHabit(id));
  assert.deepEqual([h.yesterday.state, h.streak.current], ['skipped', 3], 'the 11th, 12th and 14th, with the short 13th passed over');
});

// ---------- clock changes ----------

test('the autumn clock change: an hour that happens twice is one evening, and the streak carries on', () => {
  fresh();
  const { id } = brush('2026-10-30 06:00');
  both(id, '2026-10-30');
  check(id, '2026-10-31 07:00', { slot: 'morning' });
  // 1:30 AM on Sunday 1 November happens twice in Chicago. Both are Saturday night.
  const first = Date.parse('2026-11-01T06:30:00Z'); // 01:30 CDT
  const second = Date.parse('2026-11-01T07:30:00Z'); // 01:30 CST
  assert.deepEqual([localParts(first, CHICAGO).time, localParts(second, CHICAGO).time], ['01:30', '01:30']);
  assert.equal(store.withClock(first, () => habits.getHabit(id)).today.day, '2026-10-31');
  const evening = store.withClock(second, () => habits.checkIn(id, {}, 'me'));
  assert.deepEqual([evening.checkin.day, evening.checkin.slot], ['2026-10-31', 'evening']);
  // The 25-hour Sunday is one day, ending at 3 AM standard time on Monday.
  both(id, '2026-11-01');
  check(id, '2026-11-02 07:00', { slot: 'morning' });
  const h = see(id, '2026-11-03 09:00');
  assert.equal(h.streak.current, 3);
  assert.deepEqual(h.streak.atRisk, { day: '2026-11-02', missing: ['evening'], until: '2026-11-04T09:00:00.000Z' });
});

test('the spring clock change: the hour that is skipped breaks nothing', () => {
  fresh();
  const { id } = brush('2027-03-12 06:00');
  both(id, '2027-03-12');
  both(id, '2027-03-13');
  // Sunday 14 March 2027: 1:59 AM is followed by 3:00 AM.
  const beforeJump = Date.parse('2027-03-14T07:59:00Z');
  const afterJump = Date.parse('2027-03-14T08:00:00Z');
  assert.deepEqual([localParts(beforeJump, CHICAGO).time, localParts(afterJump, CHICAGO).time], ['01:59', '03:00']);
  assert.equal(habitDay(beforeJump, CHICAGO, '03:00'), '2027-03-13');
  assert.equal(habitDay(afterJump, CHICAGO, '03:00'), '2027-03-14');
  assert.equal(habitDay(afterJump, CHICAGO, '02:30'), '2027-03-14', 'a day start inside the skipped hour still starts the day');
  both(id, '2027-03-14');
  both(id, '2027-03-15');
  assert.equal(see(id, '2027-03-15 23:00').streak.current, 4);
  assert.equal(calendar(habits.loadHabits().habits[0], habits.loadHabits().events, '2027-03-12', '2027-03-16', '2027-03-15').days, 'dddd_');
});

// ---------- habits themselves ----------

test('creating and editing a habit', () => {
  fresh();
  const made = on('2026-10-05 06:00', () => habits.createHabit({ name: '  Floss ', icon: '🧵', color: 'Mint', schedule: TWICE, ignored: 1 }, 'me', { via: 'iPhone', key: 'key-create-1' }));
  assert.deepEqual(
    { id: made.id, name: made.name, icon: made.icon, color: made.color, dayStart: made.dayStart, paused: made.paused, archived: made.archived, rev: made.rev },
    { id: 1, name: 'Floss', icon: '🧵', color: 'mint', dayStart: '03:00', paused: false, archived: false, rev: 1 },
  );
  assert.deepEqual(made.schedule.slots[1], { id: 'evening', name: 'Evening', remind: '21:30', from: '19:00', until: '02:00', nudge: '22:30' });
  assert.deepEqual([made.today.state, made.today.total, made.streak.current, made.streak.best, made.skipsLeft], ['open', 2, 0, 0, 2]);
  assert.deepEqual(made.rates, { d7: null, d30: null, d365: null }, 'nothing has been expected yet');
  assert.equal(on('2026-10-05 06:01', () => habits.createHabit({ name: 'Floss', schedule: TWICE }, 'me', { key: 'key-create-1' })).id, 1, 'the same key makes it once');
  assert.equal(habits.loadHabits().habits.length, 1);

  const edited = on('2026-10-05 07:00', () => habits.updateHabit(1, { name: 'Floss properly', icon: '', color: 'teal', dayStart: '4:00' }, { ifRev: 1, key: 'key-edit-1' }));
  assert.deepEqual([edited.name, edited.icon, edited.color, edited.dayStart, edited.rev], ['Floss properly', null, 'teal', '04:00', 2]);
  // Sent again with the same key, it is not a conflict even though the revision moved on.
  assert.equal(on('2026-10-05 07:01', () => habits.updateHabit(1, { name: 'Floss properly' }, { ifRev: 1, key: 'key-edit-1' })).rev, 2);
  assert.throws(() => on('2026-10-05 07:02', () => habits.updateHabit(1, { name: 'Other' }, { ifRev: 1 })), (e) => e instanceof HabitConflictError && e.current.rev === 2 && /"Floss properly" has changed/.test(e.message));
  assert.equal(on('2026-10-05 07:03', () => habits.updateHabit(1, { name: 'Floss properly' }, { ifRev: 2 })).rev, 2, 'an edit that changes nothing leaves the revision alone');

  check(1, '2026-10-05 08:00');
  assert.equal(see(1, '2026-10-05 08:01').rev, 2, 'checking in is not an edit');
  assert.throws(() => habits.getHabit(99), store.NotFoundError);
  assert.throws(() => on('2026-10-05 09:00', () => habits.deleteHabit(1, { ifRev: 1 })), HabitConflictError);
  assert.deepEqual(on('2026-10-05 09:00', () => habits.deleteHabit(1, { ifRev: 2 })), { id: 1, name: 'Floss properly' });
  assert.deepEqual([habits.loadHabits().habits.length, habits.loadHabits().events.length], [0, 0], 'its check-ins go with it');
});

test('what a habit can be is checked', () => {
  fresh();
  const make = (input) => () => on('2026-10-05 06:00', () => habits.createHabit(input, 'me'));
  const slots = (...list) => ({ kind: 'daily', slots: list });
  assert.throws(make({ schedule: TWICE }), /needs a name/);
  assert.throws(make({ name: 'x' }), /needs a schedule/);
  assert.throws(make({ name: 'x', schedule: { kind: 'hourly' } }), /Invalid schedule kind/);
  assert.throws(make({ name: 'x', color: 'beige', schedule: TWICE }), /Invalid color/);
  assert.throws(make({ name: 'x', dayStart: '25:00', schedule: TWICE }), /Invalid day start/);
  assert.throws(make({ name: 'x', schedule: slots() }), /at least one slot/);
  assert.throws(make({ name: 'x', schedule: slots(...Array.from({ length: 7 }, (_, i) => ({ name: `s${i}` }))) }), /at most 6 slots/);
  assert.throws(make({ name: 'x', schedule: slots({ name: 'Morning' }, { name: 'morning' }) }), /Two slots are called "morning"/);
  assert.throws(make({ name: 'x', schedule: slots({ name: 'Morning', remind: '7.30' }) }), /Invalid reminder time/);
  assert.throws(make({ name: 'x', schedule: slots({ name: 'Morning', from: '05:00' }) }), /needs both/);
  assert.throws(make({ name: 'x', schedule: slots({ name: 'Morning', when: 'early' }) }), /Unknown slot field: when/);
  assert.throws(make({ name: 'x', schedule: { kind: 'days', slots: [{ name: 'a' }] } }), /Say which days/);
  assert.throws(make({ name: 'x', schedule: { kind: 'days', days: ['someday'], slots: [{ name: 'a' }] } }), /Invalid day "someday"/);
  assert.throws(make({ name: 'x', schedule: { kind: 'weekly', target: 8 } }), /from 1 to 7/);
  assert.throws(make({ name: 'x', schedule: { kind: 'weekly', target: 3, slots: [] } }), /Unknown schedule field: slots/);
  assert.throws(make({ name: 'x', schedule: { kind: 'weekly', target: 3, remind: { days: ['mon'] } } }), /reminder time is needed/);
  assert.throws(make({ name: 'x', paused: 'yes', schedule: TWICE }), /must be true or false/);
  assert.equal(habits.loadHabits().habits.length, 0, 'and nothing was written');
  assert.equal(fs.existsSync(HABITS_FILE), true, 'only the zone set at the start of the test');
});

// ---------- the file ----------

test('habits keep to their own file: the todo list is never written, and is copied once first', () => {
  fs.rmSync(HABITS_FILE, { force: true });
  const backup = `${store.DATA_FILE}.before-habits`;
  fs.rmSync(backup, { force: true });
  const task = store.createTodo({ title: 'Stays as it is' }, 'me');
  const todosBefore = fs.readFileSync(store.DATA_FILE, 'utf8');

  on('2026-01-01 12:00', () => habits.setZone(CHICAGO));
  assert.equal(fs.readFileSync(backup, 'utf8'), todosBefore, 'the copy is made before the first habit data is written');
  const { id } = brush();
  both(id, '2026-10-05');
  on('2026-10-05 22:00', () => habits.undo(id, { slot: 'evening' }, 'me'));
  assert.equal(fs.readFileSync(store.DATA_FILE, 'utf8'), todosBefore, 'not a byte of the todo file changed');
  assert.equal(store.load().version, 1);

  // A change to todos later doesn't refresh the copy: it is the list as it was before habits.
  store.updateTodo(task.id, { status: 'done' }, 'me');
  check(id, '2026-10-06 07:00');
  assert.equal(fs.readFileSync(backup, 'utf8'), todosBefore);

  // The file reads back as it was written, with one event to a line.
  const text = fs.readFileSync(HABITS_FILE, 'utf8');
  const db = JSON.parse(text);
  assert.deepEqual([db.schema, db.habits.length, db.events.length, db.zone.name], [1, 1, 4, CHICAGO]);
  assert.equal(text.split('\n').filter((line) => line.startsWith('    {"id":')).length, 4);
  assert.deepEqual(habits.loadHabits(), db);
  assert.equal(fs.existsSync(`${HABITS_FILE}.lock`), false, 'the lock is released');

  // A file from a newer version is refused rather than misread.
  fs.writeFileSync(HABITS_FILE, JSON.stringify({ ...db, schema: 2 }));
  assert.throws(() => habits.loadHabits(), /newer version of Todos/);
  assert.equal(habits.habitsVersion(), null);
  fs.writeFileSync(HABITS_FILE, '{ not json');
  assert.throws(() => habits.listHabits(), /not valid JSON/);
  fs.rmSync(HABITS_FILE);
  assert.deepEqual(habits.listHabits().habits, [], 'with no file there are simply no habits');
});

test('a history says how each day went, one character a day', () => {
  fresh();
  const { id } = brush();
  both(id, '2026-10-05');
  check(id, '2026-10-06 07:00', { slot: 'morning' });
  on('2026-10-08 20:00', () => habits.skipDay(id, {}, 'me'));
  both(id, '2026-10-09');
  check(id, '2026-10-10 07:00', { slot: 'morning' });
  const h = on('2026-10-11 12:00', () => habits.habitHistory(id, { from: '2026-10-03', to: '2026-10-13' }));
  //                    3 4 5 6 7 8 9 10 11 12 13
  assert.equal(h.days, '..dpxsdoo__', 'before it began, done, partial, missed, skipped, done, two open days, two to come');
  assert.deepEqual([h.from, h.to, h.today], ['2026-10-03', '2026-10-13', '2026-10-11']);
  assert.deepEqual(h.events.map((e) => [e.kind, e.day, e.slot, e.undone]), [
    ['done', '2026-10-05', 'morning', false], ['done', '2026-10-05', 'evening', false], ['done', '2026-10-06', 'morning', false],
    ['skip', '2026-10-08', null, false], ['done', '2026-10-09', 'morning', false], ['done', '2026-10-09', 'evening', false], ['done', '2026-10-10', 'morning', false],
  ]);
  const year = on('2026-10-11 12:00', () => habits.habitHistory(id));
  assert.deepEqual([year.from, year.to, year.days.length], ['2025-10-12', '2026-10-11', 365]);
  assert.throws(() => habits.habitHistory(id, { from: '2026-10-13', to: '2026-10-03' }), /must not be after/);
  assert.throws(() => habits.habitHistory(id, { from: '2020-01-01', to: '2026-10-03' }), /at most 800 days/);
  assert.throws(() => habits.habitHistory(id, { from: 'October' }), /must be a date/);
});
