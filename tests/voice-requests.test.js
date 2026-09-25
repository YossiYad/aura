const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createStore } = require("./store-harness");
const { readModule } = require("./source");
const source = readModule("voice");

function harness(options = {}) {
  const { Store } = createStore(options.seed);
  const recognitions = [], timers = new Map();
  let timerId = 0, now = 0;
  // Modelled on WebKit's recognizer: start() is accepted only while the object is
  // inactive, and after stop() or abort() it stays busy until its native end arrives
  // (end()). Native events reach whatever handler the object holds when they arrive
  // (emit()), exactly as WebKit routes them to the object by its client identifier.
  class Recognition {
    constructor() { recognitions.push(this); this.state = "inactive"; }
    start() {
      if (this.state !== "inactive") throw Object.assign(new Error("Recognition is being started or already started"), { name: "InvalidStateError" });
      this.state = "running";
      options.onstart?.(); this.onstart?.();
    }
    stop() { this.stopped = true; if (this.state === "running") this.state = "stopping"; }
    abort() { this.aborted = true; if (this.state !== "inactive") this.state = "aborting"; }
    end() { this.state = "inactive"; this.onend?.(); }
    emit(type, event = {}) { this["on" + type]?.(event); }
    result(parts) {
      this.onresult({ results: parts.map(([text, final]) => Object.assign([{ transcript: text }], { isFinal: final })) });
    }
  }
  const Ai = options.Ai || { hasAnyKey: () => false };
  const Api = options.Api || {};
  const window = { SpeechRecognition: Recognition, Ai, Log: options.Log,
    MediaRecorder: options.MediaRecorder, OfflineAudioContext: options.OfflineAudioContext };
  if (options.synth) {
    window.speechSynthesis = options.synth;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  }
  vm.runInNewContext(source, {
    window, Store, Ai, Api, Player: { queue: () => [] }, navigator: { onLine: options.online !== false, audioSession: options.audioSession,
      userAgent: options.userAgent, platform: options.platform, maxTouchPoints: options.maxTouchPoints, mediaDevices: options.mediaDevices,
      userActivation: options.userActivation },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms, every: ms }); return id; },
    clearInterval: id => timers.delete(id),
    Blob
  });
  // An interval is due again one period later; set before it runs, so it can clear itself.
  const fire = (id, timer) => {
    timers.delete(id);
    if (timer.every) timers.set(id, { ...timer, at: timer.at + timer.every });
    timer.fn();
  };
  const clock = {
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms, every: ms }); return id; },
    clearInterval: id => timers.delete(id)
  };
  return {
    Voice: window.Voice, Store, recognitions, clock,
    tick(ms) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) fire(id, timer);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; fire(next[0], next[1]);
      }
      now = target;
    }
  };
}
const song = { id: "remote-song", title: "Bohemian Rhapsody", artist: "Queen", duration: 354 };

test("basic Hebrew and English requests retain song and artist names", () => {
  const { Voice } = harness();
  for (const request of ["תשים לי את השיר Bohemian Rhapsody של Queen", "תשים את השיר Bohemian Rhapsody של Queen", "Please play the song Bohemian Rhapsody by Queen"]) {
    const intent = Voice.basicIntent(request);
    assert.equal(intent.kind, "song"); assert.equal(intent.query, song.title); assert.equal(intent.artist, "Queen");
  }
  assert.equal(Voice.basicIntent("תפעיל לי את הפלייליסט אימון").query, "אימון");
  assert.equal(Voice.basicIntent("תשים את הפלייליסט אימון").query, "אימון");
  assert.equal(Voice.basicIntent("תשים לי שירים של עידן רייכל").kind, "artist");
  assert.equal(Voice.basicIntent("play songs by Queen").kind, "artist");
});

test("a requested song absent from all local playlists is matched online", async () => {
  let query;
  const { Voice } = harness({ Api: { matchTrack: async (...args) => { query = args; return song; } } });
  const out = await Voice.resolve("תשים לי את השיר Bohemian Rhapsody של Queen");
  assert.deepEqual(query.slice(0, 2), [song.title, "Queen"]); assert.equal(query[2].original, true);
  assert.equal(out.tracks[0].id, song.id);
});

test("next-song requests preserve the song and artist while selecting queue placement", async () => {
  const queries = [];
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail },
    Api: { matchTrack: async (title, artist) => { queries.push([title, artist]); return song; } } });
  for (const request of [
    'שים את Bohemian Rhapsody של Queen בתור השיר הבא',
    'תוסיף לי את Bohemian Rhapsody של Queen כשיר הבא',
    'תנגן את Bohemian Rhapsody של Queen שיהיה השיר הבא',
    'תשים לי את Bohemian Rhapsody של Queen אחרי השיר הנוכחי',
    'תנגן בתור השיר הבא את Bohemian Rhapsody של Queen',
    'השיר הבא יהיה Bohemian Rhapsody של Queen',
    'play Bohemian Rhapsody by Queen next',
    'queue Bohemian Rhapsody by Queen up next',
    'play next song Bohemian Rhapsody by Queen',
    'play Bohemian Rhapsody by Queen as the next song'
  ]) {
    const intent = Voice.basicIntent(request);
    assert.equal(intent.action, 'next', request);
    assert.equal(intent.query, song.title, request);
    assert.equal(intent.artist, song.artist, request);
    const result = await Voice.resolve(request);
    assert.equal(result.action, 'next', request);
    assert.equal(result.tracks[0].id, song.id);
  }
  assert.equal(queries.length, 10);
  for (const query of queries) assert.deepEqual(query, [song.title, song.artist]);
});

test("ordinary titles containing next retain immediate playback", () => {
  const { Voice } = harness();
  for (const title of ['Next to Me', 'The Next Episode', 'ביום הבא']) {
    const intent = Voice.basicIntent('play ' + title);
    assert.equal(intent.action, 'play');
    assert.equal(intent.query, title);
  }
});

test("AI correction of a song name preserves the next-song action", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true,
    interpretPlayback: async () => ({ kind: 'song', query: song.title, artist: song.artist }) },
    Api: { matchTrack: async title => title === song.title ? song : null } });
  const result = await Voice.resolve('תנגן את בוהמיין רפסודי של קווין בתור השיר הבא');
  assert.equal(result.action, 'next');
  assert.equal(result.tracks[0].id, song.id);
});

test("a next-song request without a title asks for one", async () => {
  const { Voice } = harness({ Api: { matchTrack: assert.fail } });
  await assert.rejects(Voice.resolve('play next'), /איזה שיר/);
});

test("queue-add requests select the end of the queue and keep song names clean", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail },
    Api: { matchTrack: async (title, artist) => {
      assert.equal(title, song.title); assert.equal(artist, song.artist); return song;
    } } });
  for (const request of [
    'תוסיף את Bohemian Rhapsody של Queen לסוף התור',
    'תוסיף לי את Bohemian Rhapsody של Queen לתור',
    'שים את Bohemian Rhapsody של Queen בסוף התור',
    'תוסיף לסוף התור את Bohemian Rhapsody של Queen',
    'תוסיף לי את Bohemian Rhapsody של Queen',
    'add Bohemian Rhapsody by Queen to the queue',
    'add Bohemian Rhapsody by Queen to the end of my queue',
    'queue Bohemian Rhapsody by Queen',
    'append Bohemian Rhapsody by Queen'
  ]) {
    assert.equal(Voice.basicIntent(request).action, 'append', request);
    const result = await Voice.resolve(request);
    assert.equal(result.action, 'append', request);
    assert.equal(result.tracks[0].id, song.id);
  }
});

test("adding a saved playlist to the end keeps every song in order", async () => {
  const { Voice, Store } = harness();
  Store.addTrack(song);
  const another = { ...song, id: 'another', title: 'Another' };
  Store.addTrack(another);
  const playlist = Store.createPlaylist('נסיעה');
  Store.addToPlaylist(playlist.id, song.id);
  Store.addToPlaylist(playlist.id, another.id);
  const result = await Voice.resolve('תוסיף את הפלייליסט נסיעה לסוף התור');
  assert.equal(result.action, 'append');
  assert.deepEqual(Array.from(result.tracks, track => track.id), [song.id, another.id]);
});

test("AI correction preserves append placement", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true,
    interpretPlayback: async () => ({ kind: 'song', query: song.title, artist: song.artist }) },
    Api: { matchTrack: async title => title === song.title ? song : null } });
  const result = await Voice.resolve('תוסיף את בוהמיין רפסודי של קווין לסוף התור');
  assert.equal(result.action, 'append');
  assert.equal(result.tracks[0].id, song.id);
});

test("a saved cover does not override original-recording lookup when no singer was requested", async () => {
  let lookup = false;
  const { Voice, Store } = harness({ Api: { matchTrack: async () => { lookup = true; return song; } } });
  Store.addTrack({ ...song, id: 'local-cover', artist: 'Cover Singer' });
  assert.equal((await Voice.resolve('play Bohemian Rhapsody')).tracks[0].id, song.id);
  assert.equal(lookup, true);
  assert.equal((await Voice.resolve('play Bohemian Rhapsody by Cover Singer')).tracks[0].id, 'local-cover');
});

test("a saved live recording does not stand in for the requested song", async () => {
  let lookups = 0, found = song;
  const { Voice, Store } = harness({ Api: { matchTrack: async () => { lookups++; return found; } } });
  Store.addTrack({ ...song, id: 'local-live', title: 'Bohemian Rhapsody (Live Aid 1985)' });
  assert.equal((await Voice.resolve('play Bohemian Rhapsody by Queen')).tracks[0].id, song.id);
  assert.equal(lookups, 1);
  // Asked for by name, the live recording is the one wanted; with no result, it is the one there is.
  assert.equal((await Voice.resolve('play Bohemian Rhapsody live by Queen')).tracks[0].id, 'local-live');
  found = null;
  assert.equal((await Voice.resolve('play Bohemian Rhapsody by Queen')).tracks[0].id, 'local-live');
});

