(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    blobUrl: { get: () => blobUrl, set: value => { blobUrl = value; } },
    downgraded: { get: () => downgraded },
    loadSkipSegments: { get: () => loadSkipSegments },
    playViaAudio: { get: () => playViaAudio },
    playViaYt: { get: () => playViaYt },
    qualityFor: { get: () => qualityFor },
    skipSegmentIfInside: { get: () => skipSegmentIfInside },
    swappedFor: { get: () => swappedFor },
    tryAlternateUpload: { get: () => tryAlternateUpload }
  });

  let blobUrl = null;

  function waitForAudioStart(timeoutMs) {
    const target = V.audio;
    let cancel;
    /** @type {Promise<void> & { cancel?: () => void }} */
    const promise = new Promise((res, rej) => {
      let done = false;
      const cleanup = () => {
        target.removeEventListener("playing", onPlaying);
        target.removeEventListener("timeupdate", onTime);
        target.removeEventListener("error", onError);
        clearTimeout(timer);
      };
      const finish = fn => {
        if (done) return;
        done = true;
        cleanup();
        fn();
      };
      const onPlaying = () => finish(res);
      cancel = () => finish(res);
      const onTime = () => {
        if (target.currentTime > 0) finish(res);
      };
      const onError = () => finish(() => rej(new Error("audio element error")));
      const timer = setTimeout(() => finish(() => rej(new Error("audio start timeout"))), timeoutMs);
      target.addEventListener("playing", onPlaying);
      target.addEventListener("timeupdate", onTime);
      target.addEventListener("error", onError);
      if (!target.paused && (target.currentTime > 0 || target.readyState >= 3)) {
        setTimeout(() => finish(res), 0);
      }
    });
    promise.cancel = cancel;
    return promise;
  }

  async function playViaAudio(src, info, track) {
    V.stopYt();
    V.audioSessionGeneration++;
    V.backend = "audio";
    V.wantsPlayback = true;
    V.configureAudioSession();
    // Created and resumed inside the listener's tap when there is one, so the
    // context inherits the same playback permission as the element.
    V.ensureSessionKick();
    V.syncSessionKick();
    const session = V.audio.isCast ? null : navigator.audioSession;
    const sessionInterrupted = V.audioSessionInterrupted || !!(session && session.state === "interrupted");
    const confirmedFocusReturn = V.focusResumeConfirmed &&
      (V.sessionStateUnknowable() || (!!session && session.state === "active"));
    const focusBlocked = sessionInterrupted || !!V.mediaSessionPauseDecisionTimer ||
      !!(V.platformPaused && !confirmedFocusReturn);
    V.platformPaused = focusBlocked;
    // A generic platform pause needs native resume or an explicit Play gesture;
    // opening the app cannot confirm that a phone call has ended.
    V.audioSessionInterrupted = sessionInterrupted;
    V.focusResumePending = focusBlocked;
    V.focusResumeConfirmed = false;
    V.focusResumeAttempting = false;
    V.focusResumeAttemptGeneration = -1;
    V.pausedByNetwork = false;
    V.remoteSource = V.remotePlaybackActive() && /^https?:\/\//i.test(src);
    if (V.audio.isCast) { V.audio.mediaTrack = track || V.current(); V.audio.mediaMime = (info && info.mime) || "audio/mpeg"; }
    V.rememberStreamDuration(track || V.current(), info);
    // Assign ownership before src: Safari can announce a remembered AirPlay
    // route as soon as this source is attached, while its first play is pending.
    V.attachedAudioSourceToken = V.loadingToken;
    V.setPlaybackSource(V.audio, src);
    V.audio.volume = V.levelled();
    V.applyRate(V.audio);
    if (focusBlocked) {
      V.log("background", "source ready; waiting for audio focus before playback");
      V.updatePlaybackState();
      return false;
    }
    const started = waitForAudioStart(9000);
    try { await Promise.all([Promise.resolve(V.audio.play()), started]); }
    catch (e) {
      // pause() rejects a pending play() with AbortError. That pause was ours (a
      // lock-screen pause whose decision window is still open, an explicit pause not
      // yet through this load) or the platform's; either way the stream did not fail,
      // so hold rather than retry, swap or skip the source.
      if (e && e.name === "AbortError" && !V.audio.ended) throw focusUnavailableError();
      throw e;
    }
    finally { started.cancel(); }
    V.updatePlaybackState();
    return true;
  }

  function focusUnavailableError() {
    const error = /** @type {Error & { focusBlocked?: boolean }} */ (new Error("audio focus unavailable"));
    error.focusBlocked = true;
    return error;
  }

  async function playViaYt(track, expectedToken) {
    if (V.platformBlocksAutoPlay()) throw focusUnavailableError();
    const p = await V.ensureYT();
    if (expectedToken != null && expectedToken !== V.loadingToken) {
      const error = /** @type {Error & { cancelled?: boolean }} */ (new Error("playback request cancelled"));
      error.cancelled = true;
      throw error;
    }
    if (V.platformBlocksAutoPlay()) throw focusUnavailableError();
    // Keep the current backend and its interruption state intact while the iframe loads.
    // Once it is ready and the request is still current, the swap is synchronous.
    V.stopAudio();
    V.backend = "yt";
    V.wantsPlayback = true;
    p.loadVideoById(track.id);
    p.setVolume(Math.round(V.volume * 100));
    try { p.setPlaybackRate(V.rate()); } catch (e) {}
    V.startYtClock();
    V.updatePlaybackState();
  }

  // Tracks already auto-swapped once, so a bad run cannot turn into a loop of swaps.
  const swappedFor = new Set();
  // Tracks that stalled enough to earn a lower stream tier for the rest of the session.
  const downgraded = new Set();

  // Where the parts that are not the song sit in the current upload: channel intros,
  // sponsor reads, outros over the fade.
  let activeSegments = [];
  let segmentsFor = null;

  function loadSkipSegments(track) {
    activeSegments = [];
    skippedSegments.clear();
    segmentsFor = track ? track.id : null;
    if (!track || !Api.getSkipSegments || !Store.settings().skipSegments) return;
    const id = track.id;
    Api.getSkipSegments(id).then(list => {
      if (segmentsFor !== id) return;
      activeSegments = list;
      if (list.length) V.log("skip", id + " has " + list.length + " segment(s) to skip");
    }).catch(() => {});
  }

  // A skip is a seek, and a seek into a part of the stream that has not arrived yet can
  // simply not take - the element drops back to what it has buffered. The old code saw
  // itself inside the segment again and skipped again, and again: one log showed the same
  // 87s jump three times in twenty seconds, each one throwing away the buffer and forcing
  // another range request. That is what turned a slow stream into a stall storm.
  // Each segment is skipped at most once per load. If the seek did not take, the segment
  // plays through, which is a far smaller price than churning the connection.
  const skippedSegments = new Set();

  function skipSegmentIfInside() {
    if (V.loadingInProgress || !V.current() || segmentsFor !== V.current().id) return;
    if (!activeSegments.length || V.backend !== "audio") return;
    const at = V.audio.currentTime || 0;
    for (const seg of activeSegments) {
      // The half second of headroom keeps a skip from landing back inside its own segment.
      if (at >= seg.start && at < seg.end - 0.5) {
        const key = V.playbackGeneration + ":" + seg.start;
        if (skippedSegments.has(key)) return;
        skippedSegments.add(key);
        V.log("skip", "skipped " + seg.category + " to " + Math.round(seg.end) + "s");
        V.audio.currentTime = seg.end;
        V.listenClock = V.audio.currentTime || 0;
        return;
      }
    }
  }

  function qualityFor(id) {
    if (downgraded.has(id)) return "data";
    const setting = Store.settings().audioQuality;
    return setting === "data" || setting === "normal" ? setting : "best";
  }

  async function tryAlternateUpload(track, token) {
    if (swappedFor.has(track.id) || !Api.findVersions) return null;
    swappedFor.add(track.id);
    let versions = [];
    try { versions = await Api.findVersions(track); } catch (e) { return null; }
    if (token !== V.loadingToken) return null;
    for (const candidate of versions.slice(0, 3)) {
      const alt = track.kind === "podcast" ? Object.assign({}, candidate, {
        kind: "podcast", podcast: track.podcast || ""
      }) : candidate;
      if (V.failedQueueIds.has(alt.id)) continue;
      let info;
      try { info = await Api.resolve(alt.id, V.streamOptions(alt.id)); } catch (e) { continue; }
      if (token !== V.loadingToken) return null;
      try {
        V.activeGain = V.gainFor(V.noteStreamLoudness(alt.id, info.loudnessDb));
        if (await playViaAudio(info.url, info, alt) === false) throw Object.assign(new Error("Audio focus unavailable"), { focusBlocked: true });
      } catch (e) {
        if (V.playbackPermissionDenied(e)) { e.playbackTrack = alt; throw e; }
        if (e && e.focusBlocked) throw e;
        continue;
      }
      if (token !== V.loadingToken) return null;
      V.log("play", track.id + " unplayable, switched to upload " + alt.id);
      // Keep the swap, so the rest of the session uses the upload that works.
      if (V.pos >= 0 && V.queue[V.pos] && V.queue[V.pos].id === track.id) {
        V.swapQueueEntry(V.pos, alt);
        V.persist();
      }
      return alt;
    }
    return null;
  }
})();
