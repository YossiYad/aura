(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.main;
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    coverFor: { get: () => coverFor },
    driveProgress: { get: () => driveProgress },
    progressFrame: { get: () => progressFrame, set: value => { progressFrame = value; } },
    progressTick: { get: () => progressTick },
    refreshBar: { get: () => refreshBar },
    refreshTime: { get: () => refreshTime },
    syncProgressLoop: { get: () => syncProgressLoop },
    syncSpeedButton: { get: () => syncSpeedButton }
  });

  // The cover kept with a download, when there is one. The lists already drew it; the
  // player asked the network regardless, so a saved song played offline under a blank square.
  function coverFor(track) {
    return window.Views && Views.artSrc ? Views.artSrc(track) : track.thumb || Api.thumbFor(track.id);
  }
  window.addEventListener("aura-local-art", () => { V.accentId = null; refreshBar(); });

  // The mini player floats over the list rather than taking a row of its own, so the page
  // shows around its rounded edges instead of a black strip. The list runs under it by the
  // bar's full height (margins too) and gets the same room at its end to scroll past it.
  (function trackBarHeight() {
    const bar = V.$("playerbar");
    const app = bar.parentElement;
    const apply = () => {
      const style = getComputedStyle(bar);
      const h = bar.hidden ? 0 : bar.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      app.style.setProperty("--player-overlap", Math.round(h) + "px");
    };
    apply();
    if (window.ResizeObserver) new ResizeObserver(apply).observe(bar);
  })();

  function refreshBar() {
    const t = Player.current();
    const bar = V.$("playerbar");
    if (!t) { bar.hidden = true; V.refreshDrive(); return; }
    bar.hidden = false;
    V.$("pb-title").textContent = t.title;
    V.$("pb-artist").textContent = Player.needsPlaybackGesture() ? tr("לחצו על ניגון כדי להתחיל") : Player.isLoading() ? "Loading…" : t.artist || "";
    const art = V.$("pb-art");
    let img = art.querySelector("img");
    if (!img) { img = document.createElement("img"); img.alt = ""; art.prepend(img); }
    img.src = coverFor(t);
    const q = Player.queue().length;
    V.$("pb-qcount").hidden = q < 2;
    V.$("pb-qcount").textContent = q;
    V.$("pb-shuffle").classList.toggle("on", Player.shuffle());
    V.$("fp-shuffle").classList.toggle("on", Player.shuffle());
    V.$("fp-timer").classList.toggle("on", Player.sleepTimerState() !== "off");
    syncSpeedButton();
    const rep = Player.repeat();
    V.$("fp-repeat").classList.toggle("on", rep !== "off");
    V.$("fp-rep-one").hidden = rep !== "one";
    V.$("fp-title").textContent = t.title;
    V.$("fp-artist").textContent = Player.needsPlaybackGesture() ? tr("לחצו על ניגון כדי להתחיל") : t.artist || "";
    document.querySelector(".fp-eyebrow").textContent = t.album || t.artist || "Now playing";
    V.$("fp-art").style.backgroundImage = "url('" + coverFor(t).replace("mqdefault", "hqdefault") + "')";
    const saved = Store.isLiked(t.id) || Store.playlists().some(p => p.ids.includes(t.id));
    V.$("fp-like").classList.toggle("on", saved);
    V.$("pb-like").classList.toggle("on", saved);
    const sharing = !!(Player.shareSession && Player.shareSession());
    V.$("fp-autoplay").checked = sharing || !!Store.settings().autoplay;
    for (const id of ["fp-autoplay", "pb-shuffle", "fp-shuffle", "fp-repeat"]) {
      V.$(id).disabled = sharing;
      V.$(id).title = sharing ? tr("AuraShare מנגן לפי התור ומשלים שיר אחד כשצריך") : "";
    }
    V.$("fp-about-name").textContent = t.artist || "Unknown artist";
    V.$("fp-credit-name").textContent = t.artist || "Unknown artist";
    V.$("fp-about-cover").style.backgroundImage = "url('" + (t.artistThumb || t.thumb || Api.thumbFor(t.id)).replace("mqdefault", "hqdefault") + "')";
    V.applyFpAccent(t);
    V.loadLyrics(t);
    V.refreshDrive();
    V.$("fp-drive").hidden = Store.settings().driveMode === false;
  }

  // The speed only earns the accent when it is not 1x - otherwise every player would open
  // with a lit control saying "normal".
  function syncSpeedButton() {
    const r = Player.rate();
    const label = V.$("fp-speed-label");
    if (label) label.textContent = String(r) + "x";
    V.$("fp-speed").classList.toggle("on", r !== 1);
  }

  let progressFrame = 0;
  let lastClockSecond = -1;
  let lastDurationSecond = -1;
  // This runs on every animation frame for as long as something is playing, so the element
  // lookups are done once and every write is guarded. A bar is a few hundred pixels wide:
  // below a tenth of a percent nothing on screen can change, and the guard turns most
  // frames into no work at all rather than a fresh style pass on four elements.
  let barEls = null;
  let lastBarStep = -1;
  let lastSeekStep = -1;

  function progressEls() {
    if (barEls && barEls.full.isConnected) return barEls;
    barEls = { cur: V.$("fp-cur"), dur: V.$("fp-dur"), full: V.$("fullplayer") };
    lastBarStep = -1;
    lastSeekStep = -1;
    return barEls;
  }

  // One timeline per place a song shows its position. Each is released at a share of the
  // track, so the three differ only in where they sit and who may touch them.
  function seekToShare(pct) {
    const dur = Player.getTime().dur;
    if (dur) Player.seekTo(pct / 100 * dur);
    refreshTime(true);
  }
  // An arrow key moves five seconds, whatever the length of the track.
  function seekKeyStep() {
    const dur = Player.getTime().dur;
    return dur ? Math.min(10, 500 / dur) : 1;
  }
  // The collapsed bar's wave runs along the edge people tap to open the player, so a
  // finger only reads it. A mouse, which can aim at it, still seeks as it always could.
  const barProgress = SongProgress.create(V.$("pb-progress"), { touch: false, onSeek: seekToShare, keyStep: seekKeyStep });
  const fullProgress = SongProgress.create(V.$("fp-progress"), {
    onSeek: seekToShare,
    keyStep: seekKeyStep,
    // The clock follows the finger, so a scrub is aimed at a time and not at a guess.
    onPreview: pct => {
      const dur = Player.getTime().dur;
      if (pct !== null && dur) V.$("fp-cur").textContent = V.fmt(pct / 100 * dur);
      else refreshTime(true);
    }
  });
  const driveProgress = SongProgress.create(V.$("drive-progress"), { onSeek: seekToShare, keyStep: seekKeyStep });

  function refreshTime(forceDetails) {
    if (forceDetails) V.setPlayIcons(!Player.isPaused());
    const time = Player.getTime();
    const dur = time.dur || (Player.current() || {}).duration || 0;
    const cur = time.cur;
    const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
    const els = progressEls();
    const step = Math.round(pct * 10);
    if (forceDetails || step !== lastBarStep) {
      lastBarStep = step;
      barProgress.set(step / 10);
    }
    if (V.driveOpen()) V.refreshDriveProgress(cur, dur);
    // The scrubber and the clock live inside the full player. While it is closed they are
    // in a display:none subtree - writing to them all the way through a song only spends
    // work on something nobody can see.
    const fullOpen = !els.full.hidden;
    if (fullOpen) {
      const seekStep = dur ? Math.round((cur / dur) * 1000) : 0;
      if (forceDetails || seekStep !== lastSeekStep) {
        lastSeekStep = seekStep;
        fullProgress.set(seekStep / 10);
      }
    }
    const clockSecond = Math.floor(cur);
    const durationSecond = Math.floor(dur);
    // The seconds are only remembered once they have actually been written, so opening the
    // player always finds them stale and repaints, however it was opened.
    if (fullOpen && (forceDetails || clockSecond !== lastClockSecond || durationSecond !== lastDurationSecond)) {
      lastClockSecond = clockSecond;
      lastDurationSecond = durationSecond;
      if (!fullProgress.scrubbing()) els.cur.textContent = V.fmt(cur);
      els.dur.textContent = V.fmt(dur);
      V.syncLyrics(cur);
    }
  }

  function progressTick() {
    progressFrame = 0;
    refreshTime(false);
    if (!Player.isPaused() && !document.hidden) progressFrame = requestAnimationFrame(progressTick);
  }

  function syncProgressLoop() {
    if (!Player.isPaused() && !document.hidden) {
      if (!progressFrame) progressFrame = requestAnimationFrame(progressTick);
    } else {
      if (progressFrame) cancelAnimationFrame(progressFrame);
      progressFrame = 0;
      refreshTime(true);
    }
  }
})();
