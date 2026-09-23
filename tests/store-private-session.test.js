const assert = require("node:assert/strict");
const test = require("node:test");

const { createStore } = require("./store-harness.js");

// The store builds its arrays inside its own VM realm, where Array is a different
// intrinsic, so deepEqual on them compares prototypes and fails on identical contents.
const ids = list => Array.from(list, item => item.id);

const song = { id: "v1", title: "One", artist: "Someone", thumb: "", duration: 200 };
const other = { id: "v2", title: "Two", artist: "Somebody Else", thumb: "", duration: 180 };

test("a play outside a private session is recorded as usual", () => {
  const { Store } = createStore();
  Store.pushRecent(song);

  assert.deepEqual(ids(Store.recents()), ["v1"]);
  assert.equal(Store.topListeningArtists(5)[0].name, "Someone");
});

test("nothing played in a private session reaches history, stats or searches", () => {
  const { Store } = createStore();
  Store.pushRecent(song);
  Store.setPrivateSession(true);

  Store.pushRecent(other);
  Store.pushSearch("something else entirely");

  assert.deepEqual(ids(Store.recents()), ["v1"]);
  assert.deepEqual(ids(Store.topListeningTracks(5)), ["v1"]);
  assert.deepEqual(Array.from(Store.topListeningArtists(5), a => a.name), ["Someone"]);
  assert.deepEqual(Array.from(Store.searches()), []);
});

test("plays count again once the session ends", () => {
  const { Store } = createStore();
  Store.setPrivateSession(true);
  Store.pushRecent(song);
  Store.setPrivateSession(false);
  Store.pushRecent(other);

  assert.deepEqual(ids(Store.recents()), ["v2"]);
});

// A reload must not quietly start recording again: on a phone the page is dropped and
// rebuilt constantly, and nobody re-checks a switch they never touched.
test("a private session survives a reload", () => {
  const first = createStore();
  first.Store.setPrivateSession(true);

  const second = createStore({ "aura.privateSession": first.read("aura.privateSession") }, first.session());
  second.Store.pushRecent(song);

  assert.equal(second.Store.privateSession(), true);
  assert.deepEqual(Array.from(second.Store.recents()), []);
});

// Leaving the app for good is the other half of that promise. Opening it again later is
// not the same act as never having closed it, and a mode that hides what you play should
// not outlive the sitting it was turned on for.
test("leaving the app ends a private session", () => {
  const first = createStore();
  first.Store.setPrivateSession(true);

  // No session carried over: the app was closed, not reloaded.
  const second = createStore({ "aura.privateSession": first.read("aura.privateSession") });

  assert.equal(second.Store.privateSession(), false);
  assert.equal(second.read("aura.privateSession"), false);
  second.Store.pushRecent(song);
  assert.deepEqual(ids(second.Store.recents()), ["v1"]);
});

// Hiding the feature is what someone does before handing the phone over. A session left
// running behind a switch nobody can see would be the opposite of the promise.
test("hiding the feature ends any session already running", () => {
  const { Store } = createStore();
  Store.setPrivateSession(true);
  Store.patchSettings({ privateSession: false });

  assert.equal(Store.privateSession(), false);
  Store.pushRecent(song);
  assert.deepEqual(ids(Store.recents()), ["v1"]);
});

test("a hidden feature cannot be switched on", () => {
  const { Store } = createStore({ "aura.settings": { privateSession: false } });

  assert.equal(Store.setPrivateSession(true), false);
  Store.pushRecent(song);
  assert.deepEqual(ids(Store.recents()), ["v1"]);
});

test("a private session keeps no resume position, persisted queue or lyrics cache", () => {
  const h = createStore();
  const { Store } = h;
  Store.setPrivateSession(true);
  Store.savePosition("ep", 600);
  assert.equal(Store.getPosition("ep"), 0);
  assert.equal(h.read("aura.positions"), null);
  Store.saveQueue({ extra: [song], pos: 0 });
  assert.equal(h.read("aura.queue"), null, "the queue is not written where a backup or sync would read it");
  assert.deepEqual(ids(Store.loadQueue().extra), ["v1"], "but it survives a reload of the same session");
  Store.cacheLyrics("v1", { plain: "secret words" });
  assert.equal(Store.cachedLyrics("v1"), null);
  Store.setPrivateSession(false);
  assert.equal(Store.loadQueue(), null);
});

test("hiding the feature mid-session leaves no private queue behind for the next one", () => {
  const { Store, session } = createStore();
  Store.saveQueue({ items: [other], index: 0 });
  Store.setPrivateSession(true);
  Store.saveQueue({ items: [song], index: 0 });

  Store.patchSettings({ privateSession: false });
  assert.equal(Object.keys(session()).some(key => /queue/i.test(key)), false);
  Store.patchSettings({ privateSession: true });
  Store.setPrivateSession(true);
  assert.deepEqual(ids(Store.loadQueue().items), ["v2"]);
});
