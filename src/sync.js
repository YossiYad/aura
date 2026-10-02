// Types for the Sync module. Declared outside the closure so the editor sees them from any
// file; comments only, nothing at runtime.

/**
 * @typedef {Object} SyncStatus
 * @property {boolean} ready The server has been reached at least once this session.
 * @property {boolean} available
 * @property {boolean} unsupported This host has no sync service.
 * @property {string} email The signed-in identity, as the server reported it.
 * @property {number} at Last successful sync, in ms.
 * @property {number} size Bytes of the last copy sent or received.
 * @property {boolean} dirty There are local changes the server does not have yet.
 * @property {boolean} hasConflict The server kept another device's copy to recover.
 * @property {string} error
 */

/**
 * A playlist kept on the sync server and open to everyone signed in to it.
 * @typedef {Object} SharedPlaylist
 * @property {string} id
 * @property {string} name
 * @property {string} owner
 * @property {boolean} mine
 * @property {number} [count] Number of tracks, on summaries and cached records.
 * @property {number} updatedAt
 * @property {string} updatedBy
 * @property {number} [createdAt]
 * @property {Track[]} [tracks] Missing on summaries.
 * @property {number} [fetchedAt] When the local cache stored it.
 * @property {number} [added] How many tracks an append added, on its reply.
 */

