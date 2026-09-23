const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

const devices = {
  iPhone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
  iPad: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 }
};

async function setup(navigator, hidden = false, options = {}) {
  const h = createHarness({ navigator, withStorage: true, withAudioSession: false,
    tracks: ['one', 'two', 'three'].map(id => ({ id, title: id })),
    settings: { autoplay: false, noYtFallback: true, crossfade: 4 }, ...options });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  if (options.fetchStreamBlob) h.Api.fetchStreamBlob = options.fetchStreamBlob;
  // Model a source change resetting the old resource's native endpoint.
  let source = h.audio.src;
  Object.defineProperty(h.audio, 'src', {
    get: () => source,
    set(value) { source = value; this.ended = false; this.currentTime = 0; }
  });
  // Only the element started by the listener has playback permission.
  const standby = h.audioElements[1];
  standby.play = function () {
    this.playCalls++;
    return Promise.reject(Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' }));
  };
  h.document.hidden = hidden;
  h.document.visibilityState = hidden ? 'hidden' : 'visible';
  h.audio.play = function () {
    const result = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return result;
  };
  h.play();
  await flushMicrotasks(60);
  return { ...h, standby };
}

for (const [device, navigator] of Object.entries(devices)) {
  for (const hidden of [false, true]) {
    test(device + ' advances consecutive songs on the permitted element ' + (hidden ? 'in background' : 'in foreground'), async () => {
      const h = await setup(navigator, hidden);
      for (const id of ['two', 'three']) {
        h.audio.currentTime = h.audio.duration;
        h.audio.ended = true;
        h.audio.paused = true;
        const calls = h.audio.playCalls;
        h.audio.dispatch('ended');
        assert.equal(h.audio.src, 'https://test/' + id, 'source changes inside the native callback');
        assert.equal(h.audio.playCalls, calls + 1);
        await flushMicrotasks(60);
        assert.equal(h.window.Player.current().id, id);
        assert.equal(h.window.Player.isPaused(), false);
        assert.equal(h.standby.playCalls, 0);
        h.audio.dispatch('pause');
        h.audio.dispatch('ended');
        assert.equal(h.window.Player.current().id, id);
      }
      h.window.Player.dismiss();
    });
  }
}

test('iPhone preserves the prepared song through the crossfade window', async () => {
  const h = await setup(devices.iPhone);
  h.audio.currentTime = h.audio.duration - 3;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(40);
  assert.equal(h.standby.playCalls, 0);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.audio.paused, false);
  h.audio.ended = true;
  h.audio.dispatch('ended');
  assert.equal(h.audio.src, 'https://test/two');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('iPhone manual Next reuses the permitted element and prepared source', async () => {
  const h = await setup(devices.iPhone);
  h.window.Player.next();
  assert.equal(h.audio.src, 'https://test/two');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.standby.playCalls, 0);
  h.window.Player.dismiss();
});

for (const event of ['playing', 'timeupdate']) {
  test('background ' + event + ' completes the transition while play promises and timers remain pending', async () => {
    const h = await setup(devices.iPhone, true);
    h.audio.play = function () {
      FakeAudio.prototype.play.call(this);
      return new Promise(() => {});
    };
    for (const id of ['two', 'three']) {
      h.audio.currentTime = h.audio.duration;
      h.audio.ended = true;
      h.audio.paused = true;
      h.audio.dispatch('ended');
      assert.equal(h.audio.src, 'https://test/' + id);
      h.audio.currentTime = event === 'timeupdate' ? 0.3 : 0;
      h.audio.dispatch(event);
      assert.equal(h.window.Player.current().id, id, 'commit within the native event');
      assert.equal(h.navigator.mediaSession.metadata.title, id);
      assert.equal(h.pendingTimers(9000), 0);
      await flushMicrotasks(60); // Only preparation, never a play completion or timer.
    }
    h.window.Player.dismiss();
  });
}

test('a resolved but silent iPhone play request cannot restart the old lock-screen clock', async () => {
  const h = await setup(devices.iPhone, true);
  const positions = [];
  h.navigator.mediaSession.setPositionState = value => positions.push(value);
  h.audio.play = FakeAudio.prototype.play;
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  assert.equal(h.window.Player.current().id, 'one', 'no success until native playback');
  assert.equal(h.navigator.mediaSession.playbackState, 'paused');
  assert.equal(positions.at(-1), undefined, 'old timeline must be cleared');
  assert.equal(h.pendingTimers(9000), 1, 'silent success retains recovery');
  h.audio.dispatch('timeupdate'); // Reset to zero is not playback progress.
  assert.equal(h.window.Player.current().id, 'one');
  h.audio.dispatch('playing');
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.navigator.mediaSession.playbackState, 'playing');
  h.window.Player.dismiss();
});

test('native canplay reasserts a stalled background request once without a timer or lookup', async () => {
  const h = await setup(devices.iPhone, true);
  let calls = 0;
  h.audio.play = function () {
    calls++;
    FakeAudio.prototype.play.call(this);
    if (calls === 2) this.dispatch('playing');
    return new Promise(() => {});
  };
  h.audio.ended = true;
  h.audio.dispatch('ended');
  assert.equal(calls, 1);
  h.audio.dispatch('canplay');
  assert.equal(calls, 2);
  assert.equal(h.window.Player.current().id, 'two');
  h.audio.dispatch('canplay');
  assert.equal(calls, 2);
  h.window.Player.dismiss();
});

