(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    refreshAppVersion: { get: () => refreshAppVersion },
    showCacheVersion: { get: () => showCacheVersion }
  });

  function showCacheVersion() {
    const label = document.getElementById("set-version");
    if (!label) return;
    const worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    label.textContent = "Aura " + V.APP_VERSION + (worker ? " · Cache: checking…" : " · Cache: not active");
    if (!worker) return;
    const channel = new MessageChannel();
    let finished = false;
    const finish = cache => {
      if (finished) return;
      finished = true; clearTimeout(timer); channel.port1.close();
      if (document.getElementById("set-version") !== label || navigator.serviceWorker.controller !== worker) return;
      label.textContent = "Aura " + V.APP_VERSION + " · Cache: " + (typeof cache === "string" && /^aura-v\d+$/.test(cache) ? cache : "unavailable");
    };
    const timer = setTimeout(() => finish(null), 2000);
    channel.port1.onmessage = event => finish(event.data && event.data.cache);
    try { worker.postMessage({ type: "GET_CACHE_VERSION" }, [channel.port2]); }
    catch { finish(null); }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", showCacheVersion);

  async function refreshAppVersion(btn) {
    if (btn.disabled) return;
    const original = btn.innerHTML;
    const title = btn.querySelector(".set-title");
    btn.disabled = true;
    if (title) title.textContent = "Refreshing…";
    else btn.textContent = "Refreshing…";

    const log = message => { if (window.Log) Log.add("refresh", message); };
    const restore = () => {
      btn.disabled = false;
      btn.innerHTML = original;
    };
    // Bound every browser operation. A pending promise never reaches catch/finally
    // by itself, and must not prevent navigation or leave the button disabled.
    const step = async (name, action, timeout) => {
      log(name + " started");
      let timer;
      try {
        const result = await Promise.race([
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeout); }),
          Promise.resolve().then(action)
        ]);
        log(name + " completed");
        return result;
      } catch (error) {
        log(name + " failed: " + String((error && error.message) || error).slice(0, 160));
        return null;
      } finally { clearTimeout(timer); }
    };

    log("requested from " + V.APP_VERSION);
    let reachable = false;
    try {
      if ("serviceWorker" in navigator) {
        // Only update the registration controlling this app, not other apps on the host.
        const reg = await step("find service worker", () => navigator.serviceWorker.getRegistration(), 2000);
        if (reg) {
          reachable = !!(await step("update service worker", () => reg.update().then(() => true), 3000));
          const waiting = reg.waiting || reg.installing;
          if (waiting) {
            try { waiting.postMessage({ type: "SKIP_WAITING" }); log("activation requested"); }
            catch (error) { log("activation failed: " + String(error.message || error)); }
          }
        }
      }
      // The update check above only succeeds by reading sw.js from the server. With no
      // server there is nothing to fetch the shell back from, and clearing it then left
      // an app that could not open at all until the signal returned.
      if (!reachable) log("server not reached, keeping the installed app");
      if (reachable && "caches" in window) {
        const keys = await step("list app caches", () => caches.keys(), 1500);
        if (keys) {
          await step("clear app shell", () => Promise.all(keys.filter(key => /^aura-v\d+$/.test(key)).map(key => caches.delete(key))), 1500);
        }
      }
    } finally {
      // Schedule recovery before navigation too, in case the browser refuses replace().
      const restoreTimer = setTimeout(restore, 2000);
      setTimeout(() => {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("refresh", String(Date.now()));
          log("reloading from network");
          window.location.replace(url.toString());
        } catch (error) {
          log("reload failed: " + String(error.message || error));
          clearTimeout(restoreTimer);
          restore();
          V.toast("Couldn't reload - close and reopen the app", "err");
        }
      }, 350);
    }
  }
})();
