(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.main;
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    driveOpen: { get: () => driveOpen },
    refreshDrive: { get: () => refreshDrive },
    refreshDriveProgress: { get: () => refreshDriveProgress }
  });

  // Driving mode shares the player, the timeline and the voice request flow. Its timeline
  // is touched only inside its own band, which stops short of the large transport controls.
  let wakeLock = null;
  let wakeLockPending = false;
  let wakeLockRevision = 0;

  async function holdScreenAwake() {
    if (wakeLock || wakeLockPending || document.hidden || !driveOpen() ||
        !navigator.wakeLock || Store.settings().driveKeepAwake === false) return;
    const revision = wakeLockRevision;
    wakeLockPending = true;
    try {
      const held = await navigator.wakeLock.request("screen");
      if (revision !== wakeLockRevision || document.hidden || !driveOpen() ||
          Store.settings().driveKeepAwake === false) {
        await held.release();
        return;
      }
      wakeLock = held;
      held.addEventListener("release", () => { if (wakeLock === held) wakeLock = null; });
    } catch (e) {
      if (revision === wakeLockRevision) wakeLock = null;
    } finally {
      if (revision === wakeLockRevision) wakeLockPending = false;
    }
  }

  function releaseScreen() {
    wakeLockRevision++;
    wakeLockPending = false;
    if (!wakeLock) return;
    const held = wakeLock;
    wakeLock = null;
    try { held.release().catch(() => {}); } catch (e) {}
  }

  function driveOpen() { return !V.$("drive").hidden; }

  function refreshDrive() {
    if (!driveOpen()) return;
    const t = Player.current();
    V.$("drive-title").textContent = t ? t.title : "Nothing playing";
    V.$("drive-artist").textContent = Player.needsPlaybackGesture() ? tr("לחצו על ניגון כדי להתחיל") : t ? (t.artist || "") : "";
    const art = V.$("drive-art");
    // Keep the original cover's aspect ratio. YouTube's hqdefault variant can add
    // baked-in black bars, which become large bands in this full-height background.
    const source = t ? V.coverFor(t) : "";
    if (art.dataset.source !== source) {
      art.dataset.source = source;
      art.hidden = true;
      if (source) {
        art.onload = () => { art.hidden = false; };
        art.onerror = () => { art.hidden = true; };
        art.src = source;
      } else {
        art.onload = null;
        art.removeAttribute("src");
      }
    }
    const time = Player.getTime();
    refreshDriveProgress(time.cur, time.dur || (t && t.duration) || 0);
  }

  function refreshDriveProgress(cur, dur) {
    const progress = V.$("drive-progress");
    const pct = dur > 0 ? Math.max(0, Math.min(100, cur / dur * 100)) : 0;
    const step = String(Math.round(pct * 10) / 10);
    if (progress.dataset.step === step) return;
    progress.dataset.step = step;
    V.driveProgress.set(Number(step));
  }

  function openDrive() {
    const drive = V.$("drive");
    if (!drive.hidden) return;
    drive.hidden = false;
    drive.classList.toggle("day", Store.settings().driveLook === "day");
    refreshDrive();
    V.setPlayIcons(!Player.isPaused());
    holdScreenAwake();
  }

  function closeDrive() {
    const drive = V.$("drive");
    if (drive.hidden) return;
    if (!V.$("drive-voice-layer").hidden) Views.stopVoice();
    drive.hidden = true;
    releaseScreen();
  }

  // A request spoken from here is drawn here: a layer over the artwork with the orb and
  // one line saying what it is doing. Nothing on it needs reading closely or aiming at -
  // a tap anywhere calls the request off, and a failed one clears itself.
  window.addEventListener("aura-voice", e => {
    const request = /** @type {CustomEvent} */ (e).detail;
    const show = !!request && request.surface === "drive" && driveOpen();
    V.$("drive-voice-layer").hidden = !show;
    V.$("drive-voice").setAttribute("aria-pressed", show ? "true" : "false");
    if (!show) return;
    V.$("drive-voice-orb").setAttribute("state", request.state);
    V.$("drive-voice-status").textContent = request.status;
    V.$("drive-voice-text").textContent = request.text;
  });

  // A screen lock taken before the phone was backgrounded is dropped by the browser, and
  // is not handed back on return. Coming back to a mount with the screen dimming again is
  // exactly the moment it is wanted.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseScreen();
    else if (driveOpen()) holdScreenAwake();
  });

  V.$("drive-close").onclick = closeDrive;
  V.$("drive-play").onclick = () => Player.toggle();
  V.$("drive-voice").onclick = () => Views.startVoice("drive");
  V.$("drive-voice-layer").onclick = () => Views.stopVoice();
  V.$("drive-next").onclick = () => Player.next();
  V.$("drive-prev").onclick = () => Player.prev();
  V.$("fp-drive").onclick = () => { V.closeFullPlayer(); openDrive(); };

  // Back calls off a spoken request before it leaves driving mode.
  Views.addBackLayer({ open: () => !V.$("drive-voice-layer").hidden, close: () => Views.stopVoice() });
  // Above the full player in the stack, so Back leaves driving mode first.
  Views.addBackLayer({ open: driveOpen, close: closeDrive });

  // Back closes the full player like any other screen, instead of leaving the app with
  // it still covering everything.
  Views.addBackLayer({
    open: () => !V.fullPlayer.hidden && !V.fullPlayer.classList.contains("closing"),
    close: V.closeFullPlayer
  });
})();
