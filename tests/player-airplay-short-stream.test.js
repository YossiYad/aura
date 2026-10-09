const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

async function setup() {
  const h = createHarness({ withAirPlay: true, withAudioSession: false, exposeInternals: true,
    tracks: [{ id: 'one', title: 'One', duration: 215 }, { id: 'two', title: 'Two', duration: 225 }],
    settings: { autoplay: false } });
  const requests = [], invalidations = [], listens = [];
  h.Api.resolve = async id => {
    requests.push(id);
    return { url: 'https://test/' + id + '?attempt=' + requests.length, duration: id === 'one' ? 215 : 225 };
  };
  h.Api.invalidate = (id, penalize) => invalidations.push({ id, penalize });
  h.Store.pushRecent = track => listens.push(track.id);
  h.audio.currentTime = 0;
  h.audio.duration = 429.335;
  h.play();
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  await flushMicrotasks(50);
  h.window.__playerInternals.resetListenTracking(h.window.Player.current());
  h.window.__playerInternals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two', duration: 225 });
  requests.length = 0;
  return { ...h, P: h.window.Player, requests, invalidations, listens };
}

test('AirPlay 429 -> 9 -> 0 duration collapse preserves timeline, seeking and listen threshold', async () => {
  const h = await setup();
  let position;
  h.navigator.mediaSession.setPositionState = value => { position = value; };
  for (const duration of [9, 0, 9]) {
    h.audio.duration = duration;
    h.audio.dispatch('durationchange');
    assert.equal(h.P.getTime().dur, 215);
    assert.equal(position.duration, 215);
  }
  for (let second = 1; second <= 10; second++) {
    h.audio.currentTime = second;
    h.audio.dispatch('timeupdate');
  }
  assert.equal(h.P.current().id, 'one');
  assert.deepEqual(h.listens, []);
  assert.equal(h.audio.paused, false);
  h.P.seekTo(100);
  assert.equal(h.audio.currentTime, 100);
  assert.equal(h.P.getTime().cur, 100);
  h.P.dismiss();
});

for (const event of ['ended', 'timeupdate', 'pause', 'watchdog']) {
  test('premature AirPlay end via ' + event + ' refreshes the same track once and preserves position', async () => {
    const h = await setup();
    h.audio.duration = 9;
    h.audio.currentTime = 5;
    h.audio.ended = true;
    h.audio.paused = true;
    if (event === 'watchdog') h.runIntervals(5000);
    else h.audio.dispatch(event);
    // Other terminal events from this failed source must join the existing recovery.
    h.audio.dispatch('ended');
    h.audio.dispatch('timeupdate');
    h.runIntervals(5000);
    h.audio.ended = false;
    h.audio.duration = 215;
    await flushMicrotasks(50);
    assert.equal(h.P.current().id, 'one');
    assert.equal(h.audio.currentTime, 5);
    assert.equal(h.audio.paused, false);
    assert.equal(h.requests.filter(id => id === 'one').length, 1);
    assert.deepEqual(h.invalidations, [{ id: 'one', penalize: false }]);
    assert.deepEqual(h.listens, []);
    // Successful full playback still advances to the next song normally.
    h.audio.currentTime = 215;
    h.audio.ended = true;
    h.audio.dispatch('ended');
    h.audio.ended = false;
    await flushMicrotasks(50);
    assert.equal(h.P.current().id, 'two');
    h.P.dismiss();
  });
}

test('a second short end holds the track without repeating recovery, consuming sleep or recording a listen', async () => {
  const h = await setup();
  const errors = [];
  h.P.onChange(event => { if (event.type === 'remote-error') errors.push(event); });
  h.P.setSleepTimer('track');
  for (let attempt = 0; attempt < 2; attempt++) {
    h.audio.duration = 9;
    h.audio.currentTime = 5;
    h.audio.ended = true;
    h.audio.dispatch('ended');
    h.audio.ended = false;
    await flushMicrotasks(50);
  }
  assert.equal(h.P.current().id, 'one');
  assert.equal(h.P.playbackRequested(), false);
  assert.equal(h.audio.paused, true);
  assert.equal(h.P.sleepTimerState(), 'track');
  assert.equal(h.requests.filter(id => id === 'one').length, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(h.listens, []);
  h.P.dismiss();
});

test('a receiver resetting both duration and position retains the last playback checkpoint', async () => {
  const h = await setup();
  h.audio.currentTime = 101;
  h.audio.dispatch('timeupdate');
  h.audio.duration = 0;
  h.audio.currentTime = 0;
  h.audio.ended = true;
  h.audio.dispatch('timeupdate');
  h.audio.dispatch('ended');
  h.audio.ended = false;
  await flushMicrotasks(50);
  assert.equal(h.audio.currentTime, 101);
  assert.equal(h.P.current().id, 'one');
  h.P.dismiss();
});

test('fresh source duration overrides stale catalog metadata after receiver truncation', async () => {
  const h = await setup();
  const started = h.window.__playerInternals.playViaAudio('https://test/fresh', { duration: 300 });
  h.runImmediateTimers();
  await started;
  h.audio.duration = 9;
  assert.equal(h.P.getTime().dur, 300);
  h.P.dismiss();
});

test('choosing another track while recovery resolves ignores the old response', async () => {
  const h = await setup();
  let resolve;
  const normalResolve = h.Api.resolve;
  h.Api.resolve = id => id === 'one' ? new Promise(done => { resolve = done; }) : normalResolve(id);
  h.audio.duration = 9;
  h.audio.currentTime = 5;
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.audio.ended = false;
  h.P.next();
  await flushMicrotasks(50);
  h.runImmediateTimers();
  await flushMicrotasks(50);
  const source = h.audio.src;
  resolve({ url: 'https://test/stale-one', duration: 215 });
  await flushMicrotasks(50);
  assert.equal(h.P.current().id, 'two');
  assert.equal(h.audio.src, source);
  assert.ok(!h.audio.src.includes('stale-one'));
  h.P.dismiss();
});

test('pause during the fresh stream lookup cancels recovery', async () => {
  const h = await setup();
  let resolve;
  h.Api.resolve = () => new Promise(done => { resolve = done; });
  h.audio.duration = 9;
  h.audio.currentTime = 5;
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.P.pause();
  const calls = h.audio.playCalls;
  resolve({ url: 'https://test/refreshed', duration: 215 });
  await flushMicrotasks(50);
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.P.playbackRequested(), false);
  assert.equal(h.P.current().id, 'one');
  h.P.dismiss();
});

for (const [expected, media, wireless, result] of [
  [215, 9, false, 9], [9, 9, true, 9], [215, 212, true, 212],
  [0, 9, true, 9], [215, Infinity, true, 0]
]) {
  test('preserves genuine short, local, unknown and live durations: ' + [expected, media, wireless], async () => {
    const h = await setup();
    h.P.current().duration = expected;
    h.audio.webkitCurrentPlaybackTargetIsWireless = wireless;
    h.audio.duration = media;
    assert.equal(h.P.getTime().dur, result);
    h.P.dismiss();
  });
}