test("a saved playlist plays its tracks in order without any network lookup", async () => {
  const { Voice, Store } = harness();
  const playlist = Store.createPlaylist("נסיעה לעבודה");
  for (const id of ["a", "b"]) { Store.addTrack({ ...song, id }); Store.addToPlaylist(playlist.id, id); }
  assert.deepEqual(Array.from((await Voice.resolve("תפעיל את הפלייליסט נסיעה לעבודה")).tracks, t => t.id), ["a", "b"]);
});

test("duplicate playlist names require clarification instead of choosing arbitrarily", async () => {
  const { Voice, Store } = harness();
  Store.createPlaylist("Workout"); Store.createPlaylist("Workout");
  await assert.rejects(Voice.resolve("play playlist Workout"), /כמה פלייליסטים/);
});

test("a public playlist is fetched when it is absent locally", async () => {
  let fetched;
  const { Voice } = harness({ Api: {
    searchPlaylists: async () => ({ items: [{ id: "public", name: "Road Trip" }] }),
    getPlaylistInfo: async id => { fetched = id; return { name: "Road Trip", tracks: [song] }; }
  } });
  const out = await Voice.resolve("play playlist Road Trip");
  assert.equal(fetched, "public"); assert.equal(out.tracks[0].id, song.id);
});

test("artist playback excludes unrelated channels, speech and blocked tracks", async () => {
  const { Voice, Store } = harness({ Api: {
    search: async () => ({ items: [song, { ...song, id: "topic", artist: "Queen - Topic", artistVerified: true },
      { ...song, id: "other", artist: "Another artist" }, { ...song, id: "interview" }] }),
    looksLikeMusic: t => t.id !== "interview"
  } });
  Store.blockTrack(song);
  assert.deepEqual(Array.from((await Voice.resolve("play songs by Queen")).tracks, t => t.id), ["topic"]);
});

test("artist requests deal the same songs out in a different order each time", async () => {
  const items = ["a", "b", "c", "d", "e", "f"].map(id => ({ ...song, id, artist: "Queen - Topic", artistVerified: true }));
  const { Voice } = harness({ Api: { search: async () => ({ items }), looksLikeMusic: () => true, searchArtists: assert.fail } });
  const firsts = new Set(), orders = new Set();
  for (let i = 0; i < 40; i++) {
    const ids = Array.from((await Voice.resolve("play songs by Queen")).tracks, t => t.id);
    assert.deepEqual(ids.slice().sort(), ["a", "b", "c", "d", "e", "f"]);
    firsts.add(ids[0]); orders.add(ids.join(","));
  }
  assert.ok(firsts.size > 1, "the same song opened every request");
  assert.ok(orders.size > 1, "the queue came out in the same order every request");
});

test("Hebrew artist requests match bilingual channel names without AI or channel lookup", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail }, Api: {
    search: async () => ({ items: [
      { ...song, id: "official", artist: "אייל גולן Eyal Golan Official", artistVerified: true },
      { ...song, id: "fans", artist: "אייל גולן Fans" },
      { ...song, id: "tribute", artist: "אייל גולן מחווה" },
      { ...song, id: "other", artist: "אייל גולן ולהקת החברים" }
    ] }), looksLikeMusic: () => true, searchArtists: assert.fail
  } });
  for (const name of ["אייל גולן", "Eyal Golan"]) {
    assert.deepEqual(Array.from((await Voice.resolve("תשים לי שיר של " + name)).tracks, t => t.id), ["official"]);
  }
});

test("duplicate artist channels prefer the official performer without clarification or AI", async () => {
  const fetched = [];
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail }, Api: {
    search: async () => ({ items: [] }),
    searchArtists: async () => ({ items: [
      { id: "fan", name: "אייל גולן Fans", subscribers: 1000000 },
      { id: "plain", name: "אייל גולן", subscribers: 100 },
      { id: "topic", name: "אייל גולן - Topic", subscribers: 50000 },
      { id: "official", name: "אייל גולן Eyal Golan Official", subscribers: 20000, verified: true }
    ] }),
    getArtist: async id => { fetched.push(id); return { videos: [{ ...song, artist: "אייל גולן", artistId: id }] }; },
    looksLikeMusic: () => true
  } });
  assert.equal((await Voice.resolve("תשים לי שיר של אייל גולן")).tracks[0].id, song.id);
  assert.deepEqual(fetched, ["official"]);
});

test("identical artist names choose the larger channel instead of reporting multiple artists", async () => {
  const { Voice } = harness({ Api: {
    search: async () => ({ items: [] }),
    searchArtists: async () => ({ items: [
      { id: "small", name: "אייל גולן", subscribers: 2 },
      { id: "large", name: "אייל גולן", subscribers: 50000 }
    ] }),
    getArtist: async id => { assert.equal(id, "large"); return { videos: [{ ...song, title: "אייל גולן - ואיך בשמיים", artist: "אייל גולן", artistId: "large" }] }; }, looksLikeMusic: () => true
  } });
  assert.equal((await Voice.resolve("תשים שיר של אייל גולן")).tracks[0].id, song.id);
});

test("empty or blocked artist channels fall back once per channel ID", async () => {
  const fetched = [];
  const { Voice, Store } = harness({ Api: {
    search: async () => ({ items: [song] }),
    searchArtists: async () => ({ items: [
      { id: "empty", name: "Queen Official" }, { id: "empty", name: "Queen Official" },
      { id: "blocked", name: "Queen - Topic" }, { id: "working", name: "Queen" }
    ] }),
    getArtist: async id => { fetched.push(id); return { videos: id === "empty" ? [] : [{ ...song, title: "Queen - Bohemian Rhapsody", id: id === "blocked" ? song.id : "available" }] }; },
    looksLikeMusic: () => true
  } });
  Store.blockTrack(song);
  assert.equal((await Voice.resolve("play songs by Queen")).tracks[0].id, "available");
  assert.deepEqual(fetched, ["empty", "blocked", "working"]);
});

test("artist matching rejects different performers sharing only a partial name", async () => {
  const { Voice } = harness({ Api: {
    search: async () => ({ items: [{ ...song, artist: "Queen Latifah" }] }),
    searchArtists: async () => ({ items: [{ id: "wrong", name: "Queen Latifah" }] }),
    getArtist: assert.fail, looksLikeMusic: () => true
  } });
  await assert.rejects(Voice.resolve("play songs by Queen"), /לא נמצאו/);
});

test("the exact Hebrew artist request rejects unrelated uploads returned by an artist channel", async () => {
  const wrong = { ...song, id: "nqC9OCicziY", title: "Дота 2 #1", artist: "הערוץ הרשמי אייל גולן", artistId: "eyal" };
  const right = { ...song, id: "eyal-song", title: "אייל גולן - ואיך בשמיים", artist: "אייל גולן", artistId: "eyal" };
  let includeRight = false;
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail }, Api: {
    search: async () => ({ items: [] }),
    searchArtists: async () => ({ items: [{ id: "eyal", name: "אייל גולן Official" }] }),
    getArtist: async () => ({ videos: includeRight ? [wrong, right,
      { ...right, id: "wrong-channel", artistId: "someone-else" },
      { ...wrong, id: "wrong-name", artistId: "eyal" }] : [wrong] }),
    looksLikeMusic: () => true
  } });
  // Reinterpretation returning the same intent must not make the bad channel valid.
  const intent = Voice.basicIntent("תשים לי שיר של אייל גולן");
  assert.equal(intent.kind, "artist"); assert.equal(intent.query, "אייל גולן");
  await assert.rejects(Voice.resolve("תשים לי שיר של אייל גולן", null, null, intent), /לא נמצאו/);
  includeRight = true;
  assert.deepEqual(Array.from((await Voice.resolve("תשים לי שיר של אייל גולן")).tracks, t => t.id), [right.id]);
});

test("a partial local performer name cannot bypass song matching", async () => {
  const { Voice, Store } = harness({ Api: { matchTrack: async () => null } });
  Store.addTrack({ ...song, artist: "Queen Latifah" });
  await assert.rejects(Voice.resolve("play Bohemian Rhapsody by Queen"), /לא נמצאו/);
});

test("mix lookups require the requested performer and recording checks", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true,
    generatePlaylist: async () => ({ name: "Calm", tracks: [song] }) }, Api: {
    matchTrack: async (title, artist, options) => {
      assert.equal(title, song.title); assert.equal(artist, song.artist);
      assert.equal(options.original, true); return null;
    }
  } });
  await assert.rejects(Voice.resolve("תשים משהו רגוע"), /לא נמצאו/);
});

test("microphone capture replaces playback audio mode before start and restores it on every exit", () => {
  for (const ending of ["cancel", "finish", "error", "timeout"]) {
    const audioSession = { type: "playback" };
    const { Voice, recognitions, advance } = harness({ audioSession,
      onstart: () => assert.equal(audioSession.type, "play-and-record") });
    const capture = Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
    assert.equal(Voice.isListening(), true);
    if (ending === "cancel") capture.cancel();
    if (ending === "finish") { capture.finish(); recognitions[0].onend(); }
    if (ending === "error") recognitions[0].onerror({ error: "not-allowed" });
    if (ending === "timeout") advance(20000);
    assert.equal(audioSession.type, "playback", ending);
    assert.equal(Voice.isListening(), false, ending);
    audioSession.type = "auto"; capture.cancel();
    assert.equal(audioSession.type, "auto", "cleanup is idempotent");
  }
});

test("a recognition start alone does not claim the microphone is receiving audio", () => {
  const { Voice, recognitions, advance } = harness(); const hearing = [], errors = [];
  Voice.listen({ ontext() {}, onfinish: assert.fail, onlistening: value => hearing.push(value),
    onerror: code => errors.push(code) });
  assert.deepEqual(hearing, []);
  recognitions[0].onaudiostart();
  assert.deepEqual(hearing, [true]);
  advance(12000);
  assert.deepEqual(errors, ["recognition-timeout"]);
  assert.equal(recognitions[0].aborted, true);
  advance(30000); assert.equal(errors.length, 1);
});

