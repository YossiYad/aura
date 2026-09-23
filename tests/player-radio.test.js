const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

const song = (id, artist = 'Seed artist') => ({ id, title: id, artist, duration: 180 });
const songs = (prefix, count, artist) => Array.from({ length: count }, (_, i) => song(prefix + i, artist));

function setup(tracks = [song('seed')]) {
  const h = createHarness({ tracks, exposeInternals: true, withStorage: true,
    settings: { autoplay: true, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [] });
  h.Api.getSkipSegments = async () => [];
  return h;
}

test('an ordered playlist plays from the selected song and hands off to the existing radio refill', async () => {
  const h = setup();
  const player = h.window.Player;
  const playlist = songs('playlist', 8);
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [...playlist, ...songs('related', 30)] });
  player.setShuffle(true);
  player.playQueue(playlist, 2, { shuffle: false });
  await flushMicrotasks(100);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.equal(player.current().id, 'playlist2');
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), playlist.slice(3).map(t => t.id));
  await player.next();
  await flushMicrotasks(100);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.equal(player.current().id, 'playlist3');
  assert.equal(player.queue().length, 8, 'Four upcoming songs do not trigger refill');
  await player.next();
  await flushMicrotasks(100);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.equal(player.current().id, 'playlist4');
  assert.equal(player.upcoming().length, 12);
  assert.deepEqual(Array.from(player.queue().slice(0, 8), t => t.id), playlist.map(t => t.id));
  for (const expected of ['playlist5', 'playlist6', 'playlist7', 'related0']) {
    await player.next();
    await flushMicrotasks(100);
    h.runImmediateTimers();
    await flushMicrotasks(100);
    assert.equal(player.current().id, expected);
  }
  const ids = Array.from(player.queue(), t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  player.dismiss();
});

test('three related songs do not stop the search for a full twelve-song tail', async () => {
  const h = setup();
  const queries = [];
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed' ? songs('related', 3) : [] });
  h.Api.search = async query => { queries.push(query); return { items: songs('search', 12) }; };
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  assert.deepEqual(queries, ['Seed artist']);
  assert.equal(h.window.Player.current().id, 'seed');
  h.window.Player.dismiss();
});

test('a short existing Home queue is topped up while preserving its order', async () => {
  const h = setup([song('seed'), ...songs('existing', 3)]);
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed' ? songs('related', 20) : [] });
  h.play();
  await flushMicrotasks(100);
  const ids = Array.from(h.window.Player.queue(), t => t.id);
  assert.equal(ids.length, 13);
  assert.deepEqual(ids.slice(0, 4), ['seed', 'existing0', 'existing1', 'existing2']);
  h.window.Player.dismiss();
});

test('playback refills at three upcoming songs, without fetching while four remain', async () => {
  const h = setup([song('seed'), ...songs('existing', 4)]);
  const resolved = [];
  h.Api.resolve = async id => {
    resolved.push(id);
    return { url: 'https://test/' + id, related: songs('related', 20) };
  };
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 5);
  assert.equal(resolved.includes('seed'), false);
  await h.window.Player.next();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.current().id, 'existing0');
  assert.equal(h.window.Player.queue().length - h.window.Player.pos() - 1, 12);
  assert.deepEqual(Array.from(h.window.Player.queue().slice(2, 5), t => t.id), ['existing1', 'existing2', 'existing3']);
  h.window.Player.dismiss();
});

test('shuffle refills according to remaining playback order, regardless of physical position', async () => {
  const h = setup(songs('original', 16));
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: songs('related', 20) });
  h.window.Player.setShuffle(true);
  h.play();
  await flushMicrotasks(100);
  for (let i = 0; i < 11; i++) {
    await h.window.Player.next();
    await flushMicrotasks(100);
    assert.equal(h.window.Player.queue().length, 16);
  }
  await h.window.Player.next();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 25);
  h.window.Player.dismiss();
});

test('related discoveries are mixed with familiar music even when favorites are available', async () => {
  const h = setup();
  h.Store.likedTracks = () => songs('liked', 12, 'Favorite artist');
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed'
    ? [...songs('new', 8, 'Similar new artist'), ...songs('liked', 12, 'Favorite artist')] : [] });
  h.play();
  await flushMicrotasks(100);
  const ids = Array.from(h.window.Player.queue().slice(1), t => t.id);
  assert.equal(ids.length, 12);
  assert.equal(ids.filter(id => id.startsWith('new')).length, 3);
  assert.equal(ids.filter(id => id.startsWith('liked')).length, 9);
  assert.deepEqual(ids.slice(0, 4), ['liked0', 'liked1', 'liked2', 'new0']);
  h.window.Player.dismiss();
});

