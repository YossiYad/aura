(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.main;

  let errorStreak = 0;
  let ytFallbackWarned = false;
  // Time of the last outage notice, not a one-shot flag: an outage stops playback, so no
  // track change ever comes along to reset a flag - and a retry minutes later then failed
  // with nothing at all on screen. Re-notify, but no more often than this.
  const OUTAGE_RENOTIFY_MS = 15000;
  let lastOutageAt = 0;
  let handledFailureKey = null;
  let failureLimitShown = false;

  function handlePlaybackFailure(ev, message, limitMessage) {
    const track = ev.track || Player.current();
    if (!track) return;
    const key = track.id + ":" + Player.pos();
    if (handledFailureKey === key) return;
    handledFailureKey = key;
    errorStreak++;
    if (errorStreak > Math.min(Player.queue().length, 5)) {
      if (!failureLimitShown) Views.toast(limitMessage, "err");
      failureLimitShown = true;
      return;
    }
    Views.toast(ev.willSkip ? message : limitMessage, "err");
  }

  Player.onChange(ev => {
    if (ev.type === "remote") V.syncSpeedButton();
    if (ev.type === "remote-ready") Views.toast("Ready for TV playback. Tap Connect to TV in the three-dot menu again to choose your TV.");
    if (ev.type === "remote-error") { V.refreshBar(); Views.toast(ev.message, "err"); }
    if (ev.type === "track") {
      errorStreak = 0;
      handledFailureKey = null;
      failureLimitShown = false;
      lastOutageAt = 0;
    }
    // A track change is not a reason to rebuild the screen. Repainting threw away every
    // decoded image - the black flash - and recomputed the home rows, so what was on
    // screen quietly became different songs. Only the current-row marker actually moves.
    if (ev.type === "track") { V.refreshBar(); V.refreshTime(true); Views.markNowPlaying(); }
    if (ev.type === "restored") { V.refreshBar(); Views.render(); }
    if (ev.type === "queue") V.refreshBar();
    if (ev.type === "sleep") V.refreshBar();
    if (ev.type === "rate") V.syncSpeedButton();
    if (ev.type === "loading") { V.refreshBar(); V.setPlayIcons(true); }
    // The bar reads the real state: a load that was cancelled, held or failed used to
    // leave "Loading…" up until some unrelated store change repainted it.
    if (ev.type === "state") { V.setPlayIcons(!Player.isPaused()); V.syncProgressLoop(); V.refreshBar(); }
    if (ev.type === "time") {
      if (Player.isPaused()) V.refreshTime(true);
      else if (!V.progressFrame) V.progressFrame = requestAnimationFrame(V.progressTick);
    }
    if (ev.type === "fallback-yt" && !ytFallbackWarned) {
      ytFallbackWarned = true;
      Views.toast("Ad-free servers are down right now - playing via YouTube (may show ads, won't play in background)", "err");
    }
    if (ev.type === "source-outage") {
      // One message per outage, and the queue stays where it is - skipping would just
      // fail again. A retry after a quiet spell gets the message again instead of a dead
      // tap with nothing on screen.
      if (!lastOutageAt || Date.now() - lastOutageAt > OUTAGE_RENOTIFY_MS) {
        Views.toast("The streaming servers are not answering right now - stopped here so you keep your place", "err");
      }
      lastOutageAt = Date.now();
      return;
    }
    if (ev.type === "offline-skip") {
      Views.toast('You\'re offline and "' + ev.track.title + '" isn\'t saved on this device - playing the next saved song');
      return;
    }
    if (ev.type === "offline-unavailable") {
      if (!lastOutageAt || Date.now() - lastOutageAt > OUTAGE_RENOTIFY_MS) {
        Views.toast('You\'re offline and "' + ev.track.title + '" isn\'t saved on this device', "err");
      }
      lastOutageAt = Date.now();
      return;
    }
    if (ev.type === "playback-permission") {
      V.refreshBar();
      Views.toast(tr("הדפדפן דורש לחיצה על ניגון. השיר שביקשת נשמר ומוכן להפעלה."), "err");
      return;
    }
    if (ev.type === "fallback-skip") {
      handlePlaybackFailure(
        ev,
        'No ad-free stream for "' + ev.track.title + '" - skipping',
        "No ad-free stream available right now - try later or turn off the YouTube-skip setting"
      );
    }
    if (ev.type === "error") {
      handlePlaybackFailure(
        ev,
        'Could not play "' + ev.track.title + '" - skipping',
        "Playback keeps failing - check your connection and Show logs"
      );
    }
  });
  Store.onChange(() => V.refreshBar());
  function applyStaticLanguage() {
    V.$("drive-voice").setAttribute("aria-label", tr("בקשה קולית עם Aura AI"));
    // The spoken-request status reads right to left only when the interface is Hebrew.
    V.$("drive-voice-layer").dir = window.I18n ? I18n.direction() : "rtl";
  }
  function applyInterfaceLanguage() {
    applyStaticLanguage();
    V.refreshBar();
    V.refreshDrive();
  }
  window.addEventListener("aura-language", applyInterfaceLanguage);
  // Static accessibility labels need the saved preference before the first interaction.
  applyStaticLanguage();

  V.$("pb-play").onclick = e => { e.stopPropagation(); Player.toggle(); };
  V.$("pb-next").onclick = e => { e.stopPropagation(); Player.next(); };
  V.$("pb-prev").onclick = e => { e.stopPropagation(); Player.prev(); };
  V.$("pb-shuffle").onclick = e => { e.stopPropagation(); Player.setShuffle(!Player.shuffle()); V.refreshBar(); };
  V.$("pb-queue").onclick = e => { e.stopPropagation(); Views.openQueueSheet(); };
  V.$("pb-like").onclick = e => {
    e.stopPropagation();
    const t = Player.current();
    if (t) Views.openPlaylistPicker(t);
  };
})();
