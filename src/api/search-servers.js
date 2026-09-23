(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    searchArtists: { get: () => searchArtists },
    searchInvidiousOne: { get: () => searchInvidiousOne },
    searchPipedOne: { get: () => searchPipedOne },
    searchPlaylists: { get: () => searchPlaylists }
  });

  async function searchPipedOne(base, q) {
    try {
      let filter = "music_songs";
      let data = await V.fetchJson(base + "/search?q=" + q + "&filter=" + filter);
      let items = (data.items || []).filter(x => x.type === "stream").map(V.normPiped).filter(Boolean);
      if (!items.length) {
        filter = "videos";
        data = await V.fetchJson(base + "/search?q=" + q + "&filter=" + filter);
        items = (data.items || []).filter(x => x.type === "stream").map(V.normPiped).filter(Boolean);
      }
      if (!items.length) throw new Error("no results");
      V.markGood(base);
      return { items, source: base.replace(/^https?:\/\//, ""), kind: "piped", base, filter, nextpage: data.nextpage || null };
    } catch (e) {
      V.markBad(base, "search");
      V.log("search", V.host(base) + " failed: " + String(e.message || e).slice(0, 120));
      throw e;
    }
  }

  async function searchInvidiousOne(base, q) {
    try {
      const data = await V.fetchJson(base + "/api/v1/search?q=" + q + "&type=video");
      const items = (data || []).map(x => V.normInvidious(x, base)).filter(Boolean);
      if (!items.length) throw new Error("no results");
      V.markGood(base);
      return { items, source: base.replace(/^https?:\/\//, ""), kind: "invidious", base, page: 1, nextpage: "invidious-page-2" };
    } catch (e) {
      V.markBad(base, "search");
      V.log("search", V.host(base) + " failed: " + String(e.message || e).slice(0, 120));
      throw e;
    }
  }

  /**
   * @param {string} query
   * @returns {Promise<{ items: ArtistSummary[], base: string | null }>} Empty when nothing answered.
   */
  async function searchArtists(query) {
    const q = encodeURIComponent(query);
    const inst = await V.instances();
    try {
      const pipedTasks = V.prioritize(inst.piped, inst.lastGood, "search").map(async base => {
        const data = await V.fetchJson(base + "/search?q=" + q + "&filter=channels", 8000);
        const items = (data.items || [])
          .filter(x => x.type === "channel" && x.url)
          .map(c => ({ id: c.url.split("/").pop(), name: c.name || "", thumb: c.thumbnail || "", subscribers: c.subscribers || 0, verified: c.verified === true }))
          .filter(c => c.id);
        if (!items.length) throw new Error("no channels");
        V.markGood(base);
        return { items, base };
      });
      const invidiousTasks = V.prioritize(inst.invidious, inst.lastGood, "search").map(async base => {
        const data = await V.fetchJson(base + "/api/v1/search?q=" + q + "&type=channel", 8000);
        const items = (data || [])
          .filter(x => x.type === "channel" && x.authorId)
          .map(c => ({
            id: c.authorId,
            name: c.author || "",
            verified: c.authorVerified === true,
            thumb: V.largestImage(c.authorThumbnails, base),
            subscribers: c.subCount || 0
          }));
        if (!items.length) throw new Error("no channels");
        V.markGood(base);
        return { items, base };
      });
      return await V.raceOk(pipedTasks.concat(invidiousTasks));
    } catch (e) {
      return { items: [], base: null };
    }
  }

  /**
   * @param {string} query
   * @returns {Promise<{ items: PlaylistSummary[] }>}
   */
  async function searchPlaylists(query) {
    const q = encodeURIComponent(query);
    const inst = await V.instances();
    const tasks = V.prioritize(inst.piped, inst.lastGood, "search").map(async base => {
      const data = await V.fetchJson(base + "/search?q=" + q + "&filter=playlists", 10000);
      const items = (data.items || []).filter(p => p.type === "playlist" && p.url).map(p => ({
        id: (p.url.split("list=")[1] || "").split("&")[0], name: p.name || "", thumb: p.thumbnail || ""
      })).filter(p => p.id);
      if (!items.length) throw new Error("No playlists found");
      V.markGood(base);
      return { items };
    });
    V.prioritize(inst.invidious, inst.lastGood, "search").forEach(base => tasks.push((async () => {
      const data = await V.fetchJson(base + "/api/v1/search?q=" + q + "&type=playlist", 10000);
      const items = (data || []).filter(p => p.type === "playlist").map(p => V.normInvidiousPlaylist(p, base)).filter(Boolean);
      if (!items.length) throw new Error("No playlists found");
      V.markGood(base);
      return { items };
    })()));
    return V.raceOk(tasks);
  }
})();
