const http = require("http");
const fs = require("fs");
const path = require("path");

// The nightly mix, built here instead of on a phone.
//
// The in-app version of this runs in the browser, because that is where the API keys are
// kept. It works, but only while a device is awake and open at the right hour, and every
// device does the whole job again for itself. This service does it once, at a real time,
// with a key that lives on this machine and never reaches a browser - and every device
// signed into the same account picks the result up as a single same-origin request.
//
// It reads what it needs from aura-sync's volume, mounted read-only: the listening
// profile is what the mix is built from, and it is already there because the app syncs it.
// Nothing is written back into that volume.

function positiveInt(value, fallback, min) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= (min == null ? 1 : min) ? parsed : fallback;
}

const PORT = positiveInt(process.env.PORT, 8090);
const DATA_DIR = process.env.MIX_DATA_DIR || "/data";
const SYNC_DIR = process.env.SYNC_DATA_DIR || "/sync-data";
const INVIDIOUS_BASE = (process.env.INVIDIOUS_BASE || "http://invidious:3000").replace(/\/+$/, "");
const MIX_HOUR = Math.min(23, positiveInt(process.env.MIX_HOUR, 4, 0));
const MIX_SONGS = Math.min(40, positiveInt(process.env.MIX_SONGS, 15, 5));
// A rebuild asked for by hand costs an AI call and a few dozen searches, so it is not
// something to hand out on every page load.
const REBUILD_COOLDOWN_MS = 10 * 60 * 1000;
const MIX_DIR = path.join(DATA_DIR, "mix");

function envList(name) {
  return String(process.env[name] || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const DEFAULT_MODEL = { gemini: "gemini-2.5-flash", groq: "openai/gpt-oss-120b" };
const FALLBACK_MODEL = { gemini: "gemini-flash-latest", groq: "" };

// Everyone has their own key, so a mix is normally built with the key of the person it is
// for - handed over from their own Settings, and kept per identity (see keysFile below).
// What is set here is the house key: an optional shared fallback for anyone who has not
// handed one over. Leaving it unset is a perfectly good way to run this.
const SHARED_PROVIDERS = [
  {
    name: "gemini",
    keys: envList("GEMINI_KEYS"),
    model: (process.env.GEMINI_MODEL || "").trim() || DEFAULT_MODEL.gemini,
    fallbackModel: FALLBACK_MODEL.gemini
  },
  {
    name: "groq",
    keys: envList("GROQ_KEYS"),
    model: (process.env.GROQ_MODEL || "").trim() || DEFAULT_MODEL.groq,
    fallbackModel: FALLBACK_MODEL.groq
  }
];

fs.mkdirSync(MIX_DIR, { recursive: true });

// ---------------- storage ----------------

// The same sanitizing aura-sync and aura-push use, so all three agree on who's who
// without any of them having to know the others' identity format.
function identityKey(email) {
  const base = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\.\.+/g, "_")
    .replace(/[^a-z0-9@._-]/g, "_");
  if (!base || base.startsWith(".")) throw new Error("unusable identity");
  return base;
}

function mixFile(key) {
  const file = path.join(MIX_DIR, key + ".json");
  if (!file.startsWith(MIX_DIR + path.sep)) throw new Error("unusable identity");
  return file;
}

// One person's own AI keys, handed over from their Settings so the nightly run can be
// made with their key rather than someone else's. Kept apart from everything else on
// purpose: not in aura-sync's blob, which is what backups and other devices are made of,
// and not in the mix file, which is content. They are stored in the clear, like the VAPID
// private key aura-push keeps next door - anyone who can read this volume can read them,
// so this is worth handing over only to a server you run yourself.
function keysFile(key) {
  const dir = path.join(DATA_DIR, "keys");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key + ".json");
  if (!file.startsWith(dir + path.sep)) throw new Error("unusable identity");
  return file;
}

function readOwnKeys(key) {
  const own = readJson(keysFile(key), null);
  if (!own || typeof own !== "object") return null;
  const list = v => (Array.isArray(v) ? v : []).filter(k => typeof k === "string" && k.trim()).map(k => k.trim());
  const gemini = list(own.gemini);
  const groq = list(own.groq);
  if (!gemini.length && !groq.length) return null;
  return {
    gemini, groq,
    mode: own.mode === "gemini" || own.mode === "groq" ? own.mode : "both",
    geminiModel: String(own.geminiModel || "").trim(),
    groqModel: String(own.groqModel || "").trim(),
    at: Number(own.at || 0)
  };
}

