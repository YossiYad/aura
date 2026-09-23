(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    cancelRadioExtension: { get: () => cancelRadioExtension },
    extendRadio: { get: () => extendRadio },
    playFromQueueHistory: { get: () => playFromQueueHistory },
    queueHistory: { get: () => queueHistory },
    queueHistorySession: { get: () => queueHistorySession },
    RADIO_LOW: { get: () => RADIO_LOW },
    radioGeneration: { get: () => radioGeneration },
    radioPromise: { get: () => radioPromise },
    radioUpcoming: { get: () => radioUpcoming },
    rememberRadioTrack: { get: () => rememberRadioTrack },
    resetRadioSession: { get: () => resetRadioSession },
    waitForRadioAtEnd: { get: () => waitForRadioAtEnd }
  });

  // Keep enough upcoming songs to browse and reorder, topping up as playback advances.
  const RADIO_AHEAD = 12;
  const RADIO_LOW = 3;

  let radioPromise = null;
  let radioGeneration = 0;
  // These exclusions belong to this queue's listening session, never to saved taste.
  // Keep removed entries too, so clearing or pruning a tail cannot recommend it again.
  const radioSessionIds = new Set();
  const radioSessionSongs = new Set();
  const sessionQueueTracks = new Map();
  let queueHistorySession = 0;

  function radioArtistKey(name) {
    return String(name || "").normalize("NFKC").toLowerCase()
      .replace(/\s*-\s*topic\s*$/i, "").replace(/\s+/g, " ").trim();
  }

  function radioSongKey(track) {
    if (!track || V.isSpokenWord(track)) return "";
    const artist = radioArtistKey(track.artist);
    // Different upload IDs can carry the same recording. Ignore presentation labels,
    // but retain version names such as live, acoustic and remix, and episode titles.
    const title = String(track.title || "").normalize("NFKC").toLowerCase()
      .replace(/[([]\s*(?:(?:official|music|video|audio|lyrics?|hd|hq|4k)\s*)+[)\]]/gi, "")
      .replace(/\s+/g, " ").trim();
    return artist && title ? JSON.stringify([artist, title]) : "";
  }

  function rememberRadioTrack(track) {
    if (!track || !track.id) return;
    sessionQueueTracks.set(track.id, Object.assign({}, track));
    radioSessionIds.add(track.id);
    const key = radioSongKey(track);
    if (key) radioSessionSongs.add(key);
  }

  function resetRadioSession() {
    queueHistorySession++;
    radioSessionIds.clear();
    radioSessionSongs.clear();
    sessionQueueTracks.clear();
  }

  /**
   * @returns {QueueHistoryEntry[]} Everything queued this session, in play order.
   */
  function queueHistory() {
    const cur = V.current();
    const upcoming = radioUpcoming();
    const upcomingIds = new Set(upcoming.map(t => t.id));
    const live = new Map(V.queue.map(t => [t.id, t]));
    // The archive remembers membership, but its insertion order goes stale after
    // shuffle, reordering or replay. Display the active running order instead.
    const ordered = V.shuffle ? V.shuffleOrder.map(id => live.get(id)).filter(Boolean) : V.queue;
    const entries = [];
    const seen = new Set();
    const append = (track, status) => {
      if (!track || seen.has(track.id)) return;
      seen.add(track.id);
      entries.push({ track: Object.assign({}, track), status });
    };
    ordered.forEach(track => {
      if ((!cur || track.id !== cur.id) && !upcomingIds.has(track.id)) append(track, "earlier");
    });
    append(cur, "current");
    upcoming.forEach(track => append(track, "upcoming"));
    sessionQueueTracks.forEach(track => {
      if (!live.has(track.id)) append(track, "removed");
    });
    return entries;
  }

  /**
   * Plays an entry from the queue history, moving it up next when needed.
   * @param {string} id
   * @returns {boolean} False when the track is unknown or blocked.
   */
  function playFromQueueHistory(id) {
    const track = sessionQueueTracks.get(id);
    if (!track || Store.isBlocked(track)) return false;
    if (V.current() && V.current().id === id) return true;
    // Explicit replay is allowed. Move just this song next so revisiting an old entry
    // does not replay all the intervening songs or replace the listener's upcoming tail.
    if (radioUpcoming().some(t => t.id === id)) return V.jumpTo(V.queue.findIndex(t => t.id === id));
    V.playNext(track);
    // A shared queue places a contribution ahead of its automatic picks, not at pos + 1.
    return V.jumpTo(V.queue.findIndex(t => t.id === id));
  }

  function cancelRadioExtension() {
    radioGeneration++;
    radioPromise = null;
  }

  /**
   * @returns {Track[]} What will play after the current track, in order.
   */
  function radioUpcoming() {
    let upcoming = V.queue.slice(V.pos + 1);
    if (V.shuffle && V.queue.length > 1) {
      if (!V.shuffleOrder.length) V.buildShuffleOrder(); else V.syncShuffleOrder();
      const at = V.shuffleOrder.indexOf(V.current() && V.current().id);
      const byId = new Map(V.queue.map(t => [t.id, t]));
      upcoming = V.shuffleOrder.slice(at + 1).map(id => byId.get(id)).filter(Boolean);
    }
    return upcoming.filter(t => !V.failedQueueIds.has(t.id) && !Store.isBlocked(t));
  }

  // What the next stretch of radio is built from, best first: the track that just played,
  // then the few before it, then what this listener plays most. One seed used to be the
  // whole story, and one seed runs out - an instance with no related list for that video,
  // an artist whose results are all in the queue already - and when it did, the queue
  // ended and the music simply stopped in the middle of listening.
  function radioSeeds() {
    const seeds = [];
    const push = t => { if (t && t.id && !seeds.some(s => s.id === t.id)) seeds.push(t); };
    push(V.current());
    for (let i = V.pos - 1; i >= 0 && i > V.pos - 4; i--) push(V.queue[i]);
    if (!V.shareSession) (Store.topListeningTracks(6) || []).forEach(push);
    else Array.from(sessionQueueTracks.values()).filter(t => !t.auraShareAuto).reverse().slice(0, 4).forEach(push);
    return seeds.slice(0, 6);
  }

  function extendRadio() {
    if (!V.shareSession && !Store.settings().autoplay) return Promise.resolve(false);
    // The end-of-track path and the early prefetch path can arrive here together. Both
    // must wait for the same request: treating "already running" as "nothing found"
    // strands an ended player even when that request adds songs a moment later.
    if (radioPromise) return radioPromise;
    const cur = V.current();
    const ahead = V.shareSession ? 1 : RADIO_AHEAD;
    if (!cur || radioUpcoming().length >= ahead) return Promise.resolve(false);
    const generation = radioGeneration;
    let request;
    request = (async () => {
      try {
        const valid = () => generation === radioGeneration && (V.shareSession || Store.settings().autoplay);
        const remaining = () => Math.max(0, ahead - radioUpcoming().length);
        const songsOnly = Store.settings().musicOnly !== false;
        const spoken = V.isSpokenWord(cur);
        const liked = V.shareSession ? [] : Store.likedTracks();
        // With no signal only what is on the device can play. The tail used to fill with
        // liked songs that were not, and playback stopped at the first of them with saved
        // music further down. Nothing is asked of the network either: it cannot answer.
        const saved = navigator.onLine === false ? await V.localIds().catch(() => new Set()) : null;
        if (!valid()) return false;
        const familiar = (V.shareSession ? Array.from(sessionQueueTracks.values()).filter(t => !t.auraShareAuto) : liked.concat(Store.topListeningTracks(60), Store.library(), Store.recents(),
          saved && Store.downloadedTracks ? Store.downloadedTracks() : []))
          .filter(t => t && t.id && !Store.isBlocked(t) && !V.isSpokenWord(t));
        const familiarIds = new Set(familiar.map(t => t.id));
        const likedIds = new Set(liked.map(t => t.id));
        const artistKey = radioArtistKey;
        const artists = new Set(familiar.concat(cur).map(t => artistKey(t.artist)).filter(Boolean));
        const artistIds = new Set(familiar.concat(cur).map(t => t.artistId).filter(Boolean));
        const knownArtist = t => (t.artistId && artistIds.has(t.artistId)) || artists.has(artistKey(t.artist));
        const inTaste = t => familiarIds.has(t.id) || knownArtist(t);
        const sameShow = t => {
          if (!V.isSpokenWord(t)) return false;
          const show = t.podcast || (Store.matchingPodcastShow && (Store.matchingPodcastShow(t) || {}).name);
          const currentShow = cur.podcast || (Store.matchingPodcastShow && (Store.matchingPodcastShow(cur) || {}).name);
          if (currentShow) return !!show && radioArtistKey(show) === radioArtistKey(currentShow);
          return (cur.artistId && t.artistId === cur.artistId) ||
            (!!cur.artist && radioArtistKey(t.artist) === radioArtistKey(cur.artist));
        };
        // After an episode, more of that show - not a song, and not another show's episode.
        // Episodes run far longer than the song cap, so that cap cannot apply here.
        const ok = t => t && t.id && !radioSessionIds.has(t.id) && !radioSessionSongs.has(radioSongKey(t)) &&
          !V.failedQueueIds.has(t.id) && !Store.isBlocked(t) && (!saved || saved.has(t.id)) && t.duration > 60 && (spoken
          ? t.duration < 4 * 3600 && sameShow(t)
          : !V.isSpokenWord(t) && t.duration < 900 && (!songsOnly || Api.looksLikeMusic(t)));
        let added = 0;
        // Related lists provide discovery, while the listener's music anchors most of
        // the tail. With no profile yet, the selected song is the available signal.
        let discoveries = radioUpcoming().filter(t => !inTaste(t)).length;
        const discoveryLimit = familiar.length ? 3 : RADIO_AHEAD;
        const score = t => likedIds.has(t.id) ? 3 : familiarIds.has(t.id) ? 2 : knownArtist(t) ? 1 : 0;
        // Publish each usable batch immediately. Later lookups can fill the rest without
        // holding the next song hostage to a slow provider. Recheck the live queue on every
        // batch because the listener can add, clear or replace it while a request is pending.
        const take = (list, related = false) => {
          if (!valid()) return true;
          const live = new Set(V.queue.map(t => t.id));
          const adds = [];
          const want = remaining();
          if (!want) return true;
          const ranked = (list || []).filter(Boolean).slice().sort((a, b) => score(b) - score(a));
          const known = ranked.filter(t => inTaste(t));
          const novel = ranked.filter(t => !inTaste(t));
          const candidates = [];
          while (known.length || novel.length) {
            candidates.push(...known.splice(0, 3), ...novel.splice(0, 1));
          }
          for (const t of candidates) {
            if (live.has(t.id)) continue;
            if (!ok(t)) continue;
            const discovery = !spoken && !inTaste(t);
            if (discovery && (!related || discoveries >= discoveryLimit)) continue;
            rememberRadioTrack(t);
            adds.push(V.shareSession ? Object.assign({}, t, { auraShareAuto: true }) : t);
            if (discovery) discoveries++;
            if (adds.length >= want) break;
          }
          if (adds.length) {
            V.queue = V.queue.concat(adds);
            added += adds.length;
            V.persist();
            const ni = V.pickNextIndex();
            if (ni !== -1 && ni !== V.pos) V.prepNextSource(ni);
          }
          return !remaining();
        };
        const seeds = saved ? [] : radioSeeds().filter(t => !Store.isBlocked(t) && (spoken ? sameShow(t) : !V.isSpokenWord(t)));
        if (saved && !spoken) take(familiar);
        for (const seed of seeds) {
          if (!valid()) return false;
          try {
            const info = await Api.resolve(seed.id, V.streamOptions(seed.id));
            if (take(info.related, true)) break;
          } catch (e) {}
          // Saved favorites and actual listening are stronger evidence than unrelated
          // provider suggestions, and remain available when a related list is sparse.
          if (!spoken && take(familiar)) break;
        }
        if (remaining()) {
          const searched = new Set();
          for (const seed of seeds) {
            if (!valid()) return false;
            const q = seed.artist || seed.title;
            if (!q || searched.has(artistKey(q))) continue;
            searched.add(artistKey(q));
            try {
              const res = await Api.search(q);
              // Search ranking alone is not evidence of the requested artist.
              if (take((res.items || []).filter(t => t && (spoken || inTaste(t))))) break;
            } catch (e) {}
          }
        }
        if (!valid()) return false;
        if (!added) {
          V.log("radio", "nothing new to add from " + seeds.length + " seed(s)" +
            (navigator.onLine === false ? " while offline" : ""));
          return false;
        }
        V.log("radio", "queue extended with " + added + " tracks");
        return true;
      } finally {
        if (radioPromise === request) radioPromise = null;
      }
    })();
    radioPromise = request;
    return request;
  }

  const RADIO_END_WAIT_MS = 1200;

  function waitForRadioAtEnd() {
    const request = extendRadio();
    return new Promise(resolveP => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveP(value);
      };
      const timer = setTimeout(() => finish(false), RADIO_END_WAIT_MS);
      request.then(ok => finish(!!ok), () => finish(false));
    });
  }
})();
