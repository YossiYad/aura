(function () {
  const V = window.Aura.player;
  // Wiring at load: the two audio elements and the Cast element bound, the page lifecycle listeners, the audio session configured.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    audioRetryId: { get: () => audioRetryId, set: value => { audioRetryId = value; } }
  });

  let audioRetryId = null;

  V.bindAudioEvents(V.audioA);

  V.bindAudioEvents(V.audioB);

  V.configureRemoteElements();

  V.bindRemotePlayback(V.audioA);

  V.bindRemotePlayback(V.audioB);

  if (window.CastPlayback) {
    V.bindAudioEvents(CastPlayback.audio);
    CastPlayback.onChange(event => {
      if (event.type === "connected") {
        const at = V.currentTrackTime();
        V.loadingToken++;
        V.remotePreparation = null;
        V.loadingInProgress = true;
        V.cancelCrossfade();
        V.commitInterruptedPreparedStart("Cast connection");
        V.discardPrep();
        V.localBeforeCast = V.audio;
        V.audio.pause();
        V.audio = CastPlayback.audio;
        V.audio.currentTime = at;
        V.attachedTrackId = V.current() ? V.current().id : null;
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

  V.configureAudioSession();
})();
