const assert = require("node:assert/strict");
const test = require("node:test");

const { createHarness, flushMicrotasks } = require("./harness.js");

// The reported iOS 27 failure: a stateless Audio Session (statechange with no
// readable state), a long background interruption, and an element that stays
// silent afterward no matter what play()/reload does until the app is reopened.
// A bare AudioContext is a second client of the same platform audio session, so
// its running/suspended/interrupted transitions track focus even in the
// background, where the element's own signals do not.
function backgroundInterruption(options = {}) {
  let now = 1000000;
  const h = createHarness({
    withAudioContext: true,
    Date: { now: () => now },
    navigator: { userAgent: "iPhone" },
    ...options
  });
  // Model the failing build: statechange fires, but the state is never readable.
  delete h.audioSession.state;
  h.play();
  const ctx = h.audioContexts[0];
  assert.ok(ctx, "playback creates the audio-session kick context inside the gesture");
  ctx.setState("running"); // The platform grants audio to both clients.
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  return {
    ...h, ctx,
    advance(ms) { now += ms; },
    interrupt() {
      // Another app takes the audio: the element is paused and, a moment later,
      // the platform suspends our context client too.
      h.audio.currentTime = 62.57;
      h.audio.pause();
      ctx.setState("suspended");
    },
    release() { ctx.setState("running"); }
  };
}

test("playback creates and resumes the audio-session context inside the gesture", () => {
  const h = createHarness({ withAudioContext: true, navigator: { userAgent: "iPhone" } });
  h.play();
  const ctx = h.audioContexts[0];
  assert.ok(ctx);
  assert.equal(ctx.resumeCalls, 1, "the context is resumed alongside the element");
});

test("the context renders looped silence so the platform treats it as a session client", () => {
  const h = createHarness({ withAudioContext: true, navigator: { userAgent: "iPhone" } });
  h.play();
  const ctx = h.audioContexts[0];
  // An idle, source-less context is ignored by iOS entirely: it is never
  // suspended with an interruption and never resumed after one, so it would
  // observe nothing (verified on the reported device).
  assert.equal(ctx.silentSources.length, 1);
  const source = ctx.silentSources[0];
  assert.equal(source.loop, true, "a one-shot buffer would fall idle after one frame");
  assert.equal(source.started, true);
  assert.equal(source.connected, ctx.destination);
  assert.ok(source.buffer, "the source renders digital silence, not sound");
});

test("no audio-session context is created off iOS", () => {
  const h = createHarness({ withAudioContext: true, navigator: { userAgent: "Android" } });
  h.play();
  assert.equal(h.audioContexts.length, 0, "Chrome/Android resume the element natively");
});

test("a suspended context requests a standing resume that the platform fulfils on release", () => {
  const h = backgroundInterruption();
  const before = h.ctx.resumeCalls;
  h.interrupt();
  // Suspending our client while playback is still wanted issues one standing
  // resume request; it stays pending while the OS holds the audio.
  assert.equal(h.ctx.resumeCalls, before + 1, "one standing resume request, not a poll");
  assert.equal(h.ctx.state, "suspended");
  assert.equal(h.audio.paused, true);
});

