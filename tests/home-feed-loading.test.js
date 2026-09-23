const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule, moduleScope } = require('./source');

// Exercise the real search pipeline and home row loader with a deterministic network clock.
function harness(reply) {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], logs = [], saved = [];
  const setTimeout = (fn, delay = 0) => {
    timers.set(++nextId, { at: now + delay, fn });
    return nextId;
  };
  const clearTimeout = id => timers.delete(id);
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const Log = { add: (tag, message) => logs.push({ tag, message }) };
  const Store = { settings: () => ({}), rememberInstance() {}, isBlocked: () => false };
  const context = vm.createContext(moduleScope({
    window: { Store, Log }, Store, Log, URL, AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    fetch(url, { signal }) {
      calls.push(url);
      const response = url === 'config.json'
        ? { json: { invidiousInstances: ['https://music.test'] } } : reply(url);
      return new Promise((resolve, reject) => {
        let timer;
        const abort = () => { clearTimeout(timer); reject(new Error('Fetch is aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        if (response.hang) return;
        timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve({ ok: !response.status || response.status === 200, status: response.status || 200,
            json: async () => response.json, text: async () => response.text });
        }, response.delay || 0);
      });
    },
    homeFilter: 'all', fillHomeFeeds() {}, homeFeedCacheSave: (key, rows) => saved.push(rows),
    homeFeeds: {}, homeFeedKey: () => 'home', homeFeedCacheLoad: () => null,
    homeFeedSpecs: () => [['More like Artist', 'artist music'], ['Popular right now', 'popular music']]
  }));
  vm.runInContext(readModule('api'), context);
  context.Api = context.window.Api;
  const views = readModule('views');
  for (const name of ['categorySearch', 'searchedRow', 'followHomeFeedKey', 'loadHomeSection', 'buildHomeFeeds']) {
    const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(views);
    vm.runInContext(views.slice(match.index, views.indexOf('\n  }', match.index) + 4), context);
  }
  return {
    context, calls, logs, saved,
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    row() {
      const section = { title: 'More like Artist', query: 'artist music', mode: '', tracks: [] };
      const state = { sections: [section] };
      const done = context.loadHomeSection(state, section, 'home');
      return { state, section, done };
    }
  };
}

const song = { videoId: 'song1111111', title: 'Song', author: 'Artist', lengthSeconds: 180 };
const html = 'var ytInitialData = ' + JSON.stringify({ contents: [{ videoRenderer: {
  videoId: song.videoId, title: { runs: [{ text: song.title }] },
  ownerText: { runs: [{ text: song.author }] }, lengthText: { simpleText: '3:00' }
} }] }) + ';</script>';

test('home accepts fallback results arriving after ten seconds', async () => {
  const h = harness(url => url.startsWith('https://music.test') ? { hang: true } : { delay: 4000, text: html });
  const row = h.row();
  await h.advance(10000);
  assert.equal(row.section.status, 'loading');
  await h.advance(2000);
  await row.done;
  assert.equal(row.section.status, 'ready');
  assert.equal(row.section.tracks[0].id, song.videoId);
  assert.equal(h.saved.length, 1);
});

test('a hanging first proxy cannot hold up a working fallback', async () => {
  const h = harness(url => url.startsWith('https://music.test') ? { status: 503 }
    : url.startsWith('https://api.allorigins.win') ? { hang: true } : { text: html });
  const row = h.row();
  await h.advance(1);
  assert.equal(row.section.status, 'ready');
  assert.equal(row.section.tracks[0].id, song.videoId);
  await h.advance(15000);
  assert.equal(row.section.status, 'ready');
});

test('a proxy error page is rejected while another proxy can supply tracks', async () => {
  const h = harness(url => url.startsWith('https://music.test') ? { status: 503 }
    : url.startsWith('https://api.allorigins.win') ? { text: '<html>Blocked</html>' } : { text: html });
  const row = h.row();
  await h.advance(1);
  await row.done;
  assert.equal(row.section.status, 'ready');
  assert.equal(row.section.tracks.length, 1);
});

