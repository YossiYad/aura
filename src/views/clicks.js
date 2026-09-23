(function () {
  const V = window.Aura.views;

  V.view.addEventListener("click", async e => {
    const now = Date.now();
    const fromFinger = now - V.lastTouchAt < 700;
    // Typing and toggles are never a scroll; everything else on this screen is a big
    // target sitting inside a scrolling list, and a moving finger was not choosing it.
    const editing = !!(e.target.closest("[contenteditable]") || {}).isContentEditable;
    const typing = editing || !!e.target.closest("input, label, select, textarea");
    const ignore = !typing && (V.touchMoved || (fromFinger && now - V.lastScrollAt < V.SETTLE_MS));
    V.touchMoved = false;
    // The menu is already open from the hold; the release must not also play the song.
    if (V.pressFired) { V.pressFired = false; return; }
    if (ignore || editing) return;
    const renamePl = e.target.closest("[data-rename-pl]");
    if (renamePl) {
      V.beginTitleRename(renamePl, renamePl.dataset.renamePl);
      return;
    }
    const feedRetry = e.target.closest("[data-feed-retry]");
    if (feedRetry) {
      const state = V.homeFeeds[V.homeFeedRenderedKey];
      const section = state && state.sections[parseInt(feedRetry.dataset.feedRetry, 10)];
      if (section) V.loadHomeSection(state, section, V.homeFeedRenderedKey);
      return;
    }
    const homeFeedTrack = e.target.closest("[data-home-feed-track]");
    if (homeFeedTrack) {
      const state = V.homeFeeds[V.homeFeedRenderedKey];
      const section = state && state.sections[parseInt(homeFeedTrack.dataset.homeFeedSection, 10)];
      const index = parseInt(homeFeedTrack.dataset.homeFeedTrack, 10);
      const tracks = section ? V.unblocked(section.tracks) : [];
      if (tracks[index]) V.playSelection(tracks, index);
      return;
    }
    const browse = e.target.closest("[data-browse]");
    if (browse) {
      V.currentTab = "search";
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
      V.pushSubView({
        kind: "category",
        title: browse.dataset.browseTitle || browse.textContent.trim() || "Music",
        query: browse.dataset.browse,
        color: browse.dataset.browseColor || "#477d95",
        sections: [],
        loaded: false,
        loading: false
      });
      return;
    }
    const categoryTrack = e.target.closest("[data-category-track]");
    if (categoryTrack && V.subView && V.subView.kind === "category") {
      const section = V.subView.sections[parseInt(categoryTrack.dataset.categorySection, 10)];
      const index = parseInt(categoryTrack.dataset.categoryTrack, 10);
      const tracks = section ? V.unblocked(section.tracks) : [];
      if (tracks[index]) V.playSelection(tracks, index);
      return;
    }
    const savedSearch = e.target.closest("[data-search]");
    if (savedSearch) {
      // The debounced live search armed while typing would otherwise run after this
      // tap and replace its results with the shorter query.
      V.cancelLiveSearch();
      const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
      // iOS does not move focus to a tapped button, so the box would keep the typed
      // prefix while the results show the chip's query.
      if (input) input.value = savedSearch.dataset.search;
      V.doSearch(savedSearch.dataset.search);
      return;
    }
    const trackArtist = e.target.closest("[data-trackartist]");
    if (trackArtist) {
      e.stopPropagation();
      V.pushSubView({
        kind: "ytArtist",
        id: trackArtist.dataset.trackartist,
        name: trackArtist.dataset.trackartistname || "Unknown",
        thumb: trackArtist.dataset.trackartistthumb || ""
      });
      return;
    }
    const dlBtn = e.target.closest(".row-dl[data-dl]");
    if (dlBtn) {
      e.stopPropagation();
      if (dlBtn.classList.contains("done") || dlBtn.classList.contains("busy")) return;
      // This used to write into the same cache that fills itself while you listen, which
      // is pruned once it passes its limit and refuses anything over 60MB. A song saved
      // on purpose could quietly disappear, and a long one never saved at all. It is a
      // real download now, like the one in the menu, and it goes through the queue so
      // closing the app does not lose it.
      const track = V.trackForElement(dlBtn) || { id: dlBtn.dataset.dl, title: "", artist: "", duration: 0, thumb: "" };
      dlBtn.classList.add("busy");
      const added = Player.queueDownloads([track]);
      if (!added) { dlBtn.classList.remove("busy"); dlBtn.classList.add("done"); }
      return;
    }
    const kebab = e.target.closest("[data-menu]");
    if (kebab) {
      e.stopPropagation();
      const row = kebab.closest("[data-id]");
      const track = V.trackById(kebab.dataset.menu);
      if (track) V.openTrackMenu(track, row ? row.dataset.ctx : "");
      return;
    }
    const plMenu = e.target.closest("[data-plmenu]");
    if (plMenu) { e.stopPropagation(); V.openPlaylistMenu(plMenu.dataset.plmenu); return; }

    const sharedMenu = e.target.closest("[data-sharedmenu]");
    if (sharedMenu) { e.stopPropagation(); V.openSharedPlaylistMenu(sharedMenu.dataset.sharedmenu); return; }

    const addBtn = e.target.closest("[data-add]");
    if (addBtn) {
      e.stopPropagation();
      const list = V.currentResultList();
      const t = list.find(x => x.id === addBtn.dataset.add);
      if (!t) return;
      V.openPlaylistPicker(t, added => {
        if (!added || !addBtn.isConnected) return;
        addBtn.className = "add-btn added rn-pop";
        addBtn.disabled = true;
        addBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Added';
      });
      return;
    }

    const dr = e.target.closest(".dr[data-id]");
    if (dr) {
      const list = V.currentResultList();
      const idx = list.findIndex(x => x.id === dr.dataset.id);
      if (idx >= 0) V.playSelection(list, idx, V.subView && V.subView.kind === "ytAlbum" ? { shuffle: false } : undefined);
      return;
    }

    const songRow = e.target.closest(".song[data-id]");
    if (songRow) {
      const tapped = V.trackById(songRow.dataset.id);
      if (tapped && Store.isBlocked(tapped)) { V.toast(V.BLOCKED_MSG, "err"); return; }
      const list = Array.from(V.view.querySelectorAll(".song[data-id]")).map(el => el.dataset.id);
      const tracks = list.map(V.trackById).filter(Boolean);
      const idx = tracks.findIndex(t => t.id === songRow.dataset.id);
      if (idx >= 0) V.playSelection(tracks, idx, V.playlistPlaybackOptions(songRow.dataset.ctx));
      return;
    }

    const chip = e.target.closest("[data-chip]");
    if (chip) {
      V.libraryFilter = chip.dataset.chip;
      V.render(true);
      V.view.scrollTop = 0;
      const selected = V.view.querySelector('[data-chip="' + V.libraryFilter + '"]');
      if (selected) { selected.focus({ preventScroll: true }); selected.scrollIntoView({ block: "nearest", inline: "nearest" }); }
      return;
    }

    const layout = e.target.closest("[data-library-layout]");
    if (layout) {
      const value = layout.dataset.libraryLayout;
      Store.patchSettings({ libraryLayout: value });
      V.renderLibrary();
      V.view.querySelector('[data-library-layout="' + value + '"]').focus({ preventScroll: true });
      return;
    }

    const songSort = e.target.closest("[data-songsort]");
    if (songSort && V.subView && V.subView.kind === "ytArtist") {
      V.subView.songSort = songSort.dataset.songsort;
      V.subView.songSortChosen = true;
      V.render();
      return;
    }

    const quick = e.target.closest("[data-quick]");
    if (quick) {
      if (quick.dataset.quick === "downloaded") V.pushSubView({ kind: "downloaded" });
      else if (quick.dataset.quick === "liked") V.pushSubView({ kind: "liked" });
      else if (quick.dataset.quick === "likedPodcast") V.pushSubView({ kind: "likedPodcast" });
      else if (quick.dataset.quick === "pl") V.pushSubView({ kind: "playlist", id: quick.dataset.quickid });
      return;
    }

    const rec = e.target.closest("[data-rec]");
    if (rec) {
      const idx = parseInt(rec.dataset.rec, 10);
      if (V.homeRecs.items[idx]) V.playSelection(V.homeRecs.items.slice(), idx);
      return;
    }

    const aiHome = e.target.closest("[data-ai-home]");
    if (aiHome) {
      const idx = parseInt(aiHome.dataset.aiHome, 10);
      if (V.aiHomeSection.tracks[idx]) V.playSelection(V.aiHomeSection.tracks.slice(), idx);
      return;
    }

    // Tapping a saved song plays the saved list from there, so the row behaves like a
    // list rather than a set of one-offs.
    const dl = e.target.closest("[data-downloaded]");
    if (dl) {
      const idx = V.homeDownloads.items.findIndex(t => t.id === dl.dataset.downloaded);
      if (idx >= 0) V.playSelection(V.homeDownloads.items.slice(), idx);
      return;
    }

    const recent = e.target.closest("[data-recent]");
    if (recent) {
      const rid = recent.dataset.recent;
      const t = V.trackById(rid);
      if (!t) return;
      if (Store.isBlocked(t)) { V.toast(V.BLOCKED_MSG, "err"); return; }
      Player.playQueue([t], 0);
      return;
    }

    const ytArtistCard = e.target.closest("[data-ytartist]");
    if (ytArtistCard) {
      V.pushSubView({ kind: "ytArtist", id: ytArtistCard.dataset.ytartist, name: ytArtistCard.dataset.ytname, thumb: ytArtistCard.dataset.ytthumb });
      return;
    }
    const ytAlbumCard = e.target.closest("[data-ytalbum]");
    if (ytAlbumCard) {
      const artistName = (V.subView && V.subView.data && V.subView.data.name) || "";
      V.pushSubView({ kind: "ytAlbum", id: ytAlbumCard.dataset.ytalbum, name: ytAlbumCard.dataset.albname, thumb: ytAlbumCard.dataset.albthumb, artistName });
      return;
    }

    const albumCard = e.target.closest("[data-album]");
    if (albumCard) { V.pushSubView({ kind: "album", key: albumCard.dataset.album }); return; }
    const artistCard = e.target.closest("[data-artist]");
    if (artistCard) {
      V.openArtistByName(artistCard.dataset.artist, (artistCard.querySelector("img") || {}).src || "");
      return;
    }
    const sharedRow = e.target.closest("[data-shared]");
    if (sharedRow) { V.pushSubView({ kind: "shared", id: sharedRow.dataset.shared }); return; }
    const plRow = e.target.closest("[data-pl]");
    if (plRow) { V.pushSubView({ kind: "playlist", id: plRow.dataset.pl }); }
  });
})();
