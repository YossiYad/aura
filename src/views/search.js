(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    BLOCKED_MSG: { get: () => BLOCKED_MSG },
    blockedAvoidLabels: { get: () => blockedAvoidLabels },
    cancelLiveSearch: { get: () => cancelLiveSearch },
    discoverState: { get: () => discoverState },
    doSearch: { get: () => doSearch },
    drRow: { get: () => drRow },
    renderSearch: { get: () => renderSearch },
    unblocked: { get: () => unblocked },
    watchLoadMore: { get: () => watchLoadMore }
  });

  // ---------------- Search ----------------

  /**
   * What the search screen shows for the query typed into it.
   * @typedef {Object} DiscoverState
   * @property {string} q
   * @property {Track[]} items
   * @property {ArtistSummary[]} artists
   * @property {string} source
   * @property {boolean} busy
   * @property {string | null} error
   * @property {SourceKind | "proxy" | null} kind
   * @property {string | null} nextpage
   * @property {string} [base]
   * @property {string} [filter]
   * @property {number} [page]
   * @property {boolean} [loadingMore] While the next page is being fetched.
   * @property {boolean} [moreError] The next page failed, so scrolling no longer loads more by itself.
   */
  /** @type {DiscoverState} */
  let discoverState = { q: "", items: [], artists: [], source: "", busy: false, error: null, kind: null, nextpage: null, loadingMore: false };

  function drRow(t) {
    const inPlaylist = Store.playlists().some(p => p.ids.includes(t.id));
    const active = Player.current() && Player.current().id === t.id;
    return '<li class="dr' + (active ? " active" : "") + '" data-id="' + V.esc(t.id) + '">' +
      '<div class="dr-thumb"><img decoding="async" src="' + V.esc(t.thumb) + '" loading="lazy" alt="" />' +
      // Both are drawn and one is hidden, so markNowPlaying can move the bars to whichever
      // result is playing without the list being painted again.
      '<div class="eq"' + (active ? "" : " hidden") + ' style="position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:8px;background:rgba(0,0,0,.55)"><span></span><span></span><span></span><span></span></div>' +
      '<div class="play-fab" data-play="1"' + (active ? " hidden" : "") + '>' + V.PLAY_ICON + '</div>' +
      '<span class="duration">' + V.fmt(t.duration) + '</span></div>' +
      '<div class="meta"><div class="title" dir="auto">' + V.esc(t.title) + '</div><div class="sub" dir="auto">' + V.artistHtml(t) + (t.views != null && t.views >= 0 ? " · " + V.fmtViews(t.views) : "") + '</div></div>' +
      V.rowDlBtn(t.id) +
      (inPlaylist
        ? '<button class="add-btn added" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Added</button>'
        : '<button class="add-btn add" data-add="' + V.esc(t.id) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add</button>') +
      '<button class="kebab" data-menu="' + V.esc(t.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>' +
      '</li>';
  }

  const BLOCKED_MSG = "Blocked - unblock it in Settings";
  function unblocked(list) { return list.filter(t => !Store.isBlocked(t)); }

  // Fed to the AI prompt so blocked songs and artists are not suggested in the first
  // place; matching filters whatever slips through anyway.
  function blockedAvoidLabels() {
    const list = Store.blockedList();
    return list.tracks.filter(t => t.title).map(t => t.title + (t.artist ? " - " + t.artist : "")).concat(list.artists);
  }

  function ytResultsHtml(d) {
    const items = unblocked(d.items);
    return (d.busy ? '<div class="status-line"><span class="ring"></span> Searching YouTube…</div>' :
      d.error ? '<div class="status-line err">' + V.esc(d.error) + '</div>' +
        '<div class="row-actions"><button class="btn ghost" id="search-retry">Try again</button></div>' :
      items.length ? '<div class="status-line"><span class="results-count">' + items.length + ' results</span><span style="color:var(--fg-faint)">·</span><span class="via">via ' + V.esc(d.source) + '</span></div>' : "") +
      (d.artists.length
        ? '<h3 class="section-title">Artists</h3><div class="rail artists">' + d.artists.map(a =>
            '<button class="card" data-ytartist="' + V.esc(a.id) + '" data-ytname="' + V.esc(a.name) + '" data-ytthumb="' + V.esc(a.thumb) + '">' +
            '<div class="card-art"><img decoding="async" src="' + V.esc(a.thumb) + '" loading="lazy" alt="" /></div>' +
            '<div class="card-title" dir="auto">' + V.esc(a.name) + '</div><div class="card-sub">' + V.fmtSubs(a.subscribers) + '</div></button>'
          ).join("") + '</div>'
        : "") +
      (items.length ? '<h3 class="section-title">Songs</h3>' : "") +
      '<ul class="song-list">' + items.map(drRow).join("") + '</ul>' +
      (items.length && d.nextpage
        ? '<div class="load-more-wrap"><button class="btn ghost" id="load-more">' + (d.loadingMore ? '<span class="ring"></span> Loading…' : "Load more") + '</button></div>'
        : "") +
      (items.length ? '<p class="footnote">Tap the play button to listen instantly. Swipe a song right to queue it, left to keep it - pull further for the second action.</p>' : "");
  }

  /**
   * @param {string} [q]
   * @returns {DiscoverState}
   */
  function emptyDiscoverState(q) {
    return { q: q || "", items: [], artists: [], source: "", busy: false, error: null, kind: null, nextpage: null };
  }

  function searchDiscoveryHtml() {
    const d = discoverState;
    if (d.q || d.items.length) return "";
    const searches = Store.searches();
    return '<section class="search-discovery">' +
      (searches.length ? '<div class="section-head"><h3>Recent searches</h3><button id="clear-searches">Clear</button></div><div class="recent-searches">' + searches.map(q => '<button data-search="' + V.esc(q) + '">' + V.esc(q) + '</button>').join("") + '</div>' : "") +
      V.freshSearchHtml() + '<h3 class="search-browse-head">Browse all</h3>' + V.browseHtml() + '</section>';
  }

  // Reaching the end of a list is itself the request for more, so the button fires when it
  // scrolls into view. It stays in the DOM and still works on tap, as the fallback for
  // browsers without IntersectionObserver and for anyone who reaches for it.
  let loadMoreWatcher = null;
  function watchLoadMore(el, run) {
    if (loadMoreWatcher) { loadMoreWatcher.disconnect(); loadMoreWatcher = null; }
    if (!el || typeof IntersectionObserver !== "function") return;
    loadMoreWatcher = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) run();
    }, { root: V.view, rootMargin: "300px" });
    loadMoreWatcher.observe(el);
  }

  // A lyric is cached for anything whose words were ever looked up, which is a wider set
  // than the library - a song played once from search has them too.
  function knownTrack(id) {
    return Store.findTrack(id) || Store.recents().find(track => track.id === id) || null;
  }

  function lyricHitRow(track, line) {
    const cur = Player.current();
    const active = cur && cur.id === track.id;
    return '<li class="song' + (active ? " active" : "") + '" data-id="' + V.esc(track.id) + '" data-ctx="library">' +
      V.artHtml(track, "lg") +
      '<div class="meta"><div class="song-title" dir="auto">' + V.esc(track.title) + '</div>' +
      '<div class="song-sub lyric-hit" dir="auto">' + V.esc(line) + '</div></div>' +
      V.rowDlBtn(track.id) +
      '<button class="kebab" data-menu="' + V.esc(track.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>';
  }

  function renderSearchHits() {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    const hits = document.getElementById("lib-hits");
    if (!input || !hits) return;
    const q = input.value.trim().toLowerCase();
    const matches = q ? Store.library().filter(t => !Store.isBlocked(t) && Store.matchesQuery(q, t.title, t.artist)).slice(0, 10) : [];
    // Titles first, then the songs that only matched on their words - a listener typing a
    // title wants the title, and one typing a half-remembered line has nothing else to go
    // on. Anything already listed above is not repeated down here.
    const seen = new Set(matches.map(track => track.id));
    const lyricHits = (q ? Store.searchLyrics(q, 8) : [])
      .map(hit => ({ line: hit.line, track: knownTrack(hit.id) }))
      .filter(hit => hit.track && !seen.has(hit.track.id) && !Store.isBlocked(hit.track));
    hits.innerHTML =
      (matches.length
        ? '<div class="status-line">In your library</div><ul class="song-list">' + matches.map(t => V.trackRow(t, "library")).join("") + '</ul>'
        : "") +
      (lyricHits.length
        ? '<div class="status-line">Matching lyrics</div><ul class="song-list">' +
          lyricHits.map(hit => lyricHitRow(hit.track, hit.line)).join("") + '</ul>'
        : "");
  }

  // Recent searches narrowed to whatever is being typed, so a returning query costs a
  // tap rather than a retyping. Hidden the moment a search actually commits, so it
  // never fights the results it just produced.
  let committedSearchQ = null;

  function renderSearchSuggestions(raw) {
    const box = document.getElementById("search-suggest");
    if (!box) return;
    const value = String(raw || "").trim();
    const matches = !value || value === committedSearchQ ? [] :
      Store.searches().filter(s =>
        s !== value && Store.foldText(s).indexOf(Store.foldText(value)) !== -1
      ).slice(0, 6);
    box.innerHTML = matches.length
      ? '<div class="section-head"><h3>Suggestions</h3></div><div class="recent-searches">' +
        matches.map(q => '<button data-search="' + V.esc(q) + '">' + V.esc(q) + '</button>').join("") + '</div>'
      : "";
  }

  // Repaints everything on the search tab except the text field itself, so typing
  // is never interrupted by a re-render (results, playback events, store updates).
  function refreshSearchView() {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    if (!input) return false;
    const clear = document.getElementById("disc-clear");
    if (clear) clear.style.display = input.value ? "" : "none";
    renderSearchSuggestions(input.value);
    const discovery = document.getElementById("search-discovery");
    if (discovery) discovery.innerHTML = searchDiscoveryHtml();
    const results = document.getElementById("yt-results");
    if (results) results.innerHTML = ytResultsHtml(discoverState);
    renderSearchHits();
    const more = document.getElementById("load-more");
    if (more) more.onclick = () => loadMore();
    watchLoadMore(discoverState.moreError ? null : more, loadMore);
    const retry = document.getElementById("search-retry");
    if (retry) retry.onclick = () => doSearch(discoverState.q);
    const clearSearches = document.getElementById("clear-searches");
    if (clearSearches) clearSearches.onclick = () => { Store.clearSearches(); refreshSearchView(); };
    return true;
  }

  let liveSearchTimer = null;
  function cancelLiveSearch() {
    clearTimeout(liveSearchTimer);
    liveSearchTimer = null;
  }
  function renderSearch() {
    if (refreshSearchView()) return;
    const d = discoverState;
    V.view.innerHTML =
      '<div class="search-wrap"><div class="search-input">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
      '<input type="search" id="disc-input" dir="auto" enterkeyhint="search" placeholder="Search any song, artist, album…" value="' + V.esc(d.q) + '" />' +
      '<button class="search-clear" id="disc-clear"' + (d.q ? "" : ' style="display:none"') + '>×</button>' +
      (Voice.supported() ? tr('<button class="search-mic" id="disc-mic" aria-label="בקשה קולית">') +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg></button>' : "") +
      '</div></div>' +
      '<div id="search-suggest"></div>' +
      '<div id="lib-hits"></div>' +
      '<div id="search-discovery">' + searchDiscoveryHtml() + '</div>' +
      '<div id="yt-results">' + ytResultsHtml(d) + '</div>';

    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    cancelLiveSearch();
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { cancelLiveSearch(); committedSearchQ = input.value.trim(); input.blur(); doSearch(input.value.trim()); }
    });
    const mic = document.getElementById("disc-mic");
    if (mic) mic.onclick = () => { Views.showTab("ai"); V.voiceStart("ask"); };
    document.getElementById("disc-clear").onclick = () => {
      cancelLiveSearch();
      V.ticket("search");
      committedSearchQ = null;
      input.value = "";
      discoverState = emptyDiscoverState();
      refreshSearchView();
      input.focus();
    };
    input.addEventListener("input", () => {
      cancelLiveSearch();
      const value = input.value.trim();
      if (value !== discoverState.q) {
        // A new ticket for nobody: the search in flight finds its own stale.
        V.ticket("search");
        if (discoverState.busy) discoverState = emptyDiscoverState();
      }
      if (!value && discoverState.q) discoverState = emptyDiscoverState();
      refreshSearchView();
      if (value.length >= 2 && value !== discoverState.q) liveSearchTimer = setTimeout(() => doSearch(value), 450);
    });
    renderSearchHits();
    const more = document.getElementById("load-more");
    if (more) more.onclick = () => loadMore();
    watchLoadMore(discoverState.moreError ? null : more, loadMore);
    const retry = document.getElementById("search-retry");
    if (retry) retry.onclick = () => doSearch(discoverState.q);
    const clearSearches = document.getElementById("clear-searches");
    if (clearSearches) clearSearches.onclick = () => { Store.clearSearches(); refreshSearchView(); };
  }

  function showSearchState(q) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    if (V.currentTab !== "search" || V.subView || !input) { V.render(); return; }
    if (q != null && document.activeElement !== input && input.value.trim() !== q) input.value = q;
    refreshSearchView();
  }

  async function doSearch(q) {
    if (!q) return;
    // The results are kept for the Search tab whichever screen is up when they land, so
    // the ticket is for the query alone: one typed over it is the one that counts.
    const still = V.ticket("search");
    committedSearchQ = q;
    discoverState = { q, items: [], artists: [], source: "", busy: true, error: null, kind: null, nextpage: null };
    showSearchState(q);
    try {
      const res = await Api.search(q);
      if (!still()) return;
      Store.pushSearch(q);
      discoverState = { q, items: res.items.filter(t => !Store.isBlocked(t)), artists: res.artists || [], source: res.source, busy: false, error: null, kind: res.kind, base: res.base, filter: res.filter, page: res.page, nextpage: res.nextpage || null };
    } catch (e) {
      if (!still()) return;
      discoverState = { q, items: [], artists: [], source: "", busy: false, error: "Search failed - no server reachable right now. Check your connection and try again.", kind: null, nextpage: null };
    }
    if (V.currentTab === "search" && !V.subView) showSearchState(q);
  }

  async function loadMore() {
    const state = discoverState;
    if (state.loadingMore || !state.nextpage) return;
    state.loadingMore = true;
    state.moreError = false;
    V.render();
    try {
      const more = await Api.searchMore(state, state.q);
      if (state !== discoverState) return;
      const seen = new Set(state.items.map(t => t.id));
      state.items = state.items.concat(more.items.filter(t => !seen.has(t.id) && seen.add(t.id) && !Store.isBlocked(t)));
      state.nextpage = more.nextpage || null;
      state.page = more.page;
    } catch (e) {
      state.moreError = true;
      if (state === discoverState) V.toast("Couldn't load more results - tap Load more to retry", "err");
    } finally {
      state.loadingMore = false;
      if (state === discoverState && V.currentTab === "search" && !V.subView) V.render();
    }
  }

})();
