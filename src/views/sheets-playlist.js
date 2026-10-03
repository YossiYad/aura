(function () {
  const V = window.Aura.views;
  // A playlist's own sheet and heading: rename in place, the playlist menu, the create sheet.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    beginTitleRename: { get: () => beginTitleRename },
    openCreateSheet: { get: () => openCreateSheet },
    openPlaylistMenu: { get: () => openPlaylistMenu }
  });

  // Renaming a playlist meant finding it in the library, opening its menu and typing into a
  // modal - four steps away from the name sitting right there at the top of the list. The
  // heading edits in place instead: it keeps its own styling, so nothing moves, and Enter
  // or tapping away saves while Escape puts the old name back.
  let renamingPl = null;

  let renamingEl = null;

  function beginTitleRename(el, pid) {
    const p = Store.getPlaylist(pid);
    // A repaint can take the heading being edited away without a blur; that edit is over.
    if (!p || (renamingPl && renamingEl && renamingEl.isConnected)) return;
    renamingPl = pid;
    renamingEl = el;
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
      renamingEl = null;
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

  function openPlaylistMenu(pid) {
    const p = Store.getPlaylist(pid);
    if (!p) return;
    // Sharing only means anything on the private server, and only once it has answered -
    // offering it on the public build would be a button that can only ever fail.
    const canShare = !!(window.Sync && Sync.describe && Sync.describe().available);
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">' + V.esc(p.name) + '</div><div class="song-sub" dir="auto">' + p.ids.length + ' songs' +
      (p.sharedId ? ' · shared' : '') + (p.private ? ' · private listening' : '') + '</div></div></div>' +
      V.sheetItem("play", "Play", V.IC.play) +
      V.sheetItem("download", "Download all for offline", V.IC.dl) +
      V.sheetItem("rename", "Rename", V.IC.plus) +
      V.sheetItem("cover", p.cover ? "Change cover" : "Choose a cover", V.IC.plus) +
      (p.cover ? V.sheetItem("clearcover", "Use the songs' artwork", V.IC.trash) : "") +
      // A private session for one playlist, kept on it: what plays from here stays out of
      // history, stats and recommendations until this is switched back.
      V.sheetItem("private", p.private ? "Record plays from here again" : "Listen privately from here", V.IC.person) +
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
      if (act === "play") { const ts = Store.playlistTracks(pid); if (ts.length) Player.playQueue(ts, 0, { shuffle: false, playlist: pid }); }
      else if (act === "private") {
        const on = !p.private;
        Store.setPlaylistPrivate(pid, on);
        V.toast(on ? 'Plays from "' + p.name + '" stay out of your history and recommendations' : 'Plays from "' + p.name + '" are recorded again');
        V.render();
      }
      else if (act === "download") V.downloadAll(Store.playlistTracks(pid));
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
      ((window.SharedQueue && SharedQueue.available()) || canShare ? V.sheetItem("sharedqueue", "AuraShare", V.IC.person) : "") +
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
