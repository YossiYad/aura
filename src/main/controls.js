(function () {
  const V = window.Aura.main;

  V.bindSingleTap("fp-close", V.closeFullPlayer);
  V.$("fp-play").onclick = () => Player.toggle();
  V.$("fp-next").onclick = () => Player.next();
  V.$("fp-prev").onclick = () => Player.prev();
  V.$("fp-shuffle").onclick = () => { Player.setShuffle(!Player.shuffle()); V.refreshBar(); };
  V.$("fp-repeat").onclick = () => { Player.cycleRepeat(); V.refreshBar(); };
  V.$("fp-like").onclick = () => { const t = Player.current(); if (t) Views.openPlaylistPicker(t); };
  V.bindSingleTap("fp-more", () => { const t = Player.current(); if (t) Views.openTrackMenu(t, ""); });
  V.$("fp-queue").onclick = () => { V.$("fullplayer").hidden = true; Views.openQueueSheet(); };
  V.$("fp-timer").onclick = () => Views.openSleepTimerSheet();
  V.$("fp-speed").onclick = () => Views.openSpeedSheet();
  // The label otherwise sat at the markup's "1x" until something played, which on a fresh
  // open is exactly when a listener who set 1.5x yesterday goes looking for it.
  V.syncSpeedButton();
  V.$("fp-about-open").onclick = () => Views.openCurrentArtist();
  // lrclib times against the official release while this plays a YouTube upload that often
  // carries an intro or a different edit, so the words run early or late with no recourse.
  // Added from script so the markup file stays untouched.
  (function addLyricsOffsetControls() {
    const head = document.querySelector(".lyrics-head");
    const expand = V.$("lyrics-expand");
    if (!head || !expand || V.$("lyrics-earlier")) return;
    const make = (id, label, step) => {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = label;
      b.title = "Shift lyrics by " + step + "s";
      b.onclick = () => {
        V.lyricsOffset = Math.round((V.lyricsOffset + step) * 10) / 10;
        V.syncLyrics(Player.getTime().cur);
        Views.toast(V.lyricsOffset === 0 ? "Lyrics timing reset"
          : "Lyrics " + (V.lyricsOffset > 0 ? "+" : "") + V.lyricsOffset + "s");
      };
      return b;
    };
    head.insertBefore(make("lyrics-earlier", "-1s", -1), expand);
    head.insertBefore(make("lyrics-later", "+1s", 1), expand);
  })();

  V.$("lyrics-expand").onclick = () => {
    const card = V.$("lyrics-card");
    card.classList.toggle("expanded");
    V.$("lyrics-expand").textContent = card.classList.contains("expanded") ? "Collapse" : "Expand";
  };
  V.$("lyrics-lines").onclick = e => {
    const line = e.target.closest("[data-lyric]");
    if (!line) return;
    const item = V.lyricsLines[parseInt(line.dataset.lyric, 10)];
    if (item && item.at != null) Player.seekTo(Math.max(0, item.at - V.lyricsOffset));
  };
  V.$("fp-autoplay").onchange = e => Store.patchSettings({ autoplay: e.target.checked });
  V.$("fp-volume").oninput = e => Player.setVolume(e.target.value / 100);

  V.fullPlayer.addEventListener("touchstart", e => {
    if (V.fullPlayer.hidden || V.fullPlayer.scrollTop > 0 || e.touches.length !== 1) return;
    if (e.target.closest("button, input, label, a, .lyrics-lines, .song-progress")) return;
    const touch = e.touches[0];
    V.fpDragStartX = touch.clientX;
    V.fpDragStartY = touch.clientY;
    V.fpDragStartAt = performance.now();
    V.fpDragY = 0;
    V.fpDragEligible = true;
    V.fpDragging = false;
  }, { passive: true });

  V.fullPlayer.addEventListener("touchmove", e => {
    if (!V.fpDragEligible || e.touches.length !== 1) return;
    if (V.fullPlayer.scrollTop > 0) { V.resetFullPlayerDrag(); return; }
    const touch = e.touches[0];
    const dx = touch.clientX - V.fpDragStartX;
    const dy = touch.clientY - V.fpDragStartY;
    if (!V.fpDragging) {
      if (dy <= 6) return;
      if (Math.abs(dx) > dy) { V.resetFullPlayerDrag(); return; }
      V.fpDragging = true;
      V.fullPlayer.classList.add("dragging");
    }
    V.fpDragY = Math.max(0, dy);
    if (!V.fpDragFrame) {
      V.fpDragFrame = requestAnimationFrame(() => {
        V.fpDragFrame = 0;
        V.fullPlayer.style.transform = "translate3d(0," + V.fpDragY + "px,0)";
      });
    }
    e.preventDefault();
  }, { passive: false });

  V.fullPlayer.addEventListener("touchend", () => {
    if (!V.fpDragEligible) return;
    const elapsed = Math.max(1, performance.now() - V.fpDragStartAt);
    const fastSwipe = V.fpDragY / elapsed > 0.65 && V.fpDragY > 54;
    const crossedThreshold = V.fpDragY > Math.min(150, window.innerHeight * 0.18);
    V.fpDragEligible = false;
    if (V.fpDragging && (fastSwipe || crossedThreshold)) {
      V.dismissFullPlayerBySwipe();
      return;
    }
    V.fpDragging = false;
    V.fpDragY = 0;
    if (V.fpDragFrame) cancelAnimationFrame(V.fpDragFrame);
    V.fpDragFrame = 0;
    V.fullPlayer.classList.remove("dragging");
    V.fullPlayer.classList.add("drag-resetting");
    V.fullPlayer.style.removeProperty("transform");
    setTimeout(() => V.fullPlayer.classList.remove("drag-resetting"), 260);
  }, { passive: true });

  V.fullPlayer.addEventListener("touchcancel", V.resetFullPlayerDrag, { passive: true });

  document.addEventListener("keydown", /** @param {KeyboardEvent & { target: HTMLElement }} e */ e => {
    // Space is play/pause everywhere except where the listener is typing - which now
    // includes a heading being renamed in place, where it used to eat the space - and
    // except on a focused control: there the key belongs to the control (Space activates
    // a button), and swallowing it made Space on "Next" toggle playback instead.
    if (e.target.closest && e.target.closest("input, textarea, select, button, a, summary, [role='button']")) return;
    if (e.target.isContentEditable) return;
    if (e.code === "Space") { e.preventDefault(); Player.toggle(); }
    else if (e.key === "ArrowRight" && e.shiftKey) Player.next();
    else if (e.key === "ArrowLeft" && e.shiftKey) Player.prev();
  });

  document.addEventListener("visibilitychange", () => {
    V.syncProgressLoop();
    if (!document.hidden) Views.refreshIfStale();
  });

  document.addEventListener("gesturestart", e => e.preventDefault());
  document.addEventListener("gesturechange", e => e.preventDefault());
  document.addEventListener("dblclick", e => e.preventDefault());
})();
