const assert = require("node:assert/strict");
const test = require("node:test");

const { createHarness, flushMicrotasks } = require("./harness.js");

test("voice capture clears interrupted playback intent and retains microphone audio mode", () => {
  const h = createHarness();
  h.play();
  h.audioSession.state = "interrupted";
  h.audioSession.dispatch("statechange");
  h.audio.pause();
  assert.equal(h.window.Player.playbackRequested(), true);
  h.window.Player.pause();
  h.window.Voice = { isListening: () => true };
  h.audioSession.type = "play-and-record";
  h.audioSession.state = "active";
  h.audioSession.dispatch("statechange");
  h.runImmediateTimers();
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.audio.playCalls, 1, "microphone focus must not resume music");
  h.document.hidden = true;
  h.document.dispatch("visibilitychange");
  assert.equal(h.audioSession.type, "play-and-record");
  h.window.Voice.isListening = () => false;
  h.play();
  assert.equal(h.audioSession.type, "playback");
});

// Without an authoritative focus-return event, a hidden retry can steal the audio back
// from navigation or a call. The browser may resume its media session natively; JavaScript
// only makes a fallback attempt after confirmed focus return.
test("a hidden platform pause never reclaims audio focus", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  assert.equal(harness.audio.playCalls, 1);

  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  harness.audio.pause();
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.pendingTimers(1000), 0);

  assert.equal(harness.runTimers(1000), 0);
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.audio.paused, true);
});

// Chrome never exposes an Audio Session, so a focus loss to another app can never be
// confirmed as over. The listener returning to the app stands in for that confirmation.
test("opening the app resumes a platform pause when focus state is unknowable", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  harness.audio.pause();
  assert.equal(harness.audio.playCalls, 1);

  harness.document.hidden = false;
  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  assert.equal(harness.audio.playCalls, 2);
  assert.equal(harness.audio.paused, false);
});

test("a replaced source held for focus starts when the listener returns", async () => {
  const harness = createHarness({ exposeInternals: true, withAudioSession: false });
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  harness.audio.pause();

  const started = await harness.window.__playerInternals.playViaAudio("https://example.test/replacement.mp3");
  assert.equal(started, false);
  assert.equal(harness.audio.playCalls, 1);

  harness.document.hidden = false;
  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  assert.equal(harness.audio.playCalls, 2);
  assert.equal(harness.audio.paused, false);
});

test("source replacement cannot bypass an unconfirmed platform pause", async () => {
  const harness = createHarness({ exposeInternals: true });
  harness.audioSession.state = "active";
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  harness.audio.pause();

  const started = await harness.window.__playerInternals.playViaAudio("https://example.test/replacement.mp3");
  assert.equal(started, false);
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.audio.paused, true);
});

test("YouTube fallback cannot start while audio focus is interrupted", async () => {
  const harness = createHarness({ exposeInternals: true });
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();

  await assert.rejects(
    harness.window.__playerInternals.playViaYt(harness.window.Player.current()),
    /audio focus unavailable/
  );
  assert.equal(harness.window.Player.playbackRequested(), true);
  assert.equal(harness.audio.playCalls, 1);
});

test("YouTube fallback cannot consume a pending Media Session pause", async () => {
  const harness = createHarness({ exposeInternals: true });
  harness.audioSession.state = "active";
  harness.play();
  harness.pause();

  await assert.rejects(
    harness.window.__playerInternals.playViaYt(harness.window.Player.current()),
    /audio focus unavailable/
  );
  harness.runTimers(500);
  assert.equal(harness.window.Player.playbackRequested(), false);
  assert.equal(harness.audio.paused, true);
});

test("an interruption during YouTube initialization blocks its late start", async () => {
  const harness = createHarness({ exposeInternals: true, withYt: true });
  harness.audioSession.state = "active";
  harness.play();
  const attempt = harness.window.__playerInternals.playViaYt(harness.window.Player.current(), 0);

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  await assert.rejects(attempt, /audio focus unavailable/);
  assert.equal(harness.ytPlayer().loadCalls, 0);
  assert.equal(harness.window.Player.playbackRequested(), true);
});

test("an explicit pause cancels YouTube initialization already in flight", async () => {
  const harness = createHarness({ exposeInternals: true, withYt: true });
  harness.audioSession.state = "active";
  harness.play();
  const attempt = harness.window.__playerInternals.playViaYt(harness.window.Player.current(), 0);

  harness.window.Player.toggle();
  await assert.rejects(attempt, /playback request cancelled/);
  assert.equal(harness.ytPlayer().loadCalls, 0);
  assert.equal(harness.window.Player.playbackRequested(), false);
});

test("an active YouTube fallback resumes after audio focus returns", async () => {
  const harness = createHarness({ exposeInternals: true, withYt: true });
  harness.audioSession.state = "active";
  harness.play();
  await harness.window.__playerInternals.playViaYt(harness.window.Player.current(), 0);
  assert.equal(harness.ytPlayer().loadCalls, 1);

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  assert.equal(harness.ytPlayer().pauseCalls, 1);
  assert.equal(harness.window.Player.playbackRequested(), true);

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  await flushMicrotasks();
  assert.equal(harness.ytPlayer().playCalls, 1);
  assert.equal(harness.pendingTimers(500), 0);
  assert.equal(harness.window.Player.playbackRequested(), true);
});

