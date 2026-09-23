(function () {
  const V = window.Aura.views;

  // The handoff should not wait for someone to open Settings: a device that has a key and
  // a server that can use it should be in step from the first launch.
  /** Hands the AI key to the server mix service a few seconds after launch, when set up. */
  function initServerMix() {
    setTimeout(() => { V.syncServerMixKey().catch(() => {}); }, 4000);
  }

  window.Views = {
    openSharedQueue: () => SharedQueue.open(V.openSheet),
    startVoice: V.voiceStart,
    stopVoice: V.voiceEnd,
    voiceOpen: () => !!V.voice,
    initServerMix,
    render: V.render, markNowPlaying: V.markNowPlaying, refreshIfStale: V.refreshIfStale, toast: V.toast, syncPrivateButton: V.syncPrivateButton, openQueueSheet: V.openQueueSheet, openSettings: V.openSettings, openTrackMenu: V.openTrackMenu, openPlaylistPicker: V.openPlaylistPicker, openCreateSheet: V.openCreateSheet, openSleepTimerSheet: V.openSleepTimerSheet, openSpeedSheet: V.openSpeedSheet,
    applyAppearance: V.applyAppearance, artSrc: V.artSrc,
    addBackLayer(layer) { V.backLayers.push(layer); },
    focusLibrarySearch() {
      let input = document.getElementById("library-query");
      if (!input && V.subView) {
        V.spendSubViewEntries();
        V.subView = null;
        V.subViewStack = [];
        V.subViewScrollStack = [];
        V.render();
        input = document.getElementById("library-query");
      }
      if (input) input.focus();
      else this.showTab("search");
    },
    openCurrentArtist() {
      const track = Player.current();
      if (!track) return;
      document.getElementById("fullplayer").hidden = true;
      V.currentTab = "search";
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
      if (track.artistId) V.pushSubView({ kind: "ytArtist", id: track.artistId, name: track.artist || "Unknown", thumb: track.artistThumb || track.thumb || "" });
      else {
        // A screen left open would be drawn again over the results it was left for.
        V.spendSubViewEntries();
        V.subView = null;
        V.subViewStack = [];
        V.subViewScrollStack = [];
        V.doSearch(track.artist || track.title);
      }
    },
    // Reached from a tapped push notification, which only ever names a followed channel.
    openFollowedArtist(id) {
      if (!id) return;
      const f = Store.getFollow(id) || { id, name: "Artist", thumb: "" };
      document.getElementById("fullplayer").hidden = true;
      V.currentTab = "search";
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
      V.pushSubView({ kind: "ytArtist", id: f.id, name: f.name, thumb: f.thumb });
    },
    // Where a manifest shortcut lands - the menu behind a long press on the home screen
    // icon. A shortcut launches a fresh document, so main.js reads the query string once
    // at boot and calls this after the first render.
    openShortcut(name) {
      const fp = document.getElementById("fullplayer");
      if (fp) fp.hidden = true;
      if (name === "search") {
        this.showTab("search");
        // The input is only in the DOM after render(), and focusing it is what makes the
        // shortcut worth tapping - it should open with the keyboard already up.
        requestAnimationFrame(() => {
          const input = document.getElementById("disc-input");
          if (input) input.focus();
        });
        return true;
      }
      if (name === "ai") { this.showTab("ai"); return true; }
      if (name === "liked" || name === "downloaded") {
        this.showTab("library");
        V.pushSubView({ kind: name });
        return true;
      }
      return false;
    },
    showTab(tab) {
      if (!V.subView) V.tabScroll[V.currentTab] = V.view.scrollTop;
      V.currentTab = tab;
      // Switching tabs abandons whatever screens were stacked here. Their history
      // entries have to go with them, or Back presses later get eaten one by one and
      // the press after that leaves the app with playback still running.
      V.spendSubViewEntries();
      V.subView = null;
      V.subViewStack = [];
      V.subViewScrollStack = [];
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      V.render(true);
      V.restoreViewScroll(V.tabScroll[tab] || 0);
    },
    currentTab: () => V.currentTab
  };
})();
