(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    search: { get: () => search },
    searchMore: { get: () => searchMore }
  });

  /**
   * @param {SearchPage} prev The page before.
   * @param {string} query The same query.
   * @returns {Promise<SearchPage>}
   */
  async function searchMore(prev, query) {
    const q = encodeURIComponent(query);
    if (prev.kind === "piped" && prev.nextpage) {
      const data = await V.fetchJson(prev.base + "/nextpage/search?nextpage=" + encodeURIComponent(prev.nextpage) + "&q=" + q + "&filter=" + prev.filter, 10000);
      const items = (data.items || []).filter(x => x.type === "stream").map(V.normPiped).filter(Boolean);
      return { items, kind: "piped", base: prev.base, filter: prev.filter, nextpage: data.nextpage || null };
    }
    if (prev.kind === "invidious") {
      const page = (prev.page || 1) + 1;
      const data = await V.fetchJson(prev.base + "/api/v1/search?q=" + q + "&type=video&page=" + page, 10000);
      const items = (data || []).map(x => V.normInvidious(x, prev.base)).filter(Boolean);
      const known = new Set((prev.items || []).map(t => t.id));
      const fresh = items.some(t => !known.has(t.id));
      return { items, kind: "invidious", base: prev.base, page, nextpage: fresh ? "invidious-page-" + (page + 1) : null };
    }
    return { items: [], kind: prev.kind, nextpage: null };
  }

  /**
   * @param {string} txt "m:ss" or "h:mm:ss".
   * @returns {number} Seconds, or 0.
   */
  function parseDuration(txt) {
    const parts = String(txt || "").trim().split(":").map(x => parseInt(x, 10));
    if (parts.some(isNaN) || !parts.length) return 0;
    return parts.reduce((a, x) => a * 60 + x, 0);
  }

  function parseYtInitialData(html) {
    const marker = "var ytInitialData = ";
    const i = html.indexOf(marker);
    if (i === -1) throw new Error("no ytInitialData");
    const start = i + marker.length;
    const end = html.indexOf(";</script>", start);
    if (end === -1) throw new Error("no end marker");
    return JSON.parse(html.slice(start, end));
  }

  function extractVideos(node, out) {
    if (!node || typeof node !== "object" || out.length >= 25) return;
    if (node.videoRenderer && node.videoRenderer.videoId) {
      const v = node.videoRenderer;
      const title = ((v.title || {}).runs || []).map(r => r.text).join("");
      const artist = (((v.ownerText || {}).runs || [])[0] || {}).text || "";
      const views = parseInt(String(((v.viewCountText || {}).simpleText || "")).replace(/[^\d]/g, ""), 10);
      out.push({
        id: v.videoId,
        title,
        artist,
        album: "",
        duration: parseDuration((v.lengthText || {}).simpleText),
        thumb: V.thumbFor(v.videoId),
        views: isNaN(views) ? null : views
      });
      return;
    }
    for (const k in node) {
      if (node[k] && typeof node[k] === "object") extractVideos(node[k], out);
    }
  }

  async function searchYtProxy(q) {
    const target = "https://www.youtube.com/results?search_query=" + q;
    // A stalled relay must not keep a working one waiting behind its timeout.
    // Each request retains its own deadline, including reading the response body.
    return V.raceOk(V.CORS_PROXIES.map(async wrap => {
      const url = wrap(target);
      try {
        const html = await V.fetchText(url, 15000);
        const data = parseYtInitialData(html);
        const items = [];
        extractVideos(data, items);
        if (!items.length) throw new Error("no search results");
        V.log("search", "fallback succeeded via " + V.host(url));
        return { items, source: "youtube (proxy)" };
      } catch (e) {
        V.log("search", V.host(url) + " failed: " + String(e.message || e).slice(0, 120));
        throw e;
      }
    }));
  }

  /**
   * Searches for tracks on every configured server at once, merging what arrives in time.
   * @param {string} query
   * @param {boolean} [tracksOnly] Skip the channel search.
   * @returns {Promise<SearchPage>}
   */
  async function search(query, tracksOnly) {
    const q = encodeURIComponent(query);
    const inst = await V.instances();
    const artistsPromise = tracksOnly ? Promise.resolve({ items: [] }) : V.searchArtists(query);

    /** @type {SearchPage | null} */
    let piped = null;
    /** @type {SearchPage | null} */
    let inv = null;
    const pipedP = V.raceOk(V.prioritize(inst.piped, inst.lastGood, "search").map(b => V.searchPipedOne(b, q)))
      .then(r => { piped = r; }).catch(() => {});
    const invP = V.raceOk(V.prioritize(inst.invidious, inst.lastGood, "search").map(b => V.searchInvidiousOne(b, q)))
      .then(r => { inv = r; }).catch(() => {});

    await Promise.race([pipedP, invP]);
    if (!piped && !inv) {
      await Promise.all([pipedP, invP]);
    } else {
      await Promise.race([
        Promise.all([pipedP, invP]),
        new Promise(r => setTimeout(r, 2500))
      ]);
    }

    let result = piped || inv;
    if (!result) {
      const proxied = await searchYtProxy(q);
      result = Object.assign({ kind: "proxy", nextpage: null }, proxied);
    } else if (piped && inv) {
      const seen = new Set(result.items.map(x => x.id));
      const extra = result === piped ? inv.items : piped.items;
      for (const it of extra) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          result.items.push(it);
        }
      }
      result.source = piped.source + " + " + inv.source;
    }
    try { result.artists = (await artistsPromise).items; } catch (e) { result.artists = []; }
    return result;
  }
})();