test("an ignored YouTube resume command is retried after confirmed focus", async () => {
  const harness = createHarness({ exposeInternals: true, withYt: true, ytSilentResumeCount: 1 });
  harness.audioSession.state = "active";
  harness.play();
  await harness.window.__playerInternals.playViaYt(harness.window.Player.current(), 0);
  const baseline1500Timers = harness.pendingTimers(1500);
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.ytPlayer().playCalls, 1);
  assert.equal(harness.pendingTimers(500), 1);

  harness.runTimers(500);
  await flushMicrotasks();
  assert.equal(harness.ytPlayer().playCalls, 2);
  assert.equal(harness.ytPlayer().state, 1);
  assert.equal(harness.pendingTimers(1500), baseline1500Timers);
});

test("a pause the listener asked for is left alone", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.pause();
  assert.equal(harness.audio.paused, true);
  assert.equal(harness.pendingTimers(1000), 0);

  harness.document.hidden = false;
  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.audio.paused, true);
});

test("a transient Audio Session interruption resumes once focus returns", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();

  assert.equal(harness.audio.playCalls, 1);
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 2);
});

test("focus return clears a hold when native playback never paused", () => {
  const harness = createHarness({
    tracks: [
      { id: "track-1", title: "One", artist: "A", duration: 180 },
      { id: "track-2", title: "Two", artist: "B", duration: 180 }
    ]
  });
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();

  harness.audio.ended = true;
  harness.audio.paused = true;
  harness.audio.dispatch("ended");
  assert.equal(harness.window.Player.pos(), 1);
});

test("native focus resume prevents a duplicate fallback play", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.audio.play();
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 2);
});

test("an explicit pause during an interruption prevents automatic resume", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.window.Player.toggle();

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
});

test("a system Media Session pause preserves intent through an interruption", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.pause();
  assert.equal(harness.window.Player.playbackRequested(), true);
  assert.equal(harness.audio.paused, true);

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 2);
  assert.equal(harness.audio.paused, false);
});

test("a system Media Session pause can arrive before the interruption event", () => {
  const harness = createHarness();
  harness.audioSession.state = "active";
  harness.play();
  harness.pause();
  assert.equal(harness.audio.paused, true);

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.window.Player.playbackRequested(), true);
  assert.equal(harness.audio.playCalls, 2);
  assert.equal(harness.audio.paused, false);
});

test("a later lock-screen pause during an interruption stays paused", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.runTimers(500);

  harness.pause();
  harness.runTimers(500);
  assert.equal(harness.window.Player.playbackRequested(), false);

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.audio.paused, true);
});

test("native playback cannot outrun a pending explicit Media Session pause", () => {
  const harness = createHarness();
  harness.audioSession.state = "active";
  harness.play();
  harness.pause();

  harness.audio.play();
  assert.equal(harness.audio.paused, true);
  harness.runTimers(500);
  assert.equal(harness.window.Player.playbackRequested(), false);
  assert.equal(harness.audio.paused, true);
});

test("a pause cancels a source resolution already in flight", async () => {
  const harness = createHarness({ withStorage: true });
  let resolveSource;
  harness.Api.resolve = () => new Promise(resolve => { resolveSource = resolve; });
  harness.window.Player.playQueue([
    { id: "track-2", title: "Another", artist: "Artist", duration: 180 }
  ], 0);
  for (let i = 0; i < 20 && !resolveSource; i++) await Promise.resolve();
  assert.equal(typeof resolveSource, "function");

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.runTimers(500);
  harness.pause();
  harness.runTimers(500);
  resolveSource({ url: "https://example.test/track-2.mp3", base: "https://example.test" });
  await flushMicrotasks();

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.window.Player.playbackRequested(), false);
  assert.equal(harness.audio.playCalls, 0);
  assert.equal(harness.audio.src, "");

  harness.Api.resolve = () => Promise.resolve({
    url: "https://example.test/track-2.mp3",
    base: "https://example.test"
  });
  harness.play();
  await flushMicrotasks();
  harness.runImmediateTimers();
  await flushMicrotasks();
  assert.equal(harness.audio.src, "https://example.test/track-2.mp3");
  assert.equal(harness.audio.paused, false);
});

test("focus can return while a replacement source is still resolving", async () => {
  const harness = createHarness({ withStorage: true });
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();

  let resolveSource;
  harness.Api.resolve = () => new Promise(resolve => { resolveSource = resolve; });
  harness.window.Player.playQueue([
    { id: "track-2", title: "Another", artist: "Artist", duration: 180 }
  ], 0);
  for (let i = 0; i < 20 && !resolveSource; i++) await Promise.resolve();
  assert.equal(typeof resolveSource, "function");

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  resolveSource({ url: "https://example.test/track-2.mp3", base: "https://example.test" });
  await flushMicrotasks();
  harness.runImmediateTimers();
  await flushMicrotasks();

  assert.equal(harness.audio.src, "https://example.test/track-2.mp3");
  assert.equal(harness.audio.paused, false);
});

