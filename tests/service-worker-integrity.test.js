const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readModule, pageScripts } = require('./source');

function worker() {
  const source = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
  const name = source.match(/const CACHE = "([^"]+)"/)[1];
  const handlers = {}, listeners = {}, stores = new Map(), served = new Map(), fetched = [];
  const origin = 'https://test';
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin + '/').href;
  const cache = store => ({
    async match(request, options = {}) {
      const wanted = new URL(key(request));
      for (const [url, response] of store) {
        if (url === wanted.href || options.ignoreSearch && new URL(url).pathname === wanted.pathname) return response.clone();
      }
    },
    async put(request, response) { store.set(key(request), response.clone()); }
  });
  const caches = {
    async open(id) { if (!stores.has(id)) stores.set(id, new Map()); return cache(stores.get(id)); },
    async keys() { return Array.from(stores.keys()); },
    async delete(id) { return stores.delete(id); },
    async match(request, options) {
      for (const store of stores.values()) {
        const response = await cache(store).match(request, options);
        if (response) return response;
      }
    }
  };
  let online = true;
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; (listeners[type] = listeners[type] || []).push(fn); },
      clients: { claim: async () => {} } },
    location: { origin }, caches, URL, Response, AbortController, setTimeout, clearTimeout, Uint8Array,
    fetch: async request => {
      fetched.push(new URL(key(request)).pathname);
      if (!online) throw Error('offline');
      const body = served.get(key(request));
      if (body instanceof Error) throw body;
      return body instanceof Response ? body.clone() : new Response(body === undefined ? key(request) : body);
    }
  });
  const shell = Array.from(source.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g), m => m[1]);
  return {
    name, caches, shell, fetched,
    offline() { online = false; },
    serve(url, body) { served.set(key(url), body); },
    async message(data) {
      let reply, done;
      for (const fn of listeners.message) fn({ data, ports: [{ postMessage: value => { reply = value; } }], waitUntil: p => { done = p; } });
      await done;
      return reply && JSON.parse(JSON.stringify(reply));
    },
    async seed(id, url, body) { await (await caches.open(id)).put(url, new Response(body)); },
    async activate() { let done; handlers.activate({ waitUntil: p => { done = p; } }); await done; },
    async get(url, mode = 'cors', referrer = '') {
      let response;
      const work = [];
      handlers.fetch({ request: { url: key(url), method: 'GET', mode, referrer, headers: new Headers() },
        waitUntil: p => work.push(p), respondWith: p => { response = p; } });
      const result = await response;
      await Promise.all(work);
      return result;
    }
  };
}

test('an app update removes only old shell caches', async () => {
  const h = worker();
  for (const name of ['another-app', 'aura-v1', h.name]) await h.seed(name, '/', 'saved');
  await h.activate();
  assert.deepEqual(await h.caches.keys(), ['another-app', h.name]);
});

test('shell assets cannot come from another application cache', async () => {
  const h = worker();
  await h.seed('another-app', '/src/main.js', 'wrong code');
  await h.seed(h.name, '/src/main.js', 'current code');
  h.offline();
  assert.equal(await (await h.get('/src/main.js')).text(), 'current code');
});

test('offline dynamic requests cannot reuse a response for a different query', async () => {
  const h = worker();
  await h.get('/resource?id=first');
  h.offline();
  assert.equal((await h.get('/resource?id=second')).type, 'error');
  assert.equal(await (await h.get('/resource?id=first')).text(), 'https://test/resource?id=first');
});

test('shell query strings still use the installed app while offline', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'app');
  h.offline();
  assert.equal(await (await h.get('/index.html?artist=UC1', 'navigate')).text(), 'app');
});

test('opening the app does not replace individual files in the installed shell', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'installed document');
  await h.seed(h.name, '/src/app.css', 'installed styles');
  await h.get('/index.html', 'navigate');
  await h.get('/src/app.css');
  h.offline();
  assert.equal(await (await h.get('/index.html', 'navigate')).text(), 'installed document');
  assert.equal(await (await h.get('/src/app.css')).text(), 'installed styles');
});

