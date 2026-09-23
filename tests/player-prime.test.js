const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

const iPhone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' };
const requested = { id: 'requested', title: 'Requested song', artist: 'Singer', duration: 180 };
const denied = () => Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });

// Model iOS element permission. A fresh <audio> element refuses play() until it has been
// played once from a user gesture - which is exactly what primeForPlayback does inside the
// request's opening tap. The first play() call stands in for that gesture: it spends the
// permission (so this attempt is still refused, as the real prime's is aborted) and every
// later programmatic play() on the element is then allowed. A permitted play dispatches
// 'playing' so playViaAudio's start wait resolves, as the other iOS player tests do.
function iosElement(audio) {
  let permitted = false;
  audio.play = function () {
    this.playCalls++;
    if (!permitted) { permitted = true; return Promise.reject(denied()); }
    const result = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return result;
  };
}

// An element that always plays, dispatching 'playing' - a device with no autoplay gate.
function freeElement(audio) {
  audio.play = function () {
    const result = FakeAudio.prototype.play.call(this);
    this.dispatch('playing');
    return result;
  };
}

function setup(navigator = iPhone) {
  const h = createHarness({ navigator, withStorage: true, withAudioSession: false,
    settings: { autoplay: true, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  const events = [];
  h.window.Player.onChange(e => events.push(e));
  // Start from an idle, empty element: the listener opened the app and went straight to AI.
  h.audio.pause();
  h.audio.removeAttribute('src');
  return { ...h, P: h.window.Player, events };
}

test('without priming, an iOS AI request is held for a Play tap (the reported bug)', async () => {
  const h = setup();
  iosElement(h.audio);
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.P.needsPlaybackGesture(), true, 'the resolved track waits for a manual tap');
  assert.equal(h.P.current().id, requested.id);
  assert.equal(h.audio.src, 'https://test/requested', 'the source and queue are kept');
  assert.ok(h.events.some(e => e.type === 'playback-permission'));
  assert.equal(h.events.some(e => e.type === 'track'), false);
});

test('priming inside the request tap starts the iOS AI play with no manual tap', async () => {
  const h = setup();
  iosElement(h.audio);
  h.P.primeForPlayback();
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.P.needsPlaybackGesture(), false, 'playback started rather than waiting for a tap');
  assert.equal(h.P.current().id, requested.id);
  assert.equal(h.audio.paused, false);
  assert.equal(h.events.filter(e => e.type === 'track').length, 1);
  assert.equal(h.events.some(e => e.type === 'playback-permission'), false);
});

test('priming leaves no source on the element, so the microphone is not starved', () => {
  const h = setup();
  iosElement(h.audio);
  h.P.primeForPlayback();
  assert.equal(h.audio.src, '', 'the silent prime clip is detached synchronously');
  assert.equal(h.audio.paused, true);
  assert.ok(h.logs.some(l => l.tag === 'play' && /primed the audio element/.test(l.message)));
});

test('releaseForVoice primes even with nothing loaded, so the voice path plays without a tap', async () => {
  const h = setup();
  iosElement(h.audio);
  // The mic tap releases for capture; with an empty player it still hands over permission.
  h.P.releaseForVoice();
  assert.equal(h.audio.src, '', 'the element stays clear for the microphone');
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.P.needsPlaybackGesture(), false);
  assert.equal(h.P.current().id, requested.id);
  assert.equal(h.audio.paused, false);
});

test('priming never interrupts or replaces a source that is already playing', async () => {
  const h = setup();
  iosElement(h.audio);
  h.P.primeForPlayback();
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.audio.paused, false);
  const srcBefore = h.audio.src;
  const pauseCallsBefore = h.audio.pauseCalls;
  h.P.primeForPlayback();
  assert.equal(h.audio.src, srcBefore, 'the playing stream is not replaced by the prime clip');
  assert.equal(h.audio.pauseCalls, pauseCallsBefore, 'playback is not paused');
  assert.equal(h.audio.paused, false);
});

test('priming is a no-op on Android, which starts AI playback on its own', async () => {
  const h = setup(android);
  freeElement(h.audio);
  h.P.primeForPlayback();
  assert.equal(h.audio.playCalls, 0, 'no silent play on Android');
  assert.equal(h.audio.src, '', 'no prime source set on Android');
  assert.equal(h.logs.some(l => /primed the audio element/.test(l.message)), false);
  h.P.playQueue([requested], 0);
  await flushMicrotasks(70);
  assert.equal(h.P.needsPlaybackGesture(), false, 'Android plays without any priming');
  assert.equal(h.P.current().id, requested.id);
});
