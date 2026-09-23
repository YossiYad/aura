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
  class Recognition {
    constructor() { recognitions.push(this); }
    start() { options.onstart?.(); this.onstart?.(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
    result(parts) {
      this.onresult({ results: parts.map(([text, final]) => Object.assign([{ transcript: text }], { isFinal: final })) });
    }
  }
  const Ai = options.Ai || { hasAnyKey: () => false };
  const Api = options.Api || {};
  const window = { SpeechRecognition: Recognition, Ai, Log: options.Log };
  if (options.synth) {
    window.speechSynthesis = options.synth;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  }
  vm.runInNewContext(source, {
    window, Store, Ai, Api, Player: { queue: () => [] }, navigator: { onLine: options.online !== false, audioSession: options.audioSession,
      userAgent: options.userAgent, platform: options.platform, maxTouchPoints: options.maxTouchPoints, mediaDevices: options.mediaDevices },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  return {
    Voice: window.Voice, Store, recognitions,
    tick(ms) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
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
    recognition.onend();
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
    assert.equal(recognitions.length, 1, 'the one iOS recognizer is reused across the reconnect, not recreated');
    if (ending === 'cancel') capture.cancel();
    if (ending === 'error') recognitions[0].onerror({ error: 'network' });
    if (ending === 'timeout') advance(20000);
    if (ending === 'finish-fallback') { capture.finish(); advance(1500); }
    assert.equal(stopped, true, ending);
    assert.equal(Voice.isListening(), false);
  }
});

test("iPhone reuses one recognizer across separate requests, but other browsers make a new one", async () => {
  // iOS feeds audio only to the first recognizer created per page load; a fresh one for the
  // next request fires audio start but stays deaf (WebKit 321436), so every capture reuses it.
  const ios = harness({ userAgent: "iPhone",
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  ios.Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
  await Promise.resolve();
  assert.equal(ios.recognitions.length, 1);
  ios.Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
  await Promise.resolve();
  assert.equal(ios.recognitions.length, 1, "the second request reuses the first recognizer, not a deaf new one");

  const other = harness();
  other.Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
  assert.equal(other.recognitions.length, 1);
  other.Voice.listen({ ontext() {}, onfinish() {}, onerror() {} });
  assert.equal(other.recognitions.length, 2, "off iOS each request makes its own recognizer");
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
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
  });
  // Spoken replies default off on iPhone (they deafen the next request); this test opts in
  // to exercise the settle that follows a reply the listener asked for.
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
  const ios = harness({ userAgent: "iPhone", synth: speak });
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