test("an inactive Audio Session does not trigger a resume", () => {
  const harness = createHarness();
  harness.play();
  harness.audio.pause();
  harness.audioSession.state = "inactive";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  harness.runTimers(1000);
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.pendingTimers(1000), 0);
});

test("inactive invalidates a queued resume but retains intent for the next focus return", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");

  harness.audioSession.state = "inactive";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 2);
});

test("starting another track invalidates a queued focus-return resume", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");

  harness.window.Player.playQueue([
    { id: "track-2", title: "Another", artist: "Artist", duration: 180 }
  ], 0);
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
});

test("focus return does not resume while the device is offline", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.navigator.onLine = false;

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
});

test("an interrupted pause cannot arm stall recovery", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.audio.dispatch("waiting");

  assert.equal(harness.pendingTimers(8000), 0);
});

test("a permanent platform pause cannot arm late stall recovery", () => {
  const harness = createHarness();
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  harness.audioSession.state = "inactive";
  harness.audioSession.dispatch("statechange");
  harness.audio.dispatch("waiting");

  assert.equal(harness.pendingTimers(8000), 0);
});

test("network recovery resumes while the app remains hidden", () => {
  const harness = createHarness();
  harness.play();
  harness.navigator.onLine = false;
  harness.window.dispatch("offline");
  assert.equal(harness.audio.paused, true);

  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.navigator.onLine = true;
  harness.window.dispatch("online");
  assert.equal(harness.audio.playCalls, 2);
  assert.equal(harness.audio.paused, false);

  harness.document.hidden = false;
  harness.document.visibilityState = "visible";
  harness.document.dispatch("visibilitychange");
  assert.equal(harness.audio.playCalls, 2);
});

test("a blocked background network resume is retried", async () => {
  const harness = createHarness();
  harness.play();
  harness.navigator.onLine = false;
  harness.window.dispatch("offline");
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";

  const normalPlay = harness.audio.play.bind(harness.audio);
  harness.audio.play = () => {
    harness.audio.playCalls++;
    return Promise.reject(new Error("background start blocked"));
  };
  harness.navigator.onLine = true;
  harness.window.dispatch("online");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.pendingTimers(1000), 1);
  harness.audio.play = normalPlay;
  harness.runTimers(1000);
  assert.equal(harness.audio.paused, false);
  assert.equal(harness.audio.playCalls, 3);
});

test("network and focus recovery wait for both conditions", () => {
  const harness = createHarness();
  harness.play();
  harness.navigator.onLine = false;
  harness.window.dispatch("offline");
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.navigator.onLine = true;
  harness.window.dispatch("online");
  assert.equal(harness.audio.playCalls, 1);

  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 2);
});

test("an online event cannot reclaim focus from a hidden generic platform pause", () => {
  const harness = createHarness();
  harness.audioSession.state = "active";
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.document.dispatch("visibilitychange");
  harness.audio.pause();

  harness.window.dispatch("online");
  harness.runImmediateTimers();
  assert.equal(harness.audio.playCalls, 1);
  assert.equal(harness.audio.paused, true);
});

test("the end of a track waits for the radio request already in flight", async () => {
  const harness = createHarness({
    exposeInternals: true,
    settings: { autoplay: true, musicOnly: false },
    withAudioSession: false
  });
  let release;
  harness.Api.resolve = () => new Promise(resolve => { release = resolve; });
  const events = [];
  harness.window.Player.onChange(ev => events.push(ev.type));

  harness.window.__playerInternals.prefetchNext();
  const advance = harness.window.__playerInternals.next(true);
  release({ related: [
    { id: "track-2", title: "Two", artist: "A", duration: 180 },
    { id: "track-3", title: "Three", artist: "B", duration: 180 },
    { id: "track-4", title: "Four", artist: "C", duration: 180 }
  ] });
  await advance;

  assert.equal(events.includes("queue-end"), false);
  assert.equal(harness.window.Player.queue().length, 4);
  assert.equal(harness.window.Player.pos(), 1);
});

test("slow radio waits for new songs without replaying the previous queue", async () => {
  const harness = createHarness({
    exposeInternals: true,
    settings: { autoplay: true, musicOnly: false },
    withAudioSession: false
  });
  let release;
  harness.Api.resolve = id => id === 'track-1' ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ url: 'https://test/' + id, related: [] });
  harness.Api.getSkipSegments = async () => [];
  const events = [];
  harness.window.Player.onChange(ev => events.push(ev.type));
  harness.play();
  harness.window.__playerInternals.prefetchNext();
  harness.audio.ended = true;
  harness.audio.paused = true;

  const advance = harness.window.__playerInternals.next(true);
  harness.runTimers(1200);
  await flushMicrotasks(60);

  assert.equal(events.includes("queue-end"), false);
  assert.equal(harness.window.Player.pos(), 0);
  assert.equal(harness.audio.paused, true);
  assert.equal(harness.audio.playCalls, 1);
  release({ related: [{ id: 'fresh', title: 'Fresh', artist: 'Artist', duration: 180 }] });
  await advance;
  await flushMicrotasks(60);
  assert.equal(harness.window.Player.current().id, 'fresh');
  assert.equal(harness.audio.paused, false);
  harness.window.Player.dismiss();
});

