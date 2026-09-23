(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    albumArtistsHtml: { get: () => albumArtistsHtml },
    bindTrackGestures: { get: () => bindTrackGestures },
    collectionQuery: { get: () => collectionQuery, set: value => { collectionQuery = value; } },
    collectionSort: { get: () => collectionSort, set: value => { collectionSort = value; } },
    heroView: { get: () => heroView },
    queueHeroStickyBar: { get: () => queueHeroStickyBar },
    renderCollection: { get: () => renderCollection },
    reorderHandle: { get: () => reorderHandle },
    stickyBarHtml: { get: () => stickyBarHtml },
    syncHeroStickyBar: { get: () => syncHeroStickyBar }
  });

  // ---------------- Hero collections (library album/artist/playlist/liked) ----------------

  // components/Preview/Artists/Artists.tsx: one row per distinct artist, hidden
  // entirely if any of them has no id to link to - reads count on any id, not the
  // subset that has one, the same guard the reference component applies.
  function albumArtistsHtml(tracks) {
    const seen = new Set();
    const artists = [];
    for (const t of tracks) {
      if (!t.artistId || seen.has(t.artistId)) continue;
      seen.add(t.artistId);
      artists.push({ id: t.artistId, name: t.artist || "", thumb: t.artistThumb || "" });
    }
    if (!artists.length) return "";
    return '<div class="album-artists">' + artists.map(a =>
      '<button class="album-artist-row" data-trackartist="' + V.esc(a.id) + '" data-trackartistname="' + V.esc(a.name) + '" data-trackartistthumb="' + V.esc(a.thumb) + '">' +
      '<div class="album-artist-avatar"><img decoding="async" src="' + V.esc(a.thumb) + '" loading="lazy" alt="" /></div>' +
      '<span dir="auto">' + V.esc(a.name) + '</span></button>'
    ).join("") + '</div>';
  }

  // components/Preview/CommonHeader/CommonHeader.tsx: an always-visible back button
  // plus a title bar that only appears once the cover has scrolled out of the way -
  // interpolate(scrollY, [0, COVER*0.75, COVER*1.05], [0,0,1]) for the bar itself,
  // a little further for the title's own fade+rise.
  function stickyBarHtml(title, thumb) {
    const bgStyle = thumb ? ' style="--hero-bg:' + V.cssUrl(thumb) + '"' : "";
    return '<div class="hero-stickybar-wrap"><div class="hero-stickybar" id="hero-stickybar"' + bgStyle + '>' +
      '<span class="hero-stickybar-title" dir="auto">' + V.esc(title || "") + '</span></div>' +
      '<button class="back-btn" id="back-btn" aria-label="Back">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button></div>';
  }
  const HERO_STICKYBAR_COVER = 300; // COVER_SIZE
  // The scroll event can arrive several times per frame, and this reads scrollTop and
  // then writes styles - doing that per event is a layout thrash the finger can feel.
  // One coalesced pass per frame is all a repaint can use anyway.
  let stickyBarFrame = 0;
  let stickyBarEl = null;
  let stickyBarTitleEl = null;
  let stickyBarOpacity = -1;
  let stickyBarTitleAt = -1;

  function syncHeroStickyBar() {
    if (!V.view) return;
    if (!stickyBarEl || !stickyBarEl.isConnected) {
      stickyBarEl = document.getElementById("hero-stickybar");
      stickyBarTitleEl = stickyBarEl && stickyBarEl.querySelector(".hero-stickybar-title");
      stickyBarOpacity = -1;
      stickyBarTitleAt = -1;
    }
    if (!stickyBarEl) return;
    const y = V.view.scrollTop;
    const barFrom = HERO_STICKYBAR_COVER * 0.75, barTo = HERO_STICKYBAR_COVER * 1.05;
    // Rounded before comparing, so the long flat stretches above and below the fade cost
    // nothing at all - the style is only touched while the number is actually moving.
    const opacity = Math.round(Math.max(0, Math.min(1, (y - barFrom) / (barTo - barFrom))) * 100) / 100;
    if (opacity !== stickyBarOpacity) {
      stickyBarOpacity = opacity;
      stickyBarEl.style.opacity = String(opacity);
    }
    if (!stickyBarTitleEl) return;
    const tFrom = barTo - 5, tTo = barTo + 50;
    const p = Math.round(Math.max(0, Math.min(1, (y - tFrom) / (tTo - tFrom))) * 100) / 100;
    if (p === stickyBarTitleAt) return;
    stickyBarTitleAt = p;
    stickyBarTitleEl.style.opacity = String(p);
    stickyBarTitleEl.style.transform = "translateY(" + (10 - 10 * p) + "px)";
  }

  function queueHeroStickyBar() {
    if (stickyBarFrame) return;
    stickyBarFrame = requestAnimationFrame(() => { stickyBarFrame = 0; syncHeroStickyBar(); });
  }
  if (V.view) V.view.addEventListener("scroll", queueHeroStickyBar, { passive: true });

  function heroView(opts) {
    const bgStyle = opts.thumb ? ' style="--hero-bg:' + V.cssUrl(opts.thumb) + '"' : "";
    return stickyBarHtml(opts.title, opts.thumb) +
      '<div class="album-hero"' + bgStyle + '>' +
      '<div class="hero-art' + (opts.coverPl ? ' hero-art-editable' : '') + '"' +
      (opts.coverPl ? ' data-cover-pl="' + V.esc(opts.coverPl) + '" role="button" tabindex="0" title="Change cover"' : "") + '>' +
      (opts.art || '<img decoding="async" src="' + V.esc(opts.thumb || "") + '" alt="" />') +
      (opts.coverPl ? '<span class="hero-art-edit">Change cover</span>' : "") + '</div>' +
      '<div class="hero-text"><div class="hero-eyebrow">' + V.esc(opts.eyebrow) + '</div>' +
      '<h2 class="hero-title" dir="auto"' +
      (opts.renamePl ? ' data-rename-pl="' + V.esc(opts.renamePl) + '" title="Rename" tabindex="0"' : "") +
      '>' + V.esc(opts.title) + '</h2>' +
      (opts.artist ? '<div class="hero-artist" dir="auto">' + V.esc(opts.artist) + '</div>' : "") +
      '<div class="hero-meta">' + V.esc(opts.meta) + '</div>' +
      '<div class="hero-cta">' + (opts.cta != null ? opts.cta : '<button class="btn primary" id="hero-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Play</button>' +
      '<button class="btn ghost" id="hero-shuffle">Shuffle</button>' +
      '<button class="btn ghost" id="hero-download">Download all</button>') + '</div></div></div>';
  }

  // Finding one track in a long imported playlist meant scrolling for it. The controls
  // reuse the library's own search field and sort bar, and the list is repainted on its
  // own so typing is never interrupted - the same reason the search tab works that way.
  const COLLECTION_SORTS = [["order", "Playlist order"], ["title", "Title"], ["artist", "Artist"], ["duration", "Duration"]];
  let collectionQuery = "";
  let collectionSort = "order";

  function collectionView(tracks) {
    const query = collectionQuery.trim().toLowerCase();
    const shown = query
      ? tracks.filter(t => Store.matchesQuery(query, t.title, t.artist))
      : tracks.slice();
    if (collectionSort === "title") shown.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else if (collectionSort === "artist") shown.sort((a, b) => (a.artist || "").localeCompare(b.artist || "") || (a.title || "").localeCompare(b.title || ""));
    else if (collectionSort === "duration") shown.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    return shown;
  }

  function reorderHandle(title) {
    return '<button type="button" class="reorder-handle" aria-label="Drag to reorder ' + V.esc(title) +
      '" title="Drag to reorder. Arrow keys move; Delete removes."><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/></svg></button>';
  }

  // One pointer interaction for mouse, pen and touch. Only the handle owns vertical
  // movement; the rest of the row keeps native scrolling until a sideways intent wins.
  function bindTrackGestures(list, selector, move, remove, label) {
    list.classList.add("gesture-list");
    let gesture = null, frame = 0, suppressUntil = 0;
    const rows = () => Array.from(list.querySelectorAll(selector));
    const scroller = list.closest(".sheet") || V.view;
    const releaseDrag = () => finish(true);
    const cancelDrag = () => finish(false);
    const escapeDrag = e => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    function finish(commit) {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      window.removeEventListener("keydown", escapeDrag, true);
      window.removeEventListener("pointerup", releaseDrag);
      window.removeEventListener("pointercancel", cancelDrag);
      window.removeEventListener("blur", cancelDrag);
      cancelAnimationFrame(frame);
      const target = rows().indexOf(g.row);
      const original = g.original.indexOf(g.row);
      g.row.classList.remove("track-dragging", "track-swiping", "swipe-ready");
      g.row.style.removeProperty("transform");
      g.row.removeAttribute("data-swipe-label");
      if (g.live) suppressUntil = performance.now() + 500;
      // Restore DOM before committing so a cancelled or stale gesture never saves.
      const valid = list.isConnected && g.original.every(row => row.parentElement === list);
      if (g.mode === "move" && valid) g.original.forEach(row => list.appendChild(row));
      if (list.hasPointerCapture(g.pointer)) list.releasePointerCapture(g.pointer);
      if (!commit || !g.live || !valid) return;
      if (g.mode === "move" && target !== original) move(g.row, g.original[target]);
      else if (g.mode === "remove" && Math.abs(g.dx) >= g.threshold) remove(g.row);
    }
    function paintDrag() {
      if (!gesture || !gesture.live || gesture.mode !== "move") return;
      const g = gesture;
      if (!list.isConnected || !g.row.isConnected) { finish(false); return; }
      const bounds = scroller.getBoundingClientRect();
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      const speed = g.y < top + 56 ? -Math.min(16, (top + 56 - g.y) / 3) :
        g.y > bottom - 56 ? Math.min(16, (g.y - bottom + 56) / 3) : 0;
      scroller.scrollTop += speed;
      const others = rows().filter(row => row !== g.row);
      const before = others.find(row => { const box = row.getBoundingClientRect(); return g.y < box.top + box.height / 2; });
      if (before) list.insertBefore(g.row, before); else list.appendChild(g.row);
      g.row.style.transform = "none";
      g.row.style.transform = "translateY(" + (g.y - g.offset - g.row.getBoundingClientRect().top) + "px)";
      frame = requestAnimationFrame(paintDrag);
    }
    list.addEventListener("pointerdown", e => {
      if (gesture) { finish(false); return; }
      if (e.button !== 0 || !e.isPrimary) return;
      const row = e.target.closest(selector);
      const handle = e.target.closest(".reorder-handle");
      if (!row || e.target.closest("button, a, input") && !handle) return;
      if (handle && !move || !handle && !remove) return;
      gesture = { row, pointer: e.pointerId, x: e.clientX, y: e.clientY, startY: e.clientY,
        dx: 0, offset: e.clientY - row.getBoundingClientRect().top, original: rows(),
        mode: handle ? "move" : "remove", live: false,
        threshold: Math.max(80, Math.min(130, row.offsetWidth * .3)) };
      window.addEventListener("keydown", escapeDrag, true);
      window.addEventListener("pointerup", releaseDrag);
      window.addEventListener("pointercancel", cancelDrag);
      window.addEventListener("blur", cancelDrag);
      if (handle) e.preventDefault();
    });
    list.addEventListener("pointermove", e => {
      const g = gesture;
      if (!g || e.pointerId !== g.pointer) return;
      g.dx = e.clientX - g.x;
      g.y = e.clientY;
      const dy = g.y - g.startY;
      if (!g.live) {
        // A hold may already have opened the track menu while this finger stayed down.
        if (V.view.contains(g.row) && V.pressFired && !V.sheetEl.hidden) { finish(false); return; }
        if (g.mode === "remove" && Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(g.dx)) { finish(false); return; }
        if (g.mode === "move" ? Math.abs(dy) < 6 : Math.abs(g.dx) < 12 || Math.abs(g.dx) < Math.abs(dy) * 1.5) return;
        g.live = true;
        V.cancelLongPress();
        V.touchMoved = true;
        if (V.pullActive) V.endPull(false);
        list.setPointerCapture(e.pointerId);
        g.row.classList.add(g.mode === "move" ? "track-dragging" : "track-swiping");
        if (g.mode === "move") paintDrag();
      }
      if (e.cancelable) e.preventDefault();
      if (g.mode === "remove") {
        g.row.style.transform = "translateX(" + Math.max(-g.threshold * 1.3, Math.min(g.threshold * 1.3, g.dx)) + "px)";
        g.row.dataset.swipeLabel = label;
        g.row.classList.toggle("swipe-ready", Math.abs(g.dx) >= g.threshold);
      }
    });
    list.addEventListener("pointerup", () => finish(true));
    list.addEventListener("pointercancel", () => finish(false));
    list.addEventListener("lostpointercapture", e => {
      if (e.target === list && !list.hasPointerCapture(e.pointerId)) finish(false);
    });
    list.addEventListener("keydown", e => {
      if (e.key === "Escape") { finish(false); return; }
      const handle = e.target.closest(".reorder-handle");
      if (!handle) return;
      const row = handle.closest(selector), all = rows(), index = all.indexOf(row);
      const target = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 :
        e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
        e.preventDefault(); if (all[target] && target !== index && move) move(row, all[target]);
      } else if (e.key === "Delete" && remove) { e.preventDefault(); remove(row); }
    });
    list.addEventListener("click", e => {
      if (performance.now() < suppressUntil || e.target.closest(".reorder-handle")) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    // Handles own their touches. Ordinary rows retain their existing hold menu.
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      list.addEventListener(type, e => {
        if (e.target.closest(".reorder-handle") || gesture && gesture.live) e.stopPropagation();
      }, { passive: true });
    }
  }

  function renderCollection(tracks, opts, ctx) {
    const mins = Math.round(tracks.reduce((a, t) => a + (t.duration || 0), 0) / 60);
    const playlistId = ctx && ctx.startsWith("pl:") ? ctx.slice(3) : null;
    // A list swiped down to one song has no Done button left to leave reordering with.
    if (V.subView && V.subView.reordering && tracks.length < 2) V.subView.reordering = false;
    const reordering = !!(playlistId && V.subView && V.subView.reordering);
    // A filter must not outlive the box that clears it: a list that drops under ten
    // songs loses its controls, and used to keep showing only what had matched.
    if (reordering || tracks.length < 10) { collectionQuery = ""; collectionSort = "order"; }
    const controls = tracks.length >= 10 && !reordering;
    const sortLabel = () => (COLLECTION_SORTS.find(s => s[0] === collectionSort) || COLLECTION_SORTS[0])[1];
    V.view.innerHTML = heroView(Object.assign({ meta: tracks.length + " tracks · " + mins + " min" }, opts)) +
      (controls
        ? '<div class="library-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
          '<input id="collection-query" type="search" dir="auto" placeholder="Find in this list" value="' + V.esc(collectionQuery) + '" /></div>' +
          '<div class="sort-bar"><button class="sort-trigger" id="collection-sort">' + V.esc(sortLabel()) +
          ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></button>' +
          '<span class="count" id="collection-count"></span></div>'
        : "") +
      (playlistId && tracks.length > 1 ? '<div class="playlist-order-bar"><button class="btn ghost" id="playlist-reorder" aria-pressed="' + reordering + '">' +
        (reordering ? 'Done' : 'Reorder') + '</button>' +
        (reordering ? '<span>Drag the three lines to reorder. Swipe a song sideways to remove. Changes save automatically.</span>' : '') + '</div>' : '') +
      '<ul class="song-list" id="collection-list"></ul>' +
      '<div class="sr-only" id="playlist-order-status" role="status" aria-live="polite"></div>';

    const list = document.getElementById("collection-list");
    const count = document.getElementById("collection-count");
    const paintList = () => {
      const shown = collectionView(tracks);
      V.paint(list, shown.map((t, i) => reordering
        ? '<li class="song playlist-order-row" data-order-id="' + V.esc(t.id) + '">' + V.artHtml(t, "lg") +
          '<div class="meta"><div class="song-title" dir="auto">' + V.esc(t.title) + '</div><div class="song-sub">' + (i + 1) + ' of ' + shown.length + '</div></div>' +
          reorderHandle(t.title) + '</li>'
        : V.trackRow(t, ctx)).join("") ||
        '<li class="library-no-results">Nothing matches that</li>');
      if (count) count.textContent = shown.length + " of " + tracks.length;
      return shown;
    };
    paintList();

    const reorderBtn = document.getElementById("playlist-reorder");
    if (reorderBtn) reorderBtn.onclick = () => {
      V.subView.reordering = !reordering;
      collectionQuery = "";
      collectionSort = "order";
      V.render();
      const next = document.getElementById("playlist-reorder");
      if (next) next.focus({ preventScroll: true });
    };
    if (playlistId) bindTrackGestures(list, reordering ? "[data-order-id]" : ".song[data-id]", reordering ? (row, target) => {
      const id = row.dataset.orderId;
      if (!Store.movePlaylistTrack(playlistId, id, target.dataset.orderId)) return;
      tracks = Store.playlistTracks(playlistId);
      paintList();
      const handle = /** @type {HTMLElement} */ (Array.from(/** @type {HTMLCollectionOf<HTMLElement>} */ (list.children)).find(el => el.dataset.orderId === id).querySelector(".reorder-handle"));
      handle.focus({ preventScroll: true });
      handle.scrollIntoView({ block: "nearest" });
      document.getElementById("playlist-order-status").textContent = "Moved to position " + (tracks.findIndex(t => t.id === id) + 1);
    } : null, row => {
      const id = row.dataset.orderId || row.dataset.id;
      const previous = Store.getPlaylist(playlistId).ids.slice();
      Store.removeFromPlaylist(playlistId, id);
      tracks = Store.playlistTracks(playlistId);
      paintList();
      V.toast("Removed from playlist", "", () => {
        if (!Store.getPlaylist(playlistId)) return;
        Store.addToPlaylist(playlistId, id);
        const next = previous.slice(previous.indexOf(id) + 1).find(other => Store.getPlaylist(playlistId).ids.includes(other));
        if (next) Store.movePlaylistTrack(playlistId, id, next);
      });
    }, "Remove from playlist");

    const input = /** @type {HTMLInputElement} */ (document.getElementById("collection-query"));
    if (input) {
      input.addEventListener("input", () => { collectionQuery = input.value; paintList(); });
    }
    const sortBtn = document.getElementById("collection-sort");
    if (sortBtn) sortBtn.onclick = () => {
      const at = COLLECTION_SORTS.findIndex(s => s[0] === collectionSort);
      collectionSort = COLLECTION_SORTS[(at + 1) % COLLECTION_SORTS.length][0];
      sortBtn.childNodes[0].nodeValue = sortLabel() + " ";
      paintList();
    };

    document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
    const coverArt = /** @type {HTMLElement} */ (document.querySelector("[data-cover-pl]"));
    if (coverArt) coverArt.onclick = () => V.pickPlaylistCover(coverArt.dataset.coverPl);
    const playBtn = document.getElementById("hero-play");
    // Play and shuffle follow what is on screen, so filtering then playing does what it looks like.
    if (playBtn) playBtn.onclick = () => { const shown = collectionView(tracks); if (shown.length) Player.playQueue(shown, 0, V.playlistPlaybackOptions(ctx)); };
    const shufBtn = document.getElementById("hero-shuffle");
    if (shufBtn) shufBtn.onclick = () => {
      const shown = collectionView(tracks);
      if (!shown.length) return;
      if (Player.shareSession()) {
        // Shuffle is a queue-wide setting a shared queue does not take, and a shared
        // queue takes the list from the start index on: contribute the whole list in
        // a random order rather than a random tail of it.
        const order = shown.slice();
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const swap = order[i]; order[i] = order[j]; order[j] = swap;
        }
        Player.playQueue(order, 0);
        return;
      }
      Player.setShuffle(true);
      Player.playQueue(shown, Math.floor(Math.random() * shown.length));
    };
    const dlAll = document.getElementById("hero-download");
    if (dlAll) dlAll.onclick = () => V.downloadAll(collectionView(tracks));
  }
})();
