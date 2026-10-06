(function () {
  const V = window.Aura.views;
  // When a screen is painted again: stale marks, the pull to refresh, the return from hidden, the now-playing row.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    forceRefresh: { get: () => forceRefresh },
    markNowPlaying: { get: () => markNowPlaying },
    markStale: { get: () => markStale },
    refreshIfStale: { get: () => refreshIfStale },
    refreshing: { get: () => refreshing },
    viewStale: { get: () => viewStale, set: value => { viewStale = value; } }
  });

  // Changing track used to rebuild the whole screen. Every image was thrown away and
  // fetched again - the black flash - and the home page recomputed itself, so the rows
  // silently became different songs while the listener was reading them. The only thing
  // that actually changes on a track change is which row is the current one.
  // Removing the repaint-on-every-track-change fixed the flashing, and took the live
  // updates with it: a song finished, recents changed, and "Jump back in" never noticed.
  // The data changing is the reason to repaint - but not underneath someone reading the
  // screen. If the screen is covered, repaint now; if it is being looked at, wait until
  // they come back to it.
  let viewStale = false;

  function screenCovered() {
    if (document.hidden) return true;
    const fp = document.getElementById("fullplayer");
    if (fp && !fp.hidden) return true;
    // Driving mode covers the screen the same way; marked stale under it, Home kept its
    // old rows after the drive closed, with nothing left to repaint them.
    const drive = document.getElementById("drive");
    if (drive && !drive.hidden) return true;
    return !V.modalEl.hidden || !V.sheetEl.hidden;
  }

  // Everything the home page builds itself from, thrown away so the next render goes and
  // asks again. Used by the pull gesture and by the network coming back.
  let refreshing = false;

  async function forceRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      // With no signal there is nothing to ask again, and the saved rows are all Home has:
      // a pull on a plane used to trade them for five rows of "Couldn't load".
      if (navigator.onLine !== false) {
        Object.keys(V.homeFeeds).forEach(key => delete V.homeFeeds[key]);
        V.homeRecs.items = [];
        try { localStorage.removeItem("aura.homeFeeds"); } catch (e) {}
        try { localStorage.removeItem("aura.homeRecs"); } catch (e) {}
      } else V.toast("You're offline - showing what's saved on this device");
      V.homeDownloads.loaded = false;
      V.view.__painted = null;
      V.render();
      // Long enough that the gesture reads as having done something, short enough that it
      // is never in the way.
      await new Promise(r => setTimeout(r, 450));
    } finally {
      refreshing = false;
    }
  }

  function markStale() {
    // Hidden is not covered: a repaint there, with the network work Home does, is spent
    // on a screen nobody sees. It waits for the return, when refreshIfStale runs.
    if (document.hidden) { viewStale = true; return; }
    if (screenCovered()) {
      // Bulk writes (an import, "add all" in a sheet) notify once or twice per track; the
      // screen underneath is repainted once after the batch, not once per notice.
      if (coveredRender) return;
      coveredRender = setTimeout(() => {
        coveredRender = 0;
        if (document.hidden) { viewStale = true; return; }
        V.render();
      }, 0);
      return;
    }
    viewStale = true;
  }

  let coveredRender = 0;

  /** Renders the current screen when a change arrived while it was hidden. */
  function refreshIfStale() {
    if (!viewStale) return;
    viewStale = false;
    V.render();
  }

  /** Moves the playing marker to the current track without a full V.render. */
  function markNowPlaying() {
    const cur = Player.current();
    const id = cur ? cur.id : null;
    /** @type {NodeListOf<HTMLElement>} */ (V.view.querySelectorAll('.quick-tile[data-recent]')).forEach(el => {
      const active = el.dataset.recent === id;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    });
    /** @type {NodeListOf<HTMLElement>} */ (V.view.querySelectorAll(".song.active, .song-row.active, .dr.active")).forEach(el => {
      if (el.dataset.id !== id) markRowPlaying(el, false);
    });
    if (!id) return;
    /** @type {NodeListOf<HTMLElement>} */ (V.view.querySelectorAll('.song[data-id], .song-row[data-id], .dr[data-id]')).forEach(el => {
      markRowPlaying(el, el.dataset.id === id);
    });
  }

  // The pulsing bars are baked into the artwork markup at render time; a track change
  // repaints nothing, so they have to move with the highlight or they stay on the song
  // that was playing when the list was drawn.
  function markRowPlaying(el, active) {
    el.classList.toggle("active", active);
    const eq = el.querySelector(".eq");
    if (eq) eq.hidden = !active;
    const fab = el.classList.contains("dr") && el.querySelector(".play-fab");
    if (fab) fab.hidden = active;
  }
})();
