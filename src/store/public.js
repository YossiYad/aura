(function () {
  const V = window.Aura.store;

  window.Store = {
    // Per-tab delivery state is deliberately excluded from library backup and sync.
    /** @returns {string} This tab's 32-character id for the shared queue. */
    sharedQueueDevice() {
      let id;
      try { id = sessionStorage.getItem("aura.sharedQueueDevice"); } catch (e) {}
      if (!/^[A-Za-z0-9_-]{32}$/.test(id || "")) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
        try { sessionStorage.setItem("aura.sharedQueueDevice", id); } catch (e) {}
      }
      return id;
    },
    /**
     * @param {string} id Shared queue item id.
     * @param {boolean} [delivered] Record the item as delivered to this tab.
     * @returns {boolean} Whether it had been delivered before this call.
     */
    sharedQueueDelivered(id, delivered) {
      try {
        const key = "aura.sharedQueueDelivered";
        const ids = JSON.parse(sessionStorage.getItem(key) || "[]");
        if (delivered && !ids.includes(id)) sessionStorage.setItem(key, JSON.stringify(ids.concat(id).slice(-2000)));
        return ids.includes(id);
      } catch (e) { return false; }
    },
    /**
     * Reads, and optionally first replaces, the queue of the shared session played here.
     * @param {(SavedQueue & { id: string }) | null} [value] Null clears it; undefined only reads.
     * @returns {(SavedQueue & { id: string }) | null}
     */
    sharedQueuePlayback(value) {
      try {
        const key = "aura.sharePlayback";
        if (value === null) sessionStorage.removeItem(key);
        else if (value !== undefined) sessionStorage.setItem(key, JSON.stringify(value));
        return JSON.parse(sessionStorage.getItem(key) || "null");
      } catch (e) { return null; }
    },
    /** @param {(what: StoreChange) => void} fn */
    onChange: fn => V.listeners.push(fn),
    /** @param {MediaFilter} [kind] @returns {Track[]} Newest first. */
    library: kind => V.mediaTracks(V.library, kind),
    sortedLibrary: V.sortedLibrary,
    findTrack: V.findTrack, addTrack: V.addTrack, removeTrack: V.removeTrack,
    rememberDownload: V.rememberDownload, forgetDownload: V.forgetDownload, downloadedTracks: V.downloadedTracks, artistIdFor: V.artistIdFor,
    isLiked: V.isLiked, toggleLike: V.toggleLike, likedTracks: V.likedTracks,
    /** @returns {Playlist[]} */
    playlists: () => V.playlists.slice(),
    createPlaylist: V.createPlaylist, getPlaylist: V.getPlaylist, renamePlaylist: V.renamePlaylist, deletePlaylist: V.deletePlaylist, setPlaylistCover: V.setPlaylistCover,
    addToPlaylist: V.addToPlaylist, removeFromPlaylist: V.removeFromPlaylist, movePlaylistTrack: V.movePlaylistTrack, playlistTracks: V.playlistTracks, setPlaylistShared: V.setPlaylistShared,
    /** @param {MediaFilter} [kind] @returns {Track[]} Most recent first. */
    recents: kind => V.mediaTracks(V.recents, kind),
    pushRecent: V.pushRecent,
    topListeningTracks: V.topListeningTracks, topListeningArtists: V.topListeningArtists, topListeningPodcasts: V.topListeningPodcasts, mediaKind: V.mediaKind, rememberMedia: V.rememberMedia, matchingPodcastShow: V.matchingPodcastShow,
    /** @returns {string[]} Recent search queries, newest first. */
    searches: () => V.searches.slice(),
    pushSearch: V.pushSearch, clearSearches: V.clearSearches, clearHistory: V.clearHistory,
    savePosition: V.savePosition, getPosition: V.getPosition, clearPosition: V.clearPosition,
    isBlocked: V.isBlocked, blockTrack: V.blockTrack, blockArtist: V.blockArtist, blockedList: V.blockedList, unblockTrack: V.unblockTrack, unblockArtist: V.unblockArtist,
    foldText: V.foldText, matchesQuery: V.matchesQuery,
    cachedLyrics: V.cachedLyrics, cacheLyrics: V.cacheLyrics, searchLyrics: V.searchLyrics,
    cachedSegments: V.cachedSegments, cacheSegments: V.cacheSegments,
    albums: V.albums, artists: V.artists,
    isFollowing: V.isFollowing, getFollow: V.getFollow, followsList: V.followsList, follow: V.follow, unfollow: V.unfollow,
    podcastShowsList: V.podcastShowsList, podcastShowsAge: V.podcastShowsAge, podcastShowsLang: V.podcastShowsLang, savePodcastShows: V.savePodcastShows,
    notePodcastChannel: V.notePodcastChannel, isPodcastChannel: V.isPodcastChannel,
    refreshFollowLatest: V.refreshFollowLatest, markFollowSeen: V.markFollowSeen, hasNewFollow: V.hasNewFollow,
    /** @returns {Settings} A copy. */
    settings: () => Object.assign({}, V.settings),
    /** @param {string} base URL of the server that answered last. */
    rememberInstance(base) {
      if (V.settings.lastGoodInstance === base) return;
      V.settings = Object.assign({}, V.settings, { lastGoodInstance: base });
      V.save("aura.settings", V.settings);
      // Not announced: this is a device-local hint, and announcing it marked a fresh
      // install dirty before its first sync, which then uploaded an empty library.
    },
    privateSession: V.privateOn,
    setPrivateSession: V.setPrivateSession,
    /** @param {Partial<Settings>} patch */
    patchSettings(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
      V.settings = Object.assign({}, V.settings, patch);
      V.save("aura.settings", V.settings);
      // Hiding the feature ends the session it hides, rather than leaving it running with
      // nothing on screen to say so.
      if (patch.privateSession === false && V.privateSession) {
        try { sessionStorage.removeItem(V.PRIVATE_QUEUE_KEY); } catch (e) {}
        V.privateSession = false;
        V.save("aura.privateSession", false);
        V.notify("privateSession");
      }
      V.notify("settings");
    },
    /** @param {SavedQueue} q */
    saveQueue(q) {
      // A private session's queue lives with the session: it survives a reload, dies
      // with the app, and is never exported or synced to another device.
      if (V.privateOn()) {
        try { sessionStorage.setItem(V.PRIVATE_QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
        return;
      }
      V.save("aura.queue", q);
      if (Date.now() - V.lastQueueNotice > 5000) {
        V.lastQueueNotice = Date.now();
        V.notify("queue");
      }
    },
    /** @returns {SavedQueue | null} */
    loadQueue() {
      if (V.privateOn()) {
        try {
          const raw = sessionStorage.getItem(V.PRIVATE_QUEUE_KEY);
          if (raw) return JSON.parse(raw);
        } catch (e) {}
      }
      return V.load("aura.queue", null);
    },
    exportData: V.exportData, importData: V.importData,
    /** Erases the library and listening data. Downloads, follows and settings stay. */
    clearAll() {
      ["aura.library", "aura.playlists", "aura.liked", "aura.recents", "aura.searches", "aura.queue",
        "aura.listeningProfile", "aura.downloadQueue"].forEach(k => V.erase(k));
      V.library = []; V.playlists = []; V.liked = []; V.recents = []; V.searches = [];
      // The record of what was taken offline stays: the files themselves are still on the
      // device, and without it nothing lists them and nothing can remove them.
      V.listeningProfile = { tracks: {}, artists: {} };
      // These lived on through a clear, so a wipe left the old blocklist and the old
      // resume positions behind and a restore merged into them.
      V.erase("aura.blocked");
      V.erase("aura.positions");
      V.blocked = { tracks: [], artists: [] };
      V.positions = {};
      // Follows are a subscription, not listening data - a library wipe should not
      // silently unfollow anyone, so they are deliberately left alone here.
      V.notify("library");
    }
  };

  // Stage writes and notifications until the complete operation succeeds. On storage
  // failure, roll back completed keys and rehydrate memory from the durable state.
  /**
   * Wraps a Store method so its writes land together or not at all.
   * @param {(...args: any[]) => any} fn
   * @param {string} name For the log.
   * @param {boolean} quiet Swallow a storage failure instead of showing it and rethrowing.
   * @returns {(...args: any[]) => any}
   */
  function atomicMutation(fn, name, quiet) {
    return function (...args) {
      if (V.transaction) return fn.apply(this, args);
      const tx = { writes: new Map(), notices: new Set() };
      const previous = new Map();
      V.transaction = tx;
      let result;
      try {
        result = fn.apply(this, args);
        tx.writes.forEach((raw, key) => {
          previous.set(key, localStorage.getItem(key));
          if (raw == null) localStorage.removeItem(key);
          else localStorage.setItem(key, raw);
        });
      } catch (error) {
        if (!tx.writes.size) { V.transaction = null; throw error; }
        for (const [key, raw] of Array.from(previous).reverse()) {
          try { if (raw == null) localStorage.removeItem(key); else localStorage.setItem(key, raw); } catch (e) {}
        }
        V.library = V.loadList("aura.library"); V.playlists = V.loadPlaylists();
        V.liked = V.loadList("aura.liked"); V.recents = V.loadList("aura.recents");
        V.searches = V.loadList("aura.searches"); V.downloads = V.loadMap("aura.downloads");
        V.listeningProfile = V.loadListeningProfile();
        V.follows = V.loadList("aura.follows"); V.settings = V.loadSettings();
        V.positions = V.loadMap("aura.positions"); V.blocked = V.normalizeBlocked(V.load("aura.blocked", { tracks: [], artists: [] }));
        V.lyrics = V.loadMap("aura.lyrics"); V.lyricsIndex = null; V.segments = V.loadMap("aura.segments");
        V.podcastShows = V.loadPodcastShows();
        V.privateSession = V.load("aura.privateSession", false) === true;
        V.transaction = null;
        // Background writes - a resume position, a lyric cache, the queue - were never
        // something the listener asked for, so a full disk is logged, not announced, and
        // the caller carries on rather than unwinding into playback.
        if (window.Log) Log.add("store", (name || "a write") + " could not be saved: " + String((error && error.message) || error).slice(0, 120));
        if (quiet) return false;
        if (window.Views && window.Views.toast) window.Views.toast("Couldn't save changes. Check device storage and try again.", "err");
        throw error;
      }
      V.transaction = null;
      tx.notices.forEach(V.notify);
      return typeof result === "function" ? atomicMutation(result, name, quiet) : result;
    };
  }
  // Written by playback and by background refreshes, never by a tap.
  const QUIET_WRITES = new Set(["savePosition", "clearPosition", "cacheLyrics", "cacheSegments",
    "rememberMedia", "pushRecent", "saveQueue", "savePodcastShows", "notePodcastChannel", "refreshFollowLatest", "rememberInstance",
    "markFollowSeen"]);
  ["rememberMedia", "addTrack", "removeTrack", "rememberDownload", "forgetDownload", "toggleLike",
    "createPlaylist", "renamePlaylist", "deletePlaylist", "setPlaylistCover", "addToPlaylist",
    "removeFromPlaylist", "movePlaylistTrack", "setPlaylistShared", "pushRecent", "pushSearch", "clearSearches",
    "clearHistory", "savePosition", "clearPosition", "blockTrack", "blockArtist", "unblockTrack",
    "unblockArtist", "cacheLyrics", "cacheSegments", "follow", "unfollow", "savePodcastShows",
    "notePodcastChannel", "refreshFollowLatest", "markFollowSeen", "setPrivateSession", "patchSettings",
    "saveQueue", "importData", "clearAll", "rememberInstance"].forEach(name => {
      window.Store[name] = atomicMutation(window.Store[name], name, QUIET_WRITES.has(name));
    });
})();