test("iPhone repeat captures keep a live microphone until completion and release it before playback", async () => {
  const audioSession = { type: 'playback' }, tracks = [], heard = [], finished = [];
  const { Voice, recognitions, advance } = harness({ userAgent: 'iPhone', audioSession,
    mediaDevices: { getUserMedia: async constraints => {
      assert.equal(constraints.audio, true);
      const track = { stopped: false, stop() {
        assert.equal(audioSession.type, 'play-and-record');
        this.stopped = true;
      } };
      tracks.push(track);
      return { getTracks: () => [track] };
    } },
    onstart: () => assert.equal(tracks.at(-1).stopped, false)
  });
  for (const text of ['play First', 'play Second', 'play Third']) {
    const count = recognitions.length;
    Voice.listen({ ontext: value => heard.push(value), onfinish: value => finished.push(value), onerror: assert.fail });
    assert.equal(recognitions.length, count, 'wait for the actual microphone before starting recognition');
    await Promise.resolve();
    const recognition = recognitions.at(-1);
    recognition.onaudiostart();
    recognition.result([[text, true]]);
    advance(2000);
    assert.equal(recognition.stopped, true, 'silence sends the request without a button');
    assert.equal(tracks.at(-1).stopped, false, 'keep audio active until the last result');
    recognition.end();
    assert.equal(tracks.at(-1).stopped, true);
    assert.equal(audioSession.type, 'playback');
    assert.equal(Voice.isListening(), false);
  }
  assert.deepEqual(heard, ['play First', 'play Second', 'play Third']);
  assert.deepEqual(finished, heard);
});

test("iPad microphone stays open over recognition reconnects and closes on every exit", async () => {
  for (const ending of ['cancel', 'error', 'timeout', 'finish-fallback']) {
    let stopped = false;
    const { Voice, recognitions, advance } = harness({ platform: 'MacIntel', maxTouchPoints: 5,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }) }
    });
    const capture = Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
    await Promise.resolve();
    recognitions[0].onend(); advance(300);
    assert.equal(stopped, false);
    assert.equal(recognitions.length, 2, 'the reconnect starts a recognizer of its own on the same microphone');
    if (ending === 'cancel') capture.cancel();
    if (ending === 'error') recognitions[1].onerror({ error: 'network' });
    if (ending === 'timeout') advance(20000);
    if (ending === 'finish-fallback') { capture.finish(); advance(1500); }
    assert.equal(stopped, true, ending);
    assert.equal(Voice.isListening(), false);
  }
});

// A voice harness that records the log and hands out live microphone tracks, checking
// that every earlier request's microphone was released before a new one is asked for.
function voiceHarness(platform, extra = {}) {
  const tracks = [], logs = [], constraints = [], audioSession = { type: "playback" };
  const h = harness({ ...platform, audioSession, Log: { add: (tag, message) => logs.push(tag + " " + message) },
    mediaDevices: { getUserMedia: async asked => {
      constraints.push(asked);
      assert.ok(tracks.every(track => track.readyState === "ended"), "the earlier microphone was released first");
      const track = { readyState: "live", stop() { this.readyState = "ended"; } };
      tracks.push(track);
      return { getTracks: () => [track] };
    } }, ...extra });
  return { ...h, tracks, logs, constraints, audioSession };
}
const finalResult = words => ({ results: [Object.assign([{ transcript: words }], { isFinal: true })] });

test("every request and every reconnect gets a recognizer of its own, on iPhone as on other browsers", async () => {
  for (const platform of [{ userAgent: "iPhone" }, { platform: "MacIntel", maxTouchPoints: 5 }, { userAgent: "Android" }]) {
    const { Voice, recognitions, advance } = voiceHarness(platform);
    const first = Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
    await Promise.resolve();
    assert.equal(recognitions.length, 1);
    recognitions[0].end(); advance(300);
    assert.equal(recognitions.length, 2, "a reconnect starts a new recognizer");
    first.cancel();
    assert.equal(recognitions[1].aborted, true);
    assert.equal(recognitions[1].onresult, null, "the cancelled run's recognizer keeps no handlers");
    Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
    await Promise.resolve();
    assert.equal(recognitions.length, 3, "the next request starts a new recognizer");
    assert.equal(recognitions[2].state, "running");
  }
});

test("on iPhone a request whose recognizer never ends cannot block the requests after it", async () => {
  // Reusing one recognizer, the second start() met an object still aborting the first run,
  // and on a device that never delivers that end, voice input failed until a reload.
  const errors = [], finished = [];
  const { Voice, recognitions, advance, tracks } = voiceHarness({ userAgent: "iPhone" });
  for (const words of ["play First", "play Second", "play Third", "play Fourth"]) {
    Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code) });
    await Promise.resolve();
    const recognition = recognitions.at(-1);
    assert.equal(recognition.state, "running", "the new request's recognizer started");
    recognition.emit("audiostart");
    recognition.result([[words, true]]);
    advance(2000);
    assert.equal(recognition.state, "stopping");
    // No end ever arrives: the capture completes on its fallback and aborts the run.
    advance(1500);
    assert.equal(recognition.state, "aborting");
    assert.equal(tracks.at(-1).readyState, "ended");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(finished, ["play First", "play Second", "play Third", "play Fourth"]);
});

test("late events from an earlier request's recognizer never reach the next request", async () => {
  for (const platform of [{ userAgent: "iPhone" }, { userAgent: "Android" }]) {
    const heard = [], finished = [], errors = [], listening = [];
    const { Voice, recognitions, advance } = voiceHarness(platform);
    // The first request is submitted by the fallback before its run has ended.
    Voice.listen({ ontext() {}, onfinish() {}, onerror: assert.fail });
    await Promise.resolve();
    const old = recognitions[0];
    old.emit("audiostart");
    old.result([["play First", true]]);
    advance(2000); advance(1500);
    Voice.listen({ ontext: value => heard.push(value), onfinish: value => finished.push(value),
      onerror: code => errors.push(code), onlistening: value => listening.push(value) });
    await Promise.resolve();
    const current = recognitions[1];
    assert.notEqual(current, old);
    current.emit("audiostart");
    // Whatever the first run still sends goes to its own, detached object.
    old.emit("result", finalResult("play First again"));
    old.emit("audioend"); old.emit("error", { error: "aborted" }); old.end();
    assert.deepEqual(heard, [], "no earlier words appear in the new request");
    assert.deepEqual(errors, []);
    assert.deepEqual(listening, [true], "the new request still shows it is listening");
    assert.equal(Voice.isListening(), true);
    current.result([["play Second", true]]);
    advance(2000); current.end();
    assert.deepEqual(heard, ["play Second"]);
    assert.deepEqual(finished, ["play Second"]);
  }
});

test("cancelling a request and asking again at once listens while the cancelled run still aborts", async () => {
  for (const platform of [{ userAgent: "iPhone" }, { userAgent: "Android" }]) {
    const finished = [];
    const { Voice, recognitions, advance } = voiceHarness(platform);
    const first = Voice.listen({ ontext: assert.fail, onfinish: assert.fail, onerror: assert.fail });
    await Promise.resolve();
    recognitions[0].emit("audiostart");
    first.cancel();
    assert.equal(recognitions[0].state, "aborting");
    Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: assert.fail });
    await Promise.resolve();
    assert.equal(recognitions[1].state, "running", "the new request does not wait for the old end");
    recognitions[1].result([["play Again", true]]);
    advance(2000); recognitions[1].end();
    recognitions[0].end();
    assert.deepEqual(finished, ["play Again"]);
    assert.equal(Voice.isListening(), false);
  }
});

test("an iPhone recovery listens on a new recognizer even while the silent one still aborts", async () => {
  const finished = [];
  const { Voice, recognitions, advance } = voiceHarness({ userAgent: "iPhone" });
  Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: assert.fail });
  await Promise.resolve();
  recognitions[0].emit("audiostart");
  advance(5000);
  assert.equal(recognitions[0].state, "aborting", "the silent run was aborted and has not ended");
  advance(1000);
  assert.equal(recognitions.length, 2);
  assert.equal(recognitions[1].state, "running");
  recognitions[1].result([["play Retry", true]]);
  advance(2000); recognitions[1].end();
  assert.deepEqual(finished, ["play Retry"]);
});

test("audio end turns the listening indicator off, and a trailing result cannot relight it", () => {
  const listening = [], heard = [];
  const { Voice, recognitions } = harness();
  Voice.listen({ ontext: value => heard.push(value), onfinish() {}, onerror() {}, onlistening: value => listening.push(value) });
  const recognition = recognitions[0];
  recognition.emit("audiostart");
  recognition.result([["play", false]]);
  recognition.emit("audioend");
  recognition.result([["play First", true]]);
  assert.deepEqual(listening, [true, true, false]);
  assert.deepEqual(heard, ["play", "play First"], "the trailing words still count");
});

test("each request is logged as its own capture, from opening to cleanup, without its words", async () => {
  const { Voice, recognitions, advance, logs } = voiceHarness({ userAgent: "iPhone" });
  for (const words of ["play First", "play Fifth"]) {
    Voice.listen({ ontext() {}, onfinish() {}, onerror: assert.fail });
    await Promise.resolve();
    const recognition = recognitions.at(-1);
    recognition.emit("audiostart");
    recognition.result([[words, true]]);
    advance(2000); recognition.end();
  }
  for (const id of [1, 2]) {
    for (const step of ["opened on the iOS path", "microphone requested", "microphone ready, session play-and-record",
      "run 1 created, start requested", "run 1 started", "run 1 audio started", "run 1 result, 10 characters, final true",
      "run 1 stop requested", "run 1 ended", "finished, 10 characters", "microphone released, tracks ended", "closed, cleanup complete"])
      assert.ok(logs.some(line => line.startsWith("voice capture " + id + ": " + step)), "capture " + id + " logs " + step);
  }
  assert.equal(logs.some(line => /First|Fifth/.test(line)), false, "spoken words stay out of the log");
});

