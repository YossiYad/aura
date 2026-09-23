const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

function setup(ids, pos = 0) {
  const h = createHarness({
    tracks: ids.map(id => ({ id, title: id })), pos, withStorage: true,
    settings: { autoplay: false, noYtFallback: true }
  });
  h.resolved = [];
  h.Api.resolve = async id => {
    h.resolved.push(id);
    return { url: 'https://test/' + id };
  };
  h.Api.getSkipSegments = async () => [];
  return h;
}

function sharedSetup() {
  const h = setup(['personal', 'personal-next']);
  let saved = null;
  h.Store.sharedQueuePlayback = value => {
    if (value !== undefined) saved = value;
    return saved;
  };
  h.window.Player.beginShare('room');
  return h;
}

test('ordered playlist playback replaces inherited shuffle and persists the selected position', async () => {
  const h = setup(['old', 'old-next']);
  const player = h.window.Player;
  player.setShuffle(true);
  player.playQueue(['a', 'b', 'c', 'd'].map(id => ({ id })), 1, { shuffle: false });
  await flushMicrotasks(80);
  assert.equal(player.shuffle(), false);
  assert.equal(player.current().id, 'b');
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), ['c', 'd']);
  assert.equal(h.savedQueues.at(-1).shuffle, false);
  assert.deepEqual(Array.from(h.savedQueues.at(-1).shuffleOrder), []);
  await player.next();
  await flushMicrotasks(80);
  assert.equal(player.current().id, 'c');
  player.dismiss();
});

test('ordinary selections keep shuffle and a rejected playlist cannot change it', () => {
  const h = setup(['old', 'old-next']);
  const player = h.window.Player;
  player.setShuffle(true);
  h.Store.isBlocked = t => t.id === 'blocked';
  assert.equal(player.playQueue([{ id: 'blocked' }], 0, { shuffle: false }), false);
  assert.equal(player.current().id, 'old');
  assert.equal(player.shuffle(), true);
  player.playQueue([{ id: 'a' }, { id: 'b' }], 0);
  assert.equal(player.shuffle(), true);
  player.dismiss();
});

test('playlist playback options still contribute to an active shared queue', async () => {
  const h = sharedSetup(), player = h.window.Player;
  player.addToQueue({ id: 'guest', duration: 180 });
  await flushMicrotasks(80);
  player.playQueue(['a', 'b', 'c'].map(id => ({ id })), 1, { shuffle: false });
  assert.equal(player.current().id, 'guest');
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), ['b', 'c']);
  player.endShare();
});

test('AuraShare starts silent and restores the separate personal queue on close', async () => {
  const h = sharedSetup(), player = h.window.Player;
  assert.equal(player.current(), null);
  assert.equal(player.queue().length, 0);
  assert.equal(player.playbackRequested(), false);
  assert.equal(h.resolved.length, 0);
  player.addToQueue({ id: 'guest', title: 'Guest song', duration: 180 });
  await flushMicrotasks(80);
  assert.equal(player.current().id, 'guest');
  assert.equal(h.audio.paused, false);
  assert.equal(h.savedQueues.length, 0);
  player.endShare();
  assert.deepEqual(Array.from(player.queue(), t => t.id), ['personal', 'personal-next']);
  assert.equal(player.playbackRequested(), false);
  assert.equal(player.shareSession(), '');
  player.dismiss();
});

