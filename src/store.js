// Types shared by every module. Declared outside the module's closure so the editor sees
// them from any file in the project; they are comments only and do nothing at runtime.

/** @typedef {"music" | "podcast"} MediaKind */

/**
 * Which items a list should hold: one kind, or everything when "all" or left out.
 * @typedef {MediaKind | "all" | undefined} MediaFilter
 */

/**
 * A playable item: a YouTube video id and what is shown for it. Search results, the
 * library, history, downloads and the queue all carry this shape.
 * @typedef {Object} Track
 * @property {string} id YouTube video id.
 * @property {string} title
 * @property {string} artist Uploader or channel name.
 * @property {string} [album]
 * @property {number} [duration] Length in seconds; 0 when unknown.
 * @property {string} [thumb] Cover art URL.
 * @property {boolean} [live] A live stream or an upcoming premiere.
 * @property {number} [published] Upload time in ms since the epoch; 0 when unknown.
 * @property {number | null} [views]
 * @property {string | null} [artistId] YouTube channel id of the uploader.
 * @property {boolean} [artistVerified]
 * @property {string} [artistThumb]
 * @property {MediaKind} [kind] Missing on records written before it existed; see Store.mediaKind.
 * @property {string} [podcast] Show name when `kind` is "podcast".
 * @property {number} [addedAt] When it entered the library, in ms.
 * @property {number} [at] When it was played (history) or downloaded, in ms.
 * @property {number} [plays] Play count, on tracks from Store.topListeningTracks.
 * @property {number} [lastPlayed] Last play in ms, on tracks from Store.topListeningTracks.
 * @property {boolean} [auraShareAuto] A queue entry Aura added to fill an AuraShare session.
 */

/**
 * @typedef {Object} Playlist
 * @property {string} id Local id, "pl_..." for playlists made on this device.
 * @property {string} name
 * @property {string[]} ids Track ids in play order; each one is looked up in the library.
 * @property {number} [createdAt]
 * @property {string} [cover] A small square picture as a data URL.
 * @property {string} [sharedId] The copy of this playlist on the sync server, if any.
 */

/**
 * An artist or podcast channel followed for new-release alerts.
 * @typedef {Object} Follow
 * @property {string} id YouTube channel id.
 * @property {string} name
 * @property {string} thumb
 * @property {"artist" | "podcast"} kind
 * @property {number} followedAt
 * @property {string | null} latestId Newest upload the last check found.
 * @property {string | null} lastSeenId Newest upload the listener has looked at.
 * @property {number} checkedAt When the channel was last checked; 0 before the first check.
 */

/**
 * @typedef {Object} PodcastShow
 * @property {string} name
 * @property {string} channel Name of the channel that publishes it, once known.
 * @property {string} channelId Id of that channel, once known.
 */

/**
 * @typedef {Object} BlockedTrack
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string} thumb
 */

/**
 * @typedef {Object} BlockedList
 * @property {BlockedTrack[]} tracks
 * @property {string[]} artists Folded artist keys (lower case, without "- Topic" or "VEVO").
 */

/**
 * @typedef {Object} Settings
 * @property {boolean} autoplay
 * @property {"added" | "title" | "artist"} sort Library order.
 * @property {number} crossfade Seconds.
 * @property {boolean} normalize
 * @property {boolean} musicOnly
 * @property {boolean} skipSegments
 * @property {"best" | "normal" | "data"} audioQuality
 * @property {boolean} noYtFallback
 * @property {boolean} wifiOnlyDownloads
 * @property {string} accent
 * @property {"wave" | "line"} progressStyle
 * @property {boolean} animations
 * @property {boolean} rememberPosition
 * @property {number} cacheLimitMB
 * @property {boolean} notifyNewReleases
 * @property {number} playbackRate
 * @property {boolean} aiHomeSection
 * @property {boolean} nightlyPrebuild
 * @property {number} nightlyHour Local hour, 0-23.
 * @property {boolean} serverMixKey
 * @property {boolean} driveMode
 * @property {string} driveLook
 * @property {boolean} driveKeepAwake
 * @property {boolean} privateSession Whether the private session feature is shown at all.
 * @property {boolean} portraitLock
 * @property {"recent" | "name"} [librarySort] Order of the Library's collections.
 * @property {"list" | "grid"} [libraryLayout] How the Library lays them out.
 * @property {"en" | "he"} [interfaceLanguage] Unset until the listener picks; English until then.
 * @property {"default" | "large" | "larger"} [textSize] How much larger text is drawn.
 * @property {boolean} [highContrast] Brighter secondary text and stronger outlines.
 * @property {string} [voiceLanguage] Speech recognition language; follows the interface language until set.
 * @property {boolean} [voiceReply] Spoken answers; unset means on everywhere but iOS.
 * @property {string} [lastGoodInstance] Device-local hint: the server that answered last.
 */

