const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

function setup(ids = ['one', 'two', 'three'], options = {}) {
  const tracks = ids.map(id => ({ id, title: id, duration: 180 }));
  const h = createHarness({ tracks, withStorage: true, withAudioSession: false,
    settings: { autoplay: false, noYtFallback: true, crossfade: 0 }, ...options });
  const P = h.window.Player, events = [], requests = [];
  h.Api.resolve = async id => {
    requests.push(id);
    if (h.navigator.onLine === false) throw Object.assign(new Error('Failed to fetch'), { outage: true });
    return { url: 'https://test/' + id };
  };
  h.Api.invalidate = () => {};
  P.onChange(event => events.push(event));
  // A new source only counts as started once the element reports it is playing.
  for (const audio of h.audioElements) {
    const play = audio.play;
    audio.play = function () { const result = play.call(this); this.dispatch('playing'); return result; };
  }
  return { ...h, P, events, requests, tracks };
}

function goOffline(h) {
  h.navigator.onLine = false;
  h.window.dispatch('offline');
}

test('a song buffered to its end plays out offline instead of pausing a second short', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(80);
  h.audio.buffered = { length: 1, start: () => 0, end: () => 180 };
  h.audio.currentTime = 100;
  goOffline(h);
  h.audio.currentTime = 179.4;
  h.runIntervals(500);
  assert.equal(h.audio.paused, false, 'the end of the song is not the end of the buffer');
  assert.equal(h.P.isPaused(), false);
});

test('a stream whose buffer really runs out offline is paused for the network', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(80);
  h.audio.buffered = { length: 1, start: () => 0, end: () => 60 };
  h.audio.currentTime = 30;
  goOffline(h);
  assert.equal(h.audio.paused, false);
  h.audio.currentTime = 59.5;
  h.runIntervals(500);
  assert.equal(h.audio.paused, true);
});

// unreadable ids are listed as saved but hand back nothing, as bytes a phone cannot read do.
function memoryDb(saved = [], unreadable = []) {
  const stores = { tracks: new Map(saved.map(id => [id, new Blob(['audio ' + id], { type: 'audio/mp4' })])
    .concat(unreadable.map(id => [id, null]))), art: new Map(), cache: new Map() };
  function request(result) { const req = { result }; Promise.resolve().then(() => { if (req.onsuccess) req.onsuccess(); }); return req; }
  return { objectStoreNames: { contains: () => true }, transaction(name) {
    const map = stores[name] || (stores[name] = new Map());
    const tx = { objectStore: () => ({ get: key => request(map.get(key) || null), put: (value, key) => { map.set(key, value); return request(); },
      delete: key => { map.delete(key); return request(); }, getAllKeys: () => request([...map.keys()]) }) };
    Promise.resolve().then(() => { if (tx.oncomplete) tx.oncomplete(); });
    return tx;
  } };
}

test('with no signal the queue carries on with the next saved song, quietly', async () => {
  const h = setup(['saved-1', 'stream-only', 'saved-2'], { storageDb: memoryDb(['saved-1', 'saved-2']) });
  h.P.playQueue(h.tracks, 0);
  await flushMicrotasks(120);
  assert.match(h.audio.src, /^blob:/);
  goOffline(h);
  h.requests.length = 0;
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.audio.ended = false;
  await flushMicrotasks(200);
  assert.equal(h.P.current().id, 'saved-2');
  assert.equal(h.P.isPaused(), false);
  assert.deepEqual(h.requests, [], 'nothing is asked of the network');
  assert.equal(h.events.some(e => e.type === 'offline-skip' || e.type === 'source-outage'), false);
});

test('a song picked offline that is not on the device gives way to a saved one and says so', async () => {
  const h = setup(['stream-only', 'other', 'saved'], { storageDb: memoryDb(['saved']) });
  h.navigator.onLine = false;
  h.P.playQueue(h.tracks, 0);
  await flushMicrotasks(200);
  assert.equal(h.P.current().id, 'saved');
  assert.equal(h.P.isPaused(), false);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.events.filter(e => e.type === 'offline-skip').map(e => e.track.id), ['stream-only']);
});

test('with nothing saved ahead an offline song is held for the signal, not skipped or sent to YouTube', async () => {
  const h = setup(['one', 'two', 'three'], { storageDb: memoryDb([]), settings: { autoplay: false, noYtFallback: false, crossfade: 0 } });
  h.play();
  await flushMicrotasks(80);
  h.navigator.onLine = false;
  h.requests.length = 0;
  h.P.jumpTo(2);
  await flushMicrotasks(200);
  assert.equal(h.P.current().id, 'three');
  assert.deepEqual(h.requests, []);
  assert.equal(h.events.some(e => e.type === 'offline-unavailable'), true);
  assert.equal(h.events.some(e => e.type === 'fallback-yt' || e.type === 'error' || e.type === 'fallback-skip'), false);
  h.navigator.onLine = true;
  h.window.dispatch('online');
  await flushMicrotasks(200);
  assert.deepEqual(h.requests.slice(0, 1), ['three'], 'the held song is asked for once the signal is back');
  assert.equal(h.audio.src, 'https://test/three');
});

