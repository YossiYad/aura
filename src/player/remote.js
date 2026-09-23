(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    airPlaySourceChange: { get: () => airPlaySourceChange },
    airPlaySourceChangeActive: { get: () => airPlaySourceChangeActive },
    bindRemotePlayback: { get: () => bindRemotePlayback },
    clearAirPlaySourceChange: { get: () => clearAirPlaySourceChange },
    configureRemoteElements: { get: () => configureRemoteElements },
    localBeforeCast: { get: () => localBeforeCast, set: value => { localBeforeCast = value; } },
    nativeRemotePlaybackState: { get: () => nativeRemotePlaybackState },
    prepareRemotePlayback: { get: () => prepareRemotePlayback },
    remotePlaybackActive: { get: () => remotePlaybackActive },
    remotePlaybackStatus: { get: () => remotePlaybackStatus },
    remotePreparation: { get: () => remotePreparation, set: value => { remotePreparation = value; } },
    remoteSource: { get: () => remoteSource, set: value => { remoteSource = value; } },
    remoteState: { get: () => remoteState, set: value => { remoteState = value; } },
    requestRemotePlayback: { get: () => requestRemotePlayback },
    restoredPosition: { get: () => restoredPosition, set: value => { restoredPosition = value; } },
    resumeAfterCastAt: { get: () => resumeAfterCastAt, set: value => { resumeAfterCastAt = value; } },
    routeCanResume: { get: () => routeCanResume },
    routeReattached: { get: () => routeReattached, set: value => { routeReattached = value; } },
    routeSettlingUntil: { get: () => routeSettlingUntil },
    scheduleRouteRecovery: { get: () => scheduleRouteRecovery },
    setPlaybackSource: { get: () => setPlaybackSource },
    stopRouteRecovery: { get: () => stopRouteRecovery },
    streamOptions: { get: () => streamOptions }
  });

  // A wireless route belongs to a media element. Keep that element and give the
  // receiver an HTTP source: device-local blob URLs cannot be fetched by a TV.
  let remoteState = "disconnected";
  let remoteSource = false;
  let remotePreparation = null;
  let localBeforeCast = V.audioA;
  let resumeAfterCastAt = 0;
  let restoredPosition = null;
  let castInitializing = false;
  let routeRecoveryTimer = null;
  let routeSettlingUntil = 0;
  let routeReattached = false;
  let airPlaySourceChange = null;
  const remoteRouteHandlers = new WeakMap();

  function clearAirPlaySourceChange() {
    if (airPlaySourceChange) clearTimeout(airPlaySourceChange.timer);
    airPlaySourceChange = null;
  }

  function airPlaySourceChangeActive(el) {
    const change = airPlaySourceChange;
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
      const change = { el, source, until: Date.now() + 9000, disconnected: false, timer: null };
      airPlaySourceChange = change;
      change.timer = setTimeout(() => {
        if (airPlaySourceChange !== change) return;
        clearAirPlaySourceChange();
        const reconcile = remoteRouteHandlers.get(el);
        if (reconcile) reconcile();
      }, 9000);
    }
    el.src = source;
    if (airPlaySourceChange && airPlaySourceChange.el === el) airPlaySourceChange.position = el.currentTime || 0;
  }

  function stopRouteRecovery() {
    clearTimeout(routeRecoveryTimer);
    routeRecoveryTimer = null;
    routeSettlingUntil = 0;
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
    if (V.audio.isCast || remoteState !== "connected" || !V.wantsPlayback ||
        (airPlaySourceChangeActive(V.audio) && nativeRemotePlaybackState(V.audio) === "disconnected") ||
        V.loadingInProgress || V.backend !== "audio" || !V.current()) return;
    const target = V.audio, token = V.loadingToken, source = V.audio.src;
    const startedAt = position;
    const deadline = Date.now() + 12000;
    if (step === 0) {
      stopRouteRecovery();
      routeSettlingUntil = Date.now() + 12000;
      V.clearStallCheck();
    }
    routeRecoveryTimer = setTimeout(() => {
      routeRecoveryTimer = null;
      if (target !== V.audio || token !== V.loadingToken || source !== V.audio.src ||
          remoteState !== "connected" || !V.wantsPlayback || V.loadingInProgress ||
          (airPlaySourceChangeActive(V.audio) && nativeRemotePlaybackState(V.audio) === "disconnected") ||
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
      } else if (step === 1 && !routeReattached) {
        // Reattach the SAME source once, preserving its position and codec.
        // Resolving another format here tears down Safari's new route again.
        routeReattached = true;
        V.log("remote", "wireless handoff has no progress; reattaching the current stream once");
        prepareRemotePlayback(true);
      } else V.holdRemotePlayback();
    }, step === 0 ? 2500 : 4000);
  }

  function castConnected() { return !!(window.CastPlayback && CastPlayback.connected()); }

  function nativeRemotePlaybackState(el) {
    // Safari exposes both APIs, but its generic remote.state can remain
    // "connecting" while audio is on the phone. Use the direct AirPlay output
    // flag whenever the native picker is available, including a false flag.
    if (typeof el.webkitShowPlaybackTargetPicker === "function" &&
        typeof el.webkitCurrentPlaybackTargetIsWireless === "boolean") {
      return el.webkitCurrentPlaybackTargetIsWireless ? "connected" : "disconnected";
    }
    return el.webkitCurrentPlaybackTargetIsWireless ? "connected" :
      (el.remote ? el.remote.state : "disconnected");
  }

  function remotePlaybackActive() {
    return castConnected() || airPlaySourceChangeActive(V.audio) || nativeRemotePlaybackState(V.audio) !== "disconnected";
  }

  function streamOptions(id) {
    // Safari can decode WebM locally with an engine that cannot hand off to
    // AirPlay. Choose a native receiver format before a system route is picked,
    // including for the next song, without requesting a connection to any TV.
    return { quality: V.qualityFor(id), remote: remotePlaybackActive(),
      receiverCompatible: typeof V.audio.webkitShowPlaybackTargetPicker === "function" };
  }

  /**
   * @returns {RemotePlaybackStatus}
   */
  function remotePlaybackStatus() {
    return { supported: !!(window.CastPlayback && CastPlayback.ready()) || typeof V.audio.webkitShowPlaybackTargetPicker === "function" ||
      !!(V.audio.remote && typeof V.audio.remote.prompt === "function"),
      state: remoteState, preparing: !!(remotePreparation && remotePreparation.token === V.loadingToken) || castInitializing,
      deviceName: castConnected() ? CastPlayback.deviceName() : "TV", canDisconnect: castConnected() };
  }

  // "allow" asks Safari for AirPlay's video mode even for a song: the TV downloads the
  // stream itself, so it shows the container's own length (YouTube's fragmented m4a
  // reads as double) and the phone's volume buttons do not reach it. On iPhone and iPad
  // "deny" turns off only that mode. The system route still carries the sound, the way
  // a music app does: the phone plays and streams, the TV shows the Media Session's
  // title, artwork and corrected timeline, and the volume buttons control the receiver.
  // To the page this is ordinary local playback, so downloads and crossfade keep working.
  const airPlayAudioOnly = V.isIOS;

  function configureRemoteElements() {
    [V.audioA, V.audioB].forEach(el => {
      el.disableRemotePlayback = el !== V.audio;
      el.setAttribute("x-webkit-airplay", el === V.audio && !airPlayAudioOnly ? "allow" : "deny");
    });
  }

  function prepareRemotePlayback(reuseSource = false) {
    if (remotePreparation && remotePreparation.token === V.loadingToken) return remotePreparation.promise;
    V.commitInterruptedPreparedStart("wireless connection");
    const track = V.current();
    if (!track) return Promise.resolve(false);
    // A pause during the handoff removed the source, and with it the position; the
    // one kept from that moment is where the TV picks up.
    const resumeAt = V.getTime().cur || resumeAfterCastAt || 0;
    resumeAfterCastAt = 0;
    const source = V.audio.src;
    stopRouteRecovery();
    const token = ++V.loadingToken;
    V.playbackGeneration++;
    V.loadingInProgress = true;
    remoteSource = false;
    V.stopSourceRetry();
    V.cancelCrossfade();
    V.discardPrep();
    V.clearStallCheck();
    V.audio.pause();
    V.backend = "audio";
    V.stopYt();
    const pending = (async () => {
      try {
        const info = reuseSource ? await Promise.resolve(/** @type {StreamInfo} */ ({ url: source })) :
          await Api.resolve(track.id, { quality: V.qualityFor(track.id), remote: true });
        if (token !== V.loadingToken) return false;
        if (!/^https?:\/\//i.test(info.url)) throw new Error("No TV-compatible stream");
        V.activeLocalKind = null;
        if (!reuseSource) V.activeGain = V.gainFor(info.loudnessDb);
        remoteSource = true;
        if (V.audio.isCast) { V.audio.mediaTrack = track; V.audio.mediaMime = info.mime || "audio/mpeg"; }
        V.rememberStreamDuration(track, info);
        V.attachedAudioSourceToken = token;
        setPlaybackSource(V.audio, info.url);
        if (V.audio.isCast) V.audio.currentTime = resumeAt;
        V.audio.volume = V.levelled();
        V.audio.muted = false;
        V.applyRate(V.audio);
        const target = V.audio;
        const restorePosition = () => {
          target.removeEventListener("loadedmetadata", restorePosition);
          if (token !== V.loadingToken || target !== V.audio) return;
          try { target.currentTime = resumeAt; } catch (e) {}
        };
        target.addEventListener("loadedmetadata", restorePosition);
        if (target.readyState >= 1) restorePosition();
        if (V.blobUrl) { URL.revokeObjectURL(V.blobUrl); V.blobUrl = null; }
        if (V.wantsPlayback && !V.platformBlocksAutoPlay()) {
          let timer;
          try {
            await Promise.race([target.play(), new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error("TV playback timed out")), 9000);
            })]);
          } finally { clearTimeout(timer); }
        } else if (V.audio.isCast) await V.audio.loadPaused();
        if (token !== V.loadingToken) return false;
        V.lastAudioTime = target.currentTime || 0;
        V.lastAudioProgressAt = Date.now();
        V.updateMediaSession(track);
        V.prefetchNext();
        return true;
      } catch (e) {
        if (token !== V.loadingToken) return false;
        V.audio.pause();
        if (V.playbackPermissionDenied(e)) V.holdPlaybackPermission(track, resumeAt);
        else V.emit({ type: "remote-error", message: "Could not load a stream for the TV. Check your connection and try again." });
        return false;
      } finally {
        if (token === V.loadingToken) {
          V.loadingInProgress = false;
          V.updatePlaybackState();
          V.emit({ type: "state" });
        }
      }
    })();
    remotePreparation = { token, promise: pending };
    V.emit({ type: "remote" });
    pending.then(success => {
      if (remotePreparation && remotePreparation.promise === pending) remotePreparation = null;
      if (success && token === V.loadingToken) scheduleRouteRecovery(reuseSource ? 2 : 0, resumeAt);
      V.emit({ type: "remote" });
    });
    return pending;
  }

  /**
   * Opens the AirPlay or Cast picker, or ends a Cast session already running.
   * @returns {Promise<void>}
   */
  async function requestRemotePlayback() {
    if (window.CastPlayback && typeof V.audio.webkitShowPlaybackTargetPicker !== "function") {
      if (castConnected()) { CastPlayback.disconnect(); return; }
      if (!CastPlayback.ready()) {
        castInitializing = true;
        V.emit({ type: "remote" });
        try {
          if (await CastPlayback.initialize()) {
            V.emit({ type: "remote-ready" });
            return;
          }
        } catch (e) { /* The native browser picker remains available as a fallback. */ }
        finally { castInitializing = false; V.emit({ type: "remote" }); }
      } else {
        try { await CastPlayback.request(); }
        catch (e) {
          if (e !== "cancel" && (!e || e.code !== "cancel")) V.emit({ type: "remote-error", message: "Could not connect to the TV. Check that both devices are on the same Wi-Fi." });
        }
        return;
      }
    }
    if (!remotePlaybackStatus().supported) {
      V.emit({ type: "remote-error", message: "TV playback is not available in this browser. Try Safari on iPhone or Chrome on Android, with the TV on the same Wi-Fi." });
      return;
    }
    if (!V.current()) return;
    if (airPlayAudioOnly && typeof V.audio.webkitShowPlaybackTargetPicker === "function") {
      // The phone stays the player on this route, so there is no receiver stream to
      // prepare: open the system chooser inside this same tap and leave the source alone.
      try { V.audio.webkitShowPlaybackTargetPicker(); } catch (e) {}
      return;
    }
    if (V.loadingInProgress) return;
    if (!/^https?:\/\//i.test(V.audio.src) || V.backend !== "audio") {
      if (await prepareRemotePlayback()) {
        // Opening a native picker requires a new user gesture after async fetching.
        V.emit({ type: "remote-ready" });
      }
      return;
    }
    V.cancelCrossfade();
    V.discardPrep();
    try {
      if (typeof V.audio.webkitShowPlaybackTargetPicker === "function") V.audio.webkitShowPlaybackTargetPicker();
      else await V.audio.remote.prompt();
    } catch (e) {
      if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
        V.emit({ type: "remote-error", message: "No TV connection available. Check that your phone and TV are on the same Wi-Fi." });
      }
    }
    V.prefetchNext();
    V.emit({ type: "remote" });
  }

  function bindRemotePlayback(el) {
    let lastConflictingState = null;
    const changed = () => {
      if (el !== V.audio) return;
      const state = nativeRemotePlaybackState(el);
      if (airPlaySourceChangeActive(el)) {
        if (state === "disconnected") {
          if (!airPlaySourceChange.disconnected) V.log("remote", "AirPlay source change; waiting for receiver");
          airPlaySourceChange.disconnected = true;
          return;
        }
        if (state === "connected" && airPlaySourceChange.disconnected) {
          clearAirPlaySourceChange();
          V.log("remote", "AirPlay receiver returned after source change");
          // The route never changed from the app's point of view. Do not commit
          // or discard a pending prepared start, or replace its in-flight source.
          if (state === remoteState) {
            if (V.wantsPlayback && routeCanResume()) V.platformPaused = false;
            scheduleRouteRecovery();
            return;
          }
        }
      } else if (airPlaySourceChange && airPlaySourceChange.el === el) clearAirPlaySourceChange();
      const conflicting = state === "disconnected" && el.remote && el.remote.state !== state ? el.remote.state : null;
      if (conflicting && conflicting !== lastConflictingState) {
        V.log("remote", "ignoring Remote Playback " + conflicting + "; AirPlay reports local output");
      }
      lastConflictingState = conflicting;
      if (state === remoteState) return;
      remoteState = state;
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
        (V.loadingInProgress && !(remotePreparation && remotePreparation.token === V.loadingToken) && V.attachedAudioSourceToken !== V.loadingToken);
      if (state !== "disconnected" && needsSource) {
        prepareRemotePlayback();
      } else {
        // A native route event is not a request to replace a working stream.
        // Leave Safari's native handoff in charge of the existing source.
        if (state !== "disconnected") remoteSource = true;
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
    remoteRouteHandlers.set(el, changed);
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
