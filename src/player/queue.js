(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    addToQueue: { get: () => addToQueue },
    buildShuffleOrder: { get: () => buildShuffleOrder },
    clearUpcoming: { get: () => clearUpcoming },
    countListen: { get: () => countListen },
    dismiss: { get: () => dismiss },
    firstPlayableIndex: { get: () => firstPlayableIndex },
    jumpTo: { get: () => jumpTo },
    listenClock: { get: () => listenClock, set: value => { listenClock = value; } },
    moveAt: { get: () => moveAt },
    nearEnd: { get: () => nearEnd },
    noteListening: { get: () => noteListening },
    persist: { get: () => persist },
    pickNextIndex: { get: () => pickNextIndex },
    playNext: { get: () => playNext },
    playQueue: { get: () => playQueue },
    prefetchNext: { get: () => prefetchNext },
    removeAt: { get: () => removeAt },
    replaceCurrent: { get: () => replaceCurrent },
    replayCurrent: { get: () => replayCurrent },
    resetListenTracking: { get: () => resetListenTracking },
    shuffleOrder: { get: () => shuffleOrder, set: value => { shuffleOrder = value; } },
    swapQueueEntry: { get: () => swapQueueEntry },
    syncShuffleOrder: { get: () => syncShuffleOrder }
  });

  // A track that was started is not a track that was heard. Counting the start put every
  // accidental tap, every skipped-through track and every failed one into "Jump back in"
  // and into the play counts that pick the recommendations. Require a third of the
  // track in actual playback, even for long songs and when playback reaches the end.
  let listenedSeconds = 0;
  let listenClock = 0;
  let listenCounted = false;
  let listenTrackId = null;

  function listenTarget(track) {
    const dur = V.getTime().dur || Number(track && track.duration);
    return Number.isFinite(dur) && dur > 0 ? dur / 3 : Infinity;
  }

  function resetListenTracking(track) {
    listenedSeconds = 0;
    listenClock = V.getTime().cur || 0;
    listenCounted = false;
    listenTrackId = (track && track.id) || null;
  }

  function countListen(reason) {
    const track = V.current();
    if (listenCounted || !track || track.id !== listenTrackId) return;
    if (listenedSeconds < listenTarget(track)) return;
    listenCounted = true;
    V.log("listen", track.id + " counted as played (" + reason + ")");
    Store.pushRecent(track, V.isSpokenWord(track) ? "podcast" : "music");
    if (reason === "listened through") cacheAhead();
  }

  function noteListening() {
    const track = V.current();
    if (!track || track.id !== listenTrackId) return;
    const now = V.getTime().cur || 0;
    const step = now - listenClock;
    listenClock = now;
    // Only forward movement at playing speed counts; a seek is not listening.
    if (!V.loadingInProgress && !(V.backend === "audio" && V.audio.seeking) &&
        (!V.isPaused() || (V.backend === "audio" && V.audio.ended)) && step > 0 && step < 5) listenedSeconds += step;
    if (!listenCounted && listenedSeconds >= listenTarget(track)) countListen("listened through");
  }

  // How close to the end the next track has to be before it is worth holding ready.
  function nearEnd() {
    const t = V.getTime();
    if (!t.dur) return false;
    return t.dur - t.cur <= Math.max(V.crossfadeSecs() + 6, 12);
  }

  // Prepare only the next track as soon as playback starts. The standby element
  // buffers its stream without saving a download or waiting until the current song ends.
  function prefetchNext() {
    if (!V.wantsPlayback || V.repeat === "one") return;
    const ni = pickNextIndex();
    if (!V.shareSession && V.repeat === "off" && V.radioUpcoming().length <= V.RADIO_LOW) {
      V.extendRadio();
    }
    if (ni === -1 || ni === V.pos) return;
    V.prepNextSource(ni);
  }

  // Keeping a copy is worth a track's data once the listener has stayed with it - not at
  // the first second, when the stream and the copy were being pulled down side by side
  // and a skip threw both away.
  function cacheAhead() {
    const cur = V.current();
    if (cur) V.autoCache(cur.id);
    if (V.repeat === "one") return;
    const ni = pickNextIndex();
    if (ni === -1 || ni === V.pos || !V.queue[ni]) return;
    V.prepNextSource(ni);
  }

  function persist() {
    V.queue.forEach(V.rememberRadioTrack);
    if (V.shuffle) {
      if (!shuffleOrder.length) buildShuffleOrder(); else syncShuffleOrder();
    }
    const saved = { extra: V.queue, pos: V.pos, shuffle: V.shuffle, repeat: V.repeat, shuffleOrder };
    if (V.shareSession) Store.sharedQueuePlayback({ id: V.shareSession, ...saved });
    else Store.saveQueue(saved);
    V.emit({ type: "queue" });
  }

  // A blocked track must never be the one that starts playing, whichever surface asked
  // for it. The requested start slides forward past blocked entries and wraps once, so a
  // playlist that opens with them still plays; when nothing in the list is playable the
  // caller gets false and the running queue is left untouched.
  function firstPlayableIndex(tracks, wanted) {
    const start = Math.max(0, Math.min(wanted || 0, tracks.length - 1));
    for (let i = start; i < tracks.length; i++) {
      if (!Store.isBlocked(tracks[i])) return i;
    }
    for (let i = 0; i < start; i++) {
      if (!Store.isBlocked(tracks[i])) return i;
    }
    return -1;
  }

  /**
   * Replaces the queue and starts playing. An empty list stops playback and clears it.
   * In a shared session the tracks are added to the session instead.
   * @param {Track[]} tracks
   * @param {number} [startIndex]
   * @param {{ shuffle?: boolean }} [options]
   * @returns {boolean} False when every track is blocked.
   */
  function playQueue(tracks, startIndex, options) {
    // While sharing, selecting music contributes to the session instead of replacing
    // other people's songs. The empty call still clears playback explicitly.
    if (V.shareSession && tracks.length) {
      let added = false;
      for (const track of tracks.slice(startIndex || 0)) added = addToQueue(track) || added;
      return added;
    }
    if (Store.rememberMedia && !(Store.privateSession && Store.privateSession())) tracks = tracks.map(t => Store.rememberMedia(t) || t);
    V.cancelRadioExtension();
    if (!tracks.length) {
      V.resetRadioSession();
      V.stopPlayback();
      V.stopAudio();
      V.stopYt();
      V.backend = "audio";
      V.queue = [];
      V.pos = -1;
      V.history = [];
      shuffleOrder = [];
      V.failedQueueIds.clear();
      V.swappedFor.clear();
      persist();
      return true;
    }
    const at = firstPlayableIndex(tracks, startIndex);
    if (at === -1) return false;
    // Apply an explicit playback order only after accepting the new queue. Changing
    // shuffle first would prefetch recommendations for the queue being replaced.
    if (options && typeof options.shuffle === "boolean") V.shuffle = options.shuffle;
    V.resetRadioSession();
    V.queue = tracks.slice();
    V.pos = at;
    V.history = [];
    shuffleOrder = [];
    V.failedQueueIds.clear();
    V.swappedFor.clear();
    persist();
    V.loadAndPlay(V.current());
    return true;
  }

  // Swiping the collapsed bar aside is a listener saying "done for now": the sound stops,
  // the lock screen card goes, and the queue empties so nothing is left playing behind a
  // bar nobody can see. Nothing is remembered about the dismissal - the next thing played
  // builds a queue again and the bar comes straight back with it.
  /** Stops playback and empties the queue. */
  function dismiss() {
    V.stopPlayback();
    V.setSleepTimer("off");
    V.stopAudio();
    V.stopYt();
    V.backend = "audio";
    playQueue([]);
  }

  // Queueing a song already in the queue used to add it a second time, so a listener
  // adding a favourite twice got it twice. Moving the copy already there is what they
  // meant; a track put up next is taken out of wherever it was sitting.
  function dropFromQueue(id) {
    const at = V.queue.findIndex((t, i) => i !== V.pos && t.id === id);
    if (at === -1) return false;
    V.queue.splice(at, 1);
    if (at < V.pos) V.pos--;
    V.history = V.history.filter(x => x !== at).map(x => x > at ? x - 1 : x);
    return true;
  }

  /**
   * Puts a track right after the current one, moving it if it is already queued.
   * @param {Track} track
   * @returns {boolean | void}
   */
  function playNext(track) {
    if (V.shareSession) return addToQueue(track);
    if (Store.rememberMedia && !(Store.privateSession && Store.privateSession())) track = Store.rememberMedia(track) || track;
    if (Store.isBlocked(track)) return;
    if (V.pos < 0) return playQueue([track], 0);
    if (V.current().id === track.id) return false;
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    V.discardPrep();
    dropFromQueue(track.id);
    V.history = V.history.map(i => i > V.pos ? i + 1 : i);
    V.queue.splice(V.pos + 1, 0, track);
    if (V.shuffle) {
      if (!shuffleOrder.length) buildShuffleOrder(); else syncShuffleOrder();
      shuffleOrder = shuffleOrder.filter(id => id !== track.id);
      shuffleOrder.splice(shuffleOrder.indexOf(V.current().id) + 1, 0, track.id);
    }
    persist();
    prefetchNext();
  }

  /**
   * @param {Track} track
   * @returns {boolean} False when it is blocked or already queued.
   */
  function addToQueue(track) {
    if (Store.rememberMedia && !(Store.privateSession && Store.privateSession())) track = Store.rememberMedia(track) || track;
    if (Store.isBlocked(track)) return false;
    if (V.shareSession) {
      if (V.current() && V.current().id === track.id && !V.shareExhausted) return false;
      const existing = V.queue.findIndex((t, i) => i > V.pos && t.id === track.id);
      if (existing !== -1 && !V.queue[existing].auraShareAuto) return false;
      V.cancelCrossfade();
      V.commitPendingPreparedStart("queue change");
      V.discardPrep();
      // A pending end-of-queue lookup was hunting for something to play, and this
      // contribution is that something. A late recommendation must not pile on after it.
      if (V.radioPromise) V.cancelRadioExtension();
      // Contributing a track is an explicit request to try it again, like selecting it;
      // a stale failure marker must not make the queue skip straight past the guest.
      V.failedQueueIds.delete(track.id);
      dropFromQueue(track.id);
      const nextAuto = V.queue.findIndex((t, i) => i > V.pos && t.auraShareAuto);
      const at = nextAuto === -1 ? V.queue.length : nextAuto;
      V.queue.splice(at, 0, Object.assign({}, track, { auraShareAuto: false }));
      V.history = V.history.map(i => i >= at ? i + 1 : i);
      if (V.pos < 0) {
        V.pos = at;
        persist();
        V.loadAndPlay(V.current());
      } else {
        persist();
        // The normal queue retains its last entry after ending. A shared queue must
        // wake for a new contribution, while an explicit Pause stays paused.
        if (V.shareExhausted) V.next(false);
        else prefetchNext();
      }
      return true;
    }
    if (V.pos < 0) return playQueue([track], 0);
    if (V.queue.some(t => t.id === track.id)) return false;
    V.queue.push(track);
    persist();
    prefetchNext();
    return true;
  }

  /**
   * @param {number} i Queue index; the current track cannot be removed.
   */
  function removeAt(i) {
    if (!Number.isInteger(i) || i < 0 || i >= V.queue.length || i === V.pos) return;
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    if (i === V.pos) return;
    V.discardPrep();
    V.queue.splice(i, 1);
    if (i < V.pos) V.pos--;
    V.history = V.history.filter(x => x !== i).map(x => x > i ? x - 1 : x);
    persist();
    prefetchNext();
  }

  /**
   * Moves an upcoming track. Played and current tracks stay where they are.
   * @param {number} from Queue index.
   * @param {number} to Queue index.
   */
  function moveAt(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || to < 0 || from >= V.queue.length || to >= V.queue.length || from === to) return;
    if (V.shuffle) {
      const upcoming = V.radioUpcoming();
      if (!upcoming.some(t => t.id === V.queue[from].id) || !upcoming.some(t => t.id === V.queue[to].id)) return;
      V.cancelCrossfade();
      V.commitPendingPreparedStart("queue change");
      if (V.queue[from].id === V.current().id || V.queue[to].id === V.current().id) return;
      V.discardPrep();
      const start = shuffleOrder.indexOf(V.queue[from].id);
      const end = shuffleOrder.indexOf(V.queue[to].id);
      shuffleOrder.splice(end, 0, shuffleOrder.splice(start, 1)[0]);
      persist();
      prefetchNext();
      return;
    }
    if (from <= V.pos || to <= V.pos || from >= V.queue.length || to >= V.queue.length || from === to) return;
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    if (from <= V.pos || to <= V.pos) return;
    V.discardPrep();
    const item = V.queue.splice(from, 1)[0];
    V.queue.splice(to, 0, item);
    V.history = V.history.map(i => i === from ? to :
      from < to && i > from && i <= to ? i - 1 :
      from > to && i >= to && i < from ? i + 1 : i);
    persist();
    prefetchNext();
  }

  /** Removes everything after the current track. */
  function clearUpcoming() {
    if (V.pos < 0) return;
    V.cancelRadioExtension();
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    V.discardPrep();
    const previous = V.queue;
    const track = V.current();
    if (V.shuffle) {
      if (!shuffleOrder.length) buildShuffleOrder(); else syncShuffleOrder();
      const retained = new Set(shuffleOrder.slice(0, shuffleOrder.indexOf(track.id) + 1));
      V.queue = V.queue.filter(t => retained.has(t.id));
    } else V.queue = V.queue.slice(0, V.pos + 1);
    V.history = V.history.map(i => V.queue.indexOf(previous[i])).filter(i => i >= 0);
    V.pos = V.queue.indexOf(track);
    V.failedQueueIds.clear();
    persist();
  }

  // Swap the playing entry for a different upload of the same song, keeping its place
  // in the queue so the rest of the listening session is undisturbed.
  /**
   * Swaps the playing entry for another upload of the same song.
   * @param {Track} track
   */
  function replaceCurrent(track) {
    if (!track || Store.isBlocked(track)) return;
    if (V.pos < 0 || V.pos >= V.queue.length) return playQueue([track], 0);
    V.discardPrep();
    V.failedQueueIds.delete(track.id);
    swapQueueEntry(V.pos, track);
    persist();
    V.loadAndPlay(track);
  }

  /**
   * @param {number} i Queue index.
   * @returns {boolean} False when the index is invalid or the track is blocked.
   */
  function jumpTo(i) {
    if (!Number.isInteger(i) || i < 0 || i >= V.queue.length) return false;
    if (Store.isBlocked(V.queue[i])) return false;
    V.history.push(V.pos);
    V.pos = i;
    V.failedQueueIds.delete(V.queue[i].id);
    persist();
    V.loadAndPlay(V.current());
    return true;
  }

  // Shuffle used to draw a fresh random index on every advance, so some tracks came round
  // twice while others never played at all, and turning it off restored nothing. The order
  // is drawn once and then followed like any other running order: one pass, every track.
  let shuffleOrder = [];

  function shuffleArtistKey(id) {
    const t = V.queue.find(x => x.id === id);
    return t ? (t.artistId || String(t.artist || "").trim().toLowerCase()) : "";
  }

  // A plain shuffle happily draws the same artist twice in a row. Walk the drawn order and,
  // wherever that happens, swap in the nearest later track by someone else - leaving it be
  // only when every track left shares that same artist, since there is nothing to swap for.
  function declumpByArtist(ids) {
    for (let i = 1; i < ids.length; i++) {
      const prevKey = shuffleArtistKey(ids[i - 1]);
      if (!prevKey || shuffleArtistKey(ids[i]) !== prevKey) continue;
      let j = -1;
      for (let k = i + 1; k < ids.length; k++) {
        if (shuffleArtistKey(ids[k]) !== prevKey) { j = k; break; }
      }
      if (j === -1) continue;
      const swap = ids[i]; ids[i] = ids[j]; ids[j] = swap;
    }
    return ids;
  }

  function buildShuffleOrder() {
    const curId = V.current() ? V.current().id : null;
    const rest = V.queue.map(t => t.id).filter(id => id !== curId);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = rest[i]; rest[i] = rest[j]; rest[j] = swap;
    }
    shuffleOrder = declumpByArtist((curId ? [curId] : []).concat(rest));
  }

  // Absorbs what the radio appended and what was removed, without redrawing the order.
  function syncShuffleOrder() {
    const live = new Set(V.queue.map(t => t.id));
    shuffleOrder = shuffleOrder.filter(id => live.has(id));
    for (const t of V.queue) if (shuffleOrder.indexOf(t.id) === -1) shuffleOrder.push(t.id);
  }

  // A different upload of the same song takes over the queue slot and, with it, the slot
  // in the drawn shuffle order. Leaving the order to resync would drop the old id and
  // append the new one, moving the playing track to the end of the pass so that every
  // track still waiting was skipped.
  function swapQueueEntry(i, track) {
    const old = V.queue[i];
    V.queue[i] = track;
    if (!old || old.id === track.id) return;
    const at = shuffleOrder.indexOf(old.id);
    if (at === -1) return;
    if (shuffleOrder.indexOf(track.id) === -1) shuffleOrder[at] = track.id;
    else shuffleOrder.splice(at, 1);
  }

  function playableIndexOf(id, usable) {
    for (let i = 0; i < V.queue.length; i++) {
      if (V.queue[i].id === id && i !== V.pos && !V.failedQueueIds.has(V.queue[i].id) && !Store.isBlocked(V.queue[i]) &&
          (!usable || usable(V.queue[i]))) return i;
    }
    return -1;
  }

  // usable narrows the choice further - to the songs saved on the device, with no signal.
  function pickNextIndex(usable) {
    if (V.shuffle && V.queue.length > 1) {
      if (!shuffleOrder.length) buildShuffleOrder(); else syncShuffleOrder();
      const curId = V.current() ? V.current().id : null;
      const at = curId ? shuffleOrder.indexOf(curId) : -1;
      for (let step = at + 1; step < shuffleOrder.length; step++) {
        const idx = playableIndexOf(shuffleOrder[step], usable);
        if (idx !== -1) return idx;
      }
      if (V.repeat === "all") {
        for (let step = 0; step <= at && step < shuffleOrder.length; step++) {
          const idx = playableIndexOf(shuffleOrder[step], usable);
          if (idx !== -1) return idx;
        }
      }
      return -1;
    }
    const ok = track => !V.failedQueueIds.has(track.id) && !Store.isBlocked(track) && (!usable || usable(track));
    for (let i = V.pos + 1; i < V.queue.length; i++) {
      if (ok(V.queue[i])) return i;
    }
    if (V.repeat === "all") {
      for (let i = 0; i <= V.pos; i++) {
        if (ok(V.queue[i])) return i;
      }
    }
    return -1;
  }

  function replayCurrent() {
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.seekTo(0);
    resetListenTracking(V.current());
    V.resumePlay();
  }
})();
