(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    current: { get: () => current },
    emit: { get: () => emit },
    listeners: { get: () => listeners },
    offlineBlocksResume: { get: () => offlineBlocksResume },
    reportPlaybackFailure: { get: () => reportPlaybackFailure }
  });

  const listeners = [];
  // Listeners repaint the UI, and loadAndPlay emits from inside its try block: an
  // exception thrown while rendering used to unwind into that catch, be read as a failed
  // stream, and skip the track that was already playing fine. Keep them isolated.
  /**
   * @param {PlayerEvent} ev
   */
  function emit(ev) {
    listeners.forEach(fn => {
      try { fn(ev); }
      catch (e) { V.log("ui", "listener failed on " + ev.type + ": " + String((e && e.message) || e).slice(0, 120)); }
    });
  }

  /**
   * @returns {Track | null} The track at the queue position.
   */
  function current() { return V.pos >= 0 && V.pos < V.queue.length ? V.queue[V.pos] : null; }

  // Resuming a stream with no signal has nothing to resume from. A copy on the device
  // plays the same either way, and treating the two alike left a saved song silent after
  // a call or an alarm for as long as the phone stayed offline.
  function offlineBlocksResume() {
    return navigator.onLine === false && !/^(?:blob:|data:)/i.test(V.audio.src || "");
  }

  function reportPlaybackFailure(ev) {
    const track = ev.track || current();
    if (!track || !current() || current().id !== track.id) return;
    const token = V.loadingToken, generation = V.audioSessionGeneration;
    V.failedQueueIds.add(track.id);
    const canAdvance = () => token === V.loadingToken && generation === V.audioSessionGeneration &&
      current() && current().id === track.id && V.wantsPlayback && navigator.onLine !== false &&
      !V.platformBlocksAutoPlay() && !V.remotePlaybackActive() && V.pickNextIndex() !== -1;
    emit({ ...ev, willSkip: !!canAdvance() });
    // Finish the failing load's cleanup first, then advance without a UI timer.
    // A pause, focus interruption or new selection invalidates this continuation.
    // Failed IDs bound the traversal even with repeat-all; an exhausted queue
    // keeps its existing source retry instead of repeatedly generating more songs.
    Promise.resolve().then(() => {
      if (!canAdvance()) return;
      V.log("play", track.id + " unavailable; continuing to the next queued track");
      V.next(false);
    });
  }
})();
