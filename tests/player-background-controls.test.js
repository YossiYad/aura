const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
const tracks = ids => ids.map(id => ({ id, title: id, duration: 180 }));

// Browser-faithful play()/pause() promises: play() settles only once the element starts,
// and pause() rejects every pending play() with AbortError, as Chrome and WebKit do.
function realisticPlayback(audio) {
  audio.pendingPlays = [];
  let source = audio.src;
  Object.defineProperty(audio, 'src', {
    get: () => source,
    set(value) { source = value; if (value) { this.ended = false; this.currentTime = 0; this.readyState = 0; this.dispatch('loadstart'); } }
  });
  audio.play = function () {
    this.playCalls++;
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.dispatch('play');
    return new Promise((res, rej) => this.pendingPlays.push({ res, rej }));
  };
  audio.pause = function () {
    if (this.paused) return;
    this.paused = true;
    this.pendingPlays.splice(0).forEach(p => p.rej(Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' })));
    this.dispatch('pause');
  };
  audio.startPlaying = function () {
    this.readyState = 4;
    this.pendingPlays.splice(0).forEach(p => p.res());
    this.dispatch('playing');
  };
  audio.removeAttribute = function (name) { if (name === 'src') source = ''; };
}

function statelessIphone(options = {}) {
  const h = createHarness({ navigator: IPHONE, withStorage: true, tracks: tracks(['one', 'two', 'three']),
    settings: { autoplay: false, noYtFallback: true }, ...options });
  delete h.audioSession.state;
  h.Api.getSkipSegments = async () => [];
  return h;
}

function hide(h) { h.document.hidden = true; h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange'); }
function show(h) { h.document.hidden = false; h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange'); }

test('a lock-screen pause during a load holds the track instead of failing its source', async () => {
  const h = statelessIphone();
  const invalidations = [];
  let findVersions = 0;
  h.Api.resolve = async id => ({ url: 'https://test/' + id, base: 'https://test' });
  h.Api.invalidate = id => invalidations.push(id);
  h.Api.findVersions = async () => { findVersions++; return [{ id: 'two-alt', title: 'Two (other upload)' }]; };
  realisticPlayback(h.audio);
  h.audio.src = 'https://test/one';
  h.play(); h.audio.startPlaying(); await flushMicrotasks(20);
  h.document.hidden = true; h.document.visibilityState = 'hidden';
  h.actions.get('nexttrack')();
  await flushMicrotasks(80);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.pendingPlays.length, 1, 'the new source is still starting');
  h.pause();
  await flushMicrotasks(200);
  assert.deepEqual(invalidations, [], 'our own pause is not a broken stream');
  assert.equal(findVersions, 0, 'no other upload is looked for');
  assert.equal(h.window.Player.current().id, 'two');
  h.runTimers(500); await flushMicrotasks(50);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.navigator.mediaSession.metadata.title, 'two', 'the lock screen names the song the queue holds');
  assert.deepEqual(h.window.Player.queue().map(t => t.id), ['one', 'two', 'three']);
  h.play(); await flushMicrotasks(80);
  assert.equal(h.audio.src, 'https://test/two');
  h.audio.startPlaying(); await flushMicrotasks(20);
  assert.equal(h.audio.paused, false);
  assert.equal(h.window.Player.current().id, 'two');
});

test('a load caught by an interruption starts once the app is reopened', async () => {
  let now = 1000000;
  const h = createHarness({ Date: { now: () => now }, navigator: IPHONE, tracks: tracks(['one', 'two']),
    settings: { autoplay: false, noYtFallback: true } });
  delete h.audioSession.state;
  let resolveTwo;
  h.Api.resolve = id => id === 'two' ? new Promise(r => { resolveTwo = r; }) : Promise.resolve({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  h.play();
  hide(h);
  h.actions.get('nexttrack')();
  await flushMicrotasks(20);
  h.audioSession.dispatch('statechange');
  h.pause();
  await flushMicrotasks();
  assert.equal(h.audio.paused, true);
  now += 60000;
  show(h);
  await flushMicrotasks();
  h.runImmediateTimers();
  const before = h.audio.playCalls;
  resolveTwo({ url: 'https://test/two' });
  await flushMicrotasks(40);
  h.runImmediateTimers(); await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, before + 1, 'the held source is started, not left for the next reopen');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.paused, false);
  assert.equal(h.window.Player.current().id, 'two');
});

test('a song tapped in the reopened app under a stale platform hold plays', async () => {
  let now = 1000000;
  const h = statelessIphone({ Date: { now: () => now } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, base: 'https://test' });
  h.play();
  hide(h);
  h.audio.pause(); h.audioSession.dispatch('statechange'); h.runTimers(500);
  now += 5000;
  show(h);
  await flushMicrotasks(40); h.runImmediateTimers(); await flushMicrotasks(40);
  const before = h.audio.playCalls;
  h.window.Player.jumpTo(2);
  await flushMicrotasks(40); h.runImmediateTimers(); await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'three');
  assert.equal(h.audio.src, 'https://test/three', 'the tap is a gesture, not a load to hold');
  assert.equal(h.audio.playCalls, before + 1);
});

test('a queue edit during a pending handoff commits the song already starting', async () => {
  const h = createHarness({ navigator: IPHONE, withStorage: true, withAudioSession: false, tracks: tracks(['one', 'two', 'three']),
    settings: { autoplay: false, noYtFallback: true, crossfade: 4 } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', { get: () => source, set(value) { source = value; this.ended = false; this.currentTime = 0; } });
  h.document.hidden = true; h.document.visibilityState = 'hidden';
  h.audio.play = function () { const r = FakeAudio.prototype.play.call(this); this.dispatch('playing'); return r; };
  h.play();
  await flushMicrotasks(60);
  h.audio.play = function () { FakeAudio.prototype.play.call(this); return new Promise(() => {}); };
  h.audio.ended = true;
  h.audio.dispatch('ended');
  assert.equal(h.audio.src, 'https://test/two', 'the next song is starting on the permitted element');
  h.window.Player.playNext({ id: 'x', title: 'x', duration: 180 });
  assert.equal(h.audio.src, 'https://test/two', 'the element keeps the song that is starting');
  assert.equal(h.window.Player.current().id, 'two');
  assert.deepEqual(h.window.Player.queue().map(t => t.id), ['one', 'two', 'x', 'three']);
  assert.equal(h.window.Player.playbackRequested(), true);
  h.audio.dispatch('playing');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('a second Next during a prepared start moves on to the song after it', async () => {
  const h = createHarness({ navigator: IPHONE, withStorage: true, withAudioSession: false, tracks: tracks(['one', 'two', 'three']),
    settings: { autoplay: false, noYtFallback: true, crossfade: 4 } });
  const resolves = [];
  h.Api.resolve = async id => { resolves.push(id); return { url: 'https://test/' + id }; };
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', { get: () => source, set(value) { source = value; this.ended = false; this.currentTime = 0; } });
  h.document.hidden = true; h.document.visibilityState = 'hidden';
  h.audio.play = function () { const r = FakeAudio.prototype.play.call(this); this.dispatch('playing'); return r; };
  h.play();
  await flushMicrotasks(60);
  h.audio.play = function () { FakeAudio.prototype.play.call(this); return new Promise(() => {}); };
  h.window.Player.next();
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.window.Player.current().id, 'one', 'the handoff has not been confirmed yet');
  h.window.Player.next();
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'three');
  assert.equal(h.audio.src, 'https://test/three');
  assert.equal(resolves.filter(id => id === 'two').length, 1, 'the second Next does not start the same song again');
  h.window.Player.dismiss();
});

test('Previous while the next song loads returns to the song before it', async () => {
  const h = createHarness({ withStorage: true, tracks: tracks(['one', 'two', 'three']), settings: { autoplay: false, noYtFallback: true } });
  const resolves = [];
  h.Api.resolve = id => { resolves.push(id); return id === 'two' ? new Promise(() => {}) : Promise.resolve({ url: 'https://test/' + id }); };
  h.Api.getSkipSegments = async () => [];
  h.play();
  h.audio.currentTime = 120;
  h.window.Player.next();
  await flushMicrotasks(20);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.prev();
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'one', 'not a restart of the song that was leaving');
  assert.ok(resolves.includes('one'));
  h.window.Player.dismiss();
});

test('a prepared handoff resumes a podcast where it was left', async () => {
  const h = createHarness({ navigator: IPHONE, withStorage: true, withAudioSession: false,
    tracks: [{ id: 'one', title: 'one', duration: 180 }, { id: 'two', title: 'Ep 2', duration: 3600, kind: 'podcast' }],
    settings: { autoplay: false, noYtFallback: true, crossfade: 4 } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  h.Store.getPosition = id => id === 'two' ? 1000 : 0;
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', { get: () => source, set(value) { source = value; this.ended = false; this.currentTime = 0; } });
  h.document.hidden = true; h.document.visibilityState = 'hidden';
  h.audio.play = function () { const r = FakeAudio.prototype.play.call(this); this.dispatch('playing'); return r; };
  h.play();
  await flushMicrotasks(60);
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.currentTime, 1000, 'the saved place, not the start');
  h.window.Player.dismiss();
});

test('pausing, seeking and leaving the app save the listening position', async () => {
  const h = createHarness({ withStorage: true, tracks: [{ id: 'ep', title: 'Ep', duration: 3600, kind: 'podcast' }],
    settings: { autoplay: false, noYtFallback: true } });
  const saves = [];
  h.Store.savePosition = (id, at) => saves.push([id, at]);
  h.play();
  h.audio.duration = 3600;
  h.audio.currentTime = 100;
  h.window.Player.seekTo(200);
  assert.deepEqual(saves.at(-1), ['ep', 200]);
  h.audio.currentTime = 300;
  h.window.Player.pause();
  assert.deepEqual(saves.at(-1), ['ep', 300]);
  h.play();
  h.audio.currentTime = 400;
  hide(h);
  assert.deepEqual(saves.at(-1), ['ep', 400]);
  assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'ep', at: 400 });
  h.window.Player.dismiss();
});

test('Play after a reload resumes a paused song where it stood', async () => {
  const h = createHarness({ withStorage: true, tracks: tracks(['song']), settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.getSkipSegments = async () => [];
  h.savedLocal.set('aura.queueAt', JSON.stringify({ id: 'song', at: 90 }));
  h.window.Player.restore({ extra: tracks(['song']), pos: 0 });
  h.audio.removeAttribute('src');
  h.play();
  await flushMicrotasks(60);
  h.audio.dispatch('playing');
  await flushMicrotasks(20);
  assert.equal(h.audio.src, 'https://test/song');
  assert.equal(h.audio.currentTime, 90);
  h.window.Player.dismiss();
});

test('Play at the end of the queue replays the last song without a pending lookup cutting it off', async () => {
  const h = createHarness({ tracks: [{ id: 'a', title: 'A', artist: 'X', duration: 180 }], withStorage: true,
    withAudioSession: false, settings: { autoplay: true, noYtFallback: true } });
  let release;
  h.Api.resolve = id => id === 'a' ? new Promise(r => { release = r; }) : Promise.resolve({ url: 'https://test/' + id });
  h.Api.getSkipSegments = async () => [];
  h.Api.search = async () => ({ items: [] });
  h.audio.play = function () { const r = FakeAudio.prototype.play.call(this); this.dispatch('playing'); return r; };
  h.play();
  await flushMicrotasks(60);
  h.document.hidden = true;
  h.audio.currentTime = 180; h.audio.ended = true; h.audio.paused = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(30);
  h.runTimers(1200);
  await flushMicrotasks(30);
  h.audio.ended = false;
  h.actions.get('play')();
  await flushMicrotasks(30);
  const src = h.audio.src;
  h.audio.currentTime = 12;
  release({ related: [{ id: 'fresh', title: 'Fresh', artist: 'X', duration: 180 }] });
  await flushMicrotasks(120);
  assert.equal(h.window.Player.current().id, 'a', 'the replay the listener asked for keeps playing');
  assert.equal(h.audio.src, src);
  h.window.Player.dismiss();
});

test('Play after a sleep deadline that passed while the page slept plays', async () => {
  let now = 1000000;
  const h = createHarness({ Date: { now: () => now }, withStorage: true });
  h.play();
  h.window.Player.setSleepTimer(1);
  now += 61000;
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(h.window.Player.sleepTimerState(), 'off');
});

test('the Play tap that resolves a permission hold resumes the audio context inside the gesture', async () => {
  const h = createHarness({ navigator: IPHONE, withAudioContext: true });
  delete h.audioSession.state;
  h.audio.play = function () { this.playCalls++; return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' })); };
  h.window.Player.toggle();
  await flushMicrotasks();
  const ctx = h.audioContexts[0];
  assert.equal(h.window.Player.needsPlaybackGesture(), true);
  const before = ctx.resumeCalls;
  h.audio.play = FakeAudio.prototype.play;
  h.window.Player.toggle();
  assert.equal(ctx.resumeCalls, before + 1, 'a resume() issued synchronously inside the tap');
});
