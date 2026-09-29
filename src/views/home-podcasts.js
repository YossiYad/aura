(function () {
  const V = window.Aura.views;
  // The podcast side of Home: the shows a listener follows or is likely to, and their latest episodes.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    byNewest: { get: () => byNewest },
    LATEST_SHOWS: { get: () => LATEST_SHOWS },
    latestEpisodes: { get: () => latestEpisodes },
    PODCAST_ROWS: { get: () => PODCAST_ROWS },
    podcastShowsForRows: { get: () => podcastShowsForRows },
    podcastSpecs: { get: () => podcastSpecs },
    refreshPodcastShows: { get: () => refreshPodcastShows }
  });

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

  // Podcasts are listened to, so the language of the shows follows the listener: Hebrew
  // when they picked Hebrew, English when they picked it on a Hebrew phone, and otherwise
  // the phone's own language - English on a French phone still means French shows, as the
  // interface offers no French of its own to pick.
  function listenerLanguage() {
    const tag = String((navigator.languages && navigator.languages[0]) || navigator.language || "");
    const browser = tag.toLowerCase().split("-")[0] || "en";
    const chosen = window.I18n ? I18n.language() : "";
    if (chosen === "he") return "he";
    return chosen === "en" && browser === "he" ? "en" : browser;
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
      const episodes = V.showEpisodes({ title: show.name, show }, items);
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
})();