/**
 * A lyrics record as lrclib returns it, or `{ none: true }` for a known miss.
 * @typedef {Object} LyricsEntry
 * @property {string} [syncedLyrics] LRC text, one "[mm:ss.xx] words" line per lyric line.
 * @property {string} [plainLyrics]
 * @property {number} [duration] Seconds.
 * @property {string} [artistName]
 * @property {string} [trackName]
 * @property {boolean} [none]
 */

/**
 * A stretch of a video that is not the song, from SponsorBlock.
 * @typedef {Object} SkipSegment
 * @property {number} start Seconds.
 * @property {number} end Seconds.
 * @property {string} category "sponsor", "intro", "outro" and so on.
 */

/** @typedef {"off" | "all" | "one"} RepeatMode */

/**
 * The play queue as it is persisted between launches.
 * @typedef {Object} SavedQueue
 * @property {Track[]} extra The queue itself.
 * @property {number} pos Index of the current track.
 * @property {boolean} shuffle
 * @property {RepeatMode} repeat
 * @property {number[]} shuffleOrder
 */

/**
 * What a Store listener is told has changed.
 * @typedef {"library" | "liked" | "playlists" | "recents" | "downloads" | "follows" |
 *   "blocked" | "positions" | "podcastShows" | "privateSession" | "searches" |
 *   "settings" | "queue" | "restore"} StoreChange
 */

/**
 * Puts back what the call that returned it removed, leaving later edits alone.
 * @typedef {() => void} Undo
 */

/**
 * The file written by Store.exportData and read by Store.importData.
 * @typedef {Object} AuraBackup
 * @property {"aura-backup"} format
 * @property {1} version
 * @property {string} exportedAt ISO date.
 * @property {Object} data Library, playlists, likes, history, settings and the rest.
 */

