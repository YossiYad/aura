const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

const tracks = [{ id: 'one', title: 'One', duration: 180 }, { id: 'two', title: 'Two', duration: 180 }];

function setup(settings, options = {}) {
  const h = createHarness({
    tracks: tracks.map(track => ({ ...track })),
    withStorage: false,
    exposeInternals: true,
    withAudioSession: false,
    ...options,
    settings: Object.assign({ autoplay: false, noYtFallback: true }, settings)
  });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, base: 'https://test' });
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  return Object.assign(h, { standby: h.audioElements[1], internals: h.window.__playerInternals });
}

test('the native picker opens in the tap without replacing a playing HTTP source', async () => {
  const h = setup({}, { withAirPlay: true });
  h.play();
  await flushMicrotasks(40);
  const source = h.audio.src, calls = h.audio.playCalls;
  await h.window.Player.requestRemotePlayback();
  assert.equal(h.audio.pickerCalls, 1);
  assert.equal(h.audio.src, source);
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});

for (const reported of ['connecting', 'connected']) {
  test('Safari local output ignores a conflicting Remote Playback ' + reported + ' state', async () => {
    let now = 1000000;
    const h = setup({}, { withAirPlay: true, withAudioSession: true, Date: { now: () => now } });
    delete h.audioSession.state;
    h.play();
    await flushMicrotasks(40);
    const source = h.audio.src;
    h.audio.currentTime = 75.08;
    h.audio.remote.state = reported;
    h.audio.remote.dispatch(reported === 'connecting' ? 'connecting' : 'connect');
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
    h.document.hidden = true;
    h.document.dispatch('visibilitychange');
    h.audio.pause();
    h.audioSession.dispatch('statechange');
    h.runTimers(500);
    now += 8216;
    h.audio.play();
    h.audioSession.dispatch('statechange');
    const calls = h.audio.playCalls;
    h.runTimers(1000);
    await flushMicrotasks();
    assert.equal(h.audio.playCalls, calls + 1, 'a phantom TV route must not disable interruption recovery');
    assert.equal(h.audio.src, source);
    assert.equal(h.audio.currentTime, 75.08);
    assert.equal(h.document.hidden, true);
    h.window.Player.dismiss();
  });
}

test('Safari ignores a phantom connection before a local blob is replaced', async () => {
  const h = setup({}, { withAirPlay: true });
  h.audio.src = 'blob:downloaded-song';
  const requests = [];
  h.Api.resolve = async (id, options) => { requests.push({ id, remote: options.remote }); return { url: 'https://test/' + id }; };
  h.play();
  await flushMicrotasks(40);
  requests.length = 0;
  h.audio.remote.state = 'connecting';
  h.audio.remote.dispatch('connecting');
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'blob:downloaded-song');
  assert.equal(requests.some(request => request.id === 'one'), false);
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
  h.window.Player.dismiss();
});

test('actual AirPlay output still takes priority and releases a stale generic route on disconnect', async () => {
  const h = setup({}, { withAirPlay: true });
  h.play();
  await flushMicrotasks(40);
  h.audio.remote.state = 'connecting';
  connectAirPlay(h);
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
  h.audio.webkitCurrentPlaybackTargetIsWireless = false;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
  const calls = h.audio.playCalls;
  h.runTimers(2500);
  h.runTimers(4000);
  await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, calls, 'disconnect cancels the remote handoff recovery');
  h.window.Player.dismiss();
});

for (const state of [undefined, 'active']) {
  test('a hidden connecting/connected handoff resumes the same source with audio-session state ' + state, async () => {
    const h = setup({}, { withAudioSession: true });
    h.audioSession.state = state;
    h.play();
    await flushMicrotasks(40);
    const source = h.audio.src;
    h.audio.currentTime = 14;
    h.document.hidden = true;
    h.document.visibilityState = 'hidden';
    h.document.dispatch('visibilitychange');
    h.audio.remote.state = 'connecting';
    h.audio.remote.dispatch('connecting');
    h.audio.pause();
    h.audioSession.dispatch('statechange');
    connectRemotePlayback(h);
    h.runTimers(2500);
    await flushMicrotasks(40);
    assert.equal(h.audio.paused, false);
    assert.equal(h.audio.src, source);
    assert.equal(h.audio.currentTime, 14);
    h.audio.currentTime = 17;
    h.runTimers(4000);
    await flushMicrotasks(40);
    assert.equal(h.audio.src, source);
    assert.equal(h.audio.currentTime, 17);
    assert.equal(h.audio.playCalls, 2, 'only resume the handoff pause');
    h.window.Player.dismiss();
  });
}

