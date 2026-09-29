(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    artIds: { get: () => artIds },
    deleteDownload: { get: () => deleteDownload },
    download: { get: () => download },
    getArt: { get: () => getArt },
    getDownload: { get: () => getDownload },
    objectStore: { get: () => objectStore },
    openDb: { get: () => openDb }
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
    V.downloadState.delete(id);
    V.downloadTries.delete(id);
    V.dlProgress.delete(id);
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
      V.dlProgress.set(track.id, { got, total });
      // Throttled: a chunk arrives many times a second and each emit repaints rows.
      if (Date.now() - V.lastProgressEmit < 500) return;
      V.lastProgressEmit = Date.now();
      V.emit({ type: "downloads" });
    }, { receiverCompatible: typeof V.audio.webkitShowPlaybackTargetPicker === "function" });
    V.dlProgress.delete(track.id);
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
    V.keepStorage();
  }

})();