test("a prepared transition is not committed before playback starts", async () => {
  const harness = createHarness({
    exposeInternals: true,
    tracks: [
      { id: "track-1", title: "One", artist: "A", duration: 180 },
      { id: "track-2", title: "Two", artist: "B", duration: 180 }
    ],
    withAudioSession: false
  });
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.window.__playerInternals.keepPreparedSource({
    ni: 1, id: "track-2", src: "https://example.test/track-2.mp3", blobUrl: null, localKind: null, gain: 1
  });

  let release;
  harness.audio.play = () => {
    harness.audio.playCalls++;
    return new Promise(resolve => { release = resolve; });
  };
  harness.audio.paused = true;
  harness.audio.ended = true;

  assert.equal(harness.window.__playerInternals.playPreparedInstantly(), true);
  assert.equal(harness.window.Player.pos(), 0);

  harness.audio.paused = false;
  harness.audio.ended = false;
  harness.audio.dispatch("play");
  release();
  await Promise.resolve();

  assert.equal(harness.window.Player.pos(), 1);
});

test("an interrupted prepared transition keeps source and metadata together", async () => {
  const harness = createHarness({
    exposeInternals: true,
    tracks: [
      { id: "track-1", title: "One", artist: "A", duration: 180 },
      { id: "track-2", title: "Two", artist: "B", duration: 180 }
    ]
  });
  harness.play();
  harness.document.hidden = true;
  harness.document.visibilityState = "hidden";
  harness.window.__playerInternals.keepPreparedSource({
    ni: 1, id: "track-2", src: "https://example.test/track-2.mp3", blobUrl: null, localKind: null, gain: 1
  });

  const normalPlay = harness.audio.play.bind(harness.audio);
  harness.audio.play = () => {
    harness.audio.playCalls++;
    harness.audio.paused = true;
    return Promise.reject(new Error("audio focus interrupted"));
  };
  assert.equal(harness.window.__playerInternals.playPreparedInstantly(), true);
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  await flushMicrotasks();

  assert.equal(harness.window.Player.pos(), 1);
  assert.equal(harness.window.Player.current().id, "track-2");
  assert.equal(harness.audio.src, "https://example.test/track-2.mp3");

  harness.audio.play = normalPlay;
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  assert.equal(harness.audio.paused, false);
  assert.equal(harness.window.Player.current().id, "track-2");
});

test("explicit play of a held source waits for active focus after an inactive transition", async () => {
  const harness = createHarness({ exposeInternals: true, withStorage: true });
  harness.Api.resolve = () => Promise.resolve({
    url: "https://example.test/reloaded.mp3",
    base: "https://example.test"
  });
  harness.play();
  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.audio.pause();
  const track = harness.window.Player.current();
  harness.window.__playerInternals.stopAudio(true);
  harness.window.__playerInternals.scheduleSourceRetry(track, 12, "test interruption");
  harness.audioSession.state = "inactive";
  harness.audioSession.dispatch("statechange");

  harness.play();
  await flushMicrotasks();
  assert.equal(harness.audio.src, "");
  assert.equal(harness.audio.playCalls, 1);
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  await flushMicrotasks();
  harness.runImmediateTimers();
  await flushMicrotasks();
  harness.runImmediateTimers();
  await flushMicrotasks();
  assert.equal(harness.audio.src, "https://example.test/reloaded.mp3");
  assert.equal(harness.audio.paused, false);
});

function sessionState(h, state) {
  h.audioSession.state = state;
  h.audioSession.dispatch("statechange");
}

for (const intermediateInactive of [false, true]) {
  test("call interruption resumes in the background only after active focus, inactive=" + intermediateInactive, () => {
    const h = createHarness();
    h.play();
    h.document.hidden = true;
    sessionState(h, "interrupted");
    h.audio.pause(); // Native phone interruption.
    if (intermediateInactive) sessionState(h, "inactive");
    for (const event of ["pageshow", "online"]) h.window.dispatch(event);
    h.document.hidden = false;
    h.document.dispatch("visibilitychange");
    h.play(); // Even a Media Session play must wait while interruption is known.
    h.runImmediateTimers();
    h.runIntervals(5000);
    assert.equal(h.audio.playCalls, 1);
    assert.equal(h.audio.paused, true);
    h.document.hidden = true;
    sessionState(h, "active");
    h.runImmediateTimers();
    assert.equal(h.audio.playCalls, 2);
    assert.equal(h.audio.currentTime, 12);
    assert.equal(h.audio.paused, false);
  });
}

test("a late native pause cannot erase confirmed focus return", () => {
  const h = createHarness();
  h.play();
  sessionState(h, "interrupted");
  sessionState(h, "active");
  h.audio.pause();
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
});

test("native iOS resume can precede the active statechange notification", () => {
  const h = createHarness();
  h.play();
  sessionState(h, "interrupted");
  h.audio.pause();
  h.audioSession.state = "active";
  h.audio.play(); // WebKit has resumed, its statechange event is still queued.
  assert.equal(h.audio.paused, false);
  h.audioSession.dispatch("statechange");
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 2);
});

