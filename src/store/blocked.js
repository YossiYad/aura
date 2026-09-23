(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    blockArtist: { get: () => blockArtist },
    blocked: { get: () => blocked, set: value => { blocked = value; } },
    blockedList: { get: () => blockedList },
    blockTrack: { get: () => blockTrack },
    isBlocked: { get: () => isBlocked },
    normalizeBlocked: { get: () => normalizeBlocked },
    PROFILE_TRACK_CAP: { get: () => PROFILE_TRACK_CAP },
    unblockArtist: { get: () => unblockArtist },
    unblockTrack: { get: () => unblockTrack }
  });

  // Discovery here is built out of unfiltered YouTube results, so a junk re-upload or an
  // artist the listener does not want keeps coming back through radio and the home rails.
  // This is the "not this, ever" they had no way to say.
  let blocked = V.load("aura.blocked", { tracks: [], artists: [] });

  // Entries used to be bare video ids, which worked only for as long as the track could be
  // found somewhere else on the device - library, downloads, recents. A song blocked straight
  // from search and never played since has nowhere left to be looked up, and showed up in the
  // blocklist manager as an unrecognizable id nobody could decide about. Each entry now
  // carries the snapshot taken at the moment of blocking; older ids are migrated on load.
  /**
   * @param {*} entry A bare id (older format) or a snapshot.
   * @returns {BlockedTrack | null}
   */
  function normalizeBlockedEntry(entry) {
    if (typeof entry === "string") return { id: entry, title: "", artist: "", thumb: "" };
    if (entry && typeof entry === "object" && entry.id) {
      return { id: entry.id, title: String(entry.title || ""), artist: String(entry.artist || ""), thumb: String(entry.thumb || "") };
    }
    return null;
  }

  /**
   * @param {*} value
   * @returns {BlockedList}
   */
  function normalizeBlocked(value) {
    const b = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const tracks = [];
    const seenTracks = new Set();
    (Array.isArray(b.tracks) ? b.tracks : []).forEach(entry => {
      const norm = normalizeBlockedEntry(entry);
      if (!norm || seenTracks.has(norm.id)) return;
      seenTracks.add(norm.id);
      tracks.push(norm);
    });
    const artists = [];
    const seenArtists = new Set();
    (Array.isArray(b.artists) ? b.artists : []).forEach(name => {
      const key = artistKey(name);
      if (!key || seenArtists.has(key)) return;
      seenArtists.add(key);
      artists.push(key);
    });
    return { tracks, artists };
  }

  // Kept per distinct track played; with a snapshot each, an uncapped profile alone
  // outgrew the sync size limit after a few thousand tracks, and then nothing synced.
  const PROFILE_TRACK_CAP = 2000;

  // The same artist appears as "X", "X - Topic" and "XVEVO" across uploads; a block
  // taken from one of them covers the others.
  /**
   * @param {*} name
   * @returns {string}
   */
  function artistKey(name) {
    return String(name || "").trim().toLowerCase().replace(/\s*-\s*topic$/, "").replace(/vevo$/, "").trim();
  }

  blocked = normalizeBlocked(blocked);

  /**
   * @param {string} id
   * @returns {boolean}
   */
  function isTrackBlockedId(id) {
    return !!id && blocked.tracks.some(t => t.id === id);
  }

  /**
   * @param {Track | null | undefined} track
   * @returns {boolean} True when the track or its artist is blocked.
   */
  function isBlocked(track) {
    if (!track) return false;
    if (isTrackBlockedId(track.id)) return true;
    const key = artistKey(track.artist);
    return !!key && blocked.artists.some(name => artistKey(name) === key);
  }

  /**
   * @param {Track} track
   * @returns {Undo}
   */
  function blockTrack(track) {
    if (!track || !track.id || isTrackBlockedId(track.id)) return () => {};
    blocked.tracks.unshift({
      id: track.id,
      title: String(track.title || ""),
      artist: String(track.artist || ""),
      thumb: String(track.thumb || "")
    });
    V.save("aura.blocked", blocked);
    V.notify("blocked");
    return () => unblockTrack(track.id);
  }

  /**
   * @param {string} name
   * @returns {Undo}
   */
  function blockArtist(name) {
    const key = artistKey(name);
    if (!key || blocked.artists.indexOf(key) !== -1) return () => {};
    blocked.artists.push(key);
    V.save("aura.blocked", blocked);
    V.notify("blocked");
    return () => {
      blocked.artists = blocked.artists.filter(x => x !== key);
      V.save("aura.blocked", blocked);
      V.notify("blocked");
    };
  }

  /**
   * @returns {BlockedList} A copy.
   */
  function blockedList() {
    return {
      tracks: blocked.tracks.map(t => Object.assign({}, t)),
      artists: blocked.artists.slice()
    };
  }

  /**
   * @param {string} id
   */
  function unblockTrack(id) {
    if (!isTrackBlockedId(id)) return;
    blocked.tracks = blocked.tracks.filter(t => t.id !== id);
    V.save("aura.blocked", blocked);
    V.notify("blocked");
  }

  /**
   * @param {string} name
   */
  function unblockArtist(name) {
    const key = artistKey(name);
    if (!key || blocked.artists.indexOf(key) === -1) return;
    blocked.artists = blocked.artists.filter(x => x !== key);
    V.save("aura.blocked", blocked);
    V.notify("blocked");
  }
})();
