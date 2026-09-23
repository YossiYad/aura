(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    artistMore: { get: () => artistMore },
    getAlbumTracks: { get: () => getAlbumTracks },
    getArtist: { get: () => getArtist },
    getPlaylistInfo: { get: () => getPlaylistInfo }
  });

  async function loadChannelTab(base, tab) {
    try {
      const data = await V.fetchJson(base + "/channels/tabs?data=" + encodeURIComponent(tab.data), 10000);
      return (data.content || [])
        .filter(x => x.type === "playlist" && x.url)
        .map(p => ({
          id: (p.url.split("list=")[1] || "").split("&")[0],
          name: p.name || "",
          thumb: p.thumbnail || "",
          count: p.videos || 0
        }))
        .filter(p => p.id);
    } catch (e) {
      return [];
    }
  }

  async function getArtistFromSearch(base, channelId, fallback) {
    const name = String((fallback || {}).name || "").trim();
    const queries = V.dedup([name, name.replace(/\s+-\s+Topic$/i, "").trim()]).filter(Boolean);
    for (const query of queries) {
      const data = await V.fetchJson(base + "/api/v1/search?q=" + encodeURIComponent(query) + "&type=video", 10000);
      const videos = (data || []).map(x => V.normInvidious(x, base)).filter(x => x && x.artistId === channelId);
      if (!videos.length) continue;
      V.markGood(base);
      V.log("artist", "loaded " + videos.length + " songs via search fallback on " + V.host(base));
      return {
        id: channelId,
        name: videos[0].artist || name,
        thumb: videos[0].artistThumb || (fallback || {}).thumb || "",
        banner: "",
        subscribers: 0,
        videos,
        songPage: { kind: "invidious", base, channelId, nextpage: "__first" },
        albums: [],
        playlists: []
      };
    }
    throw new Error("artist search fallback empty");
  }

  /**
   * @param {string} channelId
   * @param {{ name?: string, thumb?: string }} [fallback] Used when the channel API fails.
   * @returns {Promise<ArtistPage>}
   */
  async function getArtist(channelId, fallback) {
    const inst = await V.instances();
    const pipedTasks = V.prioritize(inst.piped, inst.lastGood, "search").map(async base => {
      const data = await V.fetchJson(base + "/channel/" + channelId, 10000);
      if (!data || !data.name) throw new Error("empty channel");
      V.markGood(base);
      const tabs = data.tabs || [];
      const albumsTab = tabs.find(t => t.name === "albums");
      const playlistsTab = tabs.find(t => t.name === "playlists");
      const [albums, playlists] = await Promise.all([
        albumsTab ? loadChannelTab(base, albumsTab) : [],
        playlistsTab ? loadChannelTab(base, playlistsTab) : []
      ]);
      return {
        id: channelId,
        name: data.name || "",
        thumb: data.avatarUrl || "",
        banner: data.bannerUrl || "",
        subscribers: data.subscriberCount || 0,
        videos: (data.relatedStreams || []).map(V.normPiped).filter(Boolean),
        songPage: { kind: "piped", base, channelId, nextpage: data.nextpage || null },
        albums,
        playlists
      };
    });
    const invidiousTasks = V.prioritize(inst.invidious, inst.lastGood, "search").map(async base => {
      let data;
      try {
        data = await V.fetchJson(base + "/api/v1/channels/" + channelId, 10000);
      } catch (e) {
        V.log("artist", "channel API failed on " + V.host(base) + ", trying search fallback");
        return getArtistFromSearch(base, channelId, fallback);
      }
      if (!data || !data.author) return getArtistFromSearch(base, channelId, fallback);
      const [releasesData, playlistsData, videosData] = await Promise.all([
        V.fetchJson(base + "/api/v1/channels/" + channelId + "/releases", 10000).catch(() => ({ playlists: [] })),
        V.fetchJson(base + "/api/v1/channels/" + channelId + "/playlists", 10000).catch(() => ({ playlists: [] })),
        V.fetchJson(base + "/api/v1/channels/" + channelId + "/videos", 10000).catch(() => null)
      ]);
      const albums = (releasesData.playlists || []).map(x => V.normInvidiousPlaylist(x, base)).filter(Boolean);
      const albumIds = new Set(albums.map(x => x.id));
      const playlists = (playlistsData.playlists || []).map(x => V.normInvidiousPlaylist(x, base)).filter(x => x && !albumIds.has(x.id));
      V.markGood(base);
      return {
        id: channelId,
        name: data.author || "",
        thumb: V.largestImage(data.authorThumbnails, base),
        banner: V.largestImage(data.authorBanners, base),
        subscribers: data.subCount || 0,
        videos: ((videosData && videosData.videos) || data.latestVideos || []).map(x => V.normInvidious(x, base)).filter(Boolean),
        songPage: { kind: "invidious", base, channelId, nextpage: videosData ? videosData.continuation || null : "__first" },
        albums,
        playlists
      };
    });
    return await V.raceOk(pipedTasks.concat(invidiousTasks));
  }

  /**
   * @param {ArtistPageCursor} prev
   * @returns {Promise<{ items: Track[], nextpage: string | null }>}
   */
  async function artistMore(prev) {
    let data;
    if (prev.kind === "piped") {
      data = await V.fetchJson(prev.base + "/nextpage/channel/" + encodeURIComponent(prev.channelId) +
        "?nextpage=" + encodeURIComponent(prev.nextpage), 10000);
      return { items: (data.relatedStreams || []).map(V.normPiped).filter(Boolean), nextpage: data.nextpage || null };
    }
    const token = prev.nextpage === "__first" ? "" : "?continuation=" + encodeURIComponent(prev.nextpage);
    data = await V.fetchJson(prev.base + "/api/v1/channels/" + encodeURIComponent(prev.channelId) + "/videos" + token, 10000);
    return { items: (data.videos || []).map(x => V.normInvidious(x, prev.base)).filter(Boolean), nextpage: data.continuation || null };
  }

  /**
   * Reads a whole playlist from one server, following every page.
   * @param {string} base
   * @param {SourceKind} kind
   * @param {string} listId
   * @returns {Promise<{ name: string, tracks: Track[] }>}
   */
  async function playlistFromSource(base, kind, listId) {
    const id = encodeURIComponent(listId);
    const url = kind === "piped" ? base + "/playlists/" + id : base + "/api/v1/playlists/" + id;
    let data = await V.fetchJson(url, 12000);
    const name = data.name || data.title || "";
    const tracks = [], seen = new Set(), cursors = new Set();
    let page = 1, received = 0;
    for (;;) {
      const raw = kind === "piped" ? data.relatedStreams || [] : data.videos || [];
      const batch = raw.map(x => kind === "piped" ? V.normPiped(x) : V.normInvidious(x, base)).filter(Boolean);
      received += raw.length;
      const before = tracks.length;
      batch.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); tracks.push(t); } });
      // A mix or a list served without a count answers every page with the same
      // videos; a page that adds nothing is the end, not a reason to ask for page 100.
      const grew = tracks.length > before;
      const next = kind === "piped" ? data.nextpage :
        (raw.length && grew && (data.videoCount == null || received < data.videoCount) ? page + 1 : null);
      if (!next) break;
      if (cursors.has(String(next)) || page >= 100) throw new Error("Playlist pagination did not finish; nothing was imported");
      cursors.add(String(next));
      page++;
      data = await V.fetchJson(kind === "piped" ? base + "/nextpage/playlists/" + id + "?nextpage=" + encodeURIComponent(next) : url + "?page=" + page, 12000);
    }
    if (!tracks.length) throw new Error("empty playlist");
    return { name, tracks };
  }

  /**
   * @param {string} listId YouTube list id.
   * @returns {Promise<{ name: string, tracks: Track[] }>}
   */
  async function getPlaylistInfo(listId) {
    const inst = await V.instances();
    // Race complete lists, so a failure on a later page never wins with a partial list.
    const tasks = V.prioritize(inst.piped, inst.lastGood, "search").slice(0, 3)
      .map(base => playlistFromSource(base, "piped", listId));
    V.prioritize(inst.invidious, inst.lastGood, "search")
      .forEach(base => tasks.push(playlistFromSource(base, "invidious", listId)));
    return V.raceOk(tasks);
  }

  /**
   * @param {string} listId YouTube list id.
   * @returns {Promise<Track[]>}
   */
  async function getAlbumTracks(listId) { return (await getPlaylistInfo(listId)).tracks; }
})();
