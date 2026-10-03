(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    PRIVATE_QUEUE_KEY: { get: () => PRIVATE_QUEUE_KEY },
    privateListening: { get: () => privateListening },
    privateOn: { get: () => privateOn },
    setPrivateSession: { get: () => setPrivateSession },
    setQueuePlaylist: { get: () => setQueuePlaylist }
  });

  // Hiding the feature has to disable it, not just its button: a switch nobody can see is
  // worse than no switch at all, and the listener who hid it is entitled to assume their
  // history is being kept.
  const PRIVATE_QUEUE_KEY = "aura.queue.private";

  /**
   * @returns {boolean} Whether a private session is running.
   */
  function privateOn() {
    return V.privateSession && V.settings.privateSession !== false;
  }

  // A playlist can be private by itself: the children's songs, the one for falling asleep,
  // whatever should not teach the recommendations anything. The player says which playlist
  // the queue was started from, and the playlist is asked each time, so switching it on
  // while it plays takes effect on the very next song. Whatever joins that queue later -
  // autoplay, a song put up next - is part of the same sitting and is kept out with it.
  // Held in memory only: the saved queue carries the playlist across a reload.
  let queuePlaylist = "";

  /**
   * @param {string | null | undefined} pid The playlist the play queue was started from, if any.
   */
  function setQueuePlaylist(pid) {
    queuePlaylist = typeof pid === "string" ? pid : "";
  }

  /**
   * @returns {boolean} Whether what plays now is kept out of history, stats and the caches
   *   that name a song: a private session, or a queue started from a private playlist.
   */
  function privateListening() {
    if (privateOn()) return true;
    const playlist = queuePlaylist ? V.getPlaylist(queuePlaylist) : null;
    return !!(playlist && playlist.private);
  }

  /**
   * @param {boolean} on
   * @returns {boolean} Whether a private session is running now.
   */
  function setPrivateSession(on) {
    const next = !!on && V.settings.privateSession !== false;
    if (next === V.privateSession) return privateOn();
    if (!next) { try { sessionStorage.removeItem(PRIVATE_QUEUE_KEY); } catch (e) {} }
    V.privateSession = next;
    V.save("aura.privateSession", V.privateSession);
    V.notify("privateSession");
    return privateOn();
  }
})();
