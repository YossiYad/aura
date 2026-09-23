const assert = require("node:assert/strict");
const test = require("node:test");

const { createHarness, flushMicrotasks } = require("./harness.js");

test("a replacement source clears the previous song endpoint until metadata is ready", () => {
  const h = createHarness({ withAudioSession: false });
  let position;
  h.navigator.mediaSession.setPositionState = state => { position = state; };
  h.play();
  h.audio.currentTime = 179;
  h.audio.dispatch("timeupdate");
  assert.equal(position.position, 179);
  h.audio.src = "https://example.test/replacement.mp3";
  h.audio.readyState = 0;
  h.audio.duration = NaN;
  h.audio.currentTime = 0;
  h.audio.dispatch("loadstart");
  assert.equal(position, undefined);
  h.audio.dispatch("durationchange");
  assert.equal(position, undefined);
  h.audio.readyState = 1;
  h.audio.duration = 180;
  h.audio.dispatch("loadedmetadata");
  assert.equal(position.position, 0);
  assert.equal(position.duration, 180);
});

test("unknown and live durations discard an old finite external timeline", () => {
  const h = createHarness();
  let position;
  h.navigator.mediaSession.setPositionState = state => { position = state; };
  h.play();
  for (const duration of [NaN, Infinity, 0]) {
    h.audio.duration = 180;
    h.audio.dispatch("durationchange");
    assert.equal(position.duration, 180);
    h.audio.duration = duration;
    h.audio.dispatch("durationchange");
    assert.equal(position, undefined);
  }
});

test("pause and resume anchor the external clock immediately without progress events", () => {
  const h = createHarness({ withAudioSession: false });
  let position;
  h.navigator.mediaSession.setPositionState = state => { position = state; };
  h.play();
  h.audio.currentTime = 50;
  h.pause();
  assert.equal(position.position, 50);
  h.audio.currentTime = 55;
  h.play();
  assert.equal(position.position, 55);
  h.actions.get("stop")();
  assert.equal(position, undefined);
});

test("completed platform seeks and rate changes refresh the external timeline", () => {
  const h = createHarness();
  let position;
  h.navigator.mediaSession.setPositionState = state => { position = state; };
  h.play();
  h.audio.currentTime = 179;
  h.audio.dispatch("timeupdate");
  h.audio.currentTime = 20;
  h.audio.dispatch("seeked");
  assert.equal(position.position, 20);
  h.audio.playbackRate = 1.5;
  h.audio.dispatch("ratechange");
  assert.equal(position.playbackRate, 1.5);
});

for (const event of ["playing", "pageshow", "visibilitychange"]) {
  test("media controls reconnect on " + event + " without repeated play/pause taps", () => {
    const h = createHarness({ withAudioSession: false });
    h.play();
    h.actions.clear();
    if (event === "playing") h.audio.dispatch(event);
    else if (event === "pageshow") h.window.dispatch(event);
    else { h.document.hidden = true; h.document.dispatch(event); }
    assert.equal(h.actions.size, 8);
    assert.equal(h.audio.playCalls, 1);
    h.pause();
    assert.equal(h.audio.paused, true);
    h.play();
    assert.equal(h.audio.paused, false);
  });
}

test("restoring a paused page republishes lost metadata without starting audio", () => {
  const h = createHarness();
  h.play();
  h.window.Player.pause();
  h.navigator.mediaSession.metadata = null;
  h.window.dispatch("pageshow");
  assert.equal(h.navigator.mediaSession.metadata.title, "Track");
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
  assert.equal(h.audio.playCalls, 1);
});

test("restoring a dismissed page does not republish its metadata or timeline", () => {
  const h = createHarness();
  let position;
  h.navigator.mediaSession.setPositionState = state => { position = state; };
  h.play();
  h.actions.get("stop")();
  h.audio.dispatch("seeked");
  h.window.dispatch("pageshow");
  assert.equal(h.navigator.mediaSession.metadata, null);
  assert.equal(h.navigator.mediaSession.playbackState, "none");
  assert.equal(position, undefined);
});

