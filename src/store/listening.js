(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    artistIdFor: { get: () => artistIdFor },
    downloadedTracks: { get: () => downloadedTracks },
    forgetDownload: { get: () => forgetDownload },
    pushRecent: { get: () => pushRecent },
    rememberDownload: { get: () => rememberDownload },
    topListeningArtists: { get: () => topListeningArtists },
    topListeningPodcasts: { get: () => topListeningPodcasts },
    topListeningTracks: { get: () => topListeningTracks }
  });

  /**
   * Records a play in history and in the listening profile. Does nothing in a private session.
   * @param {Track} track
   * @param {MediaKind} [kind] Overrides the stored classification.
   */
  function pushRecent(track, kind) {
    // The whole of private listening is this line. Everything downstream of recents and the
    // listening profile - Home's rows, the stats page, what the AI is told this listener
    // likes - is fed from here, so a play that never lands here never reaches any of them.
    if (V.privateOn()) return;
    track = V.rememberMedia(kind === "podcast" || kind === "music" ? Object.assign({}, track, { kind }) : track);
    const now = Date.now();
    const classified = kind === "podcast" || kind === "music" ? kind : V.mediaKind(track);
    V.recents = V.recents.filter(t => t.id !== track.id);
    V.recents.unshift({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album || "",
      thumb: track.thumb,
      duration: track.duration,
      views: track.views != null ? track.views : null,
      artistId: track.artistId || null,
      artistVerified: track.artistVerified === true,
      artistThumb: track.artistThumb || "",
      kind: classified,
      podcast: classified === "podcast" ? String(track.podcast || "") : "",
      at: now
    });
    V.recents = V.recents.slice(0, 50);
    const trackStat = V.listeningProfile.tracks[track.id] || { plays: 0 };
    V.listeningProfile.tracks[track.id] = Object.assign({}, trackStat, {
      plays: trackStat.plays + 1,
      lastPlayed: now,
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist || "",
        album: track.album || "",
        thumb: track.thumb || "",
        duration: track.duration || 0,
        artistId: track.artistId || null,
        artistVerified: track.artistVerified === true,
        artistThumb: track.artistThumb || "",
        kind: classified,
        podcast: classified === "podcast" ? String(track.podcast || "") : ""
      }
    });
    const ids = Object.keys(V.listeningProfile.tracks);
    if (ids.length > V.PROFILE_TRACK_CAP) {
      ids.sort((a, b) => (V.listeningProfile.tracks[a].lastPlayed || 0) - (V.listeningProfile.tracks[b].lastPlayed || 0));
      ids.slice(0, ids.length - V.PROFILE_TRACK_CAP).forEach(id => { delete V.listeningProfile.tracks[id]; });
    }
    const artist = String(track.artist || "").trim();
    if (artist && classified === "music") {
      const artistStat = V.listeningProfile.artists[artist] || { plays: 0 };
      V.listeningProfile.artists[artist] = {
        plays: artistStat.plays + 1,
        lastPlayed: now,
        thumb: track.artistThumb || track.thumb || artistStat.thumb || "",
        // Without this, a top artist was only ever a name, and a name is all a search can
        // be given. Kept so the tile can open the artist instead of guessing at them.
        artistId: track.artistId || artistStat.artistId || null
      };
    }
    V.save("aura.recents", V.recents);
    V.save("aura.listeningProfile", V.listeningProfile);
    V.notify("recents");
  }

  /**
   * @param {Track} track
   */
  function rememberDownload(track) {
    if (!track || !track.id) return;
    track = V.rememberMedia(track);
    const classified = V.mediaKind(track);
    V.downloads[track.id] = {
      id: track.id,
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
      thumb: track.thumb || "",
      duration: track.duration || 0,
      artistId: track.artistId || null,
      artistVerified: track.artistVerified === true,
      artistThumb: track.artistThumb || "",
      kind: classified,
      podcast: classified === "podcast" ? String(track.podcast || "") : "",
      at: Date.now()
    };
    V.save("aura.downloads", V.downloads);
    V.notify("downloads");
  }

  /**
   * @param {string} id
   */
  function forgetDownload(id) {
    if (!V.downloads[id]) return;
    delete V.downloads[id];
    V.save("aura.downloads", V.downloads);
    V.notify("downloads");
  }

  /**
   * Downloaded tracks, newest first.
   * @param {MediaFilter} [kind]
   * @returns {Track[]}
   */
  function downloadedTracks(kind) {
    return V.mediaTracks(Object.keys(V.downloads).map(id => V.downloads[id]).filter(Boolean), kind)
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  /**
   * Most played tracks, with their play counts.
   * @param {number} [limit] Default 12.
   * @param {MediaFilter} [kind] Default "music".
   * @returns {Track[]}
   */
  function topListeningTracks(limit, kind) {
    const wanted = kind === "all" ? null : (kind === "podcast" ? "podcast" : "music");
    return Object.values(V.listeningProfile.tracks)
      .filter(item => item && item.track && item.track.id)
      .filter(item => !wanted || V.mediaKind(item.track) === wanted)
      .sort((a, b) => (b.plays - a.plays) || (b.lastPlayed - a.lastPlayed))
      .slice(0, limit || 12)
      .map(item => Object.assign({}, item.track, { plays: item.plays, lastPlayed: item.lastPlayed }));
  }

  // The channel behind a name, from wherever it is already known - the profile for anyone
  // listened to since this was recorded, and the tracks themselves for everyone before.
  /**
   * @param {string} name
   * @returns {string | null} The channel id behind an artist name, if any stored record has it.
   */
  function artistIdFor(name) {
    const key = String(name || "").trim();
    if (!key) return null;
    const entry = V.listeningProfile.artists[key];
    if (entry && entry.artistId) return entry.artistId;
    const lower = key.toLowerCase();
    const match = t => t && t.artistId && String(t.artist || "").trim().toLowerCase() === lower;
    const fromRecents = V.recents.find(match);
    if (fromRecents) return fromRecents.artistId;
    const fromLibrary = V.library.find(match);
    if (fromLibrary) return fromLibrary.artistId;
    const ids = Object.keys(V.listeningProfile.tracks);
    for (const id of ids) {
      const t = (V.listeningProfile.tracks[id] || {}).track;
      if (match(t)) return t.artistId;
    }
    return null;
  }

  /**
   * @param {number} [limit] Default 12.
   * @returns {{ name: string, plays: number, lastPlayed: number, thumb: string, artistId: string | null }[]}
   */
  function topListeningArtists(limit) {
    const artists = new Map();
    Object.values(V.listeningProfile.tracks).forEach(item => {
      const track = item && item.track;
      const name = String((track && track.artist) || "").trim();
      if (!name || V.mediaKind(track) !== "music") return;
      const previous = artists.get(name) || { name, plays: 0, lastPlayed: 0, thumb: "", artistId: null };
      previous.plays += Number(item.plays) || 0;
      previous.lastPlayed = Math.max(previous.lastPlayed, Number(item.lastPlayed) || 0);
      previous.thumb = track.artistThumb || track.thumb || previous.thumb;
      previous.artistId = track.artistId || previous.artistId;
      artists.set(name, previous);
    });
    return Array.from(artists.values())
      .sort((a, b) => (b.plays - a.plays) || (b.lastPlayed - a.lastPlayed))
      .slice(0, limit || 12);
  }

  /**
   * @param {number} [limit] Default 12.
   * @returns {{ name: string, channel: string, channelId: string, plays: number, lastPlayed: number }[]}
   */
  function topListeningPodcasts(limit) {
    const shows = new Map();
    Object.values(V.listeningProfile.tracks).forEach(item => {
      const track = item && item.track;
      if (!track || V.mediaKind(track) !== "podcast") return;
      const channel = String(track.artist || "").trim();
      const known = V.matchingPodcastShow(track);
      const name = String(track.podcast || (known && known.name) || channel).trim();
      if (!name) return;
      const key = V.showKey(name);
      const previous = shows.get(key) || {
        name, channel, channelId: track.artistId || (known && known.channelId) || "",
        plays: 0, lastPlayed: 0
      };
      previous.plays += Number(item.plays) || 0;
      previous.lastPlayed = Math.max(previous.lastPlayed, Number(item.lastPlayed) || 0);
      previous.channelId = previous.channelId || track.artistId || "";
      shows.set(key, previous);
    });
    return Array.from(shows.values())
      .sort((a, b) => (b.plays - a.plays) || (b.lastPlayed - a.lastPlayed))
      .slice(0, limit || 12);
  }
})();
