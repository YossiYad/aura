(function () {
  const V = window.Aura.main;

  function reloadWithFreshAppVersion() {
    const url = new URL(window.location.href);
    url.searchParams.set("refresh", String(Date.now()));
    window.location.replace(url.toString());
  }

  function activateWaitingWorker(worker) {
    if (!worker) return;
    try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (e) {}
  }

  function watchForAppUpdates(reg, hadController) {
    let reloading = false;
    let pendingReload = false;
    let updateAnnounced = false;

    function reloadWhenQuiet() {
      if (!pendingReload || reloading) return;
      if (Player.current() && (Player.playbackRequested() || !Player.isPaused())) {
        if (window.AppLaunch) window.AppLaunch.finish();
        // Said once per update: this runs on every return to the app, and a listener
        // who switches apps during a long session would otherwise read it every time.
        if (!updateAnnounced && window.Views) {
          updateAnnounced = true;
          Views.toast("App update ready - refresh from Settings when playback is idle");
        }
        return;
      }
      // A late update must not replace an interface the user is already using.
      // The activated worker will supply the new version on the next launch.
      if (window.AppLaunch && !window.AppLaunch.coverUpdate()) return;
      reloading = true;
      try { reloadWithFreshAppVersion(); }
      catch (err) {
        reloading = false;
        if (window.AppLaunch) window.AppLaunch.cancelUpdate();
      }
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // First install claiming an uncontrolled page: the assets in memory are already the
      // freshly fetched ones, so reloading here just restarts the app for no reason.
      if (!hadController) {
        if (window.AppLaunch) window.AppLaunch.finish();
        return;
      }
      pendingReload = true;
      updateAnnounced = false;
      reloadWhenQuiet();
    });

    if (reg.waiting) activateWaitingWorker(reg.waiting);

    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          activateWaitingWorker(worker);
        }
      });
    });

    // An update check only notices a changed sw.js. A deploy that left it alone is caught
    // by having the worker compare its installed shell with the server's. That happens
    // behind the running app and is picked up by the next launch, online or not.
    let shellSyncing = false, shellSyncedAt = 0;
    function syncInstalledShell() {
      const worker = navigator.serviceWorker.controller;
      if (!worker || shellSyncing || reg.installing || reg.waiting || navigator.onLine === false ||
          Date.now() - shellSyncedAt < 5 * 60 * 1000) return;
      shellSyncing = true;
      let channel = null;
      const finish = data => {
        if (!shellSyncing) return;
        shellSyncing = false; clearTimeout(timer);
        if (channel) channel.port1.close();
        // A failed comparison is worth another go, in a minute rather than in five, but
        // not on every return to the app: on a bad connection each one is a full read.
        shellSyncedAt = data && !data.failed ? Date.now() : Date.now() - 4 * 60 * 1000;
        if (data && data.changed && window.Log) Log.add("refresh", "installed app files brought up to date for the next launch");
      };
      const timer = setTimeout(() => finish(null), 30000);
      try {
        channel = new MessageChannel();
        channel.port1.onmessage = event => finish(event.data);
        worker.postMessage({ type: "SYNC_SHELL" }, [channel.port2]);
      } catch (e) { finish(null); }
    }

    const update = () => reg.update().catch(() => {});
    const check = () => update().then(syncInstalledShell);
    update().then(() => {
      if ((!hadController || (!reg.installing && !reg.waiting)) && !pendingReload && window.AppLaunch) {
        window.AppLaunch.finish();
      }
      syncInstalledShell();
    });
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        check();
        reloadWhenQuiet();
      }
    });
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(reg => watchForAppUpdates(reg, hadController))
      .catch(() => { if (window.AppLaunch) window.AppLaunch.finish(); });
  } else if (window.AppLaunch) window.AppLaunch.finish();
})();
