const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

// YouTube's embedded player pauses itself on a phone whose page is hidden, so with the
// screen off the iframe fallback is a dead end: the song it was handed sits silent until
// the app is reopened. A phone skips such a song and keeps the queue going; a desktop
// browser, whose background tab plays the embed fine, keeps the fallback.
const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) Chrome/140.0' };

function setup(ids, options = {}) {
  const tracks = ids.map(id => ({ id, title: id, duration: 180 }));
  const h = createHarness({ tracks, withStorage: true, withAudioSession: false, withYt: true, exposeInternals: true,
    settings: { autoplay: false, crossfade: 0 }, ...options });
  const P = h.window.Player, events = [], requests = [];
  const broken = new Set();
  h.Api.resolve = async id => {
    requests.push(id);
    if (broken.has(id)) throw new Error('Video unavailable');
    return { url: 'https://test/' + id };
  };
  h.Api.invalidate = () => {};
  P.onChange(event => events.push(event));
  return { ...h, P, events, requests, broken, tracks };
}

function hide(h) {
  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  h.document.dispatch('visibilitychange');
}

async function settle(h) {
  await flushMicrotasks(120);
  h.runImmediateTimers();
  await flushMicrotasks(120);
}

for (const phone of [true, false]) {
  test((phone ? 'a hidden phone skips' : 'a hidden desktop tab still hands') + ' a song with no stream ' +
      (phone ? 'instead of starting' : 'to') + ' the YouTube player', async () => {
    const h = setup(['one', 'broken', 'three'], phone ? { navigator: android } : {});
    h.broken.add('broken');
    h.play();
    hide(h);
    h.P.next();
    await settle(h);
    if (phone) {
      assert.equal(h.P.current().id, 'three');
      assert.equal(h.audio.src, 'https://test/three');
      assert.equal(h.P.isPaused(), false);
      assert.equal(h.ytPlayer(), null, 'the iframe is never created');
      assert.equal(h.events.some(e => e.type === 'fallback-yt'), false);
      assert.equal(h.events.filter(e => e.type === 'fallback-skip').length, 1);
      assert.ok(h.logs.some(l => l.tag === 'play' && /broken skipped: the YouTube player cannot start while the screen is off/.test(l.message)));
    } else {
      assert.equal(h.P.current().id, 'broken');
      assert.equal(h.ytPlayer().loadCalls, 1);
      assert.equal(h.events.some(e => e.type === 'fallback-yt'), true);
      assert.equal(h.events.some(e => e.type === 'fallback-skip'), false);
    }
  });
}

test('a stream error with the screen off skips to the next song rather than the YouTube player', async () => {
  const h = setup(['one', 'two'], { navigator: android });
  h.play();
  hide(h);
  h.broken.add('one');
  h.audio.error = { code: 2 };
  h.audio.dispatch('error');
  await settle(h);
  assert.equal(h.P.current().id, 'two');
  assert.equal(h.audio.src, 'https://test/two');
  assert.equal(h.P.isPaused(), false);
  assert.equal(h.ytPlayer(), null);
  assert.equal(h.events.some(e => e.type === 'fallback-yt'), false);
  assert.equal(h.events.filter(e => e.type === 'fallback-skip').length, 1);
});

for (const phone of [true, false]) {
  test((phone ? 'a phone' : 'a desktop tab') + ' going hidden while the YouTube fallback plays ' +
      (phone ? 'moves on to the next song' : 'leaves the song in place'), async () => {
    const h = setup(['one', 'two'], phone ? { navigator: android } : {});
    h.play();
    await h.window.__playerInternals.playViaYt(h.P.current(), 0);
    assert.equal(h.ytPlayer().loadCalls, 1);
    assert.equal(h.P.current().id, 'one');
    hide(h);
    await settle(h);
    if (phone) {
      assert.equal(h.P.current().id, 'two');
      assert.equal(h.audio.src, 'https://test/two');
      assert.equal(h.P.isPaused(), false);
      assert.equal(h.P.playbackRequested(), true);
      assert.ok(h.logs.some(l => l.tag === 'play' && /one was playing through YouTube, which pauses in the background/.test(l.message)));
    } else {
      assert.equal(h.P.current().id, 'one');
      assert.equal(h.ytPlayer().loadCalls, 1);
      assert.equal(h.requests.includes('two'), false);
    }
  });
}

test('the last song in the queue stays with the YouTube player for the reopening to resume', async () => {
  const h = setup(['one'], { navigator: android });
  h.play();
  await h.window.__playerInternals.playViaYt(h.P.current(), 0);
  hide(h);
  await settle(h);
  assert.equal(h.P.current().id, 'one');
  assert.equal(h.ytPlayer().loadCalls, 1);
  assert.equal(h.P.playbackRequested(), true);
});

test('a listener pause on the YouTube fallback is not overridden by the page going hidden', async () => {
  const h = setup(['one', 'two'], { navigator: android });
  h.play();
  await h.window.__playerInternals.playViaYt(h.P.current(), 0);
  h.P.pause();
  hide(h);
  await settle(h);
  assert.equal(h.P.current().id, 'one');
  assert.equal(h.P.playbackRequested(), false);
  assert.equal(h.requests.includes('two'), false);
});
