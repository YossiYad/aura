(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    normInvidious: { get: () => normInvidious },
    normInvidiousPlaylist: { get: () => normInvidiousPlaylist },
    normPiped: { get: () => normPiped },
    thumbFor: { get: () => thumbFor }
  });

  /**
   * @param {string} id Video id.
   * @returns {string} The YouTube thumbnail URL.
   */
  function thumbFor(id) {
    return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
  }

  /**
   * @param {Object} item A Piped stream item.
   * @returns {Track | null}
   */
  function normPiped(item) {
    const id = V.videoIdFromUrl(item.url);
    if (!id) return null;
    return {
      id,
      title: item.title || "",
      artist: item.uploaderName || "",
      album: "",
      // Piped marks a live stream with -1; nothing downstream wants a negative length.
      duration: item.duration > 0 ? item.duration : 0,
      live: item.duration === -1,
      thumb: item.thumbnail || thumbFor(id),
      // When it went up, in ms. Kept because relevance order is not release order, and
      // "what came out this week" cannot be answered without it.
      published: typeof item.uploaded === "number" && item.uploaded > 0 ? item.uploaded : 0,
      views: item.views != null ? item.views : null,
      artistId: V.channelIdFromUrl(item.uploaderUrl),
      artistVerified: item.uploaderVerified === true,
      artistThumb: item.uploaderAvatar || ""
    };
  }

  /**
   * @param {Object} item An Invidious video item.
   * @param {string} base
   * @returns {Track | null}
   */
  function normInvidious(item, base) {
    if (!item.videoId) return null;
    return {
      id: item.videoId,
      title: item.title || "",
      artist: item.author || "",
      album: "",
      duration: item.lengthSeconds > 0 ? item.lengthSeconds : 0,
      live: !!(item.liveNow || item.isUpcoming),
      thumb: thumbFor(item.videoId),
      published: typeof item.published === "number" && item.published > 0 ? item.published * 1000 : 0,
      views: item.viewCount != null ? item.viewCount : null,
      artistId: item.authorId || null,
      artistVerified: item.authorVerified === true,
      artistThumb: V.largestImage(item.authorThumbnails, base)
    };
  }

  /**
   * @param {Object} item
   * @param {string} base
   * @returns {PlaylistSummary | null}
   */
  function normInvidiousPlaylist(item, base) {
    if (!item || !item.playlistId) return null;
    return {
      id: item.playlistId,
      name: item.title || "",
      thumb: V.absoluteUrl(item.playlistThumbnail || "", base),
      count: item.videoCount || 0
    };
  }
})();
