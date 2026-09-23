(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    getTime: { get: () => getTime },
    isPaused: { get: () => isPaused },
    logAudioDuration: { get: () => logAudioDuration },
    mediaSessionPause: { get: () => mediaSessionPause },
    next: { get: () => next },
    pausePlay: { get: () => pausePlay },
    playbackDuration: { get: () => playbackDuration },
    primeForPlayback: { get: () => primeForPlayback },
    releaseForVoice: { get: () => releaseForVoice },
    rememberStreamDuration: { get: () => rememberStreamDuration },
    resumePlay: { get: () => resumePlay },
    seekTo: { get: () => seekTo },
    toggle: { get: () => toggle }
  });

  /**
   * @param {boolean} [fromEnded] True when the current track finished on its own.
   * @returns {Promise<void>}
   */
  async function next(fromEnded) {
    if (V.sleepAfterTrack && fromEnded) { V.stopForSleep(); return; }
    if (V.repeat === "one" && fromEnded) {
      V.replayCurrent();
      return;
    }
    V.commitPendingPreparedStart("next");
    let ni = V.pickNextIndex();
    if (fromEnded && ni !== -1 && navigator.onLine === false && !V.remotePlaybackActive()) {
      // With no signal the music carries on with what is on the device, quietly: the
      // song after this one may not be saved, and the one after that may be.
      const token = V.loadingToken;
      const saved = await V.localIds().catch(() => new Set());
      if (token !== V.loadingToken) return;
      const local = saved.has(V.queue[ni].id) ? ni : V.pickNextIndex(t => saved.has(t.id));
      if (local !== -1) ni = local;
    }
    if (ni === -1) {
      if (V.shareSession && V.current()) V.shareExhausted = true;
      const token = V.loadingToken;
      const generation = V.radioGeneration;
      await V.waitForRadioAtEnd();
      if (token !== V.loadingToken || generation !== V.radioGeneration) return;
      ni = V.pickNextIndex();
      if (ni === -1 && (V.shareSession || Store.settings().autoplay) && V.radioPromise) {
        // A slow refill may still produce new songs. Wait for it without looping through
        // music already heard. Pause, a new selection and queue clearing invalidate this wait.
        V.log("radio", "waiting for new songs at the end of the queue");
        await V.radioPromise;
        if (token !== V.loadingToken || generation !== V.radioGeneration) return;
        ni = V.pickNextIndex();
      }
      if (ni === -1) {
        // The one way playback ends by itself. Silence with nothing in the log behind it
        // is the hardest thing to answer when someone says the music just stopped.
        V.log("play", "queue ended after " + V.queue.length + " track(s)" +
          (V.failedQueueIds.size ? ", " + V.failedQueueIds.size + " of them unplayable" : "") +
          (Store.settings().autoplay ? "" : " - autoplay is off"));
        if (fromEnded) {
          pausePlay();
          if (V.shareSession) V.shareExhausted = true;
          V.emit({ type: "state" });
        }
        V.emit({ type: "queue-end" });
        return;
      }
    }
    if (!fromEnded && !V.loadingInProgress && !V.xfade && V.prepValid() && V.xfadePrep.ni === ni &&
        !V.xfadePrep.repairing && V.wantsPlayback && !V.platformBlocksAutoPlay()) {
      V.cancelSleepFade();
      if (V.playPreparedInstantly(true)) return;
    }
    V.history.push(V.pos);
    V.pos = ni;
    V.persist();
    V.loadAndPlay(V.current());
  }

  function rememberStreamDuration(track, info) {
    const duration = Number(info && info.duration);
    if (track && Number.isFinite(duration) && duration > 0) V.streamDurations.set(track.id, duration);
  }

  function playbackDuration() {
    const media = V.audio.duration;
    const track = V.current();
    const expected = track && (V.streamDurations.get(track.id) || Number(track.duration));
    // A malformed container can claim minutes of audio beyond the known upload length.
    // Use fresh source metadata when available, including for prepared tracks. Small
    // encoding/rounding differences and speech keep the media's own endpoint.
    // The numeric guards go first: the spoken-word classifier can scan the library and
    // recents, and this runs several times per timeupdate tick.
    if (track && Number.isFinite(expected) && expected > 0 && Number.isFinite(media) &&
        media - expected > Math.max(30, expected * 0.25) && !V.isSpokenWord(track)) return expected;
    return Number.isFinite(media) && media > 0 ? media : 0;
  }

  function logAudioDuration() {
    const track = V.current();
    if (V.backend !== "audio" || V.loadingInProgress || V.preparedStart || !track || !V.audio.src) return;
    const values = [track.id, V.audio.src, V.audio.duration, track.duration,
      V.streamDurations.get(track.id) || 0, playbackDuration()];
    const signature = values.join("|");
    if (V.reportedDurations.get(V.audio) === signature) return;
    V.reportedDurations.set(V.audio, signature);
    V.log("duration", track.id + " media=" + values[2] + "s catalog=" + values[3] +
      "s source=" + values[4] + "s playback=" + values[5] + "s route=" + V.remoteState);
  }

  /**
   * @returns {{ cur: number, dur: number }} Position and length in seconds.
   */
  function getTime() {
    if (V.backend === "yt" && V.yt && V.ytReady) {
      try { return { cur: V.yt.getCurrentTime() || 0, dur: V.yt.getDuration() || 0 }; } catch (e) { return { cur: 0, dur: 0 }; }
    }
    const dur = playbackDuration();
    const cur = V.audio.currentTime || 0;
    return { cur: dur ? Math.min(cur, dur) : cur, dur };
  }

  /**
   * @returns {boolean}
   */
  function isPaused() {
    if (V.backend === "yt" && V.yt && V.ytReady) {
      try { return V.yt.getPlayerState() !== YT.PlayerState.PLAYING; } catch (e) { return true; }
    }
    return V.audio.paused;
  }

  /**
   * @param {number} sec
   */
  function seekTo(sec) {
    if (!Number.isFinite(sec)) return;
    V.interruptionCheckpoint = null;
    V.stopNativeResumeCheck();
    const dur = getTime().dur;
    sec = Math.max(0, dur > 0 ? Math.min(sec, dur) : sec);
    if (V.backend === "yt" && V.yt && V.ytReady) { try { V.yt.seekTo(sec, true); } catch (e) {} }
    else { V.cancelCrossfade(); V.audio.currentTime = sec; }
    V.listenClock = sec;
    V.saveListeningPosition();
    // Background timers may be suspended. Publish seeks during the control action.
    V.updatePositionState();
  }

  function resumePlay() {
    // A deadline that passed while the page slept has done its work by now; a Play
    // pressed after it asks to listen again, not to stop.
    if (V.sleepDeadline && Date.now() >= V.sleepDeadline) V.finishSleep();
    if (V.audioFocusInterrupted()) {
      V.wantsPlayback = true;
      V.platformPaused = true;
      V.audioSessionInterrupted = true;
      V.focusResumePending = true;
      V.focusResumeConfirmed = false;
      V.updatePlaybackState();
      return;
    }
    V.stopNativeResumeCheck();
    V.stopAudioFocusResumeRetry();
    // A position held for an interruption's recovery belongs to that interruption.
    V.interruptionCheckpoint = null;
    V.routeReattached = false;
    if (V.backend === "audio" && (V.audio.ended || V.handledEndGeneration === V.playbackGeneration)) {
      // An end-of-queue lookup still pending would cut this replay off when it lands,
      // and a shared queue's next contribution would too if the queue still read as
      // exhausted.
      V.cancelRadioExtension();
      V.shareExhausted = false;
      if (!V.audio.ended) V.audio.currentTime = 0;
      V.playbackGeneration++;
      V.handledEndGeneration = -1;
      V.resetListenTracking(V.current());
    }
    V.reviveStoppedMediaSession();
    V.clearMediaSessionPauseDecision();
    V.clearMediaSessionPauseExpectation();
    V.stopYtFocusResumeRetry();
    V.audioSessionGeneration++;
    V.wantsPlayback = true;
    V.platformPaused = false;
    V.audioSessionInterrupted = false;
    V.focusResumePending = false;
    V.focusResumeConfirmed = false;
    V.focusResumeAttempting = false;
    V.focusResumeAttemptGeneration = -1;
    V.pausedByNetwork = false;
    V.configureAudioSession();
    V.ensureSessionKick();
    V.syncSessionKick(true);
    V.lastAudioTime = V.audio.currentTime || 0;
    V.lastAudioProgressAt = Date.now();
    if (V.loadingInProgress) { V.updatePlaybackState(); return; }
    if (V.remotePlaybackActive() && (!V.remoteSource || !/^https?:\/\//i.test(V.audio.src))) {
      V.prepareRemotePlayback();
      return;
    }
    if (V.backend === "yt" && V.yt && V.ytReady) { V.startYtClock(); try { V.yt.playVideo(); } catch (e) {} }
    else if (!V.audio.src) {
      const noted = V.restoredPosition && V.current() && V.restoredPosition.id === V.current().id ? V.restoredPosition.at : 0;
      V.restoredPosition = null;
      // Read before the retry is asked for: refused with no signal, the load below used to
      // start the held song from the top and write that over its place.
      const held = V.sourceRetryTrack && V.current() && V.sourceRetryTrack.id === V.current().id ? V.sourceRetryAt : 0;
      if (!V.retrySourceNow("listener play") && V.current()) V.loadAndPlay(V.current(), V.resumeAfterCastAt || held || noted);
      V.resumeAfterCastAt = 0;
    } else {
      const pending = V.pendingPlaybackPermission;
      const token = V.loadingToken;
      const track = V.current();
      const valid = () => token === V.loadingToken && V.current() && track && V.current().id === track.id && V.wantsPlayback;
      // Call synchronously inside the Play gesture, before waiting on any promise.
      try {
        Promise.resolve(V.audio.play()).then(() => {
          if (!valid()) return;
          if (pending && pending === V.pendingPlaybackPermission && pending.src === V.audio.src) {
            V.pendingPlaybackPermission = null;
            if (pending.actualTrack.id !== track.id) { V.swapQueueEntry(V.pos, pending.actualTrack); V.persist(); }
            V.log("play", pending.actualTrack.id + " started after Play permission");
            V.finishTrackStart(pending.actualTrack, pending.resumeAt);
          } else {
            V.prefetchNext();
            V.scheduleEarlyPrefetch();
          }
        }).catch(error => {
          if (!valid()) return;
          if (V.playbackPermissionDenied(error)) V.holdPlaybackPermission(track, pending ? pending.resumeAt : V.audio.currentTime, pending && pending.actualTrack);
          else if (pending) V.loadAndPlay(track, pending.resumeAt);
        });
      } catch (error) {
        if (valid() && V.playbackPermissionDenied(error)) V.holdPlaybackPermission(track, pending ? pending.resumeAt : V.audio.currentTime, pending && pending.actualTrack);
      }
    }
    V.updatePositionState();
  }

  /** Pauses playback. */
  function pausePlay() {
    V.stopNativeResumeCheck();
    V.stopRouteRecovery();
    V.stopAudioFocusResumeRetry();
    V.shareExhausted = false;
    if (V.shareSession) V.cancelRadioExtension();
    V.clearMediaSessionPauseDecision();
    V.clearMediaSessionPauseExpectation();
    V.stopYtFocusResumeRetry();
    V.audioSessionGeneration++;
    V.interruptionCheckpoint = null;
    // A Media Session pause can arrive while a source or fallback is still resolving.
    // Always invalidate that work so it cannot restore playback intent afterward.
    const cancelledLoad = V.loadingInProgress;
    V.loadingToken++;
    V.loadingInProgress = false;
    V.wantsPlayback = false;
    V.platformPaused = false;
    V.audioSessionInterrupted = false;
    V.focusResumePending = false;
    V.focusResumeConfirmed = false;
    V.focusResumeAttempting = false;
    V.focusResumeAttemptGeneration = -1;
    V.pausedByNetwork = false;
    V.clearStallCheck();
    V.stopSourceRetry();
    V.stopNetworkResumeWatch();
    if (cancelledLoad) {
      // The queue already points at the requested track while the attached source may
      // still belong to the previous one. Detach both backends so the next Play resolves
      // the current queue entry instead of reviving stale audio under new metadata.
      if (V.remotePlaybackActive()) V.resumeAfterCastAt = getTime().cur || V.resumeAfterCastAt;
      V.stopAudio();
      V.stopYt();
      V.backend = "audio";
      // The lock screen still names the song that was playing; the queue has moved on.
      if (V.current()) V.updateMediaSession(V.current());
    } else if (V.backend === "yt" && V.yt && V.ytReady) { V.stopYtClock(); try { V.yt.pauseVideo(); } catch (e) {} }
    else {
      if (!V.commitPendingPreparedStart("listener pause")) V.cancelPreparedStart();
      V.cancelCrossfade();
      V.audio.pause();
    }
    V.updatePositionState();
  }

  // Close and forget the silent session-holder context so it stops pinning the AVAudioSession.
  // ensureSessionKick recreates it on the next play (sessionKick is null again), so the
  // interruption-recovery client returns with playback. The listener is dropped first so the
  // close's own statechange cannot run against a torn-down context.
  function releaseSessionKick() {
    if (!V.sessionKick) return;
    const ctx = V.sessionKick;
    V.sessionKick = null;
    V.sessionKickSource = null;
    V.sessionKickResuming = false;
    try { if (ctx.removeEventListener) ctx.removeEventListener("statechange", V.onSessionKickStateChange); } catch (e) {}
    try { ctx.onstatechange = null; } catch (e) {}
    try { Promise.resolve(ctx.close()).catch(() => {}); } catch (e) {}
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
  // tap, re-arm the element's playback permission so the track the AI resolves seconds later
  // starts without a manual Play tap. No-op off iOS and off the audio backend.
  /** On iOS, lets go of the audio element so the microphone can open. */
  function releaseForVoice() {
    if (!V.isIOS || V.backend !== "audio") return;
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
      releaseSessionKick();
    }
    primeForPlayback();
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
          pausePlay();
        }, 500);
        if (V.backend === "yt" && V.yt && V.ytReady) {
          try { V.yt.pauseVideo(); } catch (e) {}
        } else V.pauseIfRunning();
        V.updatePlaybackState();
      }
      return;
    }
    pausePlay();
  }

  /** Plays or pauses, or cancels a track that is still loading. */
  function toggle() {
    if (!V.current()) return;
    if (V.loadingInProgress) {
      V.loadingToken++;
      V.loadingInProgress = false;
      V.stopAudio();
      V.stopYt();
      // Like a pause during a load: the queue points at the new track while the
      // iframe still holds the old one, so the next tap must resolve the new one.
      V.backend = "audio";
      if (V.current()) V.updateMediaSession(V.current());
      V.emit({ type: "state" });
      return;
    }
    if (V.backend === "audio" && !V.audio.src) { resumePlay(); return; }
    if (isPaused()) resumePlay(); else pausePlay();
  }
})();
