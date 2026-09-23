(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    cancelLongPress: { get: () => cancelLongPress },
    currentResultList: { get: () => currentResultList },
    endPull: { get: () => endPull },
    lastScrollAt: { get: () => lastScrollAt },
    lastTouchAt: { get: () => lastTouchAt },
    pressFired: { get: () => pressFired, set: value => { pressFired = value; } },
    pullActive: { get: () => pullActive },
    SETTLE_MS: { get: () => SETTLE_MS },
    touchMoved: { get: () => touchMoved, set: value => { touchMoved = value; } },
    trackById: { get: () => trackById }
  });

  // A song is not only a library entry. Downloading one straight from search never added
  // it to the library, and the Downloaded list deliberately shows those - so looking a
  // tapped row up in the library alone found nothing and the tap did nothing at all.
  // Every place that turns an id back into a song goes through here.
  function trackById(id) {
    if (!id) return null;
    return Store.findTrack(id) ||
      (Store.downloadedTracks ? Store.downloadedTracks().find(t => t.id === id) : null) ||
      Store.recents().find(t => t.id === id) ||
      Store.topListeningTracks(1000, "all").find(t => t.id === id) ||
      currentResultList().find(t => t.id === id) ||
      (Player.queue ? Player.queue().find(t => t.id === id) : null) ||
      V.homeDownloads.items.find(t => t.id === id) ||
      null;
  }

  function currentResultList() {
    if (V.subView && V.subView.kind === "ytArtist" && V.subView.currentVideos) return V.subView.currentVideos;
    if (V.subView && V.subView.kind === "ytAlbum" && V.subView.currentVideos) return V.subView.currentVideos;
    // A shared list is the one collection whose songs may exist nowhere on this device -
    // without this, tapping a row in someone else's list found no track to play.
    if (V.subView && V.subView.kind === "shared") {
      const record = V.subView.record || Sync.sharedCached(V.subView.id);
      if (record && record.tracks) return record.tracks;
    }
    if (V.currentTab === "ai" && !V.subView) return V.askState.tracks;
    return V.discoverState.items;
  }

  let dlMarkTimer = null;
  new MutationObserver(() => {
    if (dlMarkTimer) return;
    dlMarkTimer = setTimeout(() => { dlMarkTimer = null; V.markLocalRows(); }, 50);
  }).observe(V.view, { childList: true, subtree: true });

  V.view.addEventListener("error", e => {
    const img = e.target;
    if (!img || !img.matches || !img.matches("img")) return;
    if (img.parentElement) img.parentElement.classList.add("image-missing");
    img.remove();
  }, true);

  // A finger that moved was scrolling, not choosing. Without this a tap released at the
  // end of a flick - or the tap that stops momentum - counted as picking whatever was
  // under it, and the track changed while the listener was only browsing.
  const TOUCH_SLOP = 10;      // px of travel that turns a tap into a scroll
  const SETTLE_MS = 250;      // after the list moves, the next tap is stopping it
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let lastTouchAt = 0;
  let lastScrollAt = 0;

  // Pull the top of a list down and let go to refresh - the gesture every phone app has.
  // The indicator is drawn from the app's own spinner, so it belongs to this app rather
  // than looking borrowed.
  const PULL_TRIGGER = 64;
  const PULL_MAX = 110;
  let pullStartY = 0;
  let pullActive = false;
  let pullDistance = 0;
  let lastTouchY = null;
  const pullEl = document.createElement("div");
  pullEl.className = "pull-refresh";
  pullEl.innerHTML = '<span class="ring"></span>';
  V.view.parentNode.insertBefore(pullEl, V.view);

  let pullArmed = false;

  function setPull(px, spinning) {
    pullDistance = px;
    const progress = Math.max(0, Math.min(1, px / PULL_TRIGGER));
    const ring = /** @type {HTMLElement} */ (pullEl.firstElementChild);
    // Grows and turns as it is pulled, so the gesture has something to answer to before
    // it is released - the whole point of the pull is knowing when it has caught.
    pullEl.style.transform = "translateY(" + Math.round(px) + "px) scale(" + (0.55 + progress * 0.45).toFixed(3) + ")";
    pullEl.style.opacity = px > 4 ? String(Math.min(1, progress * 1.25)) : "0";
    if (spinning) ring.style.transform = "";
    else ring.style.transform = "rotate(" + Math.round(progress * 300) + "deg)";
    const armed = progress >= 1;
    if (armed && !pullArmed && navigator.vibrate) { try { navigator.vibrate(9); } catch (e) {} }
    pullArmed = armed;
    pullEl.classList.toggle("ready", armed);
    pullEl.classList.toggle("spinning", !!spinning);
    V.view.style.transform = px > 0 ? "translateY(" + Math.round(px * 0.42) + "px)" : "";
  }

  function endPull(run) {
    pullActive = false;
    V.view.style.transition = "transform .26s var(--ease-standard)";
    pullEl.style.transition = "transform .26s var(--ease-standard), opacity .2s linear";
    if (run) {
      setPull(PULL_TRIGGER * 0.6, true);
      V.forceRefresh().then(() => {
        setPull(0, false);
        setTimeout(() => { V.view.style.transition = ""; pullEl.style.transition = ""; }, 280);
      });
      return;
    }
    setPull(0, false);
    setTimeout(() => { V.view.style.transition = ""; pullEl.style.transition = ""; }, 280);
  }

  const LONG_PRESS_MS = 500;
  // Every element that stands for a single track, so a hold anywhere one is shown reaches
  // the same menu. Kept in step with trackForElement - a row it cannot resolve has nothing
  // to open, and a row missing from here silently has no hold at all.
  const PRESSABLE = V.TRACK_ELEMENTS.join(", ");
  let pressTimer = null;
  let pressFired = false;

  function cancelLongPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }

  function openHeldTrack(target, suppressClick = true) {
    const track = V.trackForElement(target);
    if (!track) return false;
    cancelLongPress();
    pressFired = suppressClick;
    if (pullActive) endPull(false);
    // Galaxy browsers can send contextmenu after the hold timer, including after
    // touchcancel. Consume it without rebuilding the menu or restarting its animation.
    const existing = V.sheetEl.querySelector("[data-track-menu]");
    if (!V.sheetEl.hidden && existing && existing.dataset.trackMenu === track.id) return true;
    const ctx = (target.closest("[data-ctx]") || { dataset: {} }).dataset.ctx || "";
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
    V.openTrackMenu(track, ctx);
    return true;
  }

  V.view.addEventListener("contextmenu", e => {
    const target = e.target.closest(PRESSABLE);
    if (!target || !V.trackForElement(target)) return;
    e.preventDefault();
    openHeldTrack(target, e.pointerType === "touch" || Date.now() - lastTouchAt < 1500);
  });

  V.view.addEventListener("touchstart", e => {
    lastTouchAt = Date.now();
    cancelLongPress();
    pressFired = false;
    if (e.touches.length !== 1) { touchMoved = true; return; }
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchMoved = false;
    // Holding a song opens the same menu the three dots do - the dots are a small target
    // on a phone, and the tile the finger is already on is the obvious one.
    // Only from the very top, and only downwards, so it never fights a scroll.
    lastTouchY = e.touches[0].clientY;
    if (V.view.scrollTop <= 0 && !V.refreshing) {
      pullStartY = e.touches[0].clientY;
      pullActive = true;
      V.view.style.transition = "";
      pullEl.style.transition = "";
    }
    const target = e.target.closest(PRESSABLE);
    if (!target || e.target.closest("button.kebab, .row-dl, [data-menu], [data-add]")) return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      openHeldTrack(target);
    }, LONG_PRESS_MS);
  }, { passive: true });

  V.view.addEventListener("touchend", () => {
    cancelLongPress();
    lastTouchY = null;
    if (!pullActive) return;
    endPull(pullDistance >= PULL_TRIGGER);
  }, { passive: true });
  V.view.addEventListener("touchcancel", () => {
    cancelLongPress();
    lastTouchY = null;
    if (V.sheetEl.hidden) pressFired = false;
    if (pullActive) endPull(false);
  }, { passive: true });

  V.view.addEventListener("touchmove", e => {
    if (e.touches.length !== 1) return;
    // Touches stay targeted at the original home tile after its menu opens. Keep
    // the remaining hold from scrolling or pulling to refresh behind the menu.
    if (pressFired && !V.sheetEl.hidden) {
      if (e.cancelable) e.preventDefault();
      return;
    }
    // The pull is tracked for the whole gesture, not only until the finger counts as
    // having moved - that early return is about taps, and would freeze the pull at its
    // first few pixels.
    // Scrolling up to the top and carrying on in the same motion is the ordinary way to
    // reach for this - the finger never lifts, so waiting for a fresh touch that starts
    // at the top would mean the gesture only worked when you were already there. The pull
    // arms wherever the list runs out, from the point the finger is at right then.
    if (!pullActive && !V.refreshing && V.view.scrollTop <= 0 && lastTouchY != null &&
        e.touches[0].clientY > lastTouchY) {
      pullActive = true;
      pullStartY = e.touches[0].clientY;
      V.view.style.transition = "";
      pullEl.style.transition = "";
    }
    lastTouchY = e.touches[0].clientY;
    if (pullActive) {
      const pulled = e.touches[0].clientY - pullStartY;
      if (pulled > 0 && V.view.scrollTop <= 0) setPull(Math.min(PULL_MAX, pulled * 0.6), false);
      else if (pullDistance) setPull(0, false);
    }
    if (touchMoved) return;
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > TOUCH_SLOP || dy > TOUCH_SLOP) { touchMoved = true; cancelLongPress(); }
  }, { passive: false });

  V.view.addEventListener("scroll", () => { lastScrollAt = Date.now(); }, { passive: true });
})();
