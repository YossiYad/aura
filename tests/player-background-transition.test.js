const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

const tracks = [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }];
function setup() {
  const cache = new Map();
  const downloads = new Map();
  const request = result => {
    const req = { result };
    Promise.resolve().then(() => req.onsuccess?.());
    return req;
  };
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name) {
      const map = name === 'cache' ? cache : downloads;
      const tx = { objectStore: () => ({
        get: id => request(map.get(id)),
        put: (value, id) => { map.set(id, value); return request(); },
        delete: id => { map.delete(id); return request(); }
      }) };
      Promise.resolve().then(() => tx.oncomplete?.());
      return tx;
    }
  };
  const h = createHarness({ tracks: tracks.map(track => ({ ...track })), storageDb, withStorage: true, exposeInternals: true,
    withAudioSession: false, settings: { autoplay: false, noYtFallback: true } });
  const resolves = [];
  h.Api.resolve = async id => { resolves.push(id); return { url: 'https://test/' + id, base: 'https://test' }; };
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  return { ...h, cache, downloads, resolves, standby: h.audioElements[1], internals: h.window.__playerInternals };
}

for (const event of ['timeupdate', 'pause']) {
  test('background transition starts from the final ' + event + ' without timers or an ended event', async () => {
    const h = setup();
    h.window.Player.addToQueue({ id: 'three', title: 'Three' });
    await flushMicrotasks(50);
    // Loading a new resource resets the previous resource's endpoint in a browser.
    let source = h.audio.src;
    Object.defineProperty(h.audio, 'src', {
      get: () => source,
      set(value) { source = value; this.ended = false; this.currentTime = 0; }
    });
    for (const id of ['two', 'three']) {
      h.audio.currentTime = h.audio.duration;
      h.audio.ended = true;
      h.audio.paused = true;
      const calls = h.audio.playCalls;
      h.audio.dispatch(event);
      // Request playback inside the native media callback, before yielding to
      // storage, a timer, or a visibility event that may wait until foregrounding.
      assert.equal(h.audio.src, 'https://test/' + id);
      assert.equal(h.audio.playCalls, calls + 1);
      await flushMicrotasks(50);
      assert.equal(h.window.Player.current().id, id);
      assert.equal(h.audio.paused, false);
      // Events queued for the old resource must not stop or skip the new song.
      h.audio.dispatch('pause');
      h.audio.dispatch('ended');
      await flushMicrotasks(50);
      assert.equal(h.window.Player.current().id, id);
      assert.equal(h.audio.paused, false);
    }
    h.window.Player.dismiss();
  });
}

test('a near-end pause on a non-iOS engine stays an ordinary platform pause', async () => {
  // Chrome and friends fire ended reliably and resume their own interruptions, so
  // only iOS reads a final-second stop as the track finishing.
  const h = setup();
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  h.audio.currentTime = h.audio.duration - 0.4;
  h.audio.paused = true;
  h.audio.dispatch('pause');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true, 'intent kept for the focus return');
  h.window.Player.dismiss();
});

test('a final background timeupdate does not advance during an audio interruption', async () => {
  const h = setup();
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  h.audio.pause();
  h.audio.currentTime = h.audio.duration;
  h.audio.ended = true;
  h.audio.dispatch('timeupdate');
  h.audio.dispatch('pause');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.paused, true);
  h.window.Player.dismiss();
});

test('an unreadable cached next track is repaired while the first track keeps playing', async () => {
  const h = setup();
  h.cache.set('two', { blob: new Blob(['bad audio']) });
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  assert.match(h.standby.src, /^blob:/);
  h.standby.error = { code: 4 };
  h.standby.dispatch('error');
  await flushMicrotasks(40);
  assert.equal(h.cache.has('two'), false);
  assert.equal(h.standby.src, 'https://test/two');
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.playCalls, 1);
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.window.Player.current().id, 'two');
  assert.deepEqual(h.resolves, ['two']);
  h.window.Player.dismiss();
});

