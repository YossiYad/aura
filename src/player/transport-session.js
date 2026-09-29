(function () {
  const V = window.Aura.player;
  // The audio session around a control: the kick released, the element primed inside a gesture, the pause that came from the lock screen, the microphone's turn.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    mediaSessionPause: { get: () => mediaSessionPause },
    primeForPlayback: { get: () => primeForPlayback },
    releaseForVoice: { get: () => releaseForVoice }
  });

  // Close and forget the silent session-holder context so it stops pinning the AVAudioSession.
  // ensureSessionKick recreates it on the next play (sessionKick is null again), so the
  // interruption-recovery client returns with playback. The listener is dropped first so the
  // close's own statechange cannot run against a torn-down context.
  // Settles once the context has closed, or at once without one.
  function releaseSessionKick() {
    if (!V.sessionKick) return Promise.resolve();
    const ctx = V.sessionKick;
    V.sessionKick = null;
    V.sessionKickSource = null;
    V.sessionKickResuming = false;
    try { if (ctx.removeEventListener) ctx.removeEventListener("statechange", V.onSessionKickStateChange); } catch (e) {}
    try { ctx.onstatechange = null; } catch (e) {}
    try { return Promise.resolve(ctx.close()).catch(() => {}); } catch (e) { return Promise.resolve(); }
  }

  // iOS lets an <audio> element play only from a user gesture, or once it has already
  // played from one (the sticky per-element permission the top-of-file note relies on).
  // A voice or typed AI request reaches audio.play() seconds later - after speech
  // recognition and the model resolve - with no gesture in hand, so iOS refuses it
  // (NotAllowedError) and the resolved track waits for a manual Play tap
  // (holdPlaybackPermission). Priming plays a scrap of silence on the element inside the
  // tap that opens the request, a genuine gesture, so the element carries that permission
  // forward and the resolved track's own play() is allowed. Kept element-only and cleared
  // synchronously: no source and no running context may linger into the microphone
  // capture that can follow (WebKit 321436), and the queued play/pause events fire against
  // an already-empty element, so they no-op. Android grants sticky permission across the
  // async resolve on its own, so this is iOS-only and never touches the Android path.
  /**
   * On iOS, starts the audio element from inside a user gesture so later playback is allowed.
   */
  function primeForPlayback() {
    if (!V.isIOS || V.audio.isCast || V.remotePlaybackActive() || V.backend !== "audio") return;
    // A loaded element already holds permission; never interrupt real playback nor
    // overwrite a source (its saved position would be lost) merely to prime.
    if (V.audio.src) { V.playbackPrimed = V.playbackPrimed || !V.audio.paused; return; }
    const previousVolume = V.audio.volume;
    try {
      V.audio.src = V.SILENT_PRIME_CLIP;
      V.audio.volume = 0;
      const started = V.audio.play();
      // The gesture is spent the instant play() is called; stop and detach at once so
      // nothing audible escapes and no client is left to deafen the microphone.
      try { V.audio.pause(); } catch (e) {}
      V.audio.removeAttribute("src");
      try { V.audio.load(); } catch (e) {}
      V.audio.volume = previousVolume;
      V.playbackPrimed = true;
      if (started && typeof started.then === "function") {
        started.then(() => {}, e => {
          if (e && e.name !== "AbortError")
            V.log("play", "priming refused (" + ((e && e.name) || e) + "); an AI-started track may still need a tap");
        });
      }
      V.log("play", "primed the audio element for an AI-triggered play");
    } catch (e) {
      V.audio.volume = previousVolume;
      V.log("play", "priming failed: " + String((e && e.message) || e).slice(0, 60));
    }
  }

  // On iOS any live audio-session client starves webkitSpeechRecognition (WebKit bug 321436):
  // the next capture reports audio start but receives no input. Two clients survive an ordinary
  // pause and each alone is enough to deafen the mic (both proven on device): a media element
  // that still holds a source (pausePlay only pauses it, keeping src), and the sessionKick
  // AudioContext, which even SUSPENDED keeps the session pinned to playback. Release both for a
  // capture - detach every element source (position stashed so resumePlay's no-source branch
  // reloads current() in place) and close the context. Then, still inside the capture-opening
  // tap, give the element its playback permission if it does not hold it yet, so the song the
  // request resolves to seconds later starts without a manual Play tap. iOS keeps that
  // permission on the element across sources - the prime itself drops its source and the
  // later play() is still allowed - so a primed element is not primed again: doing that on
  // every request played and stopped the element right in front of each capture. A refused
  // play clears the mark (holdPlaybackPermission), and the next request's tap primes again.
  // No-op off iOS and off the audio backend. The context closes asynchronously, and one
  // still closing leaves the capture as silent as a live one, so the returned promise
  // settles once it is gone; the microphone waits for it (src/voice.js).
  /**
   * On iOS, lets go of the audio element so the microphone can open.
   * @returns {Promise<void>} Settles once the player's audio context has closed.
   */
  function releaseForVoice() {
    let closed = Promise.resolve();
    if (!V.isIOS || V.backend !== "audio") return closed;
    if (V.audio.src || V.otherEl().src || V.sessionKick) {
      const track = V.current();
      if (track && V.audio.src) V.restoredPosition = { id: track.id, at: V.audio.currentTime || 0 };
      V.log("voice", "releasing for capture, element " + (V.audio.src ? V.audio.readyState : "empty") +
        ", other " + (V.otherEl().src ? V.otherEl().readyState : "empty") +
        ", kick " + ((V.sessionKick && V.sessionKick.state) || "none"));
      [V.audio, V.otherEl()].forEach(el => {
        if (!el.src) return;
        el.pause();
        el.removeAttribute("src");
        try { el.load(); } catch (e) {}
      });
      closed = releaseSessionKick();
    }
    if (V.playbackPrimed) V.log("voice", "element already holds playback permission, not priming");
    else primeForPlayback();
    return closed;
  }

  function mediaSessionPause() {
    const session = V.audio.isCast ? null : navigator.audioSession;
    if ((V.backend === "audio" || V.backend === "yt") && V.wantsPlayback && session) {
      V.stopYtFocusResumeRetry();
      // WebKit can send this action for both an interruption and a real headset/lock-screen
      // pause. A nearby Audio Session event identifies the former; otherwise, after this
      // short decision window, the action is committed as an explicit listener pause.
      if (V.mediaSessionPauseExpected) {
        V.clearMediaSessionPauseExpectation();
        // A session with no readable state can never report "active"; leaving
        // the interrupted flag raised there would block Play forever.
        V.audioSessionInterrupted = session.state === "interrupted";
        V.platformPaused = true;
        V.platformPausedAt = Date.now();
        V.focusResumePending = true;
        V.focusResumeConfirmed = false;
        V.clearStallCheck();
        if (V.backend === "audio") {
          V.commitInterruptedPreparedStart("media session interruption");
          V.cancelCrossfade();
          V.pauseIfRunning();
        } else if (V.yt && V.ytReady) {
          try { V.yt.pauseVideo(); } catch (e) {}
        }
        V.updatePlaybackState();
        return;
      }
      if (!V.mediaSessionPauseDecisionTimer) {
        V.mediaSessionPauseDecisionTimer = setTimeout(() => {
          V.mediaSessionPauseDecisionTimer = null;
          V.pausePlay();
        }, 500);
        if (V.backend === "yt" && V.yt && V.ytReady) {
          try { V.yt.pauseVideo(); } catch (e) {}
        } else V.pauseIfRunning();
        V.updatePlaybackState();
      }
      return;
    }
    V.pausePlay();
  }
})();