test('AuraShare keeps its own position note so the personal song resumes where it paused', async () => {
  const h = setup(['personal', 'personal-next']), player = h.window.Player;
  let saved = null;
  h.Store.sharedQueuePlayback = value => { if (value !== undefined) saved = value; return saved; };
  for (const audio of h.audioElements) {
    let source = audio.src;
    Object.defineProperty(audio, 'src', { get: () => source, set(value) { source = value; this.currentTime = 0; } });
    const play = audio.play;
    audio.play = function () { const result = play.call(this); this.dispatch('playing'); return result; };
  }
  h.play();
  await flushMicrotasks(80);
  h.audio.currentTime = 47;
  player.beginShare('room');
  assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'personal', at: 47 });
  player.addToQueue({ id: 'guest', title: 'Guest song', duration: 180 });
  await flushMicrotasks(80);
  h.audio.currentTime = 20;
  player.pause();
  assert.deepEqual(JSON.parse(h.savedLocal.get('aura.shareQueueAt')), { id: 'guest', at: 20 });
  assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'personal', at: 47 });
  // Reloading the controlling tab returns to the shared song at its own place.
  player.endShare();
  h.savedLocal.set('aura.shareQueueAt', JSON.stringify({ id: 'guest', at: 20 }));
  saved = { id: 'room', extra: [{ id: 'guest', title: 'Guest song', duration: 180 }], pos: 0 };
  player.beginShare('room');
  h.play();
  await flushMicrotasks(80);
  assert.equal(player.current().id, 'guest');
  assert.equal(h.audio.currentTime, 20);
  player.endShare();
  assert.equal(h.savedLocal.has('aura.shareQueueAt'), false);
  assert.equal(player.current().id, 'personal');
  h.play();
  await flushMicrotasks(80);
  assert.equal(h.audio.currentTime, 47);
  player.dismiss();
});

test('AuraShare fills with just one song at each exhaustion even with personal autoplay off', async () => {
  const h = sharedSetup(), player = h.window.Player;
  let sequence = 0;
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [1, 2, 3].map(() => ({ id: 'related-' + ++sequence, title: 'Related', duration: 180 })) });
  player.addToQueue({ id: 'guest', duration: 180 });
  await flushMicrotasks(80);
  assert.equal(player.queue().length, 1, 'No eager radio tail');
  await player.next();
  await flushMicrotasks(80);
  assert.equal(player.queue().length, 2);
  assert.equal(player.current().auraShareAuto, true);
  assert.equal(player.upcoming().length, 0);
  await player.next();
  await flushMicrotasks(80);
  assert.equal(player.queue().length, 3);
  assert.equal(player.upcoming().length, 0);
  player.endShare();
});

test('a contribution wins over a late AuraShare recommendation without skipping it', async () => {
  const h = sharedSetup(), player = h.window.Player;
  player.addToQueue({ id: 'guest', duration: 180 });
  await flushMicrotasks(80);
  let release;
  h.Api.resolve = id => id === 'guest' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ url: 'https://test/' + id });
  const advancing = player.next();
  player.addToQueue({ id: 'friend', duration: 180 });
  release({ related: [{ id: 'automatic', duration: 180 }] });
  await advancing;
  await flushMicrotasks(80);
  assert.equal(player.current().id, 'friend');
  assert.deepEqual(Array.from(player.queue(), t => t.id), ['guest', 'friend']);
  player.endShare();
});

test('an explicit pause during AuraShare refill stays paused when a guest adds music', async () => {
  const h = sharedSetup(), player = h.window.Player;
  player.addToQueue({ id: 'guest', duration: 180 });
  await flushMicrotasks(80);
  let release;
  h.Api.resolve = () => new Promise(resolve => { release = resolve; });
  const advancing = player.next();
  player.pause();
  player.addToQueue({ id: 'friend', duration: 180 });
  release({ related: [{ id: 'automatic', duration: 180 }] });
  await advancing;
  assert.equal(player.current().id, 'guest');
  assert.equal(player.playbackRequested(), false);
  assert.equal(h.audio.paused, true);
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), ['friend']);
  player.endShare();
});

test('play next takes priority over the existing shuffle order', async () => {
  const h = setup(['a', 'b']);
  const player = h.window.Player;
  player.setShuffle(true);
  player.playNext({ id: 'requested', title: 'Requested' });
  await player.next();
  await flushMicrotasks(60);
  assert.equal(player.current().id, 'requested');
  await player.next();
  await flushMicrotasks(60);
  assert.equal(player.current().id, 'b');
  player.dismiss();
});

test('moving an already queued song to play next also updates shuffle order', async () => {
  const h = setup(['a', 'b']);
  const player = h.window.Player;
  player.setShuffle(true);
  player.addToQueue({ id: 'c', title: 'C' });
  player.playNext({ id: 'c', title: 'C' });
  await player.next();
  await flushMicrotasks(60);
  assert.equal(player.current().id, 'c');
  assert.deepEqual(Array.from(player.queue(), track => track.id), ['a', 'c', 'b']);
  player.dismiss();
});

