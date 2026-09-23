const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, flushMicrotasks } = require('./harness');
const { readModule } = require('./source');

// Exercise the real player AND resolver. A phone can report both codecs as
// playable even though its WebM decoder cannot pass WebKit's wireless check.
function setup(airplay) {
  const tracks = ['one', 'two', 'three'].map(id => ({ id, title: id, duration: 247 }));
  const h = createHarness({ withAirPlay: airplay, withAudioSession: false,
    tracks, settings: { autoplay: false } });
  h.audio.canPlayType = () => 'probably';
  const lookups = [];
  const context = {
    window: {}, document: h.document, navigator: h.navigator,
    localStorage: { getItem: () => null, setItem() {} },
    URL, AbortController, setTimeout, clearTimeout, console,
    fetch: async url => {
      let data = [];
      if (url === 'config.json') data = { invidiousInstances: ['https://test'] };
      else if (url.startsWith('https://test/api/v1/videos/')) {
        const id = new URL(url).pathname.split('/').at(-1);
        lookups.push(id);
        data = { lengthSeconds: 247, adaptiveFormats: [
          { url: 'https://test/' + id + '.webm', type: 'audio/webm; codecs="opus"', bitrate: 256000 },
          { url: 'https://test/' + id + '.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
        ] };
      }
      return { ok: true, status: 200, json: async () => data };
    }
  };
  vm.runInNewContext(readModule('api'), context);
  Object.assign(h.Api, context.window.Api);
  return { ...h, tracks, lookups };
}

async function finishLoad(h) {
  await flushMicrotasks(80);
  h.audio.dispatch('playing');
  h.runImmediateTimers();
  await flushMicrotasks(80);
}

function route(h, connected) {
  h.audio.webkitCurrentPlaybackTargetIsWireless = connected;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
}

function nativeCompatibilityCheck(h) {
  // Mirrors the unsupported-engine outcome of checkPlaybackTargetCompatibility,
  // which WebKit schedules 500 ms after announcing the wireless route.
  if (h.audio.src.endsWith('.webm')) route(h, false);
}

for (const airplay of [false, true]) {
  test('initial and prefetched formats respect native AirPlay support=' + airplay + ' without connecting', async () => {
    const h = setup(airplay);
    h.window.Player.playQueue(h.tracks);
    await finishLoad(h);
    const extension = airplay ? '.m4a' : '.webm';
    assert.equal(h.audio.src, 'https://test/one' + extension);
    assert.equal(h.audioElements[1].src, 'https://test/two' + extension);
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'disconnected');
    assert.equal(h.audio.pickerCalls || 0, 0);
    h.window.Player.dismiss();
  });
}

test('Safari retains a compatible source across repeated hidden reconnects and a fresh app session', async () => {
  for (let session = 0; session < 2; session++) {
    const h = setup(true);
    h.window.Player.playQueue(h.tracks);
    await finishLoad(h);
    const source = h.audio.src;
    for (let attempt = 0; attempt < 5; attempt++) {
      h.document.hidden = true;
      h.document.visibilityState = 'hidden';
      h.document.dispatch('visibilitychange');
      h.play();
      route(h, true);
      nativeCompatibilityCheck(h);
      assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
      h.audio.currentTime += 3;
      h.audio.dispatch('timeupdate');
      h.runTimers(2500);
      await flushMicrotasks(40);
      assert.equal(h.audio.src, source, 'no source switch during reconnection');
      assert.equal(h.audio.paused, false);
      route(h, false);
      h.document.hidden = false;
      h.document.visibilityState = 'visible';
      h.document.dispatch('visibilitychange');
      await flushMicrotasks(40);
    }
    assert.equal(h.lookups.filter(id => id === 'one').length, 1);
    route(h, true);
    h.window.Player.next();
    await finishLoad(h);
    nativeCompatibilityCheck(h);
    assert.equal(h.audio.src, 'https://test/two.m4a');
    assert.equal(h.window.Player.remotePlaybackStatus().state, 'connected');
    assert.equal(h.audioElements[1].src, '');
    h.window.Player.dismiss();
  }
});
