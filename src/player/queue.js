(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    addToQueue: { get: () => addToQueue },
    cacheAhead: { get: () => cacheAhead },
    clearUpcoming: { get: () => clearUpcoming },
    dismiss: { get: () => dismiss },
    firstPlayableIndex: { get: () => firstPlayableIndex },
    jumpTo: { get: () => jumpTo },
    moveAt: { get: () => moveAt },
    persist: { get: () => persist },
    playNext: { get: () => playNext },
    playQueue: { get: () => playQueue },
    prefetchNext: { get: () => prefetchNext },
    removeAt: { get: () => removeAt },
    replaceCurrent: { get: () => replaceCurrent }
  });

  // Prepare only the next track as soon as playback starts. The standby element
  // buffers its stream without saving a download or waiting until the current song ends.
  function prefetchNext() {
    if (!V.wantsPlayback || V.repeat === "one") return;
    const ni = V.pickNextIndex();
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
    const ni = V.pickNextIndex();
    if (ni === -1 || ni === V.pos || !V.queue[ni]) return;
    V.prepNextSource(ni);
  }

  function persist() {
    V.queue.forEach(V.rememberRadioTrack);
    if (V.shuffle) {
      if (!V.shuffleOrder.length) V.buildShuffleOrder(); else V.syncShuffleOrder();
    }
    const saved = { extra: V.queue, pos: V.pos, shuffle: V.shuffle, repeat: V.repeat, shuffleOrder: V.shuffleOrder };
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
      V.shuffleOrder = [];
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
    V.shuffleOrder = [];
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
    // The commit may have moved the queue onto this very track; dropFromQueue keeps the
    // current entry, so inserting now would queue it twice in a row.
    if (V.current().id === track.id) return false;
    V.discardPrep();
    dropFromQueue(track.id);
    V.history = V.history.map(i => i > V.pos ? i + 1 : i);
    V.queue.splice(V.pos + 1, 0, track);
    if (V.shuffle) {
      if (!V.shuffleOrder.length) V.buildShuffleOrder(); else V.syncShuffleOrder();
      V.shuffleOrder = V.shuffleOrder.filter(id => id !== track.id);
      V.shuffleOrder.splice(V.shuffleOrder.indexOf(V.current().id) + 1, 0, track.id);
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
      if (V.current() && V.current().id === track.id && !V.shareExhausted) return false;
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
      const start = V.shuffleOrder.indexOf(V.queue[from].id);
      const end = V.shuffleOrder.indexOf(V.queue[to].id);
      V.shuffleOrder.splice(end, 0, V.shuffleOrder.splice(start, 1)[0]);
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
      if (!V.shuffleOrder.length) V.buildShuffleOrder(); else V.syncShuffleOrder();
      const retained = new Set(V.shuffleOrder.slice(0, V.shuffleOrder.indexOf(track.id) + 1));
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
    V.swapQueueEntry(V.pos, track);
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

})();