test("duplicate active notifications do not lose or duplicate the pending resume", () => {
  const h = createHarness();
  h.play();
  sessionState(h, "interrupted");
  h.audio.pause();
  sessionState(h, "active");
  sessionState(h, "active");
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 2);
});

test("native Android focus recovery can resume while the PWA remains hidden", () => {
  const h = createHarness({ withAudioSession: false });
  h.play();
  h.document.hidden = true;
  h.audio.pause();
  h.runImmediateTimers();
  h.runIntervals(5000);
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.window.Player.playbackRequested(), true);
  h.audio.play(); // Chrome resumes the interrupted media element on focus gain.
  assert.equal(h.audio.paused, false);
  assert.equal(h.navigator.mediaSession.playbackState, "playing");
  assert.equal(h.audio.currentTime, 12);
  h.document.hidden = false;
  h.document.dispatch("visibilitychange");
  assert.equal(h.audio.playCalls, 2);
});

for (const withAudioSession of [false, true]) {
  test("navigation ducking preserves volume preference and background playback, Audio Session=" + withAudioSession, () => {
    const h = createHarness({ withAudioSession });
    h.play();
    h.audioSession.state = "active";
    h.window.Player.setVolume(0.7);
    h.document.hidden = true;
    h.document.dispatch("visibilitychange");
    // The OS normally ducks outside element.volume. Also cover an engine that
    // reports volumechange: neither path should restart or overwrite its level.
    h.audio.volume = 0.2;
    h.audio.dispatch("volumechange");
    h.audio.dispatch("timeupdate");
    h.runIntervals(5000);
    assert.equal(h.audio.volume, 0.2);
    assert.equal(h.window.Player.volume(), 0.7);
    assert.equal(h.audio.playCalls, 1);
    assert.equal(h.audio.paused, false);
    h.audio.volume = 0.7;
    h.audio.dispatch("volumechange");
    assert.equal(h.audio.playCalls, 1);
  });
}

for (const outcome of ["resume", "pause", "interrupt", "inactive", "exhausted", "new source"]) {
  test("a rejected focus resume retries safely: " + outcome, async () => {
    const h = createHarness();
    h.play();
    h.document.hidden = true;
    sessionState(h, "interrupted");
    h.audio.pause();
    const nativePlay = h.audio.play;
    h.audio.play = function () {
      this.playCalls++;
      return Promise.reject(new Error("output not ready"));
    };
    sessionState(h, "active");
    h.runImmediateTimers();
    await flushMicrotasks();
    assert.equal(h.audio.playCalls, 2);
    assert.equal(h.pendingTimers(500), 1);
    if (outcome === "resume") h.audio.play = nativePlay;
    if (outcome === "pause") h.window.Player.pause();
    if (outcome === "interrupt") sessionState(h, "interrupted");
    if (outcome === "inactive") sessionState(h, "inactive");
    if (outcome === "new source") h.window.Player.playQueue([{ id: "new", title: "New" }], 0);
    h.runTimers(500);
    await flushMicrotasks();
    h.runTimers(1500);
    await flushMicrotasks();
    h.runTimers(1500);
    assert.equal(h.audio.playCalls, outcome === "resume" ? 3 : outcome === "exhausted" ? 4 : 2);
    assert.equal(h.audio.paused, outcome !== "resume");
    assert.equal(h.pendingTimers(1500), 0);
  });
}

test("an explicit pause during intermediate inactive cancels call recovery", () => {
  const h = createHarness();
  h.play();
  sessionState(h, "interrupted");
  h.audio.pause();
  sessionState(h, "inactive");
  h.window.Player.pause();
  sessionState(h, "active");
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.window.Player.playbackRequested(), false);
});

test("a second call does not leave recovery blocked by the first pending play promise", async () => {
  const h = createHarness();
  h.play();
  sessionState(h, "interrupted");
  h.audio.pause();
  const nativePlay = h.audio.play;
  let rejectFirst;
  h.audio.play = function () {
    this.playCalls++;
    return new Promise((resolve, reject) => { rejectFirst = reject; });
  };
  sessionState(h, "active");
  h.runImmediateTimers();
  sessionState(h, "interrupted");
  h.audio.play = nativePlay;
  sessionState(h, "active");
  h.runImmediateTimers();
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.playCalls, 3);
  rejectFirst(new Error("previous call interrupted play"));
  await flushMicrotasks();
  h.runTimers(500);
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.playCalls, 3);
});

test("an unrelated inactive to active transition never resumes a generic pause", () => {
  const h = createHarness();
  h.play();
  h.audio.pause();
  sessionState(h, "inactive");
  sessionState(h, "active");
  h.document.dispatch("visibilitychange");
  h.window.dispatch("online");
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 1);
});

