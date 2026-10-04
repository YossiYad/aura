(function () {
  const V = window.Aura.views;
  // The bottom sheet, its drag-to-dismiss, the modal and the text prompt.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    closeModal: { get: () => closeModal },
    closeSheet: { get: () => closeSheet },
    modalCleanup: { get: () => modalCleanup, set: value => { modalCleanup = value; } },
    openModal: { get: () => openModal },
    openSheet: { get: () => openSheet },
    promptModal: { get: () => promptModal }
  });

  // What is left on screen of a sheet that has just closed: a copy of it sliding away and
  // a copy of the scrim fading out. The sheet itself is closed and empty at once, as every
  // caller expects, so the exit is only ever a picture of it and nothing can act on it.
  /** @type {HTMLElement[]} */
  let sheetLeaving = [];

  const sheetLeaveMs = 200;

  function dropSheetLeaving() {
    for (const el of sheetLeaving) el.remove();
    sheetLeaving = [];
  }

  // The sheet slides in, so it slides out the same way it came, from wherever it is at
  // that moment: at rest, part way through its entry, or under the finger that dragged
  // it down. Called while the sheet is still showing; closeSheet empties it afterwards.
  // With reduced motion the sheet simply goes and only the scrim fades, as it faded in.
  function leaveSheet() {
    dropSheetLeaving();
    if (document.documentElement.classList.contains("no-anim")) return;
    const box = V.sheetEl.getBoundingClientRect();
    const offset = Math.max(0, box.bottom - V.sheetEl.parentElement.getBoundingClientRect().bottom);
    /** @type {HTMLElement[]} */
    const leaving = [];
    // The same curve and time as the full player's exit (--ease-exit in tokens.css).
    const easing = "cubic-bezier(0.32, 0.72, 0, 1)";
    if (box.height && offset < box.height && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const scrollTop = V.sheetEl.scrollTop;
      const ghost = document.createElement("div");
      ghost.className = "sheet sheet-leaving" + (V.sheetEl.classList.contains("expanded") ? " expanded" : "");
      ghost.inert = true;
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.maxHeight = box.height + "px";
      ghost.append(...Array.from(V.sheetEl.childNodes));
      V.sheetEl.after(ghost);
      ghost.scrollTop = scrollTop;
      // Animated by script because the starting point is only known here, and so that the
      // animations switch in Settings, which stops stylesheet motion, is the check above.
      ghost.animate([
        { transform: "translate3d(0," + offset + "px,0)" },
        { transform: "translate3d(0," + box.height + "px,0)" }
      ], { duration: sheetLeaveMs, easing, fill: "forwards" });
      leaving.push(ghost);
    }
    if (!V.scrimEl.hidden) {
      const scrim = document.createElement("div");
      scrim.className = "scrim scrim-leaving";
      V.scrimEl.after(scrim);
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: sheetLeaveMs, easing, fill: "forwards" });
      leaving.push(scrim);
    }
    if (!leaving.length) return;
    sheetLeaving = leaving;
    setTimeout(() => {
      // A later close has its own copies by now; only this close's are taken away.
      if (sheetLeaving === leaving) dropSheetLeaving();
    }, sheetLeaveMs);
  }

  function closeSheet() {
    V.resetQueueSelection();
    if (!V.sheetEl.hidden && !V.closingFromHistory && V.historyDepth > 0) V.handOverEntry();
    if (!V.sheetEl.hidden) leaveSheet();
    V.sheetEl.hidden = true;
    V.scrimEl.hidden = true;
    V.sheetEl.innerHTML = "";
    resetSheetDrag();
    V.sheetEl.classList.remove("expanded");
    if (window.SharedQueue) SharedQueue.refreshNotifications();
  }

  /**
   * Opens the bottom sheet with the given content.
   * @param {string} html Escaped already.
   * @param {boolean} [keepQueueSelection]
   */
  function openSheet(html, keepQueueSelection = false) {
    if (!keepQueueSelection) V.resetQueueSelection();
    if (V.sheetEl.hidden) V.pushHistory();
    dropSheetLeaving();
    resetSheetDrag();
    V.sheetEl.classList.remove("expanded");
    V.sheetEl.scrollTop = 0;
    V.sheetEl.innerHTML = html;
    V.sheetEl.hidden = false;
    V.scrimEl.hidden = false;
    if (window.SharedQueue) SharedQueue.refreshNotifications();
  }

  // The sheet already draws a grab handle, so it should behave like one: drag it down to
  // dismiss, drag it up to take the whole screen. A drag only starts when the content is
  // scrolled to the top, so scrolling a long sheet still scrolls it.
  let sheetDragStartY = 0;

  let sheetDragStartX = 0;

  let sheetDragBaseY = 0;

  let sheetDragBaseHeight = 0;

  let sheetDragMaxHeight = 0;

  let sheetDragAt = 0;

  let sheetDragY = 0;

  let sheetDragging = false;

  let sheetDragEligible = false;

  let sheetDragFrame = 0;

  let sheetSuppressClickUntil = 0;

  const sheetDragHandle = ".sheet-head, .sheet-title, [data-sheet-drag-handle]";

  function paintSheetDrag() {
    sheetDragFrame = 0;
    // Reveal more of the menu while keeping its bottom anchored. Translating the
    // entire sheet upward leaves a black gap below it and snaps back on release.
    const growth = sheetDragY < 0 ? Math.min(-sheetDragY / 3, Math.max(0, sheetDragMaxHeight - sheetDragBaseHeight)) : 0;
    V.sheetEl.style.maxHeight = (sheetDragBaseHeight + growth) + "px";
    const offset = sheetDragBaseY + Math.max(0, sheetDragY);
    V.sheetEl.style.transform = "translate3d(0," + offset + "px,0)";
  }

  function resetSheetDrag() {
    if (sheetDragFrame) cancelAnimationFrame(sheetDragFrame);
    sheetDragFrame = 0;
    sheetDragEligible = false;
    sheetDragging = false;
    sheetDragY = 0;
    V.sheetEl.classList.remove("dragging");
    V.sheetEl.style.removeProperty("transform");
    V.sheetEl.style.removeProperty("max-height");
  }

  V.sheetEl.addEventListener("touchstart", /** @param {TouchEvent & { target: HTMLElement }} e */ e => {
    sheetDragEligible = false;
    sheetSuppressClickUntil = 0;
    if (e.touches.length !== 1) { resetSheetDrag(); return; }
    if (V.sheetEl.hidden || V.sheetEl.scrollTop > 1 || e.target.closest("input, textarea, select")) return;
    // Options scroll normally in both sizes. Only the grab area and header move the
    // sheet, so looking through actions cannot repeatedly expand and collapse it.
    if (e.target !== V.sheetEl && !e.target.closest(sheetDragHandle)) return;
    sheetDragStartX = e.touches[0].clientX;
    sheetDragStartY = e.touches[0].clientY;
    sheetDragAt = performance.now();
    sheetDragY = 0;
    sheetDragEligible = true;
    sheetDragging = false;
  }, { passive: true });

  V.sheetEl.addEventListener("touchmove", e => {
    if (!sheetDragEligible) return;
    // Once native scrolling owns a touch it cannot be reclaimed halfway through.
    if (e.touches.length !== 1 || !e.cancelable) { resetSheetDrag(); return; }
    const dy = e.touches[0].clientY - sheetDragStartY;
    if (!sheetDragging) {
      const dx = e.touches[0].clientX - sheetDragStartX;
      if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy)) { sheetDragEligible = false; return; }
      if (V.sheetEl.scrollTop > 1) { sheetDragEligible = false; return; }
      if (Math.abs(dy) <= 6) return;
      if (dy < 0 && V.sheetEl.classList.contains("expanded")) { sheetDragEligible = false; return; }
      // Pick up the visible position even during entry or a previous snap. Otherwise
      // the entry animation overrides our transform, making the handle feel stuck.
      const box = V.sheetEl.getBoundingClientRect();
      const parentBox = V.sheetEl.parentElement.getBoundingClientRect();
      sheetDragBaseY = box.bottom - parentBox.bottom;
      sheetDragBaseHeight = box.height;
      sheetDragMaxHeight = parentBox.height - 10;
      for (const animation of V.sheetEl.getAnimations()) {
        if (/** @type {CSSAnimation} */ (animation).animationName === "sheet-in") animation.cancel();
      }
      sheetDragging = true;
      V.sheetEl.classList.add("dragging");
      V.sheetEl.style.maxHeight = box.height + "px";
    }
    sheetDragY = dy;
    // Upward drag resists, because the only thing it can do is snap to full height.
    if (!sheetDragFrame) {
      sheetDragFrame = requestAnimationFrame(paintSheetDrag);
    }
    e.preventDefault();
  }, { passive: false });

  V.sheetEl.addEventListener("touchend", () => {
    if (!sheetDragEligible) return;
    const elapsed = Math.max(1, performance.now() - sheetDragAt);
    const flick = Math.abs(sheetDragY) / elapsed > 0.3 && Math.abs(sheetDragY) > 40;
    const dragged = sheetDragging;
    const dy = sheetDragY;
    if (dragged) {
      sheetSuppressClickUntil = performance.now() + 400;
      // Commit the final finger position before starting the snap, including when
      // touchend arrives before the scheduled paint. Both transitions start here.
      if (sheetDragFrame) cancelAnimationFrame(sheetDragFrame);
      paintSheetDrag();
      V.sheetEl.getBoundingClientRect();
    }
    resetSheetDrag();
    if (!dragged) return;
    if (dy > 0 && (flick || dy > 110)) {
      if (V.sheetEl.classList.contains("expanded")) V.sheetEl.classList.remove("expanded");
      else V.dismissViaHistory(closeSheet);
    } else if (dy < 0 && (flick || dy < -60)) {
      V.sheetEl.classList.add("expanded");
    }
  }, { passive: true });

  V.sheetEl.addEventListener("touchcancel", resetSheetDrag, { passive: true });

  V.sheetEl.addEventListener("contextmenu", /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
    if (!e.target.closest("input, textarea, select") && e.target.closest("img, " + sheetDragHandle)) e.preventDefault();
  });

  V.sheetEl.addEventListener("click", e => {
    if (e.detail && performance.now() < sheetSuppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  V.scrimEl.addEventListener("click", () => V.dismissViaHistory(() => { closeSheet(); closeModal(); }));
  // Escape closes the dialog or sheet on top, the way Back and a tap outside do, so they can
  // be left from a keyboard. A control that answers Escape itself (a rename, a drag) has
  // already taken it.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || (V.modalEl.hidden && V.sheetEl.hidden)) return;
    e.preventDefault();
    V.dismissViaHistory(() => { closeSheet(); closeModal(); V.scrimEl.hidden = true; });
  });

  let modalCleanup = null;

  function closeModal() {
    if (modalCleanup) { const cleanup = modalCleanup; modalCleanup = null; cleanup(); }
    V.modalEl.hidden = true; V.modalEl.innerHTML = "";
  }

  function openModal(html) {
    if (modalCleanup) { const cleanup = modalCleanup; modalCleanup = null; cleanup(); }
    if (V.modalEl.hidden) V.pushHistory();
    dropSheetLeaving();
    V.modalEl.innerHTML = html;
    V.modalEl.hidden = false;
    V.scrimEl.hidden = false;
  }

  function promptModal(title, initial, onOk) {
    openModal(
      '<div class="modal"><h3>' + V.esc(title) + '</h3>' +
      '<input type="text" id="modal-input" dir="auto" value="' + V.esc(initial || "") + '" />' +
      '<div class="modal-actions"><button class="btn ghost" id="modal-cancel">Cancel</button>' +
      '<button class="btn primary" id="modal-ok">Save</button></div></div>'
    );
    const input = /** @type {HTMLInputElement} */ (document.getElementById("modal-input"));
    input.focus(); input.select();
    // The modal stays visible until its history entry is spent, so a quick second Enter
    // or Save would otherwise run onOk again and spend one entry too many.
    let done = false;
    const shut = () => {
      if (done) return;
      done = true;
      V.dismissViaHistory(() => { closeModal(); V.scrimEl.hidden = true; });
    };
    document.getElementById("modal-cancel").onclick = shut;
    const ok = () => {
      const v = input.value.trim();
      if (!v || done) return;
      shut();
      onOk(v);
    };
    document.getElementById("modal-ok").onclick = ok;
    input.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
  }
})();
