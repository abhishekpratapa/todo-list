// The dashboard's sorting, filtering and Today view: the page's own files are
// served, only to those who may see the dashboard, and the page takes its rules
// from /query.js (the server's src/query.js) instead of keeping a copy of them.
// The rules themselves are tested in query.test.js.

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { boot } from './support/helpers.js';

let off; // remote access off: the dashboard on the Mac, with no sign-in
let on; // remote access on: someone on another device who hasn't signed in
before(async () => {
  off = await boot({ enabled: false });
  on = await boot();
});
after(() => {
  off.close();
  on.close();
});

test('the page\'s own files are served, and only to those who may see the dashboard', async () => {
  for (const [file, type] of [['/lists.js', 'text/javascript; charset=utf-8'], ['/lists.css', 'text/css; charset=utf-8'], ['/query.js', 'text/javascript; charset=utf-8']]) {
    const res = await off.local('GET', file);
    assert.deepEqual([res.status, res.headers['content-type']], [200, type], file);
    assert.equal((await on.tailnet('GET', file)).status, 302, `${file}: someone not signed in is sent to sign in`);
  }
  const page = (await off.local('GET', '/')).body;
  assert.match(page, /<link rel="stylesheet" href="\/lists\.css">/);
  assert.match(page, /<div class="listbar" id="listbar"><\/div>/);
  assert.match(page, /<div class="active-filters" id="active-filters" aria-label="Filters in use" hidden><\/div>/);
  // Elements the desktop app reaches into are still there.
  assert.match(page, /id="search"/);
  assert.match(page, /id="qa-title"/);
});

test('the page sorts and filters with the server\'s own rules, not a copy of them', async () => {
  const app = (await off.local('GET', '/app.js')).body;
  const lists = (await off.local('GET', '/lists.js')).body;
  assert.match(app, /from '\/query\.js'/);
  assert.match(app, /from '\/lists\.js'/);
  assert.match(lists, /from '\/query\.js'/);
  for (const [name, source] of [['app.js', app], ['lists.js', lists]]) {
    assert.doesNotMatch(source, /in_progress: 0/, `${name} has no status order of its own`);
    assert.doesNotMatch(source, /\.due [<>]=? /, `${name} compares no due dates of its own`);
    assert.doesNotMatch(source, /completedAt\)\.localeCompare|localeCompare\(a\.completedAt/, `${name} has no done order of its own`);
  }
  // The T key opens Today, beside N and /.
  assert.match(app, /e\.key === 't' \|\| e\.key === 'T'/);
});