for (const state of ['inactive', 'interrupted']) {
  test('wireless handoff cannot reclaim a session that reports ' + state, async () => {
    const h = setup({}, { withAudioSession: true });
    h.audioSession.state = 'active';
    h.play();
    await flushMicrotasks(40);
    connectAirPlay(h);
    h.audioSession.state = state;
    h.audioSession.dispatch('statechange');
    h.audio.pause();
    const calls = h.audio.playCalls;
    h.runTimers(2500);
    h.runTimers(4000);
    await flushMicrotasks(40);
    assert.equal(h.audio.playCalls, calls);
    assert.equal(h.audio.paused, true);
    h.window.Player.dismiss();
  });
}

test('a media control Pause cancels handoff recovery even when session state is unavailable', async () => {
  const h = setup({}, { withAudioSession: true });
  h.audioSession.state = undefined;
  h.play();
  await flushMicrotasks(40);
  connectAirPlay(h);
  h.actions.get('pause')();
  h.runTimers(500);
  const calls = h.audio.playCalls;
  h.runTimers(2500);
  h.runTimers(4000);
  await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.window.Player.playbackRequested(), false);
  h.window.Player.dismiss();
});

test('a source reattachment that reconnects AirPlay happens once and never skips into the queue', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = setup({}, { Date: Clock });
  const events = [];
  h.window.Player.onChange(event => events.push(event));
  h.play();
  await flushMicrotasks(40);
  let source = h.audio.src, assignments = 0;
  Object.defineProperty(h.audio, 'src', {
    get: () => source,
    set: value => {
      source = value;
      assignments++;
      h.audio.currentTime = 0;
      h.audio.readyState = 0;
      h.audio.webkitCurrentPlaybackTargetIsWireless = false;
      h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
      connectAirPlay(h);
    }
  });
  h.audio.currentTime = 14;
  connectAirPlay(h);
  h.runTimers(2500);
  h.runTimers(4000);
  await flushMicrotasks(40);
  h.audio.readyState = 1;
  h.audio.dispatch('loadedmetadata');
  assert.equal(h.audio.currentTime, 14);
  assert.equal(assignments, 1);
  assert.equal(h.window.Player.current().id, 'one');
  // Route notifications can arrive after the asynchronous source load completes.
  h.audio.webkitCurrentPlaybackTargetIsWireless = false;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  connectAirPlay(h);
  for (let attempt = 0; attempt < 3; attempt++) {
    now += 20000;
    h.runTimers(2500);
    h.runTimers(4000);
    h.runIntervals(5000);
    h.runImmediateTimers();
    await flushMicrotasks(40);
  }
  assert.equal(assignments, 1, 'no repeated reconnection or loading another song');
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.currentTime, 14);
  assert.equal(h.audio.paused, true);
  assert.equal(events.filter(event => event.type === 'remote-error').length, 1);
  h.window.Player.dismiss();
});

test('failed local-source conversion does not arm another automatic handoff attempt', async () => {
  const h = setup();
  h.audio.src = 'blob:saved-track';
  let lookups = 0;
  h.Api.resolve = async () => { lookups++; throw new Error('offline'); };
  h.play();
  await flushMicrotasks(40);
  const before = lookups;
  connectAirPlay(h);
  await flushMicrotasks(40);
  for (const delay of [2500, 4000, 8000]) h.runTimers(delay);
  await flushMicrotasks(40);
  assert.equal(lookups, before + 1);
  assert.equal(h.audio.paused, true);
  h.window.Player.dismiss();
});

