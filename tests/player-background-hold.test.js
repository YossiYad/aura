const assert = require("node:assert/strict");
const test = require("node:test");

const { createHarness, flushMicrotasks } = require("./harness.js");

// The reported iOS 27 sequence: a hidden page loses its audio to another app,
// nothing at all is logged until the app is reopened, and playback only then
// recovers. WebKit releases the process assertion it takes for audible playback
// a fixed interval after the audio stops, and a suspended process runs no
// timer. The background hold tick records how long the page actually ran so
// the next device log can tell a frozen page from a missing platform signal.
function backgroundInterruption() {
  let now = 1000000;
  const h = createHarness({
    withAudioContext: true,
    Date: { now: () => now },
    navigator: { userAgent: "iPhone" }
  });
  delete h.audioSession.state;
  h.play();
  const ctx = h.audioContexts[0];
  ctx.setState("running");
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  return {
    ...h, ctx,
    advance(ms) { now += ms; },
    tick(times = 1) {
      for (let i = 0; i < times; i++) { now += 1000; h.runIntervals(1000); }
    },
    interrupt() {
      h.audio.currentTime = 62.57;
      h.audio.pause();
      ctx.setState("suspended");
    },
    reopen() {
      h.document.hidden = false;
      h.document.visibilityState = "visible";
      h.document.dispatch("visibilitychange");
    },
    holdLines() {
      return h.logs.filter(entry => entry.tag === "background" && entry.message.startsWith("hold hidden "));
    }
  };
}

test("reopening after a frozen background hold reports how long the page ran", async () => {
  const h = backgroundInterruption();
  h.interrupt();
  // The interruption's own session and context events arrive within moments of
  // the pause; they must not be mistaken for the hold's end.
  assert.equal(h.holdLines().length, 0);
  h.tick(10);        // The page runs for ten seconds after the interruption.
  h.advance(14400);  // Then the process is suspended: no timer fires.
  h.reopen();
  await flushMicrotasks();
  const lines = h.holdLines();
  assert.equal(lines.length, 1, "one summary line per hold");
  assert.equal(lines[0].message,
    "hold hidden 24.4s until app visible: page frozen 14.4s from +10.0s; " +
    "10 ticks, gaps 1.0 1.0 1.0 1.0 1.0 1.0 1.0 1.0 | 14.4s");
  assert.equal(h.audio.paused, false, "reopening still resumes the held playback");
});

test("an overdue tick that runs just before the reopen still reports the freeze", () => {
  // The device sequence: the page ran for a while, the process was suspended,
  // and on resume the overdue interval fired a moment before visibilitychange.
  const h = backgroundInterruption();
  h.interrupt();
  h.tick(10);
  h.advance(31000);
  h.runIntervals(1000);
  h.reopen();
  const lines = h.holdLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message,
    "hold hidden 41.0s until app visible: page frozen 31.0s from +10.0s; " +
    "11 ticks, gaps 1.0 1.0 1.0 1.0 1.0 1.0 1.0 31.0 | 0.0s");
});

test("a context focus return in the background reports a page that kept running", async () => {
  const h = backgroundInterruption();
  h.interrupt();
  h.tick(3);
  h.advance(300);
  h.ctx.setState("running");
  await flushMicrotasks();
  const lines = h.holdLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message,
    "hold hidden 3.3s until audio context running: page ran throughout; 3 ticks, gaps 1.0 1.0 1.0 | 0.3s");
  assert.equal(h.audio.paused, false, "the focus-return resume is unchanged");
  assert.equal(h.document.hidden, true);
});

test("a lock-screen play during the hold reports the page waking for the command", () => {
  const h = backgroundInterruption();
  h.interrupt();
  h.tick(2);
  h.advance(5000);
  h.play();
  const lines = h.holdLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message,
    "hold hidden 7.0s until media-session play: page frozen 5.0s from +2.0s; 2 ticks, gaps 1.0 1.0 | 5.0s");
});

test("an explicit pause ends the hold tick without a report", () => {
  const h = backgroundInterruption();
  h.interrupt();
  h.tick(2);
  h.window.Player.pause();
  h.tick(3);
  h.reopen();
  assert.equal(h.holdLines().length, 0, "a listener pause is not a held interruption");
  assert.equal(h.audio.paused, true);
});

test("a hold observed in the foreground starts ticking only once the app is hidden", () => {
  let now = 5000000;
  const h = createHarness({ withAudioContext: true, Date: { now: () => now }, navigator: { userAgent: "iPhone" } });
  delete h.audioSession.state;
  h.play();
  h.audioContexts[0].setState("running");
  h.audio.pause(); // Another app takes the audio while Aura is on screen.
  now += 1000; h.runIntervals(1000);
  now += 1000; h.runIntervals(1000);
  h.document.hidden = true;
  h.document.visibilityState = "hidden";
  h.document.dispatch("visibilitychange");
  now += 1000; h.runIntervals(1000);
  now += 1000; h.runIntervals(1000);
  now += 20000;
  h.document.hidden = false;
  h.document.visibilityState = "visible";
  h.document.dispatch("visibilitychange");
  const lines = h.logs.filter(entry => entry.tag === "background" && entry.message.startsWith("hold hidden "));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message,
    "hold hidden 22.0s until app visible: page frozen 20.0s from +2.0s; 2 ticks, gaps 1.0 1.0 | 20.0s");
});

test("a very long hold caps the tick and says so", () => {
  const h = backgroundInterruption();
  h.interrupt();
  h.tick(601);
  h.advance(60000);
  h.reopen();
  const lines = h.holdLines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].message.endsWith(" | capped"), lines[0].message);
  assert.ok(lines[0].message.includes("page ran at least 600.0s (ticking capped); 600 ticks"), lines[0].message);
});
