const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createStore } = require("./store-harness");
const { readModule } = require("./source");
const source = readModule("voice");

// A trimmed copy of the voice-requests harness: only what the "latest" path touches.
function harness(options = {}) {
  const { Store } = createStore(options.seed);
  const Ai = options.Ai || { hasAnyKey: () => false };
  const Api = options.Api || {};
  const window = { SpeechRecognition: class {}, Ai, Log: options.Log };
  vm.runInNewContext(source, {
    window, Store, Ai, Api, Player: { queue: () => [] },
    navigator: { onLine: options.online !== false },
    setTimeout: () => 0, clearTimeout: () => {}
  });
  return { Voice: window.Voice, Store };
}

test("the newest-song phrasings parse as a latest-release request for the named artist", () => {
  const { Voice } = harness();
  const latest = [
    ["שים לי את השיר החדש של אריק איינשטיין", "אריק איינשטיין"],
    ["תשמיע את השיר הכי חדש של אריק איינשטיין", "אריק איינשטיין"],
    ["נגן את החדש של עידן רייכל", "עידן רייכל"],
    ["השיר האחרון של שלמה ארצי", "שלמה ארצי"],
    ["תשים את הסינגל החדש של נועה קירל", "נועה קירל"],
    // The article-less adjective is the everyday spoken form and must read as newest too.
    ["שים לי שיר חדש של אריק איינשטיין", "אריק איינשטיין"],
    ["תשמיע שיר אחרון של שלמה ארצי", "שלמה ארצי"],
    ["play the newest song by Drake", "Drake"],
    ["play the new song by Drake", "Drake"],
    ["play the latest single from Adele", "Adele"],
    ["play Taylor Swift's new song", "Taylor Swift"]
  ];
  for (const [request, artist] of latest) {
    const intent = Voice.basicIntent(request);
    assert.equal(intent.kind, "latest", request);
    assert.equal(intent.query, artist, request);
  }
});

test("an ordinary artist or titled-song request is not mistaken for a latest-release one", () => {
  const { Voice } = harness();
  assert.equal(Voice.basicIntent("תשים לי שיר של Queen").kind, "artist");
  assert.equal(Voice.basicIntent("play songs by Queen").kind, "artist");
  const song = Voice.basicIntent("play Bohemian Rhapsody by Queen");
  assert.equal(song.kind, "song");
  assert.equal(song.query, "Bohemian Rhapsody");
  // A real title of the shape "<new/last> <song> by <artist>" with no leading "the" is a
  // titled-song request, not the artist's newest release - the pre-feature reading, kept.
  for (const [request, title, artist] of [
    ["play New Song by Howard Jones", "New Song", "Howard Jones"],
    ["play Last Song by Gary Allan", "Last Song", "Gary Allan"],
    // English "last" is title-prone ("The Last Song" is a real title), so the by-form leaves
    // it to the song parser; the Hebrew "האחרון" stays a latest cue (its everyday sense).
    ["play the last song by Elton John", "the last song", "Elton John"]
  ]) {
    const parsed = Voice.basicIntent(request);
    assert.equal(parsed.kind, "song", request);
    assert.equal(parsed.query, title, request);
    assert.equal(parsed.artist, artist, request);
  }
});

test("a latest request plays the artist's newest upload first and skips non-music", async () => {
  let searched;
  const { Voice } = harness({ Api: {
    searchArtists: async query => { searched = query; return { items: [
      { id: "arik", name: "אריק איינשטיין", verified: true, subscribers: 5000 }
    ] }; },
    channelFeed: async id => { assert.equal(id, "arik"); return [
      { id: "interview", title: "ראיון עם אריק", artist: "אריק איינשטיין", artistId: "arik", published: 400 },
      { id: "new-song", title: "השיר החדש", artist: "אריק איינשטיין", artistId: "arik", published: 300 },
      { id: "old-song", title: "שיר ישן", artist: "אריק איינשטיין", artistId: "arik", published: 100 }
    ]; },
    // The feed has no durations, so looksLikeMusic cannot judge; the channel is verified,
    // so an upload counts as a song unless its title marks it otherwise.
    looksLikeMusic: () => false,
    notMusic: track => /ראיון/.test(track.title),
    getArtist: assert.fail
  } });
  const out = await Voice.resolve("שים לי את השיר החדש של אריק איינשטיין");
  assert.equal(searched, "אריק איינשטיין");
  assert.deepEqual(out.tracks.map(t => t.id), ["new-song", "old-song"]);
  assert.equal(out.label, "השיר החדש");
});

test("a newer teaser short or spoken-word clip never stands in for the newest song", async () => {
  const { Voice } = harness({ Api: {
    searchArtists: async () => ({ items: [{ id: "x", name: "נועה קירל", verified: true }] }),
    channelFeed: async () => [
      { id: "teaser", title: "טעימה מהסינגל החדש #shorts", artistId: "x", published: 500 },
      { id: "talk", title: "שיחה עם נועה קירל", artistId: "x", published: 450 },
      { id: "single", title: "הסינגל החדש", artistId: "x", published: 400 }
    ],
    // No durations in the feed, so looksLikeMusic cannot judge; the guards below must.
    looksLikeMusic: () => false,
    notMusic: () => false,
    looksLikePodcast: track => /שיחה עם/.test(track.title),
    getArtist: assert.fail
  } });
  const out = await Voice.resolve("שים לי את השיר החדש של נועה קירל");
  assert.deepEqual(out.tracks.map(t => t.id), ["single"]);
  assert.equal(out.label, "הסינגל החדש");
});

