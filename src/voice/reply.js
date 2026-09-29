(function () {
  const V = window.Aura.voice;
  // The spoken reply.
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
    reply: { get: () => reply },
    stopReply: { get: () => stopReply }
  });

  let pendingReply = null;

  /** Stops a spoken reply. */
  function stopReply() { if (pendingReply) pendingReply(); }

  /**
   * Speaks a short reply with an on-device voice, when replies are on.
   * @param {Record<string, string>} messages Text by language code, e.g. { he: "...", en: "..." }.
   * @param {string} [language] Preferred language; default "he".
   * @returns {Promise<boolean>} Whether the reply was spoken to the end.
   */
  function reply(messages, language) {
    stopReply();
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance || !V.repliesOn()) return Promise.resolve(false);
    // iOS speaks only inside a tap, and a reply comes seconds after one: it never starts,
    // holds the song back for the whole eight-second guard, and leaves one more audio client
    // in front of the next request's microphone. There the reply stays on screen.
    if (V.isIOS && !(navigator.userActivation && navigator.userActivation.isActive)) {
      V.log("spoken reply skipped: iOS speaks only right after a tap");
      return Promise.resolve(false);
    }
    const voices = synth.getVoices().filter(voice => voice.localService === true);
    // Voice tags arrive as "he-IL" on most engines and "he_IL" on some Android builds.
    const langOf = v => String(v.lang || "").replace("_", "-");
    const preferred = String(language || "he").split(/[-_]/)[0];
    const voice = voices.find(v => langOf(v).split("-")[0] === preferred && messages[preferred]) ||
      voices.find(v => /^en(?:-|$)/i.test(langOf(v)) && messages.en);
    if (!voice) return Promise.resolve(false);
    return new Promise(resolve => {
      const utterance = new window.SpeechSynthesisUtterance(messages[langOf(voice).split("-")[0]] || messages.en);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      let finished = false;
      let started = false;
      function done(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        utterance.onstart = utterance.onend = utterance.onerror = null;
        pendingReply = null;
        if (!ok) synth.cancel();
        // Only speech that played leaves audio behind for the next request to wait on; a
        // reply cancelled before it began used to earn the same idle.
        if (ok || started) V.lastSpokeAt = Date.now();
        V.log("spoken reply " + (ok ? "ended" : "cancelled or failed"));
        resolve(ok);
      }
      // A missing OS speech callback must never prevent the song starting.
      const timer = setTimeout(() => done(false), 8000);
      pendingReply = () => done(false);
      utterance.onstart = () => { started = true; };
      utterance.onend = () => done(true);
      utterance.onerror = () => done(false);
      try { V.log("spoken reply started"); synth.speak(utterance); } catch (e) { done(false); }
    });
  }

  // Start asynchronous voice discovery before a reply is needed. No audio or request
  // is sent, and remote voices are never selected, even as a fallback.
  if (window.speechSynthesis) window.speechSynthesis.getVoices();
})();
