(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    aiHomeSection: { get: () => aiHomeSection },
    aiHomeSectionHtml: { get: () => aiHomeSectionHtml },
    buildAiHomeSection: { get: () => buildAiHomeSection },
    buildHomeFeeds: { get: () => buildHomeFeeds },
    buildHomeRecs: { get: () => buildHomeRecs },
    byNewest: { get: () => byNewest },
    homeDiscoveryHtml: { get: () => homeDiscoveryHtml },
    homeFeedRenderedKey: { get: () => homeFeedRenderedKey },
    homeFeeds: { get: () => homeFeeds },
    homeFeedsHtml: { get: () => homeFeedsHtml },
    homeRecs: { get: () => homeRecs },
    homeRecsHtml: { get: () => homeRecsHtml },
    loadHomeSection: { get: () => loadHomeSection },
    refreshPodcastShows: { get: () => refreshPodcastShows },
    serverMixState: { get: () => serverMixState }
  });

  // ---------------- Home ----------------

  let homeRecs = { items: [], busy: false };
  let homeFeeds = {};
  let homeFeedRenderedKey = null;
  const RECS_TTL = 6 * 60 * 60 * 1000;
  // With the nightly prep on, a cache past its age is still the right thing to put on
  // screen: the run that replaces it is either under way or will be on the next launch,
  // and a row built a few hours late beats a spinner. The ceiling is what keeps that
  // honest - an app left unopened for a week does not come back to last week's Home.
  const STALE_MAX = 3 * 24 * 60 * 60 * 1000;
  function nightlyPrep() { return !!(window.Nightly && Nightly.enabled()); }
  function cacheUsable(at, ttl) {
    const age = Date.now() - Number(at || 0);
    if (age < 0) return false;
    return age < ttl || (nightlyPrep() && age < STALE_MAX);
  }

  // A row Home builds itself, once a day - not a template with a query filled in, an
  // actual AI request shaped only by this listener's own history. Nothing here
  // assumes a language, a genre or a country; it goes wherever the history points.
  const AI_HOME_TTL = 24 * 60 * 60 * 1000;
  let aiHomeSection = { status: "idle", tracks: [], name: "Picked for you today" };
  const AI_HOME_RETRY_MS = 10 * 60 * 1000;

  // Two questions, not one. Whether the row is wanted is the listener's setting; whether
  // this device can build a mix itself needs a key on it. A self-hosted server that
  // builds the mix overnight answers the second question for a device that has no key.
  function aiHomeWanted() { return Store.settings().aiHomeSection === true; }
  function aiHomeEnabled() {
    return !!(window.Ai && Ai.hasAnyKey()) && aiHomeWanted();
  }

  function aiHomeSignature() {
    return Store.topListeningArtists(8).map(a => a.name).sort().join("|");
  }

  function aiHomeCacheLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem("aura.aiHome") || "null");
      if (raw && raw.sig === aiHomeSignature() && cacheUsable(raw.at, AI_HOME_TTL) &&
        Array.isArray(raw.tracks) && raw.tracks.length) return raw;
    } catch (e) {}
    return null;
  }

  function aiHomeCacheSave(tracks) {
    try { localStorage.setItem("aura.aiHome", JSON.stringify({ at: Date.now(), sig: aiHomeSignature(), tracks })); } catch (e) {}
  }

  function aiHomeSectionHtml() {
    if (!aiHomeWanted()) return "";
    if (aiHomeSection.status === "loading") {
      return '<section class="home-section home-feed"><div class="section-head"><h3>' + V.esc(aiHomeSection.name) +
        ' <thinking-orb state="composing" size="20" aria-label="Putting today\'s picks together"></thinking-orb>' +
        '</h3></div><div class="home-feed-skeleton"><i></i><i></i><i></i></div></section>';
    }
    if (!aiHomeSection.tracks.length) return "";
    return '<section class="home-section home-feed"><div class="section-head"><h3>' + V.esc(aiHomeSection.name) + '</h3></div><div class="rail">' +
      aiHomeSection.tracks.map((t, i) => V.gridCard(t.thumb, t.title, t.artist || "", 'data-ai-home="' + i + '"', true)).join("") + '</div></section>';
  }

  function fillAiHomeSection() {
    if (V.currentTab !== "home" || V.subView) return;
    const holder = document.getElementById("home-ai");
    if (holder) V.paint(holder, aiHomeSectionHtml());
  }

  // Deliberately not hooked into forceRefresh() (pull-to-refresh) - that would turn a
  // manual pull into a way around the daily cache, which is the whole point of it.
  async function buildAiHomeSection() {
    // Home re-renders several times on a single load; once this session already has an
    // answer - from cache or freshly built - there is nothing more to do until the next
    // reload picks a new one up.
    if (!aiHomeWanted() || aiHomeSection.status === "loading" || aiHomeSection.status === "ready") return;
    // A build that failed (quota, no matches, servers down) is not retried on the next
    // render; Home renders on every listen, and each retry is a provider call plus a
    // dozen searches.
    if (aiHomeSection.failedAt && Date.now() - aiHomeSection.failedAt < AI_HOME_RETRY_MS) return;
    const cached = aiHomeCacheLoad();
    if (cached) {
      if (window.Log) Log.add("ai", "home section from cache (" + cached.tracks.length + " songs)");
      aiHomeSection = { status: "ready", tracks: cached.tracks, name: aiHomeSection.name };
      fillAiHomeSection();
      return;
    }
    const history = V.askHistoryContext();
    if (!history) return; // nothing listened to yet to build a taste profile from
    aiHomeSection = { status: "loading", tracks: [], name: aiHomeSection.name };
    fillAiHomeSection();
    try {
      const picked = await mixTracks(history);
      aiHomeSection = { status: "ready", tracks: picked, name: aiHomeSection.name };
      aiHomeCacheSave(picked);
    } catch (e) {
      if (window.Log) Log.add("ai", "home section failed: " + String((e && e.message) || e).slice(0, 80));
      aiHomeSection = { status: "idle", tracks: [], name: aiHomeSection.name, failedAt: Date.now() };
    }
    fillAiHomeSection();
  }

  // On the self-hosted setup a small service builds this mix overnight for whoever is
  // signed in, with that listener's own key. When it has one ready it is both better and
  // cheaper than building the same thing here: no AI round trip, no thirty searches, and a
  // phone that was asleep at 4am still opens onto a fresh mix. Anywhere else this 404s in
  // a millisecond and the device builds its own, exactly as before.
  //
  // null means there is no such server. Anything else is its answer, which carries both
  // the mix and what it holds for this listener, so Settings and Home share one request.
  async function serverMixState() {
    // Bounded: a connection that hangs rather than fails held the Home row on its
    // skeleton, and the overnight run with it, for as long as the browser cared to wait.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch("/api/mix/", { headers: { Accept: "application/json" }, cache: "no-store", signal: ctl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" && data.hour != null ? data : null;
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
  }

  async function serverMixFetch() {
    try {
      const data = await serverMixState();
      if (!data || !data.available || !Array.isArray(data.tracks)) return null;
      // Blocking is a device-side decision that may be newer than the copy the server
      // built from, so the list is filtered again here.
      const tracks = data.tracks.filter(t => t && t.id && !Store.isBlocked(t));
      if (!tracks.length) return null;
      const age = Date.now() - Number(data.at || 0);
      return { tracks, fresh: age >= 0 && age < AI_HOME_TTL };
    } catch (e) { return null; }
  }

  // The server's mix when it has a current one - that is the whole point of it building
  // overnight. An old one means the server has been down or has no key; a device that can
  // build its own should do that rather than keep serving last week's, and one that
  // cannot is still better off with the old mix than with an empty row.
  async function mixTracks(history) {
    const fromServer = await serverMixFetch();
    const useServer = fromServer && (fromServer.fresh || !aiHomeEnabled());
    if (useServer) {
      if (window.Log) Log.add("ai", "home section from the server's nightly mix (" + fromServer.tracks.length + " songs)");
      return fromServer.tracks;
    }
    if (!aiHomeEnabled()) throw new Error("no AI key on this device and no mix on the server");
    try {
      return await fetchAiHomeTracks(history);
    } catch (e) {
      if (fromServer) {
        if (window.Log) Log.add("ai", "kept the server's older mix - building one here failed");
        return fromServer.tracks;
      }
      throw e;
    }
  }

  // One mix, start to finish: ask, resolve every suggestion to a real track, and keep the
  // ones that both matched and belong in this listener's world. Split out from the render
  // path because the nightly run needs the same work without the skeleton around it.
  async function fetchAiHomeTracks(history) {
    const prompt = "Suggest a well-rounded mix of real songs this listener would enjoy right now. " +
      "Base it only on their own listening history below - do not default to any particular genre, " +
      "language or country unless their history itself points that way.";
    const parsed = await Ai.generatePlaylist(prompt, 15, history, V.blockedAvoidLabels());
    const list = parsed.tracks.map((item, index) => ({ item, index }));
    const matches = new Array(list.length);
    const workers = Array.from({ length: 3 }, async () => {
      while (list.length) {
        const entry = list.shift();
        try {
          const t = await Api.matchTrack(entry.item.title, entry.item.artist);
          // A suggested "song" occasionally matches something that is not a song at
          // all - a shofar recording, a sketch, whatever the closest title match on
          // YouTube happens to be. The model's word for it is not proof either way.
          if (t && Api.looksLikeMusic(t) && !Store.isBlocked(t)) matches[entry.index] = t;
        } catch (e) {}
      }
    });
    await Promise.all(workers);
    const found = matches.filter(Boolean);
    if (!found.length) throw new Error("no matches");
    const anchor = await V.getTasteAnchor();
    const inWorld = anchor ? found.filter(t => V.inTasteWorld(anchor, t)) : found;
    const picked = inWorld.length >= 6 ? inWorld : found;
    if (window.Log) Log.add("ai", "home section ready: " + picked.length + " of " + parsed.tracks.length +
      " suggestion(s) matched" + (picked.length < found.length ? ", " + (found.length - picked.length) + " outside this listener's world" : ""));
    return picked;
  }

  // The nightly rebuild. No skeleton and no cache read: the point is to replace the cache
  // while nobody is waiting on it, so whatever is on screen stays there until the new mix
  // is ready to take its place. Failures travel up - the run records them.
  async function rebuildAiHomeSection() {
    if (!aiHomeWanted()) return;
    const history = V.askHistoryContext();
    if (!history) return;
    const picked = await mixTracks(history);
    aiHomeSection = { status: "ready", tracks: picked, name: aiHomeSection.name };
    aiHomeCacheSave(picked);
    fillAiHomeSection();
  }

  function recsCacheLoad(seed) {
    try {
      const r = JSON.parse(localStorage.getItem("aura.homeRecs"));
      if (r && r.seed === seed && cacheUsable(r.at, RECS_TTL) && Array.isArray(r.items) && r.items.length) return r.items;
    } catch (e) {}
    return null;
  }

  function homeRecsHtml() {
    if (homeRecs.busy && !homeRecs.items.length) {
      return '<div class="section-head"><h3>Made for you</h3></div><div class="status-line"><span class="ring"></span> Building your mix…</div>';
    }
    if (!homeRecs.items.length) return "";
    return '<div class="section-head"><h3>Made for you</h3></div><div class="rail">' +
      homeRecs.items.map((t, i) => V.gridCard(t.thumb, t.title, t.artist || "", 'data-rec="' + i + '"', true)).join("") +
      '</div>';
  }

  function fillHomeRecs() {
    if (V.currentTab !== "home" || V.subView) return;
    const holder = document.getElementById("home-recs");
    if (holder) V.paint(holder, homeRecsHtml());
  }

  // Podcast rows used to be a search for "popular Hebrew podcasts". That phrase is a
  // description of a category, and a search engine answers it with videos *about* the
  // category - channels teaching Hebrew to English speakers, in that exact case, and not
  // one Israeli podcast. A show's name, searched, returns that show's episodes. So a row
  // is one show, titled with its name, and the only question left is where names come
  // from: the AI when there is a key, this list when there is not. Every name here was
  // checked against a live search, and any name whose results are not dominated by a
  // single channel is dropped when the row loads, wherever it came from.
  const PODCAST_SEEDS = {
    he: ["עושים היסטוריה", "חיות כיס", "עושים תוכנה", "בגג של יצחקי", "בן בן ברוך",
      "זמן אמת", "מדע גדול, בקטנה", "פוליטיקלי קוראת"],
    en: ["This American Life", "Radiolab", "Hardcore History", "99% Invisible",
      "Freakonomics Radio", "Planet Money", "Stuff You Should Know", "Darknet Diaries"]
  };
  const PODCAST_SHOWS_TTL = 7 * 24 * 60 * 60 * 1000;
  const PODCAST_ROWS = 5;

  function listenerLanguage() {
    const tag = String((navigator.languages && navigator.languages[0]) || navigator.language || "");
    return tag.toLowerCase().split("-")[0] || "en";
  }

  function languageName(code) {
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; }
    catch (e) { return code; }
  }

  // Followed podcasts first - they are the one part of this the listener chose outright -
  // then whatever the AI last suggested, then the built-in names so the tab is never empty.
  function podcastShowPool() {
    const out = [];
    const seen = new Set();
    const add = show => {
      const key = Store.foldText(show.name).trim();
      if (!show.name || seen.has(key)) return;
      seen.add(key);
      out.push(show);
    };
    Store.followsList().filter(f => f.kind === "podcast")
      .forEach(f => add({ name: f.name, channel: f.name, channelId: f.id || "", followed: true }));
    if (Store.topListeningPodcasts) Store.topListeningPodcasts(12)
      .forEach(show => add({ name: show.name, channel: show.channel || "", channelId: show.channelId || "", listened: true }));
    Store.podcastShowsList().forEach(show => add({ name: show.name, channel: show.channel || "", channelId: show.channelId || "" }));
    (PODCAST_SEEDS[listenerLanguage()] || PODCAST_SEEDS.en).forEach(name => add({ name, channel: "" }));
    return out;
  }

  function podcastShowsForRows(count) {
    const pool = podcastShowPool();
    if (!pool.length) return [];
    const pinned = pool.filter(show => show.followed || show.listened);
    const rest = pool.filter(show => !show.followed && !show.listened);
    // Rotated by the day, so the tab is not the same five shows forever, and fixed within
    // a day, so it never reshuffles under someone still reading it.
    const start = rest.length ? Math.floor(Date.now() / 86400000) % rest.length : 0;
    const rotated = rest.map((show, i) => rest[(start + i) % rest.length]);
    return pinned.concat(rotated).slice(0, count);
  }

  function podcastSpecs(count) {
    return podcastShowsForRows(count).map(show => [show.name, show.name, "show", show]);
  }

  const LATEST_SHOWS = 4;
  const LATEST_PER_SHOW = 3;

  // The newest episodes across several shows at once. A show row answers "what is this
  // show", which is the wrong question for someone who already knows: they want to know
  // what has come out. Asking a channel for its uploads is the only way to actually get
  // that - a search ranks by relevance, and the episode from three years ago that everyone
  // links to outranks the one from Tuesday.
  // Newest first, and anything with no date on it last rather than dropped - a source that
  // did not report one is not evidence the episode is old.
  function byNewest(tracks) {
    return tracks.slice().sort((a, b) => (b.published || 0) - (a.published || 0));
  }

  // A channel is not a show. כאן publishes חיות כיס alongside half a dozen other
  // programmes, and a comedian's channel carries his music videos next to his episodes, so
  // a channel's newest uploads answer "what did they post" - which is not the question.
  // An episode nearly always carries its show's name in its title, which is what separates
  // them, and a feed with no such title means only that the show has not published inside
  // the last fifteen uploads. Answering nothing for it is right: the row fills from the
  // other shows, and the caller can still go looking. Handing back a different programme
  // under this show's name would be worse than saying nothing.
  async function channelLatest(show, channelId) {
    if (!channelId) return null;
    try {
      const feed = (await Api.channelFeed(channelId))
        .filter(track => !Store.isBlocked(track) && Store.matchesQuery(show.name, track.title));
      const episodes = byNewest(feed).slice(0, LATEST_PER_SHOW)
        .map(track => Object.assign({}, track, { kind: "podcast", podcast: show.name }));
      return episodes.length ? episodes : null;
    } catch (e) {
      return null;
    }
  }

  async function showLatest(show) {
    const known = await channelLatest(show, show.channelId);
    if (known) return known;
    // No id yet, or an upload list that came back empty - which happens often enough that
    // it cannot be the only path. A search finds the show and, through the dominant
    // channel, its id.
    try {
      const result = await V.categorySearch(show.name);
      const items = (result.items || []).filter(track => !Store.isBlocked(track));
      const episodes = showEpisodes({ title: show.name, show }, items);
      if (!episodes.length) return [];
      // Then ask that channel directly, in this same pass. Search ranks by relevance, so
      // without this the first look at a show shows whichever episodes are most linked to
      // - for a podcast running for years, that is rarely anything from this month.
      const learned = (episodes.find(track => track.artistId) || {}).artistId;
      if (learned && learned !== show.channelId) {
        const fresh = await channelLatest(show, learned);
        if (fresh) return fresh;
      }
      return byNewest(episodes).slice(0, LATEST_PER_SHOW);
    } catch (e) {
      return [];
    }
  }

  async function latestEpisodes() {
    const shows = podcastShowsForRows(LATEST_SHOWS);
    if (!shows.length) throw new Error("no shows");
    const lists = await Promise.all(shows.map(showLatest));
    // Round robin rather than show after show, so the row reads as a feed of what is new
    // rather than three episodes of one thing followed by three of another.
    const merged = [];
    for (let rank = 0; rank < LATEST_PER_SHOW; rank++) {
      lists.forEach(list => { if (list[rank]) merged.push(list[rank]); });
    }
    if (!merged.length) throw new Error("nothing new came back");
    return merged.slice(0, 12);
  }

  let podcastShowsBusy = false;

  // About once a week, and only where there is a key to ask with. What comes back is show
  // names - what to search for - never episodes: this week's release schedule is precisely
  // what a model does not know.
  async function refreshPodcastShows(force) {
    if (podcastShowsBusy || !window.Ai || !Ai.hasAnyKey()) return false;
    const lang = listenerLanguage();
    const stale = !Store.podcastShowsList().length ||
      Store.podcastShowsLang() !== lang ||
      Store.podcastShowsAge() > PODCAST_SHOWS_TTL;
    if (!force && !stale) return false;
    podcastShowsBusy = true;
    try {
      const knownTaste = Store.followsList().filter(f => f.kind === "podcast").map(f => f.name);
      if (Store.topListeningPodcasts) Store.topListeningPodcasts(8).forEach(show => knownTaste.push(show.name));
      const shows = await Ai.suggestPodcastShows(languageName(lang), Array.from(new Set(knownTaste)));
      // Channels already learned survive the refresh: they are what identifies an episode
      // later, and re-learning one costs a whole row load.
      const known = new Map(Store.podcastShowsList().map(show => [Store.foldText(show.name).trim(), show]));
      Store.savePodcastShows(shows.map(show => ({
        name: show.name,
        channel: (known.get(Store.foldText(show.name).trim()) || {}).channel || "",
        channelId: (known.get(Store.foldText(show.name).trim()) || {}).channelId || ""
      })), lang);
      return true;
    } catch (e) {
      if (window.Log) Log.add("ai", "podcast shows failed: " + String((e && e.message) || e).slice(0, 80));
      return false;
    } finally { podcastShowsBusy = false; }
  }

  function homeFeedBase() {
    const artists = Store.topListeningArtists(3).map(artist => artist.name).sort();
    return V.homeFilter + ":" + (artists.join("|") || "new");
  }

  function homeFeedKey() {
    const base = homeFeedBase();
    if (V.homeFilter === "music") return base;
    // Podcast rows are shows, so the key has to move when the shows do - otherwise a
    // refreshed list keeps painting yesterday's cached rows for the rest of the day.
    const shows = podcastShowsForRows(V.homeFilter === "podcasts" ? PODCAST_ROWS : LATEST_SHOWS);
    return base + ":" + shows.map(show => show.name).join("|");
  }

  const LATEST_SPEC = ["Latest episodes", "", "latest"];

  function homeFeedSpecs() {
    const artists = Store.topListeningArtists(2);
    // What is new comes first on both tabs; the per-show rows sit under it for browsing.
    if (V.homeFilter === "podcasts") return [LATEST_SPEC].concat(podcastSpecs(PODCAST_ROWS));
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
      if (saved && cacheUsable(saved.at, RECS_TTL) && Array.isArray(saved.sections)) return saved.sections;
    } catch (e) {}
    return null;
  }

  function homeFeedCacheSave(key, sections) {
    try {
      const cache = JSON.parse(localStorage.getItem("aura.homeFeeds") || "{}");
      cache[key] = { at: Date.now(), sections };
      localStorage.setItem("aura.homeFeeds", JSON.stringify(cache));
    } catch (e) {}
  }

  function homeFeedsHtml() {
    homeFeedRenderedKey = homeFeedKey();
    const state = homeFeeds[homeFeedRenderedKey];
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
    if (current !== key && !homeFeeds[current] && key.indexOf(homeFeedBase() + ":") === 0) homeFeeds[current] = state;
  }

  function fillHomeFeeds() {
    if (V.currentTab !== "home" || V.subView) return;
    const holder = document.getElementById("home-feeds");
    if (holder) V.paint(holder, homeFeedsHtml());
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
    return byNewest(episodes.filter(track => (track.duration || 0) > 60)).slice(0, 12)
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
    return (section.mode === "latest" ? latestEpisodes() : searchedRow(section)).then(tracks => {
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
      if (homeFeeds[key] === state) followHomeFeedKey(state, key);
      fillHomeFeeds();
    });
  }

  function buildHomeFeeds() {
    const key = homeFeedKey();
    if (homeFeeds[key]) return;
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
    homeFeeds[key] = state;
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
    homeFeeds[key] = state;
    delete homeFeeds[homeFeedKey()];
    followHomeFeedKey(state, key);
    fillHomeFeeds();
  }

  // Artwork last, once the rows above have decided what they hold: pulling the thumbnails
  // into the browser's image cache now is what makes the first paint of the day instant
  // rather than a grid filling in square by square.
  function warmHomeArt() {
    const urls = [];
    const seen = new Set();
    const add = track => {
      const src = track && (track.thumb || (Api.thumbFor && Api.thumbFor(track.id)));
      if (!src || seen.has(src)) return;
      seen.add(src);
      urls.push(src);
    };
    aiHomeSection.tracks.forEach(add);
    homeRecs.items.forEach(add);
    Object.keys(homeFeeds).forEach(key => (homeFeeds[key].sections || []).forEach(section => (section.tracks || []).forEach(add)));
    const wanted = urls.slice(0, 60);
    if (!wanted.length) return Promise.resolve();
    return new Promise(resolve => {
      let left = wanted.length;
      const done = () => { if (--left <= 0) resolve(); };
      // A phone that drops off mid-run must not leave the whole nightly job hanging on an
      // image that will never load.
      const timer = setTimeout(resolve, 30000);
      wanted.forEach(src => {
        const img = new Image();
        img.onload = img.onerror = () => { done(); if (left <= 0) clearTimeout(timer); };
        img.src = src;
      });
    });
  }

  // Registered in the order they should run: the AI row first because it is the slowest
  // and the one most worth having ready, artwork last because it needs the others' answers.
  if (window.Nightly) {
    Nightly.register("AI mix", () => rebuildAiHomeSection());
    // Before the rows, because it decides which shows the rows are.
    Nightly.register("podcast shows", () => refreshPodcastShows());
    Nightly.register("Home rows", () => rebuildHomeFeeds());
    Nightly.register("recommendations", () => buildHomeRecs(true));
    Nightly.register("artwork", () => warmHomeArt());
  }

  // force skips the cache read: that is the nightly run replacing the row rather than the
  // render path filling it in. What is already on screen stays until the new list lands.
  async function buildHomeRecs(force) {
    const recents = Store.recents().filter(track => Store.mediaKind(track) === "music");
    if (!recents.length || homeRecs.busy) return;
    const profileSeeds = Store.topListeningTracks(6);
    const seed = profileSeeds.map(track => track.id).join(":") || recents[0].id;
    const cached = force ? null : recsCacheLoad(seed);
    if (cached) { homeRecs.items = cached; fillHomeRecs(); return; }
    // Nothing to build from without a signal. Every Home render used to start four
    // lookups that could only fail and flash the row in and out; the render that
    // follows the signal coming back builds it.
    if (navigator.onLine === false) return;
    homeRecs.busy = true;
    fillHomeRecs();
    try {
      const seeds = profileSeeds.slice(0, 4);
      const seen = new Set(recents.map(t => t.id));
      Store.library().forEach(t => seen.add(t.id));
      const results = await Promise.all(seeds.map(s => Api.resolve(s.id).catch(() => null)));
      const pools = results.map(info => (info && info.related) || []);
      const out = [];
      const maxLen = pools.reduce((a, p) => Math.max(a, p.length), 0);
      for (let i = 0; i < maxLen && out.length < 12; i++) {
        for (const pool of pools) {
          const t = pool[i];
          if (!t || seen.has(t.id) || !(t.duration > 60 && t.duration < 900)) continue;
          if (Store.settings().musicOnly !== false && !Api.looksLikeMusic(t)) continue;
          if (Store.isBlocked(t) || Store.mediaKind(t) === "podcast") continue;
          seen.add(t.id);
          out.push(t);
          if (out.length >= 12) break;
        }
      }
      homeRecs.items = out;
      if (out.length) {
        try { localStorage.setItem("aura.homeRecs", JSON.stringify({ at: Date.now(), seed, items: out })); } catch (e) {}
      }
    } finally {
      homeRecs.busy = false;
    }
    fillHomeRecs();
  }
})();
