const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

const requested = { id: 'requested', title: 'Requested song', artist: 'Original singer', duration: 180 };
const denied = () => Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });

function setup(options = {}) {
  const h = createHarness({ withStorage: true, settings: { autoplay: false, noYtFallback: true }, ...options });
  const events = [];
  h.window.Player.onChange(event => events.push(event));
  const resolves = [];
  h.Api.resolve = async id => { resolves.push(id); return { url: 'https://test/' + id, base: 'https://test', related: [] }; };
  h.Api.invalidate = assert.fail;
  h.Api.findVersions = assert.fail;
  h.audio.play = function () { this.playCalls++; return Promise.reject(denied()); };
  return { ...h, P: h.window.Player, events, resolves };
}

test('a denied stream keeps its source and queue without fallback, radio, retry or success events', async () => {
  const h = setup({ settings: { autoplay: true, noYtFallback: true } });
  const playingListeners = (h.audio.listeners.get('playing') || []).slice();
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.P.current().id, requested.id);
  assert.equal(h.P.queue().length, 1);
  assert.equal(h.audio.src, 'https://test/requested');
  assert.equal(h.P.needsPlaybackGesture(), true);
  assert.equal(h.P.playbackRequested(), false);
  assert.equal(h.events.filter(e => e.type === 'playback-permission').length, 1);
  assert.equal(h.events.some(e => ['track', 'error', 'fallback-skip', 'fallback-yt'].includes(e.type)), false);
  assert.equal(h.pendingTimers(9000), 0);
  assert.deepEqual(h.audio.listeners.get('playing'), playingListeners, 'temporary start listeners must be removed');
  for (const delay of [2000, 5000, 10000, 20000, 30000, 60000]) assert.equal(h.runTimers(delay), 0);
  h.window.dispatch('online'); h.document.dispatch('visibilitychange');
  h.audioSession.state = 'active'; h.audioSession.dispatch('statechange');
  h.runImmediateTimers(); await flushMicrotasks(30);
  assert.equal(h.audio.playCalls, 1);
  assert.deepEqual(h.resolves, ['requested']);
});

test('the next Play tap calls play synchronously on the prepared source with no new lookup', async () => {
  const h = setup(); h.P.playQueue([requested], 0); await flushMicrotasks(70);
  h.audio.play = FakeAudio.prototype.play;
  h.P.toggle();
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
  await flushMicrotasks(30);
  assert.equal(h.P.needsPlaybackGesture(), false);
  assert.deepEqual(h.resolves, ['requested']);
  assert.equal(h.events.filter(e => e.type === 'track').length, 1);
  assert.equal(h.navigator.mediaSession.metadata.title, requested.title);
});

test('a second permission denial keeps the same prepared track for another tap', async () => {
  const h = setup(); h.P.playQueue([requested], 0); await flushMicrotasks(70);
  h.P.toggle(); await flushMicrotasks(30);
  assert.equal(h.P.needsPlaybackGesture(), true);
  assert.deepEqual(h.resolves, ['requested']);
  assert.equal(h.P.current().id, requested.id);
  assert.equal(h.events.filter(e => e.type === 'playback-permission').length, 2);
  h.audio.play = FakeAudio.prototype.play; h.P.toggle(); await flushMicrotasks(30);
  assert.equal(h.P.needsPlaybackGesture(), false);
});

test('saved audio remains downloaded and its blob URL survives a permission denial', async () => {
  const blob = new Blob(['audio']);
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name) { return { objectStore: () => ({
      get() {
        const req = { result: name === 'tracks' ? blob : null };
        Promise.resolve().then(() => req.onsuccess?.()); return req;
      },
      delete: assert.fail
    }) }; }
  };
  const h = setup({ storageDb }); h.P.playQueue([requested], 0); await flushMicrotasks(70);
  assert.equal(h.P.needsPlaybackGesture(), true);
  const source = h.audio.src;
  assert.match(source, /^blob:/);
  assert.equal(await (await fetch(source)).text(), 'audio');
  assert.equal(await (await h.P.getDownload(requested.id)).text(), 'audio');
  assert.deepEqual(h.resolves, []);
  h.audio.play = FakeAudio.prototype.play; h.P.toggle(); await flushMicrotasks(30);
  assert.equal(h.P.needsPlaybackGesture(), false); assert.equal(h.audio.src, source);
  h.P.dismiss(); URL.revokeObjectURL(source);
});

test('permission denial on an alternate upload stops trying more uploads', async () => {
  const h = setup(); let playCalls = 0;
  const alt = { ...requested, id: 'alternate' };
  h.Api.invalidate = () => {};
  h.Api.findVersions = async () => [alt, { ...requested, id: 'never' }];
  h.audio.play = () => {
    playCalls++;
    return Promise.reject(playCalls === 1 ? Object.assign(new Error('Unsupported audio'), { name: 'NotSupportedError' }) : denied());
  };
  h.P.playQueue([requested], 0); await flushMicrotasks(100);
  assert.equal(h.P.needsPlaybackGesture(), true);
  assert.equal(h.P.current().id, 'requested');
  assert.equal(h.resolves.includes('never'), false);
  assert.equal(h.events.some(e => e.type === 'track'), false);
  h.audio.play = FakeAudio.prototype.play; h.P.toggle(); await flushMicrotasks(30);
  assert.equal(h.P.current().id, 'alternate');
  assert.equal(h.events.filter(e => e.type === 'track').length, 1);
});

test('a late permission rejection cannot replace a new playback selection', async () => {
  const h = setup(); h.P.playQueue([requested], 0); await flushMicrotasks(70);
  let reject;
  h.audio.play = () => new Promise((resolve, fail) => { reject = fail; });
  h.P.toggle();
  h.audio.play = FakeAudio.prototype.play;
  h.P.playQueue([{ ...requested, id: 'new-selection' }], 0);
  reject(denied());
  await flushMicrotasks(70); h.runImmediateTimers(); await flushMicrotasks(30);
  assert.equal(h.P.current().id, 'new-selection');
  assert.equal(h.P.needsPlaybackGesture(), false);
  assert.equal(h.events.filter(e => e.type === 'playback-permission').length, 1);
});

test('permission recovery preserves the saved position of a podcast', async () => {
  const h = setup(); h.Store.getPosition = () => 90;
  h.P.playQueue([{ ...requested, kind: 'podcast', duration: 1200 }], 0);
  await flushMicrotasks(70);
  h.audio.play = FakeAudio.prototype.play; h.P.toggle(); await flushMicrotasks(30);
  assert.equal(h.audio.currentTime, 90);
  assert.deepEqual(h.resolves, ['requested']);
});
