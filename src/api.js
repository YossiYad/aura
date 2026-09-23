// Types for what the Api module returns. Declared outside the closure so the editor sees
// them from any file; comments only, nothing at runtime.

/** @typedef {"piped" | "invidious" | "cobalt"} SourceKind */

/**
 * A playable address for a track, from whichever server answered first.
 * @typedef {Object} StreamInfo
 * @property {string} url
 * @property {string} [mime] Missing for cobalt streams.
 * @property {number} [duration] Seconds, when the server reports it.
 * @property {number} at When it was resolved, in ms.
 * @property {number} [expiresAt] When a private media ticket stops working, in ms.
 * @property {string} base The server it came from.
 * @property {SourceKind} kind
 * @property {Track[]} related Related uploads, used for radio.
 * @property {number | null} [loudnessDb] The upload's loudness from the server, for normalizing.
 */

/**
 * @typedef {Object} ResolveOptions
 * @property {"best" | "normal" | "data"} [quality] Defaults to the audio quality setting.
 * @property {boolean} [remote] Pick a format an AirPlay or Cast receiver can play.
 * @property {boolean} [receiverCompatible] Same as `remote`.
 * @property {Set<string>} [avoid] Servers to leave out; bypasses the cache.
 */

/**
 * @typedef {Object} ArtistSummary
 * @property {string} id Channel id.
 * @property {string} name
 * @property {string} thumb
 * @property {number} subscribers
 * @property {boolean} verified
 */

/**
 * @typedef {Object} PlaylistSummary
 * @property {string} id YouTube list id.
 * @property {string} name
 * @property {string} thumb
 * @property {number} [count]
 */

/**
 * One page of search results. Pass it back to Api.searchMore for the next page.
 * @typedef {Object} SearchPage
 * @property {Track[]} items
 * @property {string} [source] Which server or servers answered, for display.
 * @property {SourceKind | "proxy"} kind
 * @property {string} [base]
 * @property {string} [filter]
 * @property {number} [page]
 * @property {string | null} nextpage Null when there are no more pages.
 * @property {ArtistSummary[]} [artists] Channels matching the query, on the first page.
 */

/**
 * Where the next page of an artist's uploads comes from. Pass it to Api.artistMore.
 * @typedef {Object} ArtistPageCursor
 * @property {SourceKind} kind
 * @property {string} base
 * @property {string} channelId
 * @property {string | null} nextpage
 */

/**
 * @typedef {Object} ArtistPage
 * @property {string} id Channel id.
 * @property {string} name
 * @property {string} thumb
 * @property {string} [banner]
 * @property {number} [subscribers]
 * @property {Track[]} videos
 * @property {ArtistPageCursor | null} [songPage]
 * @property {PlaylistSummary[]} albums
 * @property {PlaylistSummary[]} playlists
 */

/**
 * A playlist read from a link. `match` is set when the source already names the upload.
 * @typedef {Object} ImportedPlaylist
 * @property {string} name
 * @property {{ title: string, artist: string, match?: Track }[]} tracks
 */

