(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    autoCache: { get: () => autoCache },
    cacheStats: { get: () => cacheStats },
    cacheTrack: { get: () => cacheTrack },
    clearCache: { get: () => clearCache },
    deleteCached: { get: () => deleteCached },
    downloadedIds: { get: () => downloadedIds },
    evictCache: { get: () => evictCache },
    getCached: { get: () => getCached },
    localCopyBypassed: { get: () => localCopyBypassed },
    localIds: { get: () => localIds },
    materializeBlob: { get: () => materializeBlob },
    rejectedLocalCache: { get: () => rejectedLocalCache }
  });

  const TRACK_MAX_BYTES = 60 * 1024 * 1024;

  function cacheLimitBytes() {
    const s = window.Store ? Store.settings() : {};
    const mb = parseInt(s.cacheLimitMB, 10);
    return mb > 0 ? mb * 1024 * 1024 : Infinity;
  }

  // A blob handed back by IndexedDB is only a reference: iOS can drop the bytes behind
  // it while the record stays intact, and the loss then surfaces minutes later as the
  // audio element refusing the prepared source right at a track transition. Read the
  // bytes now, while there is still time to fall back, and hand out a memory-backed
  // copy that cannot go stale between preparation and playback.
  const MATERIALIZE_MAX_BYTES = 32 * 1024 * 1024;
  async function materializeBlob(blob) {
    let bytes;
    // Only a failed or short read may condemn the stored audio; any other surprise
    // here must not be allowed to masquerade as a corrupt file.
    try {
      if (blob.size > MATERIALIZE_MAX_BYTES) {
        // Too big to keep in memory: prove both ends are readable and keep the original.
        const head = await blob.slice(0, 65536).arrayBuffer();
        const tail = await blob.slice(Math.max(0, blob.size - 65536)).arrayBuffer();
        if (!head.byteLength || !tail.byteLength) return null;
        return blob;
      }
      bytes = await blob.arrayBuffer();
      if (bytes.byteLength !== blob.size) return null;
    } catch (e) {
      return null;
    }
    try { return new Blob([bytes], { type: blob.type }); } catch (e) { return blob; }
  }

  async function getCached(id) {
    if (localCopyBypassed(id)) return null;
    const d = await V.openDb();
    if (!d || !d.objectStoreNames.contains("cache")) return null;
    const stored = await new Promise((res) => {
      let store;
      try { store = V.objectStore(d, "cache", "readwrite"); } catch (e) { return res(null); }
      const g = store.get(id);
      g.onsuccess = () => {
        const rec = g.result;
        if (rec && rec.blob) {
          rec.at = Date.now();
          try { store.put(rec, id); } catch (e) {}
          res(rec.blob);
        } else res(null);
      };
      g.onerror = () => res(null);
    });
    if (!stored) return null;
    const usable = await materializeBlob(stored);
    if (usable) return usable;
    V.log("cache", id + " stored cache is unreadable, discarding it");
    await deleteCached(id);
    return null;
  }

  async function deleteCached(id) {
    const d = await V.openDb();
    if (!d || !d.objectStoreNames.contains("cache")) return;
    return new Promise((res) => {
      const tx = d.transaction("cache", "readwrite").objectStore("cache").delete(id);
      tx.onsuccess = () => res();
      tx.onerror = () => res();
    });
  }

  async function evictCache() {
    const d = await V.openDb();
    if (!d || !d.objectStoreNames.contains("cache")) return;
    const entries = await new Promise((res) => {
      const out = [];
      const cur = d.transaction("cache", "readonly").objectStore("cache").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push({ key: c.key, at: (c.value || {}).at || 0, size: (c.value || {}).size || 0 }); c.continue(); }
        else res(out);
      };
      cur.onerror = () => res(out);
    });
    let total = entries.reduce((a, e) => a + e.size, 0);
    const max = cacheLimitBytes();
    if (total <= max) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= max) break;
      await new Promise((res) => {
        const tx = d.transaction("cache", "readwrite").objectStore("cache").delete(e.key);
        tx.onsuccess = () => res();
        tx.onerror = () => res();
      });
      total -= e.size;
    }
  }

  const cachingNow = new Set();
  const rejectedLocalCache = new Set();
  // A copy that stalled once is passed over for the stream - while there is a stream.
  // With no signal the copy is all there is, and skipping it left a saved song unplayable
  // for the rest of the session.
  function localCopyBypassed(id) {
    return rejectedLocalCache.has(id) && navigator.onLine !== false;
  }
  async function autoCache(id) {
    if (cachingNow.has(id) || rejectedLocalCache.has(id) || V.downloadsBlockedByWifi()) return;
    cachingNow.add(id);
    try {
      if (await V.getDownload(id)) return;
      if (await getCached(id)) return;
      // The limit goes to the fetch, so an oversize track is refused before its bytes
      // are spent rather than after.
      const blob = await Api.fetchStreamBlob(id, TRACK_MAX_BYTES, null,
        { receiverCompatible: typeof V.audio.webkitShowPlaybackTargetPicker === "function" });
      if (rejectedLocalCache.has(id)) return;
      if (blob.size > TRACK_MAX_BYTES) { V.log("cache", id + " too big, skipped"); return; }
      V.log("cache", id + " saved " + Math.round(blob.size / 1024) + "KB");
      const d = await V.openDb();
      if (!d || !d.objectStoreNames.contains("cache")) return;
      await new Promise((resP, rej) => {
        const tx = d.transaction("cache", "readwrite").objectStore("cache").put({ blob, at: Date.now(), size: blob.size }, id);
        tx.onsuccess = () => resP();
        tx.onerror = () => rej(tx.error);
      });
      evictCache().catch(() => {});
    } catch (e) {} finally {
      cachingNow.delete(id);
    }
  }

  /**
   * Keeps a copy of a track in the automatic cache.
   * @param {string} id
   * @returns {Promise<boolean>} Whether a copy is on the device now.
   */
  async function cacheTrack(id) {
    await autoCache(id);
    if (await V.getDownload(id)) return true;
    return !!(await getCached(id));
  }

  // Only the files the listener asked for. localIds also counts the cache that fills
  // itself while you listen, so "Downloaded" was showing songs that were merely played -
  // and those get pruned once the cache passes its limit, so it was promising something
  // it could not keep.
  /**
   * @returns {Promise<Set<string>>} Ids of the tracks the listener downloaded.
   */
  async function downloadedIds() {
    const d = await V.openDb();
    const out = new Set();
    if (!d || !d.objectStoreNames.contains("tracks")) return out;
    return new Promise(res => {
      const g = d.transaction("tracks", "readonly").objectStore("tracks").getAllKeys();
      g.onsuccess = () => { (g.result || []).forEach(k => out.add(k)); res(out); };
      g.onerror = () => res(out);
    });
  }

  /**
   * @returns {Promise<Set<string>>} Ids of every track on the device, downloaded or cached.
   */
  async function localIds() {
    const d = await V.openDb();
    const out = new Set();
    if (!d) return out;
    const readKeys = (name) => new Promise((res) => {
      if (!d.objectStoreNames.contains(name)) return res();
      const g = d.transaction(name, "readonly").objectStore(name).getAllKeys();
      g.onsuccess = () => { (g.result || []).forEach(k => out.add(k)); res(); };
      g.onerror = () => res();
    });
    await readKeys("tracks");
    await readKeys("cache");
    return out;
  }

  /**
   * @returns {Promise<{ count: number, bytes: number }>} The automatic cache.
   */
  async function cacheStats() {
    const d = await V.openDb();
    if (!d || !d.objectStoreNames.contains("cache")) return { count: 0, bytes: 0 };
    return new Promise((res) => {
      let count = 0, bytes = 0;
      const cur = d.transaction("cache", "readonly").objectStore("cache").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { count++; bytes += (c.value || {}).size || 0; c.continue(); }
        else res({ count, bytes });
      };
      cur.onerror = () => res({ count, bytes });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async function clearCache() {
    const d = await V.openDb();
    if (!d) throw new Error("IndexedDB unavailable");
    if (!d.objectStoreNames.contains("cache")) return;
    return new Promise((res, rej) => {
      const tx = d.transaction("cache", "readwrite");
      tx.objectStore("cache").clear();
      tx.oncomplete = () => res();
      tx.onerror = tx.onabort = () => rej(tx.error || new Error("Cache deletion aborted"));
    });
  }
})();