test('a handoff timer delivered after background suspension cannot restart the TV', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = setup({}, { Date: Clock });
  h.play();
  await flushMicrotasks(40);
  const source = h.audio.src, calls = h.audio.playCalls;
  connectAirPlay(h);
  h.audio.pause();
  now += 30000;
  h.runTimers(2500);
  h.runTimers(4000);
  await flushMicrotasks(40);
  assert.equal(h.audio.src, source);
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.window.Player.current().id, 'one');
  h.window.Player.dismiss();
});

test('a receiver media error holds the song and only an explicit Play resolves a replacement', async () => {
  const h = setup();
  const requested = [], events = [];
  h.Api.resolve = async (id, options) => {
    requested.push({ id, remote: options.remote });
    return { url: 'https://test/' + id };
  };
  h.window.Player.onChange(event => events.push(event));
  h.play();
  await flushMicrotasks(40);
  connectAirPlay(h);
  h.audio.currentTime = 14;
  h.audio.error = { code: 4 };
  h.audio.dispatch('error');
  for (const delay of [2500, 4000, 8000, 10000, 20000, 60000]) h.runTimers(delay);
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, true);
  assert.equal(requested.filter(request => request.id === 'one').length, 0);
  assert.equal(events.filter(event => event.type === 'remote-error').length, 1);
  h.audio.error = null;
  h.play();
  await flushMicrotasks(40);
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.currentTime, 14);
  assert.deepEqual(requested.filter(request => request.id === 'one'), [{ id: 'one', remote: true }]);
  h.window.Player.dismiss();
});

test('route events while the next receiver stream starts do not replace its in-flight load', async () => {
  const h = setup();
  const requested = [];
  h.Api.resolve = async id => { requested.push(id); return { url: 'https://test/' + id }; };
  h.play();
  await flushMicrotasks(40);
  connectAirPlay(h);
  // Make the next selection resolve normally instead of using a prepared next track.
  h.window.Player.addToQueue({ id: 'three', title: 'Three', duration: 180 });
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', {
    get: () => source,
    set: value => {
      source = value;
      if (!value) return;
      h.audio.webkitCurrentPlaybackTargetIsWireless = false;
      h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
      connectAirPlay(h);
    }
  });
  h.window.Player.jumpTo(2);
  await flushMicrotasks(40);
  h.audio.dispatch('playing');
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/three');
  assert.equal(requested.filter(id => id === 'three').length, 1);
  assert.equal(h.window.Player.current().id, 'three');
  h.window.Player.dismiss();
});

test('AirPlay connecting as the first local HTTP source is attached does not resolve it again', async () => {
  const h = setup({}, { withAudioSession: true });
  h.audioSession.state = undefined;
  const requests = [], events = [];
  h.window.Player.onChange(event => events.push(event));
  h.Api.resolve = async (id, options) => {
    requests.push({ id, remote: options.remote });
    return { url: 'https://test/' + id + (options.remote ? '.m4a' : '.webm'), duration: 213 };
  };
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', {
    get: () => source,
    set: value => {
      source = value;
      h.audio.currentTime = 0;
      h.audio.readyState = 0;
      if (!value) return;
      h.audio.remote.state = 'connecting';
      h.audio.remote.dispatch('connecting');
    }
  });
  h.window.Player.playQueue([{ id: 'first', title: 'First', duration: 213 }]);
  await flushMicrotasks(40);
  connectRemotePlayback(h);
  h.audio.readyState = 4;
  h.audio.dispatch('playing');
  await flushMicrotasks(40);
  assert.deepEqual(requests, [{ id: 'first', remote: false }]);
  assert.equal(h.audio.src, 'https://test/first.webm');
  assert.equal(events.filter(event => event.type === 'track').length, 1, 'the initial load still completes');
  h.audio.pause();
  h.runTimers(2500);
  await flushMicrotasks(40);
  assert.equal(h.audio.paused, false, 'the completed load arms handoff recovery');
  assert.equal(h.audio.src, 'https://test/first.webm');
  h.window.Player.dismiss();
});

