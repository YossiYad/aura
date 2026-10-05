(function () {
  const V = window.Aura.views;
  // The library column of the desktop layout (src/views/desktop.js): everything the
  // listener keeps - playlists, followed artists and shows, albums - one click away from
  // any screen, the way a desktop player keeps it. It opens the same screens the Library
  // tab opens; the tab itself is behind the column's title.

  const KINDS = [["playlists", "Playlists"], ["artists", "Artists"], ["albums", "Albums"], ["podcasts", "Podcasts"]];
  /** @type {HTMLElement} */
  let side = null;
  let filter = "";
  let query = "";

  function addedAt(item) {
    return (item.tracks || []).reduce((at, track) => Math.max(at, track.addedAt || 0), item.createdAt || item.followedAt || 0);
  }

  function row(data, art, name, sub, round, on) {
    return '<li><button class="dk-lib-row' + (on ? " on" : "") + '" ' + data + '>' +
      '<span class="dk-lib-art' + (round ? " round" : "") + '">' + art + '</span>' +
      '<span class="dk-lib-meta"><span class="dk-lib-name" dir="auto">' + V.esc(name) + '</span>' +
      '<span class="dk-lib-sub" dir="auto">' + V.esc(sub) + '</span></span></button></li>';
  }

  function img(src) {
    return src ? '<img decoding="async" src="' + V.esc(src) + '" loading="lazy" alt="" />' : '<div class="image-missing"></div>';
  }

  function songs(n) {
    return n + (n === 1 ? " song" : " songs");
  }

  // One list, newest first, the way the Library tab sorts by default. The two rows that
  // are always there - what was liked, what is on this device - stay at the top of it.
  function rowsHtml() {
    const sv = V.subView || {};
    const match = (...texts) => !query || Store.matchesQuery(query, ...texts);
    const want = kind => !filter || filter === kind;
    /** @type {{ at: number, html: string }[]} */
    const items = [];
    let pinned = "";
    if (want("playlists")) {
      if (match("Liked Songs")) pinned += row('data-quick="liked"', '<div class="pl-ph liked-cover">♥</div>', "Liked Songs",
        "Playlist • " + songs(Store.likedTracks("music").length), false, sv.kind === "liked");
      if (match("Downloaded")) pinned += row('data-quick="downloaded"',
        '<div class="pl-ph dk-lib-device"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><polyline points="7 11 12 16 17 11"/><line x1="5" y1="20" x2="19" y2="20"/></svg></div>',
        "Downloaded", "On this device", false, sv.kind === "downloaded");
      Store.playlists().filter(p => match(p.name)).forEach(p => items.push({
        at: addedAt({ createdAt: p.createdAt, tracks: Store.playlistTracks(p.id) }),
        html: row('data-pl="' + V.esc(p.id) + '"', V.playlistArtHtml(p), p.name,
          "Playlist • " + songs(Store.playlistTracks(p.id).length) + (p.private ? " • private" : ""), false,
          sv.kind === "playlist" && sv.id === p.id)
      }));
      const shared = window.Sync && Sync.sharedCached ? Sync.sharedCached() : [];
      shared.filter(p => match(p.name, p.owner || "")).forEach(p => items.push({
        at: addedAt(p),
        html: row('data-shared="' + V.esc(p.id) + '"', '<div class="pl-ph">◇</div>', p.name || "Shared playlist",
          "Shared • " + V.sharedOwnerLabel(p), false, sv.kind === "shared" && sv.id === p.id)
      }));
    }
    Store.followsList().filter(f => want(f.kind === "podcast" ? "podcasts" : "artists") && match(f.name)).forEach(f => items.push({
      at: addedAt(f),
      html: row('data-ytartist="' + V.esc(f.id) + '" data-ytname="' + V.esc(f.name) + '" data-ytthumb="' + V.esc(f.thumb) + '"',
        img(f.thumb), f.name, f.kind === "podcast" ? "Podcast" : "Artist", f.kind !== "podcast",
        sv.kind === "ytArtist" && sv.id === f.id)
    }));
    if (want("albums")) Store.albums().filter(a => match(a.name, a.artist)).forEach(a => items.push({
      at: addedAt(a),
      html: row('data-album="' + V.esc(a.key) + '"', img(a.thumb), a.name, "Album • " + a.artist, false,
        sv.kind === "album" && sv.key === a.key)
    }));
    items.sort((a, b) => b.at - a.at);
    const html = pinned + items.map(item => item.html).join("");
    return html || '<li class="dk-lib-empty">' + (query ? "Nothing matches that" : "Nothing here yet") + '</li>';
  }

  function chipsHtml() {
    return KINDS.map(([id, label]) =>
      '<button class="dk-chip' + (filter === id ? " on" : "") + '" aria-pressed="' + (filter === id) + '" data-lib-kind="' + id + '">' + label + '</button>'
    ).join("");
  }

  function paintList() {
    if (!side || side.hidden) return;
    V.paint(side.querySelector(".dk-lib-chips"), chipsHtml());
    V.paint(side.querySelector(".dk-lib-list"), rowsHtml());
  }

  // The same screens the Library tab's rows open. A row that is already the screen on
  // show does nothing, rather than stacking the screen on itself.
  function open(next) {
    const cur = V.subView;
    if (cur && cur.kind === next.kind && (cur.id || cur.key || "") === (next.id || next.key || "")) return;
    V.pushSubView(next);
  }

  function mount(app) {
    side = document.createElement("aside");
    side.className = "dk-lib";
    side.setAttribute("aria-label", "Your Library");
    side.innerHTML =
      '<header class="dk-lib-head"><button class="dk-lib-title" data-lib="open">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="4" y2="20"/><line x1="10" y1="4" x2="10" y2="20"/><path d="M15 5l5 1.2v13L15 18z"/></svg>' +
      '<span>Your Library</span></button>' +
      '<button class="dk-lib-create" data-lib="create">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
      '<span>Create</span></button></header>' +
      '<div class="dk-lib-chips" role="group" aria-label="Library filters"></div>' +
      '<label class="dk-lib-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
      '<input type="text" dir="auto" autocomplete="off" spellcheck="false" aria-label="Search in Your Library" placeholder="Search in Your Library" /></label>' +
      '<ul class="dk-lib-list"></ul>';
    app.insertBefore(side, V.view);

    const input = side.querySelector("input");
    input.addEventListener("input", () => { query = input.value.trim().toLowerCase(); paintList(); });
    side.addEventListener("click", e => {
      const target = /** @type {HTMLElement} */ (e.target);
      const act = /** @type {HTMLElement} */ (target.closest("[data-lib]"));
      if (act) {
        if (act.dataset.lib === "create") Views.openCreateSheet();
        else Views.showTab("library");
        return;
      }
      const kind = /** @type {HTMLElement} */ (target.closest("[data-lib-kind]"));
      if (kind) {
        filter = filter === kind.dataset.libKind ? "" : kind.dataset.libKind;
        paintList();
        return;
      }
      const item = /** @type {HTMLElement} */ (target.closest(".dk-lib-row"));
      if (!item) return;
      const d = item.dataset;
      if (d.quick) open({ kind: d.quick });
      else if (d.pl) open({ kind: "playlist", id: d.pl });
      else if (d.shared) open({ kind: "shared", id: d.shared });
      else if (d.album) open({ kind: "album", key: d.album });
      else if (d.ytartist) open({ kind: "ytArtist", id: d.ytartist, name: d.ytname, thumb: d.ytthumb });
    });
    // The menu a phone opens from a row's three dots: on a desktop, the right button.
    side.addEventListener("contextmenu", e => {
      const item = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest(".dk-lib-row"));
      if (!item || !(item.dataset.pl || item.dataset.shared)) return;
      e.preventDefault();
      if (item.dataset.pl) V.openPlaylistMenu(item.dataset.pl);
      else V.openSharedPlaylistMenu(item.dataset.shared);
    });
    Store.onChange(what => {
      if (what === "library" || what === "playlists" || what === "follows" || what === "liked" || what === "restore") paintList();
    });
  }

  V.desktopParts.push({
    mount,
    show(on) { side.hidden = !on; },
    sync: paintList
  });
})();