test("late iPhone microphone permission cannot reopen a cancelled request or disturb a retry", async () => {
  const pending = [], audioSession = { type: 'playback' };
  const { Voice, recognitions, advance } = harness({ userAgent: 'iPhone', audioSession,
    mediaDevices: { getUserMedia: () => new Promise(resolve => pending.push(resolve)) }
  });
  Voice.listen({ ontext: assert.fail, onfinish: assert.fail, onerror() {} });
  advance(20000);
  const retry = Voice.listen({ ontext() {}, onfinish() {}, onerror: assert.fail });
  let oldStopped = false, newStopped = false;
  pending[1]({ getTracks: () => [{ stop() { newStopped = true; } }] });
  await Promise.resolve();
  pending[0]({ getTracks: () => [{ stop() { oldStopped = true; } }] });
  await Promise.resolve();
  assert.equal(oldStopped, true);
  assert.equal(newStopped, false);
  assert.equal(recognitions.length, 1);
  assert.equal(Voice.isListening(), true);
  assert.equal(audioSession.type, 'play-and-record');
  retry.cancel();
  assert.equal(newStopped, true);
  assert.equal(audioSession.type, 'playback');
});

test("denied iPhone microphone access closes the request without starting recognition", async () => {
  for (const name of ['NotAllowedError', 'NotReadableError']) {
    const errors = [], audioSession = { type: 'playback' };
    const { Voice, recognitions } = harness({ userAgent: 'iPhone', audioSession,
      mediaDevices: { getUserMedia: async () => { throw { name }; } }
    });
    Voice.listen({ ontext: assert.fail, onfinish: assert.fail, onerror: code => errors.push(code) });
    await Promise.resolve();
    assert.deepEqual(errors, [name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture']);
    assert.equal(recognitions.length, 0);
    assert.equal(Voice.isListening(), false);
    assert.equal(audioSession.type, 'playback');
  }
});

test("iPhone re-listens after a spoken reply on a freshly settled audio session", async () => {
  // A spoken reply leaves WebKit's audio session configured for output; opening the
  // microphone straight after it goes deaf (bug 321436), so the next listen idles the
  // session and settles it before recognition, instead of only recovering after 5s.
  const audioSession = { type: 'playback' }, local = { lang: 'he-IL', localService: true };
  const { Voice, Store, recognitions, advance } = harness({ userAgent: 'iPhone', audioSession,
    synth: { getVoices: () => [local], cancel() {}, speak: u => u.onend() },
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    userActivation: { isActive: true }
  });
  // Spoken replies default off on iPhone (they deafen the next request); this test opts in
  // to exercise the settle that follows a reply the listener asked for, spoken in a tap.
  Store.patchSettings({ voiceReply: true });
  assert.equal(await Voice.reply({ he: 'מצאתי' }, 'he-IL'), true);
  let finished;
  Voice.listen({ ontext() {}, onfinish: value => finished = value, onerror: assert.fail });
  assert.equal(audioSession.type, 'auto', 'the session is idled before the microphone opens');
  assert.equal(recognitions.length, 0, 'recognition waits for the session to settle');
  advance(800);
  await Promise.resolve();
  assert.equal(audioSession.type, 'play-and-record');
  assert.equal(recognitions.length, 1);
  const recognition = recognitions.at(-1);
  recognition.onaudiostart();
  recognition.result([['play Second', true]]);
  advance(2000);
  recognition.onend();
  assert.equal(finished, 'play Second');
  assert.equal(audioSession.type, 'playback', 'the output category is restored on exit');
});

test("iPhone settles the audio session before listening when music was playing", async () => {
  // A song playing until this capture paused it leaves WebKit's session warm; opening the
  // microphone straight after goes deaf (bug 321436), the same as after a spoken reply.
  // voiceStart passes settle whenever it paused playback, so listen() idles and settles
  // the session before recognition even when no reply played.
  const audioSession = { type: 'playback' };
  const { Voice, recognitions, advance } = harness({ userAgent: 'iPhone', audioSession,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
  });
  let finished;
  Voice.listen({ settle: true, ontext() {}, onfinish: value => finished = value, onerror: assert.fail });
  assert.equal(audioSession.type, 'auto', 'the warm session is idled before the microphone opens');
  assert.equal(recognitions.length, 0, 'recognition waits for the session to settle');
  advance(800);
  await Promise.resolve();
  assert.equal(audioSession.type, 'play-and-record');
  assert.equal(recognitions.length, 1);
  const recognition = recognitions.at(-1);
  recognition.onaudiostart();
  recognition.result([['play Third', true]]);
  advance(2000);
  recognition.onend();
  assert.equal(finished, 'play Third');
  assert.equal(audioSession.type, 'playback', 'the output category is restored on exit');
});

test("a silent recognizer with no events is bounded and cancelled timers cannot affect a retry", () => {
  const audioSession = { type: "playback" };
  const { Voice, recognitions, advance } = harness({ audioSession });
  const first = Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: assert.fail });
  advance(10000);
  const second = Voice.listen({ ontext() {}, onfinish() {}, onerror: assert.fail });
  first.cancel();
  assert.equal(audioSession.type, "play-and-record");
  assert.equal(recognitions[0].aborted, true);
  recognitions[1].result([["תשים לי שיר של אייל גולן", false]]);
  recognitions[1].onspeechstart(); advance(60000);
  assert.equal(Voice.isListening(), true, "recognized dictation has no word or duration limit");
  second.cancel(); assert.equal(audioSession.type, "playback");
});

test("artist names retain the word Music when stripping channel suffixes", async () => {
  const { Voice } = harness({ Api: {
    search: async () => ({ items: [{ ...song, artist: "Roxy Music - Topic", artistVerified: true }] }),
    searchArtists: assert.fail, looksLikeMusic: () => true
  } });
  assert.equal((await Voice.resolve("play songs by Roxy Music")).tracks[0].id, song.id);
});

test("cancelling an artist channel lookup prevents trying the next channel", async () => {
  let release, active = true;
  const fetched = [];
  const { Voice } = harness({ Api: {
    search: async () => ({ items: [] }),
    searchArtists: async () => ({ items: [{ id: "first", name: "Queen Official" }, { id: "next", name: "Queen" }] }),
    getArtist: id => { fetched.push(id); return new Promise(resolve => { release = resolve; }); }, looksLikeMusic: () => true
  } });
  const pending = Voice.resolve("play songs by Queen", null, () => active);
  while (!release) await Promise.resolve();
  active = false; release({ videos: [] });
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(fetched, ["first"]);
});

test("a long mixed-language request reaches AI without truncation", async () => {
  const request = "אני רוצה לשמוע " + "מוזיקה ".repeat(1800) + "בעצם תשים Bohemian Rhapsody של Queen";
  let received;
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true,
    interpretPlayback: async text => { received = text; return { kind: "song", query: song.title, artist: "Queen" }; }
  }, Api: { matchTrack: async () => song } });
  assert.equal((await Voice.resolve(request)).tracks[0].id, song.id); assert.equal(received, request);
});

test("AI failure does not silently play a simpler interpretation", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: async () => { throw Error("offline"); } } });
  await assert.rejects(Voice.resolve("play Queen but only quiet tracks"), /AI/);
});

test("AI clarification never starts a music lookup", async () => {
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true, interpretPlayback: async () => ({ kind: "clarify", query: "Which artist?", artist: "" })
  } });
  await assert.rejects(Voice.resolve("play that song"), /Which artist/);
});

test("cancelling during interpretation prevents subsequent music searches", async () => {
  let release, active = true;
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: () => new Promise(r => { release = r; }) } });
  const pending = Voice.resolve("play Queen but only quiet tracks", null, () => active);
  await Promise.resolve();
  active = false; release({ kind: "artist", query: "Queen" });
  await assert.rejects(pending, /cancelled/);
});

test("clear online song requests use zero AI calls even when a key is configured", async () => {
  const { Voice } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail }, Api: { matchTrack: async () => song } });
  assert.equal((await Voice.resolve("תשים לי את השיר Bohemian Rhapsody של Queen")).tracks[0].id, song.id);
  assert.equal((await Voice.resolve("תשים את השיר Bohemian Rhapsody של Queen")).tracks[0].id, song.id);
});

test("put on the playlist without a personal pronoun uses no AI request", async () => {
  const { Voice, Store } = harness({ Ai: { hasAnyKey: () => true, interpretPlayback: assert.fail } });
  const playlist = Store.createPlaylist("אימון");
  Store.addTrack(song); Store.addToPlaylist(playlist.id, song.id);
  assert.equal((await Voice.resolve("תשים את הפלייליסט אימון")).tracks[0].id, song.id);
});

test("repeated complex requests reuse their interpretation", async () => {
  let calls = 0;
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true,
    interpretPlayback: async () => { calls++; return { kind: "song", query: song.title, artist: "Queen" }; }
  }, Api: { matchTrack: async () => song } });
  for (let i = 0; i < 2; i++) await Voice.resolve("תשים משהו של קווין בעצם בוהמיאן רפסודי");
  assert.equal(calls, 1);
});

test("a failed phonetic name lookup uses one cached interpretation and searches the corrected name", async () => {
  let calls = 0; const queries = [];
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true,
    interpretPlayback: async () => { calls++; return { kind: "song", query: song.title, artist: "Queen" }; }
  }, Api: { matchTrack: async title => { queries.push(title); return title === song.title ? song : null; } } });
  for (let i = 0; i < 2; i++) assert.equal((await Voice.resolve("תשים בוהמיאן רפסודי")).tracks[0].id, song.id);
  assert.equal(calls, 1); assert.deepEqual(queries, ["בוהמיאן רפסודי", song.title, "בוהמיאן רפסודי", song.title]);
});

test("clear mood requests generate once and reuse suggestions", async () => {
  let calls = 0;
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true, interpretPlayback: assert.fail,
    generatePlaylist: async () => { calls++; return { name: "Calm", tracks: [song] }; }
  }, Api: { matchTrack: async () => song } });
  for (let i = 0; i < 2; i++) await Voice.resolve("תשים משהו רגוע");
  assert.equal(calls, 1);
});