test("network recovery respects interrupted state before its notification arrives", () => {
  const h = createHarness();
  h.play();
  h.navigator.onLine = false;
  h.window.dispatch("offline");
  assert.equal(h.audio.paused, true);
  h.audioSession.state = "interrupted";
  h.navigator.onLine = true;
  h.window.dispatch("online");
  assert.equal(h.audio.playCalls, 1);
  h.audioSession.dispatch("statechange");
  sessionState(h, "active");
  h.runImmediateTimers();
  assert.equal(h.audio.playCalls, 2);
});

test("YouTube retains call recovery through inactive and a late paused event", async () => {
  const h = createHarness({ withYt: true, exposeInternals: true });
  await h.window.__playerInternals.playViaYt(h.window.Player.current());
  h.document.hidden = true;
  sessionState(h, "interrupted");
  sessionState(h, "inactive");
  h.runImmediateTimers();
  assert.equal(h.ytPlayer().playCalls, 0);
  sessionState(h, "active");
  h.ytPlayer().dispatchState(2);
  h.runImmediateTimers();
  await flushMicrotasks();
  assert.equal(h.ytPlayer().playCalls, 1);
  assert.equal(h.ytPlayer().state, 1);
});

test("focus return restarts a retry even when interruption began without a source", async () => {
  const harness = createHarness({ exposeInternals: true, withStorage: true });
  harness.Api.resolve = () => Promise.resolve({
    url: "https://example.test/reloaded.mp3",
    base: "https://example.test"
  });
  harness.play();
  const track = harness.window.Player.current();
  harness.window.__playerInternals.stopAudio(true);
  assert.equal(harness.audio.src, "");

  harness.audioSession.state = "interrupted";
  harness.audioSession.dispatch("statechange");
  harness.window.__playerInternals.scheduleSourceRetry(track, 12, "test interruption");
  harness.audioSession.state = "active";
  harness.audioSession.dispatch("statechange");
  harness.runImmediateTimers();
  await flushMicrotasks();
  harness.runImmediateTimers();
  await flushMicrotasks();

  assert.equal(harness.audio.src, "https://example.test/reloaded.mp3");
  assert.equal(harness.audio.paused, false);
});

test("an explicit pause cancels a pending source-outage retry", () => {
  const harness = createHarness({ exposeInternals: true, withAudioSession: false });
  harness.play();
  const track = harness.window.Player.current();
  harness.window.__playerInternals.stopAudio(true);
  harness.window.__playerInternals.scheduleSourceRetry(track, 12, "test outage");
  assert.equal(harness.pendingTimers(2000), 1);

  harness.pause();
  assert.equal(harness.pendingTimers(2000), 0);
});

// Some Safari builds dispatch Audio Session statechange without a readable state, so the
// interrupted/active branches never run. There an interruption is identified by adjacency:
// a session event beside a Media Session pause. A listener's own lock-screen pause raises
// no session event, so the quiet decision window still commits it as an explicit pause.

function statelessHarness(options) {
  const h = createHarness(options);
  delete h.audioSession.state;
  return h;
}

for (const browser of ["iPhone", "Android"]) {
  for (const progressing of [false, true]) {
    test(browser + " verifies position after a native resume event, progressing=" + progressing, async () => {
      let now = 1000000;
      const h = statelessHarness({ withAudioSession: browser === "iPhone", Date: { now: () => now } });
      h.play();
      h.audio.currentTime = 8.95;
      h.document.hidden = true;
      h.document.dispatch("visibilitychange");
      h.audio.pause();
      if (browser === "iPhone") h.audioSession.dispatch("statechange");
      h.runTimers(500);
      now += 9319;
      h.audio.play(); // Native play fires, but the decoder may remain stuck.
      if (browser === "iPhone") h.audioSession.dispatch("statechange");
      if (progressing) h.audio.currentTime += 0.5;
      now += 1000;
      h.runTimers(1000);
      await flushMicrotasks();
      assert.equal(h.audio.playCalls, progressing ? 2 : 3);
      assert.equal(h.audio.currentTime, progressing ? 9.45 : 8.95);
      assert.equal(h.audio.src, "https://example.test/track-1.mp3");
      assert.equal(h.window.Player.playbackRequested(), true);
      if (!progressing) {
        // A play promise and even playing are not progress confirmations.
        h.audio.dispatch("playing");
        h.runTimers(1000);
        h.runTimers(1000);
        h.runTimers(4000);
        h.runTimers(8000);
        assert.equal(h.audio.playCalls, 4, "one restart and one source reload, never a play-event retry loop");
      }
    });
  }
}

test("reopening the app checks a native resume whose background timer was frozen", async () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.audio.currentTime = 8.95;
  h.audio.pause();
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  now += 9319;
  h.audio.play();
  h.audioSession.dispatch("statechange");
  now += 10075;
  h.document.hidden = false;
  h.document.dispatch("visibilitychange");
  h.runTimers(1000);
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 3);
  assert.equal(h.audio.currentTime, 8.95);
});

