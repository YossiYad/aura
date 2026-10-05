const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, flushMicrotasks } = require('./harness');
const { readModule } = require('./source');

// Chrome on Android keeps a hidden page playing only while the page has a playing
// element: with the phone locked, the moment the last player leaves it drops the media
// notification and the foreground service behind it, and the next song is paused as it
// starts or plays on in a page with no network. These tests hold the handoff to the
// shape that never lets that happen, and leave the other engines as they were.

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const tracks = [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }];

function setup(userAgent) {
  const h = createHarness({ tracks: tracks.map(track => ({ ...track })), exposeInternals: true, withAudioSession: false,
    navigator: userAgent ? { userAgent } : {}, settings: { autoplay: false, noYtFallback: true } });
  const resolves = [];
  h.Api.resolve = async id => { resolves.push(id); return { url: 'https://test/' + id, base: 'https://test' }; };
  h.Api.invalidate = () => {};
  h.Api.getSkipSegments = async () => [];
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  return { ...h, resolves, standby: h.audioElements[1] };
}

const logged = (h, text) => h.logs.some(entry => entry.message.includes(text));

test('a locked Android phone starts the next song on the standby while the current one still plays', async () => {
  const h = setup(ANDROID);
  await flushMicrotasks(60);
  assert.equal(h.standby.src, 'https://test/two', 'the standby holds the next song');
  const order = [];
  const play = h.standby.play.bind(h.standby);
  const pause = h.audio.pause.bind(h.audio);
  h.standby.play = () => { order.push('standby plays'); return play(); };
  h.audio.pause = () => { order.push('current stops'); return pause(); };
  const source = h.audio.src;
  h.audio.currentTime = h.audio.duration - 1.2;
  h.audio.dispatch('timeupdate');
  // Asked for inside the media callback, with the playing element left exactly as it was:
  // swapping its source is what takes the page's only player away.
  assert.equal(h.standby.playCalls, 1);
  assert.equal(h.audio.src, source);
  assert.equal(h.audio.paused, false);
  await flushMicrotasks(50);
  assert.deepEqual(order.slice(0, 2), ['standby plays', 'current stops']);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.standby.paused, false);
  assert.equal(h.window.Player.isPaused(), false);
  assert.equal(logged(h, 'two started from prepared source'), true);
  h.window.Player.dismiss();
});

test('the handoff after it runs the same way, back on the first element', async () => {
  const h = setup(ANDROID);
  await flushMicrotasks(60);
  h.audio.currentTime = h.audio.duration - 1;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/three', 'the freed element holds the song after');
  const calls = h.audio.playCalls;
  h.standby.currentTime = h.standby.duration - 1;
  h.standby.dispatch('timeupdate');
  assert.equal(h.audio.playCalls, calls + 1);
  assert.equal(h.standby.paused, false);
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'three');
  assert.equal(h.audio.paused, false);
  h.window.Player.dismiss();
});

test('another hidden engine keeps the short window and the restart on the active element', async () => {
  const h = setup();
  await flushMicrotasks(60);
  h.audio.currentTime = h.audio.duration - 1.2;
  h.audio.dispatch('timeupdate');
  assert.equal(h.standby.playCalls, 0);
  assert.equal(h.window.Player.current().id, 'one');
  h.audio.currentTime = h.audio.duration - 0.5;
  const calls = h.audio.playCalls;
  h.audio.dispatch('timeupdate');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.audio.playCalls, calls + 1);
  assert.equal(h.standby.playCalls, 0);
  await flushMicrotasks(50);
  assert.equal(h.window.Player.current().id, 'two');
  h.window.Player.dismiss();
});

test('a start Android refuses holds the next song for the reopened app instead of skipping it', async () => {
  const h = setup(ANDROID);
  await flushMicrotasks(60);
  const asked = h.resolves.length;
  // The song ran out before anything overlapped it, and the browser pauses the
  // standby the moment it is asked to play.
  const play = h.standby.play;
  h.standby.play = function () {
    this.playCalls++;
    return Promise.reject(Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' }));
  };
  h.audio.currentTime = h.audio.duration;
  h.audio.ended = true;
  h.audio.paused = true;
  h.audio.dispatch('ended');
  await flushMicrotasks(60);
  assert.equal(logged(h, 'two handoff refused by the browser'), true);
  assert.equal(logged(h, 'prepared playback failed'), false);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.window.Player.isPaused(), true);
  assert.equal(h.window.Player.playbackRequested(), true, 'the listener still wants music');
  assert.equal(h.standby.src, 'https://test/two', 'the song keeps its source');
  // Opening the app is the one signal that playback is allowed again.
  h.standby.play = play;
  const calls = h.standby.playCalls;
  h.document.hidden = false;
  h.document.visibilityState = 'visible';
  h.document.dispatch('visibilitychange');
  await flushMicrotasks(40);
  assert.equal(h.standby.playCalls, calls + 1);
  assert.equal(h.standby.paused, false);
  assert.equal(h.window.Player.current().id, 'two');
  assert.equal(h.resolves.slice(asked).includes('two'), false, 'nothing went back to the network for it');
  h.window.Player.dismiss();
});

test('a standby that never starts on Android is still a failed source, not a hold', async () => {
  const h = setup(ANDROID);
  await flushMicrotasks(60);
  h.standby.play = function () { this.playCalls++; this.paused = false; return new Promise(() => {}); };
  h.audio.currentTime = h.audio.duration - 1;
  h.audio.dispatch('timeupdate');
  await flushMicrotasks(20);
  assert.equal(h.runTimers(9000) > 0, true);
  await flushMicrotasks(40);
  assert.equal(logged(h, 'two prepared playback failed: prepared playback timeout'), true);
  assert.equal(logged(h, 'handoff refused'), false);
  h.window.Player.dismiss();
});

function resolver(fetch) {
  const context = { window: {}, document: { getElementById: () => ({ canPlayType: () => 'probably' }) },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} }, fetch,
    Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Blob, URL, console };
  vm.runInNewContext(readModule('api'), context);
  return context.window.Api;
}

const formats = { adaptiveFormats: [{ url: 'https://home/audio', type: 'audio/webm; codecs="opus"', bitrate: 128000 }] };

for (const [name, failure, outage] of [
  ['a server no request reaches', () => { throw new TypeError('Failed to fetch'); }, true],
  ['a server answering with its own error', async () => ({ ok: false, status: 500, json: async () => ({}) }), undefined]
]) {
  test(name + ' after a played song is ' + (outage ? 'an outage, not this video\'s fault' : 'still given the benefit of the doubt'), async () => {
    let down = false;
    const api = resolver(async url => {
      if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://home'] }) };
      if (down) return failure();
      return { ok: true, status: 200, json: async () => formats };
    });
    assert.equal((await api.resolve('one')).url, 'https://home/audio');
    down = true;
    const error = await api.resolve('two').then(() => null, e => e);
    assert.ok(error);
    assert.equal(error.outage, outage);
  });
}
