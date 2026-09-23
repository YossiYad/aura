const assert = require("node:assert/strict");
const test = require("node:test");

const { createHarness } = require("./harness.js");

// Swiping the collapsed bar aside has to end the session outright. Anything less leaves a
// track playing behind a bar that is no longer on screen to stop it.
test("dismiss stops the sound and empties the queue", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();

  harness.window.Player.dismiss();

  assert.equal(harness.window.Player.current(), null);
  assert.equal(harness.window.Player.queue().length, 0);
  assert.equal(harness.window.Player.playbackRequested(), false);
  assert.equal(harness.audio.src, "");
});

// The stored session goes with it, so reopening the app is not handed back the queue that
// was swiped away - restore() only takes a saved queue with something in it.
test("dismiss writes an empty session over the stored one", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();

  harness.window.Player.dismiss();

  const saved = harness.savedQueues[harness.savedQueues.length - 1];
  assert.equal(saved.extra.length, 0);
  assert.equal(saved.pos, -1);
});

// It is a dismissal for now, not a setting. The next thing played is a queue again, and
// the bar comes back with it.
test("playing again after a dismiss brings the queue back", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();
  harness.window.Player.dismiss();

  harness.window.Player.playQueue([{ id: "track-2", title: "Second", artist: "Someone" }], 0);

  assert.equal(harness.window.Player.current().id, "track-2");
});

test("dismiss clears the lock screen card", () => {
  const harness = createHarness({ withAudioSession: false });
  harness.play();

  harness.window.Player.dismiss();

  assert.equal(harness.navigator.mediaSession.metadata, null);
  assert.equal(harness.navigator.mediaSession.playbackState, "none");
});
