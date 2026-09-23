(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    addTrack: { get: () => addTrack },
    findTrack: { get: () => findTrack },
    insertMissing: { get: () => insertMissing },
    isLiked: { get: () => isLiked },
    likedTracks: { get: () => likedTracks },
    removeTrack: { get: () => removeTrack },
    toggleLike: { get: () => toggleLike }
  });

  /**
   * Finds a track in the library.
   * @param {string} id
   * @returns {Track | null}
   */
  function findTrack(id) {
    return V.library.find(t => t.id === id) || null;
  }

  /**
   * Adds a track to the top of the library.
   * @param {Track} track
   * @returns {boolean} False when it was already there.
   */
  function addTrack(track) {
    track = V.rememberMedia(track);
    if (findTrack(track.id)) return false;
    V.library.unshift(Object.assign({ addedAt: Date.now() }, track));
    V.save("aura.library", V.library);
    V.notify("library");
    return true;
  }

  // Undo only the removed item and its memberships; newer edits remain intact.
  function insertMissing(list, item, at, idOf) {
    if (!list.some(value => idOf(value) === idOf(item))) list.splice(Math.min(at, list.length), 0, item);
  }

  /**
   * Removes a track from the library, its likes and every playlist.
   * @param {string} id
   * @returns {Undo}
   */
  function removeTrack(id) {
    const at = V.library.findIndex(t => t.id === id);
    const track = at < 0 ? null : V.library[at];
    const likedAt = V.liked.indexOf(id);
    const memberships = V.playlists.filter(p => p.ids.includes(id)).map(p => ({ id: p.id, at: p.ids.indexOf(id) }));
    V.library = V.library.filter(t => t.id !== id);
    V.liked = V.liked.filter(x => x !== id);
    V.playlists.forEach(p => { p.ids = p.ids.filter(x => x !== id); });
    V.save("aura.library", V.library);
    V.save("aura.liked", V.liked);
    V.save("aura.playlists", V.playlists);
    V.notify("library");
    return () => {
      if (track) insertMissing(V.library, track, at, t => t.id);
      if (likedAt >= 0) insertMissing(V.liked, id, likedAt, x => x);
      memberships.forEach(entry => {
        const p = V.getPlaylist(entry.id);
        if (p) insertMissing(p.ids, id, entry.at, x => x);
      });
      V.save("aura.library", V.library);
      V.save("aura.liked", V.liked);
      V.save("aura.playlists", V.playlists);
      V.notify("library");
    };
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  function isLiked(id) { return V.liked.includes(id); }

  /**
   * @param {string} id
   * @returns {boolean} Whether the track is liked now.
   */
  function toggleLike(id) {
    if (V.liked.includes(id)) V.liked = V.liked.filter(x => x !== id);
    else V.liked.unshift(id);
    V.save("aura.liked", V.liked);
    V.notify("liked");
    return V.liked.includes(id);
  }

  /**
   * Liked tracks that are in the library, most recent first.
   * @param {MediaFilter} [kind]
   * @returns {Track[]}
   */
  function likedTracks(kind) {
    return V.mediaTracks(V.liked.map(findTrack).filter(Boolean), kind);
  }
})();
