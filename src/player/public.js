(function () {
  const V = window.Aura.player;

  /**
   * Loads a saved queue without starting playback.
   * @param {SavedQueue | null} [saved] Default: the queue saved by Store.
   * @param {boolean} [sameSitting] The app was not reopened: a queue is being put back
   *   inside a running one, and its song keeps its place whatever Settings says.
   */
  function restore(saved = Store.loadQueue(), sameSitting) {
    if (!saved || !Array.isArray(saved.extra) || !saved.extra.length) return;
    const tracks = saved.extra.filter(t => t && typeof t.id === "string" && t.id);
    const wanted = Number.isInteger(saved.pos) ? Math.max(0, tracks.indexOf(saved.extra[saved.pos])) : 0;
    const at = V.firstPlayableIndex(tracks, wanted);
    if (at === -1) return;
    V.queue = tracks;
    V.setQueuePlaylist(saved.playlist);
    V.resetRadioSession();
    V.queue.forEach(V.rememberRadioTrack);
    V.pos = at;
    V.history = [];
    V.shuffleOrder = [];
    V.shuffle = !!saved.shuffle;
    if (V.shuffle && Array.isArray(saved.shuffleOrder)) {
      V.shuffleOrder = Array.from(new Set(saved.shuffleOrder.filter(id => typeof id === "string")));
      V.syncShuffleOrder();
    }
    V.repeat = ["off", "all", "one"].includes(saved.repeat) ? saved.repeat : "off";
    V.restoredPosition = null;
    // Coming back to the app, the song that was left carries on from where it stopped -
    // or from its start, for a listener who would rather hear it whole: that is theirs to
    // choose in Settings. An episode is not asked here; its own bookmark and its own
    // setting decide where it picks up.
    const fromStart = !sameSitting && Store.settings && Store.settings().reopenSong === "restart";
    try {
      const noted = JSON.parse(localStorage.getItem(V.queuePositionKey()) || "null");
      if (!fromStart && noted && V.current() && noted.id === V.current().id && noted.at > 5) V.restoredPosition = noted;
    } catch (e) {}
    // Register the OS handlers and publish the track now. Without this, after the app has
    // been evicted - which on iOS is constantly - the headphone button and the lock screen
    // do nothing until the app is opened and play is tapped inside it.
    const t = V.current();
    if (t) V.updateMediaSession(t);
    V.emit({ type: "restored" });
  }

  /**
   * Swaps the personal queue for a shared session's queue.
   * @param {string} id Shared session id.
   */
  function beginShare(id) {
    if (V.shareSession === id) return;
    if (V.shareSession) endShare();
    const saved = Store.sharedQueuePlayback();
    // The pause below is reported after the queue is gone, so the personal song's
    // place is noted now, while the note still belongs to the personal queue.
    V.saveListeningPosition();
    V.shareSession = id;
    V.shareExhausted = false;
    V.playQueue([]);
    V.shuffle = false; V.repeat = "off";
    if (saved && saved.id === id) restore({ ...saved, shuffle: false, repeat: "off" }, true);
    V.persist();
  }

  /** Leaves the shared session and brings the personal queue back. */
  function endShare() {
    if (!V.shareSession) return;
    V.playQueue([]);
    V.shareSession = ""; V.shareExhausted = false;
    Store.sharedQueuePlayback(null);
    try { localStorage.removeItem("aura.shareQueueAt"); } catch (e) {}
    restore(undefined, true);
  }

  // Downloads left over from the last session pick up as soon as there is a network to
  // pick them up with.
  if (navigator.onLine === false) window.addEventListener("online", V.resumeDownloadQueue, { once: true });
  else setTimeout(V.resumeDownloadQueue, 1500);
  // Cached songs age out even when nothing new is cached, so the check runs at launch too.
  V.evictCache().catch(() => {});

  // A wifi-blocked queue resumes on any of these, whichever the browser offers.
  window.addEventListener("online", V.wakeDownloadQueue);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) V.wakeDownloadQueue(); });
  if (navigator.connection && navigator.connection.addEventListener) {
    navigator.connection.addEventListener("change", V.wakeDownloadQueue);
  }
  if (window.Store) Store.onChange(what => {
    if (what === "privateSession") { endPrivateQueue(); return; }
    if (what !== "settings") return;
    V.wakeDownloadQueue();
    V.evictCache().catch(() => {});
  });

  // A private session's queue lives with the session. When the session is switched off
  // (or hidden from Settings, which ends it) the queue built under it must not become
  // the personal one at the next save, which is exported and synced to other devices:
  // as at a relaunch, playback stops and the queue from before the session comes back.
  function endPrivateQueue() {
    if (!Store.privateSession || Store.privateSession() || V.shareSession || !V.queue.length) return;
    // No position note for the private song: the session is already over, so the note
    // would be written under its id in the open.
    const personal = Store.loadQueue();
    V.playQueue([]);
    restore(personal, true);
    V.persist();
  }

  window.Player = {
    /** @param {(ev: PlayerEvent) => void} fn */
    onChange: fn => V.listeners.push(fn),
    current: V.current, toggle: V.toggle, pause: V.pausePlay, next: () => V.next(false), prev: V.prev,
    playQueue: V.playQueue, playNext: V.playNext, addToQueue: V.addToQueue, removeAt: V.removeAt, moveAt: V.moveAt, clearUpcoming: V.clearUpcoming, jumpTo: V.jumpTo, replaceCurrent: V.replaceCurrent,
    beginShare, endShare, shareSession: () => V.shareSession,
    queueHistory: V.queueHistory, playFromQueueHistory: V.playFromQueueHistory,
    queueHistorySession: () => V.queueHistorySession,
    dismiss: V.dismiss,
    queue: () => V.queue.slice(),
    upcoming: V.radioUpcoming,
    pos: () => V.pos,
    shuffle: () => V.shuffle,
    setShuffle: V.setShuffle,
    repeat: () => V.repeat,
    cycleRepeat: V.cycleRepeat,
    getTime: V.getTime, isPaused: V.isPaused, playbackRequested: () => V.wantsPlayback || V.loadingInProgress, isLoading: () => V.loadingInProgress,
    releaseForVoice: V.releaseForVoice, primeForPlayback: V.primeForPlayback,
    captureState: () => ({ src: !!V.audio.src, paused: V.audio.paused, ended: V.audio.ended,
      ready: V.audio.readyState, kick: (V.sessionKick && V.sessionKick.state) || "none", backend: V.backend, primed: V.playbackPrimed,
      tts: !!(window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) }),
    seekTo: V.seekTo, setVolume: V.setVolume, volume: () => V.volume,
    needsPlaybackGesture: () => !!V.pendingPlaybackPermission,
    requestRemotePlayback: V.requestRemotePlayback, remotePlaybackStatus: V.remotePlaybackStatus,
    rate: V.rate, setRate: V.setRate, rateChoices: () => V.RATE_CHOICES.slice(),
    setSleepTimer: V.setSleepTimer, sleepTimerState: V.sleepTimerState,
    download: V.download, deleteDownload: V.deleteDownload, getDownload: V.getDownload,
    getArt: V.getArt, artIds: V.artIds,
    queueDownloads: V.queueDownloads, downloadStatus: V.downloadStatus, downloadCounts: V.downloadCounts, downloadProgress: V.downloadProgress,
    downloadsBlockedByWifi: V.downloadsBlockedByWifi,
    cacheStats: V.cacheStats, clearCache: V.clearCache, cacheTrack: V.cacheTrack, localIds: V.localIds, downloadedIds: V.downloadedIds,
    restore
  };
})();