test("sending the newest song next or to the queue inserts only the one song", async () => {
  const feed = [
    { id: "n1", title: "Brand New", artistId: "c", published: 900 },
    { id: "n2", title: "Older One", artistId: "c", published: 800 },
    { id: "n3", title: "Older Still", artistId: "c", published: 700 }
  ];
  const api = {
    searchArtists: async () => ({ items: [{ id: "c", name: "Adele", verified: true }] }),
    channelFeed: async () => feed,
    looksLikeMusic: () => true, notMusic: () => false, looksLikePodcast: () => false, getArtist: assert.fail
  };
  const played = await harness({ Api: api }).Voice.resolve("play the latest single from Adele");
  assert.equal(played.action, "play");
  assert.deepEqual(played.tracks.map(t => t.id), ["n1", "n2", "n3"]);
  for (const request of ["play the latest single from Adele next", "add Adele's newest song to the queue"]) {
    const out = await harness({ Api: api }).Voice.resolve(request);
    assert.notEqual(out.action, "play", request);
    assert.deepEqual(out.tracks.map(t => t.id), ["n1"], request);
    assert.equal(out.label, "Brand New", request);
  }
});

test("a followed artist resolves from the stored channel without an artist search", async () => {
  const { Voice, Store } = harness({ Api: {
    searchArtists: assert.fail,
    channelFeed: async id => { assert.equal(id, "chan"); return [
      { id: "b", title: "Older", artistId: "chan", published: 100 },
      { id: "a", title: "Newest", artistId: "chan", published: 900 }
    ]; },
    looksLikeMusic: () => true, notMusic: () => false, getArtist: assert.fail
  } });
  Store.follow({ id: "chan", name: "Queen", kind: "artist" });
  const out = await Voice.resolve("play the newest song by Queen");
  assert.deepEqual(out.tracks.map(t => t.id), ["a", "b"]);
  assert.equal(out.label, "Newest");
});

test("when the channel feed comes back empty the artist catalog fills in, newest first", async () => {
  const { Voice } = harness({ Api: {
    searchArtists: async () => ({ items: [{ id: "c", name: "Queen", verified: true }] }),
    channelFeed: async () => [],
    getArtist: async id => { assert.equal(id, "c"); return { videos: [
      { id: "v-old", title: "Old", artist: "Queen", artistId: "c", duration: 200, published: 100 },
      { id: "v-new", title: "New", artist: "Queen", artistId: "c", duration: 200, published: 300 }
    ] }; },
    looksLikeMusic: () => true, notMusic: () => false
  } });
  const out = await Voice.resolve("play the latest song by Queen");
  assert.deepEqual(out.tracks.map(t => t.id), ["v-new", "v-old"]);
  assert.equal(out.label, "New");
});

test("an unverified relevance match keeps the strict music test rather than trusting the feed", async () => {
  const { Voice } = harness({ Api: {
    searchArtists: async () => ({ items: [{ id: "u", name: "Queen", verified: false, subscribers: 10 }] }),
    channelFeed: async () => [
      { id: "titled", title: "Queen - Official Video", artistId: "u", published: 200 },
      { id: "bare", title: "some clip", artistId: "u", published: 300 }
    ],
    // Only the upload whose title itself reads as music passes when the channel is not verified.
    looksLikeMusic: track => /official video/i.test(track.title),
    notMusic: () => false, getArtist: async () => ({ videos: [] })
  } });
  const out = await Voice.resolve("play the newest song by Queen");
  assert.deepEqual(out.tracks.map(t => t.id), ["titled"]);
});

test("an AI-provided latest intent resolves through the same channel-feed path", async () => {
  const { Voice } = harness({ Api: {
    searchArtists: async () => ({ items: [{ id: "c", name: "Queen", verified: true }] }),
    channelFeed: async () => [{ id: "s", title: "Newest", artistId: "c", published: 1 }],
    looksLikeMusic: () => true, notMusic: () => false, getArtist: assert.fail
  } });
  const intent = { kind: "latest", query: "Queen", artist: "", tracks: [] };
  const out = await Voice.resolve("whatever the words were", null, null, intent);
  assert.deepEqual(out.tracks.map(t => t.id), ["s"]);
});

test("no channel for the named artist reports that no new song was found", async () => {
  const { Voice } = harness({ Api: {
    searchArtists: async () => ({ items: [] }),
    channelFeed: assert.fail, getArtist: assert.fail
  } });
  await assert.rejects(Voice.resolve("play the newest song by Nobody At All"), /לא מצאתי שיר חדש/);
});
