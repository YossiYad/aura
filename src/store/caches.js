(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    cachedLyrics: { get: () => cachedLyrics },
    cachedSegments: { get: () => cachedSegments },
    cacheLyrics: { get: () => cacheLyrics },
    cacheSegments: { get: () => cacheSegments },
    lyrics: { get: () => lyrics, set: value => { lyrics = value; } },
    lyricsIndex: { get: () => lyricsIndex, set: value => { lyricsIndex = value; } },
    searchLyrics: { get: () => searchLyrics },
    segments: { get: () => segments, set: value => { segments = value; } }
  });

  // Lyrics were refetched on every track change, so a replay, a return to a song later in
  // the session, or reopening the app all hit lrclib again - and offline there were none at
  // all, including for downloaded tracks.
  let lyrics = V.loadMap("aura.lyrics");

  /**
   * @param {string} id
   * @returns {LyricsEntry | null}
   */
  function cachedLyrics(id) {
    const hit = lyrics[id];
    return hit && typeof hit === "object" ? hit : null;
  }

  /**
   * @param {string} id
   * @param {LyricsEntry | null} data Empty records a known miss.
   */
  function cacheLyrics(id, data) {
    // Cached lyrics are searchable, which would name a privately played song later.
    if (!id || V.privateOn()) return;
    delete lyrics[id];
    lyrics[id] = data || { none: true };
    const keys = Object.keys(lyrics);
    if (keys.length > 300) delete lyrics[keys[0]];
    V.save("aura.lyrics", lyrics);
    lyricsIndex = null;
  }

  // Every lyric the player has ever fetched is sitting in that cache, and the words are
  // often the only thing a listener remembers - "the one that goes...". Folded once and
  // kept until the cache changes, because folding three hundred songs' worth of text on
  // every keystroke is the thing worth not doing.
  let lyricsIndex = null;

  function lyricsPlainText(entry) {
    if (!entry || typeof entry !== "object" || entry.none) return "";
    if (entry.plainLyrics) return String(entry.plainLyrics);
    // Synced lyrics carry a [mm:ss.xx] stamp per line. The words are what gets searched.
    return String(entry.syncedLyrics || "").replace(/\[\d+:\d+(?:\.\d+)?\]/g, " ");
  }

  function buildLyricsIndex() {
    lyricsIndex = [];
    Object.keys(lyrics).forEach(id => {
      const text = lyricsPlainText(lyrics[id]);
      if (text.trim()) lyricsIndex.push({ id, text, folded: V.foldText(text) });
    });
  }

  // The line that matched, not just the fact that something did: a hit reads as an answer
  // to what was typed when the words themselves are what comes back.
  function matchingLyricLine(text, words) {
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    const hit = lines.find(line => {
      const folded = V.foldText(line);
      return words.every(word => folded.indexOf(word) !== -1);
    });
    return hit || lines[0] || "";
  }

  // Short queries are left alone deliberately: two letters match most songs ever written,
  // and the row would be noise under the title matches rather than an answer.
  /**
   * Searches the lyrics of every track whose lyrics were fetched before.
   * @param {string} query At least three characters.
   * @param {number} [limit] Default 8.
   * @returns {{ id: string, line: string }[]} The track id and the line that matched.
   */
  function searchLyrics(query, limit) {
    const needle = V.foldText(query).trim();
    if (needle.length < 3) return [];
    if (!lyricsIndex) buildLyricsIndex();
    const words = needle.split(/\s+/).filter(Boolean);
    const max = limit || 8;
    const out = [];
    for (const entry of lyricsIndex) {
      if (!words.every(word => entry.folded.indexOf(word) !== -1)) continue;
      out.push({ id: entry.id, line: matchingLyricLine(entry.text, words) });
      if (out.length >= max) break;
    }
    return out;
  }

  // Community-submitted non-music ranges per video, kept so the lookup happens once.
  let segments = V.loadMap("aura.segments");

  /**
   * @param {string} id
   * @returns {SkipSegment[] | null} Null when unknown or expired.
   */
  function cachedSegments(id) {
    const hit = segments[id];
    if (!hit || !Array.isArray(hit.list)) return null;
    const ttl = hit.list.length ? 7 * 86400000 : 3600000;
    return Date.now() - (hit.at || 0) < ttl ? hit.list : null;
  }

  /**
   * @param {string} id
   * @param {SkipSegment[]} list
   */
  function cacheSegments(id, list) {
    if (!id) return;
    delete segments[id];
    segments[id] = { list: list || [], at: Date.now() };
    const keys = Object.keys(segments);
    if (keys.length > 400) delete segments[keys[0]];
    V.save("aura.segments", segments);
  }
})();
