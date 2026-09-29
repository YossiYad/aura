(function () {
  const V = window.Aura.views;
  // The "Picked for you today" row: built here from the listening history, or taken ready-made from the server that builds it overnight.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    aiHomeSection: { get: () => aiHomeSection },
    aiHomeSectionHtml: { get: () => aiHomeSectionHtml },
    buildAiHomeSection: { get: () => buildAiHomeSection },
    rebuildAiHomeSection: { get: () => rebuildAiHomeSection },
    serverMixState: { get: () => serverMixState }
  });

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
      if (raw && raw.sig === aiHomeSignature() && V.cacheUsable(raw.at, AI_HOME_TTL) &&
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
    // Two suggestions that resolve to the same upload are one card, not two alike.
    const seen = new Set();
    const found = matches.filter(t => t && !seen.has(t.id) && seen.add(t.id));
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
})();
