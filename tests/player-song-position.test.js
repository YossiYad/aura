const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks, FakeAudio } = require('./harness');

function setup(track, options = {}) {
  const h = createHarness({
    tracks: [{ id: 'first', title: 'First', duration: 180 }, track],
    withStorage: true, withAudioSession: false,
    settings: { autoplay: false, noYtFallback: true, crossfade: 0 },
    ...options
  });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.getSkipSegments = async () => [];
  h.Store.getPosition = id => id === track.id ? 100 : 0;
  h.positionSaves = [];
  h.Store.savePosition = (id, at) => h.positionSaves.push([id, at]);
  // Model the browser resetting the clock when a new resource is attached.
  for (const audio of h.audioElements) {
    let source = audio.src;
    Object.defineProperty(audio, 'src', {
      get: () => source,
      set(value) { source = value; this.ended = false; this.currentTime = 0; }
    });
    audio.play = function () {
      const result = FakeAudio.prototype.play.call(this);
      this.dispatch('playing');
      return result;
    };
  }
  return h;
}

for (const kind of ['music', undefined]) {
  for (const duration of [180, 900, 3600]) {
    test(`queue starts ${kind || 'unclassified'} music of ${duration}s at zero despite an old bookmark`, async () => {
      const h = setup({ id: 'song', title: 'Song', duration, kind });
      h.play();
      // End before prefetch has completed to exercise the ordinary load path.
      h.audio.ended = true;
      h.audio.dispatch('ended');
      await flushMicrotasks(100);
      assert.equal(h.window.Player.current().id, 'song');
      assert.equal(h.audio.currentTime, 0);
      assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'song', at: 0 });
      h.window.Player.dismiss();
    });
  }
}

for (const ios of [false, true]) {
  test(`prepared background transition starts long music at zero, iOS=${ios}`, async () => {
    const h = setup({ id: 'song', title: 'Concert', duration: 3600 }, {
      navigator: ios ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } : {}
    });
    h.document.hidden = true;
    h.document.visibilityState = 'hidden';
    h.play();
    await flushMicrotasks(100);
    h.audio.ended = true;
    h.audio.dispatch('ended');
    await flushMicrotasks(100);
    assert.equal(h.window.Player.current().id, 'song');
    assert.ok(h.logs.some(entry => entry.message.includes('prepared transition')), 'uses the prepared handoff');
    assert.equal(h.window.Player.getTime().cur, 0);
    assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'song', at: 0 });
    h.window.Player.dismiss();
  });
}

test('long music resumes a pause but starts over when selected again', async () => {
  const h = setup({ id: 'song', title: 'Concert', duration: 3600, kind: 'music' });
  const player = h.window.Player;
  player.jumpTo(1);
  await flushMicrotasks(100);
  assert.equal(h.audio.currentTime, 0);
  h.audio.currentTime = 80;
  player.pause();
  assert.equal(h.positionSaves.length, 0, 'music has no bookmark for future visits');
  assert.deepEqual(JSON.parse(h.savedLocal.get('aura.queueAt')), { id: 'song', at: 80 });
  h.play();
  await flushMicrotasks(40);
  assert.equal(h.audio.currentTime, 80, 'continuing the current listening session keeps its place');
  player.jumpTo(0);
  await flushMicrotasks(100);
  player.jumpTo(1);
  await flushMicrotasks(100);
  assert.equal(h.audio.currentTime, 0, 'revisiting the song starts a new listen');
  player.dismiss();
});

test('spoken word still resumes its saved place on an ordinary queue transition', async () => {
  const h = setup({ id: 'episode', title: 'Episode', duration: 3600, kind: 'podcast' });
  await h.window.Player.next();
  await flushMicrotasks(100);
  assert.equal(h.window.Player.current().id, 'episode');
  assert.equal(h.audio.currentTime, 100);
  h.window.Player.dismiss();
});
