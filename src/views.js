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
    askState: { get: () => askState },
    cssUrl: { get: () => cssUrl },
    currentTab: { get: () => currentTab, set: value => { currentTab = value; } },
    emptyState: { get: () => emptyState },
    esc: { get: () => esc },
    fmt: { get: () => fmt },
    fmtSubs: { get: () => fmtSubs },
    fmtViews: { get: () => fmtViews },
    gridCard: { get: () => gridCard },
    gridCardArt: { get: () => gridCardArt },
    homeFilter: { get: () => homeFilter },
    libraryFilter: { get: () => libraryFilter, set: value => { libraryFilter = value; } },
    libraryQuery: { get: () => libraryQuery, set: value => { libraryQuery = value; } },
    libraryTimer: { get: () => libraryTimer, set: value => { libraryTimer = value; } },
    modalEl: { get: () => modalEl },
    paint: { get: () => paint },
    playlistPlaybackOptions: { get: () => playlistPlaybackOptions },
    playSelection: { get: () => playSelection },
    queueSelection: { get: () => queueSelection },
    scrimEl: { get: () => scrimEl },
    setViewMotion: { get: () => setViewMotion },
    sheetEl: { get: () => sheetEl },
    shuffleSelection: { get: () => shuffleSelection },
    subView: { get: () => subView, set: value => { subView = value; } },
    subViewScrollStack: { get: () => subViewScrollStack, set: value => { subViewScrollStack = value; } },
    subViewStack: { get: () => subViewStack, set: value => { subViewStack = value; } },
    syncChrome: { get: () => syncChrome },
    syncPrivateButton: { get: () => syncPrivateButton },
    syncStatusPainter: { get: () => syncStatusPainter, set: value => { syncStatusPainter = value; } },
    syncStatusSubscribed: { get: () => syncStatusSubscribed, set: value => { syncStatusSubscribed = value; } },
    tabScroll: { get: () => tabScroll },
    ticket: { get: () => ticket },
    toast: { get: () => toast },
    trackRow: { get: () => trackRow },
    view: { get: () => view }
  });

  // The same number as CACHE in sw.js; a test holds the two together.
  const APP_VERSION = "v244";
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
  let askState = { prompt: "", asked: "", spoken: false, status: "idle", step: "", error: "", name: "", tracks: [], notFound: 0 };
  const tabScroll = { home: 0, search: 0, library: 0, ai: 0 };
  let viewEnterTimer = null;

  // Every screen fill that waits on the network takes a ticket first and asks it before
  // writing anything back. The ticket is good while no newer fill of the same scope has
  // begun and, when the fill was for a screen, while that screen is still up. Without it
  // the answer to an earlier question lands on a later screen: a search typed over, a
  // playlist backed out of, a feed key that moved while its rows loaded.
  const tickets = new Map();
  /**
   * @param {string} scope What is being filled: "search", "home-feeds", "artist".
   * @param {{ tab?: string, subView?: Object | null }} [screen] The screen the fill is for:
   *   its tab, and the subview it belongs to (null for the tab's own page).
   * @returns {() => boolean} True while the answer still has a place to land.
   */
  function ticket(scope, screen) {
    const serial = (tickets.get(scope) || 0) + 1;
    tickets.set(scope, serial);
    return () => tickets.get(scope) === serial &&
      (!screen || ((screen.tab === undefined || currentTab === screen.tab) &&
        (screen.subView === undefined || subView === screen.subView)));
  }

  // A queue started from one of the listener's own playlists says which: a private
  // playlist keeps what plays from it out of history, and the player has to know where
  // the songs came from to honour that.
  function playlistPlaybackOptions(ctx) {
    if (!/^(pl|shared):/.test(ctx || "")) return undefined;
    return ctx.startsWith("pl:") ? { shuffle: false, playlist: ctx.slice(3) } : { shuffle: false };
  }

  function playSelection(tracks, index, options) {
    if (Player.shareSession && Player.shareSession()) {
      toast(Player.addToQueue(tracks[index]) ? "Added to AuraShare" : "Already in AuraShare");
    } else Player.playQueue(tracks, index, options);
  }

  // Shuffle is a queue-wide setting a shared queue does not take, and a shared queue
  // takes a list from its start index on: there the whole list goes in, in a random
  // order, rather than the random tail of it that starting at a random index gave.
  function shuffleSelection(tracks, ctx) {
    if (!tracks.length) return;
    if (Player.shareSession && Player.shareSession()) {
      const order = tracks.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = order[i]; order[i] = order[j]; order[j] = swap;
      }
      Player.playQueue(order, 0);
      return;
    }
    Player.setShuffle(true);
    const from = playlistPlaybackOptions(ctx);
    Player.playQueue(tracks, Math.floor(Math.random() * tracks.length), from && from.playlist ? { playlist: from.playlist } : undefined);
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

  Player.onChange(ev => {
    if (ev.type === "remote") V.syncRemoteMenu();
    if (ev.type === "queue" || ev.type === "track" || ev.type === "restored") V.refreshQueueSheet();
    if (ev.type !== "downloads") return;
    V.markLocalRows();
    V.warmLocalArt();
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
    if (document.hidden || (field && view.contains(field) && (field.matches("input, textarea") || /** @type {HTMLElement} */ (field).isContentEditable))) { V.markStale(); return; }
    if (currentTab === "search" && !subView && V.discoverState.error && V.discoverState.q) V.doSearch(V.discoverState.q);
    else V.render();
  });

  Store.onChange(what => {
    if (what === "recents" || what === "library" || what === "playlists" || what === "downloads") V.markStale();
  });

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
      V.artHtml(track, "lg") +
      '<div class="meta"><div class="song-title" dir="auto">' + esc(track.title) + '</div>' +
      '<div class="song-sub" dir="auto">' + V.artistHtml(track) + (track.duration ? ' <span class="dot">·</span> ' + fmt(track.duration) : "") + '</div></div>' +
      V.rowDlBtn(track.id) +
      '<button class="kebab" data-menu="' + esc(track.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>';
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