for (const action of ['disconnect', 'next']) {
  test(action + ' invalidates the previous handoff recovery', async () => {
    const h = setup();
    h.play();
    await flushMicrotasks(40);
    connectAirPlay(h);
    if (action === 'next') h.window.Player.next();
    else {
      h.audio.webkitCurrentPlaybackTargetIsWireless = false;
      h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
    }
    await flushMicrotasks(40);
    const source = h.audio.src, calls = h.audio.playCalls;
    h.runTimers(2500);
    h.runTimers(4000);
    await flushMicrotasks(40);
    assert.equal(h.audio.src, source);
    assert.equal(h.audio.playCalls, calls);
    h.window.Player.dismiss();
  });
}

// The route is granted per element, and the picker hands it to whichever one is playing.
function connectAirPlay(h) {
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
}

function connectRemotePlayback(h) {
  h.audio.remote.state = 'connected';
  h.audio.remote.dispatch('connect');
}

async function delayedAirPlayTransition() {
  let now = 1000000;
  const h = setup({}, {
    withAirPlay: true, withAudioContext: true,
    navigator: { userAgent: 'iPhone' }, Date: { now: () => now },
    tracks: [...tracks, { id: 'three', title: 'Three', duration: 180 }]
  });
  h.play();
  h.audioContexts[0].setState('running');
  await flushMicrotasks(40);
  connectAirPlay(h);
  await flushMicrotasks(40);
  const context = h.audioContexts[0], resumes = context.resumeCalls;
  const assignments = [], requests = [];
  h.Api.resolve = async (id, options) => {
    requests.push({ id, remote: options.remote });
    return { url: 'https://test/' + id };
  };
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', {
    get: () => source,
    set: value => {
      source = value;
      assignments.push(value);
      h.audio.currentTime = 0;
      h.audio.readyState = 0;
      h.audio.duration = NaN;
      h.audio.webkitCurrentPlaybackTargetIsWireless = false;
      h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
    }
  });
  return Object.assign(h, { context, resumes, assignments, requests,
    advance(ms) { now += ms; },
    reconnect() {
      h.audio.readyState = 4;
      h.audio.duration = 180;
      h.audio.dispatch('loadedmetadata');
      connectAirPlay(h);
      h.audio.dispatch('playing');
    }
  });
}

for (const prepared of [true, false]) {
  test('AirPlay source change keeps the helper quiet until the receiver returns: prepared=' + prepared, async () => {
    const h = await delayedAirPlayTransition();
    if (prepared) h.window.Player.next();
    else h.window.Player.jumpTo(2);
    await flushMicrotasks(40);
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
    assert.equal(h.context.resumeCalls, h.resumes, 'a source reset must not reclaim the local audio session');
    h.audio.remote.state = 'connecting';
    h.audio.remote.dispatch('connecting');
    h.audio.dispatch('timeupdate');
    h.advance(5500);
    h.runTimers(2500);
    h.runTimers(4000);
    await flushMicrotasks(40);
    assert.equal(h.assignments.length, 1, 'the pending receiver source must not be reattached');
    h.reconnect();
    await flushMicrotasks(40);
    assert.equal(h.window.Player.current().id, prepared ? 'two' : 'three');
    assert.equal(h.audio.src, 'https://test/' + (prepared ? 'two' : 'three'));
    assert.equal(h.audio.paused, false);
    assert.equal(h.context.resumeCalls, h.resumes);
    assert.equal(h.requests.some(request => !request.remote), false, 'prefetch stays in receiver mode');
    assert.equal(h.audio.pickerCalls || 0, 0, 'the route remains under native control');
    h.window.Player.dismiss();
  });
}

