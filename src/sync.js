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
    describe: { get: () => describe },
    hasConflict: { get: () => hasConflict },
    init: { get: () => init },
    onChange: { get: () => onChange },
    pushNow: { get: () => pushNow },
    recoverConflict: { get: () => recoverConflict }
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

  // A keepalive upload on the way out of the app is one the page never hears back from:
  // the server's stamp moves, the local one does not, and the copy comes back on the next
  // launch looking like another device's newer changes. Recognise this device's own data.
  // The server keeps the whole backup it was sent; the library is what is inside it.
  /**
   * @param {{ data?: Object }} remote
   * @returns {boolean} True when the server copy holds exactly this device's data.
   */
  function sameAsLocal(remote) {
    try { return JSON.stringify(remote && remote.data) === JSON.stringify(Store.exportData().data); }
    catch (e) { return false; }
  }

  // A device with nothing in it has nothing worth a conflict copy: a fresh install
  // whose first instance lookup marked it dirty used to upload an empty library over
  // another device's waiting changes.
  /**
   * @param {Object} data Backup data.
   * @returns {boolean} True when there is nothing in the library, history or follows.
   */
  function bareStore(data) {
    return ["library", "playlists", "liked", "recents", "follows"]
      .every(key => !Array.isArray(data && data[key]) || !data[key].length);
  }

  async function adoptRemote(body) {
    const state = readState();
    // Nothing here worth a conflict copy, but the server's library still has to come in:
    // taking its stamp without its data let the next edit upload the empty library over it.
    const bare = state.dirty && bareStore(Store.exportData().data);
    if (state.dirty && !bare && sameAsLocal(body.data)) {
      writeState({
        stamp: body.stamp || 0,
        at: Date.now(),
        email: body.email || state.email || "",
        size: body.size || 0,
        dirty: false
      });
      notifyListeners();
      return;
    }
    if (state.dirty && !bare) {
      const revision = changeRevision;
      try {
        // The server refuses to replace a waiting copy unless it is named. The one this
        // device left while edits were still arriving is its own older snapshot.
        const headers = { "Content-Type": "application/json" };
        if (state.ownConflict) headers["If-Match"] = String(state.ownConflict);
        const res = await fetch(CONFLICT, {
          method: "PUT",
          headers,
          body: JSON.stringify(Store.exportData()),
          cache: "no-store"
        });
        if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
        conflictOnServer = true;
        if (revision !== changeRevision) {
          let saved = null;
          try { saved = await res.json(); } catch (e) {}
          writeState(Object.assign(readState(), { ownConflict: (saved && saved.stamp) || 0 }));
          lastError = "Local changes continued during sync; retrying without replacing them";
          schedulePush(PUSH_DEBOUNCE_MS);
          return;
        }
        if (window.Views && Views.toast) Views.toast("Updated from your other devices - a copy of this device's newer changes is kept under Settings");
      } catch (e) {
        log("could not save a conflict copy: " + String((e && e.message) || e));
        // Adopting now would destroy this device's newer changes with no copy of them
        // anywhere. Stay dirty; the next contact tries the backup again.
        if (window.Views && Views.toast) {
          Views.toast(e && e.status === 409
            ? "Another device's changes are already waiting under Settings - this device's changes stay here until those are restored or discarded"
            : "Couldn't back up this device's newer changes, so they were kept here for now", "err");
        }
        writeState(Object.assign({}, state, { at: Date.now(), email: body.email || state.email || "" }));
        notifyListeners();
        return;
      }
    }
    importing = true;
    try {
      Store.importData(body.data, { preserveDownloads: true });
    } catch (e) {
      lastError = "Remote copy rejected: " + String((e && e.message) || e);
      log(lastError);
      notifyListeners();
      return;
    } finally {
      importing = false;
    }
    writeState({
      stamp: body.stamp || 0,
      at: Date.now(),
      email: body.email || state.email || "",
      size: body.size || 0,
      dirty: false
    });
    // A push armed before this adopt would upload the copy just adopted, moving the
    // server stamp and making every other device adopt and reload once more.
    clearTimeout(pushTimer);
    pushTimer = 0;
    notifyListeners();
    reloadWhenIdle();
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
      await adoptRemote(body);
      return;
    }
    if (remoteStamp < (state.stamp || 0)) {
      // The server went back in time (a restored volume, a moved data directory). A
      // device with local changes goes through the conflict path; a clean device holds
      // the newest copy there is and must offer it, not replace it with the old one.
      if (state.dirty) { await adoptRemote(body); return; }
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
        if (remote.data) await adoptRemote(remote);
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
    pushTimer = setTimeout(() => {
      pushTimer = 0;
      // After a failed contact push has nothing to do, and nothing asked the server
      // again until the app was left and reopened. An edit is reason enough to try.
      queueSync(available || unsupported ? push : pullOrPush);
    }, delay);
  }

  /**
   * @returns {Promise<void>}
   */
  function pushNow() {
    return queueSync(pullOrPush);
  }

  /**
   * @returns {Promise<boolean>} Whether the server holds a conflict copy to recover.
   */
  async function hasConflict() {
    if (!available) return conflictOnServer;
    try {
      const res = await fetch(CONFLICT, { cache: "no-store" });
      conflictOnServer = res.status === 200;
      return conflictOnServer;
    } catch (e) {
      return conflictOnServer;
    }
  }

  /**
   * Restores the other device's copy the server kept, and saves it as the current one.
   * @returns {Promise<void>}
   */
  function recoverConflict() { return queueSync(recoverConflictNow); }

  async function recoverConflictNow() {
    const startingRevision = changeRevision;
    const res = await fetch(CONFLICT, { cache: "no-store" });
    if (!res.ok) throw new Error("No recovered copy was found");
    const body = await res.json();
    const head = await fetch(ENDPOINT, { cache: "no-store" });
    if (!head.ok) throw new Error("Couldn't read the server copy; nothing was restored");
    const remote = await head.json();
    if (startingRevision !== changeRevision) throw new Error("Local changes were made during recovery; retry to restore the copy");
    importing = true;
    try { Store.importData(body.data, { preserveDownloads: true }); } finally { importing = false; }
    const revision = ++changeRevision;
    writeState(Object.assign(readState(), { stamp: remote.stamp || 0, dirty: true }));
    const saved = await fetch(ENDPOINT, {
      method: "PUT", headers: { "Content-Type": "application/json", "If-Match": String(remote.stamp || 0) },
      body: JSON.stringify(Store.exportData()), cache: "no-store"
    });
    if (!saved.ok) throw new Error("Recovered locally; server save failed. The other-device copy was kept.");
    const out = await saved.json();
    writeState(Object.assign(readState(), { stamp: out.stamp, dirty: revision !== changeRevision, at: Date.now() }));
    const removed = await fetch(CONFLICT, { method: "DELETE", headers: { "If-Match": String(body.stamp || 0) } });
    if (!removed.ok) throw new Error("Recovered and saved; a newer other-device copy was kept");
    conflictOnServer = false;
    notifyListeners();
    if (revision !== changeRevision) schedulePush(PUSH_DEBOUNCE_MS);
    if (window.Views) Views.render();
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
      if (!available || syncTasks || pushing || !readState().dirty) return;
      try {
        const body = JSON.stringify(Store.exportData());
        if (new TextEncoder().encode(body).byteLength > KEEPALIVE_LIMIT) return;
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
