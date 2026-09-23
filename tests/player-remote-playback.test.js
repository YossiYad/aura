const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

function setup(platform = 'airplay') {
  const downloads = new Map();
  const cache = new Map();
  const request = result => {
    const req = { result };
    Promise.resolve().then(() => req.onsuccess?.());
    return req;
  };
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name) {
      const map = name === 'tracks' ? downloads : cache;
      const tx = { objectStore: () => ({
        get: id => request(map.get(id)),
        delete: id => { map.delete(id); return request(); }
      }) };
      Promise.resolve().then(() => tx.oncomplete?.());
      return tx;
    }
  };
  const h = createHarness({ withAirPlay: platform === 'airplay', withRemote: platform === 'cast',
    withStorage: true, storageDb, exposeInternals: true,
    tracks: ['one', 'two', 'three'].map(id => ({ id, title: id, duration: 180 })),
    settings: { autoplay: false, crossfade: 4 } });
  const requests = [];
  h.Api.resolve = async (id, opts) => {
    requests.push({ id, remote: opts?.remote });
    return { url: 'https://test/' + id + (opts?.remote ? '.mp3' : '.webm') };
  };
  h.Api.invalidate = () => {};
  // This suite exercises conversion of device-local sources for the receiver.
  // Native handoff of an existing HTTP stream is covered by remote-route tests.
  h.audio.src = 'blob:download-one';
  const events = [];
  const P = h.window.Player;
  P.onChange(event => events.push(event));
  const route = state => {
    if (platform === 'airplay') {
      h.audio.webkitCurrentPlaybackTargetIsWireless = state === 'connected';
      h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
    } else {
      h.audio.remote.state = state;
      h.audio.remote.dispatch({ connected: 'connect', connecting: 'connecting', disconnected: 'disconnect' }[state]);
    }
  };
  return { ...h, P, route, requests, events, downloads, cache, standby: h.audioElements[1], I: h.window.__playerInternals };
}

for (const platform of ['airplay', 'cast']) {
  test(platform + ': connecting a local download replaces the blob without deleting it or losing position', async () => {
    const h = setup(platform);
    const blob = new Blob(['saved']);
    h.downloads.set('one', blob);
    h.audio.src = URL.createObjectURL(blob);
    h.audio.currentTime = 47;
    h.play();
    h.route('connected');
    await flushMicrotasks(40);
    assert.equal(h.audio.src, 'https://test/one.mp3');
    assert.equal(h.audio.currentTime, 47);
    assert.equal(h.audio.paused, false);
    assert.equal(h.downloads.get('one'), blob);
    assert.equal(h.P.current().id, 'one');
    assert.equal(h.P.remotePlaybackStatus().state, 'connected');
    assert.equal(h.audio.disableRemotePlayback, false);
    assert.equal(h.standby.disableRemotePlayback, true);
    h.P.dismiss();
  });

  test(platform + ': automatic and manual next retain the routed element and skip local cached sources', async () => {
    const h = setup(platform);
    h.cache.set('two', { blob: new Blob(['cached']) });
    h.downloads.set('three', new Blob(['downloaded']));
    h.play();
    h.route('connected');
    await flushMicrotasks(40);
    assert.equal(h.standby.src, '', 'a prepared TV URL must not load a second decoder');
    h.audio.currentTime = 179.5;
    h.audio.dispatch('timeupdate');
    await flushMicrotasks();
    assert.equal(h.standby.playCalls, 0, 'no crossfade on the TV');
    assert.equal(h.P.current().id, 'one');
    h.audio.ended = true;
    h.audio.dispatch('ended');
    await flushMicrotasks(40);
    assert.equal(h.audio.src, 'https://test/two.mp3');
    assert.equal(h.P.current().id, 'two');
    h.P.next();
    await flushMicrotasks(40);
    assert.equal(h.audio.src, 'https://test/three.mp3');
    assert.equal(h.P.current().id, 'three');
    assert.equal(h.standby.playCalls, 0);
    assert.equal(h.cache.has('two'), true);
    assert.equal(h.downloads.has('three'), true);
    h.P.dismiss();
  });

  test(platform + ': connecting while paused prepares the TV source without starting playback', async () => {
    const h = setup(platform);
    h.audio.currentTime = 63;
    h.route('connected');
    await flushMicrotasks(40);
    assert.equal(h.audio.src, 'https://test/one.mp3');
    assert.equal(h.audio.currentTime, 63);
    assert.equal(h.audio.playCalls, 0);
    assert.equal(h.P.isPaused(), true);
    h.P.dismiss();
  });

  test(platform + ': disconnect keeps the current source and re-enables local preparation', async () => {
    const h = setup(platform);
    h.play();
    h.route('connected');
    await flushMicrotasks(40);
    h.cache.set('two', { blob: new Blob(['local']) });
    h.audio.currentTime += 1;
    h.audio.dispatch('timeupdate'); // The converted source is now playing on the receiver.
    const source = h.audio.src;
    const calls = h.audio.playCalls;
    h.route('disconnected');
    await flushMicrotasks(40);
    assert.equal(h.audio.src, source);
    assert.equal(h.audio.playCalls, calls);
    assert.equal(h.P.remotePlaybackStatus().state, 'disconnected');
    assert.match(h.standby.src, /^blob:/);
    h.P.dismiss();
  });

  test(platform + ': source preparation and the native device picker use separate taps', async () => {
    const h = setup(platform);
    h.play();
    await h.P.requestRemotePlayback();
    assert.equal(h.audio.pickerCalls || h.audio.remote?.promptCalls || 0, 0);
    assert.ok(h.events.some(e => e.type === 'remote-ready'));
    const pending = h.P.requestRemotePlayback();
    assert.equal(h.audio.pickerCalls || h.audio.remote?.promptCalls, 1, 'picker called synchronously in the gesture');
    await pending;
    h.P.dismiss();
  });
}

