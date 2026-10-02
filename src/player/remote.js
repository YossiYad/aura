(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    airPlaySourceChange: { get: () => airPlaySourceChange, set: value => { airPlaySourceChange = value; } },
    attachedTrackId: { get: () => attachedTrackId, set: value => { attachedTrackId = value; } },
    configureRemoteElements: { get: () => configureRemoteElements },
    currentTrackTime: { get: () => currentTrackTime },
    localBeforeCast: { get: () => localBeforeCast, set: value => { localBeforeCast = value; } },
    nativeRemotePlaybackState: { get: () => nativeRemotePlaybackState },
    prepareRemotePlayback: { get: () => prepareRemotePlayback },
    remotePlaybackActive: { get: () => remotePlaybackActive },
    remotePlaybackStatus: { get: () => remotePlaybackStatus },
    remotePreparation: { get: () => remotePreparation, set: value => { remotePreparation = value; } },
    remoteRouteHandlers: { get: () => remoteRouteHandlers },
    remoteSource: { get: () => remoteSource, set: value => { remoteSource = value; } },
    remoteState: { get: () => remoteState, set: value => { remoteState = value; } },
    requestRemotePlayback: { get: () => requestRemotePlayback },
    restoredPosition: { get: () => restoredPosition, set: value => { restoredPosition = value; } },
    resumeAfterCastAt: { get: () => resumeAfterCastAt, set: value => { resumeAfterCastAt = value; } },
    routeReattached: { get: () => routeReattached, set: value => { routeReattached = value; } },
    routeRecoveryTimer: { get: () => routeRecoveryTimer, set: value => { routeRecoveryTimer = value; } },
    routeSettlingUntil: { get: () => routeSettlingUntil, set: value => { routeSettlingUntil = value; } },
    streamOptions: { get: () => streamOptions }
  });

  // A wireless route belongs to a media element. Keep that element and give the
  // receiver an HTTP source: device-local blob URLs cannot be fetched by a TV.
  let remoteState = "disconnected";
  // The track whose source the active element holds, and so whose clock it runs.
  let attachedTrackId = null;
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
    return castConnected() || V.airPlaySourceChangeActive(V.audio) || nativeRemotePlaybackState(V.audio) !== "disconnected";
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

  // Where the current track stands, for a handoff that has to carry its place across. While
  // the next song is still resolving, the element holds the song before it, and its clock is
  // that song's: read as the new one's place, the TV started the next song where the previous
  // one had got to. The new track has no place yet but a saved episode position.
  function currentTrackTime() {
    const track = V.current();
    if (V.backend === "audio" && track && attachedTrackId && attachedTrackId !== track.id) {
      return V.savedResumePosition(track);
    }
    return V.getTime().cur || 0;
  }

  function prepareRemotePlayback(reuseSource = false) {
    if (remotePreparation && remotePreparation.token === V.loadingToken) return remotePreparation.promise;
    V.commitInterruptedPreparedStart("wireless connection");
    const track = V.current();
    if (!track) return Promise.resolve(false);
    // A pause during the handoff removed the source, and with it the position; the
    // one kept from that moment is where the TV picks up.
    const resumeAt = currentTrackTime() || resumeAfterCastAt || 0;
    resumeAfterCastAt = 0;
    const source = V.audio.src;
    V.stopRouteRecovery();
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
        if (!reuseSource) V.activeGain = V.gainFor(V.noteStreamLoudness(track.id, info.loudnessDb));
        remoteSource = true;
        if (V.audio.isCast) { V.audio.mediaTrack = track; V.audio.mediaMime = info.mime || "audio/mpeg"; }
        V.rememberStreamDuration(track, info);
        V.attachedAudioSourceToken = token;
        attachedTrackId = track.id;
        V.setPlaybackSource(V.audio, info.url);
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
        else {
          // Stopped here until the listener retries with Play, like the other TV failures.
          // Left wanting playback, the player read as playing while silent: the audio
          // session stayed held, reloads waited on it, and a later route change could
          // start the sound on its own.
          V.wantsPlayback = false;
          V.platformPaused = false;
          V.focusResumePending = false;
          V.focusResumeConfirmed = false;
          V.emit({ type: "remote-error", message: "Could not load a stream for the TV. Check your connection and try again." });
        }
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
      if (success && token === V.loadingToken) V.scheduleRouteRecovery(reuseSource ? 2 : 0, resumeAt);
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
    // A handoff already running on the active element is the current song; discarding
    // it uncommitted would strip that element and leave the queue on the finished one.
    V.commitPendingPreparedStart("remote picker");
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

})();
