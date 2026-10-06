(function () {
  const V = window.Aura.views;
  // The feed rows of Home: keyed by filter and top artists, cached for the day, loaded one row at a time.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    buildHomeFeeds: { get: () => buildHomeFeeds },
    homeDiscoveryHtml: { get: () => homeDiscoveryHtml },
    homeFeedsHtml: { get: () => homeFeedsHtml },
    loadHomeSection: { get: () => loadHomeSection },
    rebuildHomeFeeds: { get: () => rebuildHomeFeeds },
    showEpisodes: { get: () => showEpisodes }
  });

  function homeFeedBase() {
    const artists = Store.topListeningArtists(3).map(artist => artist.name).sort();
    return V.homeFilter + ":" + (artists.join("|") || "new");
  }

  function homeFeedKey() {
    const base = homeFeedBase();
    if (V.homeFilter === "music") return base;
    // Podcast rows are shows, so the key has to move when the shows do - otherwise a
    // refreshed list keeps painting yesterday's cached rows for the rest of the day.
    const shows = V.podcastShowsForRows(V.homeFilter === "podcasts" ? V.PODCAST_ROWS : V.LATEST_SHOWS);
    return base + ":" + shows.map(show => show.name).join("|");
  }

  const LATEST_SPEC = ["Latest episodes", "", "latest"];

  function homeFeedSpecs() {
    const artists = Store.topListeningArtists(2);
    // What is new comes first on both tabs; the per-show rows sit under it for browsing.
    if (V.homeFilter === "podcasts") return [LATEST_SPEC].concat(V.podcastSpecs(V.PODCAST_ROWS));
    const specs = [];
    artists.forEach(artist => specs.push(["More like " + artist.name, artist.name + " similar artists music"]));
    specs.push(["New releases for you", artists.length ? artists.map(artist => artist.name).join(" ") + " new music" : "new music releases"]);
    specs.push(["Popular right now", artists.length ? artists.map(artist => artist.name).join(" ") + " popular songs" : "popular music hits"]);
    if (V.homeFilter === "all") specs.push(LATEST_SPEC);
    return specs;
  }

  function homeFeedCacheLoad(key) {
    try {
      const cache = JSON.parse(localStorage.getItem("aura.homeFeeds") || "{}");
      const saved = cache[key];
      if (saved && V.cacheUsable(saved.at, V.RECS_TTL) && Array.isArray(saved.sections)) return saved.sections;
    } catch (e) {}
    return null;
  }

  // Every change of top artists or shows is a new key, and nothing but a pull to refresh
  // used to clear the old ones: the copy grew for as long as the app was used, towards
  // the storage quota the library and playlists are saved under. Keep the newest few
  // that can still be shown.
  const HOME_FEED_CACHE_KEYS = 6;

  function homeFeedCacheSave(key, sections) {
    try {
      const cache = JSON.parse(localStorage.getItem("aura.homeFeeds") || "{}");
      cache[key] = { at: Date.now(), sections };
      const kept = {};
      Object.keys(cache)
        .filter(k => cache[k] && Date.now() - Number(cache[k].at || 0) < V.STALE_MAX)
        .sort((a, b) => Number(cache[b].at || 0) - Number(cache[a].at || 0))
        .slice(0, HOME_FEED_CACHE_KEYS)
        .forEach(k => { kept[k] = cache[k]; });
      localStorage.setItem("aura.homeFeeds", JSON.stringify(kept));
    } catch (e) {}
  }

  function homeFeedsHtml() {
    V.homeFeedRenderedKey = homeFeedKey();
    const state = V.homeFeeds[V.homeFeedRenderedKey];
    if (!state) return homeFeedSpecs().map(spec => '<section class="home-section home-feed"><div class="section-head"><h3>' + V.esc(spec[0]) + '</h3></div><div class="home-feed-skeleton"><i></i><i></i><i></i></div></section>').join("");
    return state.sections.map((section, sectionIndex) => {
      // A failed row used to render as the empty string, so the home page quietly shrank
      // and, because buildHomeFeeds returns early once the key exists, stayed shrunk for
      // the rest of the session. Say so, and offer a way to rebuild just that row.
      if (section.status === "error" && !section.tracks.length) {
        return '<section class="home-section home-feed"><div class="section-head"><h3 dir="auto">' + V.esc(section.title) + '</h3></div>' +
          '<div class="status-line"><span class="err">Couldn\'t load this right now</span></div>' +
          '<div class="row-actions"><button class="btn ghost" data-feed-retry="' + sectionIndex + '">Try again</button></div></section>';
      }
      // A row that loaded with nothing to show (a show no channel dominates, a query whose
      // hits were all mixes, every song blocked) is dropped whole, not left as a bare heading.
      if (section.status === "ready" && !V.unblocked(section.tracks).length) return "";
      return '<section class="home-section home-feed"><div class="section-head"><h3 dir="auto">' + V.esc(section.title) + '</h3></div>' +
        (section.status === "loading" ? '<div class="home-feed-skeleton"><i></i><i></i><i></i></div>' :
          '<div class="rail">' + V.unblocked(section.tracks).map((track, trackIndex) => V.gridCard(track.thumb, track.title, track.artist || "", 'data-home-feed-section="' + sectionIndex + '" data-home-feed-track="' + trackIndex + '"', true)).join("") + '</div>') + '</section>';
    }).join("");
  }

  function homeDiscoveryHtml() {
    const items = [V.BROWSE[1], V.BROWSE[2], V.BROWSE[4], V.BROWSE[5], V.BROWSE[8], V.BROWSE[10]];
    return '<section class="home-section home-discovery"><div class="section-head"><h3>Made for you</h3></div><div class="home-discovery-rail">' + items.map(item =>
      '<button data-browse="' + V.esc(item[1]) + '" data-browse-title="' + V.esc(item[0]) + '" data-browse-color="' + item[2] + '" style="--discovery-color:' + item[2] + '"><i>' + V.esc(item[3]) + '</i><strong>' + V.esc(item[0]) + '</strong><span>' + V.esc(item[1]) + '</span></button>'
    ).join("") + '</div></section>';
  }

  // Loading a show's row is also what teaches the store that show's channel, which moves
  // it up the list of shows and the key along with it. The rows just loaded are still the
  // rows for this filter and these artists; painted under the new key they were skeletons
  // that nothing was ever going to fill.
  function followHomeFeedKey(state, key) {
    const current = homeFeedKey();
    if (current !== key && !V.homeFeeds[current] && key.indexOf(homeFeedBase() + ":") === 0) V.homeFeeds[current] = state;
  }

  function fillHomeFeeds() {
    if (V.currentTab !== "home" || V.subView) return;
    const holder = document.getElementById("home-feeds");
    if (!holder) return;
    // The key moved while rows were loading (a scrobble reordered the top artists) and
    // nothing holds rows for the new one: painting now would be skeletons that no load
    // fills. Start that load instead; it reads the day's cache first, so it usually paints.
    if (!V.homeFeeds[homeFeedKey()]) { buildHomeFeeds(); return; }
    V.paint(holder, homeFeedsHtml());
  }

  // A show row holds one show. Searching a show's name puts its own channel at the top of
  // the results with a few strays mixed in - a clip, a reaction, someone else's episode
  // about it - so the row keeps whichever channel dominates and drops the rest. A name no
  // channel dominates is not a show, whoever suggested it, and its row is dropped whole.
  function showEpisodes(section, items) {
    const sample = items.slice(0, 12);
    const counts = new Map();
    sample.forEach(track => {
      const name = (track.artist || "").trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    });
    let channel = "";
    let top = 0;
    counts.forEach((count, name) => { if (count > top) { top = count; channel = name; } });
    if (!channel || top < 3 || top * 2 < sample.length) return [];
    const owned = items.filter(track => (track.artist || "").trim() === channel);
    const named = owned.filter(track => Store.matchesQuery(section.title, track.title));
    const spoken = owned.filter(Api.looksLikePodcast);
    // One channel dominating a search only proves who ranks for the words, not that the
    // uploads are a podcast. Require the episode titles or the media itself to say so.
    // This keeps a musician, TV channel or comedian with the same name out of podcast
    // history, while network channels are narrowed to the named show they publish.
    if (named.length < 3 && spoken.length < 3) return [];
    const episodes = named.length >= 3 ? named : spoken;
    // The id rides along on the search results, and it is what lets the Latest row ask the
    // channel for its uploads later instead of searching and hoping for the right order.
    const withId = owned.find(track => track.artistId);
    Store.notePodcastChannel(section.title, channel, withId ? withId.artistId : "", true);
    // Deliberately no looksLikePodcast() pass here. That test reads a title for words like
    // "פרק" or "podcast" and, failing those, calls anything under half an hour music - it
    // threw away every episode of a show whose titles are just their subject, which is most
    // of them. The row was built from a show name and its channel has now confirmed it;
    // there is nothing left for a guess from the title to add.
    // Newest first here too. A show row is for browsing a podcast, and the episode someone
    // is looking for is far more often this month's than the one that happens to be the
    // most linked-to of the last five years.
    return V.byNewest(episodes.filter(track => (track.duration || 0) > 60)).slice(0, 12)
      .map(track => Object.assign({}, track, { kind: "podcast", podcast: section.title }));
  }

  function searchedRow(section) {
    const filter = V.homeFilter;
    return V.categorySearch(section.query).then(result => {
      const items = (result.items || []).filter(track => !Store.isBlocked(track));
      // The tabs should decide what shows up, not just how the search was worded.
      return section.mode === "show" ? showEpisodes(section, items) : items
        .filter(track => track.duration > 60)
        .filter(track => filter === "all" ||
          (filter === "podcasts" ? Api.looksLikePodcast(track) : Api.looksLikeMusic(track)))
        .slice(0, 12);
    });
  }

  // One row's worth of loading, so a retry can rebuild just that row.
  function loadHomeSection(state, section, key) {
    section.status = "loading";
    fillHomeFeeds();
    return (section.mode === "latest" ? V.latestEpisodes() : searchedRow(section)).then(tracks => {
      section.tracks = tracks;
      section.status = "ready";
    }).catch(error => {
      section.status = "error";
      if (window.Log) Log.add("home", section.title + " failed: " + String((error && error.message) || error).slice(0, 160));
    }).then(() => {
      if (state.sections.every(item => item.status !== "loading")) {
        const ready = state.sections.filter(item => item.tracks.length);
        if (ready.length) homeFeedCacheSave(key, ready);
      }
      if (V.homeFeeds[key] === state) followHomeFeedKey(state, key);
      fillHomeFeeds();
    });
  }

  function buildHomeFeeds() {
    const key = homeFeedKey();
    if (V.homeFeeds[key]) return;
    const cached = homeFeedCacheLoad(key) || [];
    // Only successful rows are cached. Recreate every expected row so a previous
    // network failure does not remove recommendations for the lifetime of that cache.
    const state = { sections: homeFeedSpecs().map(spec => {
      const section = { title: spec[0], query: spec[1], mode: spec[2] || "", show: spec[3] || null, tracks: [], status: "loading" };
      const saved = cached.find(item => item.title === section.title && item.query === section.query &&
        (item.mode || "") === section.mode && Array.isArray(item.tracks) && item.tracks.length);
      if (saved) {
        section.tracks = saved.tracks;
        section.status = "ready";
      }
      return section;
    }) };
    V.homeFeeds[key] = state;
    fillHomeFeeds();
    state.sections.filter(section => section.status === "loading").forEach(section => loadHomeSection(state, section, key));
  }

  // The nightly rebuild of the feed rows. The fresh state is kept off to the side until
  // every row has settled, so Home keeps painting yesterday's rows - not a page of
  // skeletons - for as long as the rebuild takes.
  async function rebuildHomeFeeds() {
    const key = homeFeedKey();
    const state = { sections: homeFeedSpecs().map(spec => ({ title: spec[0], query: spec[1], mode: spec[2] || "", show: spec[3] || null, tracks: [], status: "loading" })) };
    await Promise.all(state.sections.map(section => loadHomeSection(state, section, key)));
    if (!state.sections.some(section => section.tracks.length)) throw new Error("no rows came back");
    V.homeFeeds[key] = state;
    // Rows held under a key that moved while these loaded are the old ones; make way for
    // these. With the key unchanged that deleted the rows just built, and Home painted
    // skeletons that nothing was going to fill.
    if (homeFeedKey() !== key) delete V.homeFeeds[homeFeedKey()];
    followHomeFeedKey(state, key);
    fillHomeFeeds();
  }
})();
