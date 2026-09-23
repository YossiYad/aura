const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness, flushMicrotasks } = require('./harness');

function setup(options = {}) {
  const h = createHarness({ exposeInternals: true, withAudioSession: false,
    tracks: [{ id: 'one', title: 'One', duration: 210 }, { id: 'two', title: 'Two', duration: 180 }],
    ...options, settings: { autoplay: false, crossfade: 0, ...options.settings } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => assert.fail('finishing a song must not retry its stream');
  h.audio.duration = 480;
  h.play();
  return h;
}

test('an eight-minute container for a 3:30 song shows the song endpoint everywhere', () => {
  const h = setup();
  assert.equal(h.window.Player.getTime().dur, 210);
  let position;
  h.navigator.mediaSession.setPositionState = value => { position = value; };
  h.audio.currentTime = 205;
  h.audio.dispatch('durationchange');
  assert.equal(position.duration, 210);
  assert.equal(position.position, 205);
  h.actions.get('seekforward')({});
  assert.equal(h.audio.currentTime, 209);
  h.window.Player.seekTo(400);
  assert.equal(h.audio.currentTime, 210);
});

test('a mid-playback duration jump from 3:34 to 7:04 cannot extend the song', async () => {
  const h = setup({ tracks: [{ id: 'one', title: 'One', duration: 214 }] });
  const positions = [];
  h.navigator.mediaSession.setPositionState = value => positions.push(value);
  h.audio.duration = 214;
  h.audio.currentTime = 0;
  h.audio.dispatch('durationchange');
  assert.equal(h.window.Player.getTime().dur, 214);
  h.audio.currentTime = 32;
  h.audio.duration = 424;
  h.audio.dispatch('durationchange');
  assert.equal(h.window.Player.getTime().dur, 214);
  assert.equal(positions.at(-1).duration, 214);
  assert.equal(positions.at(-1).position, 32);
  h.audio.currentTime = 215;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(50);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.getTime().dur, 214);
});

for (const hidden of [false, true]) {
  test('inflated audio advances once at the song endpoint, hidden=' + hidden, async () => {
    const h = setup();
    h.document.hidden = hidden;
    h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two', duration: 180 });
    h.audio.currentTime = 211;
    h.audio.dispatch('timeupdate');
    h.audio.dispatch('timeupdate');
    await flushMicrotasks(50);
    assert.equal(h.window.Player.current().id, 'two');
    assert.equal(h.window.Player.getTime().dur, 180);
    assert.equal(h.audioElements[hidden ? 0 : 1].paused, false);
    h.window.Player.dismiss();
  });
}

test('the background watchdog advances without a native ended or timeupdate event', async () => {
  const h = setup();
  h.document.hidden = true;
  h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  h.audio.currentTime = 214;
  h.runIntervals(5000);
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('a crossfade starts near the song endpoint instead of minutes into the empty tail', async () => {
  const h = setup({ settings: { crossfade: 4 } });
  h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  h.audio.currentTime = 207;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(30);
  assert.equal(h.audioElements[1].playCalls, 1);
  assert.equal(h.window.Player.current().id, 'one');
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.paused, true);
  h.window.Player.dismiss();
});

test('the last song pauses at its corrected endpoint and Play restarts it', async () => {
  const h = setup({ tracks: [{ id: 'one', title: 'One', duration: 210 }] });
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(50);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.window.Player.getTime().cur, 210);
  h.play();
  assert.equal(h.audio.currentTime, 0);
  assert.equal(h.audio.paused, false);
});

test('repeat one restarts at the corrected endpoint on every loop', () => {
  const h = setup();
  h.window.Player.cycleRepeat();
  h.window.Player.cycleRepeat();
  for (let i = 0; i < 3; i++) {
    h.audio.currentTime = 211;
    h.audio.dispatch('timeupdate');
    assert.equal(h.window.Player.current().id, 'one');
    assert.equal(h.audio.currentTime, 0);
    assert.equal(h.audio.paused, false);
  }
});

test('sleep after track stops at the corrected endpoint without starting the prepared song', () => {
  const h = setup();
  h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  h.window.Player.setSleepTimer('track');
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audioElements[1].playCalls, 0);
  assert.equal(h.window.Player.sleepTimerState(), 'off');
});