function forgetOwnKeys(key) {
  try { fs.unlinkSync(keysFile(key)); } catch (e) {}
}

// Whose key this run is spending. Someone's own comes first and, when they picked a
// single provider in Settings, only that one is tried - the same rule the app follows.
function providersFor(key) {
  const own = readOwnKeys(key);
  if (!own) return { providers: SHARED_PROVIDERS, mine: false };
  const wanted = own.mode === "both" ? ["gemini", "groq"] : [own.mode];
  const providers = wanted.map(name => ({
    name,
    keys: name === "gemini" ? own.gemini : own.groq,
    model: (name === "gemini" ? own.geminiModel : own.groqModel) || DEFAULT_MODEL[name],
    fallbackModel: FALLBACK_MODEL[name]
  })).filter(p => p.keys.length);
  return providers.length ? { providers, mine: true } : { providers: SHARED_PROVIDERS, mine: false };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = file + ".tmp";
  // Provider keys live in these files; nobody else on the box needs to read them.
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const stateFile = path.join(DATA_DIR, "state.json");

function readMix(key) {
  const mix = readJson(mixFile(key), null);
  return mix && Array.isArray(mix.tracks) && mix.tracks.length ? mix : null;
}

// One listener's whole synced state. Only the parts a mix is built from are read.
function readAccount(key) {
  const record = readJson(path.join(SYNC_DIR, key + ".json"), null);
  const data = record && record.data && record.data.data;
  return data && typeof data === "object" ? data : null;
}

function listAccounts() {
  try {
    return fs.readdirSync(SYNC_DIR)
      .filter(f => f.endsWith(".json") && !f.endsWith(".conflict.json"))
      .map(f => f.slice(0, -5));
  } catch (e) { return []; }
}

// ---------------- the listener, read out of the synced blob ----------------

function profileOf(account) {
  const p = (account && account.listeningProfile) || {};
  return {
    tracks: (p.tracks && typeof p.tracks === "object") ? p.tracks : {},
    artists: (p.artists && typeof p.artists === "object") ? p.artists : {}
  };
}

function isMusicTrack(track) {
  if (!track) return false;
  if (track.kind) return track.kind === "music";
  if (track.podcast) return false;
  return !/(?:^|\s)(?:podcast|פודקאסט|(?:episode|פרק)\s+[0-9]+)(?:\s|$)/i.test(track.title || "");
}

function topListeningTracks(account, limit) {
  return Object.values(profileOf(account).tracks)
    .filter(item => item && item.track && item.track.id && isMusicTrack(item.track))
    .sort((a, b) => ((b.plays || 0) - (a.plays || 0)) || ((b.lastPlayed || 0) - (a.lastPlayed || 0)))
    .slice(0, limit || 12)
    .map(item => Object.assign({}, item.track, { plays: item.plays || 0 }));
}

function topListeningArtists(account, limit) {
  const artists = new Map();
  Object.values(profileOf(account).tracks).forEach(item => {
    const t = item && item.track;
    if (!isMusicTrack(t) || !t.artist) return;
    const entry = artists.get(t.artist) || { name: t.artist, plays: 0, lastPlayed: 0 };
    entry.plays += Number(item.plays) || 0;
    entry.lastPlayed = Math.max(entry.lastPlayed, Number(item.lastPlayed) || 0);
    artists.set(t.artist, entry);
  });
  return Array.from(artists.values())
    .sort((a, b) => (b.plays - a.plays) || (b.lastPlayed - a.lastPlayed))
    .slice(0, limit || 12);
}

// What the request gets told about this listener - the same sentence the app builds, so
// a mix from here reads like one built on the device rather than a different feature.
function historyContext(account) {
  const artists = topListeningArtists(account, 8)
    .filter(a => a.name)
    .map(a => a.name + " (" + (a.plays || 0) + ")");
  const tracks = topListeningTracks(account, 10).map(t => t.title + (t.artist ? " by " + t.artist : ""));
  const parts = [];
  if (artists.length) parts.push("Artists this listener plays most, with play counts: " + artists.join(", ") + ".");
  if (tracks.length) parts.push("Recently played: " + tracks.join("; ") + ".");
  return parts.join(" ");
}

// The signature the app keys its own daily cache by: whose top artists this mix was
// built for. The app compares it against its own to notice a mix built for a taste that
// has since moved on.
function signatureOf(account) {
  return topListeningArtists(account, 8).map(a => a.name).sort().join("|");
}

function blockedOf(account) {
  const b = (account && account.blocked) || {};
  const tracks = Array.isArray(b.tracks) ? b.tracks.filter(t => t && t.id) : [];
  const artists = Array.isArray(b.artists) ? b.artists.map(a => String(a || "").trim().toLowerCase()).filter(Boolean) : [];
  return {
    ids: new Set(tracks.map(t => t.id)),
    artists: new Set(artists),
    labels: tracks.filter(t => t.title).map(t => t.title + (t.artist ? " - " + t.artist : "")).concat(artists)
  };
}

function isBlocked(blocked, track) {
  if (!track) return false;
  if (blocked.ids.has(track.id)) return true;
  const key = String(track.artist || "").trim().toLowerCase();
  return !!key && blocked.artists.has(key);
}

// Store.foldText, for comparing artist names that differ only in niqqud, quote style or
// dash - which is most of them, in a Hebrew catalogue.
function foldText(value) {
  return String(value == null ? "" : value).toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[\u05F3\u2018\u2019']/g, "")
    .replace(/[\u05F4\u201C\u201D"]/g, "")
    .replace(/[\u05BE\u2010-\u2015_]/g, " ")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Prompts steer a model, they do not bind it, so taste is checked structurally too: an
// artist this listener actually plays, from anywhere in their synced data. The app also
// counts a video YouTube files next to one they play, which needs a related-videos lookup
// per seed - skipped here, so this is the stricter half of the same test.
function knownArtists(account) {
  const known = new Set();
  const add = name => { const key = foldText(name); if (key) known.add(key); };
  topListeningArtists(account, 20).forEach(a => add(a.name));
  (Array.isArray(account.library) ? account.library : []).forEach(t => isMusicTrack(t) && add(t.artist));
  (Array.isArray(account.recents) ? account.recents : []).forEach(t => isMusicTrack(t) && add(t.artist));
  const downloads = (account && account.downloads) || {};
  Object.keys(downloads).forEach(id => { const t = downloads[id]; if (isMusicTrack(t)) add(t.artist); });
  return known;
}

// ---------------- Invidious: turning a suggestion into a real track ----------------

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function thumbFor(id) { return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"; }

function normInvidious(item) {
  if (!item || !item.videoId) return null;
  return {
    id: item.videoId,
    title: item.title || "",
    artist: item.author || "",
    album: "",
    duration: item.lengthSeconds || 0,
    thumb: thumbFor(item.videoId),
    views: item.viewCount != null ? item.viewCount : null,
    artistId: item.authorId || null,
    artistThumb: ""
  };
}

async function searchTracks(query) {
  const data = await fetchJson(INVIDIOUS_BASE + "/api/v1/search?q=" + encodeURIComponent(query) + "&type=video", 15000);
  return (Array.isArray(data) ? data : []).map(normInvidious).filter(Boolean);
}

function normMatch(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
}

const OTHER_VERSION = ["live", "cover", "remix", "karaoke", "instrumental", "reaction",
  "nightcore", "mashup", "sped up", "slowed", "reverb", "8d", "loop", "tutorial",
  "teaser", "trailer", "acapella", "concert"];
const MATCH_STOPWORDS = ["official", "video", "audio", "music", "hd", "hq", "lyric",
  "lyrics", "ft", "feat", "featuring", "the", "a"];

function matchTokens(s) {
  return normMatch(s).split(" ").filter(w => w && MATCH_STOPWORDS.indexOf(w) === -1);
}

function coverage(wanted, found) {
  if (!wanted.length) return 1;
  const have = new Set(found);
  return wanted.filter(w => have.has(w)).length / wanted.length;
}

// Ranks a search result against the song actually asked for, rather than trusting
// whatever the search happened to return first. Ported from the app unchanged - the two
// have to agree, or a mix built here would feel like a different app's mix.
function scoreMatch(candidate, wantTitle, wantArtist) {
  const candTitle = matchTokens(candidate.title);
  const candArtist = matchTokens(candidate.artist);
  const titleScore = coverage(matchTokens(wantTitle), candTitle.concat(candArtist));
  const wantedArtist = matchTokens(wantArtist);
  const artistScore = wantedArtist.length
    ? Math.max(coverage(wantedArtist, candArtist), coverage(wantedArtist, candTitle))
    : 1;
  let score = titleScore * 3 + artistScore * 2;
  const asked = normMatch(wantTitle + " " + wantArtist);
  const got = normMatch(candidate.title + " " + candidate.artist);
  for (const word of OTHER_VERSION) {
    if (got.indexOf(word) !== -1 && asked.indexOf(word) === -1) score -= 1.5;
  }
  if (/ topic$/.test(normMatch(candidate.artist))) score += 1;
  if (candidate.views > 0) score += Math.min(0.5, Math.log10(candidate.views) / 20);
  return { score, title: titleScore, artist: artistScore };
}

async function matchTrack(title, artist) {
  let items;
  try { items = await searchTracks((title + " " + (artist || "")).trim()); }
  catch (e) { return null; }
  let best = null;
  for (const item of items.filter(t => t.duration > 45 && t.duration < 1200)) {
    const scored = scoreMatch(item, title, artist);
    if (!best || scored.score > best.score) best = { item, score: scored.score, title: scored.title };
  }
  // No plausible candidate is a better answer than the wrong song.
  if (!best || best.title < 0.5 || best.score < 1.5) return null;
  return best.item;
}

const NOT_MUSIC = ["מערכון", "פרק מלא", "ראיון", "פודקאסט", "סטנד אפ", "סטנדאפ", "טריילר",
  "כתבה", "הרצאה", "חדשות", "מבזק", "וידאו בלוג", "משחק",
  "sketch", "full episode", "interview", "podcast", "trailer", "review", "reaction",
  "vlog", "documentary", "tutorial", "gameplay", "walkthrough", "highlights",
  "compilation", "prank", "unboxing", "stand up", "standup", "behind the scenes",
  "explained", "news", "recap"];
const IS_MUSIC = ["official video", "official audio", "official music video", "lyric video",
  "audio oficial", "קליפ", "רשמי", "שיר"];

// A suggested "song" occasionally matches something that is not a song at all - a sketch,
// a recording of a ceremony, whatever the closest title on YouTube happens to be.
function looksLikeMusic(track) {
  if (!track) return false;
  const artist = normMatch(track.artist);
  if (/ topic$/.test(artist) || /vevo/.test(artist)) return true;
  const hay = normMatch(track.title) + " " + artist;
  const raw = String(track.title || "") + " " + String(track.artist || "");
  for (const word of NOT_MUSIC) {
    if (hay.indexOf(normMatch(word)) !== -1 || raw.indexOf(word) !== -1) return false;
  }
  for (const word of IS_MUSIC) {
    if (hay.indexOf(normMatch(word)) !== -1 || raw.indexOf(word) !== -1) return true;
  }
  const secs = track.duration || 0;
  return secs >= 75 && secs <= 600;
}

// ---------------- the AI call ----------------

const JSON_SHAPE = 'Reply with only a JSON object shaped exactly like this, nothing else: ' +
  '{"name": "playlist name", "tracks": [{"title": "song title", "artist": "artist name"}]}.';

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING", description: "A short, catchy playlist name, 3-6 words" },
    tracks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { title: { type: "STRING" }, artist: { type: "STRING" } },
        required: ["title", "artist"]
      }
    }
  },
  required: ["name", "tracks"]
};

// A key that just hit its quota is worth skipping for a while rather than asking it again
// on the next listener in the same run.
const failedAt = new Map();
const KEY_COOLDOWN_MS = 30 * 60 * 1000;
function liveKeys(provider) {
  const live = provider.keys.filter(k => {
    const at = failedAt.get(provider.name + "|" + k);
    return !at || Date.now() - at > KEY_COOLDOWN_MS;
  });
  return live.length ? live : provider.keys;
}

async function postJson(url, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    // Keep the deadline active until the response body has arrived as well.
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
  } finally { clearTimeout(timer); }
}

async function callGemini(key, provider, prompt) {
  const model = provider.model;
  const send = candidate => postJson(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(candidate) +
      ":generateContent?key=" + encodeURIComponent(key),
    { "Content-Type": "application/json" },
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA }
    }
  );
  let res = await send(model);
  // A retired or momentarily unavailable model hands the request to the rolling alias,
  // so a sunset degrades into a quiet handoff instead of a wall of 404s.
  if ((res.status >= 500 || res.status === 404) && provider.fallbackModel && provider.fallbackModel !== model) {
    res = await send(provider.fallbackModel);
  }
  if (res.status === 400 || res.status === 403 || res.status === 429) {
    throw Object.assign(new Error("gemini rejected the key (HTTP " + res.status + ")"), { keyBad: true });
  }
  if (!res.ok) throw new Error("gemini HTTP " + res.status);
  const data = await res.json();
  const text = ((((data.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error("gemini returned nothing usable");
  return text;
}

async function callGroq(key, model, prompt) {
  const res = await postJson(
    "https://api.groq.com/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    { model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }
  );
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw Object.assign(new Error("groq rejected the key (HTTP " + res.status + ")"), { keyBad: true });
  }
  if (!res.ok) throw new Error("groq HTTP " + res.status);
  const data = await res.json();
  const text = ((((data.choices || [])[0] || {}).message || {}).content || "");
  if (!text) throw new Error("groq returned nothing usable");
  return text;
}

function hasSharedKey() { return SHARED_PROVIDERS.some(p => p.keys.length); }
function canBuildFor(key) { return providersFor(key).providers.some(p => p.keys.length); }

// Every live key across both providers, Gemini first, so a request falls through to Groq
// only once every Gemini key has actually failed.
async function askForSongs(prompt, providers) {
  let lastErr = null;
  for (const provider of providers) {
    for (const key of liveKeys(provider)) {
      try {
        const text = provider.name === "gemini"
          ? await callGemini(key, provider, prompt)
          : await callGroq(key, provider.model, prompt);
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        if (e && e.keyBad) failedAt.set(provider.name + "|" + key, Date.now());
        console.log(provider.name + " key ..." + key.slice(-4) + " failed: " + String((e && e.message) || e).slice(0, 80));
      }
    }
  }
  throw lastErr || new Error("no AI key answered");
}

// ---------------- building one listener's mix ----------------

const builds = new Map();
function buildMix(key) {
  if (builds.has(key)) return builds.get(key);
  const request = buildMixOnce(key);
  builds.set(key, request);
  const done = () => { if (builds.get(key) === request) builds.delete(key); };
  request.then(done, done);
  return request;
}

async function buildMixOnce(key) {
  const account = readAccount(key);
  if (!account) throw new Error("nothing synced for this account yet");
  const history = historyContext(account);
  if (!history) throw new Error("nothing listened to yet to build a taste profile from");
  const { providers, mine } = providersFor(key);
  if (!providers.some(p => p.keys.length)) throw new Error("no AI key for this account");

  const blocked = blockedOf(account);
  const instruction = "You are a music curator for a specific listener. " +
    "What they've been listening to: " + history + " " +
    "This is their request: \"Suggest a well-rounded mix of real songs this listener would enjoy right now. " +
    "Base it only on their own listening history below - do not default to any particular genre, " +
    "language or country unless their history itself points that way.\". " +
    "Suggest around " + MIX_SONGS + " real, existing songs. Get the artist right for each song. " +
    "The request sets the subject, while the listening history sets the SOUND: work out the style, language and " +
    "scene those most-played artists share, and stay inside that world. Every pick should feel like the next song " +
    "someone who listens to them all day would hear, not a famous track from some other style. " +
    (blocked.labels.length ? "Never suggest any of these songs or artists: " + blocked.labels.join("; ") + ". " : "") +
    "Within that world, mixing better-known songs with deeper cuts is welcome; avoid duplicates, and do not repeat " +
    "the same artist too often. " + JSON_SHAPE;

  const parsed = await askForSongs(instruction, providers);
  const suggestions = (Array.isArray(parsed.tracks) ? parsed.tracks : [])
    .map(t => ({ title: String((t && t.title) || "").trim(), artist: String((t && t.artist) || "").trim() }))
    .filter(t => t.title);
  if (!suggestions.length) throw new Error("no songs came back");

  const queue = suggestions.map((item, index) => ({ item, index }));
  const matches = new Array(queue.length);
  // Three at a time, the same as in the app: enough to keep the run short, few enough
  // that a self-hosted Invidious is not being asked to do thirty searches at once.
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      try {
        const t = await matchTrack(entry.item.title, entry.item.artist);
        if (t && looksLikeMusic(t) && !isBlocked(blocked, t)) matches[entry.index] = t;
      } catch (e) {}
    }
  }));

  const found = matches.filter(Boolean);
  if (!found.length) throw new Error("nothing matched");
  const known = knownArtists(account);
  const inWorld = found.filter(t => t.artist && known.has(foldText(t.artist)));
  // Below a handful the filter is doing more harm than good - a mix of four songs is
  // worse than one with a few unfamiliar names in it.
  const picked = inWorld.length >= 6 ? inWorld : found;

  const mix = {
    at: Date.now(),
    sig: signatureOf(account),
    name: String(parsed.name || "Picked for you today").trim().slice(0, 60) || "Picked for you today",
    tracks: picked
  };
  writeJson(mixFile(key), mix);
  console.log("built a mix for " + key + " with " + (mine ? "their own key" : "the shared key") + ": " +
    picked.length + " of " + suggestions.length + " suggestion(s) matched" +
    (picked.length < found.length ? ", " + (found.length - picked.length) + " outside this listener's world" : ""));
  return mix;
}

