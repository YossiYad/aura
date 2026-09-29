(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    buildHomeRecs: { get: () => buildHomeRecs },
    cacheUsable: { get: () => cacheUsable },
    homeFeedRenderedKey: { get: () => homeFeedRenderedKey, set: value => { homeFeedRenderedKey = value; } },
    homeFeeds: { get: () => homeFeeds },
    homeRecs: { get: () => homeRecs },
    homeRecsHtml: { get: () => homeRecsHtml },
    RECS_TTL: { get: () => RECS_TTL },
    STALE_MAX: { get: () => STALE_MAX }
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
    V.aiHomeSection.tracks.forEach(add);
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
    Nightly.register("AI mix", () => V.rebuildAiHomeSection());
    // Before the rows, because it decides which shows the rows are.
    Nightly.register("podcast shows", () => V.refreshPodcastShows());
    Nightly.register("Home rows", () => V.rebuildHomeFeeds());
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
      // A rebuild that found nothing - every lookup failed - leaves the row it came to
      // replace, rather than emptying it.
      if (out.length || !force) homeRecs.items = out;
      if (out.length) {
        try { localStorage.setItem("aura.homeRecs", JSON.stringify({ at: Date.now(), seed, items: out })); } catch (e) {}
      }
    } finally {
      homeRecs.busy = false;
    }
    fillHomeRecs();
  }
})();
