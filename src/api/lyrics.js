(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    getLyrics: { get: () => getLyrics },
    lyricsQuery: { get: () => lyricsQuery }
  });

  // Uploads are titled for YouTube, not for a lyrics database: "Artist - Title (Official
  // Video)" on a channel called "ArtistVEVO", and a runtime that includes an intro. All
  // three were sent verbatim to an exact-match endpoint, so almost everything 404'd.
  const TITLE_NOISE = /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|hd|hq|4k|mv|visuali[sz]er|remaster(?:ed)?|explicit|clean|full|live|version|clip)\b[^)\]]*[)\]]/gi;

  const TITLE_NOISE_HE = /\s*[([][^)\]]*(?:קליפ|רשמי|מילים|לייב|אודיו|הופעה חיה)[^)\]]*[)\]]/g;

  /**
   * The title and artist to look lyrics up by, cleaned of YouTube naming.
   * @param {Track} track
   * @returns {{ title: string, artist: string }}
   */
  function lyricsQuery(track) {
    let title = String((track && track.title) || "")
      .replace(TITLE_NOISE, " ")
      .replace(TITLE_NOISE_HE, " ")
      .replace(/\s*[([]\s*[)\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let artist = String((track && track.artist) || "")
      .replace(/\s*-\s*topic\s*$/i, "")
      .replace(/\s*vevo\s*$/i, "")
      .replace(/\s*official\s*$/i, "")
      .trim();
    // "Artist - Title" is how nearly every music upload is named, and the name in the
    // title is the real one - the channel is often a label or a reuploader.
    const split = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(title);
    if (split) {
      artist = split[1].trim() || artist;
      title = split[2].trim();
    }
    // Takes the opening bracket with it, so "STAY (feat. X" does not become "STAY (".
    title = title
      .replace(/\s*[([]?\s*\b(?:feat|ft|featuring)\b\.?\s+.*$/i, "")
      .replace(/[\s\-–—([,]+$/, "")
      .trim();
    return { title, artist };
  }

  function pickLyrics(list, duration, artist) {
    const wantedArtist = V.matchTokens(artist || "");
    const usable = (list || []).filter(x => x && (x.syncedLyrics || x.plainLyrics))
      // A YouTube runtime rarely equals the release runtime, but a candidate minutes
      // away is a different recording, and often a different song.
      .filter(x => !(duration > 0 && x.duration > 0 && Math.abs(x.duration - duration) > Math.max(20, duration * 0.15)))
      .filter(x => !wantedArtist.length || V.coverage(wantedArtist, V.matchTokens(x.artistName)) > 0);
    if (!usable.length) return null;
    const score = x => (x.syncedLyrics ? 0 : 1000) +
      (duration && x.duration ? Math.abs(x.duration - duration) : 500);
    return usable.slice().sort((a, b) => score(a) - score(b))[0];
  }

  /**
   * @param {Track} track
   * @returns {Promise<LyricsEntry | null>} Null when no lyrics were found.
   * @throws {Error} When the lookup failed, so a miss is never cached for a network error.
   */
  async function getLyrics(track) {
    const q = lyricsQuery(track);
    if (!q.title) return null;
    const duration = Math.round((track && track.duration) || 0);
    // Transport trouble has to stay distinguishable from a clean miss: the caller caches
    // a miss as "no lyrics exist", and caching it for a request that merely failed - a
    // tunnel, a rate limit - kept lyrics away from that track until the cache rotated.
    const ask = async path => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch("https://lrclib.net" + path, { signal: ctl.signal, headers: { "Lrclib-Client": "Aura Music" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };
    let failed = false;
    const attempt = async path => {
      try { return await ask(path); } catch (e) { failed = true; return null; }
    };
    let found = null;
    // Search rather than exact-get: a YouTube runtime rarely equals the release runtime,
    // so the closest candidate is chosen here instead of being rejected by the server.
    found = pickLyrics(await attempt("/api/search?" + new URLSearchParams({
      track_name: q.title, artist_name: q.artist
    })), duration);
    if (!found && q.artist) {
      found = pickLyrics(await attempt("/api/search?" + new URLSearchParams({ q: q.title + " " + q.artist })), duration);
    }
    // The title alone finds every song of that name; the performer, when known, still
    // has to appear on the candidate, or "Hello" comes back with someone else's words.
    if (!found) found = pickLyrics(await attempt("/api/search?" + new URLSearchParams({ q: q.title })), duration, q.artist);
    if (!found && failed) throw new Error("lyrics lookup failed");
    return found;
  }
})();