(function () {
  // The network layer is one module in several files: this one holds what every request
  // shares (the server lists, fetch with a deadline, cooldowns for servers that just failed,
  // the first-answer race), and src/api/ holds one file per job - normalizing results,
  // searching, artist and playlist pages, relays, playlist import, matching, telling music
  // from talk, streams, downloads, skip segments and lyrics - loaded after it in the order
  // index.html lists them. Each file is its own closure and reaches the others through V,
  // window.Aura.api, where each file publishes, at its top, the names the others use.
  // Nothing outside the module uses V; the public face is window.Api, put together in
  // src/api/public.js.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).api = {};
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    absoluteUrl: { get: () => absoluteUrl },
    channelIdFromUrl: { get: () => channelIdFromUrl },
    CORS_PROXIES: { get: () => CORS_PROXIES },
    dedup: { get: () => dedup },
    DEFAULT_COBALT: { get: () => DEFAULT_COBALT },
    DEFAULT_INVIDIOUS: { get: () => DEFAULT_INVIDIOUS },
    DEFAULT_PIPED: { get: () => DEFAULT_PIPED },
    fetchJson: { get: () => fetchJson },
    fetchText: { get: () => fetchText },
    host: { get: () => host },
    instances: { get: () => instances },
    largestImage: { get: () => largestImage },
    liveOnly: { get: () => liveOnly },
    log: { get: () => log },
    markBad: { get: () => markBad },
    markGood: { get: () => markGood },
    prioritize: { get: () => prioritize },
    raceOk: { get: () => raceOk },
    shouldCooldownStream: { get: () => shouldCooldownStream },
    siteConfig: { get: () => siteConfig },
    STREAM_TTL: { get: () => STREAM_TTL },
    streamCache: { get: () => streamCache },
    TEXT_PROXIES: { get: () => TEXT_PROXIES },
    VERIFY_AFTER: { get: () => VERIFY_AFTER },
    videoIdFromUrl: { get: () => videoIdFromUrl },
    withLastGood: { get: () => withLastGood }
  });

  const DEFAULT_PIPED = [];
  const DEFAULT_INVIDIOUS = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://iv.duti.dev"
  ];
  const DEFAULT_COBALT = [
    "https://co.eepy.today",
    "https://dwnld.nichind.dev",
    "https://co.otomir23.me"
  ];
  const CORS_PROXIES = [
    u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    u => "https://corsproxy.io/?url=" + encodeURIComponent(u)
  ];
  // Reading a page - a Spotify or Apple Music playlist - is not the same job as pulling a
  // stream. It is small, it is one-off, and it is worth trying more relays before giving
  // up, because the site behind them refuses anonymous readers often enough that a two
  // entry list runs out and the whole import fails with a bare "HTTP 403".
  const TEXT_PROXIES = CORS_PROXIES.concat([
    u => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
    u => "https://api.cors.lol/?url=" + encodeURIComponent(u),
    u => "https://r.jina.ai/" + u
  ]);

  function log(tag, msg) { if (window.Log) Log.add(tag, msg); }
  function host(u) { try { return new URL(u).host; } catch (e) { return String(u).slice(0, 40); } }

  const streamCache = new Map();
  const STREAM_TTL = 45 * 60 * 1000;
  const VERIFY_AFTER = 10 * 60 * 1000;
  const LIVE_TTL = 24 * 60 * 60 * 1000;
  const LIVE_EMPTY_RETRY = 60 * 1000;
  let livePromise = null;

  /**
   * @param {string} url
   * @param {number} [timeoutMs] Default 8 seconds.
   * @returns {Promise<any>}
   * @throws {Error} With a `status` property on an HTTP error.
   */
  async function fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * @param {string} url
   * @param {number} [timeoutMs] Default 12 seconds.
   * @returns {Promise<string>}
   */
  async function fetchText(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 12000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * The public Invidious directory, cached for a day.
   * @returns {Promise<{ at: number, invidious: string[] }>}
   */
  async function fetchLive() {
    try {
      const raw = localStorage.getItem("aura.liveInstances");
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.at < LIVE_TTL) return cached;
      }
    } catch (e) {}
    const out = { at: Date.now(), invidious: [] };
    try {
      const list = await fetchJson("https://api.invidious.io/instances.json?sort_by=health", 6000);
      out.invidious = (list || [])
        .filter(x => x[1] && x[1].type === "https" && x[1].api !== false && x[1].cors !== false)
        .map(x => (x[1].uri || "").replace(/\/+$/, ""))
        .filter(x => /^https:\/\//.test(x));
    } catch (e) {}
    if (out.invidious.length) {
      try { localStorage.setItem("aura.liveInstances", JSON.stringify(out)); } catch (e) {}
    }
    return out;
  }

  function dedup(arr) { return Array.from(new Set(arr)); }

  let siteConfigPromise = null;
  /**
   * The optional config.json served next to the app, read once.
   * @returns {Promise<Object>} An empty object when the host has none.
   */
  function siteConfig() {
    if (!siteConfigPromise) {
      siteConfigPromise = fetchJson("config.json", 4000)
        .then(c => {
          if (!c || typeof c !== "object") return {};
          log("config", "loaded config.json from this host");
          return c;
        })
        .catch(error => {
          // A missing file, or a static host answering with its fallback page, is a host
          // with no config: keep that answer. Anything else may be the network, so ask again.
          if (error.status !== 404 && !(error instanceof SyntaxError)) siteConfigPromise = null;
          return {};
        });
    }
    return siteConfigPromise;
  }

  /**
   * @param {Object} cfg
   * @param {string} key
   * @returns {string[]} The http(s) URLs under that key, without trailing slashes.
   */
  function cfgList(cfg, key) {
    return (Array.isArray(cfg[key]) ? cfg[key] : [])
      .map(x => String(x).trim().replace(/\/+$/, ""))
      .filter(x => /^https?:\/\//.test(x));
  }

  /**
   * The servers to ask, from config.json or the built-in and public lists.
   * @returns {Promise<{ trustedCobalt: string[], piped: string[], invidious: string[], cobalt: string[], lastGood: string | null }>}
   */
  async function instances() {
    const cfg = await siteConfig();
    const s = window.Store ? Store.settings() : {};
    const configuredInvidious = cfgList(cfg, "invidiousInstances");
    const configuredPiped = cfgList(cfg, "pipedInstances");
    let live = { invidious: [] };
    if (!configuredInvidious.length) {
      if (!livePromise) livePromise = fetchLive();
      try { live = await livePromise; } catch (e) { live = { at: 0, invidious: [] }; }
      // A list fetched while offline, or while the directory was down, is empty. Keeping
      // that for the whole page lifetime leaves every search and resolve on the built-in
      // defaults long after the network is back; ask again after a minute, when online.
      if (!live.invidious.length && navigator.onLine !== false && Date.now() - (live.at || 0) > LIVE_EMPTY_RETRY) {
        livePromise = null;
      }
    }
    const trustedCobalt = cfgList(cfg, "cobaltInstances");
    const hasConfiguredSources = configuredInvidious.length || configuredPiped.length || trustedCobalt.length;
    return {
      trustedCobalt,
      piped: configuredPiped.slice(0, 20),
      invidious: (configuredInvidious.length ? configuredInvidious : dedup(DEFAULT_INVIDIOUS.concat(live.invidious))).slice(0, 15),
      cobalt: hasConfiguredSources ? [] : DEFAULT_COBALT.slice(0, 8),
      lastGood: s.lastGoodInstance || null
    };
  }

  const failedAt = new Map();
  const FAIL_COOLDOWN = 10 * 60 * 1000;

  /**
   * @param {string[]} list
   * @param {string} kind "search" or "stream".
   * @returns {string[]} The servers not cooling off after a recent failure.
   */
  function liveOnly(list, kind) {
    if (list.length <= 1) return list.slice();
    return list.filter(b => {
      const at = failedAt.get(kind + "|" + b);
      return !at || Date.now() - at > FAIL_COOLDOWN;
    });
  }

  /**
   * @param {string[]} out
   * @param {string | null} lastGood
   * @returns {string[]} The list with the last server that answered moved to the front.
   */
  function withLastGood(out, lastGood) {
    if (lastGood && out.includes(lastGood)) {
      return [lastGood].concat(out.filter(x => x !== lastGood));
    }
    return out;
  }

  /**
   * @param {string[]} list
   * @param {string | null} lastGood
   * @param {string} kind "search" or "stream".
   * @returns {string[]}
   */
  function prioritize(list, lastGood, kind) {
    let out = liveOnly(list, kind);
    if (!out.length) out = list;
    return withLastGood(out, lastGood);
  }

  function markBad(base, kind) { failedAt.set(kind + "|" + base, Date.now()); }
  function markGood(base) {
    if (window.Store) Store.rememberInstance(base);
  }

  // The server broke, rather than this video being unplayable. Any 5xx counts: a server
  // that answers with its own error has told us nothing about the video, and asking it
  // about a different one gets the same answer just as fast.
  /**
   * @param {*} error
   * @returns {boolean} True when the server failed, rather than the video being unplayable.
   */
  function shouldCooldownStream(error) {
    const message = String((error && (error.message || error)) || "");
    return /abort|timeout|timed out|network|fetch|load failed|HTTP 5\d\d/i.test(message);
  }

  /**
   * Settles with the first task that fulfills with a truthy value.
   * @template T
   * @param {Promise<T>[]} tasks
   * @returns {Promise<T>} Rejects with the last error when every task fails or comes back empty.
   */
  function raceOk(tasks) {
    return new Promise((res, rej) => {
      let left = tasks.length;
      let lastErr = null;
      let done = false;
      if (!left) return rej(new Error("nothing to try"));
      tasks.forEach(p => {
        p.then(v => {
          if (!done && v) { done = true; res(v); }
          else if (--left === 0 && !done) rej(lastErr || new Error("all empty"));
        }).catch(e => {
          lastErr = e;
          if (--left === 0 && !done) rej(lastErr);
        });
      });
    });
  }

  function videoIdFromUrl(u) {
    const m = /v=([\w-]{11})/.exec(u || "");
    return m ? m[1] : null;
  }

  function channelIdFromUrl(u) {
    const m = /\/(?:channel|c)\/([^/?#]+)/.exec(u || "");
    return m ? m[1] : null;
  }

  function absoluteUrl(u, base) {
    if (!u) return "";
    try { return new URL(u, base + "/").toString(); } catch (e) { return u; }
  }

  function largestImage(images, base) {
    const list = (images || []).filter(x => x && x.url);
    if (!list.length) return "";
    const best = list.slice().sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    return absoluteUrl(best.url, base);
  }
})();