test('focus returning offline resumes a saved song, and still leaves a stream alone', () => {
  for (const [source, plays] of [['blob:saved-copy', 2], ['https://test/stream', 1]]) {
    const h = createHarness();
    h.audio.src = source;
    h.play();
    h.audioSession.state = 'interrupted';
    h.audioSession.dispatch('statechange');
    h.audio.pause();
    h.navigator.onLine = false;
    h.audioSession.state = 'active';
    h.audioSession.dispatch('statechange');
    h.runImmediateTimers();
    assert.equal(h.audio.playCalls, plays, source);
  }
});

test('a stream error with no signal keeps its place for the signal instead of turning to YouTube', async () => {
  const h = setup(['one', 'two'], { settings: { autoplay: false, noYtFallback: false, crossfade: 0 } });
  h.play();
  await flushMicrotasks(80);
  h.audio.currentTime = 90;
  h.navigator.onLine = false;
  h.requests.length = 0;
  h.audio.dispatch('error');
  await flushMicrotasks(80);
  assert.deepEqual(h.requests, []);
  assert.equal(h.events.some(e => e.type === 'fallback-yt' || e.type === 'error' || e.type === 'fallback-skip'), false);
  assert.equal(h.P.current().id, 'one');
  h.navigator.onLine = true;
  h.window.dispatch('online');
  await flushMicrotasks(200);
  assert.equal(h.requests[0], 'one');
  assert.equal(h.audio.src, 'https://test/one');
});

test('radio with no signal extends the queue with saved songs only and asks the network nothing', async () => {
  const song = id => ({ id, title: id, artist: 'Artist ' + id, duration: 180 });
  const h = setup(['seed'], { storageDb: memoryDb(['seed', 'liked-saved', 'only-downloaded']),
    settings: { autoplay: true, noYtFallback: true, crossfade: 0 } });
  h.Store.likedTracks = () => [song('liked-stream'), song('liked-saved'), song('liked-stream-2')];
  h.Store.downloadedTracks = () => [song('only-downloaded')];
  h.navigator.onLine = false;
  h.P.playQueue([song('seed')], 0);
  await flushMicrotasks(300);
  h.runImmediateTimers();
  await flushMicrotasks(300);
  assert.deepEqual(Array.from(h.P.queue(), t => t.id).sort(), ['liked-saved', 'only-downloaded', 'seed']);
  assert.deepEqual(h.requests, []);
});

// Repeat-all wraps round to the song it started from; one that is listed as saved but
// cannot be read used to be picked again and again, each load re-entering the next.
test('an unreadable saved song under repeat-all is held offline instead of reloading forever', async () => {
  const h = setup(['broken', 'stream-only'], { storageDb: memoryDb([], ['broken']) });
  h.P.cycleRepeat();
  h.navigator.onLine = false;
  h.P.playQueue(h.tracks, 0);
  await flushMicrotasks(600);
  const loads = h.events.filter(e => e.type === 'loading').length;
  assert(loads <= 2, 'loaded ' + loads + ' times');
  assert.equal(h.events.some(e => e.type === 'offline-unavailable'), true);
  assert.deepEqual(h.requests, []);
});

test('Next during an interruption resumes the selected saved song when focus returns offline', async () => {
  const h = setup(['one', 'two'], { storageDb: memoryDb(['one', 'two']), withAudioSession: true });
  h.navigator.onLine = false;
  h.P.playQueue(h.tracks);
  await flushMicrotasks(120);
  h.audioSession.state = 'interrupted';
  h.audioSession.dispatch('statechange');
  h.audio.pause();
  h.actions.get('nexttrack')();
  await flushMicrotasks(120);
  assert.equal(h.P.current().id, 'two');
  assert.equal(h.audio.src, '');
  h.audioSession.state = 'active';
  h.audioSession.dispatch('statechange');
  h.runImmediateTimers();
  await flushMicrotasks(120);
  assert.equal(h.P.isPaused(), false);
  assert.match(h.audio.src, /^blob:/);
  assert.equal(await (await fetch(h.audio.src)).text(), 'audio two');
  assert.deepEqual(h.requests, []);
  h.P.dismiss();
});
