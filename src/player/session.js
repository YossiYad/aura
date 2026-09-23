(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    audioFocusInterrupted: { get: () => audioFocusInterrupted },
    clearMediaSessionPauseDecision: { get: () => clearMediaSessionPauseDecision },
    clearMediaSessionPauseExpectation: { get: () => clearMediaSessionPauseExpectation },
    configureAudioSession: { get: () => configureAudioSession },
    confirmNativeResumeProgress: { get: () => confirmNativeResumeProgress },
    ensureSessionKick: { get: () => ensureSessionKick },
    holdNativeResume: { get: () => holdNativeResume },
    onSessionKickStateChange: { get: () => onSessionKickStateChange },
    pauseIfRunning: { get: () => pauseIfRunning },
    platformBlocksAutoPlay: { get: () => platformBlocksAutoPlay },
    reportBackgroundHold: { get: () => reportBackgroundHold },
    resumePlatformPause: { get: () => resumePlatformPause },
    resumeSessionKick: { get: () => resumeSessionKick },
    resumeYtPlatformPause: { get: () => resumeYtPlatformPause },
    scheduleUnconfirmedFocusResume: { get: () => scheduleUnconfirmedFocusResume },
    sessionStateUnknowable: { get: () => sessionStateUnknowable },
    stopAudioFocusResumeRetry: { get: () => stopAudioFocusResumeRetry },
    stopBackgroundHoldWatch: { get: () => stopBackgroundHoldWatch },
    stopNativeResumeCheck: { get: () => stopNativeResumeCheck },
    stopYtFocusResumeRetry: { get: () => stopYtFocusResumeRetry },
    syncSessionKick: { get: () => syncSessionKick },
    verifyNativeResume: { get: () => verifyNativeResume },
    watchBackgroundHold: { get: () => watchBackgroundHold }
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

  function stopYtFocusResumeRetry() {
    if (V.ytFocusResumeTimer) clearTimeout(V.ytFocusResumeTimer);
    V.ytFocusResumeTimer = null;
    V.ytFocusResumeAttempts = 0;
  }

  function scheduleYtFocusResumeRetry(reason, generation) {
    if (V.ytFocusResumeTimer || V.ytFocusResumeAttempts >= 3) return;
    const delays = [500, 1500, 3000];
    const delay = delays[Math.min(V.ytFocusResumeAttempts - 1, delays.length - 1)];
    V.ytFocusResumeTimer = setTimeout(() => {
      V.ytFocusResumeTimer = null;
      if (generation !== V.audioSessionGeneration || !canResumeYtPlatformPause()) return;
      resumeYtPlatformPause(reason + " retry", generation);
    }, delay);
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
      ", at " + (V.audio.currentTime || 0).toFixed(2) + "s");
    reportBackgroundHold("audio context " + ctx.state);
    syncSessionKick();
    if (ctx.state !== "running") return;
    if (V.backend !== "audio" || V.audio.isCast || !V.wantsPlayback || V.remotePlaybackActive() ||
        !V.platformPaused || !V.focusResumePending || V.loadingInProgress || V.audio.ended ||
        audioFocusInterrupted() || V.mediaSessionPauseDecisionTimer || V.pausedByNetwork ||
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
      scheduleUnconfirmedFocusResume(V.audioSessionGeneration, "audio focus regained");
      return;
    }
    resumePlatformPause("audio focus regained");
  }

  // WebKit keeps a page's web content process alive while it plays audio and
  // releases that assertion a fixed interval after the audio stops
  // (audibleActivityClearDelay, ten seconds in WebKit trunk). A suspended
  // process runs no timer and is handed the interruption's end only when the
  // app is reopened, so a long interruption in the background is invisible to
  // every listener above, whichever signal the platform would have sent. While
  // an interruption holds playback hidden, tick once a second and report on the
  // next signal how long the page actually ran: that separates "focus never
  // returned to the page" from "nothing was running to notice it". The tick
  // starts only after the hold is a fact and stops with it; it never plays.
  const BACKGROUND_HOLD_TICK = 1000;
  const BACKGROUND_HOLD_TICK_LIMIT = 10 * 60 * 1000;

  function watchBackgroundHold() {
    if (V.backgroundHoldWatch || !document.hidden || !V.platformPaused || !V.focusResumePending || !V.wantsPlayback) return;
    const startedAt = Date.now();
    const watch = { startedAt, lastTickAt: startedAt, ticks: 0, gaps: [], longestGap: 0, longestGapFrom: 0,
      capped: false, timer: null };
    watch.timer = setInterval(() => {
      if (V.backgroundHoldWatch !== watch) { clearInterval(watch.timer); return; }
      if (!V.platformPaused || !V.wantsPlayback || !document.hidden) { stopBackgroundHoldWatch(); return; }
      const now = Date.now();
      noteHoldGap(watch, now);
      watch.ticks++;
      watch.lastTickAt = now;
      if (now - startedAt >= BACKGROUND_HOLD_TICK_LIMIT) {
        clearInterval(watch.timer);
        watch.timer = null;
        watch.capped = true;
      }
    }, BACKGROUND_HOLD_TICK);
    V.backgroundHoldWatch = watch;
  }

  function noteHoldGap(watch, now) {
    const gap = now - watch.lastTickAt;
    watch.gaps.push(gap);
    if (watch.gaps.length > 8) watch.gaps.shift();
    if (gap > watch.longestGap) {
      watch.longestGap = gap;
      watch.longestGapFrom = watch.lastTickAt - watch.startedAt;
    }
  }

  function stopBackgroundHoldWatch() {
    const watch = V.backgroundHoldWatch;
    if (!watch) return;
    if (watch.timer) clearInterval(watch.timer);
    V.backgroundHoldWatch = null;
  }

  // The interruption's own arrival raises session and context events within
  // the first moments of the hold; those are not the hold's end.
  function reportBackgroundHold(signal) {
    const watch = V.backgroundHoldWatch;
    if (!watch) return;
    const now = Date.now();
    if (now - watch.startedAt < 1500) return;
    stopBackgroundHoldWatch();
    const seconds = ms => (ms / 1000).toFixed(1);
    // A suspended process runs its overdue tick either just before or just
    // after the signal that woke it, so the freeze can sit inside the gap list
    // or be the final gap. Report the longest of them and where it began.
    const finalGap = now - watch.lastTickAt;
    let longest = watch.longestGap, from = watch.longestGapFrom;
    if (!watch.capped && finalGap > longest) { longest = finalGap; from = watch.lastTickAt - watch.startedAt; }
    const verdict = watch.capped
      ? "page ran at least " + seconds(watch.lastTickAt - watch.startedAt) + "s (ticking capped)"
      : longest > 3000 ? "page frozen " + seconds(longest) + "s from +" + seconds(from) + "s" : "page ran throughout";
    V.log("background", "hold hidden " + seconds(now - watch.startedAt) + "s until " + signal + ": " + verdict +
      "; " + watch.ticks + " ticks, gaps " + watch.gaps.map(seconds).join(" ") + (watch.gaps.length ? " | " : "") +
      (watch.capped ? "capped" : seconds(finalGap) + "s"));
    // A late context or session event, or a resume the platform then refuses, leaves
    // the hold in place. Keep watching it; the guard above declines once it has ended.
    watchBackgroundHold();
  }

  function stopNativeResumeCheck() {
    if (V.nativeResumeTimer) clearTimeout(V.nativeResumeTimer);
    V.nativeResumeTimer = null;
    V.nativeResumeCheck = null;
  }

  function confirmNativeResumeProgress() {
    const check = V.nativeResumeCheck;
    if (!check || check.target !== V.audio || check.token !== V.loadingToken || check.source !== V.audio.src ||
        V.audio.paused || V.audio.seeking || (V.audio.currentTime || 0) - check.position < 0.2) return false;
    V.log("background", "playback progress confirmed after interruption at " + V.audio.currentTime.toFixed(2) +
      "s, " + (document.hidden ? "in background" : "in foreground"));
    stopNativeResumeCheck();
    return true;
  }

  function holdNativeResume(check, reason) {
    if (V.nativeResumeCheck !== check || check.target !== V.audio || check.token !== V.loadingToken ||
        check.source !== V.audio.src) return;
    // An interruption failure is not evidence of a bad file or low bandwidth.
    // Do not enter the generic recovery path, which can downgrade or delete it.
    V.interruptionCheckpoint = check;
    stopNativeResumeCheck();
    V.clearStallCheck();
    V.platformPaused = true;
    V.platformPausedAt = Date.now();
    V.focusResumePending = true;
    V.focusResumeConfirmed = false;
    V.audio.pause();
    V.log("background", "interruption recovery " + reason + " at " + check.position.toFixed(2) +
      "s, " + (document.hidden ? "in background" : "in foreground") +
      ", ready " + V.audio.readyState + ", network " + V.audio.networkState + "; source and position retained");
    V.updatePlaybackState();
    V.emit({ type: "state" });
  }

  // A native play event changes the element's pause flag before its decoder
  // necessarily advances. Verify the clock independently of the focus hold.
  // A stateless session event just after play must not invalidate this check.
  function verifyNativeResume() {
    const check = V.nativeResumeCheck;
    if (!check) return;
    if (V.nativeResumeTimer) clearTimeout(V.nativeResumeTimer);
    V.nativeResumeTimer = setTimeout(() => {
      V.nativeResumeTimer = null;
      if (V.nativeResumeCheck !== check) return;
      if (check.target !== V.audio || check.token !== V.loadingToken || check.source !== V.audio.src ||
          V.backend !== "audio" || !V.wantsPlayback || !V.audio.src || V.audio.paused || V.audio.ended ||
          (V.audio.seeking && !check.reloaded) || V.loadingInProgress || platformBlocksAutoPlay() ||
          !V.routeCanResume() || V.remotePlaybackActive() || V.offlineBlocksResume()) {
        stopNativeResumeCheck();
        return;
      }
      if (confirmNativeResumeProgress()) return;
      if (check.reloaded) {
        holdNativeResume(check, "still blocked");
        return;
      }
      const reload = check.attempted;
      check.attempted = true;
      check.reloaded = reload;
      V.log("background", "play event without progress at " + check.position.toFixed(2) + "s; " +
        (reload ? "reloading the same source once" : "restarting once") +
        ", " + (document.hidden ? "in background" : "in foreground"));
      // Ask the platform for the session back before touching the element: on
      // the failing build play() succeeds without it and stays silent.
      resumeSessionKick(reload ? "decoder reload" : "interruption restart");
      // Keep this check across our own pause/play, including a queued play event,
      // so the restart cannot recursively create another recovery attempt.
      check.restarting = true;
      const blocked = error => {
        // load() aborts an earlier pending play promise. Its rejection must not
        // cancel the newer decoder reload that is already using the same check.
        if (check.reloaded === reload) {
          holdNativeResume(check, "rejected: " + String((error && error.message) || error).slice(0, 60));
        }
      };
      try {
        // Our restart pause is not a natural stop at the final decodable sample.
        V.platformPaused = true;
        V.focusResumePending = true;
        V.audio.pause();
        if (reload) {
          // Reinitialize the decoder on the permitted element. Setting currentTime
          // before metadata stores the native default start position, so playback
          // cannot start at zero while an asynchronous resolver is still running.
          V.audio.load();
          V.audio.currentTime = check.position;
        }
        Promise.resolve(V.audio.play()).catch(blocked);
      } catch (error) { blocked(error); }
      finally { check.restarting = false; }
      if (V.nativeResumeCheck === check) verifyNativeResume();
    }, check.reloaded ? 4000 : 1000);
  }

  // WebKit restores an interrupted element to the last state a script asked for,
  // and a pause() while the session is interrupted pins that to "paused"
  // (PlatformMediaSession::processClientWillPausePlayback). The platform has
  // already paused the element by the time the interruption's own pause action
  // and session event arrive, so pausing it again changes nothing except
  // cancelling the engine's own resume at the interruption's end. Pause only an
  // element that is still running; a listener pause commits through pausePlay.
  function pauseIfRunning() {
    if (!V.audio.paused) V.audio.pause();
  }

  // The interruption reading without a state value to back it up. It keeps the
  // listener's intent exactly like the confirmed branches do, but leaves
  // audioSessionInterrupted alone: with no "active" notification ever coming on
  // these builds, that flag would permanently block even an explicit Play.
  function adoptUnconfirmedInterruption(reason) {
    clearMediaSessionPauseExpectation();
    V.platformPaused = true;
    V.platformPausedAt = Date.now();
    V.focusResumePending = true;
    V.focusResumeConfirmed = false;
    V.clearStallCheck();
    if (V.backend === "audio") {
      V.commitInterruptedPreparedStart(reason);
      V.cancelCrossfade();
      pauseIfRunning();
    } else if (V.backend === "yt" && V.yt && V.ytReady) {
      try { V.yt.pauseVideo(); } catch (e) {}
    }
    V.updatePlaybackState();
  }

  // On a stateless session, a statechange while an interruption is held most
  // plausibly marks its end; the platform cannot say. One short-delay attempt
  // per session event, never a poll: a pause arriving inside the settle window
  // re-stamps platformPausedAt and reclaims the event for a new interruption.
  function scheduleUnconfirmedFocusResume(generation, reason = "audio session event") {
    // A second notification supersedes a timer whose generation is now stale.
    if (V.unconfirmedFocusResumeTimer) clearTimeout(V.unconfirmedFocusResumeTimer);
    const target = V.audio, source = V.audio.src, token = V.loadingToken;
    const pausedAt = V.platformPausedAt, position = V.audio.currentTime || 0;
    V.unconfirmedFocusResumeTimer = setTimeout(() => {
      V.unconfirmedFocusResumeTimer = null;
      if (generation !== V.audioSessionGeneration || V.focusResumeAttempting ||
          V.mediaSessionPauseDecisionTimer || V.audioSessionInterrupted ||
          !V.platformPaused || !V.focusResumePending || !V.wantsPlayback || V.backend !== "audio" ||
          target !== V.audio || source !== V.audio.src || token !== V.loadingToken ||
          V.audio.ended || !V.audio.src || V.audio.seeking || V.loadingInProgress || V.remotePlaybackActive() ||
          !sessionStateUnknowable() || V.offlineBlocksResume() || pausedAt !== V.platformPausedAt ||
          (reason === "app visible" ? document.hidden : Date.now() - V.platformPausedAt <= 1000)) return;
      // Native recovery can clear paused without delivering play. Only an advancing
      // clock proves recovery: otherwise the platform hold also blocks stall repair.
      if (!V.audio.paused) {
        if ((V.audio.currentTime || 0) - position >= 0.2) {
          V.platformPaused = false;
          V.focusResumePending = false;
          V.focusResumeConfirmed = false;
          V.pausedByNetwork = false;
          V.noteAudioProgress();
          V.log("background", reason + ": native playback progressing after interruption");
          V.updatePlaybackState();
          return;
        }
        V.log("background", reason + ": unpaused playback stuck at " + position.toFixed(2) + "s; restarting once");
        // Reuse the permitted element and source, retaining the listening position.
        V.audio.pause();
      }
      V.log("background", reason + " after an interruption; attempting one resume");
      resumeSessionKick("unconfirmed focus resume");
      const blocked = e => V.log("background", "unconfirmed focus resume blocked: " +
        String((e && e.message) || e).slice(0, 60));
      try {
        Promise.resolve(V.audio.play()).then(() => {
          if (generation !== V.audioSessionGeneration) return;
          V.pausedByNetwork = false;
          V.updatePlaybackState();
        }).catch(blocked);
      } catch (e) { blocked(e); }
    }, 500);
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
      reportBackgroundHold("audio session " + (session.state || "event"));
      if (session.state === "interrupted") {
        stopNativeResumeCheck();
        stopAudioFocusResumeRetry();
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        stopYtFocusResumeRetry();
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
            if (resumeYtPlatformPause("focus return", sessionGeneration)) return;
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
            resumePlatformPause("focus return", sessionGeneration);
          }, 0);
        }
      } else if (session.state === "inactive") {
        stopNativeResumeCheck();
        // Inactive alone does not grant focus. Retain an existing interruption across
        // this intermediate state so a later active notification can finish it.
        V.audioSessionInterrupted = V.focusResumePending && (V.audioSessionInterrupted || V.focusResumeConfirmed);
        V.focusResumePending = V.audioSessionInterrupted;
        V.focusResumeConfirmed = false;
        stopAudioFocusResumeRetry();
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        stopYtFocusResumeRetry();
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
          adoptUnconfirmedInterruption("audio session event beside pause action");
        } else if (V.platformPaused && V.focusResumePending && V.wantsPlayback &&
            Date.now() - V.platformPausedAt > 1000) {
          scheduleUnconfirmedFocusResume(sessionGeneration);
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

  function platformBlocksAutoPlay() {
    return V.platformPaused || audioFocusInterrupted() || !!V.mediaSessionPauseDecisionTimer;
  }

  function audioFocusInterrupted() {
    if (V.audio.isCast) return false;
    const session = navigator.audioSession;
    // Native play can arrive before statechange, but only an active session can
    // release a known interruption. Visibility and inactive cannot do so.
    return !!(session && session.state === "interrupted") ||
      (V.audioSessionInterrupted && (!session || session.state !== "active"));
  }

  function stopAudioFocusResumeRetry() {
    if (V.audioFocusResumeTimer) clearTimeout(V.audioFocusResumeTimer);
    V.audioFocusResumeTimer = null;
    V.audioFocusResumeAttempts = 0;
  }

  function scheduleAudioFocusResumeRetry(reason, generation) {
    if (V.audioFocusResumeTimer || V.audioFocusResumeAttempts >= 3 ||
        generation !== V.audioSessionGeneration || !canResumePlatformPause()) return;
    V.audioFocusResumeTimer = setTimeout(() => {
      V.audioFocusResumeTimer = null;
      resumePlatformPause(reason + " retry", generation);
    }, V.audioFocusResumeAttempts === 1 ? 500 : 1500);
  }

  function canResumePlatformPause() {
    const session = navigator.audioSession;
    if (V.mediaSessionPauseDecisionTimer || !V.platformPaused || !V.wantsPlayback || V.backend !== "audio" ||
        (!V.audio.paused && !V.audio.ended) || !V.audio.src || V.loadingInProgress || V.audioSessionInterrupted ||
        V.offlineBlocksResume()) return false;
    if (session && session.state != null) {
      return V.audioSessionBound && session.state === "active" &&
        V.focusResumePending && V.focusResumeConfirmed;
    }
    // Without a readable focus state the platform can never confirm that the
    // interruption ended; there the listener returning to the app stands in for
    // that confirmation (set on the visibility transition).
    return V.focusResumePending && V.focusResumeConfirmed;
  }

  function resumePlatformPause(reason, expectedGeneration) {
    if ((expectedGeneration != null && expectedGeneration !== V.audioSessionGeneration) ||
        V.focusResumeAttempting || !canResumePlatformPause()) return false;
    // A sleep deadline that passed during the hold means the listener asked for silence
    // by now; the platform handing audio back does not reopen that.
    if (V.sleepDeadline && Date.now() >= V.sleepDeadline) { V.finishSleep(); return false; }
    const generation = V.audioSessionGeneration;
    if (V.audio.ended) {
      V.platformPaused = false;
      V.focusResumePending = false;
      V.focusResumeConfirmed = false;
      V.focusResumeAttempting = false;
      V.focusResumeAttemptGeneration = -1;
      V.advanceAfterEnd(reason);
      return true;
    }
    V.focusResumeAttempting = true;
    V.focusResumeAttemptGeneration = generation;
    V.audioFocusResumeAttempts++;
    resumeSessionKick(reason);
    try {
      Promise.resolve(V.audio.play()).then(() => {
        if (generation !== V.audioSessionGeneration) return;
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        V.pausedByNetwork = false;
        V.updatePlaybackState();
      }).catch(e => {
        if (V.focusResumeAttemptGeneration === generation) {
          V.focusResumeAttempting = false;
          V.focusResumeAttemptGeneration = -1;
        }
        V.log("background", reason + " resume blocked: " + String((e && e.message) || e).slice(0, 60));
        scheduleAudioFocusResumeRetry(reason, generation);
      });
    } catch (e) {
      V.focusResumeAttempting = false;
      V.focusResumeAttemptGeneration = -1;
      V.log("background", reason + " resume blocked: " + String((e && e.message) || e).slice(0, 60));
      scheduleAudioFocusResumeRetry(reason, generation);
    }
    return true;
  }

  function canResumeYtPlatformPause() {
    const session = navigator.audioSession;
    if (V.mediaSessionPauseDecisionTimer || !V.platformPaused || !V.wantsPlayback || V.backend !== "yt" ||
        !V.yt || !V.ytReady || V.audioSessionInterrupted || navigator.onLine === false) return false;
    if (session && session.state != null) {
      return V.audioSessionBound && session.state === "active" &&
        V.focusResumePending && V.focusResumeConfirmed;
    }
    return V.focusResumePending && V.focusResumeConfirmed;
  }

  function resumeYtPlatformPause(reason, expectedGeneration) {
    if ((expectedGeneration != null && expectedGeneration !== V.audioSessionGeneration) ||
        !canResumeYtPlatformPause()) return false;
    const generation = V.audioSessionGeneration;
    V.ytFocusResumeAttempts++;
    try {
      if (window.YT && V.yt.getPlayerState && V.yt.getPlayerState() === YT.PlayerState.ENDED) {
        stopYtFocusResumeRetry();
        V.platformPaused = false;
        V.focusResumePending = false;
        V.focusResumeConfirmed = false;
        V.next(true);
        return true;
      }
      V.yt.playVideo();
    }
    catch (e) {
      V.log("background", reason + " YouTube resume blocked: " + String((e && e.message) || e).slice(0, 60));
    }
    // playVideo() is a command, not a promise. Keep the focus hold until PLAYING confirms
    // success; a short bounded retry covers a command the iframe silently ignored.
    if (V.platformPaused && V.focusResumeConfirmed) scheduleYtFocusResumeRetry(reason, generation);
    V.updatePlaybackState();
    V.emit({ type: "state" });
    return true;
  }
})();
