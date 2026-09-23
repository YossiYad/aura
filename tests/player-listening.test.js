const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');
const { createStore } = require('./store-harness');

function setup(duration = 180, options = {}) {
  const h = createHarness({ exposeInternals: true,
    tracks: [{ id: 'song', title: 'Song', artist: 'Artist', duration }],
    settings: { autoplay: false, crossfade: 4 }, ...options });
  const store = createStore();
  h.Store.pushRecent = store.Store.pushRecent;
  h.audio.duration = duration;
  h.audio.currentTime = 0;
  h.play();
  h.window.__playerInternals.resetListenTracking(h.window.Player.current());
  return { ...h, store };
}

function listen(h, seconds) {
  for (let i = 0; i < seconds; i++) {
    h.audio.currentTime++;
    h.audio.dispatch('timeupdate');
  }
}

test('recents, play counts and recommendation history start at exactly one third, once per play', () => {
  const h = setup();
  listen(h, 59);
  assert.equal(h.store.Store.recents().length, 0);
  assert.equal(h.store.Store.topListeningTracks(10).length, 0);
  listen(h, 1);
  assert.equal(h.store.Store.recents()[0].id, 'song');
  assert.equal(h.store.Store.topListeningTracks(10)[0].id, 'song');
  listen(h, 30);
  assert.equal(h.store.read('aura.listeningProfile').tracks.song.plays, 1);
});

test('long songs require a full third rather than the old four-minute cap', () => {
  const h = setup(900);
  listen(h, 299);
  assert.equal(h.store.Store.recents().length, 0);
  listen(h, 1);
  assert.equal(h.store.Store.recents().length, 1);
});

test('unknown duration waits for metadata instead of counting after a fixed timeout', () => {
  const h = setup(0);
  listen(h, 70);
  assert.equal(h.store.Store.recents().length, 0);
  h.audio.duration = 300;
  listen(h, 29);
  assert.equal(h.store.Store.recents().length, 0);
  listen(h, 1);
  assert.equal(h.store.Store.recents().length, 1);
});

test('the playback duration sets the threshold when catalog metadata is stale', () => {
  const h = setup(180);
  h.audio.duration = 210;
  listen(h, 69);
  assert.equal(h.store.Store.recents().length, 0);
  listen(h, 1);
  assert.equal(h.store.Store.recents().length, 1);
});

test('short seeks and paused position updates do not count as listening', () => {
  const h = setup();
  listen(h, 55);
  for (let i = 0; i < 5; i++) {
    h.window.Player.seekTo(h.audio.currentTime + 2);
    h.audio.dispatch('timeupdate');
  }
  h.window.Player.pause();
  listen(h, 10);
  assert.equal(h.store.Store.recents().length, 0);
  h.play();
  listen(h, 5);
  assert.equal(h.store.Store.recents().length, 1);
});

test('seeking near the end and finishing cannot bypass the threshold', async () => {
  const h = setup();
  listen(h, 5);
  h.window.Player.seekTo(177);
  h.audio.dispatch('timeupdate');
  assert.equal(h.store.Store.recents().length, 0);
  listen(h, 3);
  h.audio.ended = true;
  h.audio.paused = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(60);
  assert.equal(h.store.Store.recents().length, 0);
});

test('restored playback near the end does not count the restored position', () => {
  const h = setup();
  h.audio.currentTime = 150;
  h.window.__playerInternals.resetListenTracking(h.window.Player.current());
  listen(h, 28);
  assert.equal(h.store.Store.recents().length, 0);
});

test('starting another track discards the previous partial listen', () => {
  const h = setup();
  listen(h, 59);
  h.window.Player.current().id = 'other';
  h.audio.currentTime = 0;
  h.window.__playerInternals.resetListenTracking(h.window.Player.current());
  listen(h, 1);
  assert.equal(h.store.Store.recents().length, 0);
  listen(h, 59);
  assert.equal(h.store.Store.recents()[0].id, 'other');
});

test('private listening stays out of history after reaching one third', () => {
  const h = setup();
  h.store.Store.setPrivateSession(true);
  listen(h, 65);
  assert.equal(h.store.Store.recents().length, 0);
  assert.equal(h.store.Store.topListeningTracks(10).length, 0);
});