test('a new listener can discover a full tail from the selected song', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed' ? songs('new', 15, 'New artist') : [] });
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  h.window.Player.dismiss();
});

test('saved music fills sparse results and blocked tracks and spoken word stay out', async () => {
  const h = setup();
  h.Store.likedTracks = () => [song('blocked'), { ...song('podcast'), kind: 'podcast' }, ...songs('liked', 12)];
  h.Store.isBlocked = t => t.id === 'blocked';
  h.play();
  await flushMicrotasks(100);
  assert.deepEqual(Array.from(h.window.Player.queue().slice(1), t => t.id), songs('liked', 12).map(t => t.id));
  h.window.Player.dismiss();
});

test('unrelated artist search matches cannot enter the tail as discoveries', async () => {
  const h = setup();
  h.Api.search = async () => ({ items: [song('unrelated', 'Other artist'), ...songs('match', 12)] });
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  assert.equal(h.window.Player.queue().some(t => t.id === 'unrelated'), false);
  h.window.Player.dismiss();
});

test('the first batch is ready before slow follow-up search and clearing cancels the rest', async () => {
  const h = setup();
  let release;
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed' ? songs('related', 3) : [] });
  h.Api.search = () => new Promise(resolve => { release = resolve; });
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 4);
  assert.equal(h.audioElements[1].src, 'https://test/related0');
  h.window.Player.clearUpcoming();
  release({ items: songs('late', 12) });
  await flushMicrotasks(100);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['seed']);
  h.window.Player.dismiss();
});

test('manual additions during lookup count toward the twelve upcoming songs', async () => {
  const h = setup();
  let release;
  h.Api.resolve = id => id === 'seed' ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ url: 'https://test/' + id, related: [] });
  h.play();
  await flushMicrotasks(60);
  h.window.Player.addToQueue(song('manual'));
  release({ related: [song('manual'), ...songs('related', 20)] });
  await flushMicrotasks(100);
  const ids = Array.from(h.window.Player.queue(), t => t.id);
  assert.equal(ids.length, 13);
  assert.equal(ids[1], 'manual');
  assert.equal(new Set(ids).size, ids.length);
  h.window.Player.dismiss();
});

test('podcast continuation stays within the same show', async () => {
  const h = setup([{ ...song('seed', 'My show'), kind: 'podcast' }]);
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed'
    ? [song('other', 'Other show'), ...songs('episode', 12, 'My show').map(t => ({ ...t, kind: 'podcast', duration: 1800 }))] : [] });
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  assert.equal(h.window.Player.queue().every(t => t.artist === 'My show'), true);
  h.window.Player.dismiss();
});

test('successive refills choose fresh songs from overlapping provider results', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: songs('pool', 40) });
  h.play();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  for (let batch = 0; batch < 2; batch++) {
    for (let i = 0; i < 9; i++) {
      await h.window.Player.next();
      await flushMicrotasks(100);
    }
    const ids = Array.from(h.window.Player.queue(), t => t.id);
    assert.equal(ids.length, 13 + (batch + 1) * 9);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length - h.window.Player.pos() - 1, 12);
  }
  h.window.Player.dismiss();
});

test('clearing a generated tail does not allow those songs back into the same session', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: songs('pool', 30) });
  h.play();
  await flushMicrotasks(100);
  const firstTail = new Set(Array.from(h.window.Player.queue().slice(1), t => t.id));
  h.window.Player.clearUpcoming();
  h.window.__playerInternals.prefetchNext();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  assert.equal(h.window.Player.queue().slice(1).some(t => firstTail.has(t.id)), false);
  h.window.Player.dismiss();
});

test('removing a played song does not let radio recommend it again', async () => {
  const h = setup([song('heard'), song('seed')]);
  h.Store.settings = () => ({ autoplay: false, noYtFallback: true });
  h.window.Player.jumpTo(1);
  await flushMicrotasks(100);
  h.window.Player.removeAt(0);
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [song('heard'), ...songs('new', 12)] });
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  h.window.__playerInternals.prefetchNext();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.queue().length, 13);
  assert.equal(h.window.Player.queue().some(t => t.id === 'heard'), false);
  h.window.Player.dismiss();
});

