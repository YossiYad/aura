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

  window.addEventListener("focusout", () => { setTimeout(() => {
    const el = document.activeElement;
    if (!el || !el.matches("input, textarea, select")) window.scrollTo(0, 0);
  }, 60); });
  V.syncKeyboardViewport();
  document.addEventListener("focusin", V.syncKeyboardViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      V.syncKeyboardViewport();
      const el = document.activeElement;
      if (!el || !el.matches("input, textarea, select")) window.scrollTo(0, 0);
    });
    window.visualViewport.addEventListener("scroll", V.syncKeyboardViewport);
  }
})();