(function () {
  // Everything the app keeps is one module in several files: this one holds the records
  // themselves as they were loaded, reading and writing them, and telling listeners what
  // changed; src/store/ holds one file per kind of record - the library, playlists, what
  // was played, follows, backups, resume positions, the blocklist, cached lyrics and
  // segments, podcast shows, the private session, searches - loaded after it in the order
  // index.html lists them, and src/store/public.js puts window.Store together and makes
  // every write all-or-nothing. Each file is its own closure and reaches the others through
  // V, window.Aura.store, where each file publishes, at its top, the names the others use.
  // The records are published with a setter, because a write that fails reloads all of them.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).store = {};
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    defaultSettings: { get: () => defaultSettings },
    downloads: { get: () => downloads, set: value => { downloads = value; } },
    erase: { get: () => erase },
    follows: { get: () => follows, set: value => { follows = value; } },
    lastQueueNotice: { get: () => lastQueueNotice, set: value => { lastQueueNotice = value; } },
    library: { get: () => library, set: value => { library = value; } },
    liked: { get: () => liked, set: value => { liked = value; } },
    listeners: { get: () => listeners },
    listeningProfile: { get: () => listeningProfile, set: value => { listeningProfile = value; } },
    load: { get: () => load },
    loadList: { get: () => loadList },
    loadListeningProfile: { get: () => loadListeningProfile },
    loadMap: { get: () => loadMap },
    loadPlaylists: { get: () => loadPlaylists },
    loadPodcastShows: { get: () => loadPodcastShows },
    loadSettings: { get: () => loadSettings },
    notify: { get: () => notify },
    playlists: { get: () => playlists, set: value => { playlists = value; } },
    privateSession: { get: () => privateSession, set: value => { privateSession = value; } },
    recents: { get: () => recents, set: value => { recents = value; } },
    save: { get: () => save },
    searches: { get: () => searches, set: value => { searches = value; } },
    settings: { get: () => settings, set: value => { settings = value; } },
    transaction: { get: () => transaction, set: value => { transaction = value; } }
  });

  /**
   * Reads a JSON value from localStorage.
   * @param {string} key
   * @param {*} fallback Returned when the key is missing or unreadable.
   * @returns {any}
   */
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  let transaction = null;
  /**
   * Writes a JSON value, or stages it when a mutation is in progress.
   * @param {string} key
   * @param {*} val
   */
  function save(key, val) {
    const raw = JSON.stringify(val);
    if (transaction) { transaction.writes.set(key, raw); return; }
    localStorage.setItem(key, raw);
  }
  /**
   * @param {string} key
   */
  function erase(key) {
    if (transaction) transaction.writes.set(key, null);
    else localStorage.removeItem(key);
  }

  // True when this load continues a session that was already open - a reload - and false
  // when the app is being started fresh. A browser that will not give up sessionStorage at
  // all answers true: keeping a private session running one launch too long is the side of
  // that guess nobody gets hurt by.
  function sameAppSession() {
    try {
      const seen = sessionStorage.getItem("aura.appSession") === "1";
      sessionStorage.setItem("aura.appSession", "1");
      return seen;
    } catch (e) {
      return true;
    }
  }

  /** @type {Settings} */
  const defaultSettings = {
    autoplay: true, sort: "added", crossfade: 4,
    normalize: true, musicOnly: true, skipSegments: false,
    audioQuality: "best", noYtFallback: false, wifiOnlyDownloads: false,
    accent: "green", progressStyle: "wave", animations: true, rememberPosition: true, cacheLimitMB: 400,
    notifyNewReleases: true, playbackRate: 1, aiHomeSection: false,
    nightlyPrebuild: true, nightlyHour: 4, serverMixKey: true,
    driveMode: true, driveLook: "night", driveKeepAwake: true,
    privateSession: true, portraitLock: true
  };
  // Whatever is on disk is repaired once here, at the storage boundary, so that no reader
  // has to be defensive about it. The same repairs run again when a failed write rolls the
  // records back from storage: a tolerated malformed record must not become a throw then.
  function loadList(key) { const v = load(key, []); return Array.isArray(v) ? v : []; }
  function loadMap(key) { const v = load(key, {}); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  function loadSettings() { return Object.assign({}, defaultSettings, loadMap("aura.settings")); }
  // A partially written or hand-edited backup must not make every Library render and
  // removal path throw on p.ids. Keep usable playlists and repair their id lists.
  function loadPlaylists() {
    return loadList("aura.playlists")
      .filter(p => p && typeof p === "object" && p.id)
      .map(p => Object.assign({}, p, {
        id: String(p.id),
        name: String(p.name || "Playlist"),
        ids: Array.from(new Set((Array.isArray(p.ids) ? p.ids : []).filter(id => typeof id === "string" && id)))
      }));
  }
  function loadListeningProfile() {
    const profile = loadMap("aura.listeningProfile");
    if (!profile.tracks || typeof profile.tracks !== "object") profile.tracks = {};
    if (!profile.artists || typeof profile.artists !== "object") profile.artists = {};
    return profile;
  }
  function loadPodcastShows() {
    const shows = load("aura.podcastShows", null);
    return shows && typeof shows === "object" && Array.isArray(shows.shows) ? shows : { at: 0, lang: "", shows: [] };
  }
  let library = loadList("aura.library");
  let playlists = loadPlaylists();
  let liked = loadList("aura.liked");
  let recents = loadList("aura.recents");
  let searches = loadList("aura.searches");
  // What was downloaded, kept as its own record. Intersecting the files on disk with the
  // library used to hide anything saved straight from search - downloaded, on the phone,
  // and invisible on the flight it was downloaded for.
  let downloads = loadMap("aura.downloads");
  let listeningProfile = loadListeningProfile();
  // Artists and podcasts followed for new-release alerts. latestId is whatever the last
  // check found; lastSeenId is what the listener has actually looked at - the gap between
  // the two is the "new" dot on Home. Following seeds both to the same value, so a catalog
  // someone already had out does not read as new the moment it is followed.
  let follows = loadList("aura.follows");
  let settings = loadSettings();
  // A private session survives a reload but not a real exit. The app is reloaded all the
  // time - by the phone reclaiming memory as much as by anyone - and coming back recording
  // again, silently, is the one failure this mode cannot have. Coming back days later still
  // private is the other one: nobody re-checks a switch they never touched. sessionStorage
  // draws exactly that line - it lives through a reload of the same page and dies with the
  // app itself - so the mode ends when the app is really closed, when it is switched off,
  // and when hiding the feature switches it off.
  const resumedAppSession = sameAppSession();
  let privateSession = load("aura.privateSession", false) === true;
  if (privateSession && !resumedAppSession) {
    privateSession = false;
    save("aura.privateSession", false);
  }

  const listeners = [];
  let lastQueueNotice = 0;
  // Same reasoning as the player's emit: a listener that throws must not unwind into
  // whatever triggered the save.
  /**
   * @param {StoreChange} what
   */
  function notify(what) {
    if (transaction) { transaction.notices.add(what); return; }
    listeners.forEach(fn => {
      try { fn(what); }
      catch (e) { if (window.Log) Log.add("ui", "store listener failed on " + what + ": " + String((e && e.message) || e).slice(0, 120)); }
    });
  }
})();
