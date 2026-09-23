const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

// A voice request pauses the music to open the microphone. On iOS a paused-but-loaded
// media element still holds the audio session and starves webkitSpeechRecognition
// (WebKit 321436), so Player.releaseForVoice() detaches the source; the song reloads in
// place on resume through resumePlay's no-source branch. Off iOS it is a no-op.
async function playing(navigator) {
  const h = createHarness({ navigator, withStorage: true,
    tracks: [{ id: 'one', title: 'one' }, { id: 'two', title: 'two' }],
    settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  h.play();
  await flushMicrotasks(60);
  return h;
}

test('iPhone releases the paused media element for a voice capture, then reloads the same song', async () => {
  const h = await playing({ userAgent: 'iPhone' });
  const Player = h.window.Player;
  assert.ok(h.audio.src, 'a song is loaded and playing before the request');
  const track = Player.current();
  Player.releaseForVoice();
  assert.equal(h.audio.src, '', 'the element source is released so the microphone is not starved');
  assert.equal(Player.captureState().src, false, 'captureState reports the released element for the on-device log');
  Player.toggle();
  await flushMicrotasks(60);
  assert.ok(h.audio.src, 'the paused song reloads for resume');
  assert.equal(Player.current().id, track.id, 'the same song comes back');
});

test('iPhone releases a loaded element that is only paused, not actively playing', async () => {
  // The deaf case on device: a song loaded but paused (or waiting for a play tap) still
  // holds the iOS session, yet playbackRequested()/isPaused() make pauseNeeded false. The
  // release must key off a loaded source, not active playback, or the mic stays deaf.
  const h = await playing({ userAgent: 'iPhone' });
  const Player = h.window.Player;
  Player.toggle();
  await flushMicrotasks(20);
  assert.ok(h.audio.src, 'a paused song keeps its source loaded');
  assert.equal(Player.isPaused(), true, 'the song is paused, so pauseNeeded would be false');
  Player.releaseForVoice();
  assert.equal(h.audio.src, '', 'the loaded-but-paused element is released so the mic is not starved');
});

test('iPhone closes the session-holder context for a voice capture so it stops pinning the mic', async () => {
  // Device diagnostics: with the element released (src false) but the sessionKick AudioContext
  // present (kick suspended), recognition was still deaf; a request with no context (kick none)
  // was heard. Even a suspended context pins the iOS session, so it must be closed for a capture.
  const h = createHarness({ withAudioContext: true, withStorage: true, navigator: { userAgent: 'iPhone' },
    tracks: [{ id: 'one', title: 'one' }, { id: 'two', title: 'two' }], settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.invalidate = () => {};
  h.play();
  await flushMicrotasks(60);
  const Player = h.window.Player;
  const ctx = h.audioContexts[0];
  assert.ok(ctx, 'playback created the session-holder context');
  Player.releaseForVoice();
  assert.equal(ctx.state, 'closed', 'the context is closed so it stops pinning the iOS session');
  assert.equal(Player.captureState().kick, 'none', 'no live context is left to deafen the mic');
});

test('off iOS releaseForVoice leaves the element loaded so quick resume is unchanged', async () => {
  const h = await playing({ userAgent: 'TestBrowser/1.0' });
  const Player = h.window.Player;
  assert.ok(h.audio.src, 'a song is loaded');
  Player.releaseForVoice();
  assert.ok(h.audio.src, 'no iOS session bug off iOS, so the element stays loaded');
});
