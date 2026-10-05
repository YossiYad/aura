(function () {
  const V = window.Aura.views;
  // How a mouse works the desktop layout (src/views/desktop.js) where a finger works the
  // phone's: menus open at the pointer instead of rising from the bottom, and rows that
  // scroll sideways are dragged instead of swiped. Built with the rest of the layout, the
  // first time a window is taken for a computer.

  // A menu opens where it was asked for, the way a desktop's menus do: at the pointer,
  // pulled back inside the window where it would run off it. One opened from the
  // keyboard has no such place and opens in the middle. The position is kept on the app
  // frame, so the copy a closing sheet leaves behind (core-sheets.js) fades where it was.
  let point = { x: 0, y: 0, at: 0 };
  /** @type {{ x: number, y: number } | null} */
  let anchor = null;
  let sheetOpen = false;
  let sheetTimer = 0;
  function placeSheet(app) {
    const open = !V.sheetEl.hidden;
    if (!V.desktop || !open) {
      sheetOpen = false;
      clearTimeout(sheetTimer);
      sheetTimer = window.setTimeout(() => {
        for (const name of ["--dk-sheet-x", "--dk-sheet-y", "--dk-sheet-shift", "--dk-sheet-w", "--dk-scrim"]) app.style.removeProperty(name);
      }, V.desktop ? 260 : 0);
      return;
    }
    clearTimeout(sheetTimer);
    if (!sheetOpen) anchor = Date.now() - point.at < 800 ? { x: point.x, y: point.y } : null;
    sheetOpen = true;
    if (!anchor) return;
    app.style.setProperty("--dk-sheet-shift", "0 0");
    app.style.setProperty("--dk-sheet-w", "340px");
    app.style.setProperty("--dk-scrim", "transparent");
    const box = app.getBoundingClientRect();
    const fit = (at, size, room) => Math.max(8, Math.min(at, room - size - 8));
    app.style.setProperty("--dk-sheet-x", Math.round(fit(anchor.x - box.left, V.sheetEl.offsetWidth, box.width)) + "px");
    app.style.setProperty("--dk-sheet-y", Math.round(fit(anchor.y - box.top, V.sheetEl.offsetHeight, box.height)) + "px");
  }
  function watchSheet(app) {
    const note = e => { point = { x: e.clientX, y: e.clientY, at: Date.now() }; };
    document.addEventListener("pointerdown", note, true);
    document.addEventListener("contextmenu", note, true);
    if (window.MutationObserver) {
      new MutationObserver(() => placeSheet(app)).observe(V.sheetEl, { attributes: true, attributeFilter: ["hidden"], childList: true });
    }
  }

  // A row that scrolls sideways under a finger - the Settings tabs, the filters, a row of
  // cards that does not fit - has nothing to take hold of with a mouse: its scrollbar is
  // hidden and the wheel scrolls the page. So it is dragged, the way it is swiped: press
  // and pull. A drag that moved is not also a click on whatever it was let go over.
  /** @type {{ row: HTMLElement, id: number, x: number, left: number, moved: boolean } | null} */
  let drag = null;
  let clickBlockedUntil = 0;
  function sidewaysRow(target) {
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth + 2) return node;
    }
    return null;
  }
  function watchDrags() {
    document.addEventListener("pointerdown", e => {
      if (!V.desktop || e.pointerType !== "mouse" || e.button !== 0) return;
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest("input, textarea, select, [contenteditable], .song-progress, .reorder-handle")) return;
      const row = sidewaysRow(target);
      if (row) drag = { row, id: e.pointerId, x: e.clientX, left: row.scrollLeft, moved: false };
    });
    document.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 6) return;
        drag.moved = true;
        drag.row.classList.add("dk-dragging");
      }
      // Logical scrolling: a right-to-left row counts its scroll from the other side.
      drag.row.scrollLeft = drag.left - dx;
      e.preventDefault();
    });
    const end = () => {
      if (!drag) return;
      if (drag.moved) clickBlockedUntil = Date.now() + 250;
      drag.row.classList.remove("dk-dragging");
      drag = null;
    };
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    document.addEventListener("click", e => {
      if (Date.now() >= clickBlockedUntil) return;
      clickBlockedUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    // A picture or a link would otherwise be picked up and carried off by the browser.
    document.addEventListener("dragstart", e => { if (V.desktop && sidewaysRow(/** @type {HTMLElement} */ (e.target))) e.preventDefault(); });
  }

  V.desktopParts.push({
    mount: app => { watchSheet(app); watchDrags(); },
    show: () => {},
    sync: () => {}
  });
})();
