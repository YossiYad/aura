const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');
const { castSdk } = require('./cast-sdk-harness');

const track = id => ({ id, title: id, duration: 180 });

function setup(options = {}) {
  const h = createHarness({ tracks: [track('one')], withAudioSession: false,
    settings: { autoplay: false, noYtFallback: true, crossfade: 0, skipSegments: true }, ...options });
  h.Api.resolve = async id => ({ url: 'https://test/' + id, base: 'https://test' });
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  for (const audio of h.audioElements) {
    const play = audio.play;
    audio.play = function () { const result = play.call(this); this.dispatch('playing'); return result; };
  }
  return { ...h, P: h.window.Player };
}

test('timeupdate during a new load cannot apply the previous song skip segments', async () => {
  const h = setup();
  h.Api.getSkipSegments = async id => id === 'one' ? [{ start: 0, end: 15, category: 'intro' }] : [];
  h.P.playQueue([track('one')]);
  await flushMicrotasks(80);
  h.audio.currentTime = 1;
  h.audio.dispatch('timeupdate');
  assert.equal(h.audio.currentTime, 15, 'the current song still skips its own intro');
  h.P.playQueue([track('two')]);
  h.audio.currentTime = 0;
  h.audio.dispatch('timeupdate');
  assert.equal(h.audio.currentTime, 0, 'a source reset is not an intro in the new song');
  await flushMicrotasks(80);
  h.audio.currentTime = 1;
  h.audio.dispatch('timeupdate');
  assert.equal(h.audio.currentTime, 1);
  h.P.dismiss();
});

test('an alternate upload uses and remembers its own loudness', async () => {
  const h = setup();
  h.Api.resolve = async id => ({ url: 'https://test/' + id, loudnessDb: id === 'one' ? 12 : 2 });
  h.Api.findVersions = async () => [track('alternate')];
  const play = h.audio.play;
  h.audio.play = function () {
    return this.src.endsWith('/one') ? Promise.reject(new Error('Bad stream')) : play.call(this);
  };
  h.P.playQueue([track('one')]);
  await flushMicrotasks(160);
  assert.equal(h.P.current().id, 'alternate');
  assert.equal(h.P.isPaused(), false);
  assert.ok(Math.abs(h.audio.volume - Math.pow(10, -2 / 20)) < 1e-9);
  assert.equal(JSON.parse(h.savedLocal.get('aura.streamLoudness')).alternate, 2);
  h.P.dismiss();
});

test('playback failover tries another server when the fastest server returns an unplayable stream', async () => {
  const h = setup();
  const sources = [];
  h.Api.resolve = async (id, options) => {
    const base = options.avoid && options.avoid.has('https://fast') ? 'https://working' : 'https://fast';
    sources.push(base);
    return { base, url: base + '/' + id };
  };
  const play = h.audio.play;
  h.audio.play = function () {
    return this.src.startsWith('https://fast/') ? Promise.reject(new Error('HTTP 403')) : play.call(this);
  };
  h.P.playQueue([track('one')]);
  await flushMicrotasks(160);
  assert.equal(h.audio.src, 'https://working/one');
  assert.equal(h.P.isPaused(), false);
  assert.deepEqual(sources, ['https://fast', 'https://working']);
  h.P.dismiss();
});

test('one Play after cancelling TV preparation starts a fresh load and ignores the old result', async () => {
  const receiver = castSdk();
  const h = setup({ castSdk: receiver.sdk });
  h.audio.currentTime = 42;
  h.play();
  const releases = [];
  h.Api.resolve = () => new Promise(resolve => releases.push(resolve));
  await h.P.requestRemotePlayback();
  await h.P.requestRemotePlayback();
  await flushMicrotasks(40);
  assert.equal(releases.length, 1);
  h.P.pause();
  h.play();
  await flushMicrotasks(40);
  assert.equal(releases.length, 2, 'Play replaces the cancelled preparation immediately');
  releases[0]({ url: 'https://test/obsolete' });
  await flushMicrotasks(40);
  assert.equal(receiver.loads.length, 0);
  assert.equal(h.P.remotePlaybackStatus().preparing, true);
  releases[1]({ url: 'https://test/current', mime: 'audio/mp4' });
  await flushMicrotasks(80);
  assert.equal(receiver.loads.length, 1);
  assert.equal(receiver.loads[0].media.contentId, 'https://test/current');
  assert.equal(receiver.loads[0].currentTime, 42);
  assert.equal(h.P.isPaused(), false);
  assert.equal(h.P.remotePlaybackStatus().preparing, false);
  h.P.dismiss();
});