test('complete network failure settles with a logged error and a later retry succeeds', async () => {
  let online = false;
  const h = harness(url => online && url.startsWith('https://music.test') ? { json: [song] } : { hang: true });
  const row = h.row();
  await h.advance(24000);
  assert.equal(row.section.status, 'error');
  assert.equal(h.saved.length, 0);
  assert(h.logs.some(entry => entry.tag === 'home' && entry.message.includes('More like Artist') && entry.message.includes('Fetch is aborted')));
  online = true;
  const retry = h.context.loadHomeSection(row.state, row.section, 'home');
  await h.advance(1);
  await retry;
  assert.equal(row.section.status, 'ready');
  assert.equal(row.section.tracks[0].id, song.videoId);
});

test('a healthy primary source does not call public proxies', async () => {
  const h = harness(() => ({ json: [song] }));
  const row = h.row();
  await h.advance(1);
  await row.done;
  assert.equal(row.section.status, 'ready');
  assert.deepEqual(h.calls, ['config.json', 'https://music.test/api/v1/search?q=artist%20music&type=video']);
});

test('a partial cache preserves successful rows and retries missing recommendations', async () => {
  const h = harness(() => ({ json: [song] }));
  h.context.homeFeedCacheLoad = () => [{ title: 'More like Artist', query: 'artist music', mode: '', tracks: [{ id: 'cached', duration: 180 }] }];
  h.context.buildHomeFeeds();
  const state = h.context.homeFeeds.home;
  assert.equal(state.sections.length, 2);
  assert.equal(state.sections[0].tracks[0].id, 'cached');
  assert.equal(state.sections[0].status, 'ready');
  assert.equal(state.sections[1].status, 'loading');
  await h.advance(1);
  assert.equal(state.sections[1].status, 'ready');
  assert.equal(h.calls.filter(url => url.includes('/search?')).length, 1);
  assert(h.calls.some(url => url.includes('q=popular%20music')));
});

test('successful recommendations are cached even when the last row fails', async () => {
  const h = harness(url => url.includes('q=artist%20music') ? { json: [song] } : { status: 503, delay: 100 });
  h.context.buildHomeFeeds();
  await h.advance(1000);
  assert.equal(h.context.homeFeeds.home.sections[0].status, 'ready');
  assert.equal(h.context.homeFeeds.home.sections[1].status, 'error');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].length, 1);
  assert.equal(h.saved[0][0].tracks[0].id, song.videoId);
});

test('a complete cache paints immediately without making search requests', async () => {
  const h = harness(() => { throw new Error('Unexpected search'); });
  h.context.homeFeedCacheLoad = () => h.context.homeFeedSpecs().map(spec => ({
    title: spec[0], query: spec[1], tracks: [{ id: 'cached', duration: 180 }]
  }));
  h.context.buildHomeFeeds();
  await h.advance(1);
  assert(h.context.homeFeeds.home.sections.every(section => section.status === 'ready'));
  assert.equal(h.calls.length, 0);
});

// Loading a show's row teaches the store that show's channel, which reorders the shows
// and moves the key; the rows used to be painted under a key nothing had loaded.
test('rows stay reachable when the show order moves the key while they load', async () => {
  const h = harness(() => ({ json: [song], delay: 100 }));
  let key = 'all:new:Show A|Show B';
  h.context.homeFeedKey = () => key;
  h.context.homeFeedBase = () => 'all:new';
  h.context.buildHomeFeeds();
  key = 'all:new:Show B|Show A';
  await h.advance(1000);
  const state = h.context.homeFeeds[key];
  assert(state, 'the loaded rows are what the new key paints');
  assert(state.sections.every(section => section.status === 'ready'));
  // A different filter or different artists are different rows, and load for themselves.
  h.context.homeFeedBase = () => 'music:new';
  key = 'music:new';
  h.context.followHomeFeedKey(state, 'all:new:Show A|Show B');
  assert.equal(h.context.homeFeeds['music:new'], undefined);
});
