(function () {
  const V = window.Aura.views;
  // A playlist's cover: the four-up mosaic, a picked picture squared and kept small.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    pickPlaylistCover: { get: () => pickPlaylistCover },
    playlistArtHtml: { get: () => playlistArtHtml },
    playlistCoverSrc: { get: () => playlistCoverSrc }
  });

  // ---------------- Playlist covers ----------------

  // A playlist either wears a picture someone chose for it or it wears its own songs -
  // four of them in a square. Below four there is nothing to tile, so it stays what it has
  // always been: the first song's artwork across the whole tile.
  const PL_COVER_SIZE = 320;

  const PL_COVER_MAX_BYTES = 120 * 1024;

  function playlistCoverThumbs(pid) {
    const seen = new Set();
    const out = [];
    for (const track of Store.playlistTracks(pid)) {
      const src = track.thumb || Api.thumbFor(track.id);
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
      if (out.length === 4) break;
    }
    return out;
  }

  function playlistArtHtml(p) {
    if (p && p.cover) return '<img decoding="async" src="' + V.esc(p.cover) + '" loading="lazy" alt="" />';
    const thumbs = playlistCoverThumbs(p.id);
    if (thumbs.length >= 4) {
      return '<div class="cover-grid">' +
        thumbs.map(src => '<img decoding="async" src="' + V.esc(src) + '" loading="lazy" alt="" />').join("") + '</div>';
    }
    if (thumbs.length) return '<img decoding="async" src="' + V.esc(thumbs[0]) + '" loading="lazy" alt="" />';
    return '<div class="pl-ph">♪</div>';
  }

  // One url, for the places that need exactly that - the blurred page backdrop, the sticky
  // bar, a tile too small for a mosaic to read as anything but noise.
  function playlistCoverSrc(p) {
    if (!p) return "";
    if (p.cover) return p.cover;
    return playlistCoverThumbs(p.id)[0] || "";
  }

  // What comes off a phone camera is several megabytes of the wrong shape. This crops to
  // the centre square and re-encodes small, because the result is stored on the playlist
  // record itself - which is what gets synced and written into every backup file.
  function squareCoverDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          if (!side) throw new Error("empty image");
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = PL_COVER_SIZE;
          canvas.getContext("2d").drawImage(img,
            (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
            0, 0, PL_COVER_SIZE, PL_COVER_SIZE);
          let out = canvas.toDataURL("image/jpeg", 0.8);
          if (out.length > PL_COVER_MAX_BYTES) out = canvas.toDataURL("image/jpeg", 0.6);
          resolve(out);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
      img.src = url;
    });
  }

  function pickPlaylistCover(pid) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        Store.setPlaylistCover(pid, await squareCoverDataUrl(file));
        V.toast("Cover updated");
        V.render();
      } catch (e) {
        V.toast("Couldn't read that image", "err");
      }
    };
    input.click();
  }
})();
