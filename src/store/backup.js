(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    exportData: { get: () => exportData },
    importData: { get: () => importData }
  });

  /**
   * @returns {AuraBackup}
   */
  function exportData() {
    return {
      format: "aura-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        library: V.library,
        playlists: V.playlists,
        liked: V.liked,
        recents: V.recents,
        searches: V.searches,
        settings: V.settings,
        queue: V.load("aura.queue", null),
        listeningProfile: V.listeningProfile,
        // Left out until now, and each one is work the listener did by hand: what they
        // blocked, where they stopped in an episode, and what they took offline.
        blocked: V.blocked,
        positions: V.positions,
        downloads: V.downloads,
        follows: V.follows,
        podcastShows: V.podcastShows
      }
    };
  }

  /**
   * Replaces the stored data with a backup. Validates everything before writing anything.
   * @param {AuraBackup} backup
   * @param {{ preserveDownloads?: boolean }} [options]
   * @returns {{ songs: number, playlists: number, history: number }}
   * @throws {Error} When the backup is not valid; nothing is restored then.
   */
  function importData(backup, options) {
    if (!backup || backup.format !== "aura-backup" || backup.version !== 1 || !backup.data || typeof backup.data !== "object") throw new Error("Invalid Aura backup file");
    const data = JSON.parse(JSON.stringify(backup.data));
    const object = value => value && typeof value === "object" && !Array.isArray(value);
    const id = value => typeof value === "string" && value.length > 0;
    const track = value => object(value) && id(value.id) &&
      ["title", "artist", "album", "thumb", "artistId"].every(key => value[key] == null || typeof value[key] === "string");
    const invalid = () => { throw new Error("Backup contains invalid records; nothing was restored"); };
    if (!object(data)) invalid();
    if (!Array.isArray(data.library) || !Array.isArray(data.playlists) || !Array.isArray(data.liked) || !Array.isArray(data.recents)) throw new Error("Backup data is incomplete");
    if (!data.library.every(track) || !data.recents.every(track) || !data.liked.every(id) ||
        !data.playlists.every(p => object(p) && id(p.id) && typeof p.name === "string" && Array.isArray(p.ids) && p.ids.every(id))) invalid();
    if (data.searches != null && (!Array.isArray(data.searches) || !data.searches.every(x => typeof x === "string"))) invalid();
    if (data.podcastShows != null && (!object(data.podcastShows) || !Array.isArray(data.podcastShows.shows) ||
        !data.podcastShows.shows.every(s => object(s) && typeof s.name === "string" &&
          ["channel", "channelId"].every(k => s[k] == null || typeof s[k] === "string")))) invalid();
    if (data.settings != null && !object(data.settings)) invalid();
    if (data.follows != null && (!Array.isArray(data.follows) || !data.follows.every(track))) invalid();
    if (data.downloads != null && (!object(data.downloads) || !Object.values(data.downloads).every(track))) invalid();
    if (data.positions != null && (!object(data.positions) || !Object.values(data.positions).every(x => typeof x === "number" && Number.isFinite(x) && x >= 0))) invalid();
    if (data.blocked != null && (!object(data.blocked) || !Array.isArray(data.blocked.tracks) || !Array.isArray(data.blocked.artists) ||
        !data.blocked.tracks.every(x => id(x) || track(x)) || !data.blocked.artists.every(id))) invalid();
    if (data.listeningProfile != null && (!object(data.listeningProfile) ||
        !object(data.listeningProfile.tracks) || !object(data.listeningProfile.artists) ||
        !Object.values(data.listeningProfile.tracks).every(x => object(x) && track(x.track)) || !Object.values(data.listeningProfile.artists).every(object))) invalid();
    if (data.queue != null && (!object(data.queue) ||
        (data.queue.extra != null && (!Array.isArray(data.queue.extra) || !data.queue.extra.every(track))))) invalid();
    V.library = data.library;
    V.playlists = data.playlists
      .filter(p => p && typeof p === "object" && p.id)
      .map(p => Object.assign({}, p, {
        id: String(p.id),
        name: String(p.name || "Playlist"),
        ids: Array.from(new Set((Array.isArray(p.ids) ? p.ids : []).filter(id => typeof id === "string" && id)))
      }));
    V.liked = data.liked;
    V.recents = data.recents;
    V.searches = Array.isArray(data.searches) ? data.searches : [];
    V.settings = Object.assign({}, V.defaultSettings, data.settings && typeof data.settings === "object" ? data.settings : {});
    V.listeningProfile = data.listeningProfile && typeof data.listeningProfile === "object" ? data.listeningProfile : { tracks: {}, artists: {} };
    if (!V.listeningProfile.tracks || typeof V.listeningProfile.tracks !== "object") V.listeningProfile.tracks = {};
    if (!V.listeningProfile.artists || typeof V.listeningProfile.artists !== "object") V.listeningProfile.artists = {};
    V.save("aura.library", V.library);
    V.save("aura.playlists", V.playlists);
    V.save("aura.liked", V.liked);
    V.save("aura.recents", V.recents);
    V.save("aura.searches", V.searches);
    V.save("aura.settings", V.settings);
    V.save("aura.queue", data.queue || null);
    V.save("aura.listeningProfile", V.listeningProfile);
    // Optional, so a backup written before these were carried still restores.
    if (data.blocked && typeof data.blocked === "object") {
      V.blocked = V.normalizeBlocked(data.blocked);
      V.save("aura.blocked", V.blocked);
    }
    if (data.positions && typeof data.positions === "object" && !Array.isArray(data.positions)) {
      V.positions = data.positions;
      V.save("aura.positions", V.positions);
    }
    if (!(options && options.preserveDownloads) && data.downloads && typeof data.downloads === "object" && !Array.isArray(data.downloads)) {
      V.downloads = data.downloads;
      V.save("aura.downloads", V.downloads);
    }
    if (Array.isArray(data.follows)) {
      V.follows = data.follows;
      V.save("aura.follows", V.follows);
    }
    if (data.podcastShows) {
      V.podcastShows = data.podcastShows;
      V.save("aura.podcastShows", V.podcastShows);
    }
    V.notify("restore");
    return { songs: V.library.length, playlists: V.playlists.length, history: V.recents.length };
  }
})();
