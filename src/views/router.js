(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    IC: { get: () => IC },
    render: { get: () => render },
    sheetItem: { get: () => sheetItem },
    syncRemoteMenu: { get: () => syncRemoteMenu }
  });

  // ---------------- Router ----------------

  /**
   * Draws the current tab or sub-screen again.
   * @param {boolean} [animate]
   */
  function render(animate) {
    if (V.currentTab !== "search" || V.subView) V.cancelLiveSearch();
    // A request spoken on the Ask screen ends when that screen is left: nobody is looking
    // at its orb any more, and the song it paused should not stay paused for it.
    if (V.voice && V.voice.surface === "ask" && (V.currentTab !== "ai" || V.subView)) V.voiceEnd();
    V.setViewMotion(!!animate);
    V.viewStale = false;
    // A screen drawn again in place gets a new sticky bar at its resting opacity; only a
    // scroll used to bring it back, so it vanished from a list that was already scrolled.
    V.queueHeroStickyBar();
    V.syncChrome(V.subView ? (V.subView.kind === "settings" ? "Settings" : "") : V.currentTab === "library" ? "Your Library" : V.currentTab === "search" ? "Search" : V.currentTab === "ai" ? "Ask AI" : "Good " + (new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"));
    if (V.subView) {
      if (V.subView.kind === "settings") return V.renderSettingsPage();
      if (V.subView.kind === "stats") return V.renderStatsPage();
      if (V.subView.kind === "album") {
        const a = Store.albums().find(x => x.key === V.subView.key);
        if (a) return V.renderCollection(a.tracks, { eyebrow: "Album", title: a.name, artist: a.artist, thumb: a.thumb }, "library");
      }
      if (V.subView.kind === "artist") {
        const a = Store.artists().find(x => x.name === V.subView.name);
        if (a) return V.renderCollection(a.tracks, { eyebrow: "Artist", title: a.name, thumb: a.thumb }, "library");
      }
      if (V.subView.kind === "playlist") {
        const p = Store.getPlaylist(V.subView.id);
        if (p) return V.renderCollection(Store.playlistTracks(p.id), {
          eyebrow: "Playlist", title: p.name,
          thumb: V.playlistCoverSrc(p), art: V.playlistArtHtml(p), coverPl: p.id, renamePl: p.id
        }, "pl:" + p.id);
      }
      if (V.subView.kind === "downloaded") {
        V.fillHomeDownloaded();
        const saved = V.homeDownloads.items;
        return V.renderCollection(saved, {
          eyebrow: "On this device",
          title: "Downloaded",
          thumb: saved.length ? V.artSrc(saved[0]) : ""
        }, "library");
      }
      if (V.subView.kind === "likedPodcast") {
        const episodes = Store.likedTracks("podcast");
        return V.renderCollection(episodes, { eyebrow: "Podcasts", title: "Liked episodes", thumb: (episodes[0] || {}).thumb }, "library");
      }
      if (V.subView.kind === "liked") {
        return V.renderCollection(Store.likedTracks("music"), { eyebrow: "Playlist", title: "Liked Songs", thumb: (Store.likedTracks("music")[0] || {}).thumb }, "library");
      }
      if (V.subView.kind === "shared") return V.renderSharedPlaylist(V.subView);
      if (V.subView.kind === "ytArtist") return V.renderYtArtist(V.subView);
      if (V.subView.kind === "ytAlbum") return V.renderYtAlbum(V.subView);
      if (V.subView.kind === "category") return V.renderCategory(V.subView);
      // The collection this screen showed is gone: its last track removed, a playlist
      // deleted by a sync pull. Leave it the way a Back press would, restoring the screen
      // beneath with its own chrome and spending the entry this screen pushed, rather
      // than painting the tab under the hero chrome with a dead Back press left behind.
      V.spendEntry();
      V.popSubView();
      return;
    }
    if (V.currentTab === "home") V.renderHome();
    else if (V.currentTab === "search") V.renderSearch();
    else if (V.currentTab === "library") V.renderLibrary();
    else if (V.currentTab === "ai") V.renderAsk();
  }

  function sheetItem(id, label, icon) {
    return '<button class="sheet-item" data-act="' + id + '">' + icon + '<span>' + V.esc(label) + '</span></button>';
  }
  const IC = {
    cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8V5h18v14h-8M3 12a7 7 0 0 1 7 7M3 16a3 3 0 0 1 3 3"/><circle cx="3" cy="19" r="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><polyline points="17 3 21 6 17 9"/></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    disc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>'
  };

  function syncRemoteMenu() {
    const button = V.sheetEl.querySelector('[data-act="remote"]');
    if (!button) return;
    const remote = Player.remotePlaybackStatus();
    const label = remote.preparing ? "Preparing TV playback..." :
      remote.state === "connected" ? (remote.canDisconnect ? "Disconnect from " : "AirPlay / output: ") + remote.deviceName :
      remote.state === "connecting" ? "Connecting to TV..." : "Connect to TV";
    button.querySelector("span").textContent = label;
    button.disabled = remote.preparing || remote.state === "connecting";
    button.setAttribute("aria-label", label);
  }
})();
