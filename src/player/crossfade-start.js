(function () {
  const V = window.Aura.player;
  // Starting the prepared song: the crossfade itself, the instant handoff, and the commit that makes the standby the active element.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    commitPreparedOnActive: { get: () => commitPreparedOnActive },
    commitTo: { get: () => commitTo },
    maybeCrossfade: { get: () => maybeCrossfade },
    playPreparedInstantly: { get: () => playPreparedInstantly }
  });

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
    V.attachedTrackId = V.queue[ni] ? V.queue[ni].id : null;
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.stallRecoveries = 0;
    V.clearStallCheck();
    V.lastAudioTime = V.audio.currentTime || 0;
    V.lastAudioProgressAt = Date.now();
    V.xfade = null;
    V.xfadePrep = null;
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
      V.scheduleEarlyPrefetch();
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
    V.attachedTrackId = prep.id;
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.stallRecoveries = 0;
    V.clearStallCheck();
    V.lastAudioTime = 0;
    V.lastAudioProgressAt = Date.now();
    V.xfadePrep = null;
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
      V.scheduleEarlyPrefetch();
    }
  }

  function startCrossfade(fade) {
    if (V.isIOS || V.remotePlaybackActive()) return;
    if (V.xfadePrep && V.xfadePrep.repairing) return;
    if (V.audio.paused || V.platformBlocksAutoPlay() || !V.prepValid()) {
      if (!V.prepValid()) V.discardPrep();
      return;
    }
    // A track with a place to pick up from is not faded in from its start; the handoff
    // at the end resumes it.
    if (V.savedResumePosition(V.queue[V.xfadePrep.ni]) > 0) return;
    const prep = V.xfadePrep;
    const standby = prep.el || V.otherEl();
    if (!standby.src) standby.src = prep.src;
    standby.volume = 0;
    const durMs = fade * 1000;
    V.xfade = {
      el: standby, ni: prep.ni, blobUrl: prep.blobUrl, localKind: prep.localKind, gain: prep.gain,
      timer: null, started: false
    };
    V.xfadePrep = null;
    const begin = () => {
      if (!V.xfade || V.xfade.el !== standby || standby.paused || V.audio.paused || V.platformBlocksAutoPlay()) {
        if (V.xfade && V.xfade.el === standby) V.cancelCrossfade();
        return;
      }
      V.xfade.started = true;
      const startAt = Date.now();
      V.log("xfade", "crossfading " + fade + "s into " + prep.id);
      V.xfade.timer = setInterval(() => {
        if (!V.xfade) return;
        if (standby.paused || V.audio.paused || V.platformBlocksAutoPlay()) { V.cancelCrossfade(); return; }
        const p = Math.min(1, (Date.now() - startAt) / durMs);
        standby.volume = Math.max(0, Math.min(1, V.volume * (prep.gain == null ? 1 : prep.gain) * p));
        V.audio.volume = V.levelled(1 - p);
        if (p >= 1) {
          clearInterval(V.xfade.timer);
          commitTo(standby, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
        }
      }, 60);
    };
    try {
      const play = standby.play();
      if (play && play.then) {
        play.then(begin).catch(() => {
          if (V.xfade && V.xfade.el === standby) V.cancelCrossfade();
        });
      } else {
        begin();
      }
    } catch (e) {
      V.cancelCrossfade();
    }
  }

  function maybeCrossfade() {
    if (V.backend !== "audio" || !V.wantsPlayback || V.audio.paused || V.platformBlocksAutoPlay() ||
        V.preparedStart || V.loadingInProgress || V.xfade || V.repeat === "one") return;
    if (V.sleepAfterTrack) return;
    const dur = V.playbackDuration();
    if (!Number.isFinite(dur) || !dur) return;
    // In seconds of actual waiting, not seconds of the track: at 1.5x there is a third less
    // time left than the timeline says, and the fade ramp below runs on Date.now(). Left
    // unscaled, a crossfade started at the right place in the song was still ramping when
    // the track ended.
    const remaining = (dur - V.audio.currentTime) / (V.audio.playbackRate || 1);
    const fade = V.crossfadeSecs();
    // End transitions still require the same amount of actual listening.
    if (remaining <= Math.max(fade, 2)) V.countListen("reached the end");
    // Held ready in the background too - the screen being off is when continuous playback
    // matters most, and nothing else prepares it there.
    // One held since the song began may have expired by now; ask for it again in time.
    if (remaining <= Math.max(fade + 6, 12) && V.prepExpiring(V.xfadePrep) && !V.xfadePrep.repairing) V.discardPrep();
    if (remaining <= Math.max(fade + 6, 12) && !V.xfadePrep && !V.prepBusy) V.prepNextSource();
    if (document.hidden) {
      if (!V.remotePlaybackActive() && remaining <= V.hiddenHandoffLead() && V.prepValid()) playPreparedInstantly();
      return;
    }
    if (fade > 0 && remaining <= fade && V.prepValid()) startCrossfade(Math.min(fade, Math.max(1, remaining)));
  }

  function playPreparedInstantly(manualNext) {
    if (V.preparedStart) return true;
    if (!V.wantsPlayback || V.platformBlocksAutoPlay()) return false;
    if (!V.prepValid()) { V.discardPrep(); return false; }
    if (V.xfadePrep.repairing || (V.remotePlaybackActive() && !/^https?:\/\//i.test(V.xfadePrep.src))) { V.discardPrep(); return false; }
    // A stream lined up before the signal went has a few buffered seconds to give at
    // best. Started offline it stalled there, with saved songs waiting behind it.
    if (navigator.onLine === false && !V.xfadePrep.localKind && !V.remotePlaybackActive()) { V.discardPrep(); return false; }
    const prep = V.xfadePrep;
    const onActive = V.handoffOnActive();
    const target = onActive ? V.audio : (prep.el || V.otherEl());
    if (target.isCast) { target.mediaTrack = V.queue[prep.ni]; target.mediaMime = prep.mime || "audio/mpeg"; }
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    V.xfadePrep = null;
    // At the track's own level from the first sample: the loudness gain used to arrive
    // only with the confirmed handoff, so a loud upload blared for its first moments.
    target.volume = Math.max(0, Math.min(1, V.volume * (prep.gain == null ? 1 : prep.gain)));
    const attempt = { el: target, prep, timer: null, deadline: Date.now() + 9000 };
    V.preparedStart = attempt;
    const valid = () => V.preparedStart === attempt && generation === V.playbackGeneration &&
      startPos === V.pos && V.wantsPlayback;
    // An attempt invalidated without being cancelled (a generation bump, a Cast pause)
    // used to stay in preparedStart for good, holding the ended handler, the stall
    // check and the position writes until a pause or a new selection. Let it go.
    const abandon = () => {
      if (V.preparedStart !== attempt) return;
      if (onActive) { V.preparedStart = null; clearTimeout(attempt.timer); }
      else V.cancelPreparedStart();
    };
    const failed = e => {
      if (!valid()) { abandon(); return; }
      if (onActive && V.platformBlocksAutoPlay() && V.commitInterruptedPreparedStart("audio interruption")) return;
      if (!onActive && V.holdRefusedHandoff(attempt, e)) return;
      V.preparedStart = null;
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
      if (!valid()) { abandon(); return; }
      if (V.platformBlocksAutoPlay()) return;
      if (target.paused) { failed(new Error("audio remained paused")); return; }
      V.preparedStart = null;
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