test('inserting a next song preserves the identity of previously played tracks', async () => {
  const h = setup(['a', 'b', 'c']);
  const player = h.window.Player;
  player.jumpTo(2);
  await flushMicrotasks(60);
  player.jumpTo(0);
  await flushMicrotasks(60);
  player.playNext({ id: 'new', title: 'New' });
  player.seekTo(0);
  player.prev();
  assert.equal(player.current().id, 'c');
  await flushMicrotasks(60);
  player.dismiss();
});

test('shuffle prepares the next song when playing the last physical queue entry', async () => {
  const h = setup(['a', 'b'], 1);
  h.window.Player.setShuffle(true);
  h.play();
  await flushMicrotasks(60);
  assert.deepEqual(h.resolved, ['a']);
  assert.equal(h.audioElements[1].src, 'https://test/a');
  h.window.Player.dismiss();
});

test('moving an upcoming song preserves playback history after jumping backward', async () => {
  const h = setup(['a', 'b', 'c']);
  const player = h.window.Player;
  player.jumpTo(2);
  await flushMicrotasks(60);
  player.jumpTo(0);
  await flushMicrotasks(60);
  player.moveAt(2, 1);
  player.seekTo(0);
  player.prev();
  assert.equal(player.current().id, 'c');
  player.dismiss();
});

test('clearing a playing queue stops sound and removes media metadata', async () => {
  const h = setup(['a']);
  h.play();
  await flushMicrotasks(60);
  h.window.Player.playQueue([]);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.navigator.mediaSession.metadata, null);
});

test('play next does not duplicate the currently playing song', () => {
  const h = setup(['a', 'b']);
  h.window.Player.playNext({ id: 'a' });
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['a', 'b']);
});

test('invalid jump indices leave the current song and queue intact', () => {
  const h = setup(['a', 'b']);
  for (const index of [NaN, 0.5, '1', undefined]) {
    assert.equal(h.window.Player.jumpTo(index), false);
    assert.equal(h.window.Player.current().id, 'a');
  }
});

test('a pending end-of-queue advance cannot skip a newly selected queue', async () => {
  const h = setup(['a']);
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  let resolve;
  h.Api.resolve = id => id === 'a' ? new Promise(r => { resolve = r; }) : Promise.resolve({ url: 'https://test/' + id });
  const advancing = h.window.Player.next();
  h.window.Player.playQueue([{ id: 'new' }, { id: 'tail' }]);
  await flushMicrotasks(60);
  resolve({ related: [{ id: 'old-radio', duration: 120 }] });
  await advancing;
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'new');
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['new', 'tail']);
  h.window.Player.dismiss();
});

test('previous skips tracks blocked since they were played', async () => {
  const h = setup(['a', 'b', 'c']);
  const player = h.window.Player;
  player.jumpTo(1);
  await flushMicrotasks(60);
  player.jumpTo(2);
  await flushMicrotasks(60);
  h.Store.isBlocked = t => t && t.id === 'b';
  player.seekTo(0);
  player.prev();
  assert.equal(player.current().id, 'a');
  player.dismiss();
});

test('radio does not duplicate a track manually queued while recommendations load', async () => {
  const h = setup(['a']);
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  let resolve;
  h.Api.resolve = id => id === 'a' ? new Promise(r => { resolve = r; }) : Promise.resolve({ url: 'https://test/' + id });
  const advancing = h.window.Player.next();
  h.window.Player.addToQueue({ id: 'requested', duration: 120 });
  resolve({ related: ['requested', 'radio1', 'radio2'].map(id => ({ id, duration: 120 })) });
  await advancing;
  await flushMicrotasks(60);
  const ids = Array.from(h.window.Player.queue(), t => t.id);
  assert.equal(ids.filter(id => id === 'requested').length, 1);
  h.window.Player.dismiss();
});

