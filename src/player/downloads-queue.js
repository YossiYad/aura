(function () {
  const V = window.Aura.player;
  // The download queue: what waits, what is in flight, the retries, the Wi-Fi wait and the persisted list a killed app picks up.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    dlProgress: { get: () => dlProgress },
    downloadCounts: { get: () => downloadCounts },
    downloadProgress: { get: () => downloadProgress },
    downloadsBlockedByWifi: { get: () => downloadsBlockedByWifi },
    downloadState: { get: () => downloadState },
    downloadStatus: { get: () => downloadStatus },
    downloadTries: { get: () => downloadTries },
    keepStorage: { get: () => keepStorage },
    lastProgressEmit: { get: () => lastProgressEmit, set: value => { lastProgressEmit = value; } },
    queueDownloads: { get: () => queueDownloads },
    resumeDownloadQueue: { get: () => resumeDownloadQueue },
    wakeDownloadQueue: { get: () => wakeDownloadQueue }
  });

  // Asked once there is something worth keeping. Storage that is not marked persistent
  // is the browser's to clear when the device runs short of space - the saved songs,
  // and the installed app with them, which is what offline rests on.
  let storageKeepAsked = false;

  function keepStorage() {
    if (storageKeepAsked) return;
    storageKeepAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {}
  }

  // Downloads used to be one track at a time, awaited from the sheet the user tapped, with
  // a failure collapsing into a toast they could not act on. A queue lets a whole album go
  // at once and keeps a failed track visible so it can be retried.
  const downloadQueue = [];

  const downloadState = new Map();

  let downloadRunning = false;

  const downloadTries = new Map();

  const dlProgress = new Map();

  let inFlight = null;

  let lastProgressEmit = 0;

  // With an id, that track's progress; without one, whatever is being fetched right now.
  /**
   * @param {string} [id] Default: the download running now.
   * @returns {{ got: number, total: number } | null} Bytes; `total` is 0 when unknown.
   */
  function downloadProgress(id) {
    if (id) return dlProgress.get(id) || null;
    return inFlight ? (dlProgress.get(inFlight.id) || null) : null;
  }

  // The queue lived only in memory, so queueing an album and switching apps - which on a
  // phone is what always happens next - lost everything still waiting, silently. It is
  // written down and picked back up on the next launch.
  function saveDownloadQueue() {
    try {
      // The one being fetched stays on the list until it is actually saved, so a phone
      // killed mid-download picks that track up again rather than dropping it.
      const pending = (inFlight ? [inFlight] : []).concat(downloadQueue)
        .map(t => ({ id: t.id, title: t.title, artist: t.artist,
        album: t.album || "", thumb: t.thumb || "", duration: t.duration || 0,
        artistId: t.artistId || null, artistThumb: t.artistThumb || "",
        artistVerified: t.artistVerified === true, kind: t.kind, podcast: t.podcast || "" }));
      localStorage.setItem("aura.downloadQueue", JSON.stringify(pending));
    } catch (e) {}
  }

  let downloadQueueResumed = false;

  function resumeDownloadQueue() {
    if (downloadQueueResumed) return;
    downloadQueueResumed = true;
    let pending = [];
    try { pending = JSON.parse(localStorage.getItem("aura.downloadQueue") || "[]"); } catch (e) {}
    if (!Array.isArray(pending) || !pending.length) return;
    V.log("download", "picking up " + pending.length + " unfinished download" + (pending.length === 1 ? "" : "s"));
    queueDownloads(pending);
  }

  /**
   * @param {string} id
   * @returns {"pending" | "busy" | "done" | "failed" | null}
   */
  function downloadStatus(id) { return downloadState.get(id) || null; }

  /**
   * @returns {{ working: number, failed: number }}
   */
  function downloadCounts() {
    let working = 0, failed = 0;
    downloadState.forEach(v => {
      if (v === "pending" || v === "busy") working++;
      else if (v === "failed") failed++;
    });
    return { working, failed };
  }

  /**
   * Adds tracks to the download queue, skipping ones already saved or queued.
   * @param {Track[]} tracks
   * @returns {number} How many were added.
   */
  function queueDownloads(tracks) {
    // Whatever the last session left unfinished goes first, and the list written
    // below must include it: writing only the new track threw the rest away.
    if (!downloadQueueResumed) resumeDownloadQueue();
    const saved = Store.downloadedTracks ? new Set(Store.downloadedTracks().map(t => t.id)) : new Set();
    let added = 0;
    for (const t of tracks || []) {
      if (!t || !t.id) continue;
      const at = downloadState.get(t.id);
      if (at === "pending" || at === "busy" || at === "done") continue;
      // Already on the device from an earlier session: "Download all" is one action,
      // not a fresh copy of every song in the list.
      if (at !== "failed" && saved.has(t.id)) continue;
      downloadTries.delete(t.id);
      downloadState.set(t.id, "pending");
      downloadQueue.push(t);
      added++;
    }
    if (added) { saveDownloadQueue(); V.emit({ type: "downloads" }); runDownloads(); }
    // A list picked up from the last session whose every entry had in fact finished
    // was otherwise kept and picked up again on every launch.
    else if (!downloadQueue.length && !inFlight) saveDownloadQueue();
    return added;
  }

  // Metered is only claimed on positive evidence - Data Saver, or a connection the
  // browser actually reports as cellular. Browsers that expose nothing at all stay
  // trusted, because blocking every download on them would be worse than the risk.
  function meteredConnection() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return false;
    if (c.saveData) return true;
    return c.type === "cellular";
  }

  /**
   * @returns {boolean} True when downloads wait for Wi-Fi.
   */
  function downloadsBlockedByWifi() {
    return !!(window.Store && Store.settings().wifiOnlyDownloads && meteredConnection());
  }

  let wifiResumeFn = null;

  function waitForWifi() {
    return new Promise(res => { wifiResumeFn = res; });
  }

  function wakeDownloadQueue() {
    if (wifiResumeFn && navigator.onLine !== false && !downloadsBlockedByWifi()) {
      const fn = wifiResumeFn;
      wifiResumeFn = null;
      fn();
    }
  }

  async function runDownloads() {
    if (downloadRunning) return;
    downloadRunning = true;
    while (downloadQueue.length) {
      if (navigator.onLine === false || downloadsBlockedByWifi()) {
        V.log("download", downloadQueue.length + " waiting for a permitted connection");
        V.emit({ type: "downloads" });
        await waitForWifi();
        continue;
      }
      const t = downloadQueue.shift();
      inFlight = t;
      saveDownloadQueue();
      downloadState.set(t.id, "busy");
      V.emit({ type: "downloads" });
      try {
        await V.download(t);
        downloadState.set(t.id, "done");
        V.log("download", t.id + " saved");
      } catch (e) {
        // One source failing is not the same as the song being unavailable, and the
        // fetcher has already tried every source once. A single second attempt, at the
        // back of the queue, covers the blip without grinding on a dead track.
        const tries = (downloadTries.get(t.id) || 0) + 1;
        downloadTries.set(t.id, tries);
        V.log("download", t.id + " failed (try " + tries + "): " + String((e && e.message) || e).slice(0, 60));
        // Read afresh: the connection can drop while the download runs.
        if (/** @type {boolean} */ (navigator.onLine) === false) {
          downloadTries.delete(t.id);
          downloadState.set(t.id, "pending");
          downloadQueue.unshift(t);
        } else if (tries < 2) {
          downloadState.set(t.id, "pending");
          downloadQueue.push(t);
          saveDownloadQueue();
        } else {
          downloadState.set(t.id, "failed");
        }
      }
      dlProgress.delete(t.id);
      inFlight = null;
      saveDownloadQueue();
      V.emit({ type: "downloads" });
    }
    downloadRunning = false;
  }
})();