test('a pause during a pending background transition prevents canplay from restarting audio', async () => {
  const h = await setup(devices.iPhone, true);
  h.audio.play = function () {
    FakeAudio.prototype.play.call(this);
    return new Promise(() => {});
  };
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.window.Player.pause();
  const calls = h.audio.playCalls;
  h.audio.dispatch('canplay');
  h.audio.dispatch('playing');
  assert.equal(h.audio.playCalls, calls);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.audio.paused, true);
  assert.equal(h.pendingTimers(9000), 0);
  h.window.Player.dismiss();
});

test('reopening after a suspended timeout recovers the next song without replaying the old one', async () => {
  let now = 1000;
  const h = await setup(devices.iPhone, true, { Date: class extends Date { static now() { return now; } } });
  h.audio.play = FakeAudio.prototype.play; // Resolves, but no native playback follows.
  h.audio.ended = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(40);
  const requests = [];
  h.Api.resolve = async id => { requests.push(id); return { url: 'https://test/' + id }; };
  h.audio.play = function () {
    const result = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return result;
  };
  now += 10000;
  h.document.hidden = false;
  h.document.visibilityState = 'visible';
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(80);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.paused, false);
  assert.equal(requests[0], 'two');
  assert.equal(requests.includes('one'), false);
  assert.equal(h.pendingTimers(9000), 0);
  h.window.Player.dismiss();
});

test('iPhone hands off from a locally saved next track without touching the network', async () => {
  const cache = new Map();
  const request = result => { const req = { result }; Promise.resolve().then(() => req.onsuccess?.()); return req; };
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction(name) {
      const map = name === 'cache' ? cache : new Map();
      const tx = { objectStore: () => ({
        get: id => request(map.get(id)),
        put: (value, id) => { map.set(id, value); return request(); },
        delete: id => { map.delete(id); return request(); }
      }) };
      Promise.resolve().then(() => tx.oncomplete?.());
      return tx;
    }
  };
  const fetched = [];
  const h = await setup(devices.iPhone, true, { storageDb,
    fetchStreamBlob: async id => { fetched.push(id); return new Blob(['audio ' + id]); } });
  await flushMicrotasks(120);
  assert.deepEqual(fetched, ['two'], 'only the next track is saved ahead');
  assert.equal(cache.has('two'), true);
  assert.equal(h.standby.src, '', 'no second element streams the same bytes on iOS');
  h.audio.currentTime = h.audio.duration;
  h.audio.ended = true;
  h.audio.paused = true;
  h.audio.dispatch('ended');
  assert.match(h.audio.src, /^blob:/, 'the permitted element starts from the local copy');
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.window.Player.isPaused(), false);
  h.window.Player.dismiss();
});

test('a background pause at the end of the playable range advances instead of sticking', async () => {
  const h = await setup(devices.iPhone, true);
  // The stream carried a hair less audio than the container promised: WebKit
  // pauses just shy of duration and `ended` never becomes true.
  h.audio.currentTime = h.audio.duration - 0.4;
  h.audio.paused = true;
  h.audio.dispatch('pause');
  assert.equal(h.audio.src, 'https://test/two', 'the next source starts inside the native callback');
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.window.Player.isPaused(), false);
  h.window.Player.dismiss();
});

test('a background pause in the middle of a song still holds as a platform pause', async () => {
  const h = await setup(devices.iPhone, true);
  h.audio.currentTime = 30;
  h.audio.paused = true;
  h.audio.dispatch('pause');
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'one');
  assert.notEqual(h.audio.src, 'https://test/two', 'no track switch on a mid-song pause');
  assert.equal(h.window.Player.playbackRequested(), true, 'listening intent survives the OS pause');
  assert.equal(h.audio.paused, true, 'no play() request that would steal focus back');
  h.window.Player.dismiss();
});

test('repeated canplay events cannot spin on a silent background source', async () => {
  const h = await setup(devices.iPhone, true);
  h.audio.play = FakeAudio.prototype.play;
  const calls = h.audio.playCalls;
  h.audio.ended = true;
  h.audio.dispatch('ended');
  for (let i = 0; i < 5; i++) h.audio.dispatch('canplay');
  await flushMicrotasks(40);
  assert.equal(h.audio.playCalls, calls + 2);
  assert.equal(h.window.Player.current().id, 'one');
  assert.equal(h.pendingTimers(9000), 1);
  h.window.Player.dismiss();
});

test('an in-app pause during a pending background transition lands on the next song, not the finished one', async () => {
  const h = await setup(devices.iPhone, true);
  const requests = [];
  h.Api.resolve = async id => { requests.push(id); return { url: 'https://test/' + id }; };
  h.audio.play = function () {
    FakeAudio.prototype.play.call(this);
    return new Promise(() => {});
  };
  h.audio.ended = true;
  h.audio.dispatch('ended');
  assert.equal(h.audio.src, 'https://test/two');
  h.window.Player.pause();
  assert.equal(h.window.Player.current().id, 'two', 'the pause belongs to the song being started');
  assert.equal(h.audio.src, 'https://test/two', 'the prepared source stays on the element');
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.pendingTimers(9000), 0);
  h.audio.play = function () {
    const result = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return result;
  };
  h.window.Player.toggle();
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.paused, false);
  assert.equal(requests.includes('one'), false, 'the finished song is not reloaded');
  h.window.Player.dismiss();
});
