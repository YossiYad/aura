(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    beginTitleRename: { get: () => V.beginTitleRename },
    downloadAll: { get: () => V.downloadAll },
    openCreateSheet: { get: () => V.openCreateSheet },
    openPlaylistMenu: { get: () => V.openPlaylistMenu },
    openPlaylistPicker: { get: () => V.openPlaylistPicker },
    openPlaylistPickerBulk: { get: () => V.openPlaylistPickerBulk },
    openSleepTimerSheet: { get: () => openSleepTimerSheet },
    openSpeedSheet: { get: () => openSpeedSheet },
    openTrackMenu: { get: () => openTrackMenu },
    TRACK_ELEMENTS: { get: () => TRACK_ELEMENTS },
    trackForElement: { get: () => trackForElement }
  });

  /**
   * @param {Track} track
   * @param {string} [ctx] Where the row was: "pl:<id>" for a playlist, "shared:<id>" for a
   * shared playlist, "library", or empty.
   */
  function openTrackMenu(track, ctx) {
    const liked = Store.isLiked(track.id);
    const inLib = !!Store.findTrack(track.id);
    const sharing = !!(Player.shareSession && Player.shareSession());
    V.openSheet(
      '<div class="sheet-head" data-track-menu="' + V.esc(track.id) + '">' + V.artHtml(track, "") +
      '<div class="meta"><div class="song-title" dir="auto">' + V.esc(track.title) + '</div><div class="song-sub" dir="auto">' + V.esc(track.artist) + '</div></div></div>' +
      (sharing ? V.sheetItem("addqueue", "Add to AuraShare", V.IC.queue) :
        V.sheetItem("play", "Play now", V.IC.play) +
        V.sheetItem("playnext", "Play next", V.IC.next) +
        V.sheetItem("addqueue", "Add to queue", V.IC.queue)) +
      V.sheetItem("like", liked ? "Remove from Liked" : "Add to Liked Songs", V.IC.heart) +
      V.sheetItem("addpl", "Add to playlist", V.IC.plus) +
      V.sheetItem("versions", "Play another version", V.IC.disc) +
      (Player.current() && Player.current().id === track.id ? V.sheetItem("remote", "Connect to TV", V.IC.cast) : "") +
      V.sheetItem("sleep", "Sleep timer", V.IC.queue) +
      V.sheetItem("speed", "Playback speed", V.IC.disc) +
      V.sheetItem("block", "Never play this again", V.IC.trash) +
      (track.artist ? V.sheetItem("blockartist", "Never play " + track.artist, V.IC.person) : "") +
      (inLib ? "" : V.sheetItem("addlib", "Add to library", V.IC.plus)) +
      (inLib && Store.mediaKind(track) === "music" ? V.sheetItem("goalbum", "Go to album", V.IC.disc) : "") +
      (track.artistId || inLib ? V.sheetItem("goartist", "Go to artist", V.IC.person) : "") +
      V.sheetItem("dl", "Download for offline", V.IC.dl) +
      (ctx && ctx.startsWith("pl:") ? V.sheetItem("rmpl", "Remove from this playlist", V.IC.trash) : "") +
      // Anyone may add to a shared list; only the person who shared it can take things out,
      // so one listener cannot quietly undo what the household put together.
      (ctx && ctx.indexOf("shared:") === 0 && (Sync.sharedCached(ctx.slice(7)) || {}).mine
        ? V.sheetItem("rmshared", "Remove from this shared list", V.IC.trash) : "") +
      (inLib ? V.sheetItem("rmlib", "Remove from library", V.IC.trash) : "")
    );
    V.syncRemoteMenu();
    const downloadButton = V.sheetEl.querySelector('[data-act="dl"]');
    Player.getDownload(track.id).then(download => {
      if (!download || V.sheetEl.hidden) return;
      const btn = V.sheetEl.querySelector('[data-act="dl"]');
      if (!btn || btn !== downloadButton) return;
      btn.dataset.act = "undl";
      btn.innerHTML = V.IC.trash + "<span>Remove download</span>";
    }).catch(() => {});
    V.sheetEl.onclick = async e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      // Leaf actions spend the sheet's entry through history; branches that open another
      // sheet keep it open so the content swaps in place - the entry then belongs to the
      // new sheet. Branches that push a subview close directly: spending would put a
      // history.back() and a pushState in the same breath, and their order is not ours
      // to choose.
      const shut = () => V.dismissViaHistory(V.closeSheet);
      if (act === "play") {
        if (Store.isBlocked(track)) { V.toast(V.BLOCKED_MSG, "err"); return; }
        // Playing from a playlist menu carries the rest of that playlist too.
        let tracks = ctx && ctx.startsWith("pl:") ? Store.playlistTracks(ctx.slice(3)) :
          ctx && ctx.startsWith("shared:") ? (Sync.sharedCached(ctx.slice(7)) || {}).tracks : null;
        if (!tracks || !tracks.some(t => t.id === track.id)) tracks = [track];
        const index = tracks.findIndex(t => t.id === track.id);
        shut(); V.playSelection(tracks, index, V.playlistPlaybackOptions(ctx));
      }
      else if (act === "playnext") {
        if (Store.isBlocked(track)) { V.toast(V.BLOCKED_MSG, "err"); return; }
        shut(); Player.playNext(track); V.toast("Playing next");
      }
      else if (act === "addqueue") {
        if (Store.isBlocked(track)) { V.toast(V.BLOCKED_MSG, "err"); return; }
        shut(); V.toast(Player.addToQueue(track) ? (sharing ? "Added to AuraShare" : "Added to queue") : "Already in the queue");
      }
      else if (act === "like") { shut(); Store.addTrack(track); const nowLiked = Store.toggleLike(track.id); V.toast(nowLiked ? (Store.mediaKind(track) === "podcast" ? "Added to liked episodes" : "Added to Liked Songs") : "Removed from Liked"); V.render(); }
      else if (act === "addlib") { shut(); Store.addTrack(track); V.toast("Added to library"); V.render(); }
      else if (act === "addpl") V.openPlaylistPicker(track);
      else if (act === "versions") openVersionsSheet(track);
      else if (act === "sleep") openSleepTimerSheet();
      else if (act === "speed") openSpeedSheet();
      else if (act === "remote") Player.requestRemotePlayback();
      else if (act === "block") {
        shut();
        const undo = Store.blockTrack(track);
        if (Player.current() && Player.current().id === track.id) Player.next();
        V.toast("Won't play again", "", undo);
        V.render();
      }
      else if (act === "blockartist") {
        shut();
        const undo = Store.blockArtist(track.artist);
        if (Player.current() && Store.isBlocked(Player.current())) Player.next();
        V.toast("Won't play " + track.artist + " again", "", undo);
        V.render();
      }
      // Opened from the full player, the menu sits above it: the screen being gone to has
      // to be uncovered, or the tap looks like it did nothing until Back is pressed.
      else if (act === "goalbum") { V.closeSheet(); document.getElementById("fullplayer").hidden = true; const t = Store.findTrack(track.id) || track; V.pushSubView({ kind: "album", key: (t.artist || "Unknown") + "::" + (t.album || "") }); }
      else if (act === "goartist") {
        V.closeSheet();
        document.getElementById("fullplayer").hidden = true;
        if (track.artistId) V.pushSubView({ kind: "ytArtist", id: track.artistId, name: track.artist || "Unknown", thumb: track.artistThumb || "" });
        else V.openArtistByName(track.artist || "Unknown");
      }
      else if (act === "dl") {
        shut();
        V.toast("Downloading…");
        V.downloadAll([track]);
      }
      else if (act === "undl") {
        shut();
        try { await Player.deleteDownload(track.id); V.toast("Download removed"); }
        catch (err) { V.toast("Couldn't remove the download", "err"); }
      }
      else if (act === "rmpl") { shut(); Store.removeFromPlaylist(ctx.slice(3), track.id); V.render(); }
      else if (act === "rmshared") {
        shut();
        const sid = ctx.slice(7);
        try {
          const updated = await Sync.sharedRemoveTrack(sid, track.id);
          V.sharedListedAt = 0;
          if (V.subView && V.subView.kind === "shared" && V.subView.id === sid) V.subView.record = updated;
          V.toast("Removed from the shared list");
          V.render();
        } catch (err) { V.toast(String((err && err.message) || err), "err"); }
      }
      else if (act === "rmlib") { shut(); const undo = Store.removeTrack(track.id); V.toast("Removed from library", "", undo); V.render(); }
    };
  }

  // Automatic matching picks one upload out of many, and sometimes picks badly - a live
  // take, a re-upload with poor audio. This lists the other results for the same song and
  // swaps the playing entry for whichever one the listener prefers.
  function openVersionsSheet(track) {
    V.openSheet(
      '<div class="sheet-head">' + V.artHtml(track, "") +
      '<div class="meta"><div class="song-title" dir="auto">Other versions</div>' +
      '<div class="song-sub" dir="auto">' + V.esc(track.title) + '</div></div></div>' +
      '<div class="status-line" id="versions-status"><span class="ring"></span> Looking for other versions…</div>' +
      '<ul class="song-list" id="versions-list"></ul>'
    );
    const status = document.getElementById("versions-status");
    const list = document.getElementById("versions-list");
    const active = () => !V.sheetEl.hidden && document.getElementById("versions-list") === list;
    Api.findVersions(track).then(items => {
      if (!active()) return;
      if (!items.length) {
        if (status) status.textContent = "No other versions found";
        return;
      }
      if (status) status.remove();
      list.innerHTML = items.map(t =>
        '<li class="song" data-version="' + V.esc(t.id) + '">' + V.artHtml(t, "lg") +
        '<div class="meta"><div class="song-title" dir="auto">' + V.esc(t.title) + '</div>' +
        '<div class="song-sub" dir="auto">' + V.esc(t.artist || "") +
        (t.duration ? ' <span class="dot">·</span> ' + V.fmt(t.duration) : "") + '</div></div></li>'
      ).join("");
      V.sheetEl.onclick = e => {
        const row = e.target.closest("[data-version]");
        if (!row) return;
        const chosen = items.find(t => t.id === row.dataset.version);
        if (!chosen) return;
        V.dismissViaHistory(V.closeSheet);
        const cur = Player.current();
        if (cur && cur.id === track.id) Player.replaceCurrent(chosen);
        else Player.playQueue([chosen], 0);
        V.toast("Playing another version");
        V.render();
      };
    }).catch(() => {
      if (active() && status) status.textContent = "Couldn't load other versions";
    });
  }

  /** Opens the sleep timer choices. */
  function openSleepTimerSheet() {
    const active = Player.sleepTimerState();
    const options = [["off", "Off"], ["15", "15 minutes"], ["30", "30 minutes"], ["45", "45 minutes"], ["60", "1 hour"], ["track", "End of this track"]];
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">Sleep timer</div>' +
      '<div class="song-sub" dir="auto">' + (active === "off" ? "Not set" : active === "track" ? "Stopping at the end of this track" : "Running") + '</div></div></div>' +
      options.map(opt => V.sheetItem("sleep:" + opt[0], opt[1], V.IC.queue)).join("")
    );
    V.sheetEl.onclick = e => {
      const btn = e.target.closest("[data-act]");
      if (!btn || btn.dataset.act.indexOf("sleep:") !== 0) return;
      const value = btn.dataset.act.slice(6);
      V.dismissViaHistory(V.closeSheet);
      Player.setSleepTimer(value === "off" ? 0 : value);
      V.toast(value === "off" ? "Sleep timer off"
        : value === "track" ? "Stopping at the end of this track"
        : "Stopping in " + (value === "60" ? "1 hour" : value + " minutes"));
    };
  }

  // Speed belongs to the listener, not to the track: an episode paused at 1.5x and picked
  // up tomorrow should still be at 1.5x, so this writes a setting rather than a per-track
  // flag, and the sheet reads it back the same way.
  /** Opens the playback speed choices. */
  function openSpeedSheet() {
    const current = Player.rate();
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">Playback speed</div>' +
      '<div class="song-sub" dir="auto">' + (current === 1 ? "Normal" : current + "x") + '</div></div></div>' +
      Player.rateChoices().map(r =>
        V.sheetItem("rate:" + r, (r === 1 ? "Normal (1x)" : r + "x") + (r === current ? " ·" : ""), V.IC.disc)
      ).join("")
    );
    V.sheetEl.onclick = e => {
      const btn = e.target.closest("[data-act]");
      if (!btn || btn.dataset.act.indexOf("rate:") !== 0) return;
      const value = parseFloat(btn.dataset.act.slice(5));
      V.dismissViaHistory(V.closeSheet);
      Player.setRate(value);
      V.toast(value === 1 ? "Normal speed" : "Playing at " + value + "x");
    };
  }

  // Which song a tile or a row stands for, whichever screen it is on. The kebab already
  // knew this per screen; a long press needs the same answer in one place.
  const TRACK_ELEMENTS = [
    "[data-home-feed-track]",
    "[data-category-track]",
    "[data-rec]",
    "[data-ai-home]",
    "[data-downloaded]",
    "[data-recent]",
    ".song[data-id]",
    ".dr[data-id]"
  ];

  function trackForElement(el) {
    if (!el) return null;
    const feed = el.closest("[data-home-feed-track]");
    if (feed) {
      const state = V.homeFeeds[V.homeFeedRenderedKey];
      const section = state && state.sections[parseInt(feed.dataset.homeFeedSection, 10)];
      return (section && V.unblocked(section.tracks)[parseInt(feed.dataset.homeFeedTrack, 10)]) || null;
    }
    const cat = el.closest("[data-category-track]");
    if (cat && V.subView && V.subView.kind === "category") {
      const section = V.subView.sections[parseInt(cat.dataset.categorySection, 10)];
      return (section && V.unblocked(section.tracks)[parseInt(cat.dataset.categoryTrack, 10)]) || null;
    }
    const rec = el.closest("[data-rec]");
    if (rec) return V.homeRecs.items[parseInt(rec.dataset.rec, 10)] || null;
    const aiPick = el.closest("[data-ai-home]");
    if (aiPick) return V.aiHomeSection.tracks[parseInt(aiPick.dataset.aiHome, 10)] || null;
    const saved = el.closest("[data-downloaded]");
    if (saved) {
      const id = saved.dataset.downloaded;
      return V.homeDownloads.items.find(t => t.id === id) || Store.findTrack(id) || null;
    }
    const recent = el.closest("[data-recent]");
    if (recent) {
      const id = recent.dataset.recent;
      return Store.recents().find(t => t.id === id) || Store.findTrack(id) || null;
    }
    const row = el.closest("[data-id]");
    if (row) return V.trackById(row.dataset.id);
    return null;
  }

})();
