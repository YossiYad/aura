(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    isPodcastChannel: { get: () => isPodcastChannel },
    notePodcastChannel: { get: () => notePodcastChannel },
    podcastShows: { get: () => podcastShows, set: value => { podcastShows = value; } },
    podcastShows_: { get: () => podcastShows_ },
    podcastShowsAge: { get: () => podcastShowsAge },
    podcastShowsLang: { get: () => podcastShowsLang },
    podcastShowsList: { get: () => podcastShowsList },
    savePodcastShows: { get: () => savePodcastShows },
    showKey: { get: () => showKey }
  });

  // The podcast shows Home builds its rows from, and the channel each row turned out to
  // belong to. The channel is the valuable half. Whether something is talk rather than
  // music was decided by reading its title, and a real episode often says nothing that
  // gives it away - "חיות כיס | למה העובדים בישראל לא יעילים?" reads like anything else.
  // Match both the publisher and the show title before classifying an untyped episode.
  let podcastShows = V.loadPodcastShows();

  function showKey(value) {
    return V.foldText(value).replace(/\s+/g, " ").trim();
  }

  function podcastShows_() { return podcastShows.shows; }

  /**
   * @returns {PodcastShow[]}
   */
  function podcastShowsList() {
    return podcastShows_().map(show => Object.assign({}, show));
  }

  /**
   * @returns {number} Milliseconds since the show list was saved.
   */
  function podcastShowsAge() {
    return Date.now() - (Number(podcastShows.at) || 0);
  }

  /**
   * @returns {string} Language the show list was chosen for.
   */
  function podcastShowsLang() {
    return String(podcastShows.lang || "");
  }

  /**
   * @param {Partial<PodcastShow>[]} list
   * @param {string} [lang]
   */
  function savePodcastShows(list, lang) {
    const seen = new Set();
    const shows = (Array.isArray(list) ? list : []).map(show => ({
      name: String((show && show.name) || "").trim().slice(0, 80),
      channel: String((show && show.channel) || "").trim().slice(0, 80),
      channelId: String((show && show.channelId) || "").trim().slice(0, 60)
    })).filter(show => {
      const key = showKey(show.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24);
    podcastShows = { at: Date.now(), lang: String(lang || ""), shows };
    V.save("aura.podcastShows", podcastShows);
    V.notify("podcastShows");
  }

  // A row that loaded names the channel actually publishing the show. The name is what
  // makes its episodes recognisable everywhere else afterwards; the id is what lets the
  // newest ones be asked for directly, instead of hoping a search happens to rank them
  // first.
  /**
   * Records the channel publishing a show, and reclassifies earlier episodes of it.
   * @param {string} name Show name.
   * @param {string} channel Channel name.
   * @param {string} [channelId]
   * @param {boolean} [addIfMissing] Add the show when it is not in the list yet.
   */
  function notePodcastChannel(name, channel, channelId, addIfMissing) {
    const value = String(channel || "").trim().slice(0, 80);
    const id = String(channelId || "").trim().slice(0, 60);
    let show = podcastShows_().find(item => showKey(item.name) === showKey(name));
    if (!show && addIfMissing && name && value) {
      show = { name: String(name).trim().slice(0, 80), channel: "", channelId: "" };
      podcastShows_().push(show);
    }
    if (!show || !value) return;
    const changed = show.channel !== value || (id && show.channelId !== id);
    if (changed) {
      show.channel = value;
      if (id) show.channelId = id;
      V.save("aura.podcastShows", podcastShows);
    }
    // A listener may have heard this show before its row taught us the publisher. Repair
    // those untyped records now, so an old episode stops counting as music immediately.
    let repairedRecents = false;
    V.recents = V.recents.map(track => {
      if (track.kind || V.matchingPodcastShow(track) !== show) return track;
      repairedRecents = true;
      return Object.assign({}, track, { kind: "podcast", podcast: show.name });
    });
    let repairedProfile = false;
    Object.values(V.listeningProfile.tracks).forEach(item => {
      if (!item || !item.track || item.track.kind || V.matchingPodcastShow(item.track) !== show) return;
      item.track = Object.assign({}, item.track, { kind: "podcast", podcast: show.name });
      repairedProfile = true;
    });
    if (repairedRecents) V.save("aura.recents", V.recents);
    if (repairedProfile) V.save("aura.listeningProfile", V.listeningProfile);
  }

  // Followed podcasts count too: following one is the listener saying outright what it is.
  /**
   * @param {string} name Channel name.
   * @returns {boolean}
   */
  function isPodcastChannel(name) {
    const key = showKey(name);
    if (!key) return false;
    return podcastShows_().some(show => show.channel && showKey(show.channel) === key) ||
      V.follows.some(f => f.kind === "podcast" && showKey(f.name) === key);
  }
})();