test('guest navigation and APIs bypass the private application shell and caches', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'private app');
  h.offline();
  assert.equal(await h.get('/guest/', 'navigate'), undefined);
  assert.equal(await h.get('/guest/app.js'), undefined);
  assert.equal(await h.get('/guest/api/state'), undefined);
});

test('signed media bypasses shell and response caches even without a range header', async () => {
  const h = worker();
  await h.seed(h.name, '/media/play?ticket=old', 'expired audio');
  h.offline();
  assert.equal(await h.get('/media/play?ticket=old'), undefined);
  assert.equal(await h.get('/media/play?ticket=new', 'navigate'), undefined);
  assert.equal(await h.get('/api/media/ticket'), undefined);
});

test('an explicit refresh fetches the document and its scripts ahead of cached copies', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'old document');
  await h.seed(h.name, '/src/views.js', 'old code');
  assert.equal(await (await h.get('/index.html?refresh=123', 'navigate')).text(), 'https://test/index.html?refresh=123');
  assert.equal(await (await h.get('/src/views.js', 'cors', 'https://test/index.html?refresh=123')).text(), 'https://test/src/views.js');
});

test('a refresh query on another origin cannot bypass the app cache', async () => {
  const h = worker();
  await h.seed(h.name, '/src/views.js', 'installed code');
  assert.equal(await (await h.get('/src/views.js', 'cors', 'https://elsewhere.test/?refresh=123')).text(), 'installed code');
});

test('TV receiver pages bypass the phone shell even under a hosted subdirectory', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'phone UI');
  assert.equal(await h.get('/tv/index.html', 'navigate'), undefined);
  assert.equal(await h.get('/aura-music/tv/index.html', 'navigate'), undefined);
  assert.equal(await h.get('/aura-music/tv/receiver.js'), undefined);
});

test('the independent audio check is never replaced by the cached application', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'phone UI');
  assert.equal(await h.get('/audio-check.html', 'navigate'), undefined);
  assert.equal(await h.get('/aura-music/audio-check.html?refresh=1', 'navigate'), undefined);
});

test('the login proxy pages reach the network so a lapsed session can sign in again', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'private app');
  assert.equal(await h.get('/oauth2/sign_in', 'navigate'), undefined);
  assert.equal(await h.get('/oauth2/start?rd=%2F', 'navigate'), undefined);
  assert.equal(await h.get('/oauth2/callback?code=abc&state=xyz', 'navigate'), undefined);
  assert.equal(await (await h.get('/', 'navigate')).text(), 'private app');
});

test('a deploy that kept the cache name still reaches the installed shell, all of it together', async () => {
  const h = worker();
  for (const entry of h.shell) { await h.seed(h.name, entry, 'installed'); h.serve(entry, 'installed'); }
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
  h.serve('./src/views.js', 'deployed code');
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: true });
  h.offline();
  assert.equal(await (await h.get('/src/views.js')).text(), 'deployed code');
  assert.equal(await (await h.get('/index.html', 'navigate')).text(), 'installed');
});

// Reading a hundred files on every return to the app stood in the way of the app being
// picked back up. While the deploy's revision is the one the last full comparison saw,
// that one small file is all a check reads; a new revision gets the full comparison.
test('a check reads only the served revision while it is the one last compared', async () => {
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const h = worker();
  for (const entry of h.shell) { await h.seed(h.name, entry, 'installed'); h.serve(entry, 'installed'); }
  h.serve('./app-revision.txt', first + '\n');
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
  assert.equal(h.fetched.length, h.shell.length + 1, 'the first check compares the whole shell');
  h.fetched.length = 0;
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
  assert.deepEqual(h.fetched, ['/app-revision.txt'], 'the same revision again is one request');
  h.serve('./src/views.js', 'deployed code');
  h.serve('./app-revision.txt', second);
  h.fetched.length = 0;
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: true });
  assert.equal(h.fetched.length, h.shell.length + 1, 'a new revision is compared in full');
  h.fetched.length = 0;
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
  assert.deepEqual(h.fetched, ['/app-revision.txt']);
  h.offline();
  assert.equal(await (await h.get('/src/views.js')).text(), 'deployed code');
});