test("complex mix suggestions are included in the interpretation without another model request", async () => {
  let calls = 0;
  const { Voice } = harness({ Ai: {
    hasAnyKey: () => true, generatePlaylist: assert.fail,
    interpretPlayback: async () => { calls++; return { kind: "mix", query: "Quiet Queen", artist: "", tracks: [song] }; }
  }, Api: { matchTrack: async () => song } });
  assert.equal((await Voice.resolve("play Queen but only quiet tracks")).tracks[0].id, song.id);
  assert.equal(calls, 1);
});

test("unmatched or blocked songs do not produce a replacement queue", async () => {
  const { Voice, Store } = harness({ Api: { matchTrack: async () => song } });
  Store.blockTrack(song);
  await assert.rejects(Voice.resolve("play Bohemian Rhapsody"), /לא מצאתי/);
});

test("dictation accumulates results and reconnects during a brief pause", () => {
  const { Voice, recognitions, tick } = harness();
  let text, finished;
  const capture = Voice.listen({ lang: "he-IL", ontext: t => text = t, onfinish: t => finished = t, onerror: assert.fail });
  assert.equal(recognitions[0].continuous, true); assert.equal(recognitions[0].lang, "he-IL");
  recognitions[0].result([["תשים לי", true], ["שירים", false]]);
  recognitions[0].result([["תשים לי", true], ["שירים של Queen", true]]);
  assert.equal(text, "תשים לי שירים של Queen");
  recognitions[0].onend(); tick(300);
  assert.equal(finished, undefined); assert.equal(recognitions.length, 2);
  recognitions[1].result([["וגם של Beatles", true]]);
  capture.finish(); recognitions[1].onend();
  assert.equal(finished, "תשים לי שירים של Queen וגם של Beatles");
  assert.equal(recognitions[1].stopped, true); assert.equal(recognitions[1].onresult, null);
});

test("finish retains a final correction arriving after stop", () => {
  const { Voice, recognitions } = harness(); let finished;
  const capture = Voice.listen({ ontext() {}, onfinish: text => finished = text, onerror: assert.fail });
  recognitions[0].result([["Queen", false]]); capture.finish();
  recognitions[0].result([["Queen and Beatles", true]]); recognitions[0].onend();
  assert.equal(finished, "Queen and Beatles");
});

test("Galaxy cumulative hypotheses produce the user's sentence once and auto-finish", () => {
  const hypotheses = ["תשים", "תשים לי", "תשים לי", "תשים לי שיר", "תשים לי שיר", "תשים לי שיר", "תשים לי שיר של", "תשים לי שיר של אייל", "תשים לי שיר של אייל גולן", "תשים לי שיר של אייל גולן"];
  for (const markedFinal of [false, true]) {
    const { Voice, recognitions, advance } = harness(); let text, finished;
    Voice.listen({ ontext: t => text = t, onfinish: t => finished = t, onerror: assert.fail });
    for (let i = 0; i < hypotheses.length; i++) {
      recognitions[0].result(hypotheses.slice(0, i + 1).map(t => [t, markedFinal]));
      assert.equal(text, hypotheses[i]);
    }
    advance(2000); recognitions[0].onend();
    assert.equal(finished, "תשים לי שיר של אייל גולן");
    assert.equal(Voice.basicIntent(finished).query, "אייל גולן");
  }
});

test("Galaxy one-result final hypotheses replace the previous growing phrase", () => {
  const { Voice, recognitions } = harness(); let text;
  Voice.listen({ ontext: value => text = value, onfinish() {}, onerror: assert.fail });
  for (const phrase of ["תשים", "תשים לי", "תשים לי שיר", "תשים לי שיר של אייל גולן"]) {
    recognitions[0].result([[phrase, true]]);
    assert.equal(text, phrase);
  }
});

test("Galaxy duplicate initial final results followed by growth produce one command", () => {
  const { Voice, recognitions } = harness(); let text;
  const capture = Voice.listen({ ontext: value => text = value, onfinish() {}, onerror: assert.fail });
  const phrases = ['תשים', 'תשים', 'תשים לי', 'תשים לי שיר', 'תשים לי שיר של אייל גולן'];
  for (let i = 0; i < phrases.length; i++) recognitions[0].result(phrases.slice(0, i + 1).map(t => [t, true]));
  assert.equal(text, 'תשים לי שיר של אייל גולן');
  assert.equal(Voice.basicIntent(text).kind, 'artist');
  capture.cancel();
});

test("duplicate command words inside a result are removed without changing repeated song words", () => {
  const { Voice, recognitions } = harness(); let text;
  const capture = Voice.listen({ ontext: value => text = value, onfinish() {}, onerror: assert.fail });
  recognitions[0].result([['תשים תשים לי שיר של אייל גולן', true]]);
  assert.equal(text, 'תשים לי שיר של אייל גולן');
  assert.equal(Voice.basicIntent('תשים תשים לי שיר של אייל גולן').query, 'אייל גולן');
  recognitions[0].result([['play play the song Bye Bye Bye', true]]);
  assert.equal(text, 'play the song Bye Bye Bye');
  capture.cancel();
});

test("unchanged final results cannot postpone submission through a browser restart", () => {
  const { Voice, recognitions, advance } = harness(); let finished;
  Voice.listen({ ontext() {}, onfinish: value => finished = value, onerror: assert.fail });
  recognitions[0].result([['play songs by Queen', true]]);
  advance(1400);
  recognitions[0].result([['play songs by Queen', true]]);
  recognitions[0].onend(); advance(300);
  recognitions[1].onaudiostart(); advance(300);
  assert.equal(recognitions[1].stopped, true);
  recognitions[1].onend();
  assert.equal(finished, 'play songs by Queen');
});

test("cumulative transcripts across quick recognition restarts are not appended repeatedly", () => {
  const { Voice, recognitions, tick } = harness(); let text;
  const capture = Voice.listen({ ontext: t => text = t, onfinish() {}, onerror: assert.fail });
  for (const [index, words] of ["תשים", "תשים לי", "תשים לי שיר", "תשים לי שיר של אייל גולן"].entries()) {
    recognitions[index].result([[words, true]]);
    assert.equal(text, words);
    recognitions[index].onend(); tick(300);
  }
  capture.cancel();
});

test("interim replacement and removal retain final segments and real repeated words", () => {
  const { Voice, recognitions } = harness(); let text, finished;
  const capture = Voice.listen({ ontext: t => text = t, onfinish: t => finished = t, onerror: assert.fail });
  recognitions[0].result([["play", true], ["Bye Bye Bye", false]]);
  assert.equal(text, "play Bye Bye Bye");
  recognitions[0].result([["play", true], ["Talk Talk", false], ["extra", false]]);
  recognitions[0].result([["play", true], ["Talk Talk", true]]);
  assert.equal(text, "play Talk Talk");
  recognitions[0].result([["play", true], ["Talk Talk", true], ["Talk Talk", true]]);
  capture.finish(); recognitions[0].onend();
  assert.equal(finished, "play Talk Talk Talk Talk");
});

test("finish fallback preserves interim text when a browser omits its end event", () => {
  const { Voice, recognitions, tick } = harness(); let finished;
  const capture = Voice.listen({ ontext() {}, onfinish: text => finished = text, onerror: assert.fail });
  recognitions[0].result([["play Yesterday", false]]); capture.finish(); tick(1500);
  assert.equal(finished, "play Yesterday");
});

test("cancel prevents pending reconnects and late completion", () => {
  const { Voice, recognitions, tick } = harness();
  const capture = Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: assert.fail });
  recognitions[0].onend(); capture.cancel(); tick(300); tick(1500);
  assert.equal(recognitions.length, 1); assert.equal(recognitions[0].onresult, null);
});

test("permission errors release the microphone without restart", () => {
  const { Voice, recognitions, tick } = harness(); let error;
  Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: code => error = code });
  recognitions[0].onerror({ error: "not-allowed" }); tick(300);
  assert.equal(error, "not-allowed"); assert.equal(recognitions[0].aborted, true);
  assert.equal(recognitions.length, 1);
});

test("repeated empty disconnections preserve the request until automatic finish", () => {
  const { Voice, recognitions, tick } = harness(); let saved;
  Voice.listen({ ontext() {}, onfinish: text => saved = text, onerror: assert.fail });
  recognitions[0].result([["play Queen", true]]);
  for (let i = 0; i < 4; i++) { recognitions[i].onend(); tick(300); }
  tick(2000); tick(1500);
  assert.equal(saved, "play Queen"); assert.equal(recognitions.length, 4);
});

test("two seconds of silence automatically finishes exactly once with the last correction", () => {
  const { Voice, recognitions, advance } = harness(); const finished = [];
  let finishing = 0;
  Voice.listen({ ontext() {}, onfinishing: () => finishing++, onfinish: text => finished.push(text), onerror: assert.fail });
  recognitions[0].result([["play Yesterday", false]]);
  advance(1999); assert.equal(recognitions[0].stopped, undefined);
  advance(1); assert.equal(recognitions[0].stopped, true); assert.equal(finishing, 1);
  recognitions[0].result([["play Yesterday by Beatles", true]]);
  recognitions[0].onend(); advance(10000);
  assert.deepEqual(finished, ["play Yesterday by Beatles"]);
});

test("continuing to dictate resets the full silence interval", () => {
  const { Voice, recognitions, advance } = harness(); let finished;
  Voice.listen({ ontext() {}, onfinish: text => finished = text, onerror: assert.fail });
  recognitions[0].result([["תשים את השיר", false]]);
  advance(1500);
  recognitions[0].result([["תשים את השיר Yesterday", true]]);
  advance(1500); assert.equal(recognitions[0].stopped, undefined);
  advance(500); assert.equal(recognitions[0].stopped, true);
  recognitions[0].onend(); assert.equal(finished, "תשים את השיר Yesterday");
});

test("detected ongoing speech prevents timeout while a transcript is delayed", () => {
  const { Voice, recognitions, advance } = harness();
  Voice.listen({ ontext() {}, onfinish() {}, onerror: assert.fail });
  recognitions[0].result([["play", true]]); advance(1000);
  recognitions[0].onspeechstart(); advance(10000);
  assert.equal(recognitions[0].stopped, undefined);
  recognitions[0].result([["play Queen and", false]]); advance(10000);
  assert.equal(recognitions[0].stopped, undefined);
  recognitions[0].onspeechend(); advance(2000);
  assert.equal(recognitions[0].stopped, true);
});

