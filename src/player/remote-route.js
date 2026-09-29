(function () {
  const V = window.Aura.player;
  // An AirPlay route that changes under the song: the source swap, the recovery steps, and the remote playback events of each element.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    airPlaySourceChangeActive: { get: () => airPlaySourceChangeActive },
    bindRemotePlayback: { get: () => bindRemotePlayback },
    clearAirPlaySourceChange: { get: () => clearAirPlaySourceChange },
    routeCanResume: { get: () => routeCanResume },
    scheduleRouteRecovery: { get: () => scheduleRouteRecovery },
    setPlaybackSource: { get: () => setPlaybackSource },
    stopRouteRecovery: { get: () => stopRouteRecovery }
  });

  function clearAirPlaySourceChange() {
    if (V.airPlaySourceChange) clearTimeout(V.airPlaySourceChange.timer);
    V.airPlaySourceChange = null;
  }

  function airPlaySourceChangeActive(el) {
    const change = V.airPlaySourceChange;
    return !!(change && change.el === el && change.source === el.src && Date.now() < change.until);
  }

  function setPlaybackSource(el, source) {
    // Replacing src temporarily clears Safari's wireless flag while the receiver
    // loads the next song. Only a confirmed AirPlay route can start this grace
    // period; a stale generic remote.state must never put local playback in it.
    const changingAirPlaySource = el === V.audio && !el.isCast &&
      typeof el.webkitShowPlaybackTargetPicker === "function" && /^https?:\/\//i.test(source) &&
      (el.webkitCurrentPlaybackTargetIsWireless === true || airPlaySourceChangeActive(el));
    if (el === V.audio) clearAirPlaySourceChange();
    if (changingAirPlaySource) {
      stopRouteRecovery();
      // A change made while the last one is still waiting finds the flag already down, and
      // Safari will not report it dropping again: only its return is still to come.
      const change = { el, source, until: Date.now() + 9000,
        disconnected: el.webkitCurrentPlaybackTargetIsWireless !== true, timer: null };
      V.airPlaySourceChange = change;
      change.timer = setTimeout(() => {
        if (V.airPlaySourceChange !== change) return;
        clearAirPlaySourceChange();
        const reconcile = V.remoteRouteHandlers.get(el);
        if (reconcile) reconcile();
      }, 9000);
    }
    el.src = source;
    if (V.airPlaySourceChange && V.airPlaySourceChange.el === el) V.airPlaySourceChange.position = el.currentTime || 0;
  }

  function stopRouteRecovery() {
    clearTimeout(V.routeRecoveryTimer);
    V.routeRecoveryTimer = null;
    V.routeSettlingUntil = 0;
  }

  function routeCanResume() {
    const session = navigator.audioSession;
    // Safari versions that expose type/statechange but no state cannot confirm
    // focus. Only a just-connected route permits this bounded handoff recovery;
    // an observed interruption, inactive session or listener pause still wins.
    return !V.audioFocusInterrupted() && !V.mediaSessionPauseDecisionTimer &&
      (!session || session.state == null || session.state === "active");
  }

  function scheduleRouteRecovery(step = 0, position = V.audio.currentTime || 0) {
    if (V.audio.isCast || V.remoteState !== "connected" || !V.wantsPlayback ||
        (airPlaySourceChangeActive(V.audio) && V.nativeRemotePlaybackState(V.audio) === "disconnected") ||
        V.loadingInProgress || V.backend !== "audio" || !V.current()) return;
    const target = V.audio, token = V.loadingToken, source = V.audio.src;
    const startedAt = position;
    const deadline = Date.now() + 12000;
    if (step === 0) {
      stopRouteRecovery();
      V.routeSettlingUntil = Date.now() + 12000;
      V.clearStallCheck();
    }
    V.routeRecoveryTimer = setTimeout(() => {
      V.routeRecoveryTimer = null;
      if (target !== V.audio || token !== V.loadingToken || source !== V.audio.src ||
          V.remoteState !== "connected" || !V.wantsPlayback || V.loadingInProgress ||
          (airPlaySourceChangeActive(V.audio) && V.nativeRemotePlaybackState(V.audio) === "disconnected") ||
          V.preparedStart || V.audio.ended || !routeCanResume()) return;
      if (!V.audio.paused && Math.abs((V.audio.currentTime || 0) - startedAt) >= 0.2) {
        stopRouteRecovery();
        return;
      }
      // A frozen background page may deliver this timer much later, after the
      // listener has moved on to watching TV. Do not restart that expired handoff.
      if (Date.now() > deadline) { V.holdRemotePlayback(); return; }
      V.platformPaused = false;
      if (step === 0) {
        if (V.audio.paused) {
          V.log("remote", "resuming after wireless handoff");
          try { Promise.resolve(V.audio.play()).catch(() => {}); } catch (e) {}
        }
        scheduleRouteRecovery(1);
      } else if (step === 1 && !V.routeReattached) {
        // Reattach the SAME source once, preserving its position and codec.
        // Resolving another format here tears down Safari's new route again.
        V.routeReattached = true;
        V.log("remote", "wireless handoff has no progress; reattaching the current stream once");
        V.prepareRemotePlayback(true);
      } else V.holdRemotePlayback();
    }, step === 0 ? 2500 : 4000);
  }

  function bindRemotePlayback(el) {
    let lastConflictingState = null;
    const changed = () => {
      if (el !== V.audio) return;
      const state = V.nativeRemotePlaybackState(el);
      if (airPlaySourceChangeActive(el)) {
        if (state === "disconnected") {
          if (!V.airPlaySourceChange.disconnected) V.log("remote", "AirPlay source change; waiting for receiver");
          V.airPlaySourceChange.disconnected = true;
          return;
        }
        if (state === "connected" && V.airPlaySourceChange.disconnected) {
          clearAirPlaySourceChange();
          V.log("remote", "AirPlay receiver returned after source change");
          // The route never changed from the app's point of view. Do not commit
          // or discard a pending prepared start, or replace its in-flight source.
          if (state === V.remoteState) {
            if (V.wantsPlayback && routeCanResume()) V.platformPaused = false;
            scheduleRouteRecovery();
            return;
          }
        }
      } else if (V.airPlaySourceChange && V.airPlaySourceChange.el === el) clearAirPlaySourceChange();
      const conflicting = state === "disconnected" && el.remote && el.remote.state !== state ? el.remote.state : null;
      if (conflicting && conflicting !== lastConflictingState) {
        V.log("remote", "ignoring Remote Playback " + conflicting + "; AirPlay reports local output");
      }
      lastConflictingState = conflicting;
      if (state === V.remoteState) return;
      V.remoteState = state;
      // Some browsers pause immediately before announcing the route. Allow the
      // bounded handoff recovery unless focus or listener intent forbids it.
      if (state === "connected" && V.wantsPlayback && routeCanResume()) {
        V.platformPaused = false;
      }
      V.log("remote", "TV playback " + state);
      V.cancelCrossfade();
      V.commitInterruptedPreparedStart("wireless connection");
      // Detach the standby decoder, but retain an already-resolved HTTP next
      // track so an ended event during the handoff can still advance normally.
      const prep = state !== "disconnected" && V.xfadePrep &&
        !V.xfadePrep.repairing && /^https?:\/\//i.test(V.xfadePrep.src) ? V.xfadePrep : null;
      V.discardPrep();
      if (prep) { delete prep.el; V.keepPreparedSource(prep); }
      V.audio.volume = V.levelled();
      const needsSource = V.backend !== "audio" || !/^https?:\/\//i.test(V.audio.src) ||
        (V.loadingInProgress && !(V.remotePreparation && V.remotePreparation.token === V.loadingToken) && V.attachedAudioSourceToken !== V.loadingToken);
      if (state !== "disconnected" && needsSource) {
        V.prepareRemotePlayback();
      } else {
        // A native route event is not a request to replace a working stream.
        // Leave Safari's native handoff in charge of the existing source.
        if (state !== "disconnected") V.remoteSource = true;
        V.prefetchNext();
      }
      if (state === "connected") scheduleRouteRecovery();
      else stopRouteRecovery();
      if (state === "disconnected" && V.wantsPlayback && V.backend === "audio") V.ensureSessionKick();
      V.updatePlaybackState();
      if (V.current()) V.updateMediaSession(V.current());
      V.emit({ type: "remote" });
      V.emit({ type: "state" });
    };
    V.remoteRouteHandlers.set(el, changed);
    // Safari may freeze a page while a system output is selected. Reconcile the
    // actual route on return before the normal resume and metadata handlers run.
    window.addEventListener("pageshow", changed);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) changed(); });
    el.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", changed);
    if (el.remote && el.remote.addEventListener) {
      ["connecting", "connect", "disconnect"].forEach(event => el.remote.addEventListener(event, changed));
    }
  }
})();
