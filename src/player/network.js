(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    resumeAfterNetworkPause: { get: () => resumeAfterNetworkPause },
    stopNetworkResumeWatch: { get: () => stopNetworkResumeWatch }
  });

  // Losing the signal is not the same as running out of audio. What is already buffered
  // plays fine with no network at all, so a lift, a tunnel or a dead spot that lasts a few
  // seconds should not stop the music - the pause waits until the buffer is nearly spent.
  function bufferedAhead() {
    const at = V.audio.currentTime || 0;
    const ranges = V.audio.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (at < ranges.start(i) - 0.1 || at > ranges.end(i)) continue;
      // Buffered to the end is not a buffer running out. The last second of a fully
      // loaded song read as one, so it was paused just short of ending and the saved
      // song after it never started.
      if (V.audio.duration > 0 && ranges.end(i) >= V.audio.duration - 0.5) return Infinity;
      return ranges.end(i) - at;
    }
    return 0;
  }

  let bufferWatch = null;
  const NETWORK_RESUME_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
  let networkResumeTimer = null;
  let networkResumeStep = 0;

  function stopBufferWatch() {
    if (bufferWatch) { clearInterval(bufferWatch); bufferWatch = null; }
  }

  function stopNetworkResumeWatch() {
    if (networkResumeTimer) { clearTimeout(networkResumeTimer); networkResumeTimer = null; }
    networkResumeStep = 0;
  }

  function scheduleNetworkResume(reason) {
    if (networkResumeTimer || !V.pausedByNetwork || !V.wantsPlayback) return;
    const delay = NETWORK_RESUME_DELAYS[Math.min(networkResumeStep, NETWORK_RESUME_DELAYS.length - 1)];
    networkResumeStep++;
    networkResumeTimer = setTimeout(() => {
      networkResumeTimer = null;
      if (!V.pausedByNetwork || !V.wantsPlayback) { stopNetworkResumeWatch(); return; }
      if (navigator.onLine === false || V.audioSessionInterrupted || V.platformPaused) {
        scheduleNetworkResume(reason);
        return;
      }
      resumeAfterNetworkPause(reason);
    }, delay);
  }

  function pauseForNetwork(reason) {
    if (V.audio.isCast) return;
    stopBufferWatch();
    if (V.backend !== "audio" || !V.wantsPlayback || V.audio.paused) return;
    if (/^(?:blob:|data:)/i.test(V.audio.src)) return;
    V.log("network", "offline, pausing (" + reason + ")");
    stopNetworkResumeWatch();
    V.pausedByNetwork = true;
    V.audio.pause();
    V.updatePlaybackState();
  }

  window.addEventListener("offline", () => {
    if (V.audio.isCast) return;
    if (V.backend !== "audio" || !V.wantsPlayback || V.audio.paused) return;
    if (/^(?:blob:|data:)/i.test(V.audio.src)) return;
    if (bufferedAhead() <= 1) return pauseForNetwork("nothing buffered");
    V.log("network", "offline with " + (bufferedAhead() === Infinity ? "the rest of the song" : Math.round(bufferedAhead()) + "s") + " buffered, playing on");
    stopBufferWatch();
    bufferWatch = setInterval(() => {
      if (navigator.onLine) { stopBufferWatch(); return; }
      if (V.backend !== "audio" || V.audio.paused) { stopBufferWatch(); return; }
      if (bufferedAhead() <= 1) pauseForNetwork("buffer ran out");
    }, 500);
  });

  function resumeAfterNetworkPause(reason) {
    if (!V.pausedByNetwork || navigator.onLine === false || V.audioFocusInterrupted() || V.platformPaused) return false;
    if (V.backend !== "audio" || !V.wantsPlayback || !V.audio.src || V.audio.ended) {
      V.pausedByNetwork = false;
      stopNetworkResumeWatch();
      return false;
    }
    V.pausedByNetwork = false;
    V.log("network", "back online, resuming (" + reason + ")");
    V.audio.play().then(() => {
      stopNetworkResumeWatch();
      V.updatePlaybackState();
    }).catch(e => {
      V.pausedByNetwork = true;
      V.log("network", "resume blocked: " + String((e && e.message) || e).slice(0, 60));
      scheduleNetworkResume(reason);
    });
    return true;
  }

  window.addEventListener("online", () => {
    V.unreadableOffline.clear();
    stopBufferWatch();
    const resumedPlatformPause = V.resumeYtPlatformPause("network restored") ||
      V.resumePlatformPause("network restored");
    if (resumedPlatformPause) return;
    V.retrySourceNow("network restored", true);
    if (!V.pausedByNetwork) return;
    if (!resumeAfterNetworkPause("network restored")) {
      V.log("network", "back online, waiting for audio focus");
      scheduleNetworkResume("network restored");
    }
  });
})();
