(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    cycleRepeat: { get: () => cycleRepeat },
    prev: { get: () => prev },
    setShuffle: { get: () => setShuffle }
  });

  /** Restarts the track when past three seconds, otherwise goes to the one before. */
  function prev() {
    // While the next song is still loading, the clock belongs to the outgoing one; a
    // Previous then means the song before, not a restart of what is leaving.
    V.commitPendingPreparedStart("previous");
    if (!V.loadingInProgress && V.getTime().cur > 3) { V.seekTo(0); return; }
    let target = -1;
    while (V.history.length && target < 0) {
      const i = V.history.pop();
      if (i >= 0 && i < V.queue.length && i !== V.pos && !Store.isBlocked(V.queue[i])) target = i;
    }
    if (target < 0) {
      // Forward already wraps under repeat-all, so back should too - otherwise the first
      // track is a dead end in a mode whose whole point is that there is no end.
      for (let step = 1; step < V.queue.length; step++) {
        let i = V.pos - step;
        if (i < 0) {
          if (V.repeat !== "all") break;
          i += V.queue.length;
        }
        if (!Store.isBlocked(V.queue[i])) { target = i; break; }
      }
      if (target < 0) { V.seekTo(0); return; }
    }
    V.pos = target;
    if (V.current()) V.failedQueueIds.delete(V.current().id);
    V.persist();
    V.loadAndPlay(V.current());
  }

  /**
   * @param {boolean} v
   */
  function setShuffle(v) {
    if (V.shareSession) return;
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    V.discardPrep();
    V.shuffle = v;
    if (v) V.buildShuffleOrder(); else V.shuffleOrder = [];
    V.persist();
    V.prefetchNext();
  }
  /**
   * @returns {RepeatMode} The new mode: off, then all, then one.
   */
  function cycleRepeat() {
    if (V.shareSession) return "off";
    V.cancelCrossfade();
    V.commitPendingPreparedStart("queue change");
    V.discardPrep();
    V.repeat = V.repeat === "off" ? "all" : V.repeat === "all" ? "one" : "off";
    V.persist();
    if (V.repeat !== "one") V.prefetchNext();
    return V.repeat;
  }
})();
