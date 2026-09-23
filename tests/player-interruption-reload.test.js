const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness, flushMicrotasks } = require('./harness');

function interruptedPlayer(source, withAudioSession = true) {
  let now = 1000000;
  const h = createHarness({ withAudioSession, Date: { now: () => now },
    navigator: { userAgent: withAudioSession ? 'iPhone' : 'Android' } });
  delete h.audioSession.state;
  h.Api.resolve = h.Api.invalidate = () => assert.fail('focus recovery must retain the existing source');
  h.audio.src = source;
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  h.document.dispatch('visibilitychange');
  h.audio.currentTime = 62.57;
  h.audio.pause();
  if (withAudioSession) h.audioSession.dispatch('statechange');
  h.runTimers(500);
  now += 10000;
  h.audio.play(); // The native resume changes paused, but the decoder remains frozen.
  if (withAudioSession) h.audioSession.dispatch('statechange');

  let loads = 0, position = 62.57, defaultStart = 0;
  // Model HAVE_NOTHING: assigning currentTime retains a default start position
  // even though the element still reports zero until metadata becomes available.
  Object.defineProperty(h.audio, 'currentTime', {
    get() { return position; },
    set(value) { if (this.readyState === 0) defaultStart = value; else position = value; }
  });
  h.audio.load = function () {
    loads++;
    position = defaultStart = 0;
    this.readyState = 0;
    this.paused = true;
    this.dispatch('emptied');
  };
  return { ...h,
    get loads() { return loads; },
    get defaultStart() { return defaultStart; },
    advance(ms) { now += ms; },
    metadata() {
      h.audio.readyState = 4;
      position = defaultStart;
      h.audio.dispatch('loadedmetadata');
      h.audio.dispatch('timeupdate');
      h.audio.dispatch('playing');
    },
    reload() {
      h.runTimers(1000); // Pause/play reports success but no progress.
      h.runTimers(1000); // Reload the same source without the old 8s stall wait.
    }
  };
}

for (const source of ['blob:downloaded-song', 'https://example.test/track.mp4']) {
  for (const withAudioSession of [true, false]) {
    test('same-source interruption reload progresses while hidden: ' + source + ', session=' + withAudioSession, async () => {
      const h = interruptedPlayer(source, withAudioSession);
      h.reload();
      await flushMicrotasks();
      assert.equal(h.loads, 1);
      assert.equal(h.audio.src, source);
      assert.equal(h.defaultStart, 62.57);
      assert.equal(h.document.hidden, true);
      assert.equal(h.audioElements[1].playCalls, 0, 'reuse the permitted audio element');
      h.metadata();
      assert.equal(h.pendingTimers(4000), 1, 'metadata, seek position, and playing are not progress');
      h.audio.currentTime += 0.5;
      h.audio.dispatch('timeupdate');
      assert.equal(h.pendingTimers(4000), 0, 'actual progress confirms recovery while still hidden');
      assert.equal(h.document.hidden, true);
      assert.equal(h.audio.paused, false);
      assert.equal(h.window.Player.current().id, 'track-1');
      assert.equal(h.audio.currentTime, 63.07);
    });
  }
}

for (const metadataArrived of [true, false]) {
  test('a blocked background reload retains the source and checkpoint, metadata=' + metadataArrived, async () => {
    const source = 'blob:downloaded-song';
    const h = interruptedPlayer(source);
    h.reload();
    if (metadataArrived) h.metadata();
    h.advance(4000);
    h.runTimers(4000);
    await flushMicrotasks();
    assert.equal(h.audio.paused, true);
    assert.equal(h.window.Player.playbackRequested(), true);
    const calls = h.audio.playCalls;
    h.advance(60000);
    h.runIntervals(5000);
    h.runTimers(8000);
    h.runTimers(1000);
    h.runTimers(4000);
    await flushMicrotasks();
    assert.equal(h.loads, 1);
    assert.equal(h.audio.playCalls, calls, 'no polling or generic source replacement');
    assert.equal(h.audio.src, source);
    assert.equal(h.window.Player.current().id, 'track-1');
    assert.equal(h.window.Player.queue().length, 1);

    h.document.hidden = false;
    h.document.dispatch('visibilitychange');
    if (!metadataArrived) h.metadata();
    assert.equal(h.audio.currentTime, 62.57);
    assert.equal(h.audio.paused, false);
    assert.equal(h.loads, 1, 'foreground resume also retains the attached source');
    assert.equal(h.pendingTimers(1000), 1, 'restoring the seek checkpoint is not playback progress');
  });
}

for (const outcome of ['pause', 'interruption', 'new queue', 'remote route', 'native progress']) {
  test('a pending source reload yields to ' + outcome, async () => {
    const h = interruptedPlayer('https://example.test/track.mp4');
    h.runTimers(1000);
    if (outcome === 'pause') h.window.Player.pause();
    if (outcome === 'interruption') h.audio.pause();
    if (outcome === 'new queue') h.window.Player.playQueue([]);
    if (outcome === 'remote route') h.audio.remote.state = 'connected';
    if (outcome === 'native progress') { h.audio.currentTime += 0.5; h.audio.dispatch('timeupdate'); }
    const loads = h.loads; // Clearing the queue itself unloads the old element.
    h.runTimers(1000);
    h.runTimers(4000);
    await flushMicrotasks();
    assert.equal(h.loads, loads);
  });
}

test('a background watchdog cannot replace the source while decoder recovery is pending', async () => {
  const h = interruptedPlayer('blob:downloaded-song');
  h.reload();
  h.advance(30000); // Watchdog arrives before the delayed verification timeout.
  h.runIntervals(5000);
  h.runImmediateTimers();
  await flushMicrotasks();
  assert.equal(h.loads, 1);
  assert.equal(h.audio.src, 'blob:downloaded-song');
  assert.equal(h.window.Player.playbackRequested(), true);
});

test('an aborted decoder reload cannot discard a cached source', async () => {
  const h = interruptedPlayer('blob:downloaded-song');
  h.reload();
  h.audio.error = { code: 1 };
  h.audio.dispatch('error');
  h.runTimers(4000);
  await flushMicrotasks();
  assert.equal(h.audio.src, 'blob:downloaded-song');
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);
});

test('aborting an older pending play promise does not cancel the decoder reload', async () => {
  const h = interruptedPlayer('https://example.test/track.mp4');
  const play = h.audio.play.bind(h.audio);
  let rejectRestart;
  h.audio.play = () => {
    play();
    return new Promise((resolve, reject) => { rejectRestart = reject; });
  };
  h.runTimers(1000);
  h.audio.play = play;
  h.runTimers(1000);
  rejectRestart(Object.assign(new Error('load aborted the earlier play'), { name: 'AbortError' }));
  await flushMicrotasks();
  assert.equal(h.audio.paused, false);
  assert.equal(h.loads, 1);
  h.metadata();
  h.audio.currentTime += 0.5;
  h.audio.dispatch('timeupdate');
  assert.equal(h.pendingTimers(4000), 0);
  assert.equal(h.window.Player.playbackRequested(), true);
});