test('a late TV source cannot overwrite a newly selected song', async () => {
  const h = setup();
  let resolveOld;
  const resolve = h.Api.resolve;
  h.Api.resolve = (id, opts) => id === 'one' ? new Promise(r => { resolveOld = r; }) : resolve(id, opts);
  h.play();
  h.route('connected');
  h.P.next();
  await flushMicrotasks(40);
  h.audio.dispatch('playing');
  h.runImmediateTimers();
  await flushMicrotasks(40);
  resolveOld({ url: 'https://test/old.mp3' });
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/two.mp3');
  assert.equal(h.P.current().id, 'two');
  h.P.dismiss();
});

test('an explicit pause cancels an in-flight TV source', async () => {
  const h = setup();
  let finish;
  h.Api.resolve = () => new Promise(r => { finish = r; });
  h.play();
  h.route('connected');
  h.P.pause();
  finish({ url: 'https://test/late.mp3' });
  await flushMicrotasks(40);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.src, '');
  assert.equal(h.P.playbackRequested(), false);
});

test('a TV preparation failure is visible, preserves downloads, and can be retried', async () => {
  const h = setup();
  const resolve = h.Api.resolve;
  h.Api.resolve = async () => { throw new Error('offline'); };
  h.downloads.set('one', new Blob(['saved']));
  h.play();
  h.route('connected');
  await flushMicrotasks(40);
  assert.equal(h.P.isPaused(), true);
  assert.ok(h.events.some(e => e.type === 'remote-error'));
  assert.equal(h.downloads.has('one'), true);
  h.Api.resolve = resolve;
  h.P.toggle();
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/one.mp3');
  assert.equal(h.audio.paused, false);
  h.P.dismiss();
});

test('an unavailable TV stream never starts an iframe or advances the queue', async () => {
  const h = setup();
  h.play();
  h.route('connected');
  await flushMicrotasks(40);
  h.Api.resolve = async () => { throw new Error('no compatible stream'); };
  h.P.jumpTo(2);
  await flushMicrotasks(60);
  assert.equal(h.P.current().id, 'three');
  assert.ok(h.events.some(e => e.type === 'remote-error'));
  assert.equal(h.events.some(e => e.type === 'fallback-yt' || e.type === 'fallback-skip'), false);
  assert.equal(h.P.isPaused(), true);
  h.P.dismiss();
});

test('metadata arriving after the TV source loads restores the listening position', async () => {
  const h = setup();
  h.audio.currentTime = 72;
  let src = h.audio.src;
  Object.defineProperty(h.audio, 'src', {
    get: () => src,
    set: value => { src = value; h.audio.currentTime = 0; h.audio.readyState = 0; }
  });
  h.route('connected');
  await flushMicrotasks(40);
  assert.equal(h.audio.currentTime, 0);
  h.audio.readyState = 1;
  h.audio.dispatch('loadedmetadata');
  assert.equal(h.audio.currentTime, 72);
  h.P.dismiss();
});

test('a native handoff pause resumes only after the route connects with active audio focus', async () => {
  const h = setup();
  h.play();
  h.audioSession.state = 'active';
  h.audio.pause();
  h.route('connected');
  await flushMicrotasks(40);
  assert.equal(h.audio.paused, false);
  h.P.dismiss();
});

test('connecting a TV during an interruption does not steal audio focus', async () => {
  const h = setup();
  h.play();
  h.audioSession.state = 'interrupted';
  h.audioSession.dispatch('statechange');
  h.audio.pause();
  const calls = h.audio.playCalls;
  h.route('connected');
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/one.mp3');
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.audio.paused, true);
  h.P.dismiss();
});

test('a connection during source lookup replaces the pending local-quality request', async () => {
  const h = setup();
  h.play();
  h.route('connected');
  await flushMicrotasks(40);
  h.audio.currentTime += 1;
  h.audio.dispatch('timeupdate');
  h.route('disconnected');
  await flushMicrotasks(40);
  let finishLocal;
  const resolve = h.Api.resolve;
  h.Api.resolve = (id, opts) => !opts?.remote ? new Promise(r => { finishLocal = r; }) : resolve(id, opts);
  h.P.jumpTo(2);
  await flushMicrotasks(40);
  h.route('connected');
  await flushMicrotasks(40);
  finishLocal({ url: 'https://test/local.webm' });
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/three.mp3');
  assert.equal(h.P.current().id, 'three');
  h.P.dismiss();
});

test('an unresponsive remote play request times out with a visible error', async () => {
  const h = setup();
  h.play();
  h.audio.play = () => new Promise(() => {});
  h.route('connected');
  await flushMicrotasks(40);
  assert.equal(h.P.remotePlaybackStatus().preparing, true);
  h.runTimers(9000);
  await flushMicrotasks(40);
  assert.equal(h.P.remotePlaybackStatus().preparing, false);
  assert.equal(h.P.isPaused(), true);
  assert.ok(h.events.some(e => e.type === 'remote-error'));
  h.P.dismiss();
});

for (const platform of ['airplay', 'cast']) {
  test(platform + ': preparing or closing a chooser without connecting leaves later songs in phone mode', async () => {
    const h = setup(platform);
    h.play();
    await h.P.requestRemotePlayback();
    await h.P.requestRemotePlayback();
    // These mock pickers return without granting a route, just like dismissing one.
    assert.equal(h.P.remotePlaybackStatus().state, 'disconnected');
    h.P.next();
    await flushMicrotasks(60);
    assert.equal(h.audio.src, 'https://test/two.webm');
    assert.equal(h.P.remotePlaybackStatus().preparing, false);
    h.P.dismiss();
  });
}
