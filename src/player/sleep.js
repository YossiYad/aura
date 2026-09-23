(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    cancelSleepFade: { get: () => cancelSleepFade },
    finishSleep: { get: () => finishSleep },
    setSleepTimer: { get: () => setSleepTimer },
    sleepAfterTrack: { get: () => sleepAfterTrack },
    sleepDeadline: { get: () => sleepDeadline },
    sleepTimerState: { get: () => sleepTimerState },
    stopForSleep: { get: () => stopForSleep }
  });

  // Listening in bed: stop on a clock, or at the end of what is playing now.
  let sleepTimerId = null;
  let sleepFadeTimerId = null;
  let sleepDeadline = 0;

  function finishSleep() {
    if (sleepTimerId) clearTimeout(sleepTimerId);
    if (sleepFadeTimerId) clearTimeout(sleepFadeTimerId);
    sleepTimerId = sleepFadeTimerId = null;
    sleepDeadline = 0;
    cancelSleepFade();
    V.pausePlay();
    restoreSleepVolume();
    V.emit({ type: "sleep" });
  }
  let sleepAfterTrack = false;
  let sleepFadeFrame = 0;
  const SLEEP_FADE_MS = 12000;
  const SLEEP_FADE_STEP_MS = 100;

  function restoreSleepVolume() {
    if (V.backend === "yt" && V.yt && V.ytReady) { try { V.yt.setVolume(Math.round(V.volume * 100)); } catch (e) {} }
    else V.audio.volume = V.levelled();
  }

  function cancelSleepFade() {
    if (!sleepFadeFrame) return;
    clearTimeout(sleepFadeFrame);
    sleepFadeFrame = 0;
  }

  // A hard cut mid-song is what a sleep timer is meant to avoid feeling like - ramp the
  // volume down over the last stretch instead of stopping the instant the clock runs out.
  function startSleepFade() {
    sleepFadeTimerId = null;
    if (!sleepDeadline) return;
    V.log("sleep", "fading out before pausing");
    const startVol = V.backend === "yt" ? V.volume : V.audio.volume;
    // Timed steps, not animation frames: frames do not run for a hidden document, and
    // the screen is off for most of what a sleep timer is used for.
    const steps = Math.max(1, Math.round(SLEEP_FADE_MS / SLEEP_FADE_STEP_MS));
    let taken = 0;
    const step = () => {
      taken++;
      const p = Math.min(1, taken / steps);
      const v = startVol * (1 - p);
      if (V.backend === "yt" && V.yt && V.ytReady) { try { V.yt.setVolume(Math.round(v * 100)); } catch (e) {} }
      else V.audio.volume = v;
      if (p < 1) { sleepFadeFrame = setTimeout(step, SLEEP_FADE_STEP_MS); return; }
      sleepFadeFrame = 0;
      finishSleep();
    };
    sleepFadeFrame = setTimeout(step, SLEEP_FADE_STEP_MS);
  }

  /**
   * @param {string | number} value Minutes, "track" for the end of this track, or "off".
   */
  function setSleepTimer(value) {
    const wasAfterTrack = sleepAfterTrack;
    if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
    if (sleepFadeTimerId) { clearTimeout(sleepFadeTimerId); sleepFadeTimerId = null; }
    sleepDeadline = 0;
    cancelSleepFade();
    restoreSleepVolume();
    sleepAfterTrack = false;
    if (value === "track") {
      sleepAfterTrack = true;
      if (V.audio.isCast) CastPlayback.setNext(null);
      V.log("sleep", "will stop at the end of this track");
      V.emit({ type: "sleep" });
      return;
    }
    // End-of-track sleep removes the receiver's upcoming items. Cancelling it must
    // put the prepared queue back before a locked phone stops sending updates.
    if (wasAfterTrack && V.audio.isCast) {
      if (V.prepValid()) V.keepPreparedSource(V.xfadePrep);
      else V.prefetchNext();
    }
    const mins = parseInt(String(value), 10);
    if (!(mins > 0)) { V.log("sleep", "timer cleared"); V.emit({ type: "sleep" }); return; }
    const ms = mins * 60000;
    sleepDeadline = Date.now() + ms;
    sleepTimerId = setTimeout(finishSleep, ms);
    sleepFadeTimerId = setTimeout(startSleepFade, Math.max(0, ms - SLEEP_FADE_MS));
    V.log("sleep", "pausing in " + mins + " minutes");
    V.emit({ type: "sleep" });
  }

  function stopForSleep() {
    sleepAfterTrack = false;
    V.log("sleep", "end of track reached, stopping");
    V.pausePlay();
    V.emit({ type: "sleep" });
  }

  /**
   * @returns {"track" | "on" | "off"}
   */
  function sleepTimerState() {
    if (sleepAfterTrack) return "track";
    return sleepTimerId || sleepFadeFrame ? "on" : "off";
  }
})();