for (const withAudioSession of [false, true]) {
  for (const event of ["playing", "timeupdate", "visibilitychange"]) {
    test("active audio repairs a stale external playback state on " + event + ", Audio Session=" + withAudioSession, () => {
      const h = createHarness({ withAudioSession });
      h.play();
      h.document.hidden = true;
      h.document.visibilityState = "hidden";
      h.navigator.mediaSession.playbackState = "paused";
      if (event === "visibilitychange") h.document.dispatch(event);
      else h.audio.dispatch(event);
      assert.equal(h.navigator.mediaSession.playbackState, "playing");
      assert.equal(h.audio.playCalls, 1, "state repair must not restart playback");
    });
  }
}

test("late progress after an interruption reports paused even when playback is still requested", () => {
  const h = createHarness();
  h.play();
  h.audioSession.state = "interrupted";
  h.audioSession.dispatch("statechange");
  h.audio.pause();
  assert.equal(h.window.Player.playbackRequested(), true);
  h.navigator.mediaSession.playbackState = "playing";
  h.audio.dispatch("timeupdate");
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
  assert.equal(h.audio.playCalls, 1);
});

test("standby audio events cannot change the external state of the active track", () => {
  const h = createHarness();
  h.play();
  h.window.Player.pause();
  const standby = h.audioElements[1];
  standby.paused = false;
  standby.dispatch("playing");
  standby.dispatch("timeupdate");
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
});

test("late progress and visibility events cannot revive dismissed external controls", () => {
  const h = createHarness();
  h.play();
  h.actions.get("stop")();
  h.audio.dispatch("playing");
  h.audio.dispatch("timeupdate");
  h.document.hidden = true;
  h.document.dispatch("visibilitychange");
  assert.equal(h.navigator.mediaSession.playbackState, "none");
  assert.equal(h.navigator.mediaSession.metadata, null);
  assert.equal(h.audio.paused, true);
});

test("native iframe pause and resume update external controls without waiting for timers", async () => {
  const h = createHarness({ withYt: true, withAudioSession: false, exposeInternals: true });
  await h.window.__playerInternals.playViaYt(h.window.Player.current());
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.ytPlayer().dispatchState(2);
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
  h.ytPlayer().dispatchState(1);
  assert.equal(h.navigator.mediaSession.playbackState, "playing");
});

for (const unsupported of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward", "stop"]) {
  test("unsupported " + unsupported + " does not disable other media controls", () => {
    const h = createHarness({ withAudioSession: false, unsupportedMediaActions: [unsupported] });
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward", "stop"]) {
      assert.equal(h.actions.has(action), action !== unsupported, action);
    }
  });
}

test("background seeking publishes the new position without waiting for timeupdate", () => {
  const h = createHarness({ withAudioSession: false });
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  const positions = [];
  h.navigator.mediaSession.setPositionState = state => positions.push(state.position);

  h.actions.get("seekto")({ seekTime: 60 });
  h.actions.get("seekbackward")({});
  h.actions.get("seekforward")({ seekOffset: 20 });

  assert.equal(h.audio.currentTime, 70);
  assert.deepEqual(positions, [60, 50, 70]);
});

test("background play and pause still work when a seek action is unsupported", () => {
  const h = createHarness({ withAudioSession: false, unsupportedMediaActions: ["seekto"] });
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(h.navigator.mediaSession.playbackState, "playing");
  h.pause();
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(h.navigator.mediaSession.playbackState, "playing");
  h.actions.get("stop")();
  assert.equal(h.audio.paused, true);
  assert.equal(h.navigator.mediaSession.metadata, null);
});

