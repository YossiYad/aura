(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    channelFeed: { get: () => channelFeed },
    decodeHtml: { get: () => decodeHtml },
    fetchViaProxies: { get: () => fetchViaProxies }
  });

  function decodeHtml(s) {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  }

  // A relay on the app's own host needs no CORS at all and is not somebody else's rate
  // limit to run into. When config.json names one it is tried first; everything else is
  // the fallback it used to be.
  async function configuredRelay() {
    const cfg = await V.siteConfig();
    const relay = typeof cfg.textRelay === "string" ? cfg.textRelay.trim() : "";
    return /^(https?:\/\/|\/)/.test(relay) ? relay : "";
  }

  /**
   * Reads a page, directly or through the configured and public relays.
   * @param {string} url
   * @param {string} [needle] Text the page must contain to count as the real page.
   * @returns {Promise<string>}
   */
  async function fetchViaProxies(url, needle) {
    const ok = text => {
      if (!text || text.length < 200) throw new Error("empty response");
      // A relay that answers with its own error page is not a failure the browser can
      // see, so the caller says what the page has to contain to count.
      if (needle && text.indexOf(needle) === -1) throw new Error("relay returned something else");
      return text;
    };
    const tried = [];
    const routes = [];
    const relay = await configuredRelay();
    // Deliberately not percent-encoded: a relay on a plain nginx cannot unescape a query
    // value, so it has to arrive readable. Only the characters that would end the query
    // early are escaped, and none of the pages read here carry one.
    if (relay) routes.push(u => relay + String(u).replace(/[&#+ ]/g, c => encodeURIComponent(c)));
    routes.push.apply(routes, V.TEXT_PROXIES);

    try { return ok(await V.fetchText(url, 15000)); }
    catch (e) { tried.push("direct: " + String(e.message || e).slice(0, 30)); }
    for (const wrap of routes) {
      const via = V.host(wrap(url));
      try {
        const text = ok(await V.fetchText(wrap(url), 20000));
        V.log("import", "read " + V.host(url) + " via " + via);
        return text;
      } catch (e) {
        tried.push(via + ": " + String(e.message || e).slice(0, 30));
      }
    }
    V.log("import", "every route failed - " + tried.join(" | "));
    throw new Error("Could not reach " + V.host(url) + " through any relay (" + tried.length + " tried). It may be blocking them, or the link may not be public.");
  }

  // A channel's newest uploads, from the feed YouTube publishes for every channel.
  //
  // Invidious would have been the place to ask - its API takes sort_by=upload_date - but
  // every instance on the public list now answers /api/v1 with 401 or 403, and Piped's
  // channel endpoint hands back an empty upload list. This feed is the one source still
  // simply published: no key, no instance, exact dates, fifteen newest. It carries no CORS
  // header, so it goes out through the same relays the playlist importer uses.
  //
  // There are no durations in it. That is the price, and it is affordable here: the rows
  // built from this show a title and a channel, and the player reads the real length off
  // the stream when one is played.
  /**
   * A channel's fifteen newest uploads, from its public feed. Durations are 0.
   * @param {string} channelId
   * @returns {Promise<Track[]>}
   */
  async function channelFeed(channelId) {
    const id = String(channelId || "").trim();
    if (!id) throw new Error("no channel");
    const xml = await fetchViaProxies("https://www.youtube.com/feeds/videos.xml?channel_id=" + encodeURIComponent(id), "<entry>");
    const author = (/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(xml) || [])[1] || "";
    const out = [];
    const entries = xml.split("<entry>").slice(1);
    for (const entry of entries) {
      const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry) || [])[1];
      const title = (/<title>([\s\S]*?)<\/title>/.exec(entry) || [])[1];
      const published = (/<published>([^<]+)<\/published>/.exec(entry) || [])[1];
      if (!videoId || !title) continue;
      const at = Date.parse(published || "");
      out.push({
        id: videoId,
        title: decodeXml(title),
        artist: decodeXml(author),
        album: "",
        duration: 0,
        thumb: V.thumbFor(videoId),
        published: isFinite(at) ? at : 0,
        views: null,
        artistId: id,
        artistThumb: ""
      });
    }
    if (!out.length) throw new Error("empty feed");
    return out;
  }

  function decodeXml(value) {
    return String(value || "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
  }
})();
