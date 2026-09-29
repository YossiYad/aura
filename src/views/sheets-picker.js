(function () {
  const V = window.Aura.views;
  // Adding to a playlist from a sheet: the picker for one track or many, the shared-playlist branch, download all.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    downloadAll: { get: () => downloadAll },
    openPlaylistPicker: { get: () => openPlaylistPicker },
    openPlaylistPickerBulk: { get: () => openPlaylistPickerBulk }
  });

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
})();
