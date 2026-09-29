(function () {
  const V = window.Aura.views;
  // The screen stack and the history ledger behind Back: sub views, entries pushed and spent, the base entry, the layers Back closes.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    backLayers: { get: () => backLayers },
    closingFromHistory: { get: () => closingFromHistory },
    dismissViaHistory: { get: () => dismissViaHistory },
    handOverEntry: { get: () => handOverEntry },
    historyDepth: { get: () => historyDepth },
    popSubView: { get: () => popSubView },
    pushHistory: { get: () => pushHistory },
    pushSubView: { get: () => pushSubView },
    restoreViewScroll: { get: () => restoreViewScroll },
    spendEntry: { get: () => spendEntry },
    spendSubViewEntries: { get: () => spendSubViewEntries }
  });

  // On Android the Back button and the back gesture are how people leave a screen. With no
  // history entries there was nothing to go back to, so Back left the app entirely and took
  // the user's place in the app with it. Each screen and overlay adds an entry; Back closes
  // the topmost one, and only leaves the app once there is nothing left open.
  let historyDepth = 0;

  let closingFromHistory = false;

  // Entries spent deliberately by code rather than by a Back press. Each one owns a
  // history.back() that is on its way; when its popstate lands there is nothing to close
  // and the ledger must not move again - otherwise the count drifts and Back starts
  // exiting the app while screens are still open.
  let syntheticBacks = 0;

  // An entry whose sheet was closed by a tap on the way to opening something else: the
  // screen or dialog that follows takes it over rather than pushing another, and one
  // that nothing claims is spent. Left behind, each was a Back press that did nothing.
  let spareEntries = 0;

  function handOverEntry() {
    spareEntries++;
    setTimeout(() => {
      if (spareEntries <= 0) return;
      spareEntries--;
      spendEntry();
    }, 0);
  }

  function pushHistory() {
    if (spareEntries > 0) { spareEntries--; return; }
    historyDepth++;
    try { history.pushState({ aura: historyDepth }, ""); } catch (e) {}
  }

  // Consume one of our own entries now, because the thing it stood for was closed by a
  // tap rather than by Back. A browser entry can only be removed by navigating over it,
  // so this walks back across it; the matching popstate is recognised via syntheticBacks
  // and does nothing. Without this, every tap-closed menu left its entry behind - and the
  // piled-up orphans made Back press dead once and then leave the app outright.
  function spendEntry() {
    if (historyDepth <= 0 || closingFromHistory) return;
    historyDepth--;
    syntheticBacks++;
    try { history.back(); } catch (e) { syntheticBacks--; historyDepth++; }
  }

  // Spend every entry a subview stack still holds. Used where the stack is cleared as a
  // side effect of navigation that is not a Back press.
  function spendSubViewEntries() {
    const levels = (V.subView ? 1 : 0) + V.subViewStack.length;
    for (let i = 0; i < levels; i++) spendEntry();
  }

  // For a control whose only job is to dismiss: go through history so the entry is spent
  // rather than left behind for a later Back press to waste.
  function dismissViaHistory(closeDirectly) {
    if (historyDepth > 0 && !closingFromHistory) { history.back(); return; }
    closeDirectly();
  }

  // Screens owned outside this file register themselves here, so Back closes them like
  // any other layer. The full player sits above every screen but under sheets and modals.
  const backLayers = [];

  // One spare entry always sits under everything. Without it, the Back press on a bare
  // screen navigates straight out of the document - the page is destroyed, and the audio
  // element dies with it. With it, that press lands here and can be answered.
  try {
    history.pushState({ auraBase: true }, "");
    if (window.Log) Log.add("nav", "base history entry pushed, history.length=" + history.length);
  } catch (e) {
    if (window.Log) Log.add("nav", "base history entry push threw: " + String((e && e.message) || e));
  }

  function closeTopBackLayer() {
    for (let i = 0; i < backLayers.length; i++) {
      const layer = backLayers[i];
      try {
        if (!layer.open()) continue;
        layer.close();
        // The layer held no entry of its own, so the one Back just spent belonged to
        // whatever is still showing underneath. Put it back.
        try { history.pushState({ auraBase: true }, ""); } catch (e) {}
        if (window.Log) Log.add("nav", "back closed layer #" + i);
        return true;
      } catch (e) {}
    }
    return false;
  }

  // Playback is why a bare-screen Back must not simply leave: an exited app is a silent
  // one, and the exit is usually a gesture gone further than intended. While music runs
  // the press is caught and explained instead; pausing restores the old way out. Home is
  // the way to listen in other apps - the OS keeps the sound going once it is in the
  // background either way.
  function holdExit() {
    const hasPlayer = !!window.Player;
    const track = hasPlayer && Player.current();
    const paused = hasPlayer && track && Player.isPaused();
    if (window.Log) Log.add("nav", "holdExit check: hasPlayer=" + hasPlayer + " track=" + !!track + " paused=" + paused);
    if (!(hasPlayer && track && !paused)) return;
    try { history.pushState({ auraBase: true }, ""); } catch (e) {
      if (window.Log) Log.add("nav", "holdExit pushState threw: " + String((e && e.message) || e));
    }
    if (window.Log) Log.add("nav", "holdExit trapped the back press, music was playing");
    // A toast alone is easy to miss with a thumb already moving for a second Back press -
    // and a second press in quick succession isn't caught the same way the first one was.
    // A pulse felt right away needs no reading and answers the one question that matters:
    // did that Back press register at all.
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
    V.toast("Music keeps playing - use Home to listen in the background, or pause to exit");
  }

  window.addEventListener("popstate", () => {
    closingFromHistory = true;
    if (window.Log) {
      Log.add("nav", "popstate: syntheticBacks=" + syntheticBacks + " historyDepth=" + historyDepth +
        " modalHidden=" + V.modalEl.hidden + " sheetHidden=" + V.sheetEl.hidden + " subView=" + !!V.subView +
        " layers=" + backLayers.length);
    }
    try {
      if (syntheticBacks > 0) { syntheticBacks--; return; }
      // Sheets and modals float above every registered layer, including the full
      // player: dismissing one must spend its own entry, not close what shows beneath.
      if (!V.modalEl.hidden || !V.sheetEl.hidden) {
        if (historyDepth > 0) historyDepth--;
        if (!V.modalEl.hidden) { V.closeModal(); V.scrimEl.hidden = true; }
        else V.closeSheet();
        return;
      }
      if (closeTopBackLayer()) return;
      if (historyDepth > 0) historyDepth--;
      if (V.subView) popSubView();
      else holdExit();
    } finally {
      closingFromHistory = false;
    }
  });

  function pushSubView(next) {
    // The screen being covered keeps its own filter and sort, for the Back that
    // restores it; the new screen starts clean.
    if (V.subView) { V.subView.collectionQuery = V.collectionQuery; V.subView.collectionSort = V.collectionSort; }
    V.collectionQuery = "";
    V.collectionSort = "order";
    V.subViewStack.push(V.subView);
    V.subViewScrollStack.push(V.view.scrollTop);
    V.subView = next;
    pushHistory();
    V.render(true);
    restoreViewScroll(0);
  }

  function popSubView() {
    const restoreScroll = V.subViewScrollStack.pop() || 0;
    V.subView = V.subViewStack.pop() || null;
    V.collectionQuery = (V.subView && V.subView.collectionQuery) || "";
    V.collectionSort = (V.subView && V.subView.collectionSort) || "order";
    V.render(true);
    restoreViewScroll(restoreScroll);
  }

  // Setting this after a frame has already gone by paints the top of the new screen first
  // and then jumps - visible every time you back out of an album. Place it now, before
  // anything is painted, and keep the frame-later pass for lists that are still filling in.
  function restoreViewScroll(y) {
    V.view.scrollTop = y;
    requestAnimationFrame(() => {
      if (V.view.scrollTop !== y) V.view.scrollTop = y;
      V.syncHeroStickyBar();
    });
  }
})();
