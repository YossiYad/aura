(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    albums: { get: () => albums },
    artists: { get: () => artists },
    sortedLibrary: { get: () => sortedLibrary }
  });

  /**
   * The library in the order chosen in settings.
   * @param {MediaFilter} [kind]
   * @returns {Track[]}
   */
  function sortedLibrary(kind) {
    const arr = V.mediaTracks(V.library, kind);
    const mode = V.settings.sort || "added";
    if (mode === "title") arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else if (mode === "artist") arr.sort((a, b) => (a.artist || "").localeCompare(b.artist || "") || (a.title || "").localeCompare(b.title || ""));
    return arr;
  }

  /**
   * @returns {{ key: string, name: string, artist: string, thumb: string, tracks: Track[] }[]}
   */
  function albums() {
    const map = new Map();
    for (const t of V.mediaTracks(V.library, "music")) {
      const key = (t.artist || "Unknown") + "::" + (t.album || "");
      if (!map.has(key)) map.set(key, { key, name: t.album || "Singles", artist: t.artist || "Unknown", thumb: t.thumb, tracks: [] });
      map.get(key).tracks.push(t);
    }
    return Array.from(map.values()).sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
  }

  /**
   * @returns {{ name: string, thumb: string, tracks: Track[] }[]}
   */
  function artists() {
    const map = new Map();
    for (const t of V.mediaTracks(V.library, "music")) {
      const key = t.artist || "Unknown";
      if (!map.has(key)) map.set(key, { name: key, thumb: t.thumb, tracks: [] });
      map.get(key).tracks.push(t);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
})();
