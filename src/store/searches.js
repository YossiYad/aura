(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    clearHistory: { get: () => clearHistory },
    clearSearches: { get: () => clearSearches },
    pushSearch: { get: () => pushSearch }
  });

  /**
   * @param {string} query
   */
  function pushSearch(query) {
    const value = String(query || "").trim();
    // A search is history too, and the one being typed is the plainest statement of taste
    // in the app - it belongs to the session, not to the phone's owner.
    if (!value || V.privateOn()) return;
    const lower = value.toLowerCase();
    V.searches = V.searches.filter(item => {
      const other = item.toLowerCase();
      return other !== lower && !lower.startsWith(other);
    });
    V.searches.unshift(value);
    V.searches = V.searches.slice(0, 8);
    V.save("aura.searches", V.searches);
    V.notify("searches");
  }

  function clearSearches() {
    V.searches = [];
    V.save("aura.searches", V.searches);
    V.notify("searches");
  }

  function clearHistory() {
    V.recents = [];
    V.listeningProfile = { tracks: {}, artists: {} };
    V.save("aura.recents", V.recents);
    V.save("aura.listeningProfile", V.listeningProfile);
    V.notify("recents");
  }
})();
