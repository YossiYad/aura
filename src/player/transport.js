(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    getTime: { get: () => getTime },
    isPaused: { get: () => isPaused },
    logAudioDuration: { get: () => logAudioDuration },
    next: { get: () => next },
    pausePlay: { get: () => pausePlay },
    playbackDuration: { get: () => playbackDuration },
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
      // A queue edit during the read does not bump the token; re-pick from what is there now.
      ni = V.pickNextIndex();
      // Emptied during the read, the queue ends below like any other; returning here
      // left wantsPlayback on with nothing playing and no queue-end for anyone.
      if (ni !== -1) {
        const local = saved.has(V.queue[ni].id) ? ni : V.pickNextIndex(t => saved.has(t.id));
        if (local !== -1) ni = local;
      }
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
    // A handoff already running on the standby element is the next song starting. The
    // ended element reads as paused meanwhile, so Play pressed here must join that
    // handoff, not restart the finished song under it with both elements sounding.
    if (V.preparedStart && V.preparedStart.el !== V.audio && V.commitPendingPreparedStart("listener play")) {
      V.wantsPlayback = true;
      V.updatePlaybackState();
      return;
    }
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
    const trackTime = cancelledLoad && V.remotePlaybackActive() ? V.currentTrackTime() : 0;
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
      if (V.remotePlaybackActive()) V.resumeAfterCastAt = trackTime || V.resumeAfterCastAt;
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