// ---------------- the nightly run ----------------

let running = false;

async function runAll(reason) {
  if (running) return;
  running = true;
  try { await runAccounts(reason); }
  finally { running = false; }
}

async function runAccounts(reason) {
  const started = Date.now();
  // Someone who has not handed a key over, on a server with no shared one either, is not
  // a failure to report every night - there is simply nothing to build for them.
  const accounts = listAccounts().filter(canBuildFor);
  let ok = 0;
  let failed = 0;
  console.log("nightly mix run started (" + reason + ") for " + accounts.length + " account(s) with a key");
  for (const key of accounts) {
    try { await buildMix(key); ok++; }
    catch (e) { failed++; console.log("mix for " + key + " failed: " + String((e && e.message) || e).slice(0, 100)); }
  }
  // The day is marked done even when parts of it failed: a provider that is down at 4am
  // is not a reason to keep retrying it all morning, and yesterday's mix is still there.
  // Recorded at the finish, as the app does: a timer that fires a few milliseconds ahead
  // of the wall clock would otherwise leave a start time older than the slot, and the next
  // restart that day would read the run as missed and repeat it.
  writeJson(stateFile, { at: Date.now(), ok, failed, reason, hour: MIX_HOUR });
  console.log("nightly mix run done in " + Math.round((Date.now() - started) / 1000) + "s - " +
    ok + " built" + (failed ? ", " + failed + " failed" : ""));
}