for (const outcome of ["listener pause", "lock-screen pause", "second interruption", "inactive", "queue cleared", "TV connected", "offline", "progress"]) {
  test("native resume verification respects " + outcome, () => {
    const h = statelessHarness();
    h.play();
    h.document.hidden = true;
    h.audio.pause();
    h.audio.play();
    h.audioSession.dispatch("statechange");
    h.audio.dispatch("timeupdate"); // A stationary update cannot confirm playback.
    if (outcome === "listener pause") h.window.Player.pause();
    if (outcome === "lock-screen pause") {
      h.runTimers(500); // Outside the session-event adjacency window.
      h.pause();
    }
    if (outcome === "second interruption") h.audio.pause();
    if (outcome === "inactive") sessionState(h, "inactive");
    if (outcome === "queue cleared") h.window.Player.playQueue([]);
    if (outcome === "TV connected") h.audio.remote.state = "connected";
    if (outcome === "offline") h.navigator.onLine = false;
    if (outcome === "progress") {
      h.audio.currentTime += 0.5;
      h.audio.dispatch("timeupdate");
    }
    h.runTimers(1000);
    h.runTimers(1000);
    assert.equal(h.audio.playCalls, 2);
  });
}

test("a rejected restart after native play keeps interruption intent without polling", async () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.audio.pause();
  h.audio.play();
  h.audioSession.dispatch("statechange");
  h.audio.play = () => {
    h.audio.playCalls++;
    return Promise.reject(new Error("audio still held"));
  };
  h.runTimers(1000);
  await flushMicrotasks();
  h.runTimers(1000);
  h.runTimers(8000);
  h.runIntervals(5000);
  assert.equal(h.audio.playCalls, 3);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("a decoder restart near the iPhone track endpoint does not finish the queue", async () => {
  const h = statelessHarness({ navigator: { userAgent: "iPhone" } });
  h.play();
  h.audio.pause();
  h.audio.currentTime = 179.5;
  h.audio.play();
  h.audioSession.dispatch("statechange");
  h.runTimers(1000);
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 3);
  assert.equal(h.audio.currentTime, 179.5);
  assert.equal(h.window.Player.playbackRequested(), true);
});

for (const signal of ["session event", "iPhone app visible", "Android app visible"]) {
  for (const progressing of [false, true]) {
    test("an unpaused interruption is reconciled on " + signal + ", progressing=" + progressing, async () => {
      let now = 1000000;
      const h = statelessHarness({ Date: { now: () => now },
        withAudioSession: signal !== "Android app visible" });
      h.play();
      h.document.hidden = true;
      h.document.dispatch("visibilitychange");

      // First reel: the platform resumes normally on a quick exit.
      h.audio.pause();
      if (signal !== "Android app visible") h.audioSession.dispatch("statechange");
      h.runTimers(500);
      now += 1686;
      h.audio.play();
      if (signal !== "Android app visible") h.audioSession.dispatch("statechange");
      h.runTimers(500);
      assert.equal(h.audio.playCalls, 2);

      // Second reel: the element reports unpaused without a play notification.
      now += 8277;
      h.audio.pause();
      if (signal !== "Android app visible") h.audioSession.dispatch("statechange");
      h.runTimers(500);
      now += 7120;
      h.audio.paused = false;
      const at = h.audio.currentTime;
      const src = h.audio.src;
      if (signal === "session event") h.audioSession.dispatch("statechange");
      else {
        h.document.hidden = false;
        h.document.dispatch("visibilitychange");
      }
      if (progressing) h.audio.currentTime += 0.5;
      now += 500;
      h.runTimers(500);
      await flushMicrotasks();
      assert.equal(h.audio.playCalls, progressing ? 2 : 3,
        "restart stalled native playback once, leave advancing playback alone");
      assert.equal(h.audio.paused, false);
      assert.equal(h.audio.currentTime, at + (progressing ? 0.5 : 0));
      assert.equal(h.audio.src, src);
      assert.equal(h.window.Player.playbackRequested(), true);

      // Clearing the old hold lets the next genuine track end work again.
      h.audio.ended = true;
      h.audio.currentTime = h.audio.duration;
      h.audio.dispatch("ended");
      await flushMicrotasks();
      assert.equal(h.window.Player.playbackRequested(), false);
    });
  }
}

test("a stateless session event beside a Media Session pause keeps intent and resumes on return", () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");

  h.pause(); // The OS routes the interruption through the pause action.
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), true);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.playCalls, 1);

  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
});

test("a stateless session event can precede its Media Session pause action", () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");

  h.audioSession.dispatch("statechange");
  h.pause();
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), true);
  assert.equal(h.audio.paused, true);

  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
});

test("a stateless Media Session pause with no session event stays a listener pause", () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");

  h.pause();
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), false);

  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.paused, true);
});

// WebKit restores an interrupted element to the last state a script asked for. The
// platform has already paused the element when the interruption's own events arrive,
// so a script pause() there changes nothing except pinning that restore state to
// paused, which cancels the engine's own resume at the interruption's end.
for (const order of ["pause action first", "session event first"]) {
  test("a stateless interruption of an element the platform already paused is not paused again by script, " + order, () => {
    const h = statelessHarness();
    h.play();
    h.document.hidden = true;
    h.document.visibilityState = "hidden";
    h.document.dispatch("visibilitychange");
    assert.equal(h.audio.pauseCalls, 0);

    h.audio.pause(); // The platform pauses the element as the interruption begins.
    assert.equal(h.audio.pauseCalls, 1);
    if (order === "pause action first") {
      h.pause();
      h.audioSession.dispatch("statechange");
    } else {
      h.audioSession.dispatch("statechange");
      h.pause();
    }
    h.runTimers(500);
    assert.equal(h.window.Player.playbackRequested(), true);
    assert.equal(h.audio.paused, true);
    assert.equal(h.audio.pauseCalls, 1);

    // The engine resumes the element itself when the interruption ends.
    h.audio.play();
    assert.equal(h.window.Player.playbackRequested(), true);
    assert.equal(h.audio.paused, false);
    assert.ok(h.logs.some(entry => entry.message.startsWith("play event after interruption")));
  });
}

