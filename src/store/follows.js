(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    follow: { get: () => follow },
    followsList: { get: () => followsList },
    getFollow: { get: () => getFollow },
    hasNewFollow: { get: () => hasNewFollow },
    isFollowing: { get: () => isFollowing },
    markFollowSeen: { get: () => markFollowSeen },
    refreshFollowLatest: { get: () => refreshFollowLatest },
    unfollow: { get: () => unfollow }
  });

  /**
   * @param {string} id Channel id.
   * @returns {boolean}
   */
  function isFollowing(id) { return !!id && V.follows.some(f => f.id === id); }
  /**
   * @param {string} id Channel id.
   * @returns {Follow | null}
   */
  function getFollow(id) { return V.follows.find(f => f.id === id) || null; }
  /**
   * @returns {Follow[]}
   */
  function followsList() { return V.follows.slice(); }

  /**
   * @param {{ id: string, name?: string, thumb?: string, kind?: string, latestId?: string | null }} entry
   * @returns {boolean} False when it is already followed or has no id.
   */
  function follow(entry) {
    if (!entry || !entry.id || isFollowing(entry.id)) return false;
    const seed = entry.latestId || null;
    V.follows.unshift({
      id: entry.id,
      name: entry.name || "",
      thumb: entry.thumb || "",
      kind: entry.kind === "podcast" ? "podcast" : "artist",
      followedAt: Date.now(),
      // Seeded to the same value so an artist's existing catalog never reads as "new" the
      // moment someone follows them - only what shows up afterward does.
      latestId: seed,
      lastSeenId: seed,
      checkedAt: seed ? Date.now() : 0
    });
    V.save("aura.follows", V.follows);
    V.notify("follows");
    return true;
  }

  /**
   * @param {string} id Channel id.
   */
  function unfollow(id) {
    if (!isFollowing(id)) return;
    V.follows = V.follows.filter(f => f.id !== id);
    V.save("aura.follows", V.follows);
    V.notify("follows");
  }

  // Called after checking a followed channel for its newest upload. Returns true only when
  // this was already checked before and the id actually moved - a genuine new release, not
  // the first look at a channel just followed.
  /**
   * @param {string} id Channel id.
   * @param {string} latestId Newest upload found now.
   * @returns {boolean} True for a genuine new release.
   */
  function refreshFollowLatest(id, latestId) {
    const f = getFollow(id);
    if (!f || !latestId) return false;
    const hadBaseline = !!f.checkedAt;
    const changed = f.latestId !== latestId;
    f.latestId = latestId;
    f.checkedAt = Date.now();
    if (!hadBaseline && f.lastSeenId == null) f.lastSeenId = latestId;
    V.save("aura.follows", V.follows);
    V.notify("follows");
    return hadBaseline && changed;
  }

  // Viewing the artist's page counts as having seen whatever is newest, clearing the dot.
  /**
   * @param {string} id Channel id.
   */
  function markFollowSeen(id) {
    const f = getFollow(id);
    if (!f || f.lastSeenId === f.latestId) return;
    f.lastSeenId = f.latestId;
    V.save("aura.follows", V.follows);
    V.notify("follows");
  }

  /**
   * @param {string} id Channel id.
   * @returns {boolean} Whether the channel has an upload the listener has not looked at.
   */
  function hasNewFollow(id) {
    const f = getFollow(id);
    return !!(f && f.latestId && f.latestId !== f.lastSeenId);
  }
})();
