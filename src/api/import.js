(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    importPlaylist: { get: () => importPlaylist }
  });

  function parseSpotifyEmbed(html) {
    const m = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error("Couldn't read the Spotify playlist - is it public?");
    const data = JSON.parse(m[1]);
    const tracks = [];
    const seen = new Set();
    let plName = null;
    (function scan(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(scan); return; }
      if (!plName && typeof n.name === "string" && Array.isArray(n.trackList)) plName = n.name;
      if (typeof n.title === "string" && typeof n.subtitle === "string" && /spotify:track:/.test(n.uri || "")) {
        const key = n.title + "|" + n.subtitle;
        if (!seen.has(key)) { seen.add(key); tracks.push({ title: n.title, artist: n.subtitle }); }
        return;
      }
      for (const k in n) if (n[k] && typeof n[k] === "object") scan(n[k]);
    })(data);
    if (!tracks.length) throw new Error("No tracks found - playlist may be private");
    const nameM = /<meta property="og:title" content="([^"]*)"/.exec(html);
    return { name: plName || (nameM ? V.decodeHtml(nameM[1]) : "Spotify import"), tracks };
  }

  // The same shape as the Apple Music reader, for the same reason: a page rendered to
  // text still names every song and who it is by.
  function parseSpotifyMarkdown(txt) {
    const songRe = /\[([^\]]+)\]\(https:\/\/open\.spotify\.com\/track\/[^)]*\)/g;
    const hits = [];
    let m;
    while ((m = songRe.exec(txt))) hits.push({ title: m[1].trim(), at: m.index + m[0].length });
    const tracks = [];
    const seen = new Set();
    for (let i = 0; i < hits.length; i++) {
      const seg = txt.slice(hits[i].at, i + 1 < hits.length ? hits[i + 1].at : hits[i].at + 600);
      const artistRe = /\[([^\]]+)\]\(https:\/\/open\.spotify\.com\/artist\/[^)]*\)/g;
      const artists = [];
      let a;
      while ((a = artistRe.exec(seg))) { if (!artists.includes(a[1].trim())) artists.push(a[1].trim()); }
      const key = hits[i].title + "|" + artists.join(",");
      if (!hits[i].title || seen.has(key)) continue;
      seen.add(key);
      tracks.push({ title: hits[i].title, artist: artists.join(", ") });
    }
    if (!tracks.length) throw new Error("Couldn't read the Spotify playlist - is it public?");
    const nameM = /^Title:\s*(.+)$/m.exec(txt);
    const name = nameM
      ? nameM[1].replace(/\s*[-|]\s*(playlist\s*)?(by\s+.*)?$/i, "").replace(/\s*\|\s*Spotify\s*$/i, "").trim()
      : "Spotify import";
    V.log("import", "read the playlist as text: " + tracks.length + " song(s)");
    return { name: name || "Spotify import", tracks };
  }

  function parseAppleMarkdown(txt) {
    const songRe = /\[([^\]]+)\]\(https:\/\/music\.apple\.com\/[a-z-]+\/song\/[^)]*\)/g;
    const hits = [];
    let m;
    while ((m = songRe.exec(txt))) hits.push({ title: m[1], at: m.index + m[0].length });
    const tracks = [];
    const seen = new Set();
    for (let i = 0; i < hits.length; i++) {
      const seg = txt.slice(hits[i].at, i + 1 < hits.length ? hits[i + 1].at : hits[i].at + 600);
      const artistRe = /\[([^\]]+)\]\(https:\/\/music\.apple\.com\/[a-z-]+\/artist\/[^)]*\)/g;
      const artists = [];
      let a;
      while ((a = artistRe.exec(seg))) { if (!artists.includes(a[1])) artists.push(a[1]); }
      const key = hits[i].title + "|" + artists.join(",");
      if (!seen.has(key)) { seen.add(key); tracks.push({ title: hits[i].title, artist: artists.join(", ") }); }
    }
    if (!tracks.length) throw new Error("Couldn't read the Apple Music playlist - is it public?");
    const nameM = /^Title:\s*(.+)$/m.exec(txt);
    const name = nameM
      ? nameM[1].replace(/\s*-\s*Playlist\s*-\s*Apple Music\s*$/i, "").replace(/\s+on Apple Music\s*$/i, "").replace(/[‎‏]/g, "").trim()
      : "Apple Music import";
    return { name: name || "Apple Music import", tracks };
  }

  // Apple serves a playlist page twice over: the rows a browser shows, and the JSON those
  // rows are built from, kept in a script tag on the same page. A playlist someone made
  // themselves renders with no song names at all - only artwork slots and durations - so
  // reading the page as text found no songs and blamed privacy, and making the playlist
  // public changed nothing. The JSON names every song and its artist for both kinds of
  // playlist, so it is read first and the text of the page is the fallback.
  function parseAppleServerData(html) {
    const m = /<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error("Couldn't read the Apple Music playlist - is it public?");
    const data = JSON.parse(m[1]);
    const tracks = [];
    const seen = new Set();
    (function scan(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(scan); return; }
      if (typeof n.title === "string" && typeof n.artistName === "string") {
        const key = n.title + "|" + n.artistName;
        if (!seen.has(key)) { seen.add(key); tracks.push({ title: n.title, artist: n.artistName }); }
        return;
      }
      for (const k in n) if (n[k] && typeof n[k] === "object") scan(n[k]);
    })(data);
    if (!tracks.length) throw new Error("No tracks found - playlist may be private");
    // The page's own header is the first item of the first section; the document title
    // has the owner's name and "Apple Music" folded into it.
    let name = null;
    try { name = data.data[0].data.sections[0].items[0].title; } catch (e) {}
    if (typeof name !== "string" || !name.trim()) {
      const nameM = /<meta property="og:title" content="([^"]*)"/.exec(html);
      name = nameM ? V.decodeHtml(nameM[1]).replace(/\s+on Apple Music\s*$/i, "") : "";
    }
    name = name.replace(/[\u200e\u200f]/g, "").trim();
    V.log("import", "read the playlist from Apple's page data: " + tracks.length + " song(s)");
    return { name: name || "Apple Music import", tracks };
  }

  // The one source that needs no guessing. Spotify and Apple hand over a title and an
  // artist name and every song then has to be matched back to some upload, which is where
  // an import loses songs and picks up covers. A YouTube or YouTube Music list is already
  // made of the video ids this app plays, so it is read straight through - no matching, no
  // near-misses, and the same list every time.
  function youtubeListId(u) {
    let m;
    if ((m = /[?&]list=([A-Za-z0-9_-]+)/.exec(u))) return m[1];
    if ((m = /(?:music\.)?youtube\.com\/playlist\/([A-Za-z0-9_-]+)/.exec(u))) return m[1];
    // A bare list id pasted on its own, which is what sharing sheets sometimes leave behind.
    if (/^(?:PL|OLAK5uy_|RD|LL|FL|UU|VL)[A-Za-z0-9_-]{5,}$/.test(u)) return u.replace(/^VL/, "");
    return null;
  }

  /**
   * Reads a YouTube, YouTube Music, Spotify or Apple Music playlist link.
   * @param {string} url
   * @returns {Promise<ImportedPlaylist>}
   */
  async function importPlaylist(url) {
    const u = String(url || "").trim();
    let m;
    if (/(?:^|\/\/)(?:music\.|www\.|m\.)?youtu(?:be\.com|\.be)/.test(u) || youtubeListId(u)) {
      const listId = youtubeListId(u);
      if (!listId) throw new Error("That YouTube link has no playlist in it - open the playlist itself and copy that link");
      let info;
      try { info = await V.getPlaylistInfo(listId); }
      catch (e) { throw new Error("Couldn't read that YouTube playlist - is it public?"); }
      V.log("import", "read " + info.tracks.length + " song(s) straight from YouTube list " + listId);
      return {
        name: info.name || "YouTube import",
        // Already the real thing, so the caller skips matching entirely.
        tracks: info.tracks.map(t => ({ title: t.title, artist: t.artist, match: t }))
      };
    }
    if ((m = /open\.spotify\.com\/(?:[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/.exec(u))) {
      const id = m[1];
      try {
        const html = await V.fetchViaProxies("https://open.spotify.com/embed/playlist/" + id, "__NEXT_DATA__");
        return parseSpotifyEmbed(html);
      } catch (e) {
        // One relay reads pages rather than passing them through, so it answers with the
        // text of the playlist and never with the script the parser above wants. It was
        // being thrown away for containing "something else" while it was the only route
        // still answering at all. Read it as what it is.
        const txt = await V.fetchViaProxies("https://r.jina.ai/https://open.spotify.com/playlist/" + id, "open.spotify.com/track/");
        return parseSpotifyMarkdown(txt);
      }
    }
    if (/music\.apple\.com\/.+\/playlist\//.test(u)) {
      // The share sheet appends the language (?l=iw); the page is the same without it.
      const page = u.split("?")[0];
      try {
        const html = await V.fetchViaProxies(page, "serialized-server-data");
        return parseAppleServerData(html);
      } catch (e) {
        // The page itself did not come through or carried no data, so read it as text
        // the way this always did. One route only before this, so a bad moment at that
        // one relay was the whole import failing.
        const txt = await V.fetchViaProxies("https://r.jina.ai/" + page, "music.apple.com");
        return parseAppleMarkdown(txt);
      }
    }
    throw new Error("Paste a YouTube, YouTube Music, Spotify or Apple Music playlist link");
  }
})();
