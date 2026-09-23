(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    fillDownloadedLibrary: { get: () => fillDownloadedLibrary },
    offlineCandidates: { get: () => offlineCandidates },
    renderLibrary: { get: () => renderLibrary },
    sharedListedAt: { get: () => sharedListedAt, set: value => { sharedListedAt = value; } }
  });

  // ---------------- Library ----------------

  function libraryLayout() {
    return Store.settings().libraryLayout === "list" ? "list" : "grid";
  }

  function sortCollections(items) {
    const mode = Store.settings().librarySort;
    return items.slice().sort((a, b) => mode === "name"
      ? (a.name || "").localeCompare(b.name || "")
      : collectionAddedAt(b) - collectionAddedAt(a));
  }

  function collectionAddedAt(item) {
    return (item.tracks || []).reduce((at, track) => Math.max(at, track.addedAt || 0), item.createdAt || item.followedAt || 0);
  }

  function libraryToolbarHtml() {
    if (V.libraryFilter === "songs" || V.libraryFilter === "downloaded") return "";
    const layout = libraryLayout();
    return '<div class="library-toolbar"><label class="library-sort">Sort by <select id="library-sort" aria-label="Sort library">' +
      '<option value="recent"' + (Store.settings().librarySort !== "name" ? ' selected' : '') + '>Recently added</option>' +
      '<option value="name"' + (Store.settings().librarySort === "name" ? ' selected' : '') + '>Name</option></select></label>' +
      '<div class="library-layout" role="group" aria-label="Library layout">' +
      '<button data-library-layout="list" aria-label="List view" aria-pressed="' + (layout === "list") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/></svg></button>' +
      '<button data-library-layout="grid" aria-label="Grid view" aria-pressed="' + (layout === "grid") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/></svg></button></div></div>';
  }

  function renderLibrary() {
    const chips = [
      ["playlists", "Playlists"],
      ["songs", "Songs"],
      ["albums", "Albums"],
      ["artists", "Artists"],
      ["podcasts", "Podcasts"],
      ["downloaded", "Downloaded"]
    ];
    let body = "";
    if (V.libraryFilter === "songs") body = librarySongsHtml();
    else if (V.libraryFilter === "albums") body = libraryAlbumsHtml();
    else if (V.libraryFilter === "artists") body = libraryArtistsHtml();
    else if (V.libraryFilter === "podcasts") body = libraryPodcastsHtml();
    else if (V.libraryFilter === "downloaded") body = libraryDownloadedHtml();
    else body = libraryPlaylistsHtml();

    const wrote = V.paint(V.view, '<div class="library-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
      '<input id="library-query" type="search" dir="auto" aria-label="Search in Your Library" placeholder="Search in Your Library" value="' + V.esc(V.libraryQuery) + '" /></div>' +
      '<div class="chips">' + chips.map(([id, label]) =>
        '<button class="chip' + (V.libraryFilter === id ? " active" : "") + '" aria-pressed="' + (V.libraryFilter === id) + '" data-chip="' + id + '">' + V.esc(label) + '</button>').join("") + '</div>' +
      libraryToolbarHtml() + '<div class="library-content collection-' + libraryLayout() + '">' + body + '</div>');
    // Nothing was replaced, so the handlers below are still on the nodes that are there.
    // Wiring them again would double every keystroke.
    if (!wrote) return;

    const libraryInput = /** @type {HTMLInputElement} */ (document.getElementById("library-query"));
    libraryInput.addEventListener("input", () => {
      V.libraryQuery = libraryInput.value;
      clearTimeout(V.libraryTimer);
      V.libraryTimer = setTimeout(() => {
        if (V.currentTab !== "library" || V.subView) return;
        // The field is drawn again with the list. Focused afresh its caret sits at the
        // start, so the next letters typed landed in front of the ones before them.
        const at = libraryInput.selectionStart;
        renderLibrary();
        const nextInput = /** @type {HTMLInputElement} */ (document.getElementById("library-query"));
        if (!nextInput) return;
        nextInput.focus();
        try { nextInput.setSelectionRange(at, at); } catch (e) {}
      }, 180);
    });
    const sort = /** @type {HTMLSelectElement} */ (document.getElementById("library-sort"));
    if (sort) sort.onchange = () => {
      Store.patchSettings({ librarySort: /** @type {"recent" | "name"} */ (sort.value) });
      renderLibrary();
      document.getElementById("library-sort").focus();
    };
    if (V.libraryFilter === "songs") wireSongsHandlers();
    if (V.libraryFilter === "downloaded") fillDownloadedLibrary();
    if (V.libraryFilter === "playlists") {
      const newPl = document.getElementById("new-pl");
      if (newPl) newPl.onclick = () => V.promptModal("New playlist", "", name => { Store.createPlaylist(name); V.render(); });
      const importPl = document.getElementById("import-pl");
      if (importPl) importPl.onclick = V.openImportModal;
      refreshSharedList();
    }
  }

  function libraryPlaylistsHtml() {
    const query = V.libraryQuery.trim().toLowerCase();
    const pls = sortCollections(Store.playlists().filter(p => Store.matchesQuery(query, p.name)));
    const liked = Store.likedTracks("music");
    const rows = (query && !"liked songs".includes(query) ? [] : [
      '<li class="pl-row"><button class="pl-open" data-quick="liked"><div class="art lg"><div class="pl-ph liked-cover">♥</div></div>' +
      '<div class="meta"><div class="song-title" dir="auto">Liked Songs</div><div class="song-sub" dir="auto">' + liked.length + ' songs</div></div></button></li>'
    ]).concat(pls.map(p => {
      const tracks = Store.playlistTracks(p.id);
      return '<li class="pl-row"><button class="pl-open" data-pl="' + V.esc(p.id) + '">' +
        '<div class="art lg">' + V.playlistArtHtml(p) + '</div>' +
        '<div class="meta"><div class="song-title" dir="auto">' + V.esc(p.name) + '</div><div class="song-sub" dir="auto">' + tracks.length + ' songs</div></div></button>' +
        '<button class="kebab" aria-label="Options for ' + V.esc(p.name) + '" data-plmenu="' + V.esc(p.id) + '"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>';
    }));
    return '<div class="row-actions"><button class="btn primary" id="new-pl">＋ New playlist</button>' +
      '<button class="btn ghost" id="import-pl">⤓ Import a playlist</button></div>' +
      (rows.length ? '<ul class="pl-list">' + rows.join("") + '</ul>' : '<div class="library-no-results">No playlists found</div>') +
      sharedPlaylistsHtml(query);
  }

  // Only rendered when the private server has actually answered with something - on the
  // public build there is no server to share on, and an empty "Shared" heading there would
  // be a promise the deployment cannot keep.
  function sharedPlaylistsHtml(query) {
    if (!window.Sync || !Sync.sharedCached) return "";
    const shared = sortCollections(Sync.sharedCached().filter(p => Store.matchesQuery(query, p.name, p.owner || "")));
    if (!shared.length) return "";
    return '<div class="section-head"><h3>Shared on this server</h3></div>' +
      '<ul class="pl-list">' + shared.map(p =>
        '<li class="pl-row"><button class="pl-open" data-shared="' + V.esc(p.id) + '">' +
        '<div class="art lg"><div class="pl-ph">◇</div></div>' +
        '<div class="meta"><div class="song-title" dir="auto">' + V.esc(p.name || "Shared playlist") + '</div>' +
        '<div class="song-sub" dir="auto">' + V.esc(V.sharedOwnerLabel(p)) + ' · ' +
        (p.count != null ? Number(p.count) || 0 : (p.tracks || []).length) + ' songs</div></div></button>' +
        '<button class="kebab" aria-label="Options for ' + V.esc(p.name || "Shared playlist") + '" data-sharedmenu="' + V.esc(p.id) + '"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>'
      ).join("") + '</ul>';
  }

  // One refresh per visit to the tab rather than one per render, so typing in the library
  // search box does not fire a request per keystroke.
  let sharedListedAt = 0;
  function refreshSharedList() {
    if (!window.Sync || !Sync.sharedList) return;
    // The public build has no server behind /api/sync at all, and asking it every time the
    // tab opens is a request that can only ever 404.
    if (Sync.describe && Sync.describe().unsupported) return;
    if (Date.now() - sharedListedAt < 30000) return;
    sharedListedAt = Date.now();
    Sync.sharedList().then(() => {
      if (V.currentTab !== "library" || V.libraryFilter !== "playlists" || V.subView) return;
      // Not under a hand typing in the library search: the repaint replaces the box.
      const input = document.getElementById("library-query");
      if (input && document.activeElement === input) { V.markStale(); return; }
      V.render();
    }).catch(() => {});
  }

  function libraryAlbumsHtml() {
    const query = V.libraryQuery.trim().toLowerCase();
    const albums = sortCollections(Store.albums().filter(a => Store.matchesQuery(query, a.name, a.artist)));
    if (!albums.length) return V.libraryQuery ? '<div class="library-no-results">No albums found</div>' : V.emptyState("No albums yet", "Albums appear as you add songs to your library.", null);
    return '<div class="grid">' + albums.map(a =>
      V.gridCard(a.thumb, a.name, a.artist + " · " + a.tracks.length + " tracks", 'data-album="' + V.esc(a.key) + '"', true)).join("") + '</div>';
  }

  function libraryArtistsHtml() {
    const query = V.libraryQuery.trim().toLowerCase();
    const followed = Store.followsList().filter(f => f.kind !== "podcast");
    const names = new Set(followed.map(f => Store.foldText(f.name).trim()));
    const artists = sortCollections(/** @type {any[]} */ (followed).concat(Store.artists().filter(a => !names.has(Store.foldText(a.name).trim())))
      .filter(a => Store.matchesQuery(query, a.name)));
    if (!artists.length) return V.libraryQuery ? '<div class="library-no-results">No artists found</div>' : V.emptyState("No artists yet", "Artists appear as you add songs to your library.", null);
    return '<div class="grid artists">' + artists.map(a => a.id ? V.followCard(a) :
      V.gridCard(a.thumb, a.name, a.tracks.length + " songs", 'data-artist="' + V.esc(a.name) + '"', true)).join("") + '</div>';
  }

  function libraryPodcastsHtml() {
    const query = V.libraryQuery.trim();
    const shows = sortCollections(Store.followsList().filter(f => f.kind === "podcast" && Store.matchesQuery(query, f.name)));
    const liked = Store.likedTracks("podcast");
    const episodes = Store.sortedLibrary("podcast").filter(t => !Store.isBlocked(t) && Store.matchesQuery(query, t.title, t.artist, t.podcast));
    if (!shows.length && !episodes.length) return query ? '<div class="library-no-results">No podcasts found</div>' :
      V.emptyState("Your shows, all together", "Follow a podcast or save an episode to find it here.", null);
    return (liked.length ? '<button class="btn ghost" data-quick="likedPodcast">Liked episodes (' + liked.length + ')</button>' : "") +
      (shows.length ? '<div class="grid podcasts">' + shows.map(V.followCard).join("") + '</div>' : "") +
      (episodes.length ? '<div class="section-head"><h3>Saved episodes</h3></div><ul class="song-list">' +
        episodes.map(t => V.trackRow(t, "library")).join("") + '</ul>' : "");
  }

  function librarySongsHtml() {
    const query = V.libraryQuery.trim().toLowerCase();
    const tracks = Store.sortedLibrary("music").filter(t => !Store.isBlocked(t) && Store.matchesQuery(query, t.title, t.artist));
    if (!tracks.length) return V.libraryQuery ? '<div class="library-no-results">No songs found</div>' : V.emptyState("Your library is empty", "Find any song on Search and add it - free, no ads.", "Search music");
    const sort = Store.settings().sort || "added";
    const labels = { added: "Recently added", title: "Title", artist: "Artist" };
    return '<div class="sort-bar"><button class="sort-trigger" id="sort-btn">' + labels[sort] +
      ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></button>' +
      '<span class="count">' + tracks.length + ' songs</span></div>' +
      '<div class="row-actions"><button class="btn primary" id="play-all"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Play all</button>' +
      '<button class="btn ghost" id="shuffle-all">Shuffle</button>' +
      '<button class="btn ghost" id="download-all">Download all</button></div>' +
      '<ul class="song-list">' + tracks.map(t => V.trackRow(t, "library")).join("") + '</ul>';
  }

  function libraryDownloadedHtml() {
    return '<div id="downloaded-library"><div class="status-line"><span class="ring"></span> Checking downloads…</div></div>';
  }

  // Everything on the device that can be named, whichever way it got there: saved from
  // search, added to the library, or kept from something recently played. Listing only
  // the intersection with the library hid the very songs downloaded for a flight.
  function offlineCandidates() {
    const seen = new Set();
    const out = [];
    const take = list => list.forEach(t => {
      if (!t || !t.id || seen.has(t.id)) return;
      seen.add(t.id);
      out.push(t);
    });
    take(Store.downloadedTracks ? Store.downloadedTracks() : []);
    take(Store.sortedLibrary());
    take(Store.recents());
    return out;
  }

  // A big track over a slow connection is a long silence otherwise.
  function downloadPercent() {
    const p = Player.downloadProgress ? Player.downloadProgress() : null;
    return p && p.total ? " " + Math.round((p.got / p.total) * 100) + "%" : "";
  }

  async function fillDownloadedLibrary() {
    const holder = document.getElementById("downloaded-library");
    if (!holder) return;
    const ids = await Player.downloadedIds();
    if (!holder.isConnected) return;
    const query = V.libraryQuery.trim().toLowerCase();
    const tracks = offlineCandidates().filter(t => ids.has(t.id) && Store.matchesQuery(query, t.title, t.artist));
    const counts = Player.downloadCounts ? Player.downloadCounts() : { working: 0, failed: 0 };
    const waitingForWifi = counts.working && Player.downloadsBlockedByWifi && Player.downloadsBlockedByWifi();
    // The queue holds until the signal is back; a spinner promising progress it cannot
    // make read as a download that had hung.
    const status = counts.working && navigator.onLine === false
      ? '<div class="status-line">' + counts.working + (counts.working === 1 ? ' song' : ' songs') + ' waiting for a connection</div>'
      : waitingForWifi
      ? '<div class="status-line">' + counts.working + (counts.working === 1 ? ' song' : ' songs') + ' waiting for Wi-Fi</div>'
      : counts.working
      ? '<div class="status-line"><span class="ring"></span> Saving ' + counts.working +
        (counts.working === 1 ? ' song' : ' songs') + '…' + downloadPercent() + '</div>'
      : (counts.failed ? '<div class="status-line">' + counts.failed + (counts.failed === 1 ? ' song' : ' songs') + ' could not be saved</div>' : "");
    holder.innerHTML = status + (tracks.length
      ? '<div class="sort-bar"><span class="count">' + tracks.length + ' downloaded</span></div><ul class="song-list">' + tracks.map(t => V.trackRow(t, "library")).join("") + '</ul>'
      : '<div class="library-no-results">No downloaded music yet</div>');
  }

  function wireSongsHandlers() {
    const query = V.libraryQuery.trim().toLowerCase();
    const tracks = Store.sortedLibrary("music").filter(t => !Store.isBlocked(t) && Store.matchesQuery(query, t.title, t.artist));
    const cta = document.getElementById("empty-cta");
    if (cta) cta.onclick = () => Views.showTab("search");
    const playAll = document.getElementById("play-all");
    if (playAll) playAll.onclick = () => Player.playQueue(tracks, 0);
    const shuffleAll = document.getElementById("shuffle-all");
    if (shuffleAll) shuffleAll.onclick = () => {
      Player.setShuffle(true);
      Player.playQueue(tracks, Math.floor(Math.random() * tracks.length));
    };
    const dlAll = document.getElementById("download-all");
    if (dlAll) dlAll.onclick = () => V.downloadAll(tracks);
    const sortBtn = document.getElementById("sort-btn");
    if (sortBtn) sortBtn.onclick = () => {
      /** @type {Settings["sort"][]} */
      const order = ["added", "title", "artist"];
      const cur = Store.settings().sort || "added";
      Store.patchSettings({ sort: order[(order.indexOf(cur) + 1) % order.length] });
      V.render();
    };
  }
})();
