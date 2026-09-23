(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    cancelCrossfade: { get: () => cancelCrossfade },
    cancelPreparedStart: { get: () => cancelPreparedStart },
    clearEarlyPrefetch: { get: () => clearEarlyPrefetch },
    commitInterruptedPreparedStart: { get: () => commitInterruptedPreparedStart },
    commitPendingPreparedStart: { get: () => commitPendingPreparedStart },
    commitPreparedOnActive: { get: () => commitPreparedOnActive },
    commitTo: { get: () => commitTo },
    crossfadeSecs: { get: () => crossfadeSecs },
    discardPrep: { get: () => discardPrep },
    keepPreparedSource: { get: () => keepPreparedSource },
    maybeCrossfade: { get: () => maybeCrossfade },
    playPreparedInstantly: { get: () => playPreparedInstantly },
    preparedStart: { get: () => preparedStart },
    prepNextSource: { get: () => prepNextSource },
    prepValid: { get: () => prepValid },
    repairPreparedSource: { get: () => repairPreparedSource },
    scheduleEarlyPrefetch: { get: () => scheduleEarlyPrefetch },
    xfade: { get: () => xfade },
    xfadePrep: { get: () => xfadePrep }
  });

  function crossfadeSecs() {
    // Crossfading speech talks over the end of a sentence. Only songs get it.
    // iOS needs the permitted element for each song; overlapping a second
    // element can fail and discard the source prepared for the next transition.
    if (V.isIOS || V.remotePlaybackActive() || V.isSpokenWord(V.current())) return 0;
    const s = Store.settings();
    const v = s.crossfade != null ? parseInt(String(s.crossfade), 10) : 4;
    return isNaN(v) ? 0 : Math.min(12, Math.max(0, v));
  }

  let xfade = null;
  let xfadePrep = null;
  let prepBusy = false;
  let prepRevision = 0;
  let preparedStart = null;

  // Retry an unsuccessful initial preparation while there is still time left to fetch.
  const EARLY_PREFETCH_MS = 10000;
  let earlyPrefetchTimer = null;

  function clearEarlyPrefetch() {
    if (earlyPrefetchTimer) { clearTimeout(earlyPrefetchTimer); earlyPrefetchTimer = null; }
  }

  function scheduleEarlyPrefetch() {
    clearEarlyPrefetch();
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    earlyPrefetchTimer = setTimeout(() => {
      earlyPrefetchTimer = null;
      if (generation !== V.playbackGeneration || startPos !== V.pos) return;
      if (xfadePrep || xfade || prepBusy || V.nearEnd()) return;
      prepNextSource();
    }, EARLY_PREFETCH_MS);
  }

  function discardPrep() {
    if (V.audio.isCast) CastPlayback.setNext(null);
    prepRevision++;
    prepBusy = false;
    cancelPreparedStart();
    if (xfadePrep && xfadePrep.el && xfadePrep.el !== V.audio) {
      xfadePrep.el.pause();
      xfadePrep.el.removeAttribute("src");
      try { xfadePrep.el.load(); } catch (e) {}
    }
    if (xfadePrep && xfadePrep.blobUrl) URL.revokeObjectURL(xfadePrep.blobUrl);
    xfadePrep = null;
  }

  function cancelPreparedStart() {
    if (!preparedStart) return;
    const pending = preparedStart;
    preparedStart = null;
    clearTimeout(pending.timer);
    if (pending.el) {
      pending.el.pause();
      pending.el.removeAttribute("src");
      try { pending.el.load(); } catch (e) {}
    }
    if (pending.prep && pending.prep.blobUrl) URL.revokeObjectURL(pending.prep.blobUrl);
  }

  function commitInterruptedPreparedStart(reason) {
    const pending = preparedStart;
    if (!pending || pending.el !== V.audio || !pending.prep) return false;
    preparedStart = null;
    clearTimeout(pending.timer);
    V.log("background", pending.prep.id + " prepared transition held during " + reason);
    // The active element already owns the prepared source. Commit its queue metadata now
    // so a later focus return cannot play the next song under the previous song's title.
    commitPreparedOnActive(pending.prep);
    return true;
  }

  // A handoff already running on an element is the current song from here on: the one
  // before it has finished. A pause, a queue edit or a further Next that lands during it
  // commits it rather than cancelling it; cancelling stripped the element and left the
  // queue on the finished song, so Play reloaded that one from the start, or nothing
  // played at all.
  function commitPendingPreparedStart(reason) {
    const pending = preparedStart;
    if (!pending || !pending.prep || !pending.el) return false;
    if (pending.el === V.audio) return commitInterruptedPreparedStart(reason);
    preparedStart = null;
    clearTimeout(pending.timer);
    const prep = pending.prep;
    commitTo(pending.el, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
    return true;
  }

  function cancelCrossfade() {
    if (!xfade) return;
    clearInterval(xfade.timer);
    const standby = xfade.el;
    standby.pause();
    standby.removeAttribute("src");
    try { standby.load(); } catch (e) {}
    if (xfade.blobUrl) URL.revokeObjectURL(xfade.blobUrl);
    V.audio.volume = V.levelled();
    xfade = null;
  }

  function keepPreparedSource(prep) {
    V.rememberStreamDuration(V.queue[prep.ni], prep);
    if (V.audio.isCast) {
      xfadePrep = prep;
      if (!V.sleepAfterTrack) {
        CastPlayback.setNext(V.queue[prep.ni], prep.src, prep.mime).then(() => prepareCastTail(prep));
      }
      return;
    }
    if (V.remotePlaybackActive()) {
      // Keep the URL ready without loading a second element off the wireless route.
      xfadePrep = prep;
      return;
    }
    if (V.isIOS) {
      // The permitted element restarts the prepared source itself at the transition,
      // so a standby element's buffer never reaches the listener here; loading one
      // would fetch every next song twice. Hold the source ready without an element.
      xfadePrep = prep;
      V.log("background", prep.id + " holding " + (prep.localKind || "stream") + " for the permitted element");
      return;
    }
    const standby = V.otherEl();
    standby.pause();
    prep.el = standby;
    xfadePrep = prep;
    standby.preload = "auto";
    standby.src = prep.src;
    standby.volume = V.volume;
    try { standby.load(); } catch (e) {}
    V.log("background", prep.id + " preparing " + (prep.localKind || "stream") + " for continuous playback");
  }

  async function prepareCastTail(prep) {
    // Give the TV a buffer of queued songs and artwork so screen locking does not
    // require a running page for every transition. Limit concurrent URL lookups.
    const upcoming = V.radioUpcoming();
    if (!upcoming.length || upcoming[0].id !== prep.id) return;
    const tail = upcoming.slice(1, 12);
    const valid = () => V.audio.isCast && xfadePrep === prep && !V.sleepAfterTrack;
    for (let offset = 0; offset < tail.length && valid(); offset += 3) {
      const results = await Promise.allSettled(tail.slice(offset, offset + 3).map(async track =>
        ({ track, info: await Api.resolve(track.id, V.streamOptions(track.id)) })));
      if (!valid()) return;
      const entries = [];
      for (const result of results) {
        if (result.status !== "fulfilled") break;
        entries.push(result.value);
      }
      await CastPlayback.appendUpcoming(entries);
      // Preserve queue order if a source is unavailable. The normal player can
      // retry it when it reaches that item instead of silently dropping it here.
      if (entries.length !== results.length) return;
    }
  }

  async function repairPreparedSource(prep, error) {
    if (xfadePrep !== prep || prep.repairing) return;
    const rejected = V.mediaWasRejected(error, prep.el);
    const failedKind = prep.localKind;
    const revision = prepRevision;
    prep.repairing = true;
    prep.src = "";
    prep.el.removeAttribute("src");
    try { prep.el.load(); } catch (e) {}
    if (prep.blobUrl) URL.revokeObjectURL(prep.blobUrl);
    prep.blobUrl = null;
    V.log("background", prep.id + " preparation failed; replacing source before the next track");
    try {
      if (failedKind && rejected) {
        if (failedKind === "cache") {
          V.rejectedLocalCache.add(prep.id);
          await V.deleteCached(prep.id);
        } else {
          await V.deleteDownload(prep.id);
        }
      }
      if (xfadePrep !== prep || revision !== prepRevision) return;
      // One repair per preparation. A network failure is not proof that a saved
      // download is corrupt, but a fresh stream can still make the next transition.
      if (prep.repaired) { discardPrep(); return; }
      if (!failedKind) Api.invalidate(prep.id, false);
      const info = await Api.resolve(prep.id, V.streamOptions(prep.id));
      if (xfadePrep !== prep || revision !== prepRevision || !prepValid()) return;
      keepPreparedSource({ ni: prep.ni, id: prep.id, src: info.url, mime: info.mime, blobUrl: null,
        duration: info.duration, localKind: null, gain: V.gainFor(V.noteStreamLoudness(prep.id, info.loudnessDb)), repaired: true });
    } catch (e) {
      if (xfadePrep === prep && revision === prepRevision) discardPrep();
    }
  }

  // Every timeupdate in the last stretch of a song asks for the next source again; a
  // lookup that just failed waits this long before it is asked again.
  const PREP_RETRY_MS = 5000;
  let prepFailure = null;

  async function prepNextSource(targetIndex) {
    if (!V.wantsPlayback || prepBusy || preparedStart || xfadePrep || xfade || V.repeat === "one" || V.backend !== "audio") return;
    const ni = Number.isInteger(targetIndex) ? targetIndex : V.pickNextIndex();
    if (ni === -1 || !V.queue[ni]) return;
    const t = V.queue[ni];
    if (prepFailure && prepFailure.id === t.id && Date.now() - prepFailure.at < PREP_RETRY_MS) return;
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    const revision = prepRevision;
    prepBusy = true;
    try {
      const downloaded = V.remotePlaybackActive() || V.localCopyBypassed(t.id) ? null : await V.getDownload(t.id);
      const cached = downloaded || V.remotePlaybackActive() ? null : await V.getCached(t.id);
      if (generation !== V.playbackGeneration || startPos !== V.pos || revision !== prepRevision) return;
      const localBlob = downloaded || cached;
      if (localBlob) {
        const u = URL.createObjectURL(localBlob);
        keepPreparedSource({ ni, id: t.id, src: u, blobUrl: u, localKind: downloaded ? "download" : "cache", gain: V.localGain(t.id) });
      } else {
        const info = await Api.resolve(t.id, V.streamOptions(t.id));
        if (generation !== V.playbackGeneration || startPos !== V.pos || revision !== prepRevision) return;
        const prep = { ni, id: t.id, src: info.url, mime: info.mime, duration: info.duration,
          blobUrl: null, localKind: null, gain: V.gainFor(V.noteStreamLoudness(t.id, info.loudnessDb)) };
        // Hold the resolved source before deciding how to keep it, so a track that
        // ends early can still hand off to the direct stream.
        V.rememberStreamDuration(t, prep);
        xfadePrep = prep;
        cachePreparedSource(prep);
      }
    } catch (e) {
      prepFailure = { id: t.id, at: Date.now() };
      V.log("play", t.id + " could not be prepared: " + String((e && e.message) || e).slice(0, 60));
    } finally {
      if (revision === prepRevision) prepBusy = false;
    }
  }

  function prepValid() {
    return !!(xfadePrep && V.queue[xfadePrep.ni] && V.queue[xfadePrep.ni].id === xfadePrep.id && xfadePrep.ni !== V.pos &&
      !Store.isBlocked(V.queue[xfadePrep.ni]) && !V.failedQueueIds.has(xfadePrep.id));
  }

  // A standby element streaming the next song leaves the transition waiting on the
  // network wherever the permitted element restarts the source itself: always on iOS,
  // and on every engine while the screen is off. Saving the next track into the local
  // cache while this one plays turns that handoff into a read from the device, and the
  // element attach waits for the copy to settle so the same bytes are never fetched
  // twice. Whatever prevents the copy - a metered connection with Wi-Fi-only downloads,
  // being offline, an oversize track, storage trouble - falls back to the direct
  // stream, which is exactly what was kept before.
  async function cachePreparedSource(prep) {
    const revision = prepRevision;
    const settled = () => revision === prepRevision && xfadePrep === prep && !preparedStart && prepValid();
    if (V.audio.isCast || V.remotePlaybackActive() || navigator.onLine === false ||
        V.downloadsBlockedByWifi() || V.rejectedLocalCache.has(prep.id)) {
      if (settled()) keepPreparedSource(prep);
      return;
    }
    try {
      if (await V.cacheTrack(prep.id)) {
        const downloaded = await V.getDownload(prep.id);
        const blob = downloaded || await V.getCached(prep.id);
        if (!settled()) return;
        if (blob) {
          const u = URL.createObjectURL(blob);
          keepPreparedSource({ ni: prep.ni, id: prep.id, src: u, blobUrl: u, mime: prep.mime,
            duration: prep.duration, localKind: downloaded ? "download" : "cache", gain: prep.gain });
          return;
        }
      }
    } catch (e) {}
    if (settled()) keepPreparedSource(prep);
  }

  function commitTo(standby, ni, newBlobUrl, localKind, xfadeGain) {
    V.routeReattached = false;
    const old = V.audio;
    V.audio = standby;
    V.remoteSource = false;
    V.configureRemoteElements();
    V.audio.volume = V.volume;
    old.pause();
    old.removeAttribute("src");
    try { old.load(); } catch (e) {}
    old.volume = V.volume;
    if (V.blobUrl && V.blobUrl !== newBlobUrl) URL.revokeObjectURL(V.blobUrl);
    V.blobUrl = newBlobUrl || null;
    V.activeLocalKind = localKind || null;
    V.activeGain = xfadeGain == null ? 1 : xfadeGain;
    V.audio.volume = V.levelled();
    V.history.push(V.pos);
    V.pos = ni;
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.stallRecoveries = 0;
    V.clearStallCheck();
    V.lastAudioTime = V.audio.currentTime || 0;
    V.lastAudioProgressAt = Date.now();
    xfade = null;
    xfadePrep = null;
    V.persist();
    const t = V.current();
    if (t) {
      V.failedQueueIds.delete(t.id);
      V.loadSkipSegments(t);
      V.resetListenTracking(t);
      V.updateMediaSession(t);
      V.emit({ type: "track", track: t });
      V.emit({ type: "state" });
      V.prefetchNext();
      scheduleEarlyPrefetch();
    }
  }

  function commitPreparedOnActive(prep) {
    V.routeReattached = false;
    V.remoteSource = V.remotePlaybackActive() && /^https?:\/\//i.test(prep.src);
    const standby = prep.el;
    if (standby && standby !== V.audio) {
      standby.pause();
      standby.removeAttribute("src");
      try { standby.load(); } catch (e) {}
    }
    if (V.blobUrl && V.blobUrl !== prep.blobUrl) URL.revokeObjectURL(V.blobUrl);
    V.blobUrl = prep.blobUrl || null;
    V.activeLocalKind = prep.localKind || null;
    V.activeGain = prep.gain == null ? 1 : prep.gain;
    V.audio.volume = V.levelled();
    V.history.push(V.pos);
    V.pos = prep.ni;
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.stallRecoveries = 0;
    V.clearStallCheck();
    V.lastAudioTime = 0;
    V.lastAudioProgressAt = Date.now();
    xfadePrep = null;
    V.persist();
    const t = V.current();
    if (t) {
      V.failedQueueIds.delete(t.id);
      V.loadSkipSegments(t);
      V.resetListenTracking(t);
      V.updateMediaSession(t);
      V.emit({ type: "track", track: t });
      V.emit({ type: "state" });
      V.prefetchNext();
      scheduleEarlyPrefetch();
    }
  }

  function startCrossfade(fade) {
    if (V.isIOS || V.remotePlaybackActive()) return;
    if (xfadePrep && xfadePrep.repairing) return;
    if (V.audio.paused || V.platformBlocksAutoPlay() || !prepValid()) {
      if (!prepValid()) discardPrep();
      return;
    }
    // A track with a place to pick up from is not faded in from its start; the handoff
    // at the end resumes it.
    if (V.savedResumePosition(V.queue[xfadePrep.ni]) > 0) return;
    const prep = xfadePrep;
    const standby = prep.el || V.otherEl();
    if (!standby.src) standby.src = prep.src;
    standby.volume = 0;
    const durMs = fade * 1000;
    xfade = {
      el: standby, ni: prep.ni, blobUrl: prep.blobUrl, localKind: prep.localKind, gain: prep.gain,
      timer: null, started: false
    };
    xfadePrep = null;
    const begin = () => {
      if (!xfade || xfade.el !== standby || standby.paused || V.audio.paused || V.platformBlocksAutoPlay()) {
        if (xfade && xfade.el === standby) cancelCrossfade();
        return;
      }
      xfade.started = true;
      const startAt = Date.now();
      V.log("xfade", "crossfading " + fade + "s into " + prep.id);
      xfade.timer = setInterval(() => {
        if (!xfade) return;
        if (standby.paused || V.audio.paused || V.platformBlocksAutoPlay()) { cancelCrossfade(); return; }
        const p = Math.min(1, (Date.now() - startAt) / durMs);
        standby.volume = Math.max(0, Math.min(1, V.volume * (prep.gain == null ? 1 : prep.gain) * p));
        V.audio.volume = V.levelled(1 - p);
        if (p >= 1) {
          clearInterval(xfade.timer);
          commitTo(standby, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
        }
      }, 60);
    };
    try {
      const play = standby.play();
      if (play && play.then) {
        play.then(begin).catch(() => {
          if (xfade && xfade.el === standby) cancelCrossfade();
        });
      } else {
        begin();
      }
    } catch (e) {
      cancelCrossfade();
    }
  }

  function maybeCrossfade() {
    if (V.backend !== "audio" || !V.wantsPlayback || V.audio.paused || V.platformBlocksAutoPlay() ||
        preparedStart || V.loadingInProgress || xfade || V.repeat === "one") return;
    if (V.sleepAfterTrack) return;
    const dur = V.playbackDuration();
    if (!Number.isFinite(dur) || !dur) return;
    // In seconds of actual waiting, not seconds of the track: at 1.5x there is a third less
    // time left than the timeline says, and the fade ramp below runs on Date.now(). Left
    // unscaled, a crossfade started at the right place in the song was still ramping when
    // the track ended.
    const remaining = (dur - V.audio.currentTime) / (V.audio.playbackRate || 1);
    const fade = crossfadeSecs();
    // End transitions still require the same amount of actual listening.
    if (remaining <= Math.max(fade, 2)) V.countListen("reached the end");
    // Held ready in the background too - the screen being off is when continuous playback
    // matters most, and nothing else prepares it there.
    if (remaining <= Math.max(fade + 6, 12) && !xfadePrep && !prepBusy) prepNextSource();
    if (document.hidden) {
      if (!V.remotePlaybackActive() && remaining <= 0.75 && prepValid()) playPreparedInstantly();
      return;
    }
    if (fade > 0 && remaining <= fade && prepValid()) startCrossfade(Math.min(fade, Math.max(1, remaining)));
  }

  function playPreparedInstantly(manualNext) {
    if (preparedStart) return true;
    if (!V.wantsPlayback || V.platformBlocksAutoPlay()) return false;
    if (!prepValid()) { discardPrep(); return false; }
    if (xfadePrep.repairing || (V.remotePlaybackActive() && !/^https?:\/\//i.test(xfadePrep.src))) { discardPrep(); return false; }
    // A stream lined up before the signal went has a few buffered seconds to give at
    // best. Started offline it stalled there, with saved songs waiting behind it.
    if (navigator.onLine === false && !xfadePrep.localKind && !V.remotePlaybackActive()) { discardPrep(); return false; }
    const prep = xfadePrep;
    const onActive = V.isIOS || document.hidden || V.remotePlaybackActive();
    const target = onActive ? V.audio : (prep.el || V.otherEl());
    if (target.isCast) { target.mediaTrack = V.queue[prep.ni]; target.mediaMime = prep.mime || "audio/mpeg"; }
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    xfadePrep = null;
    // At the track's own level from the first sample: the loudness gain used to arrive
    // only with the confirmed handoff, so a loud upload blared for its first moments.
    target.volume = Math.max(0, Math.min(1, V.volume * (prep.gain == null ? 1 : prep.gain)));
    const attempt = { el: target, prep, timer: null, deadline: Date.now() + 9000 };
    preparedStart = attempt;
    const valid = () => preparedStart === attempt && generation === V.playbackGeneration &&
      startPos === V.pos && V.wantsPlayback;
    const failed = e => {
      if (!valid()) return;
      if (onActive && V.platformBlocksAutoPlay() && commitInterruptedPreparedStart("audio interruption")) return;
      preparedStart = null;
      clearTimeout(attempt.timer);
      if (prep.localKind && V.mediaWasRejected(e, target)) {
        // Do this before normal loading reads storage, so it cannot retry the
        // same rejected blob while the screen is off.
        if (prep.localKind === "cache") {
          V.rejectedLocalCache.add(prep.id);
          V.deleteCached(prep.id).catch(() => {});
        } else {
          V.deleteDownload(prep.id).catch(() => {});
        }
      }
      if (prep.el && prep.el !== target) {
        prep.el.removeAttribute("src");
        try { prep.el.load(); } catch (ignore) {}
      }
      if (!onActive) {
        target.pause();
        target.removeAttribute("src");
        try { target.load(); } catch (ignore) {}
      }
      if (prep.blobUrl) URL.revokeObjectURL(prep.blobUrl);
      V.log("background", prep.id + " prepared playback failed: " + String((e && e.message) || e).slice(0, 60));
      if (manualNext) V.next(false);
      else V.advanceAfterEnd("prepared playback failed");
    };
    attempt.failed = failed;
    const started = () => {
      if (!valid()) return;
      if (V.platformBlocksAutoPlay()) return;
      if (target.paused) { failed(new Error("audio remained paused")); return; }
      preparedStart = null;
      clearTimeout(attempt.timer);
      V.log("background", prep.id + (onActive ? " started on active audio element" : " started from prepared source"));
      if (onActive) commitPreparedOnActive(prep);
      else commitTo(target, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
    };
    // Native media callbacks can run while promise continuations/timers wait for
    // the page to wake up. Complete the handoff there, before processing another
    // timeupdate using the previous song's duration, skip segments or metadata.
    attempt.confirm = () => {
      if (!target.paused && !target.ended && !target.seeking && target.readyState >= 2) started();
    };
    attempt.progress = () => {
      if (target.currentTime > attempt.startTime + 0.05) attempt.confirm();
    };
    const needsNativeStart = V.isIOS && onActive && !target.isCast && !V.remotePlaybackActive();
    const requestPlay = () => {
      try {
        const play = target.play();
        if (play && play.then) play.then(() => {
          // A resolved play request alone can still leave iOS silent at time 0.
          if (!needsNativeStart) started();
        }).catch(failed);
        else if (!needsNativeStart) started();
      } catch (e) { failed(e); }
    };
    attempt.ready = () => {
      if (!needsNativeStart || !valid() || V.platformBlocksAutoPlay() || attempt.retriedReady) return;
      attempt.retriedReady = true;
      // Reassert the pending request once in the new resource's native callback,
      // without a lookup or a timer that can be suspended in the background.
      V.log("background", prep.id + " ready; reasserting pending playback on active element");
      requestPlay();
    };
    attempt.checkDeadline = () => {
      if (valid() && Date.now() >= attempt.deadline) failed(new Error("prepared playback timeout"));
    };
    attempt.timer = setTimeout(() => failed(new Error("prepared playback timeout")), 9000);
    try {
      V.log("background", (V.current() || {}).id + " -> " + prep.id + " prepared transition, visibility=" + document.visibilityState);
      if (!target.src || onActive) V.setPlaybackSource(target, prep.src);
      const resumeAt = V.savedResumePosition(V.queue[prep.ni]);
      if (resumeAt > 0) {
        V.log("play", prep.id + " resuming at " + Math.round(resumeAt) + "s");
        try { target.currentTime = resumeAt; } catch (e) {}
      }
      V.noteQueuePosition(V.queue[prep.ni], resumeAt);
      attempt.startTime = target.currentTime || 0;
      if (onActive) V.updatePositionState();
      requestPlay();
    } catch (e) {
      failed(e);
    }
    return true;
  }
})();
