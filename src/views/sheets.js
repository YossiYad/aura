(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    beginTitleRename: { get: () => beginTitleRename },
    downloadAll: { get: () => downloadAll },
    openCreateSheet: { get: () => openCreateSheet },
    openPlaylistMenu: { get: () => openPlaylistMenu },
    openPlaylistPicker: { get: () => openPlaylistPicker },
    openPlaylistPickerBulk: { get: () => openPlaylistPickerBulk },
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
      else if (act === "addpl") openPlaylistPicker(track);
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
        downloadAll([track]);
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

  // Adding to a list someone else shared is the whole point of a shared list, so the picker
  // offers them alongside your own rather than making you copy the list first.
  function sharedPickerHtml() {
    if (!window.Sync || !Sync.sharedCached) return "";
    const shared = Sync.sharedCached();
    if (!shared.length) return "";
    return '<div class="sheet-title">Shared on this server</div>' +
      shared.map(p => '<button class="sheet-item" data-sharedpl="' + V.esc(p.id) + '">' + V.IC.plus +
        '<span>' + V.esc(p.name || "Shared playlist") + ' <em>(' + V.esc(V.sharedOwnerLabel(p)) + ')</em></span></button>').join("");
  }

  async function addToSharedPlaylist(id, tracks, onAdded) {
    try {
      const was = Sync.sharedCached(id) || /** @type {Partial<SharedPlaylist>} */ ({});
      const before = was.count != null ? was.count : (was.tracks || []).length;
      const record = await Sync.sharedAppend(id, tracks);
      const added = record.added != null ? record.added
        : Math.max(0, (record.tracks || []).length - before);
      V.sharedListedAt = 0;
      // The server just handed back the list as it now stands, so an open shared view
      // shows the addition instead of the copy it loaded a minute ago.
      if (V.subView && V.subView.kind === "shared" && V.subView.id === id) V.subView.record = record;
      V.toast(added ? "Added to \"" + (record.name || "the shared list") + "\"" : "Already in that shared list");
      if (onAdded) onAdded(true);
      V.render();
    } catch (err) {
      V.toast(String((err && err.message) || err), "err");
    }
  }

  /**
   * @param {Track} track
   * @param {(added: boolean) => void} [onAdded]
   */
  function openPlaylistPicker(track, onAdded) {
    const pls = Store.playlists();
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">Add to playlist</div><div class="song-sub" dir="auto">' + V.esc(track.title) + '</div></div></div>' +
      (pls.length ? "" : '<div class="status-line">You have no playlists yet - create your first one</div>') +
      V.sheetItem("newpl", "New playlist…", V.IC.plus) +
      pls.map(p => '<button class="sheet-item" data-pl="' + V.esc(p.id) + '">' + V.IC.queue + '<span>' + V.esc(p.name) + ' <em>(' + p.ids.length + ')</em></span></button>').join("") +
      sharedPickerHtml()
    );
    V.sheetEl.onclick = e => {
      const npl = e.target.closest('[data-act="newpl"]');
      if (npl) {
        V.closeSheet();
        V.promptModal("New playlist", "", name => {
          const p = Store.createPlaylist(name);
          Store.addTrack(track);
          Store.addToPlaylist(p.id, track.id);
          V.toast('Added to "' + name + '"');
          if (onAdded) onAdded(true);
          V.render();
        });
        return;
      }
      const sharedBtn = e.target.closest("[data-sharedpl]");
      if (sharedBtn) {
        V.dismissViaHistory(V.closeSheet);
        addToSharedPlaylist(sharedBtn.dataset.sharedpl, [track], onAdded);
        return;
      }
      const btn = e.target.closest("[data-pl]");
      if (!btn) return;
      // Picking a playlist is the end of the flow; "New playlist" goes on to a prompt
      // modal that pushes its own entry, so it keeps the direct close.
      V.dismissViaHistory(V.closeSheet);
      Store.addTrack(track);
      const ok = Store.addToPlaylist(btn.dataset.pl, track.id);
      V.toast(ok ? "Added to playlist" : "Already in that playlist");
      if (onAdded) onAdded(true);
      V.render();
    };
  }

  function openPlaylistPickerBulk(tracks, label) {
    const pls = Store.playlists();
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">Add ' + tracks.length + ' songs to playlist</div><div class="song-sub" dir="auto">' + V.esc(label || "") + '</div></div></div>' +
      V.sheetItem("newpl", "New playlist…", V.IC.plus) +
      pls.map(p => '<button class="sheet-item" data-pl="' + V.esc(p.id) + '">' + V.IC.queue + '<span>' + V.esc(p.name) + ' <em>(' + p.ids.length + ')</em></span></button>').join("") +
      sharedPickerHtml()
    );
    const addAll = pid => {
      let added = 0;
      tracks.forEach(t => {
        Store.addTrack(t);
        if (Store.addToPlaylist(pid, t.id)) added++;
      });
      V.toast("Added " + added + " songs to playlist");
      V.render();
    };
    V.sheetEl.onclick = e => {
      const npl = e.target.closest('[data-act="newpl"]');
      if (npl) {
        V.closeSheet();
        V.promptModal("New playlist", label || "", name => addAll(Store.createPlaylist(name).id));
        return;
      }
      const sharedBtn = e.target.closest("[data-sharedpl]");
      if (sharedBtn) {
        V.dismissViaHistory(V.closeSheet);
        addToSharedPlaylist(sharedBtn.dataset.sharedpl, tracks);
        return;
      }
      const btn = e.target.closest("[data-pl]");
      if (!btn) return;
      V.dismissViaHistory(V.closeSheet);
      addAll(btn.dataset.pl);
    };
  }

  // Renaming a playlist meant finding it in the library, opening its menu and typing into a
  // modal - four steps away from the name sitting right there at the top of the list. The
  // heading edits in place instead: it keeps its own styling, so nothing moves, and Enter
  // or tapping away saves while Escape puts the old name back.
  let renamingPl = null;

  function beginTitleRename(el, pid) {
    const p = Store.getPlaylist(pid);
    if (!p || renamingPl) return;
    renamingPl = pid;
    const before = p.name;
    try { el.contentEditable = "plain-text-only"; } catch (e) {}
    if (!el.isContentEditable) el.contentEditable = "true";
    el.spellcheck = false;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let closed = false;
    const finish = save => {
      if (closed) return;
      closed = true;
      renamingPl = null;
      const typed = String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      el.contentEditable = "false";
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      if (save && typed && typed !== before) {
        Store.renamePlaylist(pid, typed);
        V.toast('Renamed to "' + typed + '"');
      }
      // Repaint either way: a cancelled edit, or an empty one, has to show the old name.
      V.render();
    };
    const onKey = e => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  }

  // Taking a whole list offline is one action, not one per song. Everything that already
  // has a copy on the device is skipped rather than fetched again.
  function downloadAll(tracks) {
    const list = (tracks || []).filter(t => t && t.id);
    if (!list.length) return V.toast("Nothing to download here");
    const added = Player.queueDownloads(list);
    if (!added) return V.toast("Already saved offline");
    V.toast(navigator.onLine === false
      ? "Queued " + added + (added === 1 ? " song" : " songs") + " - saving starts when you're back online"
      : "Saving " + added + (added === 1 ? " song" : " songs") + " for offline");
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

  function openPlaylistMenu(pid) {
    const p = Store.getPlaylist(pid);
    if (!p) return;
    // Sharing only means anything on the private server, and only once it has answered -
    // offering it on the public build would be a button that can only ever fail.
    const canShare = !!(window.Sync && Sync.describe && Sync.describe().available);
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">' + V.esc(p.name) + '</div><div class="song-sub" dir="auto">' + p.ids.length + ' songs' +
      (p.sharedId ? ' · shared' : '') + '</div></div></div>' +
      V.sheetItem("play", "Play", V.IC.play) +
      V.sheetItem("download", "Download all for offline", V.IC.dl) +
      V.sheetItem("rename", "Rename", V.IC.plus) +
      V.sheetItem("cover", p.cover ? "Change cover" : "Choose a cover", V.IC.plus) +
      (p.cover ? V.sheetItem("clearcover", "Use the songs' artwork", V.IC.trash) : "") +
      (canShare && !p.sharedId ? V.sheetItem("share", "Share with everyone on this server", V.IC.plus) : "") +
      (canShare && p.sharedId ? V.sheetItem("republish", "Update the shared copy", V.IC.plus) : "") +
      (canShare && p.sharedId ? V.sheetItem("unshare", "Stop sharing", V.IC.trash) : "") +
      V.sheetItem("delete", "Delete playlist", V.IC.trash)
    );
    V.sheetEl.onclick = async e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      // Rename opens a prompt modal, which pushes its own entry - so this sheet closes
      // directly rather than racing a history.back() against that pushState.
      if (act === "rename") { V.closeSheet(); V.promptModal("Rename playlist", p.name, name => { Store.renamePlaylist(pid, name); V.render(); }); return; }
      // The file picker has to open on this tap, so the sheet closes directly here too
      // rather than behind a history.back() the browser would count as a gesture ending.
      if (act === "cover") { V.closeSheet(); V.pickPlaylistCover(pid); return; }
      V.dismissViaHistory(V.closeSheet);
      if (act === "play") { const ts = Store.playlistTracks(pid); if (ts.length) Player.playQueue(ts, 0, { shuffle: false }); }
      else if (act === "download") downloadAll(Store.playlistTracks(pid));
      else if (act === "share") {
        V.toast("Sharing…");
        try {
          const record = await Sync.sharedCreate(p.name, Store.playlistTracks(pid));
          Store.setPlaylistShared(pid, record.id);
          V.sharedListedAt = 0;
          V.toast('"' + p.name + '" is now on the server for everyone signed in');
          V.render();
        } catch (err) { V.toast(String((err && err.message) || err), "err"); }
      }
      else if (act === "republish") {
        // Merge under the server lock so concurrent contributions remain in the list.
        try {
          const mine = Store.playlistTracks(pid);
          const updated = await Sync.sharedReplace(p.sharedId, p.name, mine);
          const have = new Set(mine.map(t => t.id));
          const theirs = (updated.tracks || []).filter(t => !have.has(t.id));
          V.sharedListedAt = 0;
          V.toast(theirs.length ? "Shared copy updated, keeping " + theirs.length + " song(s) others added" : "Shared copy updated");
          V.render();
        } catch (err) { V.toast(String((err && err.message) || err), "err"); }
      }
      else if (act === "unshare") {
        try {
          await Sync.sharedRemove(p.sharedId);
          Store.setPlaylistShared(pid, null);
          V.toast("Stopped sharing - your copy stays here");
          V.render();
        } catch (err) { V.toast(String((err && err.message) || err), "err"); }
      }
      else if (act === "clearcover") { Store.setPlaylistCover(pid, null); V.toast("Back to the songs' artwork"); V.render(); }
      else if (act === "delete") { const undo = Store.deletePlaylist(pid); V.toast('Deleted "' + p.name + '"', "", undo); V.render(); }
    };
  }

  /** Opens the sheet behind the Create tab. */
  function openCreateSheet() {
    // Sharing only means anything on the private server, and only once it has answered -
    // offering it on the public build would be a button that can only ever fail.
    const canShare = !!(window.Sync && Sync.describe && Sync.describe().available);
    V.openSheet(
      '<div class="sheet-title">Create</div>' +
      V.sheetItem("newpl", "Playlist", V.IC.plus) +
      V.sheetItem("aiplaylist", "Playlist with AI", V.IC.sparkle) +
      (canShare ? V.sheetItem("newshared", "Shared playlist", V.IC.person) : "") +
      ((window.SharedQueue && SharedQueue.available()) || canShare ? V.sheetItem("sharedqueue", "share", V.IC.person) : "") +
      V.sheetItem("import", "Import a playlist", V.IC.dl)
    );
    V.sheetEl.onclick = e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      V.closeSheet();
      const goToNewPlaylist = () => { V.libraryFilter = "playlists"; Views.showTab("library"); };
      if (act === "newpl") V.promptModal("New playlist", "", name => { Store.createPlaylist(name); goToNewPlaylist(); });
      else if (act === "aiplaylist") Views.showTab("ai");
      else if (act === "newshared") V.promptModal("New shared playlist", "", async name => {
        const pl = Store.createPlaylist(name);
        goToNewPlaylist();
        try {
          const record = await Sync.sharedCreate(pl.name, []);
          Store.setPlaylistShared(pl.id, record.id);
          V.sharedListedAt = 0;
          V.toast('"' + pl.name + '" is shared with everyone on this server');
        } catch (err) { V.toast(String((err && err.message) || err), "err"); }
      });
      else if (act === "sharedqueue") SharedQueue.open(V.openSheet, "standalone");
      else if (act === "import") V.openImportModal();
    };
  }
})();
