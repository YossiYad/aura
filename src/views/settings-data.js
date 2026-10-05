(function () {
  const V = window.Aura.views;
  // Backup, sync status, storage, the blocked list and the danger zone.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    bindBackupControls: { get: () => bindBackupControls },
    bindBlockedCard: { get: () => bindBlockedCard },
    bindDangerZone: { get: () => bindDangerZone },
    bindStorageActions: { get: () => bindStorageActions },
    bindSyncStatus: { get: () => bindSyncStatus }
  });

  function bindBackupControls(lastBackup) {
    document.getElementById("set-refresh").onclick = e => V.refreshAppVersion(e.currentTarget);
    document.getElementById("set-backup").onclick = () => {
      V.downloadBackup();
      V.toast("Backup downloaded");
    };
    const autoBackup = document.getElementById("set-autobackup");
    if (autoBackup) {
      // A stored handle loses its permission when the browser restarts, and the writes
      // then failed silently forever - the only sign was a backup date that stopped
      // moving. Say it out loud, and let the button put it right.
      V.backupHandle("get").then(async handle => {
        if (!handle) return;
        autoBackup.textContent = "Update automatic backup file";
        let state = "granted";
        try { state = await handle.queryPermission({ mode: "readwrite" }); } catch (e) { state = "prompt"; }
        const status = document.getElementById("set-backup-status");
        if (state === "granted") {
          if (status) status.textContent = "Automatic backup is active - last saved " + lastBackup;
          return;
        }
        autoBackup.textContent = "Automatic backup needs permission again";
        if (status) status.textContent = "Automatic backup is paused - it lost permission to write the file";
      }).catch(() => {});
      autoBackup.onclick = async () => {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: "aura-backup.json",
            types: [{ description: "Aura backup", accept: { "application/json": [".json"] } }]
          });
          await V.backupHandle("set", handle);
          await V.writeBackupFile(handle);
          autoBackup.textContent = "Update automatic backup file";
          document.getElementById("set-backup-status").textContent = "Automatic backup is active";
          V.toast("Automatic backup enabled");
        } catch (error) {
          if (error.name !== "AbortError") V.toast("Could not enable automatic backup", "err");
        }
      };
    }
    const restoreFile = /** @type {HTMLInputElement} */ (document.getElementById("set-restore-file"));
    document.getElementById("set-restore").onclick = () => restoreFile.click();
    restoreFile.onchange = async () => {
      const file = restoreFile.files && restoreFile.files[0];
      if (!file) return;
      try {
        const result = Store.importData(JSON.parse(await file.text()));
        V.toast("Restored " + result.songs + " songs and " + result.playlists + " playlists");
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        V.toast(error.message || "Could not restore this backup", "err");
      }
    };
    document.getElementById("set-logs").onclick = () => V.openLogs();
    // Shown once the server says it has an installer to give, to a browser that can use it.
    const appRow = document.getElementById("set-desktop-app-row");
    const download = V.desktopDownload();
    if (appRow && download && typeof fetch === "function") {
      document.getElementById("set-desktop-app").onclick = V.openDesktopAppDialog;
      fetch(download.file, { method: "HEAD" })
        .then(reply => { if (reply.ok && appRow.isConnected) appRow.hidden = false; })
        .catch(() => {});
    }
  }

  function bindSyncStatus() {
    if (window.Sync) {
      const syncStatus = document.getElementById("set-sync-status");
      const syncNow = /** @type {HTMLButtonElement} */ (document.getElementById("set-sync-now"));
      const syncConflict = /** @type {HTMLButtonElement} */ (document.getElementById("set-sync-conflict"));
      const syncDiscard = /** @type {HTMLButtonElement} */ (document.getElementById("set-sync-discard"));
      const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
      const paintSync = () => {
        // The subscription outlives the page - a sync event can land after the user has
        // left, and the captured nodes are then detached. Nothing to paint then.
        if (!syncStatus.isConnected) return;
        const d = Sync.describe();
        if (!d.ready) {
          syncStatus.textContent = d.error && !d.available ? "Sync is offline right now - changes stay on this device and upload when it returns" : "Checking sync…";
          syncNow.hidden = true;
          syncConflict.hidden = syncDiscard.hidden = true;
          return;
        }
        if (!d.available) {
          // Only a server that answered without sync has none. One that was synced with
          // before and cannot be reached now read the same, and hid the way to try again.
          syncStatus.textContent = d.unsupported
            ? "This server does not run sync - your data lives only on this device"
            : "Sync is offline right now - changes stay on this device and upload when it returns";
          syncNow.hidden = !!d.unsupported;
          syncConflict.hidden = syncDiscard.hidden = true;
          return;
        }
        let line = "Server copy for " + d.email;
        if (d.size) line += " · " + fmtBytes(d.size);
        line += d.at ? " · updated " + new Date(d.at).toLocaleString() : " · not uploaded yet";
        if (d.dirty) line = "Changes waiting to upload · " + line;
        if (d.error) line = d.error + " · " + line;
        syncStatus.textContent = line;
        syncNow.hidden = false;
        Sync.hasConflict().then(has => { syncConflict.hidden = syncDiscard.hidden = !has; }).catch(() => {});
      };
      // A subscription cannot be removed, and this page is rendered again and again;
      // one standing subscription forwards to whichever painter belongs to the current
      // nodes instead of keeping every painter ever made alive.
      V.syncStatusPainter = paintSync;
      if (!V.syncStatusSubscribed) {
        V.syncStatusSubscribed = true;
        Sync.onChange(() => { if (V.syncStatusPainter) V.syncStatusPainter(); });
      }
      paintSync();
      syncNow.onclick = () => {
        syncNow.disabled = true;
        Promise.resolve(Sync.pushNow()).catch(() => {}).finally(() => {
          syncNow.disabled = false;
          paintSync();
        });
      };
      syncConflict.onclick = async () => {
        syncConflict.disabled = true;
        try {
          await Sync.recoverConflict();
        } catch (error) {
          V.toast(error.message || "Could not recover that copy", "err");
          syncConflict.disabled = false;
        }
      };
      // The notice that a waiting copy holds this device back names two ways out; recovering
      // was the only one here, and it replaces this device's library with that copy.
      syncDiscard.onclick = async () => {
        if (!confirm("Discard the copy another device left on the server? The changes in it will be lost.")) return;
        syncDiscard.disabled = true;
        try {
          await Sync.discardConflict();
          V.toast("Discarded the other device's copy");
        } catch (error) {
          V.toast(error.message || "Could not discard that copy", "err");
        } finally {
          syncDiscard.disabled = false;
          paintSync();
        }
      };
    } else {
      const syncStatus = document.getElementById("set-sync-status");
      if (syncStatus) syncStatus.textContent = "Sync isn't configured - your data stays on this device";
    }
  }

  function bindStorageActions() {
    const cacheBtn = /** @type {HTMLButtonElement} */ (document.getElementById("set-clearcache"));
    Player.cacheStats().then(st => {
      const title = cacheBtn.querySelector(".set-title");
      if (st.count && title && cacheBtn.isConnected) title.textContent = "Clear song cache (" + st.count + " songs, " + Math.round(st.bytes / 1048576) + " MB)";
    }).catch(() => {});
    cacheBtn.onclick = () => {
      cacheBtn.disabled = true;
      Player.clearCache().then(() => {
        const title = cacheBtn.querySelector(".set-title");
        if (title) title.textContent = "Clear song cache";
        V.toast("Song cache cleared");
      }).catch(error => {
        V.toast((error && error.message) || "Could not clear the song cache", "err");
      }).finally(() => { cacheBtn.disabled = false; });
    };
    document.getElementById("set-clearsearches").onclick = () => {
      Store.clearSearches();
      V.toast("Search history cleared");
    };
    document.getElementById("set-clearhistory").onclick = () => {
      Store.clearHistory();
      V.toast("Listening history cleared");
    };
    document.getElementById("set-stats").onclick = () => V.pushSubView({ kind: "stats" });
  }

  function bindBlockedCard() {
    const card = document.getElementById("blocked-card");
    if (!card) return;
    /** @type {NodeListOf<HTMLButtonElement>} */ (card.querySelectorAll("[data-unblock]")).forEach(b => {
      b.onclick = () => {
        if (b.dataset.unblock === "artist") Store.unblockArtist(b.dataset.key);
        else Store.unblockTrack(b.dataset.key);
        card.innerHTML = V.blockedCardHtml();
        bindBlockedCard();
        V.toast("No longer blocked");
      };
    });
  }

  function bindDangerZone() {
    document.getElementById("set-clear").onclick = () => {
      if (confirm("Delete your entire library, playlists and history?")) {
        Store.clearAll();
        V.toast("Library, playlists and history deleted");
        V.render(true);
      }
    };
  }
})();