test("silence without recognized words never submits a request", () => {
  const { Voice, recognitions, advance } = harness();
  Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: assert.fail });
  recognitions[0].onspeechstart(); recognitions[0].onspeechend();
  recognitions[0].result([["  ", true]]); advance(10000);
  assert.equal(recognitions[0].stopped, undefined);
});

test("cancellation and permission errors clear an already armed silence timeout", () => {
  for (const cancel of [true, false]) {
    const { Voice, recognitions, advance } = harness();
    const capture = Voice.listen({ ontext() {}, onfinish: assert.fail, onerror() {} });
    recognitions[0].result([["play Queen", true]]); advance(1000);
    if (cancel) capture.cancel();
    else recognitions[0].onerror({ error: "not-allowed" });
    advance(10000); assert.equal(recognitions[0].stopped, undefined);
  }
});

test("restarting a browser session does not extend the silence deadline", () => {
  const { Voice, recognitions, advance } = harness(); let finished;
  Voice.listen({ ontext() {}, onfinish: text => finished = text, onerror: assert.fail });
  recognitions[0].result([["play Queen", true]]); advance(1000);
  recognitions[0].onend(); advance(300);
  assert.equal(recognitions.length, 2);
  advance(700); assert.equal(recognitions[1].stopped, true);
  recognitions[1].onend(); assert.equal(finished, "play Queen");
});

test("spoken replies use a local Hebrew voice without touching a remote voice", async () => {
  let spoken;
  const remote = { lang: "he-IL", localService: false };
  const local = { lang: "he-IL", localService: true };
  const { Voice } = harness({ synth: { getVoices: () => [remote, local], cancel() {}, speak: u => { spoken = u; u.onend(); } } });
  assert.equal(await Voice.reply({ he: "מצאתי", en: "Found it" }, "he-IL"), true);
  assert.equal(spoken.voice, local); assert.equal(spoken.text, "מצאתי");
});

test("devices with only an English local voice receive an English reply", async () => {
  let spoken;
  const { Voice } = harness({ synth: {
    getVoices: () => [{ lang: "he-IL", localService: false }, { lang: "en-US", localService: true }],
    cancel() {}, speak: u => { spoken = u; u.onend(); }
  } });
  await Voice.reply({ he: "מצאתי", en: "Found it" }, "he-IL");
  assert.equal(spoken.text, "Found it"); assert.equal(spoken.lang, "en-US");
});

test("remote-only speech voices and muted replies never synthesize audio", async () => {
  const { Voice, Store } = harness({ synth: { getVoices: () => [{ lang: "he-IL", localService: false }], speak: assert.fail } });
  assert.equal(await Voice.reply({ he: "מצאתי" }, "he-IL"), false);
  Store.patchSettings({ voiceReply: false });
  assert.equal(await Voice.reply({ he: "מצאתי" }, "he-IL"), false);
});

test("spoken replies default off on iPhone and on elsewhere, and the setting overrides", async () => {
  const speak = { getVoices: () => [{ lang: "he-IL", localService: true }], cancel() {}, speak: u => u.onend() };
  // Inside a tap, the only moment iOS speaks at all.
  const ios = harness({ userAgent: "iPhone", synth: speak, userActivation: { isActive: true } });
  assert.equal(ios.Voice.repliesOn(), false, "off by default on iPhone - a spoken reply deafens the next request");
  assert.equal(await ios.Voice.reply({ he: "מצאתי" }, "he-IL"), false, "so no audio is synthesized");
  ios.Store.patchSettings({ voiceReply: true });
  assert.equal(ios.Voice.repliesOn(), true, "the setting turns it back on");
  assert.equal(await ios.Voice.reply({ he: "מצאתי" }, "he-IL"), true);

  const other = harness({ synth: speak });
  assert.equal(other.Voice.repliesOn(), true, "on by default off iOS");
  other.Store.patchSettings({ voiceReply: false });
  assert.equal(other.Voice.repliesOn(), false, "and the setting turns it off");
});

test("cancelling or timing out a spoken reply releases its pending playback continuation", async () => {
  let cancelled = 0;
  const { Voice, tick } = harness({ synth: {
    getVoices: () => [{ lang: "en-US", localService: true }], speak() {}, cancel: () => cancelled++
  } });
  const first = Voice.reply({ en: "Starting" }, "en-US");
  Voice.stopReply(); assert.equal(await first, false);
  const second = Voice.reply({ en: "Starting" }, "en-US");
  tick(8000); assert.equal(await second, false); assert.equal(cancelled, 2);
});

test("liked songs can be queued next or appended without naming a song", async () => {
  const { Voice, Store } = harness();
  Store.addTrack(song);
  Store.toggleLike(song.id);
  for (const request of ["add my liked songs to the queue", "תוסיף את השירים שאהבתי לתור", "play my liked songs next"]) {
    const result = await Voice.resolve(request);
    assert.notEqual(result.action, "play", request);
    assert.deepEqual(Array.from(result.tracks, track => track.id), [song.id], request);
  }
});

test("a list asked for next goes in whole, in order, while an ambiguous song still asks for one", async () => {
  const { Voice, Store } = harness();
  const another = { ...song, id: "another", title: "Another One Bites the Dust" };
  Store.addTrack(song); Store.toggleLike(song.id);
  Store.addTrack(another); Store.toggleLike(another.id);
  const result = await Voice.resolve("play my liked songs next");
  assert.equal(result.action, "next");
  assert.deepEqual(Array.from(result.tracks, track => track.id).sort(), [another.id, song.id].sort());
});

// The placement wording had its own shorter verb lists, so a feminine "put it at the end"
// and "turn on as the next song" were read as plain play requests that replace the queue.
test("every play verb can put a song next or at the end of the queue", () => {
  const { Voice } = harness();
  for (const [request, action] of [
    ["תפעיל בתור השיר הבא את Bohemian Rhapsody של Queen", "next"],
    ["תפעילי בתור השיר הבא את Bohemian Rhapsody של Queen", "next"],
    ["put on next song Bohemian Rhapsody by Queen", "next"],
    ["תשימי לסוף התור את Bohemian Rhapsody של Queen", "append"],
    ["שימי לסוף התור את Bohemian Rhapsody של Queen", "append"]
  ]) {
    const intent = Voice.basicIntent(request);
    assert.equal(intent.action, action, request);
    assert.equal(intent.query, song.title, request);
    assert.equal(intent.artist, "Queen", request);
  }
});

test("a title with its own by or של keeps it, and the performer is what follows the last one", () => {
  const { Voice } = harness();
  const hebrew = Voice.basicIntent("תשים את השיר ילדה של אבא של עומר אדם");
  assert.equal(hebrew.query, "ילדה של אבא"); assert.equal(hebrew.artist, "עומר אדם");
  const english = Voice.basicIntent("play Stand by Me by Ben E. King");
  assert.equal(english.query, "Stand by Me"); assert.equal(english.artist, "Ben E. King");
});

test("a verb with nothing after it asks what to play without searching", async () => {
  let searched = 0;
  const { Voice } = harness({ seed: { "aura.library": [{ id: "nameless", title: "Song", artist: "" }] },
    Api: { matchTrack: async () => { searched++; return song; }, search: async () => { searched++; return { items: [] }; } } });
  for (const request of ["תשים לי", "play", "put on"]) {
    await assert.rejects(Voice.resolve(request), /איזה שיר, אמן או פלייליסט/, request);
  }
  assert.equal(searched, 0);
});

// ---- The iPhone recording path ----
// On iOS only the first recognition of a page load is fed audio, so every later iPhone
// request is recorded through the page's microphone and transcribed. The recorder hands
// out 300ms slices, each carrying the level it was recorded at, and the offline decoder
// turns the slices back into that many samples at those levels.
const SLICE_BYTES = 16;
function recordingDevice() {
  // silentWhen: which ways of opening the microphone record exact silence, by what was asked.
  // endOnStop: a stopped recognizer's native end arrives at the next step of run().
  const device = { level: 0.002, live: true, undecodable: false, silentWhen: null, endOnStop: true, recorders: [], decoders: 0, clock: null, constraints: null };
  device.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = ""; device.recorders.push(this); }
    start(slice) {
      this.state = "recording";
      const asked = device.constraints.at(-1);
      const silent = !!(device.silentWhen && device.silentWhen(asked.audio));
      this.timer = device.clock.setInterval(() => {
        // A deaf microphone hands the recorder nothing at all.
        if (device.live) this.ondataavailable?.({ data: new Blob([String(silent ? 0 : device.level).padEnd(SLICE_BYTES)], { type: "audio/mp4" }) });
      }, slice);
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      device.clock.clearInterval(this.timer);
      Promise.resolve().then(() => {
        this.ondataavailable?.({ data: new Blob([], { type: "audio/mp4" }) });
        this.onstop?.();
      });
    }
  };
  device.OfflineAudioContext = class {
    constructor(channels, length, rate) { this.sampleRate = rate; device.decoders++; }
    async decodeAudioData(buffer) {
      if (device.undecodable) throw Object.assign(new Error("undecodable"), { name: "EncodingError" });
      const levels = (Buffer.from(buffer).toString().match(new RegExp(".{" + SLICE_BYTES + "}", "g")) || []).map(Number);
      const perSlice = Math.round(this.sampleRate * 0.3), samples = new Float32Array(levels.length * perSlice);
      levels.forEach((level, i) => samples.fill(level, i * perSlice, (i + 1) * perSlice));
      return { sampleRate: this.sampleRate, getChannelData: () => samples };
    }
  };
  return device;
}
// Lets blob reads, decodes and transcriptions finish between fake timer steps.
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function run(h, ms) {
  for (let t = 0; t < ms; t += 100) {
    h.advance(100);
    if (h.device && h.device.endOnStop) for (const recognition of h.recognitions) if (recognition.state === "stopping") recognition.end();
    await flush();
  }
}
function transcriber(words) {
  const sent = [];
  return { sent, Ai: { hasAnyKey: () => true, transcribe: async (blob, lang) => {
    sent.push({ size: blob.size, type: blob.type, lang });
    return typeof words === "function" ? words() : " " + words.shift() + " ";
  } } };
}
function recordingHarness(platform, Ai, extra = {}) {
  const device = recordingDevice();
  const h = voiceHarness(platform, { Ai, MediaRecorder: device.MediaRecorder, OfflineAudioContext: device.OfflineAudioContext, ...extra });
  device.clock = h.clock;
  device.constraints = h.constraints;
  return { ...h, device };
}
// The first request of the page load, on the built-in recognizer.
async function firstRequest(h) {
  let heard;
  h.Voice.listen({ ontext() {}, onfinish: value => heard = value, onerror: assert.fail });
  await flush();
  const recognition = h.recognitions.at(-1);
  recognition.emit("audiostart");
  recognition.result([["play First", true]]);
  h.advance(2000); recognition.end();
  assert.equal(heard, "play First");
}
async function speak(h, level = 0.2) {
  h.device.level = 0.002; await run(h, 600);
  h.device.level = level; await run(h, 900);
  h.device.level = 0.002; await run(h, 2100);
}
// Runs until the recognizer alongside the recording has started, once the microphone
// delivers sound, and returns it.
async function recognizerAlongside(h, before) {
  for (let t = 0; t < 3000 && h.recognitions.length === before; t += 100) await run(h, 100);
  assert.equal(h.recognitions.length, before + 1, "the recognizer starts alongside once the microphone delivers");
  return h.recognitions.at(-1);
}
// Speaks into the recording while the recognizer alongside hears the words as they come,
// a word at a time, then its final result, then quiet.
async function speakHeard(h, recognition, words) {
  h.device.level = 0.002; await run(h, 600);
  recognition.emit("speechstart");
  h.device.level = 0.2;
  const said = words.split(" ");
  for (let i = 1; i <= said.length; i++) { recognition.result([[said.slice(0, i).join(" "), false]]); await run(h, 300); }
  recognition.result([[words, true]]);
  h.device.level = 0.002; await run(h, 2100);
}