test("a background context focus return resumes a stuck element without reopening the app", async () => {
  const h = backgroundInterruption();
  h.interrupt();
  const plays = h.audio.playCalls;
  h.advance(30000); // A long interruption: past the five-second failure threshold.
  h.release();       // The interruption ends; the platform hands our client back.
  await flushMicrotasks();
  assert.equal(h.document.hidden, true, "recovery happens in the background");
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.playCalls, plays + 1, "the element is resumed once on focus return");
  assert.equal(h.audio.currentTime, 62.57, "the same position is retained");
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("a native zombie resume on context return is verified for real progress", async () => {
  const h = backgroundInterruption();
  h.interrupt();
  // The documented zombie: paused clears with a frozen clock before focus returns.
  h.audio.paused = false;
  h.advance(30000);
  h.release();
  await flushMicrotasks();
  // The unpaused-but-frozen element must be verified, not trusted.
  assert.equal(h.pendingTimers(500) + h.pendingTimers(1000), 1, "a stuck clock is scheduled for verification");
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("a held interruption is not resumed while the OS still owns the audio", async () => {
  const h = backgroundInterruption();
  h.interrupt();
  const plays = h.audio.playCalls;
  h.advance(30000);
  // No release: the call/other app keeps focus. The context stays suspended.
  await flushMicrotasks();
  assert.equal(h.ctx.state, "suspended");
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.playCalls, plays, "no resume while the interruption is held");
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("an explicit pause suspends the context and leaves other apps their audio", () => {
  const h = createHarness({ withAudioContext: true, navigator: { userAgent: "iPhone" } });
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  h.window.Player.pause();
  assert.equal(ctx.state, "suspended", "a running playback context would hold the session active");
  assert.equal(ctx.suspendCalls, 1);
});

test("native AirPlay suspends the helper without pausing or replacing the music", () => {
  const h = createHarness({ withAudioContext: true, withAirPlay: true, navigator: { userAgent: "iPhone" } });
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  h.audio.remote.state = "connecting";
  h.audio.remote.dispatch("connecting");
  assert.equal(ctx.state, "running", "a conflicting generic route must not suspend local playback");
  const source = h.audio.src, position = h.audio.currentTime, pauses = h.audio.pauseCalls;
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch("webkitcurrentplaybacktargetiswirelesschanged");
  assert.equal(h.window.Player.remotePlaybackStatus().state, "connected");
  assert.equal(ctx.state, "suspended", "only the media element should render during AirPlay");
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.pauseCalls, pauses);
  assert.equal(h.audio.src, source);
  assert.equal(h.audio.currentTime, position);
  assert.equal(h.window.Player.playbackRequested(), true);
  const resumes = ctx.resumeCalls;
  h.audio.dispatch("timeupdate");
  assert.equal(ctx.resumeCalls, resumes, "metadata updates must not restart the helper");
});

function airplayHarness() {
  const h = createHarness({ withAudioContext: true, withAirPlay: true, navigator: { userAgent: "iPhone" } });
  delete h.audioSession.state;
  h.route = connected => {
    h.audio.webkitCurrentPlaybackTargetIsWireless = connected;
    h.audio.dispatch("webkitcurrentplaybacktargetiswirelesschanged");
  };
  return h;
}

test("starting on an existing AirPlay route does not create the local helper", () => {
  const h = airplayHarness();
  h.route(true);
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(h.audioContexts.length, 0);
});

test("AirPlay pause and explicit play leave the helper suspended", () => {
  const h = airplayHarness();
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  h.route(true);
  const resumes = ctx.resumeCalls;
  h.window.Player.pause();
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(ctx.state, "suspended");
  assert.equal(ctx.resumeCalls, resumes);
});

test("a native resume after an AirPlay pause cannot restart the local helper", () => {
  const h = airplayHarness();
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  h.route(true);
  h.audio.pause();
  const resumes = ctx.resumeCalls;
  h.audio.play();
  assert.ok(h.logs.some(entry => entry.message.includes("play event after interruption")));
  assert.equal(ctx.resumeCalls, resumes, "native focus recovery must obey the remote route too");
  assert.equal(h.audio.paused, false);
});

for (const state of ["suspended", "interrupted"]) {
  test("a pending context becoming running during AirPlay is suspended again: " + state, async () => {
    const h = airplayHarness();
    h.play();
    const ctx = h.audioContexts[0];
    if (state === "interrupted") ctx.setState(state);
    h.route(true);
    assert.equal(ctx.state, state, "an interrupted context remains under platform control");
    const resumes = ctx.resumeCalls, plays = h.audio.playCalls;
    ctx.setState("running");
    await flushMicrotasks();
    assert.equal(ctx.state, "suspended");
    assert.equal(ctx.resumeCalls, resumes);
    assert.equal(h.audio.playCalls, plays);
  });
}

for (const paused of [false, true]) {
  test("AirPlay disconnect restores the local helper only with playback intent: paused=" + paused, () => {
    const h = airplayHarness();
    h.play();
    const ctx = h.audioContexts[0];
    ctx.setState("running");
    h.route(true);
    if (paused) h.window.Player.pause();
    const resumes = ctx.resumeCalls;
    h.route(false);
    assert.equal(ctx.resumeCalls, resumes + (paused ? 0 : 1));
    assert.equal(h.audio.paused, paused);
  });
}

test("opening and cancelling the AirPlay picker leaves local interruption recovery available", async () => {
  const h = airplayHarness();
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  await h.window.Player.requestRemotePlayback();
  assert.equal(h.audio.pickerCalls, 1);
  assert.equal(ctx.state, "running");
  assert.equal(h.window.Player.remotePlaybackStatus().state, "disconnected");
  h.audio.pause();
  ctx.setState("suspended");
  ctx.setState("running");
  await flushMicrotasks();
  assert.equal(h.audio.paused, false);
});