// Local time on purpose: MIX_HOUR means that hour where the server is, which is what TZ
// in the compose file is for.
function lastSlot(now) {
  const d = new Date(now);
  d.setHours(MIX_HOUR, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

// Rescheduled one slot at a time rather than set as a 24-hour interval, so a daylight
// saving change moves the run with the clock instead of leaving it an hour adrift, and a
// container that was down at 4am catches up on the next start instead of skipping a day.
function scheduleNext() {
  const now = Date.now();
  const slot = new Date(lastSlot(now));
  slot.setDate(slot.getDate() + 1);
  slot.setHours(MIX_HOUR, 0, 0, 0);
  const next = slot.getTime();
  const wait = Math.max(60 * 1000, next - now);
  setTimeout(() => {
    runAll("scheduled hour")
      .catch(e => console.log("run failed: " + e.message))
      .finally(scheduleNext);
  }, wait);
  console.log("next run at " + new Date(next).toString());
}

function catchUpOnBoot() {
  const state = readJson(stateFile, {});
  if (Number(state.at || 0) >= lastSlot(Date.now())) return;
  setTimeout(() => runAll("catching up after a restart").catch(e => console.log("run failed: " + e.message)), 30000);
}

// ---------------- HTTP ----------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limit) { reject(Object.assign(new Error("payload too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) { send(res, 400, { error: "bad request" }); return; }
  const route = url.pathname.replace(/\/+$/, "").replace(/^\/api\/mix/, "");

  const email = String(req.headers["x-forwarded-email"] || "").trim();
  if (!email) { send(res, 401, { error: "not authenticated" }); return; }
  let key;
  try { key = identityKey(email); }
  catch (e) { send(res, 400, { error: "unusable identity" }); return; }

  // What Settings needs to describe the state in a sentence: whether a key of this
  // person's own is held here, whether the house key would cover them anyway, and when
  // the mix on the server was built.
  function statusOf() {
    const own = readOwnKeys(key);
    return {
      hour: MIX_HOUR,
      ownKey: !!own,
      ownKeyAt: own ? own.at : 0,
      sharedKey: hasSharedKey(),
      enabled: canBuildFor(key)
    };
  }

  if (route === "" && req.method === "GET") {
    const mix = readMix(key);
    if (!mix) { send(res, 200, Object.assign({ available: false }, statusOf())); return; }
    send(res, 200, Object.assign({
      available: true,
      at: mix.at,
      sig: mix.sig || "",
      name: mix.name,
      tracks: mix.tracks
    }, statusOf()));
    return;
  }

  // Handing a key over is a deliberate act taken in Settings, one device at a time. It is
  // the only way a key ever leaves a device in this app, which is why it is its own route
  // rather than a field that rides along in the synced blob.
  if (route === "/key" && req.method === "POST") {
    readBody(req, 8 * 1024).then(raw => {
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch (e) { send(res, 400, { error: "bad json" }); return; }
      const list = v => (Array.isArray(v) ? v : []).filter(k => typeof k === "string" && k.trim())
        .map(k => k.trim()).slice(0, 10);
      const gemini = list(body && body.gemini);
      const groq = list(body && body.groq);
      if (!gemini.length && !groq.length) { send(res, 400, { error: "no key in the request" }); return; }
      writeJson(keysFile(key), {
        gemini, groq,
        mode: body && (body.mode === "gemini" || body.mode === "groq") ? body.mode : "both",
        geminiModel: String((body && body.geminiModel) || "").trim().slice(0, 80),
        groqModel: String((body && body.groqModel) || "").trim().slice(0, 80),
        at: Date.now()
      });
      console.log("stored an AI key for " + key);
      send(res, 200, Object.assign({ ok: true }, statusOf()));
    }).catch(e => send(res, e && e.code === 413 ? 413 : 400, { error: e.message || "bad request" }));
    return;
  }

  // Taking it back takes the mix with it: it was built with a key that is being withdrawn,
  // and nothing here can refresh it afterwards.
  if (route === "/key" && req.method === "DELETE") {
    forgetOwnKeys(key);
    try { fs.unlinkSync(mixFile(key)); } catch (e) {}
    console.log("forgot the AI key for " + key);
    send(res, 200, Object.assign({ ok: true }, statusOf()));
    return;
  }

  if (route === "/rebuild" && req.method === "POST") {
    if (!canBuildFor(key)) { send(res, 503, { error: "no AI key for this account on the server" }); return; }
    const existing = readMix(key);
    if (existing && Date.now() - Number(existing.at || 0) < REBUILD_COOLDOWN_MS) {
      send(res, 429, { error: "just built - try again in a few minutes", at: existing.at });
      return;
    }
    buildMix(key).then(
      mix => send(res, 200, { available: true, at: mix.at, sig: mix.sig, name: mix.name, tracks: mix.tracks }),
      e => send(res, 500, { error: String((e && e.message) || e).slice(0, 120) })
    );
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  // The scheduler always starts now. Whether there is anything to build is decided per
  // person at run time, because someone can hand a key over from Settings at any point
  // after this container came up.
  console.log("aura-mix listening on " + PORT + ", building at " + MIX_HOUR + ":00 local time" +
    (hasSharedKey() ? " (a shared key is set)" : " (no shared key - each listener supplies their own from Settings)"));
  catchUpOnBoot();
  scheduleNext();
});
