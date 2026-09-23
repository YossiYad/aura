(function () {
  const V = window.Aura.sync;

  // Shared playlists are a server-side resource, not part of the personal blob: they are
  // deliberately kept out of Store.exportData so a household list is never carried into
  // someone else's backup, never counted against the 2MB personal copy, and never fought
  // over by two devices last-write-wins. What is kept locally is only a cache, so the
  // Library can show the lists on a train with no signal.
  const SHARED = "/api/sync/shared";
  const SHARED_CACHE = "aura.shared";

  function readSharedCache() {
    try {
      const map = JSON.parse(localStorage.getItem(SHARED_CACHE));
      return map && typeof map === "object" && !Array.isArray(map) ? map : {};
    } catch (e) { return {}; }
  }

  function writeSharedCache(map) {
    try { localStorage.setItem(SHARED_CACHE, JSON.stringify(map)); } catch (e) {}
  }

  /**
   * @param {SharedPlaylist} record
   * @returns {SharedPlaylist} The same record.
   */
  function cacheShared(record) {
    if (!record || !record.id) return record;
    const map = readSharedCache();
    // The full record carries no count, and sharedList compares the summary's against it.
    map[record.id] = Object.assign({}, record, { count: (record.tracks || []).length, fetchedAt: Date.now() });
    writeSharedCache(map);
    return record;
  }

  /**
   * One cached record, or null when it is not cached.
   * @overload
   * @param {string} id
   * @returns {SharedPlaylist | null}
   */
  /**
   * Every cached record, newest first.
   * @overload
   * @returns {SharedPlaylist[]}
   */
  /**
   * @param {string} [id]
   * @returns {SharedPlaylist | SharedPlaylist[] | null}
   */
  function sharedCached(id) {
    const map = readSharedCache();
    if (id) return map[id] || null;
    return Object.keys(map).map(k => map[k])
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * @param {string} id
   */
  function sharedForget(id) {
    const map = readSharedCache();
    if (!map[id]) return;
    delete map[id];
    writeSharedCache(map);
  }

  /**
   * @param {string} path After /api/sync/shared.
   * @param {string} [method] Default GET.
   * @param {Object} [body]
   * @returns {Promise<any>}
   * @throws {Error} With the server's message.
   */
  async function sharedCall(path, method, body) {
    let res;
    try {
      res = await fetch(SHARED + path, {
        method: method || "GET",
        headers: body ? { "Content-Type": "application/json" } : { Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
      });
    } catch (e) {
      throw new Error("Can't reach the server right now");
    }
    if (res.status === 404 && method !== "DELETE" && path === "") {
      throw new Error("This server has no sync service, so there is nothing to share on");
    }
    let out = null;
    try { out = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((out && out.error) || "Server said HTTP " + res.status);
    return out || {};
  }

  // Everything the server still has, and nothing it no longer does: a list someone else
  // deleted stops taking up room in the Library instead of lingering as a dead row.
  /**
   * @returns {Promise<{ email: string, playlists: SharedPlaylist[] }>}
   */
  async function sharedList() {
    const out = await sharedCall("", "GET");
    const live = new Set((out.playlists || []).map(p => p.id));
    const map = readSharedCache();
    Object.keys(map).forEach(id => { if (!live.has(id)) delete map[id]; });
    (out.playlists || []).forEach(p => {
      const cached = map[p.id] || {};
      // A summary that moved on means the cached tracks are stale; drop them so the
      // next open fetches the list rather than showing the new count over old songs.
      const changed = cached.tracks && (cached.updatedAt !== p.updatedAt || cached.count !== p.count);
      map[p.id] = Object.assign({}, cached, p);
      if (changed) delete map[p.id].tracks;
    });
    writeSharedCache(map);
    return out;
  }

  /**
   * @param {string} id
   * @returns {Promise<SharedPlaylist>}
   */
  function sharedOpen(id) { return sharedCall("/" + id, "GET").then(cacheShared); }
  /**
   * @param {string} name
   * @param {Track[]} tracks
   * @returns {Promise<SharedPlaylist>}
   */
  function sharedCreate(name, tracks) { return sharedCall("", "POST", { name, tracks }).then(cacheShared); }
  /**
   * Renames the playlist and merges in its tracks. Only its owner may do this.
   * @param {string} id
   * @param {string} name
   * @param {Track[]} tracks
   * @returns {Promise<SharedPlaylist>}
   */
  function sharedReplace(id, name, tracks) { return sharedCall("/" + id, "PUT", { name, tracks, merge: true }).then(cacheShared); }
  /**
   * @param {string} id
   * @param {string} trackId
   * @returns {Promise<SharedPlaylist>}
   */
  function sharedRemoveTrack(id, trackId) { return sharedCall("/" + id, "PUT", { removeIds: [trackId] }).then(cacheShared); }
  /**
   * Adds tracks. Anyone signed in may do this.
   * @param {string} id
   * @param {Track[]} tracks
   * @returns {Promise<SharedPlaylist>}
   */
  function sharedAppend(id, tracks) { return sharedCall("/" + id + "/tracks", "POST", { tracks }).then(cacheShared); }
  /**
   * Deletes the playlist. Only its owner may do this.
   * @param {string} id
   * @returns {Promise<any>}
   */
  function sharedRemove(id) { return sharedCall("/" + id, "DELETE").then(out => { sharedForget(id); return out; }); }

  window.Sync = {
    init: V.init, pushNow: V.pushNow, hasConflict: V.hasConflict, recoverConflict: V.recoverConflict,
    onChange: V.onChange, describe: V.describe,
    sharedList, sharedOpen, sharedCreate, sharedReplace, sharedAppend, sharedRemove, sharedRemoveTrack,
    sharedCached, sharedForget
  };
})();