test("after its first request, an iPhone whose recognizer hears nothing has each recording transcribed", async () => {
  const { sent, Ai } = transcriber(["play Second", "play Third", "play Fourth"]);
  const finished = [], errors = [], listening = [];
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  for (const words of ["play Second", "play Third", "play Fourth"]) {
    const recognizers = h.recognitions.length;
    h.Voice.listen({ ontext: assert.fail, onfinish: value => finished.push(value), onerror: code => errors.push(code),
      onlistening: value => listening.push(value) });
    await flush();
    assert.equal(h.recognitions.length, recognizers, "no recognizer before the microphone delivers");
    const recorder = h.device.recorders.at(-1);
    assert.equal(recorder.state, "recording");
    assert.equal(h.audioSession.type, "play-and-record");
    assert.equal(h.Voice.isListening(), true);
    await speak(h);
    assert.equal(h.recognitions.length, recognizers + 1, "the recognizer listened alongside, and heard nothing");
    assert.equal(recorder.state, "inactive", "a second and a half of quiet after the voice ends the request");
    await flush();
    assert.equal(finished.at(-1), words);
    assert.equal(h.Voice.isListening(), false);
    assert.equal(h.audioSession.type, "playback");
    assert.ok(h.tracks.every(track => track.readyState === "ended"), "the microphone is released");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(listening, [true, true, true]);
  assert.deepEqual(sent.map(s => s.lang), ["he-IL", "he-IL", "he-IL"]);
  assert.equal(sent[0].type, "audio/mp4");
  assert.ok(h.device.decoders > 0, "levels come from an offline decode, not a live audio context");
  assert.equal(h.logs.some(line => /Second|Third|Fourth/.test(line)), false, "spoken words stay out of the log");
  assert.ok(h.logs.some(line => line.startsWith("voice capture 2: opened on the recording path")));
  assert.ok(h.logs.some(line => /^voice capture 2: audio arriving after \d+ms, audio\/mp4, without voice processing$/.test(line)));
  assert.deepEqual(h.constraints.slice(1).map(asked => asked.audio.echoCancellation), [false, false, false],
    "each recording opens the microphone without voice processing first");
});

test("a soft voice in a quiet room is heard, and a murmur barely above a noisy room is not sent", async () => {
  for (const [room, voice, expected] of [[0.002, 0.025, "play Soft"], [0.012, 0.03, "recognition-timeout"]]) {
    const { sent, Ai } = transcriber(["play Soft"]);
    const finished = [], errors = [];
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code) });
    await flush();
    h.device.level = room; await run(h, 600);
    h.device.level = voice; await run(h, 900);
    h.device.level = room; await run(h, 10000);
    await flush();
    assert.deepEqual(finished.concat(errors), [expected], "room " + room + ", voice " + voice);
    assert.equal(sent.length, expected === "play Soft" ? 1 : 0);
  }
});

test("a recording nobody speaks into is never sent, and one the meter cannot decode is sent at its limit", async () => {
  for (const [undecodable, expected] of [[false, "recognition-timeout"], [true, "play Quiet"]]) {
    const { sent, Ai } = transcriber(["play Quiet"]);
    const finished = [], errors = [];
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    h.device.undecodable = undecodable;
    h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code) });
    await flush();
    await run(h, 10500);
    await flush();
    assert.deepEqual(finished.concat(errors), [expected]);
    assert.equal(sent.length, undecodable ? 1 : 0, "room noise is sent only when nothing could judge it");
    assert.ok(h.tracks.every(track => track.readyState === "ended"));
  }
});

test("a microphone that delivers nothing is opened the next way within seconds, never shown as listening", async () => {
  // Dead: no bytes at all; silent: bytes of exact digital silence.
  for (const [recovers, silent] of [[false, false], [true, false], [false, true]]) {
    const { sent, Ai } = transcriber(["play Again", "play Next"]);
    const finished = [], errors = [], listening = [];
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    if (silent) h.device.level = 0; else h.device.live = false;
    h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code),
      onlistening: value => listening.push(value) });
    await flush();
    await run(h, 2000);
    assert.deepEqual(listening, [], "the screen never says it listens on a microphone that delivers nothing");
    if (recovers) { h.device.live = true; await speak(h); }
    else await run(h, 5200);
    await flush();
    assert.deepEqual(finished.concat(errors), [recovers ? "play Again" : "mic-silent"]);
    assert.deepEqual(listening, recovers ? [true] : []);
    const ways = h.constraints.slice(1).map(asked => asked.audio === true ? "processed" : "raw");
    assert.deepEqual(ways, recovers ? ["raw", "processed"] : ["raw", "processed", "raw"]);
    assert.equal(h.audioSession.type, "playback", "the player's audio session comes back");
    assert.equal(sent.length, recovers ? 1 : 0);
    assert.ok(h.tracks.every(track => track.readyState === "ended"));
    const dropped = h.logs.filter(line => /^voice capture 2: no audio after \d+ms, (no bytes|\d+ bytes of exact silence),/.test(line));
    assert.equal(dropped.length, recovers ? 1 : 3);
    assert.ok(dropped.every(line => Number(line.match(/after (\d+)ms/)[1]) <= (silent ? 1000 : 1500)),
      "exact silence is dropped within a second, no bytes within a second and a half");
    if (recovers) {
      h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code) });
      await flush();
      assert.equal(h.constraints.at(-1).audio.echoCancellation, false, "the next request starts from the plainer way again");
      await speak(h);
      await flush();
      assert.equal(finished.at(-1), "play Next");
    }
  }
});

test("where the plain capture records silence, every later iPhone request is heard through voice processing", async () => {
  // As on an iPhone after music: the capture without voice processing recorded exact
  // silence, and voice processing opened right after it delivered the request.
  const requests = ["play Second", "play Third", "play Fourth", "play Fifth"];
  const { sent, Ai } = transcriber(requests.slice());
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  h.device.silentWhen = audio => audio !== true;
  for (const words of requests) {
    const finished = [], errors = [], listening = [];
    const opened = h.constraints.length;
    h.Voice.listen({ ontext: assert.fail, onfinish: value => finished.push(value), onerror: code => errors.push(code),
      onlistening: value => listening.push(value) });
    await flush();
    await run(h, 700);
    assert.deepEqual(h.constraints.slice(opened).map(asked => asked.audio === true ? "processed" : "raw"), ["raw", "processed"],
      words + ": the plain way first, then voice processing");
    assert.deepEqual(listening, [], words + ": not shown as listening while the silent way was open");
    await speak(h);
    await flush();
    assert.deepEqual(finished.concat(errors), [words]);
    assert.deepEqual(listening, [true], words + ": listening once the voice-processed microphone delivers");
    assert.ok(h.tracks.every(track => track.readyState === "ended"), words + ": the microphone is released");
    assert.equal(h.audioSession.type, "playback");
  }
  assert.equal(sent.length, requests.length);
  const dropped = h.logs.filter(line => /^voice capture \d+: no audio after \d+ms, \d+ bytes of exact silence,/.test(line));
  assert.equal(dropped.length, requests.length, "each request dropped the silent way once");
  assert.ok(dropped.every(line => Number(line.match(/after (\d+)ms/)[1]) <= 1000), "within a second");
});

test("the microphone waits for the player's audio to close, and never for long", async () => {
  for (const path of ["recognizer", "recording"]) {
    for (const settles of [true, false]) {
      const { Ai } = transcriber(["play Later"]);
      const h = recordingHarness({ userAgent: "iPhone" }, Ai);
      if (path === "recording") await firstRequest(h);
      let settle;
      const released = new Promise(resolve => { settle = resolve; });
      const opened = h.tracks.length;
      h.Voice.listen({ released, ontext() {}, onfinish() {}, onerror() {} });
      await flush();
      assert.equal(h.tracks.length, opened, path + ": no microphone while the player's audio is still closing");
      if (settles) { settle(); await flush(); }
      else { h.advance(2000); await flush(); }
      assert.equal(h.tracks.length, opened + 1, path + ": the microphone opens once it closed, or after 2s at most");
      assert.ok(h.logs.some(line => line.includes(settles ? "player audio released after" : "player audio still closing after")));
    }
  }
});

