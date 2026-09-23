(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    ensureYT: { get: () => ensureYT },
    retrySourceNow: { get: () => retrySourceNow },
    scheduleSourceRetry: { get: () => scheduleSourceRetry },
    startYtClock: { get: () => startYtClock },
    stopAudio: { get: () => stopAudio },
    stopSourceRetry: { get: () => stopSourceRetry },
    stopYt: { get: () => stopYt },
    stopYtClock: { get: () => stopYtClock },
    yt: { get: () => yt },
    ytReady: { get: () => ytReady }
  });

  let yt = null;
  let ytReady = false;
  let ytTimer = null;
  let ytWaiters = [];

  function ensureYT() {
    return new Promise((res, rej) => {
      if (yt && ytReady) return res(yt);
      ytWaiters.push({ res, rej });
      if (ytWaiters.length > 1) return;
      if (!document.getElementById("yt-holder")) {
        const holder = document.createElement("div");
        holder.id = "yt-holder";
        holder.style.cssText = "position:fixed;left:-9999px;bottom:0;width:1px;height:1px;overflow:hidden;";
        document.body.appendChild(holder);
      }
      const boot = () => {
        yt = new YT.Player("yt-holder", {
          width: 200, height: 200,
          playerVars: { playsinline: 1, controls: 0, disablekb: 1 },
          events: {
            onReady: () => {
              ytReady = true;
              yt.setVolume(Math.round(V.volume * 100));
              ytWaiters.forEach(w => w.res(yt));
              ytWaiters = [];
            },
            onStateChange: e => {
              if (V.backend !== "yt") return;
              // While a new track loads, the iframe still holds the previous one; its
              // end or a pause of it must not advance past the track being loaded, or
              // hold it for focus.
              if (V.loadingInProgress && e.data !== YT.PlayerState.PLAYING) return;
              if (e.data === YT.PlayerState.ENDED) {
                V.stopYtFocusResumeRetry();
                if (!V.platformBlocksAutoPlay()) V.next(true);
              }
              else if (e.data === YT.PlayerState.PLAYING) {
                if (!V.wantsPlayback || V.audioFocusInterrupted() || V.mediaSessionPauseDecisionTimer) {
                  try { yt.pauseVideo(); } catch (ignore) {}
                  return;
                }
                V.stopYtFocusResumeRetry();
                V.audioSessionInterrupted = false;
                V.platformPaused = false;
                V.focusResumePending = false;
                V.focusResumeConfirmed = false;
                V.emit({ type: "state" });
              } else if (e.data === YT.PlayerState.PAUSED) {
                if (V.wantsPlayback) {
                  V.platformPaused = true;
                  V.platformPausedAt = Date.now();
                  V.focusResumePending = true;
                  V.focusResumeConfirmed = V.focusResumeConfirmed && !V.audioFocusInterrupted();
                }
                V.emit({ type: "state" });
              }
              V.updatePositionState();
            },
            onError: () => {
              // Like a late state change, a late error is about the video the iframe still
              // holds, not the track being loaded over it.
              if (V.backend === "yt" && V.current() && !V.loadingInProgress) {
                V.failedQueueIds.add(V.current().id);
                V.reportPlaybackFailure({ type: "error", track: V.current(), error: new Error("Video blocked") });
              }
            }
          }
        });
      };
      if (window.YT && window.YT.Player) return boot();
      window.onYouTubeIframeAPIReady = boot;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { ytWaiters.forEach(w => w.rej(new Error("YT api load failed"))); ytWaiters = []; };
      document.head.appendChild(s);
      setTimeout(() => {
        if (!ytReady && ytWaiters.length) { ytWaiters.forEach(w => w.rej(new Error("YT api timeout"))); ytWaiters = []; }
      }, 12000);
    });
  }

  function startYtClock() {
    stopYtClock();
    ytTimer = setInterval(() => {
      if (V.backend !== "yt") return;
      V.noteListening();
      V.updatePositionState();
      V.emit({ type: "time" });
    }, 500);
  }
  function stopYtClock() { if (ytTimer) { clearInterval(ytTimer); ytTimer = null; } }

  function stopSourceRetry() {
    if (V.sourceRetryTimer) { clearTimeout(V.sourceRetryTimer); V.sourceRetryTimer = null; }
    V.sourceRetryStep = 0;
    V.sourceRetryTrack = null;
    V.sourceRetryAt = 0;
    V.sourceRetryReason = "";
  }

  function scheduleSourceRetry(track, resumeAt, reason) {
    if (!V.wantsPlayback || !track || !V.current() || V.current().id !== track.id) return;
    if (V.sourceRetryTrack && V.sourceRetryTrack.id !== track.id) stopSourceRetry();
    V.sourceRetryTrack = track;
    V.sourceRetryAt = resumeAt || 0;
    V.sourceRetryReason = reason;
    if (V.platformBlocksAutoPlay()) {
      const session = navigator.audioSession;
      // A readable session confirms the return with "active"; one whose state cannot be
      // read never will, and there reopening the app stands in for it (retrySourceNow
      // applies the same rule).
      const focusAlreadyReturned = !V.mediaSessionPauseDecisionTimer && !V.audioSessionInterrupted &&
        V.focusResumeConfirmed && (V.sessionStateUnknowable() || (V.audioSessionBound && session && session.state === "active"));
      if (!focusAlreadyReturned) return;
      V.platformPaused = false;
      V.focusResumePending = false;
      V.focusResumeConfirmed = false;
    }
    if (V.sourceRetryTimer) return;
    const delay = V.SOURCE_RETRY_DELAYS[Math.min(V.sourceRetryStep, V.SOURCE_RETRY_DELAYS.length - 1)];
    V.sourceRetryStep++;
    V.sourceRetryTimer = setTimeout(() => {
      V.sourceRetryTimer = null;
      if (!V.wantsPlayback || !V.current() || V.current().id !== track.id) { stopSourceRetry(); return; }
      if ((navigator.onLine === false && V.sourceRetryReason !== "audio interruption") || V.platformBlocksAutoPlay()) {
        scheduleSourceRetry(track, V.sourceRetryAt, reason);
        return;
      }
      V.log("play", track.id + " retrying after " + reason);
      V.loadAndPlay(track, V.sourceRetryAt, true);
    }, delay);
  }

  function retrySourceNow(reason, focusReturned) {
    if (!V.sourceRetryTrack || !V.wantsPlayback || V.loadingInProgress || V.mediaSessionPauseDecisionTimer ||
        (navigator.onLine === false && V.sourceRetryReason !== "audio interruption")) return false;
    if (V.platformBlocksAutoPlay()) {
      const session = navigator.audioSession;
      const safe = focusReturned === true && V.focusResumePending && V.focusResumeConfirmed &&
        (V.sessionStateUnknowable() || (V.audioSessionBound && session && session.state === "active"));
      if (!safe) return false;
      V.platformPaused = false;
      V.audioSessionInterrupted = false;
      V.focusResumePending = false;
      V.focusResumeConfirmed = false;
    }
    const track = V.sourceRetryTrack;
    if (!V.current() || V.current().id !== track.id) { stopSourceRetry(); return false; }
    const resumeAt = V.sourceRetryAt;
    if (V.sourceRetryTimer) { clearTimeout(V.sourceRetryTimer); V.sourceRetryTimer = null; }
    V.log("play", track.id + " retrying on " + reason);
    V.loadAndPlay(track, resumeAt, true);
    return true;
  }

  function stopAudio(preserveIntent) {
    V.interruptionCheckpoint = null;
    V.stopNativeResumeCheck();
    V.stopRouteRecovery();
    V.clearAirPlaySourceChange();
    V.stopAudioFocusResumeRetry();
    V.pendingPlaybackPermission = null;
    const intended = !!preserveIntent && V.wantsPlayback;
    const heldPlatformPause = intended && V.platformPaused;
    const heldInterruption = intended && V.audioSessionInterrupted;
    const heldFocusResume = intended && V.focusResumePending;
    const heldFocusConfirmation = intended && V.focusResumeConfirmed;
    if (!preserveIntent) {
      V.clearMediaSessionPauseDecision();
      V.clearMediaSessionPauseExpectation();
    }
    V.audioSessionGeneration++;
    V.wantsPlayback = false;
    V.platformPaused = false;
    V.audioSessionInterrupted = false;
    V.focusResumePending = false;
    V.focusResumeConfirmed = false;
    V.focusResumeAttempting = false;
    V.focusResumeAttemptGeneration = -1;
    V.stopYtFocusResumeRetry();
    V.pausedByNetwork = false;
    V.clearStallCheck();
    V.stopNetworkResumeWatch();
    if (!preserveIntent) stopSourceRetry();
    V.cancelCrossfade();
    V.discardPrep();
    V.clearEarlyPrefetch();
    V.audio.pause();
    V.audio.removeAttribute("src");
    try { V.audio.load(); } catch (e) {}
    V.wantsPlayback = intended;
    V.platformPaused = heldPlatformPause;
    V.audioSessionInterrupted = heldInterruption;
    V.focusResumePending = heldFocusResume;
    V.focusResumeConfirmed = heldFocusConfirmation;
  }
  function stopYt() {
    V.stopYtFocusResumeRetry();
    stopYtClock();
    if (yt && ytReady) { try { yt.stopVideo(); } catch (e) {} }
  }
})();
