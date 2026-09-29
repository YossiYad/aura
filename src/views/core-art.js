(function () {
  const V = window.Aura.views;
  // Artwork and the per-row download marks: covers kept with the downloads, the art of a track, the icons a row carries.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    artHtml: { get: () => artHtml },
    artistHtml: { get: () => artistHtml },
    artSrc: { get: () => artSrc },
    artWarmed: { get: () => artWarmed },
    markLocalRows: { get: () => markLocalRows },
    PLAY_ICON: { get: () => PLAY_ICON },
    rowDlBtn: { get: () => rowDlBtn },
    textZoom: { get: () => textZoom },
    warmLocalArt: { get: () => warmLocalArt }
  });

  // The Text size setting scales the content of the view and of sheets with CSS zoom (see
  // app.css). A finger moves in screen pixels and a transform inside that content is drawn
  // in its own, larger ones, so a gesture divides what the finger travelled by this.
  function textZoom() {
    if (!document.documentElement.hasAttribute("data-text-size")) return 1;
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-zoom")) || 1;
  }

  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 21,12 7,20"/></svg>';

  const ROW_DL_ICONS =
    '<svg class="i-dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    '<svg class="i-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
    '<span class="ring"></span>';

  function rowDlBtn(id) {
    return '<button class="row-dl" data-dl="' + V.esc(id) + '" aria-label="Save offline">' + ROW_DL_ICONS + '</button>';
  }

  function markLocalRows() {
    // The tick means downloaded, not "happens to be in the cache right now".
    Player.downloadedIds().then(set => {
      /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".row-dl[data-dl]")).forEach(b => {
        const state = Player.downloadStatus ? Player.downloadStatus(b.dataset.dl) : null;
        // A queued or failed download is worth seeing on the row it belongs to, rather than
        // only in a toast that has already gone.
        b.classList.toggle("busy", state === "pending" || state === "busy");
        const nowDone = set.has(b.dataset.dl) || state === "done";
        if (nowDone && !b.classList.contains("done")) b.classList.add("rn-pop");
        b.classList.toggle("done", nowDone);
        b.title = state === "failed" ? "Download failed - tap to try again" : "";
      });
    });
  }

  // Pictures kept with the downloads, as object URLs, so every list that draws art can
  // reach them without going near the network. Warmed once and kept - a cover is a few
  // tens of kilobytes and the alternative is an empty square with no signal.
  const localArt = new Map();

  let artWarmed = false;

  async function warmLocalArt() {
    if (!Player.artIds) return;
    const ids = await Player.artIds();
    let added = 0;
    for (const id of ids) {
      if (localArt.has(id)) continue;
      const blob = await Player.getArt(id);
      // Every downloads event starts a pass, several a second while a download runs; a
      // pass that got here first has made this one's URL already, and a second would
      // hold its picture in memory with nothing left to release it.
      if (!blob || localArt.has(id)) continue;
      localArt.set(id, URL.createObjectURL(blob));
      added++;
    }
    artWarmed = true;
    // A repaint here replaced the screen under the reader (the filter box being typed
    // in, an inline rename) every time a download finished; the next natural render
    // picks the local artwork up.
    if (added) V.markStale();
    // The player bar draws the current song's cover and has no render of its own to wait for.
    if (added && Player.current() && localArt.has(Player.current().id)) window.dispatchEvent(new Event("aura-local-art"));
  }

  /**
   * @param {Track} track
   * @returns {string} The saved cover when there is one, otherwise the remote one.
   */
  function artSrc(track) {
    return localArt.get(track.id) || track.thumb || Api.thumbFor(track.id);
  }

  function artHtml(track, cls) {
    const src = artSrc(track);
    const active = Player.current() && Player.current().id === track.id;
    return '<div class="art ' + (cls || "") + '"><img decoding="async" src="' + V.esc(src) + '" loading="lazy" alt="" />' +
      '<div class="eq"' + (active ? "" : " hidden") + '><span></span><span></span><span></span><span></span></div></div>';
  }

  function artistHtml(track) {
    if (!track.artistId) return V.esc(track.artist || "");
    return '<button class="track-artist" dir="auto" data-trackartist="' + V.esc(track.artistId) + '" data-trackartistname="' + V.esc(track.artist || "") + '" data-trackartistthumb="' + V.esc(track.artistThumb || "") + '">' + V.esc(track.artist || "") + '</button>';
  }
})();