test("a recording cancelled while recording or transcribing sends and starts nothing", async () => {
  for (const when of ["recording", "transcribing"]) {
    let answer;
    const { sent, Ai } = transcriber(() => new Promise(resolve => { answer = resolve; }));
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    const capture = h.Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: assert.fail });
    await flush();
    h.device.level = 0.2; await run(h, 900);
    if (when === "transcribing") { h.device.level = 0.002; await run(h, 2100); assert.equal(sent.length, 1); }
    capture.cancel();
    await flush();
    if (answer) answer("play Late");
    await flush();
    assert.equal(sent.length, when === "recording" ? 0 : 1, when);
    assert.equal(h.Voice.isListening(), false);
    assert.ok(h.tracks.every(track => track.readyState === "ended"), when);
    assert.ok(h.recognitions.slice(1).every(recognition => recognition.onresult == null && recognition.state !== "running"),
      when + ": the recognizer alongside is let go");
  }
});

test("a failed transcription and a missing key each say what happened", async () => {
  for (const [failure, code] of [[new Error("HTTP 503"), "transcribe-failed"], [Object.assign(new Error("no key"), { noKey: true }), "no-key"]]) {
    const errors = [];
    const Ai = { hasAnyKey: () => true, transcribe: async () => { throw failure; } };
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    h.Voice.listen({ ontext() {}, onfinish: assert.fail, onerror: value => errors.push(value) });
    await flush();
    await speak(h);
    await flush();
    assert.deepEqual(errors, [code]);
  }
});

test("without a key a later iPhone request is heard by the recognizer, and names the key only when it heard nothing", async () => {
  const finished = [], errors = [];
  const h = recordingHarness({ userAgent: "iPhone" }, undefined);
  await firstRequest(h);
  for (const hears of [true, false]) {
    const before = h.recognitions.length;
    h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: code => errors.push(code) });
    await flush();
    const recognition = await recognizerAlongside(h, before);
    if (hears) await speakHeard(h, recognition, "play Keyless");
    else await speak(h);
    await flush();
  }
  assert.deepEqual(finished, ["play Keyless"]);
  assert.deepEqual(errors, ["no-key"]);
  assert.ok(h.tracks.every(track => track.readyState === "ended"));
});

test("a later iPhone request is heard by the built-in recognizer, like the first, and its recording is never sent", async () => {
  const { sent, Ai } = transcriber(["unused"]);
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  // As on the device: the plain capture records silence, and voice processing delivers.
  h.device.silentWhen = audio => audio !== true;
  for (const words of ["play Second", "play Third", "play Fourth", "play Fifth"]) {
    const shown = [], finished = [], errors = [], listening = [];
    const before = h.recognitions.length;
    h.Voice.listen({ ontext: value => shown.push(value), onfinish: value => finished.push(value), onerror: code => errors.push(code),
      onlistening: value => listening.push(value) });
    await flush();
    await run(h, 700);
    assert.equal(h.recognitions.length, before, words + ": no recognizer while the microphone delivers nothing");
    const recognition = await recognizerAlongside(h, before);
    assert.equal(h.constraints.at(-1).audio, true, words + ": it listens alongside the voice-processed microphone");
    assert.deepEqual(listening, [true]);
    await speakHeard(h, recognition, words);
    await flush();
    assert.deepEqual(finished.concat(errors), [words]);
    assert.equal(shown.at(-1), words, words + ": the words show as they are heard");
    assert.ok(shown.length >= 2, words + ": the first words show before the rest");
    assert.equal(recognition.stopped, true, words + ": the recognizer is stopped when the request ends");
    assert.equal(recognition.onresult, null, words + ": and keeps no handlers");
    assert.ok(h.tracks.every(track => track.readyState === "ended"), words + ": the microphone is released");
    assert.equal(h.audioSession.type, "playback");
  }
  assert.equal(sent.length, 0, "no recording is sent while the recognizer hears");
  assert.equal(h.logs.filter(line => /the request is the recognizer's, \d+ characters; the recording is not sent$/.test(line)).length, 4);
  assert.equal(h.logs.some(line => /Second|Third|Fourth|Fifth/.test(line)), false, "spoken words stay out of the log");
});

test("the recognizer's words end a request the level cannot judge, two seconds after they stop", async () => {
  const { sent, Ai } = transcriber(["unused"]);
  const finished = [];
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  h.device.undecodable = true;
  const before = h.recognitions.length;
  h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: assert.fail });
  await flush();
  const recognition = await recognizerAlongside(h, before);
  recognition.emit("speechstart");
  recognition.result([["play Undecoded", false]]);
  await run(h, 500);
  recognition.result([["play Undecoded", true]]);
  await run(h, 1900);
  assert.deepEqual(finished, [], "not before two seconds without new words");
  await run(h, 200);
  await flush();
  assert.deepEqual(finished, ["play Undecoded"]);
  assert.equal(sent.length, 0);
});

test("words still arriving keep a request open through a quiet level, and a recognizer that never ends cannot hold it", async () => {
  const { sent, Ai } = transcriber(["unused"]);
  const finished = [];
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  h.device.endOnStop = false;
  const before = h.recognitions.length;
  h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: assert.fail });
  await flush();
  const recognition = await recognizerAlongside(h, before);
  recognition.emit("speechstart");
  h.device.level = 0.2; await run(h, 600);
  // The level drops, but the recognizer still hears new words.
  h.device.level = 0.002;
  for (const words of ["play Long", "play Long Song", "play Long Song Name", "play Long Song Name Here"]) {
    recognition.result([[words, false]]);
    await run(h, 700);
  }
  assert.equal(h.device.recorders.at(-1).state, "recording", "still listening while words arrive");
  recognition.result([["play Long Song Name Here", true]]);
  await run(h, 1300);
  assert.equal(recognition.stopped, true, "stopped once the words stopped changing");
  assert.deepEqual(finished, [], "waiting for the recognizer's last words");
  // Its native end never arrives: the request goes on without it 1.5s after the stop.
  await run(h, 1600);
  await flush();
  assert.deepEqual(finished, ["play Long Song Name Here"]);
  assert.equal(recognition.aborted, true);
  assert.equal(sent.length, 0);
});

test("a recognizer run that ends by itself is replaced, keeping the words it heard", async () => {
  const { sent, Ai } = transcriber(["unused"]);
  const finished = [];
  const h = recordingHarness({ userAgent: "iPhone" }, Ai);
  await firstRequest(h);
  const before = h.recognitions.length;
  h.Voice.listen({ ontext() {}, onfinish: value => finished.push(value), onerror: assert.fail });
  await flush();
  const first = await recognizerAlongside(h, before);
  first.result([["play Split", true]]);
  first.end();
  await run(h, 300);
  const second = h.recognitions.at(-1);
  assert.notEqual(second, first, "a new run takes over");
  assert.equal(second.state, "running");
  second.result([["Song", true]]);
  await run(h, 2100);
  await flush();
  assert.deepEqual(finished, ["play Split Song"]);
  assert.equal(sent.length, 0);
});

test("the same final words handed over twice as the iPhone recognizer stops are one request, not two", async () => {
  // As on the device: stopped just as it closed the sentence on its own, the recognizer
  // gave the final words, then the same words again as a second final result. A pause in
  // the middle of a sentence gives two different final parts, and both are kept.
  // Each case: the result events after the stop, each a list of [words, final] results.
  for (const { finals, expected } of [
    { finals: [[["play Osher Cohen", true]], [["play Osher Cohen", true], ["play Osher Cohen.", true]]], expected: "play Osher Cohen" },
    { finals: [[["play Osher", true]], [["play Osher", true], ["Cohen", true]]], expected: "play Osher Cohen" }
  ]) {
    const { sent, Ai } = transcriber(["unused"]);
    const shown = [], finished = [];
    const h = recordingHarness({ userAgent: "iPhone" }, Ai);
    await firstRequest(h);
    h.device.endOnStop = false;
    const before = h.recognitions.length;
    h.Voice.listen({ ontext: value => shown.push(value), onfinish: value => finished.push(value), onerror: assert.fail });
    await flush();
    const recognition = await recognizerAlongside(h, before);
    recognition.emit("speechstart");
    h.device.level = 0.2;
    recognition.result([["play Osher", false]]);
    await run(h, 300);
    recognition.result([["play Osher Cohen", false]]);
    await run(h, 300);
    // Quiet: the level ends the request before the recognizer has closed the sentence.
    h.device.level = 0.002;
    for (let t = 0; t < 3000 && !recognition.stopped; t += 100) await run(h, 100);
    assert.equal(recognition.stopped, true);
    for (const results of finals) recognition.result(results);
    recognition.end();
    await flush();
    assert.deepEqual(finished, [expected]);
    assert.equal(shown.at(-1), expected, "the field shows the request once");
    assert.equal(sent.length, 0);
  }
});

test("Android keeps its recognizer for every request, key or not", async () => {
  const { sent, Ai } = transcriber(["unused"]);
  const h = recordingHarness({ userAgent: "Android" }, Ai);
  await firstRequest(h);
  await firstRequest(h);
  assert.equal(h.recognitions.length, 2);
  assert.equal(h.device.recorders.length, 0);
  assert.equal(sent.length, 0);
});

test("an iPhone reply is skipped unless it is spoken inside a tap", async () => {
  for (const [userActivation, spoken] of [[undefined, false], [{ isActive: false }, false], [{ isActive: true }, true]]) {
    let speaks = 0;
    const local = { lang: "he-IL", localService: true };
    const { Voice, Store } = harness({ userAgent: "iPhone", userActivation,
      synth: { getVoices: () => [local], cancel() {}, speak: u => { speaks++; u.onend(); } } });
    Store.patchSettings({ voiceReply: true });
    assert.equal(await Voice.reply({ he: "מצאתי" }, "he-IL"), spoken);
    assert.equal(speaks, spoken ? 1 : 0);
  }
});