test('alternate uploads of the same song are excluded while distinct versions stay eligible', async () => {
  const h = setup([song('original', 'Favorite - Topic')]);
  const original = { ...song('original', 'Favorite - Topic'), title: 'A Song (Official Audio)' };
  h.Store.loadQueue = () => ({ extra: [original], pos: 0 });
  h.window.Player.restore();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [
    { ...song('duplicate', 'Favorite'), title: 'A Song (Official Video)' },
    { ...song('live', 'Favorite'), title: 'A Song (Live)' },
    ...songs('new', 12, 'Favorite')
  ] });
  h.play();
  await flushMicrotasks(100);
  const ids = Array.from(h.window.Player.queue(), t => t.id);
  assert.equal(ids.includes('duplicate'), false);
  assert.equal(ids.includes('live'), true);
  h.window.Player.dismiss();
});

test('a new Home selection resets session exclusions even when the old songs are in recents', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: songs('pool', 20) });
  h.play();
  await flushMicrotasks(100);
  const firstTail = Array.from(h.window.Player.queue().slice(1), t => t.id);
  h.Store.recents = () => songs('pool', 12);
  h.window.Player.playQueue([song('seed')]);
  await flushMicrotasks(100);
  h.runImmediateTimers();
  await flushMicrotasks(100);
  assert.deepEqual(Array.from(h.window.Player.queue().slice(1), t => t.id), firstTail);
  h.window.Player.dismiss();
});

test('radio exclusions are absent from persisted queue data', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: songs('pool', 12) });
  h.play();
  await flushMicrotasks(100);
  h.window.Player.clearUpcoming();
  const saved = h.savedQueues.at(-1);
  // shuffleOrder is deliberately persisted so a restart keeps the shuffle order.
  assert.deepEqual(Object.keys(saved).sort(), ['extra', 'pos', 'repeat', 'shuffle', 'shuffleOrder']);
  // With shuffle off it must stay empty, so no excluded radio ids can ride along in it.
  assert.deepEqual(Array.from(saved.shuffleOrder), []);
  assert.deepEqual(Array.from(saved.extra, t => t.id), ['seed']);
  const reopened = setup(saved.extra);
  reopened.Api.resolve = h.Api.resolve;
  reopened.play();
  await flushMicrotasks(100);
  assert.equal(reopened.window.Player.queue().length, 13);
  reopened.window.Player.dismiss();
  h.window.Player.dismiss();
});

test('exhausted radio stops instead of automatically looping over heard songs', async () => {
  const h = setup([song('heard'), song('seed')]);
  h.Store.settings = () => ({ autoplay: false, noYtFallback: true });
  h.window.Player.jumpTo(1);
  await flushMicrotasks(100);
  h.Store.settings = () => ({ autoplay: true, noYtFallback: true });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: [song('heard'), song('seed')] });
  h.Api.search = async () => ({ items: [song('heard'), song('seed')] });
  const events = [];
  h.window.Player.onChange(ev => events.push(ev.type));
  await h.window.__playerInternals.next(true);
  assert.equal(h.window.Player.current().id, 'seed');
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(events.includes('queue-end'), true);
  h.window.Player.dismiss();
});

test('pausing during a slow refill prevents a late playback restart', async () => {
  const h = setup();
  let release;
  h.Api.resolve = id => id === 'seed' ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ url: 'https://test/' + id, related: [] });
  h.play();
  await flushMicrotasks(60);
  const advancing = h.window.__playerInternals.next(true);
  h.runTimers(1200);
  await flushMicrotasks(60);
  h.window.Player.pause();
  release({ related: songs('fresh', 12) });
  await advancing;
  await flushMicrotasks(100);
  assert.equal(h.window.Player.current().id, 'seed');
  assert.equal(h.window.Player.playbackRequested(), false);
  h.window.Player.dismiss();
});

test('podcast continuation excludes music and different shows on the same publisher', async () => {
  const h = setup([{ ...song('seed', 'Publisher'), kind: 'podcast', podcast: 'Science Hour' }]);
  h.Api.resolve = async id => ({ url: 'https://test/' + id, related: id === 'seed' ? [
    song('music', 'Publisher'),
    { ...song('other', 'Publisher'), kind: 'podcast', podcast: 'Other Show', duration: 1800 },
    { ...song('next', 'Publisher'), kind: 'podcast', podcast: 'Science Hour', duration: 1800 }
  ] : [] });
  h.Api.search = async () => ({ items: [] });
  h.play();
  await flushMicrotasks(100);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['seed', 'next']);
});
