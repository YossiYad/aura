(function () {
  const V = window.Aura.views;

  // ---------------- Swipe actions on search rows ----------------
  //
  // A search hit is usually answered with "yes, but not right now", and saying that cost a
  // hold, a sheet and a tap. Dragging the row says it directly: right hands the song to the
  // queue, left keeps it. Each side carries a second, deeper answer, so the less common one
  // costs a longer pull rather than a different gesture.
  const SWIPE_ROWS = "#yt-results .dr[data-id], #lib-hits .song[data-id]";
  const SWIPE_ARM = 0.2;      // share of the row's width that arms the first action
  const SWIPE_ARM_FAR = 0.5;  // and the second
  const SWIPE_MAX = 0.68;     // as far as the row travels, however hard it is pulled
  const SWIPE_LOCK = 10;      // px of sideways travel before the gesture is ours

  function swipeActionsFor(track, dir) {
    if (dir > 0) return [
      { id: "playnext", label: "Play next", icon: V.IC.next, bg: "var(--accent)", fg: "var(--accent-on)" },
      { id: "addqueue", label: "Add to queue", icon: V.IC.queue, bg: "#2f6dd8", fg: "#ffffff" }
    ];
    return [
      { id: "like", label: Store.isLiked(track.id) ? "Remove from Liked" : "Like", icon: V.IC.heart, bg: "#d4356b", fg: "#ffffff" },
      { id: "download", label: "Download", icon: V.IC.dl, bg: "#6b46e5", fg: "#ffffff" }
    ];
  }

  let swipeRow = null, swipeTrack = null, swipePlate = null, swipeActions = null;
  let swipeStartX = 0, swipeStartY = 0, swipeDx = 0, swipeDir = 0, swipeStage = 0, swipeZoom = 1;
  let swipeLive = false, swipeFrame = 0;

  function paintSwipe() {
    swipeFrame = 0;
    if (!swipeRow) return;
    swipeRow.style.transform = "translateX(" + Math.round(swipeDx) + "px)";
    if (!swipePlate) return;
    const key = swipeDir + ":" + swipeStage;
    if (swipePlate.dataset.key === key) return;
    swipePlate.dataset.key = key;
    // Below the first depth the plate still names what is coming, greyed - the row is
    // being pulled, not yet answered.
    const action = swipeActions[Math.max(0, swipeStage - 1)];
    const label = '<span class="swipe-label">' + action.icon + "<span>" + V.esc(action.label) + "</span></span>";
    swipePlate.innerHTML = swipeDir > 0 ? label + "<span></span>" : "<span></span>" + label;
    swipePlate.style.background = swipeStage ? action.bg : "var(--bg-1)";
    swipePlate.style.color = swipeStage ? action.fg : "var(--fg-muted)";
    swipePlate.classList.toggle("armed", !!swipeStage);
    if (swipeStage && navigator.vibrate) { try { navigator.vibrate(9); } catch (e) {} }
  }

  function swipeClear(animate) {
    if (swipeFrame) { cancelAnimationFrame(swipeFrame); swipeFrame = 0; }
    const row = swipeRow, plate = swipePlate;
    swipeRow = null; swipeTrack = null; swipePlate = null; swipeActions = null;
    swipeDx = 0; swipeDir = 0; swipeStage = 0; swipeLive = false;
    if (!row) return;
    // The row keeps its opaque backing until it is home again, or the plate it is sliding
    // back over would show straight through it.
    if (!animate) { row.classList.remove("swiping", "swipe-settling"); row.style.transform = ""; if (plate) plate.remove(); return; }
    row.classList.add("swipe-settling");
    row.style.transform = "";
    setTimeout(() => {
      // A second swipe can start on the same row before this one has finished settling;
      // that gesture owns the row's backing now, and only the old plate is stale.
      if (row !== swipeRow) row.classList.remove("swiping", "swipe-settling");
      if (plate) plate.remove();
    }, 240);
  }

  async function runSwipeAction(track, action) {
    if (!track) return;
    if (Store.isBlocked(track)) { V.toast(V.BLOCKED_MSG, "err"); return; }
    if (action === "playnext") { Player.playNext(track); V.toast("Playing next"); }
    else if (action === "addqueue") { V.toast(Player.addToQueue(track) ? "Added to queue" : "Already in the queue"); }
    else if (action === "like") {
      // Liking something found in search has to keep the song itself too - the list it
      // was found in is gone the moment the next search runs.
      Store.addTrack(track);
      const liked = Store.toggleLike(track.id);
      V.toast(liked ? (Store.mediaKind(track) === "podcast" ? "Added to liked episodes" : "Added to Liked Songs") : "Removed from Liked");
      V.render();
    }
    else if (action === "download") {
      const existing = await Player.getDownload(track.id).catch(() => null);
      if (existing) { V.toast("Already downloaded"); return; }
      V.downloadAll([track]);
    }
  }

  V.view.addEventListener("touchstart", e => {
    swipeClear(false);
    if (e.touches.length !== 1) return;
    const row = e.target.closest(SWIPE_ROWS);
    // The controls sitting in the row are their own targets; a finger that starts on Play
    // or on the three dots is aiming at those, not at the row behind them.
    if (!row || e.target.closest("button, .play-fab")) return;
    const track = V.trackForElement(row);
    if (!track) return;
    swipeRow = row;
    swipeTrack = track;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeZoom = V.textZoom();
  }, { passive: true });

  V.view.addEventListener("touchmove", e => {
    if (!swipeRow || e.touches.length !== 1) return;
    // In the row's own pixels, which Text size may have made larger than the screen's.
    const dx = (e.touches[0].clientX - swipeStartX) / swipeZoom;
    const dy = (e.touches[0].clientY - swipeStartY) / swipeZoom;
    if (!swipeLive) {
      // A list is scrolled far more often than a row is swiped, so the sideways reading
      // has to win clearly before the row moves at all - and a vertical one ends the
      // gesture outright rather than leaving it armed for the rest of the scroll.
      if (Math.abs(dy) > SWIPE_LOCK && Math.abs(dy) >= Math.abs(dx)) { swipeRow = null; swipeTrack = null; return; }
      if (Math.abs(dx) <= SWIPE_LOCK || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      // A slow drag can cross the hold's half-second first: the menu is already open, and
      // the row underneath it is no longer the thing being touched.
      if (V.pressFired) { swipeRow = null; swipeTrack = null; return; }
      swipeLive = true;
      // Everything else the finger could have meant is called off: the hold that opens the
      // menu, the pull that refreshes, and the tap that would play the song on release.
      V.cancelLongPress();
      V.touchMoved = true;
      if (V.pullActive) V.endPull(false);
      swipeRow.classList.remove("swipe-settling");
      swipeRow.classList.add("swiping");
      swipePlate = document.createElement("div");
      swipePlate.className = "swipe-plate";
      swipePlate.style.top = swipeRow.offsetTop + "px";
      swipePlate.style.height = swipeRow.offsetHeight + "px";
      swipeRow.parentElement.insertBefore(swipePlate, swipeRow);
    }
    const width = swipeRow.offsetWidth || 1;
    const max = width * SWIPE_MAX;
    const travel = Math.abs(dx) - SWIPE_LOCK;
    // Past the far edge the row still answers the finger, but only just - there is no
    // third action out there to pull towards.
    const eased = travel <= max ? travel : max + (travel - max) * 0.18;
    const dir = dx > 0 ? 1 : -1;
    if (dir !== swipeDir) { swipeDir = dir; swipeActions = swipeActionsFor(swipeTrack, dir); }
    swipeDx = dir * eased;
    const frac = eased / width;
    swipeStage = frac >= SWIPE_ARM_FAR ? 2 : frac >= SWIPE_ARM ? 1 : 0;
    if (!swipeFrame) swipeFrame = requestAnimationFrame(paintSwipe);
  }, { passive: true });

  V.view.addEventListener("touchend", () => {
    if (!swipeRow) return;
    // A plain tap never moved the row, so there is nothing to settle and nothing to answer.
    if (!swipeLive) { swipeClear(false); return; }
    const track = swipeTrack;
    const action = swipeStage ? swipeActions[swipeStage - 1] : null;
    swipeClear(true);
    if (action) runSwipeAction(track, action.id);
  }, { passive: true });

  V.view.addEventListener("touchcancel", () => swipeClear(true), { passive: true });
})();
