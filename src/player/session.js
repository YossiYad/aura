(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    clearMediaSessionPauseDecision: { get: () => clearMediaSessionPauseDecision },
    clearMediaSessionPauseExpectation: { get: () => clearMediaSessionPauseExpectation },
    configureAudioSession: { get: () => configureAudioSession },
    describeElementState: { get: () => describeElementState },
    ensureSessionKick: { get: () => ensureSessionKick },
    onSessionKickStateChange: { get: () => onSessionKickStateChange },
    resumeSessionKick: { get: () => resumeSessionKick },
    sessionStateUnknowable: { get: () => sessionStateUnknowable },
    syncSessionKick: { get: () => syncSessionKick }
  });

  function clearMediaSessionPauseDecision() {
    if (V.mediaSessionPauseDecisionTimer) clearTimeout(V.mediaSessionPauseDecisionTimer);
    V.mediaSessionPauseDecisionTimer = null;
  }

  function clearMediaSessionPauseExpectation() {
    if (V.mediaSessionPauseExpectationTimer) clearTimeout(V.mediaSessionPauseExpectationTimer);
    V.mediaSessionPauseExpectationTimer = null;
    V.mediaSessionPauseExpected = false;
  }

  function expectMediaSessionPause() {
    clearMediaSessionPauseExpectation();
    V.mediaSessionPauseExpected = true;
    V.mediaSessionPauseExpectationTimer = setTimeout(() => {
      V.mediaSessionPauseExpectationTimer = null;
      V.mediaSessionPauseExpected = false;
    }, 500);
  }

  // One line of element and context facts for the interruption log entries. The
  // 8-second reel on the iPhone (2026-09-28) showed WebKit's own resume arriving
  // with the page running and the clock frozen; whether the element had data,
  // and whether the helper context's own clock moved, is what separates a session
  // that renders nothing from an element that cannot buffer. Every read is
  // guarded: the harness elements carry only some of these fields.
  function describeElementState() {
    const el = V.audio;
    let buffered = "none";
    try {
      const ranges = el.buffered;
      if (ranges && ranges.length) buffered = ranges.end(ranges.length - 1).toFixed(2) + "s";
    } catch (e) {}
    const ctx = V.sessionKick;
    const ctxTime = ctx && typeof ctx.currentTime === "number" ? " " + ctx.currentTime.toFixed(2) + "s" : "";
    return "ready " + el.readyState + ", network " + el.networkState + ", buffered " + buffered +
      ", ctx " + (ctx ? ctx.state + ctxTime : "none");
  }

  // Chrome has no Audio Session at all, and some Safari builds dispatch its
  // statechange without a readable state. Neither can ever confirm focus with
  // an "active" notification, so recovery decisions there rest on weaker
  // signals: event adjacency and the listener returning to the app.
  function sessionStateUnknowable() {
    const session = navigator.audioSession;
    return !session || session.state == null;
  }

  // iOS can deactivate a hidden page's audio session during a long interruption.
  // On the reported iOS 27 build no media-element call brings sound back while
  // the app stays hidden: native play clears paused with a frozen clock, and
  // pause/play, a decoder reload, even a fresh URL stay silent until the app is
  // reopened. A Web Audio context is a second client of the same audio session.
  // The platform suspends it with the interruption and hands it back when the
  // interruption ends, even in the background: its statechange to "running" is
  // the focus-return signal the stateless Audio Session never delivers, and a
  // pending resume() asks the platform to reactivate a session that
  // element.play() alone leaves inactive. Chrome and Android resume the element
  // natively, so the context exists only on iOS. The media elements themselves
  // stay outside the graph: createMediaElementSource silences cross-origin
  // streams permanently, and these streams are cross-origin.
  //
  // The context must actually render: iOS treats a context with nothing to
  // play as idle, and an idle client can be left out of interruption
  // bookkeeping entirely. One frame of digital silence looped forever keeps
  // the audio unit a genuine session client while staying inaudible.
  function ensureSessionKick() {
    if (V.sessionKick || !V.isIOS || V.audio.isCast || V.remotePlaybackActive()) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try { V.sessionKick = new Ctx(); } catch (e) { V.sessionKick = null; return; }
    try {
      if (typeof V.sessionKick.addEventListener === "function") {
        V.sessionKick.addEventListener("statechange", onSessionKickStateChange);
      } else V.sessionKick.onstatechange = onSessionKickStateChange;
    } catch (e) {}
    try {
      const buffer = V.sessionKick.createBuffer(1, 1, V.sessionKick.sampleRate || 22050);
      V.sessionKickSource = V.sessionKick.createBufferSource();
      V.sessionKickSource.buffer = buffer;
      V.sessionKickSource.loop = true;
      V.sessionKickSource.connect(V.sessionKick.destination);
      V.sessionKickSource.start(0);
    } catch (e) {
      V.log("background", "audio session context could not render silence: " +
        String((e && e.message) || e).slice(0, 60));
    }
    V.log("background", "audio session context created, state " + V.sessionKick.state);
  }

  // One standing request, never a poll: a resume() issued while the OS holds
  // the audio (a call, another player) stays pending and resolves the moment
  // the platform can activate us again. Repeats while it is pending add nothing.
  // The exception is a listener gesture: a resume() first issued outside one (after a
  // slow resolve, say) can stay pending under WebKit's gesture rule for the page's
  // lifetime, and only a call made inside the tap can start the context then.
  function resumeSessionKick(reason, fromGesture) {
    // Native play/focus recovery also calls this directly, outside the intent
    // synchronizer. Never restart the silent local renderer on a receiver route.
    if (V.audio.isCast || V.remotePlaybackActive()) return;
    const ctx = V.sessionKick;
    if (!ctx || (V.sessionKickResuming && !fromGesture) || ctx.state === "running" || ctx.state === "closed") return;
    V.sessionKickResuming = true;
    try {
      Promise.resolve(ctx.resume()).then(() => {
        V.sessionKickResuming = false;
        V.log("background", "audio session reactivation (" + reason + ") resolved, state " +
          (V.sessionKick && V.sessionKick.state));
      }, e => {
        V.sessionKickResuming = false;
        V.log("background", "audio session reactivation (" + reason + ") blocked: " +
          String((e && e.message) || e).slice(0, 60));
      });
    } catch (e) {
      V.sessionKickResuming = false;
      V.log("background", "audio session reactivation (" + reason + ") blocked: " +
        String((e && e.message) || e).slice(0, 60));
    }
  }

  // Reconcile the context with the listener's intent. Only "suspended" and
  // "running" are ours to move: an "interrupted" context belongs to the
  // platform, whose automatic resume at the interruption's end is the signal
  // this whole mechanism waits for. Suspending on pause matters beyond
  // battery: a running playback-type context holds the audio session active,
  // which would keep other apps silent while Aura is deliberately quiet.
  function syncSessionKick(fromGesture) {
    const ctx = V.sessionKick;
    if (!ctx) return;
    // A held permission keeps the context quiet, except inside the tap that resolves
    // it: that tap is the one gesture the context will get.
    // This silent renderer is for local interruption recovery only. Let the
    // media element own AirPlay playback; keeping a second renderer active is
    // unnecessary there and is a suspect in the reported black/silent handoff.
    // Use the native output flag so a stale generic "connecting" state cannot
    // disable local recovery. Do not pause or change the music source here.
    const wanted = V.wantsPlayback && V.backend === "audio" && !V.audio.isCast &&
      !V.remotePlaybackActive() && !V.pausedByNetwork && (fromGesture || !V.pendingPlaybackPermission) && !!V.current();
    if (wanted && ctx.state === "suspended") resumeSessionKick(fromGesture ? "listener play" : "playback", fromGesture);
    else if (!wanted && ctx.state === "running") {
      if (V.remotePlaybackActive()) V.log("remote", "suspending local audio helper for wireless playback");
      try { Promise.resolve(ctx.suspend()).catch(() => {}); } catch (e) {}
    }
  }

  function onSessionKickStateChange() {
    const ctx = V.sessionKick;
    if (!ctx) return;
    V.sessionKickResuming = false;
    V.log("background", "audio context " + ctx.state + ", paused " + V.isPaused() +
      ", held " + V.platformPaused + ", intent " + V.wantsPlayback +
      ", at " + (V.audio.currentTime || 0).toFixed(2) + "s, " + describeElementState());
    V.reportBackgroundHold("audio context " + ctx.state);
    syncSessionKick();
    if (ctx.state !== "running") return;
    if (V.backend !== "audio" || V.audio.isCast || !V.wantsPlayback || V.remotePlaybackActive() ||
        !V.platformPaused || !V.focusResumePending || V.loadingInProgress || V.audio.ended ||
        V.audioFocusInterrupted() || V.mediaSessionPauseDecisionTimer || V.pausedByNetwork ||
        V.offlineBlocksResume() || !sessionStateUnknowable()) return;
    // The platform handed our second session client its audio back: the
    // interruption is over, in whichever state the app happens to be. This is
    // the confirmation the visibility stand-in supplies only on reopening.
    V.focusResumeConfirmed = true;
    // A source held for focus (an outage, a load the interruption caught) has no
    // element to resume; this signal is the retry it was waiting for.
    if (!V.audio.src) { V.retrySourceNow("audio focus regained", true); return; }
    if (!V.audio.paused) {
      // Unpaused with a frozen clock is the documented zombie shape. The
      // settle window separates it from a native resume that is already
      // progressing, then its restart re-arms position verification.
      V.scheduleUnconfirmedFocusResume(V.audioSessionGeneration, "audio focus regained");
      return;
    }
    V.resumePlatformPause("audio focus regained");
  }

  function configureAudioSession() {
    if (V.audio.isCast) return;
    const session = navigator.audioSession;
    if (!session) return;
    try { session.type = window.Voice && window.Voice.isListening() ? "play-and-record" : "playback"; } catch (e) {}
    if (V.audioSessionBound || !session.addEventListener) return;
    V.audioSessionBound = true;
    session.addEventListener("statechange", () => {
      if (V.audio.isCast) return;
      const sessionGeneration = ++V.audioSessionGeneration;
      V.log("background", "audio session " + (session.state || "changed") +
        ", paused " + V.isPaused() + ", held " + V.platformPaused +
        ", intent " + V.wantsPlayback + ", at " + (V.audio.currentTime || 0).toFixed(2) + "s");
      V.reportBackgroundHold("audio session " + (session.state || "event"));
      if (session.state === "interrupted") {
        V.stopNativeResumeCheck();
        V.stopAudioFocusResumeRetry();
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        V.stopYtFocusResumeRetry();
        const pauseActionArrivedFirst = !!V.mediaSessionPauseDecisionTimer;
        clearMediaSessionPauseDecision();
        if (pauseActionArrivedFirst) clearMediaSessionPauseExpectation();
        else expectMediaSessionPause();
        V.audioSessionInterrupted = true;
        V.focusResumeConfirmed = false;
        const resumableBackend = V.backend === "audio" || (V.backend === "yt" && V.yt && V.ytReady);
        if (V.wantsPlayback && resumableBackend) {
          V.platformPaused = true;
          V.platformPausedAt = Date.now();
          V.focusResumePending = true;
          if (V.backend === "audio") V.commitInterruptedPreparedStart("audio session interruption");
          else { try { V.yt.pauseVideo(); } catch (e) {} }
        }
        V.clearStallCheck();
        V.cancelCrossfade();
      } else if (session.state === "active") {
        const shouldResume = V.focusResumePending && (V.audioSessionInterrupted || V.focusResumeConfirmed);
        V.audioSessionInterrupted = false;
        clearMediaSessionPauseExpectation();
        if (shouldResume) V.focusResumeConfirmed = true;
        if (shouldResume) {
          // The platform normally resumes the element itself. Give it one task first, then
          // try a fallback only after audio focus is confirmed as ours again.
          setTimeout(() => {
            if (sessionGeneration !== V.audioSessionGeneration || session.state !== "active" || !V.wantsPlayback) return;
            if (V.resumeYtPlatformPause("focus return", sessionGeneration)) return;
            if (V.backend === "audio" && !V.audio.paused && !V.audio.ended) {
              V.platformPaused = false;
              V.focusResumePending = false;
              V.focusResumeConfirmed = false;
              V.focusResumeAttempting = false;
              V.focusResumeAttemptGeneration = -1;
              V.pausedByNetwork = false;
              V.updatePlaybackState();
              return;
            }
            if (V.retrySourceNow("focus return", true)) return;
            V.resumePlatformPause("focus return", sessionGeneration);
          }, 0);
        }
      } else if (session.state === "inactive") {
        V.stopNativeResumeCheck();
        // Inactive alone does not grant focus. Retain an existing interruption across
        // this intermediate state so a later active notification can finish it.
        V.audioSessionInterrupted = V.focusResumePending && (V.audioSessionInterrupted || V.focusResumeConfirmed);
        V.focusResumePending = V.audioSessionInterrupted;
        V.focusResumeConfirmed = false;
        V.stopAudioFocusResumeRetry();
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        V.stopYtFocusResumeRetry();
        clearMediaSessionPauseExpectation();
      } else if (session.state == null) {
        // This WebKit build dispatches statechange without a readable state, so
        // the value branches above never run. Resolve the ambiguity by adjacency
        // instead: a session event beside a Media Session pause is the signature
        // of an interruption, never of a listener pause. Listener pauses raise
        // no session event of their own here, so committing the pause after a
        // quiet decision window still reads them correctly.
        if (V.mediaSessionPauseDecisionTimer && V.wantsPlayback) {
          clearMediaSessionPauseDecision();
          V.adoptUnconfirmedInterruption("audio session event beside pause action");
        } else if (V.platformPaused && V.focusResumePending && V.wantsPlayback &&
            Date.now() - V.platformPausedAt > 1000) {
          V.scheduleUnconfirmedFocusResume(sessionGeneration);
        } else if (V.wantsPlayback) {
          // The session event can precede its pause action. Let a pause arriving
          // inside the expectation window take the interruption reading too.
          expectMediaSessionPause();
        }
      }
      V.updatePlaybackState();
      V.emit({ type: "state" });
    });
  }

})();
