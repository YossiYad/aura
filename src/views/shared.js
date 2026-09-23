(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    openSharedPlaylistMenu: { get: () => openSharedPlaylistMenu },
    renderSharedPlaylist: { get: () => renderSharedPlaylist },
    sharedOwnerLabel: { get: () => sharedOwnerLabel }
  });

  // ---------------- Shared playlists ----------------

  // These live on the private server rather than on the device, so everyone signed in to it
  // sees the same list and anyone can add to it. The cached copy is shown first and the
  // fetch refreshes it underneath - opening a shared list on a train with no signal still
  // shows what was in it last time rather than a spinner that never resolves.
  function sharedOwnerLabel(record) {
    if (!record) return "Shared playlist";
    if (record.mine) return "Shared by you";
    const who = String(record.owner || "").split("@")[0];
    return who ? "Shared by " + who : "Shared playlist";
  }

  function renderSharedPlaylist(sv) {
    const cached = Sync.sharedCached(sv.id);
    const record = sv.record || cached;
    if (!sv.loading && !sv.fetched) {
      sv.loading = true;
      Sync.sharedOpen(sv.id).then(fresh => {
        sv.record = fresh;
        sv.loading = false;
        sv.fetched = true;
        sv.error = null;
        if (V.subView === sv) V.render();
      }).catch(err => {
        sv.loading = false;
        sv.fetched = true;
        sv.error = String((err && err.message) || err);
        if (V.subView === sv) V.render();
      });
    }
    if (!record || !record.tracks) {
      V.view.innerHTML = V.heroView({ eyebrow: "Shared playlist", title: (record && record.name) || "Shared playlist", thumb: "", meta: "", cta: "" }) +
        '<div class="status-line">' + (sv.error ? '<span class="err">' + V.esc(sv.error) + '</span>' : '<span class="ring"></span> Loading…') + '</div>' +
        (sv.error ? '<div class="row-actions"><button class="btn ghost" id="subview-retry">Try again</button></div>' : "");
      document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
      const retry = document.getElementById("subview-retry");
      if (retry) retry.onclick = () => { sv.error = null; sv.fetched = false; V.render(); };
      return;
    }
    const tracks = record.tracks;
    V.renderCollection(tracks, {
      eyebrow: sharedOwnerLabel(record),
      title: record.name,
      thumb: tracks.length ? V.artSrc(tracks[0]) : ""
    }, "shared:" + sv.id);
  }

  function openSharedPlaylistMenu(id) {
    const record = Sync.sharedCached(id);
    if (!record) return;
    V.openSheet(
      '<div class="sheet-head"><div class="meta"><div class="song-title" dir="auto">' + V.esc(record.name || "Shared playlist") + '</div>' +
      '<div class="song-sub" dir="auto">' + V.esc(sharedOwnerLabel(record)) + ' · ' + (record.count != null ? Number(record.count) || 0 : (record.tracks || []).length) + ' songs</div></div></div>' +
      V.sheetItem("open", "Open", V.IC.play) +
      V.sheetItem("copy", "Save a copy to my playlists", V.IC.plus) +
      (record.mine ? V.sheetItem("unshare", "Stop sharing this", V.IC.trash) : "")
    );
    V.sheetEl.onclick = async e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      // Opening pushes a subview, so this sheet closes directly - spending its history entry
      // would put a history.back() and a pushState in the same breath.
      if (act === "open") { V.closeSheet(); V.pushSubView({ kind: "shared", id }); return; }
      V.dismissViaHistory(V.closeSheet);
      if (act === "copy") {
        let full = record;
        if (!full.tracks) {
          try { full = await Sync.sharedOpen(id); }
          catch (err) { V.toast("Couldn't fetch that list - " + String((err && err.message) || err), "err"); return; }
        }
        const pl = Store.createPlaylist(full.name || "Shared playlist");
        (full.tracks || []).forEach(t => { Store.addTrack(t); Store.addToPlaylist(pl.id, t.id); });
        V.toast('Copied "' + pl.name + '" into your playlists');
        V.render();
        return;
      }
      if (act === "unshare") {
        try { await Sync.sharedRemove(id); }
        catch (err) { V.toast(String((err && err.message) || err), "err"); return; }
        // The local playlist it came from keeps its songs; only the server copy goes.
        const local = Store.playlists().find(p => p.sharedId === id);
        if (local) Store.setPlaylistShared(local.id, null);
        V.toast("Stopped sharing");
        V.render();
      }
    };
  }
})();
