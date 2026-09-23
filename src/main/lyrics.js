(function () {
  const V = window.Aura.main;
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    accentId: { get: () => accentId, set: value => { accentId = value; } },
    applyFpAccent: { get: () => applyFpAccent },
    fmt: { get: () => fmt },
    loadLyrics: { get: () => loadLyrics },
    lyricsLines: { get: () => lyricsLines },
    lyricsOffset: { get: () => lyricsOffset, set: value => { lyricsOffset = value; } },
    setPlayIcons: { get: () => setPlayIcons },
    syncLyrics: { get: () => syncLyrics }
  });

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function setPlayIcons(playing) {
    document.querySelectorAll(".i-play").forEach(el => el.toggleAttribute("hidden", playing));
    document.querySelectorAll(".i-pause").forEach(el => el.toggleAttribute("hidden", !playing));
    V.$("pb-eq").hidden = !playing;
    V.$("fullplayer").classList.toggle("paused", !playing);
    V.$("drive-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  let accentToken = 0;
  let accentId = null;
  let lyricsToken = 0;
  let lyricsTrackId = null;
  let lyricsFailed = false;
  let lyricsLines = [];
  let lyricsOffset = 0;
  let lastLyricLine = -1;
  let lyricsTouchedAt = 0;

  function parseLyrics(data) {
    if (!data) return [];
    if (data.syncedLyrics) {
      const lines = [];
      String(data.syncedLyrics).split("\n").forEach(line => {
        const prefix = line.match(/^(?:\[\d+:\d+(?:\.\d+)?\]\s*)+/);
        if (!prefix) return;
        const text = line.slice(prefix[0].length).trim();
        if (!text) return;
        for (const hit of prefix[0].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) {
          lines.push({ at: parseInt(hit[1], 10) * 60 + parseFloat(hit[2]), text });
        }
      });
      if (lines.length) return lines.sort((a, b) => a.at - b.at);
    }
    return String(data.plainLyrics || "").split("\n").map(text => text.trim()).filter(Boolean).map(text => ({ at: null, text }));
  }

  // Direction belongs to the song, not to each line. Resolving it per line made a Hebrew
  // song zig-zag: "La la la", an English hook or a "[Chorus]" marker flipped to the left
  // edge while every neighbouring line sat right.
  function lyricsDirection(lines) {
    let rtl = 0, ltr = 0;
    for (const line of lines) {
      const strong = /[\u0590-\u08FF]/.test(line.text) ? "rtl" : (/[A-Za-z]/.test(line.text) ? "ltr" : null);
      if (strong === "rtl") rtl++;
      else if (strong === "ltr") ltr++;
    }
    return rtl > ltr ? "rtl" : "ltr";
  }

  // A listener scrolling the lyrics themselves gets left alone for a few seconds.
  (function bindLyricsScroll() {
    const holder = V.$("lyrics-lines");
    if (!holder) return;
    ["touchstart", "wheel", "pointerdown"].forEach(ev =>
      holder.addEventListener(ev, () => { lyricsTouchedAt = Date.now(); }, { passive: true }));
  })();

  function renderLyrics() {
    const holder = V.$("lyrics-lines");
    if (!holder) return;
    if (!lyricsLines.length) {
      holder.removeAttribute("dir");
      // A lookup that failed is not a song without lyrics, and offline it read as one.
      holder.innerHTML = '<span dir="auto">' + (lyricsFailed
        ? "Couldn't load the lyrics" + (navigator.onLine === false ? " - they'll load when you're back online" : " right now")
        : "Lyrics are not available for this track.") + '</span>';
      return;
    }
    holder.setAttribute("dir", lyricsDirection(lyricsLines));
    holder.innerHTML = lyricsLines.map((line, i) => '<button data-lyric="' + i + '">' + line.text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + '</button>').join("");
  }

  async function loadLyrics(track, retry = false) {
    if (!track) return;
    const sameTrack = lyricsTrackId === track.id;
    if (sameTrack && !(retry && lyricsFailed)) return;
    lyricsTrackId = track.id;
    lyricsFailed = false;
    lyricsLines = [];
    // lrclib times against the official release while this plays a YouTube upload, which
    // often carries an intro or a different edit, so the offset is per track.
    if (!sameTrack) lyricsOffset = 0;
    lastLyricLine = -1;
    const token = ++lyricsToken;

    const cached = Store.cachedLyrics(track.id);
    if (cached) {
      lyricsLines = cached.none ? [] : parseLyrics(cached);
      renderLyrics();
      // A near-empty hit is worth one more try; a real one is not.
      if (cached.none || lyricsLines.length > 5) return;
    } else {
      V.$("lyrics-lines").innerHTML = '<span>Loading lyrics…</span>';
    }

    try {
      const data = await Api.getLyrics(track);
      if (token !== lyricsToken) return;
      const parsed = parseLyrics(data);
      // Only overwrite a usable cached copy with something at least as good.
      if (parsed.length >= lyricsLines.length) {
        lyricsLines = parsed;
        Store.cacheLyrics(track.id, data || { none: true });
        renderLyrics();
      }
    } catch (e) {
      if (token === lyricsToken) {
        lyricsFailed = true;
        renderLyrics();
      }
    }
  }

  window.addEventListener("online", () => loadLyrics(Player.current(), true));

  function syncLyrics(cur) {
    if (!lyricsLines.length || lyricsLines[0].at == null) return;
    const at = cur + lyricsOffset;
    let active = -1;
    for (let i = 0; i < lyricsLines.length; i++) {
      if (lyricsLines[i].at <= at + 0.15) active = i;
      else break;
    }
    document.querySelectorAll("#lyrics-lines [data-lyric]").forEach((el, i) => el.classList.toggle("active", i === active));
    const line = /** @type {HTMLElement} */ (document.querySelector('#lyrics-lines [data-lyric="' + active + '"]'));
    const holder = V.$("lyrics-lines");
    if (!line || !holder) return;
    // Only when the line changes, so the box does not fight a listener reading ahead.
    if (active === lastLyricLine) return;
    lastLyricLine = active;
    if (Date.now() - lyricsTouchedAt < 6000) return;
    // The collapsed box is a 210px window, so the sung line has to be scrolled to. It was
    // measured with offsetTop, which is relative to the nearest positioned ancestor and
    // not to this box - so the box scrolled to the wrong place and the white line was
    // almost always off screen. Measure against the box itself.
    const top = line.getBoundingClientRect().top - holder.getBoundingClientRect().top + holder.scrollTop;
    holder.scrollTo({
      top: Math.max(0, top - holder.clientHeight / 2 + line.offsetHeight / 2),
      behavior: "smooth"
    });
  }
  function applyFpAccent(track) {
    if (!track || track.id === accentId) return;
    accentId = track.id;
    const fp = V.$("fullplayer");
    const token = ++accentToken;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (token !== accentToken) return;
      try {
        const c = document.createElement("canvas");
        c.width = 8; c.height = 8;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        r /= n; g /= n; b /= n;
        const max = Math.max(r, g, b, 1);
        const boost = Math.min(1.65, 145 / max);
        const accent = "rgb(" + Math.round(r * boost) + "," + Math.round(g * boost) + "," + Math.round(b * boost) + ")";
        fp.style.setProperty("--fp-accent", accent);
        /** @type {HTMLElement} */ (document.querySelector(".app")).style.setProperty("--fp-accent", accent);
        // Deliberately not writing <meta name="theme-color"> here. It was left out while the
        // app ran under a translucent status bar, which a declared colour turns opaque. The
        // bar is opaque by choice now (see index.html); whether iOS would tint it from this
        // colour has not been tried on a phone.
      } catch (e) {
        fp.style.removeProperty("--fp-accent");
      }
    };
    img.onerror = () => { if (token === accentToken) fp.style.removeProperty("--fp-accent"); };
    img.src = V.coverFor(track);
  }
})();
