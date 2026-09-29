(function () {
  const V = window.Aura.views;
  // The library backup file: written on request, and kept up to date where the browser allows a standing handle.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    backupHandle: { get: () => backupHandle },
    downloadBackup: { get: () => downloadBackup },
    writeBackupFile: { get: () => writeBackupFile }
  });

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
