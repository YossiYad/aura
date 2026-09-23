(function () {
  const V = window.Aura.main;
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    bindSingleTap: { get: () => bindSingleTap },
    closeFullPlayer: { get: () => closeFullPlayer },
    dismissFullPlayerBySwipe: { get: () => dismissFullPlayerBySwipe },
    fpDragEligible: { get: () => fpDragEligible, set: value => { fpDragEligible = value; } },
    fpDragFrame: { get: () => fpDragFrame, set: value => { fpDragFrame = value; } },
    fpDragging: { get: () => fpDragging, set: value => { fpDragging = value; } },
    fpDragStartAt: { get: () => fpDragStartAt, set: value => { fpDragStartAt = value; } },
    fpDragStartX: { get: () => fpDragStartX, set: value => { fpDragStartX = value; } },
    fpDragStartY: { get: () => fpDragStartY, set: value => { fpDragStartY = value; } },
    fpDragY: { get: () => fpDragY, set: value => { fpDragY = value; } },
    fullPlayer: { get: () => fullPlayer },
    resetFullPlayerDrag: { get: () => resetFullPlayerDrag }
  });

  const fullPlayer = V.$("fullplayer");
  let fpDragStartX = 0;
  let fpDragStartY = 0;
  let fpDragStartAt = 0;
  let fpDragY = 0;
  let fpDragEligible = false;
  let fpDragging = false;
  let fpDragFrame = 0;
  let fpCloseTimer = null;

  function resetFullPlayerDrag() {
    if (fpDragFrame) cancelAnimationFrame(fpDragFrame);
    fpDragFrame = 0;
    fpDragEligible = false;
    fpDragging = false;
    fpDragY = 0;
    fullPlayer.classList.remove("dragging", "drag-resetting", "swipe-closing");
    fullPlayer.style.removeProperty("transform");
  }

  function openFullPlayer() {
    if (fpCloseTimer) clearTimeout(fpCloseTimer);
    resetFullPlayerDrag();
    fullPlayer.classList.remove("closing");
    fullPlayer.scrollTop = 0;
    fullPlayer.hidden = false;
    V.refreshBar();
    V.refreshTime(true);
  }

  // The collapsed bar is dragged up into the full player and back down out of it; sideways
  // is the third direction, and it means "done for now". A horizontal flick throws the bar
  // off screen and stops the sound with it, the way the notification card is swiped away.
  // Nothing is remembered - playing anything again brings the bar back to be minimised.
  const playerBar = V.$("playerbar");
  let barStartX = 0;
  let barStartY = 0;
  let barStartAt = 0;
  let barDX = 0;
  let barSwipeEligible = false;
  let barSwiping = false;
  let barSwipeFrame = 0;
  let barSwipedAt = 0;

  function resetBarSwipe() {
    if (barSwipeFrame) cancelAnimationFrame(barSwipeFrame);
    barSwipeFrame = 0;
    barSwipeEligible = false;
    barSwiping = false;
    barDX = 0;
    playerBar.classList.remove("swiping", "swipe-resetting", "swipe-away");
    playerBar.style.removeProperty("transform");
    playerBar.style.removeProperty("opacity");
  }

  function dismissBarBySwipe(dx) {
    const width = playerBar.offsetWidth || window.innerWidth || 320;
    playerBar.classList.remove("swiping");
    playerBar.classList.add("swipe-away");
    playerBar.style.transform = "translate3d(" + (dx < 0 ? -width : width) + "px,0,0)";
    playerBar.style.opacity = "0";
    setTimeout(() => {
      resetBarSwipe();
      Player.dismiss();
    }, 220);
  }

  playerBar.addEventListener("touchstart", e => {
    if (playerBar.hidden || e.touches.length !== 1) return;
    // The scrubber and the controls answer a touch themselves; only the bar's own body
    // starts a swipe, so a finger on Play cannot end the session by sliding off it.
    if (e.target.closest("button, input, #pb-progress")) return;
    resetBarSwipe();
    const touch = e.touches[0];
    barStartX = touch.clientX;
    barStartY = touch.clientY;
    barStartAt = performance.now();
    barSwipeEligible = true;
  }, { passive: true });

  playerBar.addEventListener("touchmove", e => {
    if (!barSwipeEligible || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - barStartX;
    const dy = touch.clientY - barStartY;
    if (!barSwiping) {
      if (Math.abs(dx) < 8) return;
      // A finger going up or down is reaching for the full player, not for this.
      if (Math.abs(dy) >= Math.abs(dx)) { resetBarSwipe(); return; }
      barSwiping = true;
      playerBar.classList.add("swiping");
    }
    barDX = dx;
    if (!barSwipeFrame) {
      barSwipeFrame = requestAnimationFrame(() => {
        barSwipeFrame = 0;
        const width = playerBar.offsetWidth || window.innerWidth || 320;
        playerBar.style.transform = "translate3d(" + barDX + "px,0,0)";
        playerBar.style.opacity = String(Math.max(0.3, 1 - Math.abs(barDX) / width));
      });
    }
    e.preventDefault();
  }, { passive: false });

  playerBar.addEventListener("touchend", () => {
    if (!barSwipeEligible) return;
    barSwipeEligible = false;
    if (!barSwiping) return;
    // The lift still fires a click on whatever the finger started on, and on this bar that
    // would open the full player of a track just thrown away.
    barSwipedAt = Date.now();
    const dx = barDX;
    const width = playerBar.offsetWidth || window.innerWidth || 320;
    const elapsed = Math.max(1, performance.now() - barStartAt);
    const flick = Math.abs(dx) / elapsed > 0.5 && Math.abs(dx) > 40;
    const crossedThreshold = Math.abs(dx) > Math.min(140, width * 0.32);
    if (flick || crossedThreshold) { dismissBarBySwipe(dx); return; }
    barSwiping = false;
    barDX = 0;
    if (barSwipeFrame) cancelAnimationFrame(barSwipeFrame);
    barSwipeFrame = 0;
    playerBar.classList.remove("swiping");
    playerBar.classList.add("swipe-resetting");
    playerBar.style.removeProperty("transform");
    playerBar.style.removeProperty("opacity");
    setTimeout(() => playerBar.classList.remove("swipe-resetting"), 240);
  }, { passive: true });

  playerBar.addEventListener("touchcancel", resetBarSwipe, { passive: true });

  V.$("pb-now").onclick = () => {
    if (Date.now() - barSwipedAt < 400) return;
    openFullPlayer();
  };

  function closeFullPlayer() {
    if (fullPlayer.hidden || fullPlayer.classList.contains("closing")) return;
    resetFullPlayerDrag();
    fullPlayer.classList.add("closing");
    fpCloseTimer = setTimeout(() => {
      fullPlayer.hidden = true;
      fullPlayer.classList.remove("closing");
      fullPlayer.scrollTop = 0;
      fpCloseTimer = null;
      // Anything that changed while the player covered the screen is caught up on here,
      // rather than moving under the listener while they were reading it.
      Views.refreshIfStale();
    }, 240);
  }

  function dismissFullPlayerBySwipe() {
    fullPlayer.classList.remove("dragging");
    fullPlayer.classList.add("swipe-closing");
    fullPlayer.style.removeProperty("transform");
    fpCloseTimer = setTimeout(() => {
      fullPlayer.hidden = true;
      fullPlayer.scrollTop = 0;
      resetFullPlayerDrag();
      fpCloseTimer = null;
      // Same catch-up the close button does: whatever changed under the player is
      // painted now, rather than lingering stale until some unrelated event.
      Views.refreshIfStale();
    }, 240);
  }

  function bindSingleTap(id, action) {
    const el = V.$(id);
    let lastTouch = 0;
    el.addEventListener("touchend", e => {
      lastTouch = Date.now();
      e.preventDefault();
      action(e);
    }, { passive: false });
    el.addEventListener("click", e => {
      if (Date.now() - lastTouch < 500) return;
      action(e);
    });
  }
})();
