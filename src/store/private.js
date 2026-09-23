(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    PRIVATE_QUEUE_KEY: { get: () => PRIVATE_QUEUE_KEY },
    privateOn: { get: () => privateOn },
    setPrivateSession: { get: () => setPrivateSession }
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