test('streaming still works when browser storage is unavailable', async () => {
  const h = createHarness({ settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async () => ({ url: 'https://test/stream' });
  h.Api.getSkipSegments = async () => [];
  h.window.Player.playQueue([{ id: 'stream' }]);
  await flushMicrotasks(80);
  assert.equal(h.audio.src, 'https://test/stream');
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});

test('ending the queue releases playback intent so idle work can run', async () => {
  const h = setup(['a']);
  h.play();
  await flushMicrotasks(60);
  h.audio.currentTime = h.audio.duration;
  h.audio.ended = true;
  h.audio.paused = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(60);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.window.Player.current().id, 'a');
  h.window.Player.dismiss();
});

test('pausing while an end-of-queue lookup is pending prevents a late restart', async () => {
  const h = setup(['a']);
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  let resolve;
  h.Api.resolve = id => id === 'a' ? new Promise(r => { resolve = r; }) : Promise.resolve({ url: 'https://test/' + id });
  const advancing = h.window.Player.next();
  h.window.Player.pause();
  resolve({ related: ['b', 'c', 'd'].map(id => ({ id, duration: 120 })) });
  await advancing;
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'a');
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.audio.paused, true);
  h.window.Player.dismiss();
});

test('restoring a queue skips a song that was blocked after it was saved', () => {
  const h = setup(['a', 'b']);
  h.window.Player.dismiss();
  h.Store.isBlocked = track => track && track.id === 'a';
  h.window.Player.restore();
  assert.equal(h.window.Player.current().id, 'b');
  assert.equal(h.window.Player.pos(), 1);
});

test('restoring a damaged queue retains the selected valid song', () => {
  const h = setup(['a']);
  h.window.Player.dismiss();
  h.Store.loadQueue = () => ({ extra: [null, { id: 'a' }, { id: 'b' }, {}], pos: 2 });
  h.window.Player.restore();
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['a', 'b']);
  assert.equal(h.window.Player.current().id, 'b');
  assert.equal(h.window.Player.pos(), 1);
});

test('restoring an entirely blocked queue leaves playback empty', () => {
  const h = setup(['a']);
  h.window.Player.dismiss();
  h.Store.isBlocked = () => true;
  h.window.Player.restore();
  assert.equal(h.window.Player.current(), null);
  assert.equal(h.window.Player.queue().length, 0);
});

test('replacing the playing upload keeps its slot in the shuffle order', async () => {
  const h = setup(['a', 'b', 'c', 'd']);
  const player = h.window.Player;
  player.setShuffle(true);
  const before = Array.from(player.upcoming(), t => t.id);
  assert.deepEqual(before.slice().sort(), ['b', 'c', 'd']);
  player.replaceCurrent({ id: 'a2', title: 'a2' });
  await flushMicrotasks(80);
  h.audio.dispatch('playing');
  await flushMicrotasks(40);
  assert.equal(player.current().id, 'a2');
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), before, 'the rest of the pass is still to come');
  await player.next();
  await flushMicrotasks(80);
  assert.equal(player.current().id, before[0]);
  player.dismiss();
});

// The browser can close the IndexedDB connection behind the page's back; the next
// transaction on it throws. That is "nothing stored", not a failed track.
test('a storage connection closed by the browser does not fail the track', async () => {
  let closed = false;
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction() {
      if (closed) throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
      return { objectStore: () => ({ get: () => ({ set onsuccess(fn) { Promise.resolve().then(fn); }, result: null }) }) };
    }
  };
  const h = createHarness({ tracks: [{ id: 'a' }, { id: 'b' }], pos: 0, withStorage: true, storageDb,
    settings: { autoplay: false, noYtFallback: true } });
  h.resolved = [];
  h.Api.resolve = async id => { h.resolved.push(id); return { url: 'https://test/' + id }; };
  h.Api.getSkipSegments = async () => [];
  closed = true;
  h.play();
  await flushMicrotasks(40);
  await h.window.Player.next();
  await flushMicrotasks(80);
  assert.equal(h.window.Player.current().id, 'b');
  assert.equal(h.window.Player.playbackRequested(), true);
  assert(h.audioElements.some(el => el.src === 'https://test/b'), 'playback streams when the stored copy cannot be read');
  h.window.Player.dismiss();
});
