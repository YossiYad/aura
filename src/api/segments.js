(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    getSkipSegments: { get: () => getSkipSegments }
  });

  // Uploads carry things that are not the song: a channel intro, a sponsor read, an outro
  // over the fade. SponsorBlock is a community index of where those sit in each video.
  const segmentCache = new Map();
  const SKIP_CATEGORIES = ["sponsor", "selfpromo", "interaction", "intro", "outro", "music_offtopic"];

  /**
   * @param {string} id Video id.
   * @returns {Promise<SkipSegment[]>}
   */
  async function getSkipSegments(id) {
    const cached = segmentCache.get(id);
    if (cached && Date.now() < cached.until) return cached.list;
    // Persisted too, so replaying a track or reopening the app does not ask again.
    const stored = Store.cachedSegments ? Store.cachedSegments(id) : null;
    if (stored) return stored;
    let out = [];
    try {
      const categories = SKIP_CATEGORIES.map(c => "category=" + encodeURIComponent(c)).join("&");
      const data = await V.fetchJson("https://sponsor.ajay.app/api/skipSegments?videoID=" + encodeURIComponent(id) + "&" + categories, 6000);
      out = (data || [])
        .map(s => ({ start: (s.segment || [])[0], end: (s.segment || [])[1], category: s.category || "segment" }))
        .filter(s => typeof s.start === "number" && typeof s.end === "number" && s.end > s.start)
        .sort((a, b) => a.start - b.start);
    } catch (e) {
      // A 404 means no submissions; a timeout or server failure is not an answer.
      if (e.status !== 404) return [];
      out = [];
    }
    segmentCache.set(id, { list: out, until: Date.now() + (out.length ? 7 * 86400000 : 3600000) });
    if (Store.cacheSegments) Store.cacheSegments(id, out);
    return out;
  }
})();
