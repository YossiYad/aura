(function () {
  const V = window.Aura.main;

  function installSwipeBoundaryGuard() {
    let gesture = null;
    function scrollParent(target, axis, delta) {
      for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (!/auto|scroll/.test(axis === "x" ? style.overflowX : style.overflowY)) continue;
        const range = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
        if (range <= 1) continue;
        const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
        const rtl = axis === "x" && style.direction === "rtl";
        const min = rtl ? -range : 0, max = rtl ? 0 : range;
        if (delta < 0 ? pos > min + 1 : pos < max - 1) return el;
      }
      return null;
    }
    document.addEventListener("touchstart", /** @param {TouchEvent & { target: HTMLElement }} event */ event => {
      gesture = null;
      // A finger arriving is the last moment a scrolled frame can be put back before this
      // very tap is judged against it.
      V.resetViewportDrift("touch");
      if (event.touches.length !== 1 || event.target.closest("input, textarea, select, label, [contenteditable='true']")) return;
      const touch = event.touches[0];
      // Installed Safari can start its history animation before touchmove. Claim
      // only the narrow screen edges there; all other scrolling remains native.
      const edge = V.isIOS() && V.isStandalone() &&
        (touch.clientX <= 24 || touch.clientX >= window.innerWidth - 24) && event.cancelable;
      gesture = { target: event.target, x: touch.clientX, y: touch.clientY, lastX: touch.clientX,
        lastY: touch.clientY, edge, moved: false, at: Date.now() };
      if (edge) event.preventDefault();
    }, { passive: false });
    document.addEventListener("touchmove", event => {
      if (!gesture || event.touches.length !== 1) { gesture = null; return; }
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8 && !gesture.moved) return;
      gesture.moved = true;
      const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      const delta = horizontal ? gesture.lastX - touch.clientX : gesture.lastY - touch.clientY;
      gesture.lastX = touch.clientX; gesture.lastY = touch.clientY;
      if (event.defaultPrevented) return; // The player or a track-row swipe owns it.
      const scroller = scrollParent(gesture.target, horizontal ? "x" : "y", delta);
      if (gesture.edge) {
        if (event.cancelable) event.preventDefault();
        if (scroller) {
          if (horizontal) scroller.scrollLeft += delta;
          else scroller.scrollTop += delta;
        }
      } else if (horizontal && !scroller && event.cancelable) {
        // An exhausted carousel must not pass the remaining drag to browser history.
        event.preventDefault();
      }
    }, { passive: false });
    document.addEventListener("touchend", event => {
      const ended = gesture;
      gesture = null;
      // A claimed edge touch has no synthesized browser click. Restore a short tap
      // so controls close to the edge remain usable, without activating after a drag.
      if (ended && ended.edge && !ended.moved && Date.now() - ended.at < 500 &&
          !event.defaultPrevented && ended.target.isConnected) {
        const target = ended.target.closest("button, a, [role='button']") || ended.target;
        if (typeof target.click === "function") target.click();
      }
    });
    document.addEventListener("touchcancel", () => { gesture = null; });
  }
  installSwipeBoundaryGuard();

  // A tap here is a finger that landed and lifted in place, quickly.
  const TAP_SLOP = 10;
  const TAP_MS = 500;
  // The click for a tap follows its touchend at once; this is only for one that never comes.
  const CLICK_WAIT = 450;
  // Above and below the header and the navigation, so a finger that landed where a control
  // is painted rather than where it is laid out is still followed.
  const TAP_BAND = 60;
  // Things a tap may legitimately land on in those bands without the report being about it.
  const TAP_TARGETS = "button, a, input, select, textarea, label, [role='button'], [role='slider'], [role='option'], " +
    "[role='menuitem'], #pb-now, [data-id], [data-pl], " +
    "[data-quick], [data-rec], [data-recent], [data-browse], [data-search], [data-chip], .card, .song, .dr, .pl-row, .quick-tile";

  // The control laid out under a point, if any.
  function controlAt(x, y) {
    return V.tapControls().find(el => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    }) || null;
  }

  // The control in the same column as a point, and how far the point is above (negative)
  // or below (positive) its box. Says by how much a tap missed.
  function nearestControl(x, y) {
    let best = null;
    for (const el of V.tapControls()) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x >= r.right) continue;
      const dy = y < r.top ? y - r.top : y >= r.bottom ? y - r.bottom : 0;
      if (!best || Math.abs(dy) < Math.abs(best.dy)) best = { el, dy: Math.round(dy) };
    }
    return best;
  }

  const recentTaps = [];
  // Follows a tap in one of the two bands to its click. A tap laid out over a control whose
  // click went elsewhere, or a tap that reached nothing at all, is written to the log with
  // what tells a covering element from a moved viewport: the touch in page and screen
  // coordinates, what the page finds under it, the nearest control and how far off it is,
  // the click that came, or did not, the viewport, and the taps just before it.
  function judgeTap(tap, click) {
    const control = controlAt(tap.x, tap.y);
    const legit = el => !!(el && el.closest && el.closest(TAP_TARGETS));
    const ok = control ? !!(click && control.contains(click)) : legit(click) || legit(tap.end);
    const name = el => el ? (el.dataset && (el.dataset.tab || el.dataset.homeFilter)) || V.describeElement(el) : "nothing";
    if (ok) {
      recentTaps.push(name(control || click) + " " + Math.round(tap.x) + "," + Math.round(tap.y) + " " + (tap.at / 1000).toFixed(1) + "s");
      if (recentTaps.length > 3) recentTaps.shift();
      return false;
    }
    const near = nearestControl(tap.x, tap.y);
    const nearText = near ? name(near.el) + " " + rectOf(near.el) + (near.dy ? " off by " + Math.abs(near.dy) + "px " + (near.dy < 0 ? "above" : "below") : "") : "none in this column";
    if (window.Log) Log.add("taps", "lost: touch " + Math.round(tap.x) + "," + Math.round(tap.y) +
      " (screen " + Math.round(tap.screenX) + "," + Math.round(tap.screenY) + ", dy " + Math.round(tap.screenY - tap.y) + ")" +
      " ended on " + V.describeElement(tap.end) + ", page finds " + V.describeElement(tap.under) +
      " | laid out here: " + (control ? name(control) + " " + rectOf(control) : "no control") + "; nearest " + nearText +
      " | click: " + (click ? V.describeElement(click) : "none within " + CLICK_WAIT + "ms") +
      " | " + V.viewportSnapshot() +
      (recentTaps.length ? " | before: " + recentTaps.join(", ") : ""));
    V.auditHitTargets("lost tap");
    return true;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height);
  }

  function installTapAudit() {
    let touch = null, pending = null, timer = 0;
    function inBand(y) {
      const top = document.querySelector(".topbar"), nav = V.$("tabs");
      if (top && /** @type {HTMLElement} */ (top).offsetHeight) {
        const r = top.getBoundingClientRect();
        if (y >= r.top - 10 && y < r.bottom + TAP_BAND) return true;
      }
      if (nav && nav.offsetHeight) {
        const r = nav.getBoundingClientRect();
        if (y >= r.top - TAP_BAND && y < r.bottom + 10) return true;
      }
      return false;
    }
    // While something covers the screen the bands belong to it, and its taps are its own.
    function covered() {
      return !!document.querySelector(".fullplayer:not([hidden]), .drive:not([hidden]), .sheet:not([hidden]), .modal-wrap:not([hidden]), .scrim:not([hidden])");
    }
    document.addEventListener("touchstart", e => {
      if (e.touches.length !== 1) { touch = null; return; }
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, screenX: t.screenX, screenY: t.screenY, at: performance.now(), moved: false };
    }, { passive: true, capture: true });
    document.addEventListener("touchmove", e => {
      if (!touch || e.touches.length !== 1) { touch = null; return; }
      const t = e.touches[0];
      if (Math.abs(t.clientX - touch.x) > TAP_SLOP || Math.abs(t.clientY - touch.y) > TAP_SLOP) touch.moved = true;
    }, { passive: true, capture: true });
    document.addEventListener("touchend", /** @param {TouchEvent & { target: HTMLElement }} e */ e => {
      const ended = touch;
      touch = null;
      if (!ended || ended.moved || performance.now() - ended.at > TAP_MS || covered() || !inBand(ended.y)) return;
      if (timer) clearTimeout(timer);
      pending = Object.assign(ended, { end: e.target, under: document.elementFromPoint(ended.x, ended.y) });
      timer = setTimeout(() => {
        timer = 0;
        const tap = pending;
        pending = null;
        if (tap) judgeTap(tap, null);
      }, CLICK_WAIT);
    }, { passive: true, capture: true });
    document.addEventListener("touchcancel", () => { touch = null; }, { passive: true, capture: true });
    document.addEventListener("click", /** @param {MouseEvent & { target: HTMLElement }} e */ e => {
      if (!pending) return;
      const tap = pending;
      pending = null;
      if (timer) clearTimeout(timer);
      timer = 0;
      judgeTap(tap, e.target);
    }, true);
  }
  installTapAudit();

  // The keyboard leaves in an animation; the frame is checked as it starts to go and again
  // once it has gone, since iOS can move the page after the first check.
  window.addEventListener("focusout", () => {
    setTimeout(() => V.resetViewportDrift("field left"), 60);
    setTimeout(() => V.resetViewportDrift("keyboard gone"), 450);
  });
  V.syncKeyboardViewport();
  document.addEventListener("focusin", V.syncKeyboardViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      V.syncKeyboardViewport();
      V.resetViewportDrift("visual viewport resized");
    });
    window.visualViewport.addEventListener("scroll", () => {
      V.syncKeyboardViewport();
      V.resetViewportDrift("visual viewport scrolled");
    });
  }
})();
