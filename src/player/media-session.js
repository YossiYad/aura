(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    clearPositionState: { get: () => clearPositionState },
    refreshMediaSessionControls: { get: () => refreshMediaSessionControls },
    reviveStoppedMediaSession: { get: () => reviveStoppedMediaSession },
    stopPlayback: { get: () => stopPlayback },
    updateMediaSession: { get: () => updateMediaSession },
    updatePlaybackState: { get: () => updatePlaybackState },
    updatePositionState: { get: () => updatePositionState }
  });

  // The picture on the lock screen. Handing over mqdefault.jpg was wrong twice. It is
  // 320x180, and the lock screen shows art far larger than that - blown up to fill a
  // square it is visibly soft. And it is a remote URL, so a downloaded song playing with
  // no signal had no art at all, even though its picture was already on disk beside the
  // audio. So the square gets cut here: from the saved blob when there is one, and from
  // the largest thumbnail YouTube has otherwise. Cutting it ourselves also settles the
  // framing, instead of leaving each platform to fit or crop the 16:9 as it sees fit.
  let artUrl = null;
  let artUrlTrackId = null;
  let artUrlSize = 0;
  let artToken = 0;

  function setMediaMetadata(track, artwork) {
    if (typeof MediaMetadata !== "function") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || "Aura",
        artwork
      });
    } catch (e) {}
  }

  // Deliberately not Api.fetchImageBlob: maxresdefault is missing for plenty of videos,
  // and that helper answers a miss by walking every CORS proxy in turn, which is a long
  // wait for a picture we have a perfectly good fallback for.
  async function fetchImageDirect(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob.size > 500 ? blob : null;
    } catch (e) {
      return null;
    } finally { clearTimeout(timer); }
  }

  async function artSourceBlob(track) {
    const saved = await V.getArt(track.id);
    if (saved) return saved;
    const hi = await fetchImageDirect("https://i.ytimg.com/vi/" + track.id + "/maxresdefault.jpg", 6000);
    if (hi) return hi;
    try { return await Api.fetchImageBlob(track.thumb || Api.thumbFor(track.id)); }
    catch (e) { return null; }
  }

  async function squareArt(blob) {
    if (typeof createImageBitmap !== "function") return null;
    let bmp = null;
    try { bmp = await createImageBitmap(blob); } catch (e) { return null; }
    try {
      const side = Math.min(bmp.width, bmp.height);
      if (!side) return null;
      // Never upscale. A 320x180 thumbnail yields a true 180x180 rather than a soft 512.
      const size = Math.min(512, side);
      const sx = Math.round((bmp.width - side) / 2);
      const sy = Math.round((bmp.height - side) / 2);
      /** @type {any} OffscreenCanvas or HTMLCanvasElement; each has one of the blob calls below. */
      let canvas;
      if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(size, size);
      else {
        canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
      const out = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
        : await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.9));
      return out ? { blob: out, size } : null;
    } catch (e) {
      return null;
    } finally { try { bmp.close(); } catch (e) {} }
  }

  function squareArtwork() {
    return [{ src: artUrl, sizes: artUrlSize + "x" + artUrlSize, type: "image/jpeg" }];
  }

  async function applySquareArt(track, token) {
    const source = await artSourceBlob(track);
    if (!source || token !== artToken) return;
    const square = await squareArt(source);
    if (!square || token !== artToken || V.remotePlaybackActive()) return;
    if (artUrl) { try { URL.revokeObjectURL(artUrl); } catch (e) {} }
    artUrl = URL.createObjectURL(square.blob);
    artUrlTrackId = track.id;
    artUrlSize = square.size;
    setMediaMetadata(track, squareArtwork());
  }

  // How far the lock screen's skip arrows move. The platform usually names its own step in
  // the action details; this is the answer when it does not.
  const SEEK_STEP = 10;

  // The notification's own dismiss. Without it the card sits in the shade after the
  // listener is done and has to be swiped away by hand. The flag outlives the call because
  // pausing fires a "pause" event on the element a tick later, and the state update riding
  // on it would otherwise put the card straight back.
  let mediaSessionStopped = false;

  function stopPlayback() {
    V.pausePlay();
    if (!("mediaSession" in navigator)) return;
    mediaSessionStopped = true;
    artToken++;
    try {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    } catch (e) {}
    clearPositionState();
  }

  function reviveStoppedMediaSession() {
    if (!mediaSessionStopped) return;
    mediaSessionStopped = false;
    const track = V.current();
    if (track) updateMediaSession(track);
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator)) return;
    mediaSessionStopped = false;
    const token = ++artToken;
    if (V.remotePlaybackActive()) {
      // Receivers cannot fetch a local cropped blob. Keep the public image and
      // invalidate any crop that was still being decoded when the route changed.
      const url = /^https?:\/\//i.test(track.thumb || "") ? track.thumb.replace("mqdefault.jpg", "hqdefault.jpg") : Api.thumbFor(track.id);
      setMediaMetadata(track, [{ src: url }]);
    } else if (artUrlTrackId === track.id && artUrl) {
      setMediaMetadata(track, squareArtwork());
    } else {
      // The remote thumbnail goes up first so the notification is never blank while the
      // square is being cut, and stays as the answer if the cut fails.
      setMediaMetadata(track, [{ src: track.thumb || Api.thumbFor(track.id), sizes: "320x180", type: "image/jpeg" }]);
      applySquareArt(track, token).catch(() => {});
    }
    registerMediaSessionActions();
    updatePositionState();
  }

  function registerMediaSessionActions() {
    if (!("mediaSession" in navigator)) return;
    const handlers = [
      ["play", V.resumePlay],
      ["pause", V.mediaSessionPause],
      ["previoustrack", V.prev],
      ["nexttrack", () => V.next(false)],
      ["seekto", d => { if (d && d.seekTime != null) V.seekTo(d.seekTime); }],
      ["seekbackward", d => {
        V.seekTo(Math.max(0, V.getTime().cur - ((d && d.seekOffset) || SEEK_STEP)));
      }],
      ["seekforward", d => {
        const time = V.getTime();
        const to = time.cur + ((d && d.seekOffset) || SEEK_STEP);
        // Stop just short of the end rather than seeking onto it: a source parked on its
        // last frame does not always fire the event that advances the queue, and the card
        // then reads as frozen on a track that has already finished.
        const dur = Number.isFinite(time.dur) ? time.dur : 0;
        V.seekTo(dur ? Math.min(to, Math.max(0, dur - 1)) : to);
      }],
      ["stop", stopPlayback]
    ];
    // Support differs by action. A rejected action must not prevent registration of
    // the remaining controls, including play/pause and track navigation.
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, details => {
          V.log("media-session", action + " visibility=" + document.visibilityState + " backend=" + V.backend);
          V.reportBackgroundHold("media-session " + action);
          return handler(details);
        });
      } catch (e) {
        V.log("media-session", action + " registration failed: " + ((e && e.name) || "Error"));
      }
    }
  }

  function refreshMediaSessionControls() {
    if (!("mediaSession" in navigator) || mediaSessionStopped || !V.current()) return;
    // Reconnect after playback starts or the page returns. Do not restart the audio,
    // or publish a pending track against the source that is still playing.
    if (!navigator.mediaSession.metadata && !V.loadingInProgress && !V.preparedStart) {
      updateMediaSession(V.current());
    } else {
      registerMediaSessionActions();
      updatePositionState();
    }
  }

  function updatePlaybackState() {
    // Every playback transition passes through here, making it the one place
    // the kick context reliably follows pause, cast, and network changes.
    V.syncSessionKick();
    V.watchBackgroundHold();
    if (!("mediaSession" in navigator)) return;
    try {
      const startingOnActive = V.preparedStart && V.preparedStart.el === V.audio;
      navigator.mediaSession.playbackState = mediaSessionStopped ? "none" : startingOnActive || V.isPaused() ? "paused" : "playing";
    } catch (e) {}
  }

  function clearPositionState() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    try { navigator.mediaSession.setPositionState(); } catch (e) {}
  }

  // getTime() reads both the audio element and the iframe fallback so neither backend
  // leaves the external timeline showing the previous source.
  function updatePositionState() {
    // Reconcile both values from the active backend. A background resume or source
    // handoff can leave the external Play button stale after the initial play event.
    updatePlaybackState();
    V.logAudioDuration();
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (mediaSessionStopped || !V.current() || (V.preparedStart && V.preparedStart.el === V.audio) ||
        (V.backend === "audio" && (!V.audio.src || (!V.audio.isCast && V.audio.readyState < 1)))) {
      clearPositionState();
      return;
    }
    const time = V.getTime();
    const dur = Number.isFinite(time.dur) ? time.dur : 0;
    const at = Number.isFinite(time.cur) ? time.cur : 0;
    // Leaving the previous position installed lets the external clock keep advancing
    // to the old endpoint while a replacement source has no usable duration yet.
    if (!(dur > 0)) { clearPositionState(); return; }
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: V.backend === "audio" ? (V.audio.playbackRate || 1) : V.rate(),
        position: Math.max(0, Math.min(at, dur))
      });
    } catch (e) {}
  }
})();