for (const reconnect of [true, false]) {
  test('Pause during an AirPlay song transition stays paused: reconnect=' + reconnect, async () => {
    const h = await delayedAirPlayTransition();
    // Keep the native play promise pending, as it is while the TV loads the song.
    h.audio.play = () => { h.audio.playCalls++; h.audio.paused = false; return new Promise(() => {}); };
    h.window.Player.next();
    h.window.Player.pause();
    const plays = h.audio.playCalls;
    if (reconnect) h.reconnect();
    h.advance(10000);
    h.runTimers(9000);
    h.runTimers(2500);
    h.runTimers(4000);
    await flushMicrotasks(40);
    assert.equal(h.window.Player.current().id, 'two');
    assert.equal(h.audio.paused, true);
    assert.equal(h.window.Player.playbackRequested(), false);
    assert.equal(h.audio.playCalls, plays);
    assert.equal(h.context.resumeCalls, h.resumes);
    assert.equal(h.window.Player.remotePlaybackStatus().state, reconnect ? 'connected' : 'disconnected');
    h.window.Player.dismiss();
  });
}

test('a real disconnect during a source change returns to local output after the bounded wait', async () => {
  const h = await delayedAirPlayTransition();
  h.window.Player.next();
  await flushMicrotasks(40);
  const plays = h.audio.playCalls;
  assert.equal(h.context.resumeCalls, h.resumes);
  h.advance(10000);
  h.runTimers(9000);
  await flushMicrotasks(40);
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
  assert.equal(h.context.resumeCalls, h.resumes + 1);
  assert.equal(h.audio.playCalls, plays, 'reconciliation does not issue another play request');
  assert.equal(h.window.Player.current().id, 'two');
  assert.deepEqual(h.assignments, ['https://test/two']);
  h.window.Player.dismiss();
});

test('rapid Next during a receiver transition keeps both selections on the routed element', async () => {
  const h = await delayedAirPlayTransition();
  h.window.Player.next();
  await flushMicrotasks(40);
  h.advance(2000);
  h.window.Player.next();
  await flushMicrotasks(40);
  h.reconnect();
  await flushMicrotasks(40);
  h.advance(10000);
  h.runTimers(9000);
  assert.equal(h.window.Player.current().id, 'three');
  assert.deepEqual(h.assignments, ['https://test/two', 'https://test/three']);
  assert.equal(h.context.resumeCalls, h.resumes);
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
  assert.equal(h.standby.src, '');
  h.window.Player.dismiss();
});

test('a delayed AirPlay route reset after source assignment still keeps the helper suspended', async () => {
  const h = setup({}, { withAirPlay: true, withAudioContext: true, navigator: { userAgent: 'iPhone' } });
  h.play();
  h.audioContexts[0].setState('running');
  await flushMicrotasks(40);
  connectAirPlay(h);
  await flushMicrotasks(40);
  const resumes = h.audioContexts[0].resumeCalls;
  h.window.Player.next();
  await flushMicrotasks(40);
  h.audio.webkitCurrentPlaybackTargetIsWireless = false;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
  assert.equal(h.audioContexts[0].resumeCalls, resumes);
  connectAirPlay(h);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('an expired source-change grace period is reconciled when the page returns before its timer', async () => {
  const h = await delayedAirPlayTransition();
  h.window.Player.next();
  await flushMicrotasks(40);
  h.advance(30000);
  h.window.dispatch('pageshow');
  assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
  assert.equal(h.context.resumeCalls, h.resumes + 1);
  h.runTimers(9000);
  assert.equal(h.context.resumeCalls, h.resumes + 1, 'the stale timer cannot restart recovery');
  h.window.Player.dismiss();
});

test('source conversion still recovers a pause when the AirPlay route stays connected', async () => {
  const h = setup({}, { withAirPlay: true });
  h.audio.src = 'blob:downloaded-song';
  h.play();
  await flushMicrotasks(40);
  connectAirPlay(h);
  await flushMicrotasks(40);
  h.audio.pause();
  const calls = h.audio.playCalls;
  h.runTimers(2500);
  await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, calls + 1);
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.src, 'https://test/one');
  h.window.Player.dismiss();
});

test('the next track starts on the element the AirPlay route is on', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(40);
  connectAirPlay(h);
  h.window.Player.next();
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  // Silence on the television is the standby element playing a track nobody routed.
  assert.equal(h.standby.src, '');
  assert.equal(h.audio.paused, false);
});

