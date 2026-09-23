(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    finishTrackStart: { get: () => finishTrackStart },
    holdPlaybackPermission: { get: () => holdPlaybackPermission },
    isSpokenWord: { get: () => isSpokenWord },
    loadAndPlay: { get: () => loadAndPlay },
    mediaWasRejected: { get: () => mediaWasRejected },
    noteQueuePosition: { get: () => noteQueuePosition },
    playbackPermissionDenied: { get: () => playbackPermissionDenied },
    queuePositionKey: { get: () => queuePositionKey },
    savedResumePosition: { get: () => savedResumePosition },
    saveListeningPosition: { get: () => saveListeningPosition }
  });

  // A stored file is only bad if the element could not decode it. play() rejected because
  // the OS took the audio, or because autoplay policy blocked it, says nothing about the
  // file - deleting on that throws away a download the listener chose to keep. The log
  // showed exactly that: "audio session changed", then 29ms later "removed invalid local".
  function mediaWasRejected(error, el) {
    const name = String((error && error.name) || "");
    if (name === "NotAllowedError" || name === "AbortError" || name === "InvalidStateError") return false;
    const code = ((el || V.audio).error || {}).code;
    if (code === 3 || code === 4) return true;          // decode error, or source unsupported
    if (code === 1 || code === 2) return false;         // aborted, or network
    return name === "NotSupportedError";
  }

  // Podcasts, interviews and other talk are legitimate listening, they just are not songs:
  // no crossfade, no music radio after them, and the listener's place is worth keeping.
  // Talk has to be recognised as talk for that; a song the music test simply failed to
  // recognise is still a song, and must not be handed the episode treatment.
  function isSpokenWord(track) {
    if (!track) return false;
    if (track.kind === "podcast") return true;
    if (track.kind === "music") return false;
    // Reuse saved episode identity, including titles matched to a known show.
    // A publisher can also upload music, so its channel alone is not evidence.
    if (window.Store && Store.mediaKind && Store.mediaKind(track) === "podcast") return true;
    if (!window.Api || !Api.looksLikePodcast) return false;
    return Api.looksLikePodcast(track);
  }

  function resumable(track) {
    if (!track || !window.Store) return false;
    if (Store.settings && Store.settings().rememberPosition === false) return false;
    // Length alone does not make music an episode. A long song, mix or concert
    // starts fresh on each queue visit, even if an older version bookmarked it.
    return isSpokenWord(track);
  }

  // Where a resumable track picks up: its saved place, unless that is within the last
  // half minute, which means it was finished and should start over.
  function savedResumePosition(track) {
    if (!track || !resumable(track) || !Store.getPosition) return 0;
    const saved = Store.getPosition(track.id);
    return saved > 30 && (!track.duration || saved < track.duration - 30) ? saved : 0;
  }

  // Where the queue stands, for the Play after a reload. The store bookmarks only
  // spoken word; this lighter note covers songs, so an evicted page
  // does not restart a paused song from the top.
  // A separate AuraShare session keeps a note of its own. Sharing one used to overwrite
  // the personal song's place, and the queue restored at closing started from the top.
  function queuePositionKey() {
    return V.shareSession ? "aura.shareQueueAt" : "aura.queueAt";
  }

  function noteQueuePosition(track, at) {
    if (Store.privateSession && Store.privateSession()) return;
    try { localStorage.setItem(queuePositionKey(), JSON.stringify({ id: track.id, at: Math.floor(at || 0) })); } catch (e) {}
  }

  // The watchdog writes the position every five seconds while audio runs. A pause, a
  // seek or the app leaving the screen can be the last thing to happen before the page
  // is evicted, so each of them writes it too. Not while a load or a handoff on the
  // element is in flight: the clock then belongs to another song.
  function saveListeningPosition() {
    const t = V.current();
    if (!t || V.backend !== "audio" || !V.audio.src || V.loadingInProgress ||
        (V.preparedStart && V.preparedStart.el === V.audio)) return;
    const at = V.audio.currentTime || 0;
    if (resumable(t) && Store.savePosition) Store.savePosition(t.id, at);
    noteQueuePosition(t, at);
  }

  function playbackPermissionDenied(error) {
    return !!error && error.name === "NotAllowedError";
  }

  function holdPlaybackPermission(track, resumeAt, actualTrack) {
    // Keep the resolved source, including local blobs. Another URL cannot grant
    // permission, and the next Play must reach audio.play() during the user's tap.
    V.pendingPlaybackPermission = { track, actualTrack: actualTrack || track, src: V.audio.src, resumeAt };
    V.wantsPlayback = false;
    V.focusResumePending = false;
    V.focusResumeConfirmed = false;
    V.platformPaused = false;
    V.pausedByNetwork = false;
    V.stopSourceRetry();
    V.stopNetworkResumeWatch();
    V.clearStallCheck();
    V.clearEarlyPrefetch();
    V.cancelRadioExtension();
    V.failedQueueIds.delete(track.id);
    V.audio.pause();
    V.updateMediaSession(track);
    V.updatePlaybackState();
    V.log("play", track.id + " waiting for a Play tap (NotAllowedError); source and queue kept");
    V.emit({ type: "state" });
    V.emit({ type: "playback-permission", track });
  }

  function finishTrackStart(track, resumeAt) {
    if (resumeAt > 0 && V.backend === "audio") {
      try {
        const dur = V.playbackDuration();
        const max = dur > 1 ? dur - 1 : resumeAt;
        V.audio.currentTime = Math.max(0, Math.min(resumeAt, max));
        V.lastAudioTime = V.audio.currentTime;
        V.lastAudioProgressAt = Date.now();
      } catch (e) {}
    }
    V.failedQueueIds.delete(track.id);
    V.unreadableOffline.delete(track.id);
    V.loadSkipSegments(track);
    V.resetListenTracking(track);
    V.updateMediaSession(track);
    V.emit({ type: "track", track });
    V.emit({ type: "state" });
    V.prefetchNext();
    V.scheduleEarlyPrefetch();
  }

  async function loadAndPlay(track, resumeAt, continuityRetry) {
    // A position kept from a TV disconnect belongs to the song that was playing then.
    V.resumeAfterCastAt = 0;
    if (!track) return;
    V.interruptionCheckpoint = null;
    V.stopNativeResumeCheck();
    V.stopRouteRecovery();
    V.routeReattached = false;
    V.stopAudioFocusResumeRetry();
    V.shareExhausted = false;
    V.remoteSource = false;
    V.pendingPlaybackPermission = null;
    if (!continuityRetry) V.stopSourceRetry();
    // A queued focus-return callback belongs to the source that was active when it was
    // created. Starting another load must invalidate it before any asynchronous work.
    V.audioSessionGeneration++;
    // Keep the interruption intent itself: focus may return while the new URL is still
    // resolving, and that confirmed return must be allowed to start the replacement.
    V.focusResumePending = V.audioSessionInterrupted && V.platformPaused && V.wantsPlayback;
    // A focus return the reopening confirmed still holds for this load: dropping it
    // here held every song tapped under a stale platform pause until the Play button.
    V.focusResumeAttempting = false;
    // Keep an in-flight focus attempt identifiable until the new source is installed.
    // Asked before a saved episode position is filled in: that is a fresh start too, and
    // must not inherit the stall count of whatever played before it.
    const reloadAt = resumeAt > 0;
    if (!(resumeAt > 0)) {
      const saved = savedResumePosition(track);
      if (saved > 0) {
        resumeAt = saved;
        V.log("play", track.id + " resuming at " + Math.round(saved) + "s");
      }
    }
    noteQueuePosition(track, resumeAt);
    const token = ++V.loadingToken;
    const t0 = Date.now();
    V.loadingInProgress = true;
    V.audioRetryId = null;
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.clearStallCheck();
    V.cancelSleepFade();
    V.lastAudioTime = 0;
    V.lastAudioProgressAt = Date.now();
    if (!reloadAt && !V.stallRecovering) V.stallRecoveries = 0;
    V.cancelCrossfade();
    V.discardPrep();
    V.clearEarlyPrefetch();
    V.activeLocalKind = null;
    let started = false;
    V.emit({ type: "loading", track });
    try {
      const downloaded = V.remotePlaybackActive() || V.localCopyBypassed(track.id) ? null : await V.getDownload(track.id);
      const cached = downloaded || V.remotePlaybackActive() ? null : await V.getCached(track.id);
      const localBlob = downloaded || cached;
      if (token !== V.loadingToken) return;
      let played = false;
      if (localBlob) {
        V.activeGain = V.localGain(track.id);
        V.activeLocalKind = downloaded ? "download" : "cache";
        V.log("play", track.id + " from local " + V.activeLocalKind);
        if (V.blobUrl) URL.revokeObjectURL(V.blobUrl);
        V.blobUrl = URL.createObjectURL(localBlob);
        try {
          if (await V.playViaAudio(V.blobUrl) === false) throw Object.assign(new Error("Audio focus unavailable"), { focusBlocked: true });
          played = true;
        } catch (e) {
          if (token !== V.loadingToken) return;
          if (playbackPermissionDenied(e) || (e && e.focusBlocked)) throw e;
          const failedKind = V.activeLocalKind;
          V.activeLocalKind = null;
          if (!mediaWasRejected(e)) {
            V.log("cache", track.id + " local " + failedKind + " kept, playback was interrupted rather than unreadable");
          } else if (failedKind === "cache") {
            V.rejectedLocalCache.add(track.id);
            await V.deleteCached(track.id);
            V.log("cache", track.id + " removed unreadable local cache");
          } else {
            // Recovery is already the fallback path - a delete that fails here must not
            // take the retry down with it.
            try {
              await V.deleteDownload(track.id);
              V.log("cache", track.id + " removed unreadable download");
            } catch (err) {
              V.log("cache", track.id + " could not remove unreadable download: " + String((err && err.message) || err).slice(0, 60));
            }
          }
          if (V.blobUrl) URL.revokeObjectURL(V.blobUrl);
          V.blobUrl = null;
        }
      }
      if (token !== V.loadingToken) return;
      if (!played && navigator.onLine === false && !V.remotePlaybackActive()) {
        // Nothing to ask without a signal, and no search for another upload or trip to
        // YouTube will find one. A saved song further on is the only thing that can play,
        // so go to it rather than sit on this one with saved music behind it; with none,
        // hold here for the signal.
        const saved = await V.localIds().catch(() => new Set());
        if (token !== V.loadingToken) return;
        if (saved.has(track.id)) V.unreadableOffline.add(track.id);
        const ni = V.pickNextIndex(t => saved.has(t.id) && !V.unreadableOffline.has(t.id));
        V.failedQueueIds.delete(track.id);
        if (ni !== -1) {
          V.log("play", track.id + " is not on this device and there is no signal, going on to the next saved song");
          V.emit({ type: "offline-skip", track });
          V.pos = ni;
          V.persist();
          loadAndPlay(V.current());
          return;
        }
        V.log("play", track.id + " held, it is not on this device and there is no signal");
        V.stopAudio(true);
        V.emit({ type: "state" });
        V.emit({ type: "offline-unavailable", track });
        V.scheduleSourceRetry(track, resumeAt, "network loss");
        return;
      }
      if (!played) {
        V.activeLocalKind = null;
        const triedSources = new Set();
        const triedBases = new Set();
        let outage = false;
        for (let attempt = 0; attempt < 4 && !played; attempt++) {
          let info;
          try { info = await Api.resolve(track.id, { ...V.streamOptions(track.id), avoid: triedBases }); }
          catch (e) {
            // Excluding sources that already returned bad media can exhaust the list;
            // that is this song's failure, not evidence of a server-wide outage.
            if (e && e.outage && !triedSources.size) outage = true;
            V.log("play", track.id + " no source: " + String(e.message || e).slice(0, 50));
            break;
          }
          if (token !== V.loadingToken) return;
          // Some providers omit their base; still bound retries by the actual URL.
          if (triedSources.has(info.url)) { Api.invalidate(track.id, false); break; }
          triedSources.add(info.url);
          try {
            V.activeLocalKind = null;
            V.activeGain = V.gainFor(V.noteStreamLoudness(track.id, info.loudnessDb));
            if (await V.playViaAudio(info.url, info) === false) throw Object.assign(new Error("Audio focus unavailable"), { focusBlocked: true });
            if (token !== V.loadingToken) return;
            if (V.blobUrl) {
              URL.revokeObjectURL(V.blobUrl);
              V.blobUrl = null;
            }
            V.log("play", track.id + " from direct stream via " + (info.base || "").replace(/^https?:\/\//, ""));
            played = true;
          } catch (e) {
            if (token !== V.loadingToken) return;
            if (playbackPermissionDenied(e) || (e && e.focusBlocked)) throw e;
            V.log("play", track.id + " source failed (" + (info.base || "").replace(/^https?:\/\//, "") + "): " + String(e.message || e).slice(0, 50));
            if (info.base) triedBases.add(info.base);
            Api.invalidate(track.id, false);
          }
        }
        if (!played && outage) {
          // Not this track's fault, and the next one would fail in the same few milliseconds.
          // Stop here with the queue intact rather than burning through it.
          if (token !== V.loadingToken) return;
          V.log("play", track.id + " held, every stream server is down or cooling off");
          V.failedQueueIds.delete(track.id);
          V.stopAudio(true);
          V.emit({ type: "state" });
          V.emit({ type: "source-outage", track });
          V.scheduleSourceRetry(track, resumeAt, "stream outage");
          return;
        }
        if (!played) {
          if (token !== V.loadingToken) return;
          // Every source refused this video - region-blocked, taken down, or simply broken.
          // An identical upload is usually one search away, and playing that keeps clean
          // audio instead of dropping to the iframe with its ads and no background play.
          const alternate = await V.tryAlternateUpload(track, token);
          if (token !== V.loadingToken) return;
          if (alternate) {
            track = alternate;
            played = true;
          }
        }
        if (!played) {
          if (token !== V.loadingToken) return;
          if (V.platformBlocksAutoPlay()) {
            V.log("play", track.id + " fallback held until audio focus returns");
            V.stopAudio(true);
            V.emit({ type: "state" });
            V.scheduleSourceRetry(track, resumeAt, "audio interruption");
            return;
          }
          if (V.remotePlaybackActive()) {
            V.stopAudio(true);
            V.emit({ type: "state" });
            V.emit({ type: "remote-error", message: "This track has no stream available for the TV. Retry playback or choose another track." });
            V.scheduleSourceRetry(track, resumeAt, "TV stream unavailable");
            return;
          }
          if (Store.settings().noYtFallback) {
            V.log("play", track.id + " skipped (noYtFallback on)");
            V.failedQueueIds.add(track.id);
            V.stopAudio(true);
            V.emit({ type: "state" });
            V.reportPlaybackFailure({ type: "fallback-skip", track });
            V.scheduleSourceRetry(track, resumeAt, "unavailable source");
            return;
          }
          V.log("play", track.id + " falling back to YouTube iframe (ads)");
          V.emit({ type: "fallback-yt", track });
          await V.playViaYt(track, token);
        }
      }
      if (token !== V.loadingToken) return;
      V.log("play", track.id + " playing after " + (Date.now() - t0) + "ms");
      finishTrackStart(track, resumeAt);
      started = true;
    } catch (e) {
      if (token !== V.loadingToken) return;
      if (playbackPermissionDenied(e)) {
        holdPlaybackPermission(track, resumeAt, e.playbackTrack);
        return;
      }
      const focusBlocked = !!(e && e.focusBlocked);
      if (focusBlocked) V.log("play", track.id + " held while audio focus is unavailable");
      else V.failedQueueIds.add(track.id);
      V.stopAudio(true);
      // The lock screen still names the song that was playing; the held one is current.
      if (focusBlocked && V.current() && V.current().id === track.id) V.updateMediaSession(track);
      V.emit({ type: "state" });
      if (!focusBlocked) V.reportPlaybackFailure({ type: "error", track, error: e });
      V.scheduleSourceRetry(track, resumeAt, focusBlocked ? "audio interruption" : "playback failure");
    } finally {
      if (token === V.loadingToken) {
        V.loadingInProgress = false;
        // A connected event during the initial load could not arm recovery yet.
        if (started) V.scheduleRouteRecovery();
      }
    }
  }
})();
