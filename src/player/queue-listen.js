(function () {
  const V = window.Aura.player;
  // Counting a listen: the clock of the current song and the point at which it counts as played.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    countListen: { get: () => countListen },
    listenClock: { get: () => listenClock, set: value => { listenClock = value; } },
    nearEnd: { get: () => nearEnd },
    noteListening: { get: () => noteListening },
    resetListenTracking: { get: () => resetListenTracking }
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
    if (reason === "listened through") V.cacheAhead();
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
})();