test('without a revision to trust, every check compares the whole shell', async () => {
  const revision = 'c'.repeat(40);
  for (const answer of [undefined, new Response('sign in', { status: 403 }), 'not a commit', Error('dropped')]) {
    const h = worker();
    for (const entry of h.shell) { await h.seed(h.name, entry, 'installed'); h.serve(entry, 'installed'); }
    if (answer !== undefined) h.serve('./app-revision.txt', answer);
    for (let i = 0; i < 2; i++) {
      h.fetched.length = 0;
      assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
      assert.equal(h.fetched.length, h.shell.length + 1);
    }
  }
  // A comparison that failed is not taken as having seen the revision.
  const h = worker();
  for (const entry of h.shell) { await h.seed(h.name, entry, 'installed'); h.serve(entry, 'installed'); }
  h.serve('./app-revision.txt', revision);
  h.serve('./src/main.js', Error('dropped'));
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false, failed: true });
  h.serve('./src/main.js', 'installed');
  h.fetched.length = 0;
  assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false });
  assert.equal(h.fetched.length, h.shell.length + 1);
});

test('a shell that cannot be read whole leaves the installed one exactly as it was', async () => {
  for (const failure of [Error('dropped'), new Response('sign in', { status: 403 })]) {
    const h = worker();
    for (const entry of h.shell) { await h.seed(h.name, entry, 'installed'); h.serve(entry, 'deployed'); }
    h.serve('./src/main.js', failure);
    assert.deepEqual(await h.message({ type: 'SYNC_SHELL' }), { changed: false, failed: true });
    h.offline();
    for (const entry of ['/index.html', '/src/views.js', '/src/main.js']) {
      assert.equal(await (await h.get(entry)).text(), 'installed');
    }
  }
});

test('a refreshed document replaces the installed one instead of sitting beside it', async () => {
  const h = worker();
  await h.seed(h.name, '/index.html', 'installed document');
  h.serve('/index.html?refresh=123', 'deployed document');
  await h.get('/index.html?refresh=123', 'navigate');
  h.offline();
  assert.equal(await (await h.get('/index.html', 'navigate')).text(), 'deployed document');
  assert.equal(await (await h.get('/index.html?open=search', 'navigate')).text(), 'deployed document');
});

test('the version shown in Settings is the one the installed cache carries', () => {
  const cache = fs.readFileSync(require.resolve('../sw.js'), 'utf8').match(/const CACHE = "aura-(v\d+)"/)[1];
  const app = readModule('views').match(/const APP_VERSION = "([^"]+)"/)[1];
  assert.equal(app, cache, 'raise APP_VERSION in src/views.js together with CACHE in sw.js');
});

test('the shared translation script stays available offline without caching guest sessions', async () => {
  const h = worker();
  assert(h.shell.includes('./guest/i18n.js'));
  await h.seed(h.name, '/guest/i18n.js', 'translation catalog');
  h.offline();
  assert.equal(await (await h.get('/guest/i18n.js')).text(), 'translation catalog');
  assert.equal(await h.get('/guest/api/state'), undefined);
  assert.equal(await h.get('/guest/'), undefined);
});

// Every script and stylesheet the app loads has to be in the shell, or an installed app
// opened offline starts without it. Splitting a module into smaller files adds scripts,
// and each one is a line in index.html and a line in SHELL; this holds the two together.
test('the shell holds every script and stylesheet the app page loads', () => {
  const sw = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
  const shell = new Set(Array.from(sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g), m => m[1].replace(/^\.\//, '')));
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const styles = Array.from(html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g), m => m[1]);
  const loaded = pageScripts().concat(styles);
  assert(loaded.includes('src/views.js') && loaded.includes('src/app.css'), 'the page was not read');
  for (const file of loaded) assert(shell.has(file), file + ' is loaded by index.html but missing from SHELL in sw.js');
});
