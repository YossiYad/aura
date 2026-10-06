const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

// Recovery paths the player takes when a source goes bad: each of these once lost the
// song, the position or the retry that the path exists to provide.

const stubApi = (h, resolve) => {
  h.Api.resolve = resolve;
  h.Api.invalidate = () => {};
  h.Api.findVersions = async () => [];
  h.Api.getSkipSegments = async () => [];
  h.Api.fetchStreamBlob = async () => { throw new Error('no'); };
};
const eventsOf = h => {
  const events = [];
  h.window.Player.onChange(ev => { if (!['state', 'time', 'queue', 'downloads'].includes(ev.type)) events.push(ev.type + (ev.track ? ':' + ev.track.id : '')); });
  return events;
};
const req = result => { const r = { result }; Promise.resolve().then(() => { if (r.onsuccess) r.onsuccess(); }); return r; };

// The YouTube iframe starts a video from the top unless told otherwise, and
// finishTrackStart seeks only the audio element, so a podcast's saved position was
// logged as "resuming" and then dropped on the fallback.
test('the YouTube fallback starts a podcast from its saved position', async () => {
  const episode = { id: 'ep1', title: 'Ep', artist: 'Show', duration: 3600, kind: 'podcast' };
  const h = createHarness({ tracks: [episode], withYt: true, withStorage: true, settings: { autoplay: false, rememberPosition: true } });
  h.Store.getPosition = () => 900;
  h.Store.savePosition = () => {};
  stubApi(h, async () => { throw new Error('no source'); });
  h.window.Player.restore();
  h.audio.src = '';
  h.play();
  await flushMicrotasks(200);
  const yt = h.ytPlayer();
  assert.ok(yt, 'the iframe took over');
  assert.equal(yt.loadRequest.videoId, 'ep1');
  assert.equal(yt.loadRequest.startSeconds, 900);
});

// A download the decoder refused is deleted before the stream is tried. The delete
// failing (quota, a closing connection) used to skip the stream and send the song to
// the YouTube fallback, ads and all, with nothing in the log about the delete.
test('a failed download delete still retries the stream after an element error', async () => {
  const song = { id: 's1', title: 'S', artist: 'A', duration: 180 };
  const blob = new Blob([new Uint8Array(1024)], { type: 'audio/mpeg' });
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name, mode) {
      if (name === 'tracks' && mode === 'readwrite') {
        const tx = { error: new Error('quota'), objectStore: () => ({ delete: () => ({}), put: () => ({}) }) };
        Promise.resolve().then(() => { if (tx.onerror) tx.onerror(); });
        return tx;
      }
      return { objectStore: () => ({ get: id => req(name === 'tracks' && id === 's1' ? blob : null), getAllKeys: () => req([]), delete: () => req(null) }) };
    }
  };
  const h = createHarness({ tracks: [song], withStorage: true, storageDb, withYt: true, settings: { autoplay: false } });
  let resolves = 0;
  stubApi(h, async id => { resolves++; return { url: 'https://stream/' + id, related: [] }; });
  h.Store.forgetDownload = () => {};
  const events = eventsOf(h);
  h.audio.src = '';
  h.play();
  await flushMicrotasks(100);
  h.audio.dispatch('playing');
  await flushMicrotasks(100);
  assert.match(h.audio.src, /^blob:/, 'playing from the download');
  h.audio.error = { code: 3 };
  h.audio.dispatch('error');
  await flushMicrotasks(300);
  assert.equal(resolves, 1, 'the stream was asked for');
  assert.equal(h.audio.src, 'https://stream/s1');
  assert.ok(!h.ytPlayer(), 'no YouTube fallback');
  assert.ok(!events.includes('fallback-yt:s1'), events.join(' '));
  assert.ok(h.logs.some(l => /could not remove local download/.test(l.message)), 'the failed delete is logged');
});

// The same for a cached copy refused while loadAndPlay starts it: the delete threw
// (the connection was closing) and the throw skipped the stream, failed the track
// and moved on.
test('a cache delete that throws does not fail the track before the stream is tried', async () => {
  const song = { id: 'c1', title: 'C', artist: 'A', duration: 180 };
  const blob = new Blob([new Uint8Array(1024)], { type: 'audio/mpeg' });
  let closing = false;
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name) {
      if (closing) { const e = new Error('connection is closing'); e.name = 'InvalidStateError'; throw e; }
      return { objectStore: () => ({
        get: id => req(name === 'cache' && id === 'c1' ? { blob, at: Date.now(), size: blob.size } : null),
        put: () => ({}), getAllKeys: () => req([]), delete: () => req(null) }) };
    }
  };
  const h = createHarness({ tracks: [song], withStorage: true, storageDb, settings: { autoplay: false, noYtFallback: true } });
  let resolves = 0;
  stubApi(h, async id => { resolves++; return { url: 'https://stream/' + id, related: [] }; });
  const events = eventsOf(h);
  const realPlay = h.audio.play.bind(h.audio);
  h.audio.play = function () {
    if (/^blob:/.test(this.src)) { closing = true; this.error = { code: 3 }; const e = new Error('decode'); e.name = 'NotSupportedError'; return Promise.reject(e); }
    return realPlay();
  };
  h.audio.src = '';
  h.play();
  await flushMicrotasks(100);
  h.audio.dispatch('playing');
  await flushMicrotasks(200);
  assert.equal(resolves, 1, 'the stream was asked for');
  assert.equal(h.audio.src, 'https://stream/c1');
  assert.ok(events.includes('track:c1') && !events.includes('error:c1'), events.join(' '));
});