test("background Audio Session pause and play respond before a suspended decision timer runs", () => {
  const h = createHarness();
  h.audioSession.state = "active";
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.pause();
  assert.equal(h.audio.paused, true);
  assert.equal(h.navigator.mediaSession.playbackState, "paused");
  // A background page may not run the 500ms pause-decision timer before Play arrives.
  h.play();
  assert.equal(h.audio.paused, false);
  assert.equal(h.audioSession.type, "playback");
  assert.equal(h.navigator.mediaSession.playbackState, "playing");
  h.runTimers(500);
  assert.equal(h.audio.paused, false);

  h.pause();
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), false);
  h.play();
  assert.equal(h.audio.paused, false);
});

test("background next and previous controls change the playing source and metadata", async () => {
  const h = createHarness({ withAudioSession: false, withStorage: true,
    settings: { autoplay: false, crossfade: 0, noYtFallback: true },
    tracks: [{ id: "one", title: "One" }, { id: "two", title: "Two" }] });
  h.Api.resolve = async id => ({ url: "https://example.test/" + id + ".mp3" });
  h.Api.getSkipSegments = async () => [];
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";

  h.actions.get("nexttrack")();
  await flushMicrotasks(60);
  h.runImmediateTimers();
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, "two");
  assert.equal(h.audio.src, "https://example.test/two.mp3");
  assert.equal(h.audio.paused, false);
  assert.equal(h.navigator.mediaSession.metadata.title, "Two");

  h.audio.currentTime = 15;
  h.actions.get("previoustrack")();
  assert.equal(h.audio.currentTime, 0);
  h.actions.get("previoustrack")();
  await flushMicrotasks(60);
  h.runImmediateTimers();
  await flushMicrotasks(60);
  assert.equal(h.window.Player.current().id, "one");
  assert.equal(h.audio.src, "https://example.test/one.mp3");
  assert.equal(h.audio.paused, false);
  assert.equal(h.navigator.mediaSession.metadata.title, "One");
  h.window.Player.dismiss();
});

// The lock screen's skip arrows. A podcast is the case that needs them: the app already
// remembers where a long track was left, but until these existed there was no way to move
// inside one without opening the app.
test("seekbackward steps back ten seconds", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.audio.currentTime = 40;

  harness.actions.get("seekbackward")({});

  assert.equal(harness.audio.currentTime, 30);
});

test("seekbackward stops at the start rather than going negative", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.audio.currentTime = 4;

  harness.actions.get("seekbackward")({});

  assert.equal(harness.audio.currentTime, 0);
});

test("seekbackward uses the step the platform asks for", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.audio.currentTime = 100;

  harness.actions.get("seekbackward")({ seekOffset: 30 });

  assert.equal(harness.audio.currentTime, 70);
});

test("seekforward steps forward ten seconds", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.audio.currentTime = 40;

  harness.actions.get("seekforward")({});

  assert.equal(harness.audio.currentTime, 50);
});

// Seeking onto the final frame is not the same as finishing: the element can sit there
// without firing the event that advances the queue, and the notification then looks stuck
// on a track that is over.
test("seekforward stops short of the end", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.audio.currentTime = 175;

  harness.actions.get("seekforward")({});

  assert.equal(harness.audio.currentTime, 179);
});

test("stop pauses playback and takes the notification down", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  assert.equal(harness.audio.paused, false);

  harness.actions.get("stop")();

  assert.equal(harness.audio.paused, true);
  assert.equal(harness.navigator.mediaSession.metadata, null);
  assert.equal(harness.navigator.mediaSession.playbackState, "none");
});

// Pausing the element raises a "pause" event on the next turn, and the state update riding
// on it used to put the card straight back after it had been dismissed.
test("the pause event after stop does not put the notification back", async () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();

  harness.actions.get("stop")();
  harness.audio.dispatch("pause");
  await flushMicrotasks();

  assert.equal(harness.navigator.mediaSession.playbackState, "none");
  assert.equal(harness.navigator.mediaSession.metadata, null);
});

test("playing again after stop brings the notification back", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.actions.get("stop")();

  harness.play();

  assert.notEqual(harness.navigator.mediaSession.metadata, null);
  assert.equal(harness.navigator.mediaSession.metadata.title, "Track");
  assert.equal(harness.navigator.mediaSession.playbackState, "playing");
});