test('fresh upload metadata overrides stale short catalog metadata', async () => {
  const h = setup();
  const started = h.window.__playerInternals.playViaAudio('https://test/long', { duration: 480 });
  h.runImmediateTimers();
  await started;
  assert.equal(h.window.Player.getTime().dur, 480);
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'one');
});

test('fresh duration survives preparation and is scoped to the next track', async () => {
  const h = setup();
  h.document.hidden = true;
  h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two', duration: 460 });
  assert.equal(h.window.Player.getTime().dur, 210);
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.window.Player.getTime().dur, 480);
  h.window.Player.dismiss();
});

for (const [name, duration, media, kind] of [
  ['a genuine eight-minute song', 480, 480],
  ['a shorter source', 480, 210],
  ['normal encoding differences', 210, 212],
  ['missing metadata', 0, 480],
  ['non-finite metadata', Infinity, 480],
  ['a live stream', 210, Infinity],
  ['speech', 210, 480, 'podcast']
]) {
  test('does not cut ' + name, () => {
    const h = setup({ tracks: [{ id: 'one', title: 'One', duration, kind }] });
    h.audio.duration = media;
    assert.equal(h.window.Player.getTime().dur, Number.isFinite(media) ? media : 0);
    h.audio.currentTime = 215;
    h.audio.dispatch('timeupdate');
    assert.equal(h.audio.paused, false);
    assert.equal(h.window.Player.current().id, 'one');
  });
}

test('a short buffer and a mid-song stall are not treated as the end', () => {
  const h = setup();
  h.audio.currentTime = 100;
  h.audio.buffered = { length: 1, start: () => 0, end: () => 100 };
  h.audio.dispatch('waiting');
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
});

test('a decoder exhausted at the real endpoint advances instead of reloading the song', () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = setup({ Date: Clock });
  h.Api.resolve = () => new Promise(() => {});
  h.audio.currentTime = 209.8;
  h.audio.dispatch('timeupdate');
  now += 16000;
  h.runIntervals(5000);
  h.runImmediateTimers();
  assert.equal(h.window.Player.current().id, 'two');
});

test('converting a local source for a receiver retains fresh duration metadata for the stream', async () => {
  const h = setup();
  h.audio.src = 'blob:saved-track';
  h.Api.resolve = async id => ({ url: 'https://test/' + id, duration: 480 });
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  await flushMicrotasks(50);
  assert.equal(h.window.Player.getTime().dur, 480);
  h.audio.currentTime = 211;
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'one');
  h.window.Player.dismiss();
});

test('a native handoff preserves its HTTP source when the decoder reports double the duration', async () => {
  const h = setup({ tracks: [{ id: 'one', title: 'One', duration: 157 }] });
  const source = h.audio.src;
  h.Api.resolve = assert.fail;
  h.audio.duration = 156.2935;
  h.audio.currentTime = 14;
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  h.audio.duration = 312.632;
  h.audio.dispatch('durationchange');
  await flushMicrotasks(50);
  assert.equal(h.audio.src, source);
  assert.equal(h.audio.currentTime, 14);
  assert.equal(h.window.Player.getTime().dur, 157);
  assert.equal(h.window.Player.current().id, 'one');
  h.window.Player.dismiss();
});

test('rounding, seeking, and a platform pause do not finish the song prematurely', () => {
  const h = setup();
  h.audio.currentTime = 210.5;
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'one');
  h.audio.currentTime = 211;
  h.audio.seeking = true;
  h.audio.dispatch('timeupdate');
  assert.equal(h.window.Player.current().id, 'one');
  h.audio.seeking = false;
  h.audio.pause();
  h.audio.dispatch('timeupdate');
  h.runIntervals(5000);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, true);
});
