(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    openImportModal: { get: () => openImportModal }
  });

  function openImportModal() {
    V.openModal(
      '<div class="modal"><h3>Import playlist</h3>' +
      '<p class="import-hint">Paste a link to a public YouTube Music, YouTube, Spotify or Apple Music playlist. YouTube lists come across exactly as they are; Spotify and Apple songs are matched to an ad-free stream.</p>' +
      '<input type="text" id="import-url" placeholder="https://music.youtube.com/playlist?list=…" />' +
      '<select id="import-target">' +
      '<option value="">Into a new playlist</option>' +
      Store.playlists().map(p => '<option value="' + V.esc(p.id) + '">Into &quot;' + V.esc(p.name) + '&quot;</option>').join("") +
      '</select>' +
      '<div class="status-line" id="import-status" hidden></div>' +
      '<div class="modal-actions"><button class="btn ghost" id="import-cancel">Cancel</button>' +
      '<button class="btn primary" id="import-go">Import</button></div></div>'
    );
    const input = /** @type {HTMLInputElement} */ (document.getElementById("import-url"));
    const status = document.getElementById("import-status");
    const goBtn = /** @type {HTMLButtonElement} */ (document.getElementById("import-go"));
    let cancelled = false;
    let running = false;
    V.modalCleanup = () => { cancelled = true; };
    input.focus();
    const shutImport = () => { cancelled = true; V.dismissViaHistory(() => { V.closeModal(); V.scrimEl.hidden = true; }); };
    document.getElementById("import-cancel").onclick = shutImport;
    const run = async () => {
      const url = input.value.trim();
      if (!url || running || cancelled) return;
      running = true;
      const targetId = /** @type {HTMLSelectElement} */ (document.getElementById("import-target")).value || "";
      goBtn.disabled = true;
      input.disabled = true;
      status.hidden = false;
      status.textContent = "Reading playlist…";
      let parsed;
      try {
        parsed = await Api.importPlaylist(url);
      } catch (e) {
        running = false;
        if (cancelled) return;
        status.textContent = String(e.message || e);
        goBtn.disabled = false;
        input.disabled = false;
        return;
      }
      if (cancelled) return;
      const list = parsed.tracks.map((item, index) => ({ item, index }));
      const total = list.length;
      let done = 0, matched = 0;
      const matches = new Array(total);
      const workers = Array.from({ length: 2 }, async () => {
        while (list.length && !cancelled) {
          const entry = list.shift();
          const item = entry.item;
          // A YouTube list arrives as the uploads themselves, so there is nothing to look
          // up and nothing to get wrong.
          if (item.match) {
            if (!Store.isBlocked(item.match)) { matches[entry.index] = item.match; matched++; }
          } else {
            try {
              const t = await Api.matchTrack(item.title, item.artist);
              if (t && !Store.isBlocked(t)) {
                matches[entry.index] = t;
                matched++;
              }
            } catch (e) {}
          }
          done++;
          status.textContent = "Matching " + done + "/" + total + " · " + matched + " found";
        }
      });
      await Promise.all(workers);
      if (cancelled) return;
      const matchedTracks = matches.filter(Boolean);
      if (!matchedTracks.length) {
        running = false;
        status.textContent = "No matching songs were found";
        goBtn.disabled = false;
        input.disabled = false;
        return;
      }
      // Straight into a playlist that already exists, if that is what was chosen - an
      // import used to always make a new one, so merging two sources meant moving songs
      // across by hand afterwards.
      let imported = 0;
      let already = 0;
      let pl;
      try {
        const existing = targetId ? Store.getPlaylist(targetId) : null;
        pl = existing || Store.createPlaylist(parsed.name || "Imported playlist");
        matchedTracks.forEach(t => {
          Store.addTrack(t);
          if (Store.addToPlaylist(pl.id, t.id)) imported++;
          else already++;
        });
      } catch (e) {
        // The store has already said what went wrong (a full disk); the sheet must
        // not stay stuck on "Matching" with its buttons disabled.
        running = false;
        goBtn.disabled = false;
        input.disabled = false;
        status.textContent = "Could not save the playlist. Check device storage and try again.";
        return;
      }
      const existing = !!targetId && pl && pl.id === targetId;
      shutImport();
      const tail = already ? " (" + already + " already there)" : (imported < total ? " (rest not found)" : "");
      V.toast((existing ? 'Added to "' : 'Imported "') + pl.name + '": ' + imported + " of " + total + " songs" + tail);
      V.render();
    };
    goBtn.onclick = run;
    input.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  }
})();