// The one stream retry a track gets per start was reset only by loadAndPlay. A track
// reached again through prepared transitions kept the used-up allowance, so its next
// network error went straight to the fallback.
test('a track reached through prepared transitions gets its stream retry again', async () => {
  const a = { id: 'a', title: 'A', artist: 'X', duration: 180 };
  const b = { id: 'b', title: 'B', artist: 'Y', duration: 180 };
  const h = createHarness({ tracks: [a, b], withStorage: true, withYt: true, settings: { autoplay: false } });
  h.window.Player.cycleRepeat();
  const resolves = [];
  stubApi(h, async id => { resolves.push(id); return { url: 'https://stream/' + id + '/' + resolves.length, related: [] }; });
  h.audio.src = '';
  h.play();
  await flushMicrotasks(100); h.audio.dispatch('playing'); await flushMicrotasks(100);
  h.audio.error = { code: 2 }; h.audio.dispatch('error'); await flushMicrotasks(200);
  assert.equal(resolves.filter(id => id === 'a').length, 2, 'the first error re-resolved the stream');
  h.audio.error = null;
  for (const step of ['b', 'a']) {
    await flushMicrotasks(200);
    const P = h.window.Aura.player;
    assert.ok(P.xfadePrep && P.xfadePrep.id === step, 'prepared ' + step);
    await h.window.Player.next();
    await flushMicrotasks(100);
    h.window.Aura.player.audio.dispatch('playing');
    await flushMicrotasks(200);
    assert.equal(h.window.Player.current().id, step);
  }
  const P = h.window.Aura.player;
  const before = resolves.length;
  P.audio.error = { code: 2 }; P.audio.dispatch('error'); await flushMicrotasks(300);
  assert.equal(resolves.slice(before).join(','), 'a', 'the error on the revisited track re-resolves');
  assert.ok(!h.ytPlayer(), 'no YouTube fallback');
});

// An upload swapped out for one that plays is not a song the listener removed: it was
// listed under the queue sheet's removed songs, and the saved queue position named it.
test('swapping a dead upload for an alternate forgets it', async () => {
  const dead = { id: 'dead', title: 'Song', artist: 'X', duration: 180 };
  const next = { id: 'next', title: 'Next', artist: 'Y', duration: 180 };
  const h = createHarness({ tracks: [dead, next], withStorage: true, settings: { autoplay: false, noYtFallback: true } });
  stubApi(h, async id => { if (id === 'dead') throw new Error('gone'); return { url: 'https://stream/' + id, related: [] }; });
  h.Api.findVersions = async () => [{ id: 'alt', title: 'Song (alt)', artist: 'X', duration: 181 }];
  h.audio.src = '';
  h.play();
  await flushMicrotasks(100); h.audio.dispatch('playing'); await flushMicrotasks(200);
  const p = h.window.Player;
  assert.equal(p.current().id, 'alt');
  assert.equal(p.queueHistory().map(e => e.track.id + ':' + e.status).join(' '), 'alt:current next:upcoming');
  assert.equal(JSON.parse(h.savedLocal.get('aura.queueAt')).id, 'alt');
});

// On iOS a song refused by the element is held, source and all, for a Play tap. The
// next typed request's Send tap primes the element, but the prime declined to touch a
// loaded source, so every request after one hold needed a manual tap.
test('priming replaces a source held for a Play tap', async () => {
  const h = createHarness({ tracks: [{ id: 'seed', title: 'Seed', artist: 'X', duration: 180 }], withStorage: true,
    navigator: { userAgent: 'iPhone', onLine: true }, settings: { autoplay: false, noYtFallback: true } });
  const V = h.window.Aura.player;
  assert.equal(V.isIOS, true);
  stubApi(h, async id => ({ url: 'https://stream/' + id, related: [] }));
  const audio = h.audio;
  audio.permitted = false;
  const realPlay = audio.play.bind(audio);
  audio.play = function () {
    if (this.src === V.SILENT_PRIME_CLIP) { this.permitted = true; return Promise.resolve(); }
    if (!this.permitted) { const e = new Error('denied'); e.name = 'NotAllowedError'; return Promise.reject(e); }
    return realPlay();
  };
  const p = h.window.Player;
  const events = eventsOf(h);
  audio.src = '';
  p.playQueue([{ id: 'one', title: 'One', artist: 'X', duration: 180 }]);
  await flushMicrotasks(200);
  assert.equal(p.needsPlaybackGesture(), true, 'the first song is held for a tap');
  p.primeForPlayback();
  assert.equal(audio.permitted, true, 'the prime ran inside the gesture');
  p.playQueue([{ id: 'two', title: 'Two', artist: 'X', duration: 180 }]);
  await flushMicrotasks(200);
  assert.equal(p.needsPlaybackGesture(), false, 'the second song plays');
  assert.equal(audio.src, 'https://stream/two');
  assert.ok(!events.includes('playback-permission:two'), events.join(' '));
});
