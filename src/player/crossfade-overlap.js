(function () {
  const V = window.Aura.player;
  // The handoff between songs on a locked Android phone: which element takes the next song, how early it starts, and what a start the browser refused becomes.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    handoffOnActive: { get: () => handoffOnActive },
    hiddenHandoffLead: { get: () => hiddenHandoffLead },
    holdRefusedHandoff: { get: () => holdRefusedHandoff }
  });

  // Chrome on Android plays in the background on the strength of its media notification:
  // the notification holds the foreground service that keeps the page running, on the
  // network and entitled to audio focus. Chrome keeps the notification exactly as long as
  // the page has a playing element. Its MediaSessionImpl goes inactive when the last
  // player leaves - a source swap destroys the player, a finished one is removed - and
  // with the phone locked MediaSessionHelper then hides the notification at once, without
  // the half second an unlocked phone is given. Android does not hand the service back to
  // a page in the background (no foreground-service start since 12, no audio focus
  // without one since 15), so the next song is paused as it starts, or plays on in a page
  // whose every request fails, until the app is opened. A Galaxy log showed it at four of
  // ten locked transitions (2026-10-05): "playback suspended by the browser or operating
  // system" a moment after "started on active audio element".
  // So on Android a hidden handoff does what a visible one does: the standby element,
  // already holding the next song, starts while the current one still plays, and the
  // session never counts zero players. iOS keeps its permitted element, and the other
  // engines keep the restart on the active element, which costs them nothing.
  const isAndroid = /Android/i.test(navigator.userAgent || "");

  function overlapsHiddenHandoff() {
    return isAndroid && !V.isIOS && !V.remotePlaybackActive();
  }

  function handoffOnActive() {
    if (V.isIOS || V.remotePlaybackActive()) return true;
    return document.hidden && !overlapsHiddenHandoff();
  }

  // How long before the end a hidden page starts the next song. The handoff rides on the
  // current song's timeupdate, and a hidden page is not promised more than one of those a
  // second. Where the overlap is what keeps the session alive, the window has to be wider
  // than that gap; elsewhere a miss only means the ended event does the same job.
  function hiddenHandoffLead() {
    return overlapsHiddenHandoff() ? 1.5 : 0.75;
  }

  // The standby paused under a start nobody here cancelled, with nothing wrong with the
  // file: the browser was refused the audio, which happens when the current song ended
  // before the handoff could overlap it. That is an interruption, not a bad source.
  // Treated as a failure it threw the song away and asked the network for the one after,
  // from a page the network no longer answers. The queue moves to the song instead and
  // holds it the way any platform pause is held, to start when the app is opened.
  function holdRefusedHandoff(attempt, error) {
    const target = attempt.el;
    const prep = attempt.prep;
    if (!overlapsHiddenHandoff() || !document.hidden || target === V.audio || !target.paused || target.error ||
        V.mediaWasRejected(error, target)) return false;
    V.preparedStart = null;
    clearTimeout(attempt.timer);
    V.log("background", prep.id + " handoff refused by the browser (" +
      String((error && (error.name || error.message)) || error).slice(0, 40) + "); held until the app is opened");
    V.commitTo(target, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
    V.platformPaused = true;
    V.platformPausedAt = Date.now();
    V.focusResumePending = true;
    V.focusResumeConfirmed = false;
    V.watchBackgroundHold();
    V.updatePlaybackState();
    V.emit({ type: "state" });
    return true;
  }
})();
