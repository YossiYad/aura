const assert = require("node:assert/strict");
const test = require("node:test");

const { createStore } = require("./store-harness.js");

test("a saved show list is readable back, newest write winning", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "עושים היסטוריה" }, { name: "Radiolab" }], "he");

  assert.deepEqual(Store.podcastShowsList().map(show => show.name), ["עושים היסטוריה", "Radiolab"]);
  assert.equal(Store.podcastShowsLang(), "he");
  assert.ok(Store.podcastShowsAge() < 1000);
});

test("blank and duplicate names are dropped", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Radiolab" }, { name: "  " }, { name: "radiolab" }, {}], "en");

  assert.deepEqual(Store.podcastShowsList().map(show => show.name), ["Radiolab"]);
});

// The channel is the half that matters: it is what identifies an episode everywhere else
// in the app, long after the row that discovered it has gone.
test("a loaded row teaches the show which channel publishes it", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "עושים היסטוריה" }], "he");
  assert.equal(Store.isPodcastChannel("Ran Levi רן לוי"), false);

  Store.notePodcastChannel("עושים היסטוריה", "Ran Levi רן לוי");

  assert.equal(Store.isPodcastChannel("Ran Levi רן לוי"), true);
  assert.equal(Store.podcastShowsList()[0].channel, "Ran Levi רן לוי");
});

test("a channel learned for a show nobody listed is ignored", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Radiolab" }], "en");

  Store.notePodcastChannel("Some Other Show", "Some Other Channel");

  assert.equal(Store.isPodcastChannel("Some Other Channel"), false);
});

test("channel matching ignores case and spacing", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Darknet Diaries", channel: "Jack Rhysider" }], "en");

  assert.equal(Store.isPodcastChannel("jack   rhysider"), true);
  assert.equal(Store.isPodcastChannel("Jack Rhysider Jr"), false);
  assert.equal(Store.isPodcastChannel(""), false);
  assert.equal(Store.isPodcastChannel(null), false);
});

// Following a podcast is the listener saying outright what it is, which outranks anything
// a suggested list happens to hold.
test("a followed podcast counts as a known podcast channel", () => {
  const { Store } = createStore();
  Store.follow({ id: "ch1", name: "Assaf Itzhaki", kind: "podcast" });

  assert.equal(Store.isPodcastChannel("Assaf Itzhaki"), true);
});

test("a followed artist does not count as a podcast channel", () => {
  const { Store } = createStore();
  Store.follow({ id: "ch2", name: "Some Band", kind: "artist" });

  assert.equal(Store.isPodcastChannel("Some Band"), false);
});

test("a stored list that is not a list is ignored rather than thrown on", () => {
  const { Store } = createStore({ "aura.podcastShows": { at: 1, lang: "he", shows: "nonsense" } });

  assert.equal(Store.podcastShowsList().length, 0);
  assert.equal(Store.isPodcastChannel("anything"), false);
});

// The Latest row asks a channel for its uploads, which needs the id and not just the name.
test("a loaded row records the channel id alongside the name", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "עושים היסטוריה" }], "he");

  Store.notePodcastChannel("עושים היסטוריה", "Ran Levi רן לוי", "UCSXSPF6VkcReGubqbDbXHIg");

  const show = Store.podcastShowsList()[0];
  assert.equal(show.channel, "Ran Levi רן לוי");
  assert.equal(show.channelId, "UCSXSPF6VkcReGubqbDbXHIg");
});

// A source that reports the channel but no id must not wipe an id already learned from one
// that did - the next Latest build would fall back to searching for no reason.
test("a later note without an id keeps the id already learned", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Radiolab", channel: "Radiolab", channelId: "UC123" }], "en");

  Store.notePodcastChannel("Radiolab", "Radiolab", "");

  assert.equal(Store.podcastShowsList()[0].channelId, "UC123");
});

test("a saved list keeps channel ids it was given", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Radiolab", channel: "Radiolab", channelId: "UC123" }], "en");

  assert.equal(Store.podcastShowsList()[0].channelId, "UC123");
});

test("a podcast play stays out of music tracks and artists", () => {
  const { Store } = createStore();
  Store.pushRecent({ id: "ep1", title: "An episode", artist: "A Show", duration: 2400 }, "podcast");

  assert.equal(Store.recents()[0].kind, "podcast");
  assert.equal(Store.topListeningTracks(10).length, 0);
  assert.equal(Store.topListeningArtists(10).length, 0);
  assert.deepEqual(Array.from(Store.topListeningPodcasts(10), show => show.name), ["A Show"]);
  assert.deepEqual(Array.from(Store.topListeningTracks(10, "all"), track => track.id), ["ep1"]);
});