test('a cache record whose bytes are already lost is discarded at preparation, not at the transition', async () => {
  const h = setup();
  // iOS keeps the IndexedDB record while dropping the file behind its blob: the get
  // succeeds, and only reading the bytes fails. The read must happen at preparation,
  // while the current track still plays, so the transition never sees a dead source.
  h.cache.set('two', { blob: {
    size: 9, type: 'audio/mp4',
    slice() { return this; },
    arrayBuffer: () => Promise.reject(Object.assign(new Error('The operation is not supported.'), { name: 'NotSupportedError' }))
  } });
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(60);
  assert.equal(h.cache.has('two'), false, 'the dead record is dropped when its read fails');
  assert.equal(h.standby.src, 'https://test/two', 'preparation falls back to the direct stream');
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(60);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('a playable cached next track is handed out as a copy the store cannot invalidate', async () => {
  const h = setup();
  const stored = new Blob(['saved audio']);
  h.cache.set('two', { blob: stored });
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(60);
  assert.match(h.standby.src, /^blob:/);
  const held = await (await fetch(h.standby.src)).text();
  assert.equal(held, 'saved audio', 'the prepared source carries the stored bytes');
  h.window.Player.dismiss();
  URL.revokeObjectURL(h.standby.src);
});

test('a network error during preparation preserves a saved download', async () => {
  const h = setup();
  const blob = new Blob(['saved audio']);
  h.downloads.set('two', blob);
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  h.standby.error = { code: 2 };
  h.standby.dispatch('error');
  await flushMicrotasks(40);
  assert.equal(h.downloads.get('two'), blob);
  assert.equal(h.standby.src, 'https://test/two');
  h.window.Player.dismiss();
});

test('a late preparation repair cannot restore a removed upcoming track', async () => {
  const h = setup();
  let release;
  h.Api.resolve = () => new Promise(resolve => { release = resolve; });
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/stale' });
  h.standby.error = { code: 2 };
  h.standby.dispatch('error');
  h.window.Player.clearUpcoming();
  release({ url: 'https://test/repaired' });
  await flushMicrotasks(40);
  assert.equal(h.standby.src, '');
  assert.equal(h.window.Player.queue().length, 1);
  assert.equal(h.audio.paused, false);
});

test('a late initial preparation cannot restore a removed upcoming track', async () => {
  const h = setup();
  let release;
  h.Api.resolve = () => new Promise(resolve => { release = resolve; });
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  h.window.Player.clearUpcoming();
  release({ url: 'https://test/removed' });
  await flushMicrotasks(40);
  assert.equal(h.standby.src, '');
  assert.equal(h.window.Player.current().id, 'one');
});

test('a blob rejected only at the background transition is not played a second time', async () => {
  const h = setup();
  h.cache.set('two', { blob: new Blob(['bad audio']) });
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  const attempted = [];
  h.audio.play = function () {
    attempted.push(this.src);
    if (this.src.startsWith('blob:')) {
      return Promise.reject(Object.assign(new Error('Unsupported'), { name: 'NotSupportedError' }));
    }
    const promise = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return promise;
  };
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(80);
  assert.equal(attempted.filter(src => src.startsWith('blob:')).length, 1);
  assert.equal(attempted.length, 2);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.cache.has('two'), false);
  assert.equal(h.standby.src, '');
  h.window.Player.dismiss();
});

test('duplicate end events cannot advance past a pending prepared transition', async () => {
  const h = setup();
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  let release;
  h.audio.play = () => new Promise(resolve => { release = resolve; });
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.audio.dispatch('ended');
  h.document.hidden = false;
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'one');
  assert.deepEqual(h.resolves, []);
  h.audio.ended = false;
  release();
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('a prepared active-element error recovers the next track, not the old track', async () => {
  const h = setup();
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/stale' });
  h.audio.play = () => new Promise(() => {});
  h.internals.playPreparedInstantly();
  h.audio.error = { code: 2 };
  h.audio.dispatch('error');
  h.audio.play = FakeAudio.prototype.play;
  await flushMicrotasks(60);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.deepEqual(h.resolves, ['two']);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.pendingTimers(9000), 0);
  h.window.Player.dismiss();
});

test('a timed-out URL can be replaced by a fresh URL from the same server', async () => {
  const h = setup();
  const attempts = [];
  let resolves = 0;
  h.Api.resolve = async () => ({ url: 'https://test/audio?token=' + (++resolves), base: 'https://test' });
  h.audio.play = function () {
    attempts.push(this.src);
    if (attempts.length === 1) { this.paused = true; this.currentTime = 0; this.readyState = 0; return new Promise(() => {}); }
    this.readyState = 4;
    const promise = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return promise;
  };
  h.window.Player.playQueue([tracks[1]], 0);
  await flushMicrotasks(40);
  h.runTimers(9000);
  await flushMicrotasks(60);
  assert.deepEqual(attempts, ['https://test/audio?token=1', 'https://test/audio?token=2']);
  assert.equal(h.audio.paused, false);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.pendingTimers(9000), 0);
  h.window.Player.dismiss();
});