test('a track prepared ahead never loads into the element off the route', async () => {
  const h = setup();
  connectAirPlay(h);
  h.play();
  await flushMicrotasks(40);
  assert.equal(h.standby.src, '');
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.standby.src, '');
});

test('a crossfade does not start a second element while a route is connected', async () => {
  const h = setup({ crossfade: 6 });
  connectAirPlay(h);
  h.play();
  await flushMicrotasks(40);
  h.audio.duration = 180;
  h.audio.currentTime = 177;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(40);
  assert.equal(h.standby.src, '');
  assert.equal(h.standby.playCalls, 0);
});

test('Chromecast through the Remote Playback API keeps playback on one element', async () => {
  const h = setup({ crossfade: 6 });
  h.play();
  await flushMicrotasks(40);
  connectRemotePlayback(h);
  h.window.Player.next();
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.standby.src, '');
  assert.equal(h.standby.playCalls, 0);
});

test('a preparation already loaded on the standby element is given back when a route arrives', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(40);
  h.internals.keepPreparedSource({ ni: 1, id: 'two', src: 'https://test/two' });
  assert.equal(h.standby.src, 'https://test/two');
  connectAirPlay(h);
  assert.equal(h.standby.src, '');
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.standby.src, '');
});

test('the pause a mid-song route change causes is resumed, not read as an interruption', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(40);
  h.audio.currentTime = 40;
  connectAirPlay(h);
  // Safari pauses the element while the route moves.
  h.audio.pause();
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);
  const src = h.audio.src;
  h.runTimers(2500);
  await flushMicrotasks(40);
  assert.equal(h.audio.paused, false);
  // Resumed where it was, rather than reloaded from the top.
  assert.equal(h.audio.src, src);
  assert.equal(h.audio.currentTime, 40);
});

test('a song left silent by the route change is handed its source again at its place', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(40);
  // A real element starts its source over from nothing every time one is handed to it.
  let src = 'https://test/one';
  Object.defineProperty(h.audio, 'src', {
    get: () => src,
    set: value => { src = value; h.audio.currentTime = 0; }
  });
  h.audio.currentTime = 40;
  connectAirPlay(h);
  h.runTimers(2500);
  await flushMicrotasks(40);
  // Playing, yet the position has not moved since the route changed.
  assert.equal(h.audio.paused, false);
  h.runTimers(4000);
  await flushMicrotasks(40);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/one');
  assert.equal(h.audio.currentTime, 40);
  assert.equal(h.audio.playCalls > 1, true);
  assert.equal(h.window.Player.current().id, 'one');
});

test('progress after the route change leaves the playing song alone', async () => {
  const h = setup();
  h.play();
  await flushMicrotasks(40);
  h.audio.currentTime = 40;
  connectAirPlay(h);
  const plays = h.audio.playCalls;
  h.audio.currentTime = 43;
  h.runTimers(2500);
  await flushMicrotasks(40);
  h.audio.currentTime = 47;
  h.runTimers(4000);
  await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, plays);
  assert.equal(h.audio.currentTime, 47);
});

for (const platform of ['AirPlay', 'Remote Playback']) {
  test(platform + ': a system route selected while frozen is detected on return without opening the menu', async () => {
    const h = setup();
    h.play();
    await flushMicrotasks(40);
    h.document.hidden = true;
    h.audio.currentTime = 52;
    if (platform === 'AirPlay') h.audio.webkitCurrentPlaybackTargetIsWireless = true;
    else h.audio.remote.state = 'connected';
    // The browser did not deliver a route event while the page was suspended.
    h.document.hidden = false;
    h.document.dispatch('visibilitychange');
    await flushMicrotasks(60);
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
    assert.equal(h.audio.currentTime, 52);
    assert.equal(h.standby.src, '');
    h.window.Player.next();
    await flushMicrotasks(40);
    assert.equal(h.audio.src, 'https://test/two');
    assert.equal(h.standby.src, '');
    if (platform === 'AirPlay') h.audio.webkitCurrentPlaybackTargetIsWireless = false;
    else h.audio.remote.state = 'disconnected';
    h.window.dispatch('pageshow');
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
    h.window.Player.dismiss();
  });
}
