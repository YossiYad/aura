(function () {
  const V = window.Aura.main;

  // A long press on the home screen icon opens the shortcuts declared in manifest.json,
  // and each one launches the app at ./index.html?open=<name>. The query is stripped once
  // it has been read, so a later refresh - or a Back press landing on this entry - opens
  // the app where the listener left it rather than replaying the shortcut.
  // The refresh marker an update reload adds is stripped the same way: it makes the
  // service worker fetch the document and every script network-first with an eight-second
  // wait each, which is right for that one load and wrong for every reload after it.
  function openLaunchShortcut() {
    let name = "", artist = "", refresh = false;
    try {
      const params = new URLSearchParams(location.search);
      name = params.get("open") || "";
      artist = params.get("artist") || "";
      refresh = params.has("refresh");
    } catch (e) {}
    if (!name && !artist && !refresh) return;
    try {
      history.replaceState(history.state, "", location.pathname + location.hash);
    } catch (e) {}
    if (!name && !artist) return;
    try { if (artist) Views.openFollowedArtist(artist); else Views.openShortcut(name); } catch (e) {}
  }

  if (window.Sync) Sync.init();
  if (window.SharedQueue) SharedQueue.init();
  if (window.Nightly) Nightly.init();
  if (Views.initServerMix) Views.initServerMix();
  if (Views.applyAppearance) Views.applyAppearance();
  V.$("fp-volume").value = String(Math.round(Player.volume() * 100));
  Player.restore();
  V.refreshBar();
  V.refreshTime(true);
  V.syncProgressLoop();
  Views.render();
  openLaunchShortcut();
  // The first launch asks which language to use; English is on screen until then.
  if (Views.askLanguage) Views.askLanguage();
})();
