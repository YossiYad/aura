(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    advanceAfterEnd: { get: () => advanceAfterEnd },
    clearStallCheck: { get: () => clearStallCheck },
    finishInflatedDuration: { get: () => finishInflatedDuration },
    handleAudioEnd: { get: () => handleAudioEnd },
    holdRemotePlayback: { get: () => holdRemotePlayback },
    noteAudioProgress: { get: () => noteAudioProgress },
    scheduleStallCheck: { get: () => scheduleStallCheck }
  });

  function clearStallCheck() {
    if (!V.stallTimer) return;
    clearTimeout(V.stallTimer);
    V.stallTimer = null;
  }

  function noteAudioProgress() {
    V.confirmNativeResumeProgress();
    const now = V.audio.currentTime || 0;
    if (Math.abs(now - V.lastAudioTime) < 0.2) return;
    V.lastAudioTime = now;
    V.lastAudioProgressAt = Date.now();
    clearStallCheck();
  }

  // Both report whether they actually took the end, so a caller that must fall back
  // to other bookkeeping when they decline can tell a handled end from a no-op.
  function advanceAfterEnd(reason) {
    if (V.preparedStart || V.loadingInProgress || V.handledEndGeneration === V.playbackGeneration || V.backend !== "audio" || !V.wantsPlayback ||
        V.platformBlocksAutoPlay() || !V.current()) return false;
    V.handledEndGeneration = V.playbackGeneration;
    clearStallCheck();
    // A metadata endpoint has no native ended event to pause the element for us.
    // Mark it handled first so this pause cannot be mistaken for lost audio focus.
    if (reason === "track duration" && !V.audio.paused) V.audio.pause();
    V.countListen("finished");
    V.log("play", V.current().id + " ended via " + reason);
    if (Store.clearPosition) Store.clearPosition(V.current().id);
    V.next(true);
    return true;
  }

  function handleAudioEnd(el, reason) {
    if (V.backend !== "audio" || V.preparedStart || V.loadingInProgress ||
        V.handledEndGeneration === V.playbackGeneration || !V.wantsPlayback || V.platformBlocksAutoPlay()) return false;
    if (V.xfade && V.xfade.el !== el) {
      const f = V.xfade;
      if (f.started && !f.el.paused) {
        clearInterval(f.timer);
        V.commitTo(f.el, f.ni, f.blobUrl, f.localKind, f.gain);
        return true;
      }
      V.cancelCrossfade();
    }
    if (el !== V.audio) return false;
    if (V.sleepAfterTrack) { V.discardPrep(); V.stopForSleep(); return true; }
    if (V.repeat !== "one" && V.playPreparedInstantly()) return true;
    return advanceAfterEnd(reason);
  }

  function finishInflatedDuration() {
    if (V.backend !== "audio" || V.audio.paused || V.audio.seeking || !V.audio.src || !V.current() ||
        V.preparedStart || V.loadingInProgress || !V.wantsPlayback || V.platformBlocksAutoPlay() ||
        V.handledEndGeneration === V.playbackGeneration) return false;
    const dur = V.playbackDuration();
    // Allow one second for whole-second catalog durations. Never infer a finish from
    // a partial buffer, silence in the middle of a song, or an unknown/live duration.
    if (!(dur > 0 && dur < V.audio.duration && V.audio.currentTime >= dur + 1)) return false;
    V.log("audio", V.current().id + " ignoring inflated duration " + Math.round(V.audio.duration) + "s; upload is " + dur + "s");
    handleAudioEnd(V.audio, "track duration");
    return true;
  }

  async function recoverStalledAudio(reason) {
    if (V.nativeResumeCheck || V.stallRecovering || V.loadingInProgress || V.backend !== "audio" || !V.wantsPlayback ||
        V.platformPaused || V.audioSessionInterrupted || !V.current()) return;
    // Re-resolving against a network that is simply gone is a doomed round trip, and two
    // of them used to end in skipping the track the listener was on. Wait for the network
    // instead and pick the same track back up.
    if (!navigator.onLine) {
      V.log("network", "offline, holding " + V.current().id + " instead of re-resolving");
      V.pausedByNetwork = true;
      V.audio.pause();
      V.updatePlaybackState();
      return;
    }
    if (V.remotePlaybackActive()) {
      // Repeated source loads can take over the TV again after it has gone idle.
      // Keep this track for an explicit retry instead of cycling through the queue.
      V.log("remote", "TV stream is not progressing; holding the current track");
      holdRemotePlayback();
      return;
    }
    if (V.stallRecoveries >= 2) {
      V.log("audio", V.current().id + " remained stalled after 2 recoveries, skipping");
      V.stallRecoveries++;
      V.next(false);
      return;
    }
    // A stream that keeps stalling is too heavy for the connection right now. Drop this
    // track a tier rather than losing it - quieter fidelity beats a skip.
    if (!V.downgraded.has(V.current().id)) {
      V.downgraded.add(V.current().id);
      V.log("audio", V.current().id + " stalling, retrying at a lower quality");
    }
    V.stallRecovering = true;
    const recoverySessionGeneration = V.audioSessionGeneration;
    V.stallRecoveries++;
    const track = V.current();
    const resumeAt = Math.max(V.audio.currentTime || 0, V.lastAudioTime || 0);
    V.log("audio", track.id + " stalled at " + Math.round(resumeAt) + "s, recovering via " + reason);
    const failedKind = V.activeLocalKind;
    V.activeLocalKind = null;
    if (failedKind) {
      // A stall on a local copy is a decoder or audio-session hiccup, not a bad file:
      // the copy stays on the device, this recovery plays the stream, and the copy is
      // tried again on the next launch. Deleting it here threw saved songs away.
      V.rejectedLocalCache.add(track.id);
      V.log("cache", track.id + " local " + failedKind + " bypassed for this session after a stall");
    } else {
      Api.invalidate(track.id, false);
    }
    if (recoverySessionGeneration !== V.audioSessionGeneration || V.platformBlocksAutoPlay() ||
        !V.wantsPlayback || V.current() !== track) {
      V.stallRecovering = false;
      if (!V.platformBlocksAutoPlay() && V.wantsPlayback && V.current() === track) {
        scheduleStallCheck("deferred " + reason, 0);
      }
      return;
    }
    V.loadAndPlay(track, resumeAt).finally(() => { V.stallRecovering = false; });
  }

  function holdRemotePlayback() {
    V.pausePlay();
    V.remoteSource = false; // An explicit Play may resolve a fresh receiver source.
    V.emit({ type: "remote-error", message: "The TV could not play this stream. Reconnect the TV or press Play to retry." });
  }

  function scheduleStallCheck(reason, delay) {
    if (V.nativeResumeCheck || V.stallTimer || V.preparedStart || V.loadingInProgress || V.backend !== "audio" || !V.wantsPlayback ||
        V.platformPaused || V.audioSessionInterrupted || V.audio.ended || Date.now() < V.routeSettlingUntil) return;
    V.stallTimer = setTimeout(() => {
      V.stallTimer = null;
      if (V.backend !== "audio" || !V.wantsPlayback || V.preparedStart || V.loadingInProgress || V.platformPaused ||
          V.audioSessionInterrupted || !V.current()) return;
      if (V.audio.ended) { handleAudioEnd(V.audio, reason); return; }
      if (finishInflatedDuration()) return;
      const now = V.audio.currentTime || 0;
      if (Math.abs(now - V.lastAudioTime) >= 0.2) {
        V.lastAudioTime = now;
        V.lastAudioProgressAt = Date.now();
        return;
      }
      if (Date.now() - V.lastAudioProgressAt < 8000) {
        scheduleStallCheck(reason, 8000 - (Date.now() - V.lastAudioProgressAt));
        return;
      }
      const dur = V.playbackDuration();
      if (dur > 0 && dur < V.audio.duration && now >= dur - 1) {
        // Some decoders stop advancing at the last audio packet while the container
        // still promises minutes more. An exhausted endpoint should advance, not
        // download the same source again. Allow whole-second metadata rounding here.
        V.log("audio", V.current().id + " exhausted audio at " + now + "s of " + dur + "s");
        handleAudioEnd(V.audio, "track duration");
        return;
      }
      recoverStalledAudio(reason);
    }, delay == null ? 8000 : Math.max(0, delay));
  }
})();
