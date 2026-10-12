// One-line task entry: "Renew passport fri !high #personal @errand every month at 9am".
//
//   dates    today, tomorrow, fri, next friday, next week, in 3 days, +2w, oct 20, 2026-10-20
//   times    3pm, 9:30am, 15:00, noon  -> a reminder at that time (and due that day)
//   repeats  every day / weekday / week / 2 weeks / month / year / friday
//   !high !med !low (or !1 !2 !3)      -> priority
//   #name                              -> project
//   @name                              -> tag   (@claude / @me set the assignee)
//
// Dates, times and repeats are picked up anywhere in the line. The ! # @ markers
// only count at the start or end of the line, next to other markers or dates, so
// "Reply to @sam about PR #42" keeps its title intact. A leading backslash
// (\friday) keeps any word literal.

import { parseDue, today } from './store.js';

const PRIORITY_WORDS = { high: 'high', hi: 'high', h: 'high', 1: 'high', medium: 'medium', med: 'medium', m: 'medium', 2: 'medium', low: 'low', lo: 'low', l: 'low', 3: 'low' };

const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DATE_PHRASES = [
  new RegExp(`^(?:today|tomorrow|tmrw|tmr|next week|(?:next )?${WEEKDAY})$`),
  /^(?:in \d+ (?:days?|weeks?)|\+\d+[dw])$/,
  /^\d{4}-\d{2}-\d{2}$/,
  new RegExp(`^${MONTH} \\d{1,2}(?:st|nd|rd|th)?(?: \\d{4})?$`),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)? ${MONTH}(?: \\d{4})?$`),
];
const REPEAT_PHRASES = [
  [/^every day$/, 'daily'],
  [/^every weekday$/, 'weekdays'],
  [/^every week$/, 'weekly'],
  [/^every (?:2|two) weeks$|^every other week$/, 'biweekly'],
  [/^every month$/, 'monthly'],
  [/^every year$/, 'yearly'],
];
const EVERY_WEEKDAY = new RegExp(`^every (${WEEKDAY})$`);
const TIME = /^(?:(\d{1,2})(?::(\d{2}))?(am|pm)|(\d{1,2}):(\d{2})|(noon))$/;

// Words that introduce a date or time and should disappear along with it.
const LEAD_IN = { date: new Set(['on', 'by', 'due']), time: new Set(['at', '@']), repeat: new Set() };

function tryDue(phrase) {
  try {
    return parseDue(phrase);
  } catch {
    return null;
  }
}

// What starts at tokens[i]? Returns { type, n, ... } where n is how many tokens it spans.
function classify(tokens, i) {
  const word = tokens[i];
  if (word.startsWith('\\') && word.length > 1) return { type: 'word', n: 1, text: word.slice(1) };

  for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
    const phrase = tokens.slice(i, i + n).join(' ').toLowerCase().replace(/,(?= |$)/g, '');
    for (const [re, repeat] of REPEAT_PHRASES) if (re.test(phrase)) return { type: 'repeat', n, repeat };
    const everyDay = phrase.match(EVERY_WEEKDAY);
    if (everyDay && tryDue(everyDay[1])) return { type: 'repeat', n, repeat: 'weekly', due: tryDue(everyDay[1]) };
    if (DATE_PHRASES.some((re) => re.test(phrase)) && tryDue(phrase)) return { type: 'date', n, due: tryDue(phrase) };
  }

  const t = word.toLowerCase().match(TIME);
  if (t) {
    let hour = t[6] ? 12 : Number(t[1] ?? t[4]);
    const minute = Number(t[2] ?? t[5] ?? 0);
    if (t[3] === 'pm' && hour < 12) hour += 12;
    if (t[3] === 'am' && hour === 12) hour = 0;
    if (t[4] && hour >= 1 && hour <= 7) hour += 12; // a bare "3:30" means the afternoon
    const valid = t[3] ? Number(t[1]) >= 1 && Number(t[1]) <= 12 : hour <= 23;
    if (valid && minute <= 59) return { type: 'time', n: 1, hour, minute };
  }

  const name = word.slice(1);
  if (word[0] === '!' && PRIORITY_WORDS[name.toLowerCase()]) return { type: 'marker', n: 1, priority: PRIORITY_WORDS[name.toLowerCase()] };
  if (word[0] === '#' && /^[\w-]+$/.test(name) && !/^\d+$/.test(name)) return { type: 'marker', n: 1, project: name };
  if (word[0] === '@' && /^[\w-]+$/.test(name)) {
    const who = name.toLowerCase();
    if (who === 'claude' || who === 'me') return { type: 'marker', n: 1, assignee: who };
    return { type: 'marker', n: 1, tag: who };
  }
  return { type: 'word', n: 1, text: word };
}

// Returns { title, fields }. `fields` holds only what the line specified, using the
// same keys createTodo accepts. The title may be empty if the line was all markers.
export function parseQuickAdd(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  let items = [];
  for (let i = 0; i < tokens.length;) {
    const item = classify(tokens, i);
    item.text ??= tokens.slice(i, i + item.n).join(' ');
    const prev = items[items.length - 1];
    if (prev?.type === 'word' && LEAD_IN[item.type]?.has(prev.text.toLowerCase())) items.pop();
    items.push(item);
    i += item.n;
  }

  // Markers count only in an unbroken run of non-title items at either end of the line.
  let start = 0;
  while (start < items.length && items[start].type !== 'word') start++;
  let end = items.length;
  while (end > start && items[end - 1].type !== 'word') end--;
  items = items.map((item, i) => (item.type === 'marker' && i >= start && i < end ? { type: 'word', text: item.text } : item));

  const fields = {};
  const tags = [];
  let time = null;
  let explicitDate = false;
  for (const item of items) {
    if (item.type === 'date') {
      fields.due = item.due;
      explicitDate = true;
    } else if (item.type === 'repeat') {
      fields.repeat = item.repeat;
      if (item.due && !explicitDate) fields.due = item.due;
    } else if (item.type === 'time') {
      time = item;
    } else if (item.type === 'marker') {
      if (item.priority) fields.priority = item.priority;
      if (item.project) fields.project = item.project;
      if (item.assignee) fields.assignee = item.assignee;
      if (item.tag) tags.push(item.tag);
    }
  }
  if (tags.length) fields.tags = [...new Set(tags)];

  // A time means "remind me then". With no date it is today, or tomorrow if that time has passed.
  if (time) {
    const at = new Date((fields.due || today()) + 'T00:00');
    at.setHours(time.hour, time.minute, 0, 0);
    if (!fields.due && at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    fields.due ??= `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    if (at.getTime() > Date.now()) fields.remindAt = at.toISOString();
  }

  const title = items.filter((item) => item.type === 'word').map((item) => item.text).join(' ');
  return { title, fields };
}
