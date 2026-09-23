const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule, moduleScope } = require('./source');

function setup(cached = null) {
  const source = readModule('main');
  const events = new Map(), cache = new Map();
  if (cached) cache.set('song', cached);
  const holder = {
    innerHTML: '', addEventListener() {}, setAttribute() {}, removeAttribute() {}
  };
  let current = { id: 'song' }, calls = 0;
  const context = {
    $: () => holder,
    window: { addEventListener: (event, fn) => events.set(event, fn) },
    Player: { current: () => current },
    navigator: { onLine: true },
    Store: { cachedLyrics: id => cache.get(id), cacheLyrics: (id, data) => cache.set(id, data) },
    Api: { getLyrics: async () => { calls++; return { plainLyrics: 'New words' }; } }
  };
  vm.createContext(moduleScope(context));
  vm.runInContext(source.slice(source.indexOf('  let lyricsToken ='), source.indexOf('  function applyFpAccent(')), context);
  return {
    context, holder, cache, calls: () => calls,
    load: () => context.loadLyrics(current),
    online: () => events.get('online')?.(),
    select: id => { current = { id }; }
  };
}

test('a shorter lyric response preserves the fuller saved copy', async () => {
  const saved = { plainLyrics: 'First line\nSecond line\nThird line' };
  const h = setup(saved);
  await h.load();
  assert.equal(h.calls(), 1);
  assert.equal(h.cache.get('song'), saved);
  assert.match(h.holder.innerHTML, /Third line/);
});

test('lyrics retry on reconnection without restarting the song', async () => {
  const h = setup();
  let calls = 0;
  h.context.Api.getLyrics = async () => {
    if (++calls === 1) throw Error('offline');
    return { plainLyrics: 'Recovered words' };
  };
  h.context.navigator.onLine = false;
  await h.load();
  assert.match(h.holder.innerHTML, /Couldn't load the lyrics - they'll load when you're back online/,
    'a failed lookup is not a song without lyrics');
  await h.load();
  assert.equal(calls, 1, 'ordinary screen refreshes must not flood a failed provider');
  h.context.navigator.onLine = true;
  await h.online();
  assert.equal(calls, 2);
  assert.match(h.holder.innerHTML, /Recovered words/);
  assert.equal(h.cache.get('song').plainLyrics, 'Recovered words');
  await h.online();
  assert.equal(calls, 2, 'successful lyrics need no further network retries');
});

test('reconnection does not duplicate a pending lyric lookup', async () => {
  const h = setup();
  let finish, calls = 0;
  h.context.Api.getLyrics = () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  };
  const pending = h.load();
  await h.online();
  assert.equal(calls, 1);
  finish({ plainLyrics: 'Ready' });
  await pending;
});

test('a failed old lookup cannot make a successful new song refetch', async () => {
  const h = setup();
  let fail, calls = 0;
  h.context.Api.getLyrics = track => {
    calls++;
    return track.id === 'song' ? new Promise((resolve, reject) => { fail = reject; })
      : Promise.resolve({ plainLyrics: 'Current song' });
  };
  const old = h.load();
  h.select('next');
  await h.load();
  fail(Error('old lookup failed'));
  await old;
  await h.online();
  assert.equal(calls, 2);
  assert.match(h.holder.innerHTML, /Current song/);
});

test('a confirmed lyric miss remains cached after reconnection', async () => {
  const h = setup({ none: true });
  await h.load();
  await h.online();
  assert.equal(h.calls(), 0);
});

test('a fuller lyric response replaces a partial cached copy', async () => {
  const h = setup({ plainLyrics: 'First line' });
  h.context.Api.getLyrics = async () => ({ plainLyrics: 'First line\nSecond line' });
  await h.load();
  assert.match(h.cache.get('song').plainLyrics, /Second line/);
  assert.match(h.holder.innerHTML, /Second line/);
});

test('retrying lyrics preserves the timing adjustment for the current song', async () => {
  const h = setup({ syncedLyrics: '[00:10.00]Saved words' });
  h.context.Api.getLyrics = async () => { throw Error('offline'); };
  await h.load();
  vm.runInContext('lyricsOffset = 2', h.context);
  h.context.Api.getLyrics = async () => ({ syncedLyrics: '[00:10.00]Recovered words' });
  await h.online();
  assert.equal(vm.runInContext('lyricsOffset', h.context), 2);
  h.select('next');
  await h.load();
  assert.equal(vm.runInContext('lyricsOffset', h.context), 0);
});
