(function () {
  const V = window.Aura.player;
  // A song held in the background: the hold watch, the native resume that has to be verified, the interruption adopted when nothing says what happened.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    adoptUnconfirmedInterruption: { get: () => adoptUnconfirmedInterruption },
    confirmNativeResumeProgress: { get: () => confirmNativeResumeProgress },
    holdNativeResume: { get: () => holdNativeResume },
    pauseIfRunning: { get: () => pauseIfRunning },
    reportBackgroundHold: { get: () => reportBackgroundHold },
    scheduleUnconfirmedFocusResume: { get: () => scheduleUnconfirmedFocusResume },
    stopBackgroundHoldWatch: { get: () => stopBackgroundHoldWatch },
    stopNativeResumeCheck: { get: () => stopNativeResumeCheck },
    verifyNativeResume: { get: () => verifyNativeResume },
    watchBackgroundHold: { get: () => watchBackgroundHold }
  });

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
      "s, " + (document.hidden ? "in background" : "in foreground") + ", " + V.describeElementState());
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
      ", " + V.describeElementState() + "; source and position retained");
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
          (V.audio.seeking && !check.reloaded) || V.loadingInProgress || V.platformBlocksAutoPlay() ||
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
        ", " + (document.hidden ? "in background" : "in foreground") + ", " + V.describeElementState());
      // Ask the platform for the session back before touching the element: on
      // the failing build play() succeeds without it and stays silent.
      V.resumeSessionKick(reload ? "decoder reload" : "interruption restart");
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
    V.clearMediaSessionPauseExpectation();
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
          !V.sessionStateUnknowable() || V.offlineBlocksResume() || pausedAt !== V.platformPausedAt ||
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
        V.log("background", reason + ": unpaused playback stuck at " + position.toFixed(2) + "s; restarting once, " +
          V.describeElementState());
        // Reuse the permitted element and source, retaining the listening position.
        V.audio.pause();
      }
      V.log("background", reason + " after an interruption; attempting one resume");
      V.resumeSessionKick("unconfirmed focus resume");
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
})();
