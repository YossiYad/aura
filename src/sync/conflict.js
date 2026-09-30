(function () {
  const V = window.Aura.sync;
  // The conflict slot: recognising this device's own copy, adopting another's, and restoring the copy the server kept.
  // Published on V for the other files of this module; see src/sync.js.
  Object.defineProperties(V, {
    adoptRemote: { get: () => adoptRemote },
    blockedByConflict: { get: () => blockedByConflict },
    discardConflict: { get: () => discardConflict },
    hasConflict: { get: () => hasConflict },
    recoverConflict: { get: () => recoverConflict },
    textHash: { get: () => textHash }
  });

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

  // FNV-1a over the text: enough to tell the copy this device sent from any other.
  /**
   * @param {string} text
   * @returns {string}
   */
  function textHash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  // The keepalive upload is remembered by a hash of what went out. Comparing the server
  // copy with the local data instead broke as soon as anything local moved on before the
  // next pull - the queue position, a resume point, the server that answered last - and the
  // device then filed its own newer data as a conflict and adopted its own older copy.
  /**
   * @param {{ data?: Object }} remote
   * @param {{ sentHash?: string }} state
   * @returns {boolean} True when the server copy is the one this device last sent out.
   */
  function sentByThisDevice(remote, state) {
    if (!state.sentHash) return false;
    try { return textHash(JSON.stringify(remote && remote.data)) === state.sentHash; }
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

  const BLOCKED_MESSAGE = "Another device's changes are already waiting under Settings - this device's changes stay here until those are restored or discarded";
  let toldBlocked = false;

  // A slot the server refused to hand over stays taken until someone restores or discards
  // what is in it. Each edit used to upload the whole library twice to hear the same
  // refusal again, and put the same notice on the screen every song.
  /**
   * @returns {boolean} True while this device waits on a conflict slot another copy holds.
   */
  function blockedByConflict() {
    return !!V.readState().conflictBlocked && V.conflictOnServer;
  }

  function tellBlocked() {
    V.lastError = "Another device's changes are waiting - recover or discard them to sync this device";
    if (toldBlocked) return;
    toldBlocked = true;
    if (window.Views && Views.toast) Views.toast(BLOCKED_MESSAGE, "err");
  }

  function clearBlocked() {
    const state = V.readState();
    if (!state.conflictBlocked) return;
    delete state.conflictBlocked;
    V.writeState(state);
    toldBlocked = false;
  }

  async function adoptRemote(body) {
    const state = V.readState();
    // Nothing here worth a conflict copy, but the server's library still has to come in:
    // taking its stamp without its data let the next edit upload the empty library over it.
    const bare = state.dirty && bareStore(Store.exportData().data);
    if (state.dirty && !bare && (sameAsLocal(body.data) || sentByThisDevice(body.data, state))) {
      // Edits since that upload are still this device's to push, on top of its own copy.
      const stillDirty = !sameAsLocal(body.data);
      V.writeState({
        stamp: body.stamp || 0,
        at: Date.now(),
        email: body.email || state.email || "",
        size: body.size || 0,
        dirty: stillDirty
      });
      V.notifyListeners();
      if (stillDirty) V.schedulePush(V.PUSH_DEBOUNCE_MS);
      return;
    }
    let announce = false;
    if (!body.hasConflict) clearBlocked();
    else if (state.dirty && !bare && state.conflictBlocked) {
      // Still taken: asking again would only be refused again.
      tellBlocked();
      V.writeState(Object.assign(V.readState(), { at: Date.now(), email: body.email || state.email || "" }));
      V.notifyListeners();
      return;
    }
    if (state.dirty && !bare) {
      const revision = V.changeRevision;
      try {
        // The server refuses to replace a waiting copy unless it is named. The one this
        // device left while edits were still arriving is its own older snapshot.
        const headers = { "Content-Type": "application/json" };
        if (state.ownConflict) headers["If-Match"] = String(state.ownConflict);
        const res = await fetch(V.CONFLICT, {
          method: "PUT",
          headers,
          body: JSON.stringify(Store.exportData()),
          cache: "no-store"
        });
        if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
        V.conflictOnServer = true;
        // The copy just left is this device's own until the adopt below completes; if
        // that adopt fails, the next attempt has to be able to name it to replace it.
        let saved = null;
        try { saved = await res.json(); } catch (e) {}
        V.writeState(Object.assign(V.readState(), { ownConflict: (saved && saved.stamp) || 0 }));
        clearBlocked();
        if (revision !== V.changeRevision) {
          V.lastError = "Local changes continued during sync; retrying without replacing them";
          V.schedulePush(V.PUSH_DEBOUNCE_MS);
          return;
        }
        announce = true;
      } catch (e) {
        V.log("could not save a conflict copy: " + String((e && e.message) || e));
        // Adopting now would destroy this device's newer changes with no copy of them
        // anywhere. Stay dirty; a taken slot waits for a pull to find it empty, anything
        // else is tried again on the next contact.
        const taken = !!(e && e.status === 409);
        if (taken) {
          V.conflictOnServer = true;
          tellBlocked();
        } else if (window.Views && Views.toast) {
          Views.toast("Couldn't back up this device's newer changes, so they were kept here for now", "err");
        }
        V.writeState(Object.assign({}, state, { at: Date.now(), email: body.email || state.email || "" },
          taken ? { conflictBlocked: true } : {}));
        V.notifyListeners();
        return;
      }
    }
    V.importing = true;
    try {
      Store.importData(body.data, { preserveDownloads: true });
    } catch (e) {
      V.lastError = "Remote copy rejected: " + String((e && e.message) || e);
      V.log(V.lastError);
      V.notifyListeners();
      return;
    } finally {
      V.importing = false;
    }
    V.writeState({
      stamp: body.stamp || 0,
      at: Date.now(),
      email: body.email || state.email || "",
      size: body.size || 0,
      dirty: false
    });
    if (announce && window.Views && Views.toast) Views.toast("Updated from your other devices - a copy of this device's newer changes is kept under Settings");
    // A push armed before this adopt would upload the copy just adopted, moving the
    // server stamp and making every other device adopt and reload once more.
    clearTimeout(V.pushTimer);
    V.pushTimer = 0;
    V.notifyListeners();
    V.reloadWhenIdle();
  }

  /**
   * @returns {Promise<boolean>} Whether the server holds a conflict copy to recover.
   */
  async function hasConflict() {
    if (!V.available) return V.conflictOnServer;
    try {
      const res = await fetch(V.CONFLICT, { cache: "no-store" });
      V.conflictOnServer = res.status === 200;
      return V.conflictOnServer;
    } catch (e) {
      return V.conflictOnServer;
    }
  }

  /**
   * Restores the other device's copy the server kept, and saves it as the current one.
   * @returns {Promise<void>}
   */
  function recoverConflict() { return V.queueSync(recoverConflictNow); }

  async function recoverConflictNow() {
    const startingRevision = V.changeRevision;
    const res = await fetch(V.CONFLICT, { cache: "no-store" });
    if (!res.ok) throw new Error("No recovered copy was found");
    const body = await res.json();
    const head = await fetch(V.ENDPOINT, { cache: "no-store" });
    if (!head.ok) throw new Error("Couldn't read the server copy; nothing was restored");
    const remote = await head.json();
    if (startingRevision !== V.changeRevision) throw new Error("Local changes were made during recovery; retry to restore the copy");
    // Changes this device has not uploaded exist nowhere else. Recovering the waiting copy
    // used to import over them and then empty the slot, and they were gone. They take the
    // recovered copy's place in the slot instead, to be restored or discarded in turn.
    const before = V.readState();
    const own = before.dirty && !bareStore(Store.exportData().data) ? Store.exportData() : null;
    // A device with nothing of its own to keep has no business replacing a server copy it
    // has never seen: those are another device's changes, and the slot the recovered copy
    // leaves would be emptied, so they would exist nowhere. A pull first puts it in step.
    if (!own && (remote.stamp || 0) !== (before.stamp || 0)) {
      throw new Error("The server copy changed since this device last synced; sync first, then restore the copy");
    }
    V.importing = true;
    try { Store.importData(body.data, { preserveDownloads: true }); } finally { V.importing = false; }
    const revision = ++V.changeRevision;
    V.writeState(Object.assign(V.readState(), { stamp: remote.stamp || 0, dirty: true }));
    try {
      const saved = await fetch(V.ENDPOINT, {
        method: "PUT", headers: { "Content-Type": "application/json", "If-Match": String(remote.stamp || 0) },
        body: JSON.stringify(Store.exportData()), cache: "no-store"
      });
      if (!saved.ok) throw new Error("Recovered locally; server save failed. The other-device copy was kept.");
      const out = await saved.json();
      V.writeState(Object.assign(V.readState(), { stamp: out.stamp, dirty: revision !== V.changeRevision, at: Date.now() }));
      if (own) {
        const kept = await fetch(V.CONFLICT, { method: "PUT", cache: "no-store",
          headers: { "Content-Type": "application/json", "If-Match": String(body.stamp || 0) }, body: JSON.stringify(own) });
        if (!kept.ok) throw new Error("Recovered and saved; this device's earlier changes could not be kept on the server");
        V.conflictOnServer = true;
        if (window.Views && Views.toast) Views.toast("Restored the other device's copy - this device's earlier changes are kept under Settings");
      } else {
        const removed = await fetch(V.CONFLICT, { method: "DELETE", headers: { "If-Match": String(body.stamp || 0) } });
        if (!removed.ok) throw new Error("Recovered and saved; a newer other-device copy was kept");
        V.conflictOnServer = false;
      }
    } catch (e) {
      // Until this device's own changes are in the slot they exist only here: a failure
      // on the way puts them back in place of the recovered copy, which the server still
      // keeps, instead of leaving them nowhere behind a message that says otherwise.
      if (own && revision === V.changeRevision) {
        V.importing = true;
        try { Store.importData(own, { preserveDownloads: true }); } finally { V.importing = false; }
        V.writeState(Object.assign(V.readState(), { stamp: before.stamp || 0, dirty: true }));
        if (window.Views) Views.render();
        throw new Error("Couldn't restore the copy; this device's changes were kept (" + String((e && e.message) || e) + ")");
      }
      throw e;
    }
    clearBlocked();
    V.notifyListeners();
    if (revision !== V.changeRevision) V.schedulePush(V.PUSH_DEBOUNCE_MS);
    if (window.Views) Views.render();
  }

  /**
   * Drops the copy waiting on the server. A device holding changes of its own then syncs,
   * which leaves them in the emptied slot and takes the server copy.
   * @returns {Promise<void>}
   */
  async function discardConflict() {
    await V.queueSync(discardConflictNow);
    if (V.readState().dirty) await V.pushNow();
  }

  async function discardConflictNow() {
    const res = await fetch(V.CONFLICT, { cache: "no-store" });
    if (res.status !== 404) {
      if (!res.ok) throw new Error("Couldn't read the waiting copy; nothing was discarded");
      const body = await res.json();
      const removed = await fetch(V.CONFLICT, { method: "DELETE", headers: { "If-Match": String(body.stamp || 0) }, cache: "no-store" });
      if (!removed.ok) throw new Error("The waiting copy changed since it was read, so it was kept");
    }
    V.conflictOnServer = false;
    const state = V.readState();
    delete state.ownConflict;
    V.writeState(state);
    clearBlocked();
    V.lastError = "";
    V.notifyListeners();
  }
})();