(function () {
  // Sync is one module in two files: this one keeps the personal copy (Store.exportData)
  // on the server and in step across devices, and src/sync/shared.js, loaded after it,
  // holds the shared playlists - a separate server resource - and the module's public
  // face, window.Sync. Each file is its own closure and reaches the other through V,
  // window.Aura.sync, where this file publishes, at its top, what window.Sync takes from it.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).sync = {};
  // Published on V for the other files of this module; see src/sync.js.
  Object.defineProperties(V, {
    available: { get: () => available },
    changeRevision: { get: () => changeRevision, set: value => { changeRevision = value; } },
    CONFLICT: { get: () => CONFLICT },
    conflictOnServer: { get: () => conflictOnServer, set: value => { conflictOnServer = value; } },
    describe: { get: () => describe },
    ENDPOINT: { get: () => ENDPOINT },
    importing: { get: () => importing, set: value => { importing = value; } },
    init: { get: () => init },
    lastError: { get: () => lastError, set: value => { lastError = value; } },
    log: { get: () => log },
    notifyListeners: { get: () => notifyListeners },
    onChange: { get: () => onChange },
    PUSH_DEBOUNCE_MS: { get: () => PUSH_DEBOUNCE_MS },
    pushNow: { get: () => pushNow },
    pushTimer: { get: () => pushTimer, set: value => { pushTimer = value; } },
    queueSync: { get: () => queueSync },
    readState: { get: () => readState },
    reloadWhenIdle: { get: () => reloadWhenIdle },
    schedulePush: { get: () => schedulePush },
    writeState: { get: () => writeState }
  });

  const ENDPOINT = "/api/sync/";
  const CONFLICT = "/api/sync/conflict";
  const STATE_KEY = "aura.syncState";
  const PUSH_DEBOUNCE_MS = 4000;
  const KEEPALIVE_LIMIT = 55000;

  let inited = false;
  let everReady = false;
  let available = false;
  let unsupported = false;
  let lastError = "";
  let conflictOnServer = false;
  let importing = false;
  let pushing = false;
  let pushQueued = false;
  let pushTimer = 0;
  let lastAttempt = 0;
  let changeRevision = 0;
  let reloadPending = false;
  let reloadTimer = 0;
  let reloadWatching = false;
  let syncTasks = 0;
  let syncTail = Promise.resolve();
  // Sync runs one request at a time. One that hangs rather than fails - a connection
  // that is there in name only - held every later sync behind it, and the upload on
  // the way out of the app with them, so each gets a limit.
  /**
   * @param {number} ms
   * @returns {AbortSignal | undefined} Undefined where AbortSignal.timeout is missing.
   */
  function timeLimit(ms) {
    try { return AbortSignal.timeout(ms); } catch (e) { return undefined; }
  }
  /**
   * Runs a sync step after the ones already queued.
   * @param {() => Promise<void>} run
   * @returns {Promise<void>}
   */
  function queueSync(run) {
    syncTasks++;
    const task = syncTail.catch(() => {}).then(run);
    syncTail = task.finally(() => { syncTasks--; });
    return syncTail;
  }
  const listeners = [];

  function log(message) { if (window.Log) Log.add("sync", message); }

  function notifyListeners() {
    listeners.forEach(fn => {
      try { fn(); } catch (e) {}
    });
  }

  function readState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function writeState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /**
   * @returns {SyncStatus}
   */
  function describe() {
    const state = readState();
    return {
      ready: everReady,
      available,
      unsupported,
      email: state.email || "",
      at: state.at || 0,
      size: state.size || 0,
      dirty: !!state.dirty,
      hasConflict: conflictOnServer,
      error: lastError
    };
  }

  /**
   * @param {() => void} fn Called when the sync status changes.
   */
  function onChange(fn) { listeners.push(fn); }

  /**
   * @param {string} message
   * @param {boolean} [permanent] This host has no sync service at all.
   */
  function markUnavailable(message, permanent) {
    available = false;
    lastError = message;
    if (permanent) {
      unsupported = true;
      everReady = true;
    }
    log("unavailable: " + message);
    notifyListeners();
  }

  // Coming back to the app should notice another device's changes, but every app switch
  // asking for the whole copy again is a phone's battery and data spent on nothing. A
  // regained connection is a real reason to look now; a glance at the screen is not.
  const PULL_THROTTLE_MS = 60000;
  function syncOnFocus(force) {
    if (unsupported) return;
    if (!force && available && Date.now() - lastAttempt < PULL_THROTTLE_MS) {
      if (readState().dirty) schedulePush(1000);
      return;
    }
    queueSync(pullOrPush);
  }

  function playing() {
    try {
      const player = window.Player;
      return !!player && (player.playbackRequested() || !player.isPaused());
    } catch (e) { return false; }
  }

  // Replacing the library wholesale is what the reload is for - the queue and the screens
  // are built from the old copy. Cutting a song off to do it is not worth it, so the app
  // is repainted now and the reload waits for the music to stop.
  function reloadWhenIdle() {
    if (playing()) {
      if (window.Views && window.Views.render) { try { window.Views.render(); } catch (e) {} }
      if (!reloadPending) log("holding the reload until playback stops");
    }
    reloadPending = true;
    if (!reloadWatching && window.Player && window.Player.onChange) {
      reloadWatching = true;
      window.Player.onChange(scheduleReload);
    }
    scheduleReload();
  }

  function scheduleReload() {
    if (!reloadPending || reloadTimer || playing()) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = 0;
      // Playback may have started since the timer was armed, including a quick
      // pause and resume. Keep waiting for the next idle event in that case.
      if (!reloadPending || playing()) return;
      reloadPending = false;
      location.reload();
    }, 400);
  }

  async function pullOrPush() {
    lastAttempt = Date.now();
    let res;
    try {
      res = await fetch(ENDPOINT, { headers: { Accept: "application/json" }, cache: "no-store", signal: timeLimit(30000) });
    } catch (e) {
      markUnavailable("offline");
      return;
    }
    if (res.status === 404) {
      markUnavailable("this server has no sync service", true);
      return;
    }
    if (!res.ok) {
      markUnavailable("HTTP " + res.status);
      return;
    }
    let body;
    try { body = await res.json(); }
    catch (e) {
      markUnavailable("unreadable response");
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !Number.isFinite(body.stamp) || body.stamp < 0 || !("data" in body)) {
      markUnavailable("invalid sync response");
      return;
    }
    everReady = true;
    available = true;
    unsupported = false;
    lastError = "";
    const state = readState();
    const remoteStamp = body.stamp || 0;
    conflictOnServer = !!body.hasConflict;
    if (!body.data || typeof body.data !== "object") {
      writeState(Object.assign({}, state, { stamp: remoteStamp }));
      await push();
      return;
    }
    if (remoteStamp > (state.stamp || 0)) {
      await V.adoptRemote(body);
      return;
    }
    if (remoteStamp < (state.stamp || 0)) {
      // The server went back in time (a restored volume, a moved data directory). A
      // device with local changes goes through the conflict path; a clean device holds
      // the newest copy there is and must offer it, not replace it with the old one.
      if (state.dirty) { await V.adoptRemote(body); return; }
      writeState(Object.assign({}, state, { stamp: remoteStamp, dirty: true }));
      await push();
      return;
    }
    writeState(Object.assign({}, state, {
      at: Date.now(),
      email: body.email || state.email || "",
      size: body.size || state.size || 0
    }));
    notifyListeners();
    if (state.dirty) await push();
  }

  async function push() {
    if (!available) return;
    if (pushing) {
      pushQueued = true;
      return;
    }
    pushing = true;
    try {
      const revision = changeRevision;
      const base = readState().stamp || 0;
      const body = JSON.stringify(Store.exportData());
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": String(base) },
        body,
        cache: "no-store",
        keepalive: bodyBytes <= KEEPALIVE_LIMIT,
        signal: timeLimit(60000)
      });
      if (res.status === 409) {
        const remote = await res.json();
        if (remote.data) await V.adoptRemote(remote);
        else {
          writeState(Object.assign(readState(), { stamp: remote.stamp || 0, dirty: true }));
          pushQueued = true;
        }
        return;
      }
      if (res.status === 413) {
        lastError = "server copy limit reached";
        log(lastError);
        notifyListeners();
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const out = await res.json();
      const state = readState();
      writeState({
        stamp: out.stamp || Date.now(),
        at: Date.now(),
        email: out.email || state.email || "",
        size: out.size || bodyBytes,
        dirty: revision !== changeRevision
      });
      if (revision !== changeRevision) pushQueued = true;
      lastError = "";
      notifyListeners();
    } catch (e) {
      lastError = String((e && e.message) || e);
      log("push failed: " + lastError);
      notifyListeners();
    } finally {
      pushing = false;
      if (pushQueued) {
        pushQueued = false;
        schedulePush(1500);
      }
    }
  }

  function schedulePush(delay) {
    clearTimeout(pushTimer);
    // A taken conflict slot refuses every upload until it is restored or discarded; the
    // next pull (a return to the app, a regained connection, Sync now) looks again.
    if (V.blockedByConflict()) {
      pushTimer = 0;
      return;
    }
    pushTimer = setTimeout(() => {
      pushTimer = 0;
      // After a failed contact push has nothing to do, and nothing asked the server
      // again until the app was left and reopened. An edit is reason enough to try.
      // Decided when its turn comes: a pull queued ahead of this push may adopt another
      // device's copy, and that copy must not go back up as this device's edit.
      queueSync(() => {
        if (!(available || unsupported)) return pullOrPush();
        return readState().dirty ? push() : Promise.resolve();
      });
    }, delay);
  }

  /**
   * @returns {Promise<void>}
   */
  function pushNow() {
    return queueSync(pullOrPush);
  }

  function contacted() { return everReady || unsupported; }

  /**
   * Starts syncing: pulls or pushes now, then after every Store change and on return to the app.
   */
  function init() {
    if (inited) return;
    inited = true;
    Store.onChange(() => {
      if (importing) return;
      changeRevision++;
      const state = readState();
      if (!state.dirty) {
        state.dirty = true;
        writeState(state);
      }
      if (contacted()) schedulePush(PUSH_DEBOUNCE_MS);
    });
    window.addEventListener("online", () => syncOnFocus(true));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      syncOnFocus(false);
    });
    window.addEventListener("pagehide", () => {
      if (!available || syncTasks || pushing || !readState().dirty || V.blockedByConflict()) return;
      try {
        const sent = Store.exportData();
        const body = JSON.stringify(sent);
        if (new TextEncoder().encode(body).byteLength > KEEPALIVE_LIMIT) return;
        writeState(Object.assign(readState(), { sentHash: V.textHash(JSON.stringify(sent.data)) }));
        fetch(ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "If-Match": String(readState().stamp || 0) },
          body,
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    });
    queueSync(pullOrPush);
  }
})();
