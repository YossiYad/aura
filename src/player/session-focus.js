(function () {
  const V = window.Aura.player;
  // Audio focus and the platform pause: whether the OS holds the audio, and the retries that take it back.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    audioFocusInterrupted: { get: () => audioFocusInterrupted },
    platformBlocksAutoPlay: { get: () => platformBlocksAutoPlay },
    resumePlatformPause: { get: () => resumePlatformPause },
    resumeYtPlatformPause: { get: () => resumeYtPlatformPause },
    stopAudioFocusResumeRetry: { get: () => stopAudioFocusResumeRetry },
    stopYtFocusResumeRetry: { get: () => stopYtFocusResumeRetry }
  });

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
    V.resumeSessionKick(reason);
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
