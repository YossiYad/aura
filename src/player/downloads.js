(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    artIds: { get: () => artIds },
    deleteDownload: { get: () => deleteDownload },
    download: { get: () => download },
    downloadCounts: { get: () => downloadCounts },
    downloadProgress: { get: () => downloadProgress },
    downloadsBlockedByWifi: { get: () => downloadsBlockedByWifi },
    downloadStatus: { get: () => downloadStatus },
    getArt: { get: () => getArt },
    getDownload: { get: () => getDownload },
    objectStore: { get: () => objectStore },
    openDb: { get: () => openDb },
    queueDownloads: { get: () => queueDownloads },
    resumeDownloadQueue: { get: () => resumeDownloadQueue },
    wakeDownloadQueue: { get: () => wakeDownloadQueue }
  });

  let db = null;
  function openDb() {
    return new Promise((resolveP) => {
      if (db) return resolveP(db);
      let req;
      try {
        if (typeof indexedDB === "undefined") return resolveP(null);
        req = indexedDB.open("aura-downloads", 3);
      } catch (e) { return resolveP(null); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("tracks")) d.createObjectStore("tracks");
        if (!d.objectStoreNames.contains("cache")) d.createObjectStore("cache");
        // Cover art, kept beside the audio so a saved song still looks like a song with
        // no network to fetch its picture from.
        if (!d.objectStoreNames.contains("art")) d.createObjectStore("art");
      };
      req.onsuccess = () => {
        const d = req.result;
        // The browser can close the connection behind the page's back (storage torn
        // down while the app sat in the background, a schema upgrade in another tab).
        // A closed connection throws on its next transaction; forget it here so the
        // next call reopens instead of failing every track until a reload.
        d.onclose = () => { if (db === d) db = null; };
        d.onversionchange = () => { try { d.close(); } catch (e) {} if (db === d) db = null; };
        db = d;
        resolveP(db);
      };
      req.onerror = () => resolveP(null);
      req.onblocked = () => resolveP(null);
    });
  }
  // A transaction on a connection that is already closing throws synchronously. For the
  // playback reads that is "nothing stored here", not a failed track.
  function objectStore(d, name, mode) {
    try { return d.transaction(name, mode).objectStore(name); }
    catch (e) { if (db === d) db = null; throw e; }
  }
  /**
   * @param {string} id
   * @returns {Promise<Blob | null>} The saved file, or null when there is none or it cannot be read.
   */
  async function getDownload(id) {
    const d = await openDb();
    if (!d) return null;
    const stored = await new Promise((res) => {
      let tx;
      try { tx = objectStore(d, "tracks", "readonly").get(id); } catch (e) { return res(null); }
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => res(null);
    });
    if (!stored) return null;
    const usable = await V.materializeBlob(stored);
    if (usable) return usable;
    // A saved song stays saved: refusing to hand out a dead reference lets playback
    // fall back to the cache or the stream, while removing a download remains the
    // job of the explicit delete paths.
    V.log("download", id + " saved file is unreadable right now; playing another source");
    return null;
  }
  /**
   * @param {string} id
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  async function putDownload(id, blob) {
    const d = await openDb();
    if (!d) throw new Error("IndexedDB unavailable");
    return new Promise((res, rej) => {
      const tx = d.transaction("tracks", "readwrite");
      tx.objectStore("tracks").put(blob, id);
      // A successful put can still be rolled back when the transaction commits.
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("Download storage aborted"));
    });
  }
  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteDownload(id) {
    const d = await openDb();
    if (!d) throw new Error("IndexedDB unavailable");
    await new Promise((res, rej) => {
      const tx = d.transaction("tracks", "readwrite");
      tx.objectStore("tracks").delete(id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("Download deletion aborted"));
    });
    downloadState.delete(id);
    downloadTries.delete(id);
    dlProgress.delete(id);
    if (Store.forgetDownload) Store.forgetDownload(id);
    await deleteArt(id);
    V.emit({ type: "downloads" });
  }
  /**
   * @param {string} id
   * @returns {Promise<Blob | null>} Cover art saved with a download.
   */
  async function getArt(id) {
    const d = await openDb();
    if (!d || !d.objectStoreNames.contains("art")) return null;
    return new Promise(res => {
      let tx;
      try { tx = objectStore(d, "art", "readonly").get(id); } catch (e) { return res(null); }
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => res(null);
    });
  }

  async function putArt(id, blob) {
    const d = await openDb();
    if (!d || !d.objectStoreNames.contains("art")) return;
    return new Promise(res => {
      const tx = d.transaction("art", "readwrite").objectStore("art").put(blob, id);
      tx.onsuccess = () => res();
      tx.onerror = () => res();
    });
  }

  async function deleteArt(id) {
    const d = await openDb();
    if (!d || !d.objectStoreNames.contains("art")) return;
    return new Promise(res => {
      const tx = d.transaction("art", "readwrite").objectStore("art").delete(id);
      tx.onsuccess = () => res();
      tx.onerror = () => res();
    });
  }

  /**
   * @returns {Promise<Set<string>>} Ids of tracks with cover art saved.
   */
  async function artIds() {
    const d = await openDb();
    const out = new Set();
    if (!d || !d.objectStoreNames.contains("art")) return out;
    return new Promise(res => {
      const g = d.transaction("art", "readonly").objectStore("art").getAllKeys();
      g.onsuccess = () => { (g.result || []).forEach(k => out.add(k)); res(out); };
      g.onerror = () => res(out);
    });
  }

  // A saved song should behave like a song with signal: its picture and its words come
  // down with the audio, so nothing has to be fetched later to make it look complete.
  async function saveExtras(track) {
    if (!track || !track.id) return;
    if (!(await getArt(track.id))) {
      const url = track.thumb || (window.Api && Api.thumbFor ? Api.thumbFor(track.id) : "");
      if (url) {
        try {
          await putArt(track.id, await Api.fetchImageBlob(url));
          V.log("download", track.id + " artwork saved");
        } catch (e) { V.log("download", track.id + " artwork unavailable"); }
      }
    }
    if (Store.cachedLyrics && Store.cachedLyrics(track.id)) return;
    try {
      const data = await Api.getLyrics(track);
      Store.cacheLyrics(track.id, data || { none: true });
      V.log("download", track.id + " lyrics saved");
    } catch (e) {
      // A lookup that failed - offline, rate limited - is left uncached, so the next
      // online attempt tries again. Only a clean miss is recorded as "none".
      V.log("download", track.id + " lyrics lookup failed, will retry when online");
    }
  }

  /**
   * Saves a track's audio to the device, then its art and lyrics in the background.
   * @param {Track} track
   * @returns {Promise<void>}
   */
  async function download(track) {
    const blob = await Api.fetchStreamBlob(track.id, 0, (got, total) => {
      dlProgress.set(track.id, { got, total });
      // Throttled: a chunk arrives many times a second and each emit repaints rows.
      if (Date.now() - lastProgressEmit < 500) return;
      lastProgressEmit = Date.now();
      V.emit({ type: "downloads" });
    }, { receiverCompatible: typeof V.audio.webkitShowPlaybackTargetPicker === "function" });
    dlProgress.delete(track.id);
    await putDownload(track.id, blob);
    // Remember what it was, not just that it exists. Without this a song saved straight
    // from search is a nameless blob: on the device, and unfindable. A record that
    // cannot be written takes the blob with it, or the blob sits there unlisted with
    // no way to see or remove it.
    try {
      if (Store.rememberDownload) Store.rememberDownload(track);
    } catch (e) {
      await deleteDownload(track.id).catch(() => {});
      throw e;
    }
    // Art and lyrics follow on their own: the song is saved already, and waiting for
    // them kept it "busy" and on the persisted queue, to be fetched again after a kill.
    saveExtras(track).catch(() => {});
    keepStorage();
  }

  // Asked once there is something worth keeping. Storage that is not marked persistent
  // is the browser's to clear when the device runs short of space - the saved songs,
  // and the installed app with them, which is what offline rests on.
  let storageKeepAsked = false;
  function keepStorage() {
    if (storageKeepAsked) return;
    storageKeepAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {}
  }

  // Downloads used to be one track at a time, awaited from the sheet the user tapped, with
  // a failure collapsing into a toast they could not act on. A queue lets a whole album go
  // at once and keeps a failed track visible so it can be retried.
  const downloadQueue = [];
  const downloadState = new Map();
  let downloadRunning = false;
  const downloadTries = new Map();
  const dlProgress = new Map();
  let inFlight = null;
  let lastProgressEmit = 0;

  // With an id, that track's progress; without one, whatever is being fetched right now.
  /**
   * @param {string} [id] Default: the download running now.
   * @returns {{ got: number, total: number } | null} Bytes; `total` is 0 when unknown.
   */
  function downloadProgress(id) {
    if (id) return dlProgress.get(id) || null;
    return inFlight ? (dlProgress.get(inFlight.id) || null) : null;
  }

  // The queue lived only in memory, so queueing an album and switching apps - which on a
  // phone is what always happens next - lost everything still waiting, silently. It is
  // written down and picked back up on the next launch.
  function saveDownloadQueue() {
    try {
      // The one being fetched stays on the list until it is actually saved, so a phone
      // killed mid-download picks that track up again rather than dropping it.
      const pending = (inFlight ? [inFlight] : []).concat(downloadQueue)
        .map(t => ({ id: t.id, title: t.title, artist: t.artist,
        album: t.album || "", thumb: t.thumb || "", duration: t.duration || 0,
        artistId: t.artistId || null, artistThumb: t.artistThumb || "",
        artistVerified: t.artistVerified === true, kind: t.kind, podcast: t.podcast || "" }));
      localStorage.setItem("aura.downloadQueue", JSON.stringify(pending));
    } catch (e) {}
  }

  let downloadQueueResumed = false;
  function resumeDownloadQueue() {
    if (downloadQueueResumed) return;
    downloadQueueResumed = true;
    let pending = [];
    try { pending = JSON.parse(localStorage.getItem("aura.downloadQueue") || "[]"); } catch (e) {}
    if (!Array.isArray(pending) || !pending.length) return;
    V.log("download", "picking up " + pending.length + " unfinished download" + (pending.length === 1 ? "" : "s"));
    queueDownloads(pending);
  }

  /**
   * @param {string} id
   * @returns {"pending" | "busy" | "done" | "failed" | null}
   */
  function downloadStatus(id) { return downloadState.get(id) || null; }

  /**
   * @returns {{ working: number, failed: number }}
   */
  function downloadCounts() {
    let working = 0, failed = 0;
    downloadState.forEach(v => {
      if (v === "pending" || v === "busy") working++;
      else if (v === "failed") failed++;
    });
    return { working, failed };
  }

  /**
   * Adds tracks to the download queue, skipping ones already saved or queued.
   * @param {Track[]} tracks
   * @returns {number} How many were added.
   */
  function queueDownloads(tracks) {
    // Whatever the last session left unfinished goes first, and the list written
    // below must include it: writing only the new track threw the rest away.
    if (!downloadQueueResumed) resumeDownloadQueue();
    const saved = Store.downloadedTracks ? new Set(Store.downloadedTracks().map(t => t.id)) : new Set();
    let added = 0;
    for (const t of tracks || []) {
      if (!t || !t.id) continue;
      const at = downloadState.get(t.id);
      if (at === "pending" || at === "busy" || at === "done") continue;
      // Already on the device from an earlier session: "Download all" is one action,
      // not a fresh copy of every song in the list.
      if (at !== "failed" && saved.has(t.id)) continue;
      downloadTries.delete(t.id);
      downloadState.set(t.id, "pending");
      downloadQueue.push(t);
      added++;
    }
    if (added) { saveDownloadQueue(); V.emit({ type: "downloads" }); runDownloads(); }
    return added;
  }

  // Metered is only claimed on positive evidence - Data Saver, or a connection the
  // browser actually reports as cellular. Browsers that expose nothing at all stay
  // trusted, because blocking every download on them would be worse than the risk.
  function meteredConnection() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return false;
    if (c.saveData) return true;
    return c.type === "cellular";
  }

  /**
   * @returns {boolean} True when downloads wait for Wi-Fi.
   */
  function downloadsBlockedByWifi() {
    return !!(window.Store && Store.settings().wifiOnlyDownloads && meteredConnection());
  }

  let wifiResumeFn = null;

  function waitForWifi() {
    return new Promise(res => { wifiResumeFn = res; });
  }

  function wakeDownloadQueue() {
    if (wifiResumeFn && navigator.onLine !== false && !downloadsBlockedByWifi()) {
      const fn = wifiResumeFn;
      wifiResumeFn = null;
      fn();
    }
  }

  async function runDownloads() {
    if (downloadRunning) return;
    downloadRunning = true;
    while (downloadQueue.length) {
      if (navigator.onLine === false || downloadsBlockedByWifi()) {
        V.log("download", downloadQueue.length + " waiting for a permitted connection");
        V.emit({ type: "downloads" });
        await waitForWifi();
        continue;
      }
      const t = downloadQueue.shift();
      inFlight = t;
      saveDownloadQueue();
      downloadState.set(t.id, "busy");
      V.emit({ type: "downloads" });
      try {
        await download(t);
        downloadState.set(t.id, "done");
        V.log("download", t.id + " saved");
      } catch (e) {
        // One source failing is not the same as the song being unavailable, and the
        // fetcher has already tried every source once. A single second attempt, at the
        // back of the queue, covers the blip without grinding on a dead track.
        const tries = (downloadTries.get(t.id) || 0) + 1;
        downloadTries.set(t.id, tries);
        V.log("download", t.id + " failed (try " + tries + "): " + String((e && e.message) || e).slice(0, 60));
        // Read afresh: the connection can drop while the download runs.
        if (/** @type {boolean} */ (navigator.onLine) === false) {
          downloadTries.delete(t.id);
          downloadState.set(t.id, "pending");
          downloadQueue.unshift(t);
        } else if (tries < 2) {
          downloadState.set(t.id, "pending");
          downloadQueue.push(t);
          saveDownloadQueue();
        } else {
          downloadState.set(t.id, "failed");
        }
      }
      dlProgress.delete(t.id);
      inFlight = null;
      saveDownloadQueue();
      V.emit({ type: "downloads" });
    }
    downloadRunning = false;
  }
})();
