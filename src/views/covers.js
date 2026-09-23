(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    backupHandle: { get: () => backupHandle },
    BROWSE: { get: () => BROWSE },
    browseHtml: { get: () => browseHtml },
    downloadBackup: { get: () => downloadBackup },
    freshSearchHtml: { get: () => freshSearchHtml },
    pickPlaylistCover: { get: () => pickPlaylistCover },
    playlistArtHtml: { get: () => playlistArtHtml },
    playlistCoverSrc: { get: () => playlistCoverSrc },
    writeBackupFile: { get: () => writeBackupFile }
  });

  // ---------------- Playlist covers ----------------

  // A playlist either wears a picture someone chose for it or it wears its own songs -
  // four of them in a square. Below four there is nothing to tile, so it stays what it has
  // always been: the first song's artwork across the whole tile.
  const PL_COVER_SIZE = 320;
  const PL_COVER_MAX_BYTES = 120 * 1024;

  function playlistCoverThumbs(pid) {
    const seen = new Set();
    const out = [];
    for (const track of Store.playlistTracks(pid)) {
      const src = track.thumb || Api.thumbFor(track.id);
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
      if (out.length === 4) break;
    }
    return out;
  }

  function playlistArtHtml(p) {
    if (p && p.cover) return '<img decoding="async" src="' + V.esc(p.cover) + '" loading="lazy" alt="" />';
    const thumbs = playlistCoverThumbs(p.id);
    if (thumbs.length >= 4) {
      return '<div class="cover-grid">' +
        thumbs.map(src => '<img decoding="async" src="' + V.esc(src) + '" loading="lazy" alt="" />').join("") + '</div>';
    }
    if (thumbs.length) return '<img decoding="async" src="' + V.esc(thumbs[0]) + '" loading="lazy" alt="" />';
    return '<div class="pl-ph">♪</div>';
  }

  // One url, for the places that need exactly that - the blurred page backdrop, the sticky
  // bar, a tile too small for a mosaic to read as anything but noise.
  function playlistCoverSrc(p) {
    if (!p) return "";
    if (p.cover) return p.cover;
    return playlistCoverThumbs(p.id)[0] || "";
  }

  // What comes off a phone camera is several megabytes of the wrong shape. This crops to
  // the centre square and re-encodes small, because the result is stored on the playlist
  // record itself - which is what gets synced and written into every backup file.
  function squareCoverDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          if (!side) throw new Error("empty image");
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = PL_COVER_SIZE;
          canvas.getContext("2d").drawImage(img,
            (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
            0, 0, PL_COVER_SIZE, PL_COVER_SIZE);
          let out = canvas.toDataURL("image/jpeg", 0.8);
          if (out.length > PL_COVER_MAX_BYTES) out = canvas.toDataURL("image/jpeg", 0.6);
          resolve(out);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
      img.src = url;
    });
  }

  function pickPlaylistCover(pid) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        Store.setPlaylistCover(pid, await squareCoverDataUrl(file));
        V.toast("Cover updated");
        V.render();
      } catch (e) {
        V.toast("Couldn't read that image", "err");
      }
    };
    input.click();
  }

  const BROWSE = [
    ["Music", "new music", "#dc148c", "MUSIC"],
    ["Made for you", "personalized music mix", "#1e3264", "MIX"],
    ["New releases", "new music releases", "#608108", "NEW"],
    ["Charts", "top music charts", "#8d67ab", "TOP"],
    ["Pop", "today's pop hits", "#477d95", "POP"],
    ["Hip-Hop", "hip hop essentials", "#ba5d07", "RAP"],
    ["Rock", "rock classics", "#006450", "ROCK"],
    ["Latin", "latin music hits", "#0d73ec", "LATIN"],
    ["Mood", "mood booster music", "#e1118c", "MOOD"],
    ["Indie", "new indie music", "#e91429", "INDIE"],
    ["Workout", "workout music", "#777777", "MOVE"],
    ["Focus", "focus music", "#a56752", "FOCUS"],
    ["Chill", "chill music", "#b06239", "CHILL"],
    ["Sleep", "sleep music", "#1e3264", "SLEEP"],
    ["Party", "party music", "#8d67ab", "PARTY"],
    ["Romance", "love songs", "#dc148c", "LOVE"],
    ["Metal", "metal music", "#e91429", "METAL"],
    ["Jazz", "jazz essentials", "#8d67ab", "JAZZ"],
    ["R&B", "r and b hits", "#ba5d07", "R&B"],
    ["K-Pop", "k pop hits", "#e91429", "K-POP"],
    ["Classical", "classical essentials", "#8c4c32", "CLASSIC"],
    ["Ambient", "ambient essentials", "#148a08", "AMBIENT"],
    ["Electronic", "electronic dance music", "#477d95", "EDM"],
    ["Country", "country music hits", "#d84000", "COUNTRY"],
    ["Soul", "soul classics", "#dc148c", "SOUL"],
    ["Blues", "blues essentials", "#0d73ec", "BLUES"],
    ["Punk", "punk rock", "#e91429", "PUNK"],
    ["Acoustic", "acoustic music", "#ba5d07", "ACOUSTIC"]
  ];

  function browseHtml() {
    return '<div class="browse-grid">' + BROWSE.map(item =>
      '<button class="browse-card" data-browse="' + V.esc(item[1]) + '" data-browse-title="' + V.esc(item[0]) + '" data-browse-color="' + item[2] + '" style="--browse-bg:' + item[2] + '"><span>' + V.esc(item[0]) + '</span><i aria-hidden="true"><b>' + V.esc(item[3]) + '</b></i></button>'
    ).join("") + '</div>';
  }

  function freshSearchHtml() {
    const items = [
      ["Fresh Israeli pop", "new Israeli pop music", "#c54872", "IL POP"],
      ["Hebrew pop", "Hebrew pop hits", "#353535", "HEBREW"],
      ["Fresh hits", "new hit songs", "#8d4b32", "FRESH"]
    ];
    return '<section class="fresh-search"><div class="section-head"><h3>Start something new</h3></div><div class="fresh-rail">' + items.map(item =>
      '<button data-browse="' + V.esc(item[1]) + '" data-browse-title="' + V.esc(item[0]) + '" data-browse-color="' + item[2] + '" style="--fresh-bg:' + item[2] + '"><i>' + V.esc(item[3]) + '</i><span>' + V.esc(item[0]) + '</span></button>'
    ).join("") + '</div></section>';
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  let backupWriteTimer = null;

  function openBackupDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("aura-backup", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("files");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function backupHandle(action, value) {
    const db = await openBackupDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", action === "get" ? "readonly" : "readwrite");
      const request = action === "get" ? tx.objectStore("files").get("automatic") : tx.objectStore("files").put(value, "automatic");
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error || request.error || new Error("Backup storage aborted"));
      };
    });
  }

  async function writeBackupFile(handle) {
    if (!handle || await handle.queryPermission({ mode: "readwrite" }) !== "granted") return false;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(Store.exportData(), null, 2));
    await writable.close();
    localStorage.setItem("aura.lastBackupAt", String(Date.now()));
    return true;
  }

  function scheduleAutomaticBackup() {
    if (!("showSaveFilePicker" in window)) return;
    clearTimeout(backupWriteTimer);
    backupWriteTimer = setTimeout(async () => {
      try { await writeBackupFile(await backupHandle("get")); } catch (e) {}
    }, 1500);
  }

  function downloadBackup() {
    const blob = new Blob([JSON.stringify(Store.exportData(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "aura-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    localStorage.setItem("aura.lastBackupAt", String(Date.now()));
  }

  Store.onChange(scheduleAutomaticBackup);
})();
