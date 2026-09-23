const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

const song = id => ({ id, title: id, artist: 'Artist', duration: 180 });
function setup(ids = ['a', 'b', 'c', 'd']) {
  const h = createHarness({ tracks: ids.map(song), withStorage: true,
    settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [] });
  h.Api.getSkipSegments = async () => [];
  return h;
}
const entries = h => Array.from(h.window.Player.queueHistory(), e => [e.track.id, e.status]);

test('queue history retains earlier songs and includes later manual additions', async () => {
  const h = setup();
  const p = h.window.Player;
  p.jumpTo(2);
  await flushMicrotasks(100);
  p.addToQueue(song('e'));
  assert.deepEqual(entries(h), [['a', 'earlier'], ['b', 'earlier'], ['c', 'current'], ['d', 'upcoming'], ['e', 'upcoming']]);
  p.dismiss();
});

test('replaying an earlier song preserves only the selected replay and existing upcoming tail', async () => {
  const h = setup();
  const p = h.window.Player;
  p.jumpTo(2);
  await flushMicrotasks(100);
  assert.equal(p.playFromQueueHistory('a'), true);
  await flushMicrotasks(100);
  assert.equal(p.current().id, 'a');
  assert.deepEqual(entries(h), [['b', 'earlier'], ['c', 'earlier'], ['a', 'current'], ['d', 'upcoming']]);
  assert.deepEqual(Array.from(p.queue().slice(p.pos() + 1), t => t.id), ['d']);
  await p.next();
  await flushMicrotasks(100);
  assert.equal(p.current().id, 'd');
  assert.deepEqual(entries(h), [['b', 'earlier'], ['c', 'earlier'], ['a', 'earlier'], ['d', 'current']]);
  p.dismiss();
});

test('cleared songs remain available for explicit replay without restoring the whole tail', async () => {
  const h = setup();
  const p = h.window.Player;
  p.clearUpcoming();
  assert.deepEqual(entries(h), [['a', 'current'], ['b', 'removed'], ['c', 'removed'], ['d', 'removed']]);
  assert.equal(p.playFromQueueHistory('c'), true);
  await flushMicrotasks(100);
  assert.equal(p.current().id, 'c');
  assert.deepEqual(Array.from(p.queue(), t => t.id), ['a', 'c']);
  p.dismiss();
});

test('new Home playback resets queue history while pause and resume retain it', async () => {
  const h = setup();
  const p = h.window.Player;
  h.play();
  await flushMicrotasks(100);
  p.pause();
  assert.equal(p.queueHistory().length, 4);
  h.play();
  await flushMicrotasks(100);
  assert.equal(p.queueHistory().length, 4);
  p.playQueue([song('new')]);
  await flushMicrotasks(100);
  assert.deepEqual(entries(h), [['new', 'current']]);
  p.dismiss();
  assert.equal(p.queueHistory().length, 0);
});

test('history playback respects blocked tracks and rejects stale selections', () => {
  const h = setup();
  const p = h.window.Player;
  h.Store.isBlocked = t => t.id === 'b';
  assert.equal(p.playFromQueueHistory('b'), false);
  assert.equal(p.playFromQueueHistory('missing'), false);
  assert.equal(p.current().id, 'a');
  p.dismiss();
});

test('automatic refills extend the same history and keep session exclusions after a manual replay', async () => {
  const h = setup(['seed']);
  const p = h.window.Player;
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  h.Api.resolve = async id => ({ url: 'https://test/' + id,
    related: Array.from({ length: 40 }, (_, i) => song('pool' + i)) });
  h.play();
  await flushMicrotasks(100);
  assert.equal(p.queueHistory().length, 13);
  for (let i = 0; i < 9; i++) {
    await p.next();
    await flushMicrotasks(100);
  }
  assert.equal(p.queueHistory().length, 22);
  p.playFromQueueHistory('seed');
  await flushMicrotasks(100);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  const before = new Set(Array.from(p.queueHistory(), e => e.track.id));
  for (let i = 0; i < 9; i++) {
    await p.next();
    await flushMicrotasks(100);
  }
  const ids = Array.from(p.queueHistory(), e => e.track.id);
  assert.equal(ids.length, 31);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.slice(22).some(id => before.has(id)), false);
  p.dismiss();
});

test('history replay under shuffle preserves all remaining songs', async () => {
  const h = setup();
  const p = h.window.Player;
  p.setShuffle(true);
  h.play();
  await flushMicrotasks(100);
  await p.next();
  await flushMicrotasks(100);
  const upcoming = Array.from(p.queueHistory().filter(e => e.status === 'upcoming'), e => e.track.id).sort();
  p.playFromQueueHistory('a');
  await flushMicrotasks(100);
  assert.equal(p.current().id, 'a');
  assert.deepEqual(Array.from(p.queueHistory().filter(e => e.status === 'upcoming'), e => e.track.id).sort(), upcoming);
  p.dismiss();
});

test('history follows reordered upcoming songs and play-next insertions', async () => {
  const h = setup();
  const p = h.window.Player;
  p.moveAt(3, 1);
  p.playNext(song('e'));
  assert.deepEqual(entries(h), [['a', 'current'], ['e', 'upcoming'], ['d', 'upcoming'], ['b', 'upcoming'], ['c', 'upcoming']]);
  for (const id of ['e', 'd', 'b', 'c']) {
    await p.next();
    await flushMicrotasks(100);
    assert.equal(p.current().id, id);
  }
  assert.deepEqual(entries(h), [['a', 'earlier'], ['e', 'earlier'], ['d', 'earlier'], ['b', 'earlier'], ['c', 'current']]);
  p.dismiss();
});

test('shuffled history puts earlier songs before current and matches subsequent playback', async () => {
  const h = setup();
  const p = h.window.Player;
  p.setShuffle(true);
  // Establish a known shuffle order that differs from the archive's insertion order.
  p.playNext(song('d'));
  p.playNext(song('c'));
  await p.next();
  await flushMicrotasks(100);
  await p.next();
  await flushMicrotasks(100);
  assert.deepEqual(entries(h), [['a', 'earlier'], ['c', 'earlier'], ['d', 'current'], ['b', 'upcoming']]);
  await p.next();
  await flushMicrotasks(100);
  assert.deepEqual(entries(h), [['a', 'earlier'], ['c', 'earlier'], ['d', 'earlier'], ['b', 'current']]);
  p.dismiss();
});

test('restored shuffle history keeps upcoming songs after a current song at the end of the stored queue', async () => {
  const h = setup();
  const p = h.window.Player;
  h.Store.loadQueue = () => ({ extra: ['a', 'b', 'c', 'd'].map(song), pos: 3, shuffle: true });
  p.restore();
  const rows = entries(h);
  assert.deepEqual(rows[0], ['d', 'current']);
  assert.equal(rows.slice(1).every(([, status]) => status === 'upcoming'), true);
  for (const [id] of rows.slice(1)) {
    await p.next();
    await flushMicrotasks(100);
    assert.equal(p.current().id, id);
  }
  p.dismiss();
});

test('removed songs stay after the running queue and replay returns them to playback order', async () => {
  const h = setup();
  const p = h.window.Player;
  p.removeAt(1);
  assert.deepEqual(entries(h), [['a', 'current'], ['c', 'upcoming'], ['d', 'upcoming'], ['b', 'removed']]);
  p.playFromQueueHistory('b');
  await flushMicrotasks(100);
  assert.deepEqual(entries(h), [['a', 'earlier'], ['b', 'current'], ['c', 'upcoming'], ['d', 'upcoming']]);
  p.dismiss();
});