test("a known show title and publisher classify old untyped listening data", () => {
  const profile = {
    tracks: {
      ep1: { plays: 2, lastPlayed: 20, track: { id: "ep1", title: "Known Show | A subject", artist: "Known Channel" } },
      song1: { plays: 1, lastPlayed: 10, track: { id: "song1", title: "A song", artist: "A Singer" } }
    },
    artists: {
      "Known Channel": { plays: 2, lastPlayed: 20 },
      "A Singer": { plays: 1, lastPlayed: 10 }
    }
  };
  const { Store } = createStore({
    "aura.listeningProfile": profile,
    "aura.podcastShows": { at: 1, lang: "en", shows: [{ name: "Known Show", channel: "Known Channel" }] }
  });

  assert.deepEqual(Array.from(Store.topListeningTracks(10), track => track.id), ["song1"]);
  assert.deepEqual(Array.from(Store.topListeningArtists(10), artist => artist.name), ["A Singer"]);
  assert.deepEqual(Array.from(Store.topListeningPodcasts(10), show => show.name), ["Known Show"]);
});

test("a verified built-in row can teach the store its channel", () => {
  const { Store } = createStore();

  Store.notePodcastChannel("Built-in Show", "Publisher Channel", "UC9", true);

  assert.equal(Store.isPodcastChannel("Publisher Channel"), true);
  assert.equal(Store.podcastShowsList()[0].name, "Built-in Show");
});

test("learning a channel repairs matching old history on disk", () => {
  const old = { id: "ep1", title: "The Show | A subject", artist: "Publisher" };
  const profile = { tracks: { ep1: { plays: 1, lastPlayed: 10, track: old } }, artists: { Publisher: { plays: 1 } } };
  const { Store, read } = createStore({
    "aura.recents": [old],
    "aura.listeningProfile": profile,
    "aura.podcastShows": { at: 1, lang: "en", shows: [{ name: "The Show", channel: "Publisher" }] }
  });

  Store.notePodcastChannel("The Show", "Publisher", "");

  assert.equal(read("aura.recents")[0].kind, "podcast");
  assert.equal(read("aura.listeningProfile").tracks.ep1.track.kind, "podcast");
});

test("a shared publisher does not turn songs or other shows into this podcast", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Science Hour", channel: "Publisher", channelId: "UC1" }], "en");
  const song = { id: "song", title: "A melody", artist: "Publisher", artistId: "UC1" };
  const episode = { id: "episode", title: "Science Hour | Space", artist: "Publisher", artistId: "UC1" };
  Store.addTrack(song); Store.addTrack(episode);
  Store.pushRecent(song); Store.pushRecent(episode);
  assert.deepEqual(Array.from(Store.artists(), a => a.name), ["Publisher"]);
  assert.deepEqual(Array.from(Store.artists()[0].tracks, t => t.id), ["song"]);
  assert.deepEqual(Array.from(Store.albums()[0].tracks, t => t.id), ["song"]);
  assert.deepEqual(Array.from(Store.library("podcast"), t => t.id), ["episode"]);
  assert.equal(Store.topListeningArtists()[0].plays, 1);
  assert.equal(Store.matchingPodcastShow({ ...episode, title: "Another Show | Space" }), null);
});

test("a verified episode repairs an existing song copy without losing user data", () => {
  const { Store } = createStore();
  const old = { id: "episode", title: "A subject", artist: "Publisher", kind: "music" };
  Store.addTrack(old); Store.toggleLike(old.id); Store.pushRecent(old);
  Store.rememberDownload(old); Store.savePosition(old.id, 120);
  const pl = Store.createPlaylist("Saved"); Store.addToPlaylist(pl.id, old.id);
  Store.addTrack({ ...old, kind: "podcast", podcast: "Science Hour" });
  assert.equal(Store.library().length, 1);
  assert.equal(Store.likedTracks("music").length, 0);
  assert.equal(Store.likedTracks("podcast")[0].id, old.id);
  assert.equal(Store.downloadedTracks("podcast")[0].podcast, "Science Hour");
  assert.equal(Store.recents()[0].kind, "podcast");
  assert.equal(Store.topListeningArtists().length, 0);
  assert.equal(Store.topListeningPodcasts()[0].plays, 1);
  assert.equal(Store.playlistTracks(pl.id)[0].id, old.id);
  assert.equal(Store.getPosition(old.id), 120);
  assert.equal(Store.mediaKind({ id: old.id, title: old.title }), "podcast");
  const restored = createStore().Store;
  restored.importData(Store.exportData());
  assert.equal(restored.likedTracks("podcast")[0].podcast, "Science Hour");
  assert.equal(restored.getPosition(old.id), 120);
});

test("show identities survive backup and legacy backups remain accepted", () => {
  const { Store } = createStore();
  Store.savePodcastShows([{ name: "Science Hour", channel: "Publisher" }], "en");
  const backup = Store.exportData();
  const restored = createStore().Store;
  restored.importData(backup);
  assert.equal(restored.mediaKind({ id: "ep", title: "Science Hour | Space", artist: "Publisher" }), "podcast");
  delete backup.data.podcastShows;
  assert.doesNotThrow(() => restored.importData(backup));
});
