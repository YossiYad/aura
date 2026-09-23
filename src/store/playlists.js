(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    addToPlaylist: { get: () => addToPlaylist },
    createPlaylist: { get: () => createPlaylist },
    deletePlaylist: { get: () => deletePlaylist },
    getPlaylist: { get: () => getPlaylist },
    movePlaylistTrack: { get: () => movePlaylistTrack },
    playlistTracks: { get: () => playlistTracks },
    removeFromPlaylist: { get: () => removeFromPlaylist },
    renamePlaylist: { get: () => renamePlaylist },
    setPlaylistCover: { get: () => setPlaylistCover },
    setPlaylistShared: { get: () => setPlaylistShared }
  });

  /**
   * @param {string} name
   * @returns {Playlist}
   */
  function createPlaylist(name) {
    const base = "pl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    let id = base;
    let suffix = 0;
    while (getPlaylist(id)) id = base + "_" + (++suffix);
    const p = { id, name, ids: [], createdAt: Date.now() };
    V.playlists.unshift(p);
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
    return p;
  }

  /**
   * @param {string} pid
   * @returns {Playlist | null}
   */
  function getPlaylist(pid) { return V.playlists.find(p => p.id === pid) || null; }

  /**
   * @param {string} pid
   * @param {string} name
   */
  function renamePlaylist(pid, name) {
    const p = getPlaylist(pid);
    if (p) { p.name = name; V.save("aura.playlists", V.playlists); V.notify("playlists"); }
  }

  // A picture chosen for this playlist, already cropped square and re-encoded small by the
  // caller - it rides along in the backup file and the sync payload like the rest of the
  // record, so what gets stored here has to stay small enough to deserve that.
  /**
   * @param {string} pid
   * @param {string | null} cover A data URL, or empty to remove the picture.
   */
  function setPlaylistCover(pid, cover) {
    const p = getPlaylist(pid);
    if (!p) return;
    if (cover) p.cover = String(cover); else delete p.cover;
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
  }

  /**
   * @param {string} pid
   * @returns {Undo}
   */
  function deletePlaylist(pid) {
    const at = V.playlists.findIndex(p => p.id === pid);
    const removed = at < 0 ? null : JSON.parse(JSON.stringify(V.playlists[at]));
    V.playlists = V.playlists.filter(p => p.id !== pid);
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
    return () => {
      if (!removed) return;
      const restored = Object.assign({}, removed, { ids: removed.ids.filter(id => V.findTrack(id)) });
      V.insertMissing(V.playlists, restored, at, p => p.id);
      V.save("aura.playlists", V.playlists);
      V.notify("playlists");
    };
  }

  // The link between a local playlist and the copy of it living on the private server, so
  // the menu can offer "update the shared copy" instead of making a second one.
  /**
   * @param {string} pid
   * @param {string | null} sharedId Empty to forget the link.
   */
  function setPlaylistShared(pid, sharedId) {
    const p = getPlaylist(pid);
    if (!p) return;
    if (sharedId) p.sharedId = sharedId;
    else delete p.sharedId;
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
  }

  /**
   * @param {string} pid
   * @param {string} id Track id.
   * @returns {boolean} False when the playlist is missing or already has the track.
   */
  function addToPlaylist(pid, id) {
    const p = getPlaylist(pid);
    if (!p || p.ids.includes(id)) return false;
    p.ids.push(id);
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
    return true;
  }

  /**
   * @param {string} pid
   * @param {string} id Track id.
   */
  function removeFromPlaylist(pid, id) {
    const p = getPlaylist(pid);
    if (!p) return;
    p.ids = p.ids.filter(x => x !== id);
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
  }

  /**
   * Moves a track to where another one sits in the same playlist.
   * @param {string} pid
   * @param {string} id Track to move.
   * @param {string} targetId Track whose place it takes.
   * @returns {boolean} False when nothing moved.
   */
  function movePlaylistTrack(pid, id, targetId) {
    const p = getPlaylist(pid);
    if (!p) return false;
    const from = p.ids.indexOf(id), to = p.ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return false;
    p.ids.splice(from, 1);
    p.ids.splice(to, 0, id);
    V.save("aura.playlists", V.playlists);
    V.notify("playlists");
    return true;
  }

  /**
   * The playlist's tracks that are still in the library, in order.
   * @param {string} pid
   * @returns {Track[]}
   */
  function playlistTracks(pid) {
    const p = getPlaylist(pid);
    return p ? p.ids.map(V.findTrack).filter(Boolean) : [];
  }
})();
