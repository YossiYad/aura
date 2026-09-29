const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { moduleScope } = require('./source');

// The Search page cards each open a category page of rows, one search per row. The rows
// used to be the card's query with "popular hits", "classics" and so on appended, which
// asked the engine for "hip hop essentials essentials" and answered the Israeli cards with
// English news clips. Every card now names its rows, and the Israeli cards ask in Hebrew
// and keep only Hebrew songs.

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function covers() {
  const api = {};
  const context = vm.createContext({ window: {}, Store: { onChange() {} }, indexedDB: {}, localStorage: {} });
  // The real classifier, so a Hebrew row turns away what the whole app calls not-music.
  const apiContext = vm.createContext(moduleScope({ window: { Aura: { api } } }));
  apiContext.V = api;
  vm.runInContext(read('src/api/match.js'), apiContext);
  vm.runInContext(read('src/api/classify.js'), apiContext);
  context.Api = api;
  context.window.Aura = { views: { esc: s => String(s) } };
  vm.runInContext(read('src/views/covers.js'), context);
  return context.window.Aura.views;
}

const year = String(new Date().getFullYear());
const song = (title, artist, duration) => ({ id: title, title, artist, duration });

test('every card names its own rows, each a search of its own', () => {
  const V = covers();
  const html = V.browseHtml() + V.freshSearchHtml();
  const keys = Array.from(html.matchAll(/data-browse="([^"]+)"/g), m => m[1]);
  assert.ok(keys.length >= 30, 'the cards are all rendered');
  for (const key of keys) {
    const plan = V.categoryPlan(key);
    assert.ok(plan, key + ' has a plan');
    assert.ok(plan.sections.length >= 4, key + ' has at least four rows');
    const queries = new Set();
    for (const [title, query] of plan.sections) {
      assert.ok(title.trim() && query.trim(), key + ' row is named and searches for something');
      assert.ok(!/\{year\}/.test(query), key + ' row has the year filled in');
      assert.ok(!/\b(\w+) \1\b/i.test(query), key + ' row does not repeat a word: ' + query);
      assert.ok(!queries.has(query), key + ' rows are distinct searches');
      queries.add(query);
    }
  }
  assert.ok(V.categoryPlan('new music').sections.some(s => s[1].startsWith('top hits ' + year)), 'the year is this year');
  assert.equal(V.categoryPlan('some query no card owns'), null);
});

test('the Israeli cards ask in Hebrew and keep only Hebrew songs', () => {
  const V = covers();
  for (const key of ['new Israeli pop music', 'Hebrew pop hits']) {
    const plan = V.categoryPlan(key);
    for (const [, query] of plan.sections) assert.match(query, /[\u0590-\u05FF]/, key + ' asks in Hebrew: ' + query);
    assert.equal(typeof plan.keep, 'function', key + ' filters its rows');
    assert.ok(plan.keep(song('תהום', 'Omer Adam', 201)), 'a Hebrew title on a Latin channel stays');
    assert.ok(plan.keep(song('New Day Will Rise', 'יובל רפאל', 180)), 'a Latin title on a Hebrew channel stays');
    assert.ok(!plan.keep(song('Jerusalema (feat. Nomcebo Zikode)', 'Master KG', 343)), 'a song with no Hebrew goes');
    assert.ok(!plan.keep(song('Netanyahu debuts musical talents in news', 'ILTV Israel News', 200)), 'an English news clip goes');
    assert.ok(!plan.keep(song('ISRAELI PARTY VOL 2 מחרוזת', 'David Zeitouni', 1077)), 'an hour-long mix goes');
    assert.ok(!plan.keep(song('חדשות הערב', 'כאן', 300)), 'a Hebrew news item goes');
  }
});

test('song cards turn away mixes and news clips; long-form cards take everything', () => {
  const V = covers();
  const plan = V.categoryPlan('hip hop essentials');
  const keep = plan.keep;
  for (const [, query] of plan.sections) assert.match(query, / official video$/, 'a song row asks for the videos: ' + query);
  for (const [, query] of V.categoryPlan('focus music').sections) assert.doesNotMatch(query, /official video/, 'a long-form row does not: ' + query);
  for (const [, query] of V.categoryPlan('Hebrew pop hits').sections) assert.doesNotMatch(query, /official video/, 'a Hebrew row does not: ' + query);
  assert.ok(keep(song('Moneybagg Yo - I See Why (Official Video)', 'MoneyBagg Yo', 214)), 'a song stays');
  assert.ok(keep(song('Short punk song', 'Band', 50)), 'a short song stays');
  assert.ok(!keep(song('Lit Hip Hop Mix 2026 Tyga, Quavo', 'West Coast Finest', 3720)), 'an hour-long mix goes');
  assert.ok(!keep(song('Rapper interview 2026', 'Talk Show', 300)), 'an interview goes');
  for (const key of ['focus music', 'sleep music', 'ambient essentials', 'chill music', 'classical essentials', 'jazz essentials']) {
    assert.equal(V.categoryPlan(key).keep, null, key + ' keeps every result');
  }
});