test('a local start timeout does not delete the cached file', async () => {
  const h = setup();
  h.cache.set('two', { blob: new Blob(['saved audio']) });
  h.audio.play = function () {
    if (this.src.startsWith('blob:')) {
      this.paused = true; this.currentTime = 0; this.readyState = 0;
      return new Promise(() => {});
    }
    const promise = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return promise;
  };
  h.window.Player.playQueue([tracks[1]], 0);
  await flushMicrotasks(40);
  h.runTimers(9000);
  await flushMicrotasks(60);
  assert.equal(h.cache.has('two'), true);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});

test('starting playback saves only the next track locally for an instant transition', async () => {
  const h = setup();
  const blobRequests = [];
  h.Api.fetchStreamBlob = async id => { blobRequests.push(id); return new Blob(['audio ' + id]); };
  h.window.Player.playQueue([...tracks, { id: 'three', title: 'Three' }], 0);
  await flushMicrotasks(50);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
  // The preparation is upgraded to the saved copy, so the handoff needs no network.
  assert.match(h.standby.src, /^blob:/);
  assert.equal(h.standby.preload, 'auto');
  assert.equal(h.standby.paused, true);
  assert.deepEqual(h.resolves, ['one', 'two']);
  assert.deepEqual(blobRequests, ['two'], 'only the next track, never the whole queue');
  assert.equal(h.cache.has('two'), true);
  assert.equal(h.downloads.size, 0);
  // The background handoff starts from the local copy on the active element.
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'two');
  assert.match(h.audio.src, /^blob:/);
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});

test('a failed local copy falls back to preparing the direct stream', async () => {
  const h = setup();
  h.Api.fetchStreamBlob = async () => { throw new Error('stream too large'); };
  h.window.Player.playQueue(tracks.map(track => ({ ...track })), 0);
  await flushMicrotasks(50);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.equal(h.standby.src, 'https://test/two');
  assert.equal(h.standby.preload, 'auto');
  assert.equal(h.cache.size, 0);
  h.window.Player.dismiss();
});

test('manual next reuses the prepared stream and prepares the following song', async () => {
  const h = setup();
  h.document.hidden = false;
  h.window.Player.addToQueue({ id: 'three', title: 'Three' });
  await flushMicrotasks(50);
  assert.equal(h.standby.src, 'https://test/two');
  h.Api.fetchStreamBlob = async () => { throw new Error('unavailable'); };
  h.window.Player.next();
  assert.equal(h.standby.playCalls, 1);
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.standby.paused, false);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.src, 'https://test/three');
  assert.equal(h.audio.preload, 'auto');
  assert.deepEqual(h.resolves, ['two', 'three']);
  h.window.Player.dismiss();
});

test('reordering the queue replaces the single prepared stream', async () => {
  const h = setup();
  h.window.Player.addToQueue({ id: 'three', title: 'Three' });
  await flushMicrotasks(50);
  assert.equal(h.standby.src, 'https://test/two');
  h.window.Player.moveAt(2, 1);
  await flushMicrotasks(50);
  assert.equal(h.standby.src, 'https://test/three');
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
  h.window.Player.next();
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'three');
  assert.equal(h.audio.src, 'https://test/three');
  assert.equal(h.standby.src, 'https://test/two');
  h.window.Player.dismiss();
});

test('repeated preparation triggers reuse the pending lookup', async () => {
  const h = setup();
  let release;
  let requests = 0;
  h.Api.resolve = () => { requests++; return new Promise(resolve => { release = resolve; }); };
  h.document.dispatch('visibilitychange');
  h.internals.prefetchNext();
  await flushMicrotasks(50);
  h.internals.prefetchNext();
  h.document.dispatch('visibilitychange');
  assert.equal(requests, 1);
  release({ url: 'https://test/two' });
  await flushMicrotasks(50);
  assert.equal(h.standby.src, 'https://test/two');
  h.window.Player.dismiss();
});

test('adding a next song to a playing single-track queue prepares it immediately', async () => {
  const h = setup();
  h.window.Player.clearUpcoming();
  await flushMicrotasks(50);
  h.window.Player.addToQueue(tracks[1]);
  await flushMicrotasks(50);
  assert.equal(h.standby.src, 'https://test/two');
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});
