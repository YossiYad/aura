const assert = require("node:assert/strict");
const test = require("node:test");

const { createStore } = require("./store-harness.js");

// See store-private-session.test.js: arrays from the store's realm are compared by content.
const ids = list => Array.from(list, item => item.id);

const song = { id: "v1", title: "One", artist: "Someone", thumb: "", duration: 200 };
const lullaby = { id: "v2", title: "Sleep", artist: "Somebody Else", thumb: "", duration: 180 };

// A store with one ordinary playlist and one private one, each holding a song.
function withPlaylists() {
  const h = createStore();
  const { Store } = h;
  Store.addTrack(song);
  Store.addTrack(lullaby);
  h.open = Store.createPlaylist("Everyday");
  Store.addToPlaylist(h.open.id, song.id);
  h.kept = Store.createPlaylist("Bedtime");
  Store.addToPlaylist(h.kept.id, lullaby.id);
  Store.setPlaylistPrivate(h.kept.id, true);
  return h;
}

test("nothing played from a private playlist's queue reaches history, stats or the caches that name a song", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.setQueuePlaylist(h.kept.id);

  assert.equal(Store.privateListening(), true);
  Store.pushRecent(lullaby);
  Store.savePosition("ep", 600);
  Store.cacheLyrics("v2", { plainLyrics: "hush" });
  Store.cacheSegments("v2", [{ start: 1, end: 2, category: "sponsor" }]);

  assert.deepEqual(ids(Store.recents()), []);
  assert.deepEqual(ids(Store.topListeningTracks(5)), []);
  assert.equal(Store.getPosition("ep"), 0);
  assert.equal(Store.cachedLyrics("v2"), null);
  assert.equal(h.read("aura.segments"), null);
});

// Only the listening is private. The mode a private session is - searches dropped, the
// queue kept off the disk - belongs to the session, and a playlist does not switch it on.
test("a private playlist is not a private session: searches and the queue are kept as usual", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.setQueuePlaylist(h.kept.id);

  assert.equal(Store.privateSession(), false);
  Store.pushSearch("something to look up");
  Store.saveQueue({ extra: [lullaby], pos: 0, playlist: h.kept.id });

  assert.deepEqual(Array.from(Store.searches()), ["something to look up"]);
  assert.equal(h.read("aura.queue").playlist, h.kept.id);
  assert.deepEqual(ids(Store.loadQueue().extra), ["v2"]);
});

test("a queue started anywhere else is recorded, and so is one started from an ordinary playlist", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.pushRecent(song);
  Store.setQueuePlaylist(h.open.id);
  Store.pushRecent(lullaby);

  assert.equal(Store.privateListening(), false);
  assert.deepEqual(ids(Store.recents()), ["v2", "v1"]);
});

// The playlist is asked on every play, so the switch works on the queue already running.
test("marking a playlist private while it plays stops the recording, and unmarking starts it again", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.setQueuePlaylist(h.open.id);
  Store.pushRecent(song);
  Store.setPlaylistPrivate(h.open.id, true);
  Store.pushRecent(lullaby);
  assert.deepEqual(ids(Store.recents()), ["v1"]);

  Store.setPlaylistPrivate(h.open.id, false);
  Store.pushRecent(lullaby);
  assert.deepEqual(ids(Store.recents()), ["v2", "v1"]);
  assert.equal("private" in Store.getPlaylist(h.open.id), false, "an unmarked playlist carries no leftover field");
});

test("the next queue is recorded once the private playlist's queue is replaced", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.setQueuePlaylist(h.kept.id);
  Store.pushRecent(lullaby);
  Store.setQueuePlaylist("");
  Store.pushRecent(song);

  assert.deepEqual(ids(Store.recents()), ["v1"]);
});

test("the mark is part of the playlist: it is stored, exported and restored with it", () => {
  const h = withPlaylists();
  const { Store } = h;
  assert.equal(h.read("aura.playlists").find(p => p.id === h.kept.id).private, true);

  const backup = JSON.parse(JSON.stringify(Store.exportData()));
  const other = createStore();
  other.Store.importData(backup);
  assert.equal(other.Store.getPlaylist(h.kept.id).private, true);
  assert.equal(!!other.Store.getPlaylist(h.open.id).private, false);

  // And it is read back from disk on the next launch.
  const again = createStore({ "aura.playlists": h.read("aura.playlists"), "aura.library": h.read("aura.library") });
  again.Store.setQueuePlaylist(h.kept.id);
  again.Store.pushRecent(lullaby);
  assert.deepEqual(ids(again.Store.recents()), []);
});

test("marking a playlist that does not exist changes nothing, and a queue from a deleted playlist is an ordinary queue", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.setPlaylistPrivate("pl_missing", true);
  assert.equal(Store.playlists().length, 2);

  Store.setQueuePlaylist(h.kept.id);
  Store.deletePlaylist(h.kept.id);
  assert.equal(Store.privateListening(), false);
});

test("hiding the private session feature leaves a private playlist private", () => {
  const h = withPlaylists();
  const { Store } = h;
  Store.patchSettings({ privateSession: false });
  Store.setQueuePlaylist(h.kept.id);
  Store.pushRecent(lullaby);

  assert.equal(Store.privateListening(), true);
  assert.deepEqual(ids(Store.recents()), []);
});