test("a lock-screen pause of an element the platform already paused still commits as a listener pause", () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");

  h.audio.pause();
  h.pause();
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), false);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.pauseCalls, 2);

  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.paused, true);
});

test("a later stateless session event resumes the held interruption in the background", async () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  h.pause();
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  assert.equal(h.window.Player.playbackRequested(), true);

  now += 300000; // The other app holds the audio for minutes.
  h.audioSession.dispatch("statechange"); // The interruption ends.
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.pendingTimers(500), 1);
  h.runTimers(500);
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("successive stateless return signals do not discard the only pending resume", async () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.audio.pause();
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  now += 7000;
  h.audioSession.dispatch("statechange");
  now += 100;
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, false);
});

for (const cancel of ["listener pause", "lock-screen pause", "new interruption", "app hidden", "offline", "queue cleared", "TV connected"]) {
  test("unpaused focus recovery yields to " + cancel, () => {
    let now = 1000000;
    const h = statelessHarness({ Date: { now: () => now } });
    h.play();
    h.document.hidden = true;
    h.audio.pause();
    now += 7000;
    h.audio.paused = false;
    h.document.hidden = false;
    h.document.dispatch("visibilitychange");
    if (cancel === "listener pause") h.window.Player.pause();
    if (cancel === "lock-screen pause") h.pause();
    if (cancel === "new interruption") {
      now += 100;
      h.audio.pause();
    }
    if (cancel === "app hidden") {
      h.document.hidden = true;
      h.document.dispatch("visibilitychange");
    }
    if (cancel === "offline") h.navigator.onLine = false;
    if (cancel === "queue cleared") h.window.Player.playQueue([]);
    if (cancel === "TV connected") h.audio.remote.state = "connected";
    now += 2000; // Even a delayed callback must respect the newer interruption.
    h.runTimers(500);
    h.runIntervals(5000);
    assert.equal(h.audio.playCalls, 1);
  });
}

test("a rejected unpaused restart is bounded and can retry when the app reopens", async () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.audio.pause();
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  now += 7000;
  h.audio.paused = false;
  const nativePlay = h.audio.play.bind(h.audio);
  h.audio.play = () => {
    h.audio.playCalls++;
    return Promise.reject(new Error("another app still holds audio"));
  };
  h.audioSession.dispatch("statechange");
  h.runTimers(500);
  await flushMicrotasks();
  h.runTimers(500);
  h.runTimers(1500);
  h.runIntervals(5000);
  assert.equal(h.audio.playCalls, 2);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);

  h.audio.play = nativePlay;
  h.document.hidden = false;
  h.document.dispatch("visibilitychange");
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 3);
  assert.equal(h.audio.paused, false);
});

test("a session event beside a fresh pause never schedules a background resume", () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  h.audio.pause(); // The element pause lands before any session event.
  now += 200;
  h.audioSession.dispatch("statechange");
  assert.equal(h.pendingTimers(500), 1); // Only the pause expectation window.
  h.runTimers(500);
  h.runTimers(500);
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("a new interruption inside the settle window reclaims the session event", () => {
  let now = 1000000;
  const h = statelessHarness({ Date: { now: () => now } });
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  h.pause();
  h.audioSession.dispatch("statechange");
  h.runTimers(500);

  now += 60000;
  h.audioSession.dispatch("statechange"); // Could be the end, could be a new interruption.
  assert.equal(h.pendingTimers(500), 1);
  now += 100;
  h.pause(); // A new interruption claims the window first,
  h.audioSession.dispatch("statechange"); // with its own session event beside it.
  h.runTimers(500);
  assert.equal(h.audio.playCalls, 1);
  assert.equal(h.audio.paused, true);
  assert.equal(h.window.Player.playbackRequested(), true);
});

test("hiding the app again drops the stand-in focus confirmation", async () => {
  const h = statelessHarness();
  h.play();
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  h.pause();
  h.audioSession.dispatch("statechange");

  const nativePlay = h.audio.play.bind(h.audio);
  h.audio.play = () => {
    h.audio.playCalls++;
    return Promise.reject(new Error("focus still held"));
  };
  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  await flushMicrotasks();
  assert.equal(h.audio.playCalls, 2);

  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  h.audio.play = nativePlay;
  h.window.dispatch("online");
  h.runTimers(500);
  h.runTimers(1500);
  assert.equal(h.audio.playCalls, 2, "no hidden retries once the app is left again");
  assert.equal(h.audio.paused, true);
});
