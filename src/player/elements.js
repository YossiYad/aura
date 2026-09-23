(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    audioRetryId: { get: () => audioRetryId, set: value => { audioRetryId = value; } }
  });

  function bindAudioEvents(el) {
    // Every path that starts a source goes through here, including the one the background
    // preparer sets up, so nothing has to remember to re-apply the speed by hand.
    el.addEventListener("loadstart", () => {
      V.applyRate(el);
      if (el === V.audio && V.backend === "audio") V.clearPositionState();
    });
    el.addEventListener("canplay", () => {
      if (V.preparedStart && V.preparedStart.el === el) {
        V.preparedStart.ready();
        return;
      }
      if (V.xfadePrep && V.xfadePrep.el === el && !V.xfadePrep.repairing && !V.xfadePrep.ready) {
        V.xfadePrep.ready = true;
        V.log("background", V.xfadePrep.id + " ready for continuous playback");
      }
    });
    // A final timeupdate/pause can already have started the next source. Ignore
    // an ended notification queued for the old resource after that handoff.
    el.addEventListener("ended", () => { if (el.ended) V.handleAudioEnd(el, "event"); });
    el.addEventListener("playing", () => {
      if (V.preparedStart && V.preparedStart.el === el) V.preparedStart.confirm();
      if (el === V.audio && V.backend === "audio") V.refreshMediaSessionControls();
    });
    el.addEventListener("play", () => {
      if (V.audio.isCast && el !== V.audio) { el.pause(); return; }
      if (el !== V.audio) return;
      if (el.isCast) {
        V.wantsPlayback = true;
        V.reviveStoppedMediaSession();
      }
      const staleFocusAttempt = V.focusResumeAttemptGeneration >= 0 &&
        V.focusResumeAttemptGeneration !== V.audioSessionGeneration;
      if (!V.wantsPlayback || staleFocusAttempt || V.audioFocusInterrupted() || V.mediaSessionPauseDecisionTimer) {
        V.focusResumeAttempting = false;
        V.focusResumeAttemptGeneration = -1;
        el.pause();
        if (staleFocusAttempt && V.focusResumePending) {
          const generation = V.audioSessionGeneration;
          setTimeout(() => V.resumePlatformPause("updated focus return", generation), 0);
        }
        return;
      }
      if (V.platformPaused || V.focusResumePending) {
        V.log("background", "play event after interruption at " + (el.currentTime || 0).toFixed(2) + "s");
        V.reportBackgroundHold("native play event");
        // A native resume can arrive on a still-inactive session. Request the
        // session alongside it so the decoder has audio to render into.
        V.resumeSessionKick("native resume");
        if (!V.nativeResumeCheck && V.backend === "audio" && !V.remotePlaybackActive()) {
          const held = V.interruptionCheckpoint;
          const position = held && held.target === el && held.source === el.src && held.token === V.loadingToken
            ? held.position : el.currentTime || 0;
          V.interruptionCheckpoint = null;
          V.nativeResumeCheck = { target: el, source: el.src, token: V.loadingToken,
            position, attempted: false, restarting: false };
          V.verifyNativeResume();
        }
      }
      V.stopAudioFocusResumeRetry();
      V.stopBackgroundHoldWatch();
      V.audioSessionInterrupted = false;
      V.platformPaused = false;
      V.focusResumePending = false;
      V.focusResumeConfirmed = false;
      V.focusResumeAttempting = false;
      V.focusResumeAttemptGeneration = -1;
      V.pausedByNetwork = false;
      V.stopSourceRetry();
      V.stopNetworkResumeWatch();
      V.lastAudioTime = V.audio.currentTime || 0;
      V.lastAudioProgressAt = Date.now();
      V.updatePositionState();
      V.emit({ type: "state" });
    });
    el.addEventListener("pause", () => {
      if (el !== V.audio) return;
      // Media events are queued: this pause can belong to a source which has
      // already been replaced and resumed. It is not a loss of audio focus.
      if (!el.paused) return;
      if (V.nativeResumeCheck && !V.nativeResumeCheck.restarting) V.stopNativeResumeCheck();
      if (el.ended) {
        V.handleAudioEnd(el, "pause at end");
        V.updatePositionState();
        V.emit({ type: "state" });
        return;
      }
      V.clearStallCheck();
      V.saveListeningPosition();
      if (el.isCast && !V.loadingInProgress && !el.ended && V.handledEndGeneration !== V.playbackGeneration) {
        V.wantsPlayback = false;
        V.platformPaused = false;
        V.focusResumePending = false;
        V.stopSourceRetry();
      }
      // A stop that our controls and network handling did not request is either the
      // track finishing or the browser/OS taking focus. Both branches below share this.
      const unsolicitedStop = V.backend === "audio" && V.wantsPlayback && !V.pausedByNetwork &&
        !V.loadingInProgress && V.audio.src && V.handledEndGeneration !== V.playbackGeneration;
      // iOS WebKit can stop at the last decodable sample with `ended` still false when
      // the container promises a hair more audio than the stream carries. In the
      // background no timer or watchdog will run again to notice, and recording it as a
      // platform pause would hold the queue silent until a tap. A stop inside the final
      // second of both the song and the container is the track finishing, unless focus
      // loss was announced, a wireless route is settling, or the end handler declines
      // and falls through to the ordinary platform pause. An inflated container's
      // silent tail never satisfies this: its own endpoint is minutes away. Other
      // engines fire ended reliably and resume their own interruptions, so they keep
      // the interruption reading for every unexplained pause.
      if (V.isIOS && unsolicitedStop && !el.seeking && !V.platformBlocksAutoPlay() &&
          !V.remotePlaybackActive() && Date.now() >= V.routeSettlingUntil) {
        const dur = V.playbackDuration();
        const cur = el.currentTime || 0;
        // One second covers whole-second catalog rounding, as in the stall checks. The
        // container comparison is NaN-safe: an unknown or live duration never passes.
        // Tracks of a couple of seconds keep the interruption reading, so a jingle
        // paused halfway is not counted as finished.
        if (dur > 2 && cur >= dur - 1 && cur >= el.duration - 1 &&
            V.handleAudioEnd(el, "pause near track end")) {
          V.updatePositionState();
          V.emit({ type: "state" });
          return;
        }
      }
      // A pause that did not come from our controls or network handling belongs to the
      // browser or OS. Do not call play() here: that would request audio focus again and
      // interrupt the other app. Chrome and supporting Audio Session implementations keep
      // transient interruptions in their media session and resume them when focus returns.
      if (unsolicitedStop && !V.audio.ended) {
        V.platformPaused = true;
        V.platformPausedAt = Date.now();
        V.focusResumePending = true;
        // A queued pause may be delivered after the active notification. Do not
        // erase that confirmation before the focus-return callback can use it.
        V.focusResumeConfirmed = V.focusResumeConfirmed && !V.audioFocusInterrupted();
        V.commitInterruptedPreparedStart("platform pause");
        V.cancelCrossfade();
        V.log("background", "playback suspended by the browser or operating system");
        V.watchBackgroundHold();
      }
      V.updatePositionState();
      V.emit({ type: "state" });
    });
    el.addEventListener("waiting", () => { if (el === V.audio && !V.loadingInProgress) { V.log("audio", (V.current() || {}).id + " waiting at " + Math.round(V.audio.currentTime || 0) + "s of " + V.playbackDuration() + "s"); V.scheduleStallCheck("waiting"); } });
    el.addEventListener("stalled", () => { if (el === V.audio && !V.loadingInProgress) { V.log("audio", (V.current() || {}).id + " stalled at " + Math.round(V.audio.currentTime || 0) + "s of " + V.playbackDuration() + "s"); V.scheduleStallCheck("stalled"); } });
    for (const event of ["loadedmetadata", "durationchange", "seeked", "ratechange", "emptied"]) {
      el.addEventListener(event, () => {
        if (el === V.audio && V.backend === "audio") V.updatePositionState();
      });
    }
    el.addEventListener("seeking", () => {
      if (el === V.audio && V.backend === "audio") V.listenClock = V.getTime().cur || 0;
    });
    el.addEventListener("timeupdate", () => {
      if (el !== V.audio || V.backend !== "audio") return;
      // Some receivers load the new resource without dropping the route flag.
      // Real playback on that route ends the grace period too, so a subsequent
      // listener disconnect is handled immediately rather than waiting it out.
      if (V.airPlaySourceChangeActive(el) && el.webkitCurrentPlaybackTargetIsWireless &&
          !el.paused && !el.seeking && el.readyState >= 2 &&
          Math.abs((el.currentTime || 0) - V.airPlaySourceChange.position) >= 0.2) V.clearAirPlaySourceChange();
      if (V.preparedStart && V.preparedStart.el === el) {
        V.preparedStart.progress();
        if (V.preparedStart) { V.preparedStart.checkDeadline(); return; }
      }
      V.noteAudioProgress();
      V.noteListening();
      // Mobile browsers can suspend the page between the final media update
      // and ended. Start the prepared source in this native callback, even if
      // the element already reports paused, without waiting for a timer/wakeup.
      if (el.ended) { V.handleAudioEnd(el, "timeupdate at end"); return; }
      if (V.finishInflatedDuration()) return;
      V.skipSegmentIfInside();
      V.updatePositionState();
      V.maybeCrossfade();
      V.emit({ type: "time" });
    });
    el.addEventListener("error", () => {
      if (V.preparedStart && V.preparedStart.el === el) {
        V.preparedStart.failed(new Error("prepared audio element error"));
        return;
      }
      if (V.xfadePrep && V.xfadePrep.el === el) {
        V.repairPreparedSource(V.xfadePrep, new Error("prepared audio element error"));
        return;
      }
      if (el !== V.audio) return;
      if (V.backend !== "audio" || !V.audio.src || !V.current()) return;
      if (V.loadingInProgress) return;
      if (V.nativeResumeCheck && V.nativeResumeCheck.reloaded && !V.mediaWasRejected(null, el)) {
        V.holdNativeResume(V.nativeResumeCheck, "element error " + ((el.error || {}).code || "?"));
        return;
      }
      if (V.remotePlaybackActive() && V.activeLocalKind) {
        V.prepareRemotePlayback();
        return;
      }
      V.log("audio", "element error on " + (V.current() || {}).id + ": code " + ((V.audio.error || {}).code || "?"));
      if (V.remotePlaybackActive()) {
        // The Play that retries must ask for a fresh receiver stream, not the cached
        // one the receiver just refused.
        if (Api.invalidate && V.current()) Api.invalidate(V.current().id, false);
        V.holdRemotePlayback();
        return;
      }
      const t = V.current();
      const token = V.loadingToken;
      const retryAt = V.audio.currentTime || 0;
      const fallYt = error => {
        if (token !== V.loadingToken || V.fallbackHandledToken === token) return;
        if (V.playbackPermissionDenied(error)) {
          V.holdPlaybackPermission(t, retryAt);
          return;
        }
        if (V.platformBlocksAutoPlay()) {
          V.stopAudio(true);
          V.scheduleSourceRetry(t, retryAt, "audio interruption");
          return;
        }
        V.fallbackHandledToken = token;
        if (V.remotePlaybackActive()) {
          V.holdRemotePlayback();
          return;
        }
        if (Store.settings().noYtFallback) {
          V.failedQueueIds.add(t.id);
          V.stopAudio(true);
          V.emit({ type: "state" });
          V.reportPlaybackFailure({ type: "fallback-skip", track: t });
          V.scheduleSourceRetry(t, retryAt, "stream error");
          return;
        }
        V.emit({ type: "fallback-yt", track: t });
        V.playViaYt(t, token).then(() => V.emit({ type: "state" })).catch(e => {
          if (token !== V.loadingToken) return;
          if (e && e.focusBlocked) {
            V.stopAudio(true);
            V.scheduleSourceRetry(t, retryAt, "audio interruption");
            return;
          }
          V.reportPlaybackFailure({ type: "error", track: t, error: new Error("Playback failed") });
        });
      };
      const failedKind = V.activeLocalKind;
      if (!failedKind && navigator.onLine === false) {
        // A stream that errors with no signal is the signal's doing. Asking again could
        // only fail, and the way on from there led to YouTube and a notice that the
        // servers were down. Keep the place, and pick it up when the signal is back.
        V.log("network", "offline, holding " + t.id + " at " + Math.round(retryAt) + "s after a stream error");
        V.stopAudio(true);
        V.emit({ type: "state" });
        V.scheduleSourceRetry(t, retryAt, "network loss");
        return;
      }
      if (failedKind) {
        V.activeLocalKind = null;
        audioRetryId = t.id;
        // Only a copy the decoder refused is a bad file. An aborted or network error on
        // a local blob says nothing about it, so that copy is bypassed for this session
        // rather than deleted, as every other local-failure path already does.
        const rejected = V.mediaWasRejected(null, el);
        V.rejectedLocalCache.add(t.id);
        const remove = rejected ? (failedKind === "cache" ? V.deleteCached(t.id) : V.deleteDownload(t.id)) : Promise.resolve();
        remove
          .then(() => {
            if (token !== V.loadingToken) return;
            if (V.blobUrl) URL.revokeObjectURL(V.blobUrl);
            V.blobUrl = null;
            V.log("cache", t.id + (rejected ? " removed invalid local " : " bypassed local ") + failedKind);
            return Api.resolve(t.id, V.streamOptions(t.id));
          })
          .then(info => { if (info && token === V.loadingToken) return V.playViaAudio(info.url, info).then(() => {
            if (token !== V.loadingToken) return;
            V.seekTo(retryAt);
            V.emit({ type: "state" });
          }); })
          .catch(fallYt);
        return;
      }
      if (audioRetryId === t.id) return fallYt();
      audioRetryId = t.id;
      Api.invalidate(t.id, false);
      Api.resolve(t.id, V.streamOptions(t.id))
        .then(info => { if (token === V.loadingToken) return V.playViaAudio(info.url, info).then(() => {
            if (token !== V.loadingToken) return;
            V.seekTo(retryAt);
            V.emit({ type: "state" });
          }); })
        .catch(fallYt);
    });
  }

  let audioRetryId = null;
  bindAudioEvents(V.audioA);
  bindAudioEvents(V.audioB);
  V.configureRemoteElements();
  V.bindRemotePlayback(V.audioA);
  V.bindRemotePlayback(V.audioB);
  if (window.CastPlayback) {
    bindAudioEvents(CastPlayback.audio);
    CastPlayback.onChange(event => {
      if (event.type === "connected") {
        V.loadingToken++;
        V.remotePreparation = null;
        const at = V.getTime().cur;
        V.loadingInProgress = true;
        V.cancelCrossfade();
        V.commitInterruptedPreparedStart("Cast connection");
        V.discardPrep();
        V.localBeforeCast = V.audio;
        V.audio.pause();
        V.audio = CastPlayback.audio;
        V.audio.currentTime = at;
        V.remoteState = "connected";
        V.platformPaused = false;
        V.audioSessionInterrupted = false;
        V.focusResumePending = false;
        V.clearMediaSessionPauseDecision();
        V.configureRemoteElements();
        V.loadingInProgress = false;
        V.prepareRemotePlayback();
      } else if (event.type === "disconnected" && V.audio.isCast) {
        V.loadingToken++;
        V.playbackGeneration++;
        V.loadingInProgress = false;
        V.remotePreparation = null;
        V.wantsPlayback = false;
        V.discardPrep();
        V.clearStallCheck();
        V.stopSourceRetry();
        V.resumeAfterCastAt = event.position || 0;
        V.audio = V.localBeforeCast;
        V.audio.removeAttribute("src");
        V.audio.load();
        V.remoteState = "disconnected";
        V.remoteSource = false;
        V.platformPaused = false;
        V.configureRemoteElements();
        if (V.current()) V.updateMediaSession(V.current());
      } else if (event.type === "error") {
        V.emit({ type: "remote-error", message: event.message });
      } else if (event.type === "track" && V.audio.isCast && !V.loadingInProgress && V.current() && V.current().id !== event.id) {
        const index = V.queue.findIndex(track => track.id === event.id && !Store.isBlocked(track));
        if (index < 0) { V.pausePlay(); return; }
        V.countListen("finished on TV");
        V.audio.mediaTrack = V.queue[index];
        const prep = V.xfadePrep && V.xfadePrep.id === event.id ? V.xfadePrep :
          { ni: index, id: event.id, src: V.audio.src, gain: 1 };
        V.commitPreparedOnActive(prep);
      }
      V.emit({ type: "remote" });
      V.emit({ type: "state" });
    });
  }
  window.addEventListener("pageshow", V.refreshMediaSessionControls);
  document.addEventListener("visibilitychange", () => {
    V.refreshMediaSessionControls();
    V.log("background", "visibility " + document.visibilityState + ", backend " + V.backend + ", paused " + V.isPaused() +
      ", held " + V.platformPaused + ", pending " + V.focusResumePending +
      ", intent " + V.wantsPlayback + ", at " + (V.audio.currentTime || 0).toFixed(2) + "s" +
      ", route " + V.nativeRemotePlaybackState(V.audio) + ", wireless " + !!V.audio.webkitCurrentPlaybackTargetIsWireless +
      ", remote-api " + (V.audio.remote ? V.audio.remote.state : "none"));
    if (document.hidden) {
      if (V.xfade) {
        const f = V.xfade;
        if (f.started && !f.el.paused && !V.platformBlocksAutoPlay()) {
          clearInterval(f.timer);
          V.commitTo(f.el, f.ni, f.blobUrl, f.localKind, f.gain);
        } else {
          V.cancelCrossfade();
        }
      }
      V.configureAudioSession();
      V.saveListeningPosition();
      // The stand-in confirmation below lasts only while the app stays open.
      // Leaving the app returns recovery to platform signals alone.
      if (V.sessionStateUnknowable()) V.focusResumeConfirmed = false;
      V.watchBackgroundHold();
      if (!V.xfadePrep && !V.xfade) V.prepNextSource();
    } else {
      V.reportBackgroundHold("app visible");
      // A suspended timeout must not leave an unconfirmed source stuck forever
      // when the listener returns to the app.
      if (V.preparedStart) V.preparedStart.checkDeadline();
      V.verifyNativeResume();
      if (V.sessionStateUnknowable() && V.platformPaused && V.wantsPlayback && !V.audioSessionInterrupted) {
        // Chrome and stateless Safari never report an active session. The
        // listener returning to the app stands in for the focus-return
        // confirmation the platform cannot give. A load that began under the
        // hold has no resume pending, and still needs the confirmation: without
        // it every song tapped in the reopened app was held until Play.
        V.focusResumeConfirmed = true;
        if (V.focusResumePending && V.backend === "audio" && !V.audio.paused && !V.audio.ended) {
          V.scheduleUnconfirmedFocusResume(V.audioSessionGeneration, "app visible");
        }
      }
      const resumedPlatformPause = V.resumeYtPlatformPause("app visible") ||
        V.resumePlatformPause("app visible");
      if (!resumedPlatformPause) {
        V.retrySourceNow("app visible", true);
        V.resumeAfterNetworkPause("app visible");
      }
      if (V.backend === "audio" && V.wantsPlayback && V.audio.src) {
        if (V.audio.ended) {
          V.handleAudioEnd(V.audio, "visibility");
        } else if (V.finishInflatedDuration()) {
          return;
        } else if (!V.audio.paused && Date.now() - V.lastAudioProgressAt > 12000) {
          V.scheduleStallCheck("visibility", 0);
        }
      }
    }
  });

  setInterval(() => {
    if (V.backend === "audio" && V.wantsPlayback && V.audio.src) {
      if (V.audio.ended) V.handleAudioEnd(V.audio, "watchdog");
      else if (V.finishInflatedDuration()) return;
      else if (!V.audio.paused && Date.now() - V.lastAudioProgressAt > 15000) V.scheduleStallCheck("watchdog", 0);
    }
    if (!V.audio.paused) V.saveListeningPosition();
  }, 5000);

  V.configureAudioSession();
})();
