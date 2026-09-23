const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

function setup(ids = ['one', 'broken', 'three'], options = {}) {
  const tracks = ids.map(id => ({ id, title: id, duration: 180 }));
  const h = createHarness({ tracks, withStorage: true, withAudioSession: false,
    settings: { autoplay: false, noYtFallback: true, crossfade: 0 }, ...options });
  const P = h.window.Player, events = [], requests = [];
  const broken = new Set(['broken']);
  h.Api.resolve = async id => {
    requests.push(id);
    if (broken.has(id)) throw new Error('Video unavailable');
    return { url: 'https://test/' + id };
  };
  h.Api.invalidate = () => {};
  P.onChange(event => events.push(event));
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  h.play();
  return { ...h, P, events, requests, broken, tracks };
}

test('a failed next song advances in the background without UI listeners or timers', async () => {
  const h = setup();
  h.audio.ended = true;
  h.audio.dispatch('ended');
  h.audio.ended = false;
  await flushMicrotasks(120);
  assert.equal(h.P.current().id, 'three');
  assert.equal(h.P.isPaused(), false);
  assert.equal(h.audio.src, 'https://test/three');
  assert.equal(h.events.filter(e => e.type === 'fallback-skip').length, 1);
  assert.equal(h.pendingTimers(2000), 0, 'the failed song cannot retry after advancing');
});

test('a run of unavailable songs reaches the next playable song without timer callbacks', async () => {
  const h = setup(['one', 'broken', 'bad2', 'bad3', 'bad4', 'bad5', 'bad6', 'good']);
  for (const id of ['bad2', 'bad3', 'bad4', 'bad5', 'bad6']) h.broken.add(id);
  h.P.next();
  await flushMicrotasks(300);
  assert.equal(h.P.current().id, 'good');
  assert.equal(h.P.isPaused(), false);
});

for (const action of ['pause', 'replace', 'offline']) {
  test(action + ' during failure notification invalidates automatic advancement', async () => {
    const h = setup();
    h.P.onChange(event => {
      if (event.type !== 'fallback-skip') return;
      if (action === 'pause') h.P.pause();
      if (action === 'replace') h.P.playQueue([{ id: 'selected', title: 'Selected' }]);
      if (action === 'offline') h.navigator.onLine = false;
    });
    h.P.next();
    await flushMicrotasks(120);
    assert.equal(h.P.current().id, action === 'replace' ? 'selected' : 'broken');
    assert.equal(h.requests.includes('three'), false);
    if (action === 'pause') assert.equal(h.P.playbackRequested(), false);
  });
}

test('a server outage holds the next song and retries it instead of skipping the queue', async () => {
  const h = setup();
  h.Api.resolve = async () => { throw Object.assign(new Error('Servers down'), { outage: true }); };
  h.P.next();
  await flushMicrotasks(100);
  assert.equal(h.P.current().id, 'broken');
  assert.equal(h.events.some(e => e.type === 'source-outage'), true);
  assert.equal(h.pendingTimers(2000), 1);
});

test('an exhausted failed queue retains a bounded retry without spinning', async () => {
  const h = setup(['broken', 'bad2']);
  h.broken.add('bad2');
  h.P.playQueue(h.tracks);
  h.P.cycleRepeat();
  assert.equal(h.P.repeat(), 'all');
  await flushMicrotasks(200);
  assert.equal(h.P.current().id, 'bad2');
  assert.equal(h.pendingTimers(2000), 1);
  const count = h.requests.length;
  await flushMicrotasks(200);
  assert.equal(h.requests.length, count);
});

test('an incoming audio interruption cancels advancement queued by a failure', async () => {
  const h = setup(undefined, { withAudioSession: true });
  h.audioSession.state = 'active';
  h.P.onChange(event => {
    if (event.type !== 'fallback-skip') return;
    h.audioSession.state = 'interrupted';
    h.audioSession.dispatch('statechange');
  });
  h.P.next();
  await flushMicrotasks(120);
  assert.equal(h.P.current().id, 'broken');
  assert.equal(h.requests.includes('three'), false);
});

test('permission denial during stream-error recovery holds the song for a Play tap', async () => {
  const h = setup();
  h.audio.play = () => Promise.reject(Object.assign(new Error('Tap required'), { name: 'NotAllowedError' }));
  h.audio.error = { code: 2 };
  h.audio.dispatch('error');
  await flushMicrotasks(120);
  assert.equal(h.P.current().id, 'one');
  assert.equal(h.P.needsPlaybackGesture(), true);
  assert.equal(h.events.some(e => e.type === 'fallback-skip'), false);
});
