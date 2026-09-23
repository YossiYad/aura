(function () {
  // The screens are one module in several files: this one holds what they all share (the
  // screen stack, sheets, dialogs, toasts, artwork), and src/views/ holds one file per area,
  // loaded after it in the order index.html lists them. Each file is its own closure. What
  // one file needs from another it reaches through V, window.Aura.views, where each file
  // publishes, at its top, the names the others use: V.render(), V.currentTab. A name that
  // another file assigns is published with a setter, so V.currentTab = "home" changes the
  // variable itself. Nothing outside the module uses V; the public face is window.Views,
  // put together in src/views/public.js.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).views = {};
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    APP_VERSION: { get: () => APP_VERSION },
    artHtml: { get: () => artHtml },
    artistHtml: { get: () => artistHtml },
    artSrc: { get: () => artSrc },
    artWarmed: { get: () => artWarmed },
    askState: { get: () => askState },
    backLayers: { get: () => backLayers },
    closeModal: { get: () => closeModal },
    closeSheet: { get: () => closeSheet },
    cssUrl: { get: () => cssUrl },
    currentTab: { get: () => currentTab, set: value => { currentTab = value; } },
    dismissViaHistory: { get: () => dismissViaHistory },
    emptyState: { get: () => emptyState },
    esc: { get: () => esc },
    fmt: { get: () => fmt },
    fmtSubs: { get: () => fmtSubs },
    fmtViews: { get: () => fmtViews },
    forceRefresh: { get: () => forceRefresh },
    gridCard: { get: () => gridCard },
    gridCardArt: { get: () => gridCardArt },
    homeFilter: { get: () => homeFilter },
    libraryFilter: { get: () => libraryFilter, set: value => { libraryFilter = value; } },
    libraryQuery: { get: () => libraryQuery, set: value => { libraryQuery = value; } },
    libraryTimer: { get: () => libraryTimer, set: value => { libraryTimer = value; } },
    markLocalRows: { get: () => markLocalRows },
    markNowPlaying: { get: () => markNowPlaying },
    markStale: { get: () => markStale },
    modalCleanup: { get: () => modalCleanup, set: value => { modalCleanup = value; } },
    openModal: { get: () => openModal },
    openSheet: { get: () => openSheet },
    paint: { get: () => paint },
    PLAY_ICON: { get: () => PLAY_ICON },
    playlistPlaybackOptions: { get: () => playlistPlaybackOptions },
    playSelection: { get: () => playSelection },
    popSubView: { get: () => popSubView },
    promptModal: { get: () => promptModal },
    pushSubView: { get: () => pushSubView },
    queueSelection: { get: () => queueSelection },
    refreshIfStale: { get: () => refreshIfStale },
    refreshing: { get: () => refreshing },
    restoreViewScroll: { get: () => restoreViewScroll },
    rowDlBtn: { get: () => rowDlBtn },
    scrimEl: { get: () => scrimEl },
    setViewMotion: { get: () => setViewMotion },
    sheetEl: { get: () => sheetEl },
    spendEntry: { get: () => spendEntry },
    spendSubViewEntries: { get: () => spendSubViewEntries },
    subView: { get: () => subView, set: value => { subView = value; } },
    subViewScrollStack: { get: () => subViewScrollStack, set: value => { subViewScrollStack = value; } },
    subViewStack: { get: () => subViewStack, set: value => { subViewStack = value; } },
    syncChrome: { get: () => syncChrome },
    syncPrivateButton: { get: () => syncPrivateButton },
    syncStatusPainter: { get: () => syncStatusPainter, set: value => { syncStatusPainter = value; } },
    syncStatusSubscribed: { get: () => syncStatusSubscribed, set: value => { syncStatusSubscribed = value; } },
    tabScroll: { get: () => tabScroll },
    textZoom: { get: () => textZoom },
    toast: { get: () => toast },
    trackRow: { get: () => trackRow },
    view: { get: () => view },
    viewStale: { get: () => viewStale, set: value => { viewStale = value; } },
    warmLocalArt: { get: () => warmLocalArt }
  });

  // The same number as CACHE in sw.js; a test holds the two together.
  const APP_VERSION = "v204";
  const view = /** @type {PaintedElement} */ (document.getElementById("view"));
  const sheetEl = document.getElementById("sheet");
  const scrimEl = document.getElementById("scrim");
  const modalEl = document.getElementById("modal");
  const toastsEl = document.getElementById("toasts");
  const queueSelection = { session: null, active: false, ids: new Set() };

  let currentTab = "home";
  let subView = null;
  let subViewStack = [];
  let subViewScrollStack = [];
  let syncStatusPainter = null;
  let syncStatusSubscribed = false;
  let libraryFilter = "playlists";
  let libraryQuery = "";
  let libraryTimer = null;
  let homeFilter = "all";
  let askState = { prompt: "", spoken: false, status: "idle", step: "", error: "", name: "", tracks: [], notFound: 0 };
  const tabScroll = { home: 0, search: 0, library: 0, ai: 0 };
  let viewEnterTimer = null;

  function playlistPlaybackOptions(ctx) {
    return /^(pl|shared):/.test(ctx || "") ? { shuffle: false } : undefined;
  }

  function playSelection(tracks, index, options) {
    if (Player.shareSession && Player.shareSession()) {
      toast(Player.addToQueue(tracks[index]) ? "Added to AuraShare" : "Already in AuraShare");
    } else Player.playQueue(tracks, index, options);
  }

  function setViewMotion(animate) {
    if (viewEnterTimer) clearTimeout(viewEnterTimer);
    view.classList.remove("view-enter");
    if (!animate || document.documentElement.classList.contains("no-anim") ||
        matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    void view.offsetWidth;
    view.classList.add("view-enter");
    viewEnterTimer = setTimeout(() => {
      view.classList.remove("view-enter");
      viewEnterTimer = null;
    }, 380);
  }

  // Lit in the accent while a session runs, grey while it does not, and absent altogether
  // when Settings hides the feature - a control that decides what gets written down has to
  // say which of the two it is doing without being tapped.
  /** Shows or hides the private session button to match the settings. */
  function syncPrivateButton() {
    const btn = document.getElementById("btn-private");
    if (!btn) return;
    const on = Store.privateSession();
    btn.hidden = Store.settings().privateSession === false || currentTab !== "home" || !!subView;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Private session on - tap to stop" : "Start a private session");
  }

  function syncChrome(title) {
    const heading = document.getElementById("app-heading");
    const search = document.getElementById("btn-goto-discover");
    const add = document.getElementById("btn-library-add");
    const settings = document.getElementById("btn-settings");
    const homeFilters = document.getElementById("home-top-filters");
    const homeMode = currentTab === "home" && !subView;
    const onSettings = !!subView && subView.kind === "settings";
    // Ask is a text box and a sentence about what to type in it. A second way to search and
    // a cog for a screen the profile circle already opens are both noise on top of that -
    // the circle is the way to Settings on every screen, so nothing is lost by dropping it.
    const askMode = currentTab === "ai" && !subView;
    // Library carries its own search box under the title, and the profile circle is the way
    // to Settings, so the top row there is the plus alone.
    const libraryMode = currentTab === "library" && !subView;
    if (heading) heading.textContent = title || "Aura";
    if (heading) heading.hidden = homeMode;
    if (search) search.hidden = currentTab === "search" || onSettings || askMode || libraryMode;
    if (add) add.hidden = !libraryMode;
    if (settings) settings.hidden = currentTab === "search" || homeMode || onSettings || askMode || libraryMode;
    if (homeFilters) {
      homeFilters.hidden = !homeMode;
      // Keep the controls mounted so color transitions, press feedback and keyboard
      // focus survive a filter change or a background refresh.
      if (!homeFilters.firstChild) {
        homeFilters.setAttribute("role", "group");
        homeFilters.setAttribute("aria-label", "Home filters");
        homeFilters.innerHTML = [["all", "All"], ["music", "Music"], ["podcasts", "Podcasts"]].map(item =>
          '<button type="button" data-home-filter="' + item[0] + '">' + item[1] + '</button>'
        ).join("") + '<span class="home-filter-pill" aria-hidden="true"></span>';
        // Font loading or a narrower screen resizes the buttons; the pill follows at once.
        if (window.ResizeObserver) new ResizeObserver(() => placeHomeFilterPill(homeFilters, false)).observe(homeFilters);
      }
      /** @type {NodeListOf<HTMLButtonElement>} */ (homeFilters.querySelectorAll("[data-home-filter]")).forEach(button => {
        const selected = homeFilter === button.dataset.homeFilter;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.onclick = () => {
          if (homeFilter === button.dataset.homeFilter) return;
          homeFilter = button.dataset.homeFilter;
          V.render(true);
        };
      });
      if (homeMode) placeHomeFilterPill(homeFilters, true);
    }
    syncPrivateButton();
    const app = document.querySelector(".app");
    app.classList.toggle("home-mode", homeMode);
    app.classList.toggle("library-mode", libraryMode);
    app.classList.toggle("category-mode", !!subView && subView.kind === "category");
    // These are every subview that renders a CommonHeader-equivalent hero of its own
    // (back button plus, once scrolled, the sticky title bar) - the generic app chrome
    // steps aside the same way it already does for "category", rather than doubling up.
    app.classList.toggle("hero-mode", !!subView && HERO_SUBVIEW_KINDS.has(subView.kind));
  }
  // Lays the accent pill over the chosen filter. It slides only when it moves from one
  // button to another on screen; its first placement, or one after the row was hidden, lands
  // in place so it never sweeps in from the corner.
  function placeHomeFilterPill(row, animate) {
    const pill = row.querySelector(".home-filter-pill");
    const button = row.querySelector("[data-home-filter].active");
    if (!pill || !button || !button.offsetWidth) return;
    const x = button.offsetLeft + "px", y = button.offsetTop + "px", w = button.offsetWidth + "px", h = button.offsetHeight + "px";
    const moved = pill.style.getPropertyValue("--pill-x") !== x || pill.style.getPropertyValue("--pill-w") !== w;
    pill.classList.toggle("moving", animate && moved && pill.dataset.placed === "1");
    pill.style.setProperty("--pill-x", x);
    pill.style.setProperty("--pill-y", y);
    pill.style.setProperty("--pill-w", w);
    pill.style.setProperty("--pill-h", h);
    pill.dataset.placed = "1";
  }
  const HERO_SUBVIEW_KINDS = new Set(["album", "artist", "playlist", "downloaded", "liked", "likedPodcast", "shared", "ytArtist", "ytAlbum"]);

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
    const levels = (subView ? 1 : 0) + subViewStack.length;
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
    toast("Music keeps playing - use Home to listen in the background, or pause to exit");
  }

  window.addEventListener("popstate", () => {
    closingFromHistory = true;
    if (window.Log) {
      Log.add("nav", "popstate: syntheticBacks=" + syntheticBacks + " historyDepth=" + historyDepth +
        " modalHidden=" + modalEl.hidden + " sheetHidden=" + sheetEl.hidden + " subView=" + !!subView +
        " layers=" + backLayers.length);
    }
    try {
      if (syntheticBacks > 0) { syntheticBacks--; return; }
      // Sheets and modals float above every registered layer, including the full
      // player: dismissing one must spend its own entry, not close what shows beneath.
      if (!modalEl.hidden || !sheetEl.hidden) {
        if (historyDepth > 0) historyDepth--;
        if (!modalEl.hidden) { closeModal(); scrimEl.hidden = true; }
        else closeSheet();
        return;
      }
      if (closeTopBackLayer()) return;
      if (historyDepth > 0) historyDepth--;
      if (subView) popSubView();
      else holdExit();
    } finally {
      closingFromHistory = false;
    }
  });

  function pushSubView(next) {
    // The screen being covered keeps its own filter and sort, for the Back that
    // restores it; the new screen starts clean.
    if (subView) { subView.collectionQuery = V.collectionQuery; subView.collectionSort = V.collectionSort; }
    V.collectionQuery = "";
    V.collectionSort = "order";
    subViewStack.push(subView);
    subViewScrollStack.push(view.scrollTop);
    subView = next;
    pushHistory();
    V.render(true);
    restoreViewScroll(0);
  }
  function popSubView() {
    const restoreScroll = subViewScrollStack.pop() || 0;
    subView = subViewStack.pop() || null;
    V.collectionQuery = (subView && subView.collectionQuery) || "";
    V.collectionSort = (subView && subView.collectionSort) || "order";
    V.render(true);
    restoreViewScroll(restoreScroll);
  }

  // Setting this after a frame has already gone by paints the top of the new screen first
  // and then jumps - visible every time you back out of an album. Place it now, before
  // anything is painted, and keep the frame-later pass for lists that are still filling in.
  function restoreViewScroll(y) {
    view.scrollTop = y;
    requestAnimationFrame(() => {
      if (view.scrollTop !== y) view.scrollTop = y;
      V.syncHeroStickyBar();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // A literal apostrophe would close the url('...') early and silently blank the
  // blurred hero backdrop, so it is percent-encoded before the value ever reaches esc().
  function cssUrl(u) {
    return "url('" + esc(String(u || "").replace(/'/g, "%27")) + "')";
  }
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  // Counts come from public servers as they sent them, and go into markup: a number or nothing.
  function fmtViews(v) {
    if (v == null) return "";
    v = Number(v);
    if (!(v >= 0)) return "";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M views";
    if (v >= 1e3) return Math.round(v / 1e3) + "K views";
    return v + " views";
  }
  function fmtSubs(v) {
    v = Number(v);
    if (!(v > 0)) return "";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M followers";
    if (v >= 1e3) return Math.round(v / 1e3) + "K followers";
    return v + " followers";
  }

  // A toast raised while the app is hidden runs its whole life unseen, or is removed in
  // the same burst of overdue timers that shows it; it waits for the return instead.
  const pendingToasts = [];
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pendingToasts.splice(0).forEach(args => toast.apply(null, args));
  });

  /**
   * Shows a short message at the bottom of the screen. Held until the app is visible.
   * @param {string} msg
   * @param {"" | "err"} [kind] "err" replaces an error already showing.
   * @param {() => void} [undo] Adds an Undo button, and shows the toast longer.
   */
  function toast(msg, kind, undo) {
    if (document.hidden) {
      if (pendingToasts.length >= 3) pendingToasts.shift();
      pendingToasts.push([msg, kind, undo]);
      return;
    }
    const now = Date.now();
    const last = /** @type {typeof toast & { lastMessage?: string, lastAt?: number }} */ (toast);
    if (!undo && last.lastMessage === msg && now - last.lastAt < 1500) return;
    last.lastMessage = msg;
    last.lastAt = now;
    if (kind === "err") toastsEl.querySelectorAll(".toast.err").forEach(old => old.remove());
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    // An undoable action gets a way back, and longer to take it. The toast layer ignores
    // pointer events, so the one carrying a button has to take them itself.
    if (typeof undo === "function") {
      const action = document.createElement("button");
      action.className = "text-action";
      action.textContent = "Undo";
      action.onclick = () => {
        el.remove();
        undo();
        V.render();
        toast("Restored");
      };
      el.appendChild(action);
      el.style.pointerEvents = "auto";
    }
    toastsEl.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, undo ? 6000 : 2600);
  }

  function closeSheet() {
    V.resetQueueSelection();
    if (!sheetEl.hidden && !closingFromHistory && historyDepth > 0) handOverEntry();
    sheetEl.hidden = true;
    scrimEl.hidden = true;
    sheetEl.innerHTML = "";
    resetSheetDrag();
    sheetEl.classList.remove("expanded");
    if (window.SharedQueue) SharedQueue.refreshNotifications();
  }
  /**
   * Opens the bottom sheet with the given content.
   * @param {string} html Escaped already.
   * @param {boolean} [keepQueueSelection]
   */
  function openSheet(html, keepQueueSelection = false) {
    if (!keepQueueSelection) V.resetQueueSelection();
    if (sheetEl.hidden) pushHistory();
    resetSheetDrag();
    sheetEl.classList.remove("expanded");
    sheetEl.scrollTop = 0;
    sheetEl.innerHTML = html;
    sheetEl.hidden = false;
    scrimEl.hidden = false;
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
    sheetEl.style.maxHeight = (sheetDragBaseHeight + growth) + "px";
    const offset = sheetDragBaseY + Math.max(0, sheetDragY);
    sheetEl.style.transform = "translate3d(0," + offset + "px,0)";
  }

  function resetSheetDrag() {
    if (sheetDragFrame) cancelAnimationFrame(sheetDragFrame);
    sheetDragFrame = 0;
    sheetDragEligible = false;
    sheetDragging = false;
    sheetDragY = 0;
    sheetEl.classList.remove("dragging");
    sheetEl.style.removeProperty("transform");
    sheetEl.style.removeProperty("max-height");
  }

  sheetEl.addEventListener("touchstart", /** @param {TouchEvent & { target: HTMLElement }} e */ e => {
    sheetDragEligible = false;
    sheetSuppressClickUntil = 0;
    if (e.touches.length !== 1) { resetSheetDrag(); return; }
    if (sheetEl.hidden || sheetEl.scrollTop > 1 || e.target.closest("input, textarea, select")) return;
    // Options scroll normally in both sizes. Only the grab area and header move the
    // sheet, so looking through actions cannot repeatedly expand and collapse it.
    if (e.target !== sheetEl && !e.target.closest(sheetDragHandle)) return;
    sheetDragStartX = e.touches[0].clientX;
    sheetDragStartY = e.touches[0].clientY;
    sheetDragAt = performance.now();
    sheetDragY = 0;
    sheetDragEligible = true;
    sheetDragging = false;
  }, { passive: true });

  sheetEl.addEventListener("touchmove", e => {
    if (!sheetDragEligible) return;
    // Once native scrolling owns a touch it cannot be reclaimed halfway through.
    if (e.touches.length !== 1 || !e.cancelable) { resetSheetDrag(); return; }
    const dy = e.touches[0].clientY - sheetDragStartY;
    if (!sheetDragging) {
      const dx = e.touches[0].clientX - sheetDragStartX;
      if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy)) { sheetDragEligible = false; return; }
      if (sheetEl.scrollTop > 1) { sheetDragEligible = false; return; }
      if (Math.abs(dy) <= 6) return;
      if (dy < 0 && sheetEl.classList.contains("expanded")) { sheetDragEligible = false; return; }
      // Pick up the visible position even during entry or a previous snap. Otherwise
      // the entry animation overrides our transform, making the handle feel stuck.
      const box = sheetEl.getBoundingClientRect();
      const parentBox = sheetEl.parentElement.getBoundingClientRect();
      sheetDragBaseY = box.bottom - parentBox.bottom;
      sheetDragBaseHeight = box.height;
      sheetDragMaxHeight = parentBox.height - 10;
      for (const animation of sheetEl.getAnimations()) {
        if (/** @type {CSSAnimation} */ (animation).animationName === "sheet-in") animation.cancel();
      }
      sheetDragging = true;
      sheetEl.classList.add("dragging");
      sheetEl.style.maxHeight = box.height + "px";
    }
    sheetDragY = dy;
    // Upward drag resists, because the only thing it can do is snap to full height.
    if (!sheetDragFrame) {
      sheetDragFrame = requestAnimationFrame(paintSheetDrag);
    }
    e.preventDefault();
  }, { passive: false });

  sheetEl.addEventListener("touchend", () => {
    if (!sheetDragEligible) return;
    const elapsed = Math.max(1, performance.now() - sheetDragAt);
    const flick = Math.abs(sheetDragY) / elapsed > 0.6 && Math.abs(sheetDragY) > 40;
    const dragged = sheetDragging;
    const dy = sheetDragY;
    if (dragged) {
      sheetSuppressClickUntil = performance.now() + 400;
      // Commit the final finger position before starting the snap, including when
      // touchend arrives before the scheduled paint. Both transitions start here.
      if (sheetDragFrame) cancelAnimationFrame(sheetDragFrame);
      paintSheetDrag();
      sheetEl.getBoundingClientRect();
    }
    resetSheetDrag();
    if (!dragged) return;
    if (dy > 0 && (flick || dy > 110)) {
      if (sheetEl.classList.contains("expanded")) sheetEl.classList.remove("expanded");
      else dismissViaHistory(closeSheet);
    } else if (dy < 0 && (flick || dy < -60)) {
      sheetEl.classList.add("expanded");
    }
  }, { passive: true });

  sheetEl.addEventListener("touchcancel", resetSheetDrag, { passive: true });
  sheetEl.addEventListener("contextmenu", /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
    if (!e.target.closest("input, textarea, select") && e.target.closest("img, " + sheetDragHandle)) e.preventDefault();
  });
  sheetEl.addEventListener("click", e => {
    if (e.detail && performance.now() < sheetSuppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  scrimEl.addEventListener("click", () => dismissViaHistory(() => { closeSheet(); closeModal(); }));
  // Escape closes the dialog or sheet on top, the way Back and a tap outside do, so they can
  // be left from a keyboard. A control that answers Escape itself (a rename, a drag) has
  // already taken it.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || (modalEl.hidden && sheetEl.hidden)) return;
    e.preventDefault();
    dismissViaHistory(() => { closeSheet(); closeModal(); scrimEl.hidden = true; });
  });

  let modalCleanup = null;
  function closeModal() {
    if (modalCleanup) { const cleanup = modalCleanup; modalCleanup = null; cleanup(); }
    modalEl.hidden = true; modalEl.innerHTML = "";
  }
  function openModal(html) {
    if (modalCleanup) { const cleanup = modalCleanup; modalCleanup = null; cleanup(); }
    if (modalEl.hidden) pushHistory();
    modalEl.innerHTML = html;
    modalEl.hidden = false;
    scrimEl.hidden = false;
  }

  function promptModal(title, initial, onOk) {
    openModal(
      '<div class="modal"><h3>' + esc(title) + '</h3>' +
      '<input type="text" id="modal-input" dir="auto" value="' + esc(initial || "") + '" />' +
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
      dismissViaHistory(() => { closeModal(); scrimEl.hidden = true; });
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

  // The Text size setting scales the content of the view and of sheets with CSS zoom (see
  // app.css). A finger moves in screen pixels and a transform inside that content is drawn
  // in its own, larger ones, so a gesture divides what the finger travelled by this.
  function textZoom() {
    if (!document.documentElement.hasAttribute("data-text-size")) return 1;
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-zoom")) || 1;
  }

  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 21,12 7,20"/></svg>';

  const ROW_DL_ICONS =
    '<svg class="i-dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    '<svg class="i-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
    '<span class="ring"></span>';

  function rowDlBtn(id) {
    return '<button class="row-dl" data-dl="' + esc(id) + '" aria-label="Save offline">' + ROW_DL_ICONS + '</button>';
  }

  function markLocalRows() {
    // The tick means downloaded, not "happens to be in the cache right now".
    Player.downloadedIds().then(set => {
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".row-dl[data-dl]")).forEach(b => {
        const state = Player.downloadStatus ? Player.downloadStatus(b.dataset.dl) : null;
        // A queued or failed download is worth seeing on the row it belongs to, rather than
        // only in a toast that has already gone.
        b.classList.toggle("busy", state === "pending" || state === "busy");
        const nowDone = set.has(b.dataset.dl) || state === "done";
        if (nowDone && !b.classList.contains("done")) b.classList.add("rn-pop");
        b.classList.toggle("done", nowDone);
        b.title = state === "failed" ? "Download failed - tap to try again" : "";
      });
    });
  }

  Player.onChange(ev => {
    if (ev.type === "remote") V.syncRemoteMenu();
    if (ev.type === "queue" || ev.type === "track" || ev.type === "restored") V.refreshQueueSheet();
    if (ev.type !== "downloads") return;
    markLocalRows();
    warmLocalArt();
    const dlHolder = document.getElementById("downloaded-library");
    if (dlHolder && dlHolder.isConnected) V.fillDownloadedLibrary();
    if (subView && subView.kind === "downloaded") V.fillHomeDownloaded();
  });

  // What the home page shows is built from these. When one of them moves, the screen is
  // out of date and has to catch up - that is the only thing that should trigger a repaint.
  // Signal back: whatever failed while there was none is worth asking for again - and
  // only that. This was the pull gesture's full refresh, which threw away every saved
  // Home row on each flicker of the connection, left a failed artist or album page on
  // its error, and replaced the field under whoever was typing.
  window.addEventListener("online", () => {
    if (window.Log) Log.add("network", "back online, asking again for what failed");
    Object.keys(V.homeFeeds).forEach(key => {
      if (V.homeFeeds[key].sections.some(section => section.status === "error")) delete V.homeFeeds[key];
    });
    delete V.aiHomeSection.failedAt;
    // fetched is what stops a shared list asking twice; left set, the cleared error became
    // a spinner with no request behind it and no button to start one.
    if (subView && subView.error) { subView.error = null; subView.loading = false; subView.fetched = false; }
    const field = document.activeElement;
    if (document.hidden || (field && view.contains(field) && field.matches("input, textarea"))) { markStale(); return; }
    if (currentTab === "search" && !subView && V.discoverState.error && V.discoverState.q) V.doSearch(V.discoverState.q);
    else V.render();
  });

  Store.onChange(what => {
    if (what === "recents" || what === "library" || what === "playlists" || what === "downloads") markStale();
  });

  // Pictures kept with the downloads, as object URLs, so every list that draws art can
  // reach them without going near the network. Warmed once and kept - a cover is a few
  // tens of kilobytes and the alternative is an empty square with no signal.
  const localArt = new Map();
  let artWarmed = false;

  async function warmLocalArt() {
    if (!Player.artIds) return;
    const ids = await Player.artIds();
    let added = 0;
    for (const id of ids) {
      if (localArt.has(id)) continue;
      const blob = await Player.getArt(id);
      if (!blob) continue;
      localArt.set(id, URL.createObjectURL(blob));
      added++;
    }
    artWarmed = true;
    // A repaint here replaced the screen under the reader (the filter box being typed
    // in, an inline rename) every time a download finished; the next natural render
    // picks the local artwork up.
    if (added) markStale();
    // The player bar draws the current song's cover and has no render of its own to wait for.
    if (added && Player.current() && localArt.has(Player.current().id)) window.dispatchEvent(new Event("aura-local-art"));
  }

  /**
   * @param {Track} track
   * @returns {string} The saved cover when there is one, otherwise the remote one.
   */
  function artSrc(track) {
    return localArt.get(track.id) || track.thumb || Api.thumbFor(track.id);
  }

  function artHtml(track, cls) {
    const src = artSrc(track);
    const active = Player.current() && Player.current().id === track.id;
    return '<div class="art ' + (cls || "") + '"><img decoding="async" src="' + esc(src) + '" loading="lazy" alt="" />' +
      '<div class="eq"' + (active ? "" : " hidden") + '><span></span><span></span><span></span><span></span></div></div>';
  }

  function artistHtml(track) {
    if (!track.artistId) return esc(track.artist || "");
    return '<button class="track-artist" dir="auto" data-trackartist="' + esc(track.artistId) + '" data-trackartistname="' + esc(track.artist || "") + '" data-trackartistthumb="' + esc(track.artistThumb || "") + '">' + esc(track.artist || "") + '</button>';
  }

  // Assigning innerHTML throws away every node and every decoded image, so a repaint that
  // produces identical markup still costs a visible flash - the "refreshing a web page"
  // feeling. Writing only when the markup actually differs makes a redundant render free.
  function paint(el, html) {
    if (!el) return false;
    // The remembered markup is only good while the nodes it produced are still the ones
    // in place. Anything else writing here - a subview, a collection page - replaces them,
    // and skipping then would leave the wrong screen up.
    if (el.__painted === html && el.firstChild && el.firstChild === el.__paintedNode) return false;
    el.__painted = html;
    el.innerHTML = html;
    el.__paintedNode = el.firstChild;
    return true;
  }

  function trackRow(track, ctx) {
    const cur = Player.current();
    const active = cur && cur.id === track.id;
    return '<li class="song' + (active ? " active" : "") + '" data-id="' + esc(track.id) + '" data-ctx="' + esc(ctx || "") + '">' +
      artHtml(track, "lg") +
      '<div class="meta"><div class="song-title" dir="auto">' + esc(track.title) + '</div>' +
      '<div class="song-sub" dir="auto">' + artistHtml(track) + (track.duration ? ' <span class="dot">·</span> ' + fmt(track.duration) : "") + '</div></div>' +
      rowDlBtn(track.id) +
      '<button class="kebab" data-menu="' + esc(track.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>';
  }

  // Changing track used to rebuild the whole screen. Every image was thrown away and
  // fetched again - the black flash - and the home page recomputed itself, so the rows
  // silently became different songs while the listener was reading them. The only thing
  // that actually changes on a track change is which row is the current one.
  // Removing the repaint-on-every-track-change fixed the flashing, and took the live
  // updates with it: a song finished, recents changed, and "Jump back in" never noticed.
  // The data changing is the reason to repaint - but not underneath someone reading the
  // screen. If the screen is covered, repaint now; if it is being looked at, wait until
  // they come back to it.
  let viewStale = false;

  function screenCovered() {
    if (document.hidden) return true;
    const fp = document.getElementById("fullplayer");
    if (fp && !fp.hidden) return true;
    return !modalEl.hidden || !sheetEl.hidden;
  }

  // Everything the home page builds itself from, thrown away so the next render goes and
  // asks again. Used by the pull gesture and by the network coming back.
  let refreshing = false;

  async function forceRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      // With no signal there is nothing to ask again, and the saved rows are all Home has:
      // a pull on a plane used to trade them for five rows of "Couldn't load".
      if (navigator.onLine !== false) {
        Object.keys(V.homeFeeds).forEach(key => delete V.homeFeeds[key]);
        V.homeRecs.items = [];
        try { localStorage.removeItem("aura.homeFeeds"); } catch (e) {}
        try { localStorage.removeItem("aura.homeRecs"); } catch (e) {}
      } else toast("You're offline - showing what's saved on this device");
      V.homeDownloads.loaded = false;
      view.__painted = null;
      V.render();
      // Long enough that the gesture reads as having done something, short enough that it
      // is never in the way.
      await new Promise(r => setTimeout(r, 450));
    } finally {
      refreshing = false;
    }
  }

  function markStale() {
    // Hidden is not covered: a repaint there, with the network work Home does, is spent
    // on a screen nobody sees. It waits for the return, when refreshIfStale runs.
    if (document.hidden) { viewStale = true; return; }
    if (screenCovered()) { V.render(); return; }
    viewStale = true;
  }

  /** Renders the current screen when a change arrived while it was hidden. */
  function refreshIfStale() {
    if (!viewStale) return;
    viewStale = false;
    V.render();
  }

  /** Moves the playing marker to the current track without a full render. */
  function markNowPlaying() {
    const cur = Player.current();
    const id = cur ? cur.id : null;
    /** @type {NodeListOf<HTMLElement>} */ (view.querySelectorAll('.quick-tile[data-recent]')).forEach(el => {
      const active = el.dataset.recent === id;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    });
    /** @type {NodeListOf<HTMLElement>} */ (view.querySelectorAll(".song.active, .song-row.active, .dr.active")).forEach(el => {
      if (el.dataset.id !== id) markRowPlaying(el, false);
    });
    if (!id) return;
    /** @type {NodeListOf<HTMLElement>} */ (view.querySelectorAll('.song[data-id], .song-row[data-id], .dr[data-id]')).forEach(el => {
      markRowPlaying(el, el.dataset.id === id);
    });
  }

  // The pulsing bars are baked into the artwork markup at render time; a track change
  // repaints nothing, so they have to move with the highlight or they stay on the song
  // that was playing when the list was drawn.
  function markRowPlaying(el, active) {
    el.classList.toggle("active", active);
    const eq = el.querySelector(".eq");
    if (eq) eq.hidden = !active;
    const fab = el.classList.contains("dr") && el.querySelector(".play-fab");
    if (fab) fab.hidden = active;
  }

  function emptyState(title, sub, cta) {
    return '<div class="empty"><div class="empty-orb"></div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p>' +
      (cta ? '<button class="btn primary lg" id="empty-cta">' + esc(cta) + '</button>' : "") + '</div>';
  }

  function gridCard(thumb, title, sub, data, playable) {
    return gridCardArt(thumb ? '<img decoding="async" src="' + esc(thumb) + '" loading="lazy" alt="" />' : '<div class="image-missing"></div>', title, sub, data, playable);
  }

  // The same card with its artwork handed in as markup, for the one thing that is not a
  // single picture: a playlist wearing the songs inside it.
  function gridCardArt(art, title, sub, data, playable) {
    return '<button class="card" ' + data + '><div class="card-art">' + art +
      (playable ? '<div class="play-fab" data-play="1"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 21,12 7,20"/></svg></div>' : "") +
      '</div><div class="card-title" dir="auto">' + esc(title) + '</div><div class="card-sub" dir="auto">' + esc(sub) + '</div></button>';
  }
})();
