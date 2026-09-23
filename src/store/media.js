(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    matchingPodcastShow: { get: () => matchingPodcastShow },
    mediaKind: { get: () => mediaKind },
    mediaTracks: { get: () => mediaTracks },
    rememberMedia: { get: () => rememberMedia }
  });

  /**
   * Decides whether a track is music or a podcast episode, using any stored record of it first.
   * @param {Track | null | undefined} track
   * @returns {MediaKind}
   */
  function mediaKind(track) {
    if (!track) return "music";
    if (track.kind === "podcast" || track.kind === "music") return track.kind;
    const known = V.library.find(t => t.id === track.id && t.kind) ||
      V.recents.find(t => t.id === track.id && t.kind) || V.downloads[track.id] ||
      (V.listeningProfile.tracks[track.id] || {}).track;
    if (known && (known.kind === "podcast" || known.kind === "music")) return known.kind;
    if (track.podcast || matchingPodcastShow(track)) return "podcast";
    // Old records have no kind. Only migrate titles that identify the format outright;
    // a long recording alone could just as easily be a concert or an album.
    const words = " " + V.foldText(track.title) + " ";
    if (/ (podcast|פודקאסט) /.test(words) || / (episode|פרק) [0-9]+ /.test(words)) return "podcast";
    return "music";
  }

  /**
   * @param {Track | null | undefined} track
   * @returns {PodcastShow | null} The known show this episode belongs to.
   */
  function matchingPodcastShow(track) {
    if (!track) return null;
    return V.podcastShows_().find(show => show.name &&
      ((show.channelId && track.artistId === show.channelId) ||
        (show.channel && V.showKey(track.artist) === V.showKey(show.channel))) &&
      V.matchesQuery(show.name, track.title)) || null;
  }

  /**
   * @param {Track[]} tracks
   * @param {MediaFilter} [kind]
   * @returns {Track[]} A new array.
   */
  function mediaTracks(tracks, kind) {
    return !kind || kind === "all" ? tracks.slice() : tracks.filter(t => mediaKind(t) === kind);
  }

  // An explicit episode from a show row can correct an older copy of the same video.
  // Keep counts, dates, memberships and positions; only its media identity changes.
  /**
   * Marks a podcast episode as one everywhere it is stored.
   * @param {Track} track
   * @returns {Track} The track with `kind` and `podcast` filled in when it is an episode.
   */
  function rememberMedia(track) {
    if (!track || !track.id) return track;
    const kind = mediaKind(track);
    const known = [V.findTrack(track.id), V.downloads[track.id], V.recents.find(t => t.id === track.id),
      (V.listeningProfile.tracks[track.id] || {}).track].find(t => t && t.podcast);
    const show = matchingPodcastShow(track);
    const podcast = kind === "podcast" ? String(track.podcast || (known && known.podcast) || (show && show.name) || "") : "";
    const normalized = kind === "podcast" ? Object.assign({}, track, { kind, podcast }) : track;
    if (kind !== "podcast") return normalized;
    let changed = false;
    const update = t => {
      if (t && t.id === track.id && (t.kind !== kind || t.podcast !== podcast)) {
        t.kind = kind; t.podcast = podcast; changed = true;
      }
    };
    V.library.forEach(update); V.recents.forEach(update); update(V.downloads[track.id]);
    update((V.listeningProfile.tracks[track.id] || {}).track);
    if (changed) {
      V.save("aura.library", V.library); V.save("aura.recents", V.recents);
      V.save("aura.downloads", V.downloads); V.save("aura.listeningProfile", V.listeningProfile);
      V.notify("library");
    }
    return normalized;
  }
})();
