(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    invalidate: { get: () => invalidate },
    looksLikePodcast: { get: () => looksLikePodcast },
    resolve: { get: () => resolve }
  });

  /**
   * @returns {"best" | "normal" | "data"}
   */
  function qualityTier() {
    const q = window.Store ? Store.settings().audioQuality : null;
    return q === "data" || q === "normal" ? q : "best";
  }

  // streams arrive sorted by bitrate, highest first.
  function pickByTier(streams, tier) {
    if (!streams.length) return null;
    if (tier === "data") return streams[streams.length - 1];
    if (tier === "normal") {
      let best = streams[0], closest = Infinity;
      for (const s of streams) {
        const off = Math.abs((s.bitrate || 0) - 128000);
        if (off < closest) { closest = off; best = s; }
      }
      return best;
    }
    return streams[0];
  }

  // "Not music" is not the same as "a podcast". Deciding the podcast side by the absence of
  // music let a long song fall through to it. The podcast side now needs positive evidence,
  // and anything that looks like music is never eligible however long it runs.
  const SPOKEN_MARKERS = ["פודקאסט", "פרק", "ראיון", "סטנד אפ", "סטנדאפ", "הרצאה", "שיחה עם",
    "מערכון", "כתבה", "חדשות", "תוכנית", "דיון", "פאנל", "ספר מוקלט",
    "podcast", "episode", "interview", "talk show", "lecture", "audiobook", "audio book",
    "sermon", "commentary", "discussion", "conversation with", "stand up", "standup"];
  // Music that runs as long as an episode. Length alone would hand these to the podcast
  // side, and a set or a full album is exactly what the listener meant by "a song".
  const LONG_MUSIC = ["מופע", "הופעה", "אלבום", "מיקס", "רמיקס", "פלייליסט", "שעה של", "סט", "סימפוניה",
    "קונצרט", "אופרה", "פסקול", "live", "concert", "mix", "remix", "dj set", "live set", "album", "full album",
    "playlist", "greatest hits", "best of", "session", "acoustic", "unplugged", "megamix",
    "symphony", "opera", "sonata", "concerto", "orchestra", "soundtrack", "ost", "medley", "extended",
    "ambient", "meditation", "sleep music", "lofi", "lo fi", "hour", "hours", "continuous"];

  /**
   * @param {Track | null | undefined} track
   * @returns {boolean}
   */
  function looksLikePodcast(track) {
    if (!track) return false;
    if (V.looksLikeMusic(track)) return false;
    const hay = V.normMatch(track.title) + " " + V.normMatch(track.artist);
    const says = list => list.some(w => V.hasWord(hay, w));
    if (says(SPOKEN_MARKERS)) return true;
    // Nothing said so outright. Length is the only evidence left, and it is only worth
    // anything past half an hour and with nothing on the track that reads as long music.
    return (track.duration || 0) >= 1800 && !says(LONG_MUSIC);
  }

  // Prefer the common AAC/MP3 formats for receivers, independently of what the
  // phone can decode. In particular, Safari decoding Opus does not imply AirPlay can.
  /**
   * @param {string} mime
   * @returns {boolean} True for AAC, MP3 and MP4 audio that AirPlay and Cast receivers play.
   */
  function receiverCompatible(mime) {
    return /^(?:audio\/(?:mp4|mpeg|aac)|video\/mp4)(?:;|$)/i.test(mime || "") &&
      !/opus|vorbis|av01|vp0?9/i.test(mime);
  }

  function playableAudio(streams, tier, remote) {
    const audio = /** @type {HTMLAudioElement} */ (document.getElementById("audio"));
    const usable = (streams || []).filter(s => s.url && /^audio\//.test(s.mimeType || s.type || ""));
    if (!usable.length) return null;
    usable.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const playable = usable.filter(s => {
      const mime = s.mimeType || s.type || "";
      return (!remote || receiverCompatible(mime)) && (!mime || audio.canPlayType(mime));
    });
    const chosen = pickByTier(playable, tier || qualityTier());
    if (!chosen) return null;
    return { url: chosen.url, mime: (chosen.mimeType || chosen.type || "").split(";")[0] };
  }

  // Some videos expose no audio-only track at all. A muxed stream still carries the same
  // audio and an <audio> element decodes it, so this beats the alternative - declaring the
  // source dead and falling back to the YouTube iframe, which means ads and no background
  // playback. Pick the smallest one, since the video half is thrown away.
  function playableMuxed(streams, remote) {
    const audio = /** @type {HTMLAudioElement} */ (document.getElementById("audio"));
    const usable = (streams || []).filter(s => s.url && /^(audio|video)\//.test(s.mimeType || s.type || ""));
    usable.sort((a, b) => (parseInt(a.height, 10) || parseInt(a.bitrate, 10) || 0) - (parseInt(b.height, 10) || parseInt(b.bitrate, 10) || 0));
    for (const s of usable) {
      const mime = s.mimeType || s.type || "";
      if ((!remote || receiverCompatible(mime)) && (!mime || audio.canPlayType(mime))) return { url: s.url, mime: mime.split(";")[0] };
    }
    return null;
  }

  async function resolvePipedOne(base, id, tier, remote) {
    try {
      const data = await V.fetchJson(base + "/streams/" + id, 6000);
      let stream = playableAudio(data.audioStreams, tier, remote);
      if (!stream) {
        stream = playableMuxed((data.videoStreams || []).filter(s => s.videoOnly === false), remote);
        if (stream) V.log("piped", id + " has no audio-only track, using a muxed stream");
      }
      if (!stream) throw new Error("no audio");
      V.markGood(base);
      V.log("piped", "stream OK via " + V.host(base) + " (" + stream.mime + ")");
      return { url: stream.url, mime: stream.mime, duration: Number(data.duration) || 0,
        at: Date.now(), base, kind: "piped", related: (data.relatedStreams || []).map(V.normPiped).filter(Boolean) };
    } catch (e) {
      V.log("piped", V.host(base) + " fail: " + String(e.message || e).slice(0, 60));
      if (V.shouldCooldownStream(e)) V.markBad(base, "stream");
      throw e;
    }
  }

  async function receiverAccessibleStream(stream) {
    const cfg = await V.siteConfig();
    if (!cfg.mediaTickets || !window.location) return stream;
    const origin = window.location.origin;
    const source = new URL(stream.url, origin);
    if (source.origin !== origin || source.pathname !== "/videoplayback") return stream;
    const endpoint = new URL(cfg.mediaTickets, origin);
    if (endpoint.origin !== origin || endpoint.pathname !== "/api/media/ticket" || endpoint.search || endpoint.hash) {
      throw new Error("Invalid media ticket endpoint");
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch(endpoint.href, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: source.href }),
        signal: ctl.signal });
      if (!res.ok) throw new Error("Media ticket HTTP " + res.status);
      const data = await res.json();
      const url = new URL(data.url, origin);
      if (url.origin !== origin || url.pathname !== "/media/play" || !url.searchParams.get("ticket") ||
          !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() + 30000) {
        throw new Error("Invalid media ticket");
      }
      return Object.assign({}, stream, { url: url.href, expiresAt: data.expiresAt });
    } finally { clearTimeout(timer); }
  }

  async function resolveInvidiousOne(base, id, tier, remote) {
    try {
      const data = await V.fetchJson(base + "/api/v1/videos/" + id + "?local=true", 6000);
      let stream = playableAudio((data.adaptiveFormats || []).map(f => ({ url: V.absoluteUrl(f.url, base), mimeType: f.type, bitrate: parseInt(f.bitrate, 10) || 0 })), tier, remote);
      // YouTube ships how far this upload sits from its reference level. It was being
      // dropped on the floor; it is what makes one track blast after a quiet one.
      const loudness = parseFloat(data.loudnessDb != null ? data.loudnessDb
        : ((data.adaptiveFormats || []).find(f => f && f.loudnessDb != null) || {}).loudnessDb);
      if (!stream) {
        stream = playableMuxed((data.formatStreams || []).map(f => ({ url: V.absoluteUrl(f.url, base), mimeType: f.type, bitrate: parseInt(f.bitrate, 10) || 0, height: parseInt(f.height, 10) || 0 })), remote);
        if (stream) V.log("invidious", id + " has no audio-only track, using a muxed stream");
      }
      if (!stream) throw new Error("no audio");
      // Safari can hand the current URL to AirPlay directly from system controls.
      // Issue a scoped URL before local playback as well as explicit TV playback.
      stream = await receiverAccessibleStream(stream);
      V.markGood(base);
      V.log("invidious", "stream OK via " + V.host(base) + " (" + stream.mime + ")");
      return { url: stream.url, mime: stream.mime, expiresAt: stream.expiresAt, at: Date.now(), base, kind: "invidious",
        duration: Number(data.lengthSeconds) || 0,
        loudnessDb: isNaN(loudness) ? null : loudness,
        related: (data.recommendedVideos || []).map(x => V.normInvidious(x, base)).filter(Boolean) };
    } catch (e) {
      V.log("invidious", V.host(base) + " fail: " + String(e.message || e).slice(0, 60));
      if (V.shouldCooldownStream(e)) V.markBad(base, "stream");
      throw e;
    }
  }

  async function resolveCobaltOne(base, id, remote) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await fetch(base + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=" + id,
          downloadMode: "audio",
          audioFormat: remote ? "mp3" : "best"
        })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const url = data.url || (Array.isArray(data.tunnel) ? data.tunnel[0] : null);
      if (!url || (data.status && data.status === "error")) { V.markBad(base, "stream"); throw new Error("cobalt " + (data.status || "no url")); }
      V.markGood(base);
      V.log("cobalt", "stream OK via " + V.host(base));
      return { url, at: Date.now(), base, kind: "cobalt", related: [] };
    } catch (e) {
      V.log("cobalt", V.host(base) + " fail: " + String(e.message || e).slice(0, 60));
      V.markBad(base, "stream");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // A stream URL can stop working before the cache entry expires. Checking it costs one
  // HEAD; being wrong costs a track that fails on play and looks like a skip.
  async function stillServing(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: ctl.signal });
      return res.status < 400;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // The same track can be asked for twice before either answer arrives - tapping it
  // again while it is still loading, or the play path and the one warming the next
  // address landing together. The second question was a second round trip to every
  // server whose answer was then thrown away.
  const inFlight = new Map();

  // What separates a server that is down from one that is merely refusing this video:
  // whether it has served anything at all, and whether the track before this one got the
  // same answer.
  let servedSomething = false;
  let brokeStreak = 0;

  /**
   * Finds a playable stream for a video, from the cache or the first server to answer.
   * @param {string} id Video id.
   * @param {ResolveOptions} [opts]
   * @returns {Promise<StreamInfo>} Rejects with `outage: true` on the error when no server works at all.
   */
  function resolve(id, opts) {
    const tier = (opts && opts.quality) || qualityTier();
    // Format compatibility can be requested before an AirPlay route is selected.
    // Reuse that format's cache/in-flight lookup when the native route connects.
    const remote = !!(opts && (opts.remote || opts.receiverCompatible));
    const key = id + "|" + tier + (remote ? "|remote" : "");
    // A caller that names servers to leave out wants a different answer from the one a
    // lookup already running, or the cache, would hand back.
    const avoid = opts && opts.avoid && opts.avoid.size ? opts.avoid : null;
    if (avoid) return resolveOnce(id, key, tier, remote, avoid);
    const running = inFlight.get(key);
    if (running) {
      V.log("resolve", id + " already being looked up, waiting on that");
      return running;
    }
    const p = resolveOnce(id, key, tier, remote);
    inFlight.set(key, p);
    // Cleared either way: a failure must not stop the next attempt from asking.
    p.then(() => inFlight.delete(key), () => inFlight.delete(key));
    return p;
  }

  async function resolveOnce(id, key, tier, remote, avoid) {
    // Cached per quality, so switching the setting does not serve the old stream back.
    const hit = avoid ? null : V.streamCache.get(key);
    if (hit && Date.now() - hit.at < V.STREAM_TTL && (!hit.expiresAt || hit.expiresAt > Date.now() + 30000)) {
      // Freshly resolved URLs are taken on trust; older ones are verified first.
      if (Date.now() - hit.at < V.VERIFY_AFTER || await stillServing(hit.url)) {
        V.log("resolve", id + " from cache (" + V.host(hit.url) + ")");
        return hit;
      }
      V.log("resolve", id + " cached url stopped serving, resolving again");
      V.streamCache.delete(key);
    }

    const t0 = Date.now();
    V.log("resolve", id + " start");
    const inst = await V.instances();
    let out = null;

    // A cooldown is a guess that one server broke. When every server of every tier is
    // cooling off at once, the likelier story is that the network dropped while a resolve
    // was in flight and each request "failed to fetch"; refusing to ask for the next ten
    // minutes would hold the queue long after the network came back. Ask them all instead
    // and let the retry backoff pace it, as prioritize() does for searches.
    const tiers = [inst.trustedCobalt, inst.piped, inst.invidious, inst.cobalt];
    const allCooling = tiers.some(list => list.length) && tiers.every(list => !V.liveOnly(list, "stream").length);
    if (allCooling) V.log("resolve", id + " every server is cooling off, asking them all");
    const liveTier = list => V.withLastGood((allCooling ? list.slice() : V.liveOnly(list, "stream"))
      .filter(b => !avoid || !avoid.has(b)), inst.lastGood);
    const trustedLive = liveTier(inst.trustedCobalt);
    const pipedLive = liveTier(inst.piped);
    const invLive = liveTier(inst.invidious);
    // A server that answered with its own error is a broken server, not a missing track.
    // Counting them is what tells the difference at the end.
    let serverFaults = 0;
    const noteFaults = p => p.catch(e => { if (V.shouldCooldownStream(e)) serverFaults++; throw e; });
    const tasks = trustedLive.map(b => resolveCobaltOne(b, id, remote))
      .concat(pipedLive.map(b => resolvePipedOne(b, id, tier, remote)))
      .concat(invLive.map(b => resolveInvidiousOne(b, id, tier, remote)))
      .map(noteFaults);
    V.log("resolve", id + " racing " + trustedLive.length + " trusted + " + pipedLive.length + " piped + " + invLive.length + " invidious");
    let attempted = tasks.length;
    if (tasks.length) {
      try { out = await V.raceOk(tasks); }
      catch (e) { V.log("resolve", id + " all primary sources failed (" + (Date.now() - t0) + "ms)"); }
    } else { V.log("resolve", id + " all primary tiers in cooldown, skipping"); }

    if (!out) {
      const cobaltLive = liveTier(inst.cobalt);
      attempted += cobaltLive.length;
      if (cobaltLive.length) {
        try { out = await V.raceOk(cobaltLive.map(b => noteFaults(resolveCobaltOne(b, id, remote)))); }
        catch (e) { V.log("resolve", id + " all cobalt failed"); }
      } else { V.log("resolve", id + " cobalt tier all in cooldown, skipping"); }
    }
    if (!out) {
      const allBroke = attempted > 0 && serverFaults >= attempted;
      // A server that errors on one video while serving others is not an outage, and
      // holding the queue on it would block the search for another upload of the same
      // song - the thing that actually gets it playing. So a working server is given the
      // benefit of the doubt once: the queue is only held when nothing has ever played
      // this session, or when a second track in a row got the same treatment.
      if (allBroke) brokeStreak++;
      // With no signal it is never this video's fault, whatever has played before. Read
      // as one, the first song after the signal dropped went looking for another upload,
      // announced that the servers were down, and tried YouTube before the queue held.
      const outage = !attempted || navigator.onLine === false || (allBroke && (!servedSomething || brokeStreak > 1));
      V.log("resolve", id + " no working source (" + (Date.now() - t0) + "ms)" +
        (!allBroke ? "" : outage ? " - every server it asked answered with an error"
          : " - the server errored on this one but has served others, treating it as this video's fault"));
      const err = /** @type {Error & { outage?: boolean }} */ (new Error(!attempted ? "all servers down" : allBroke ? "every server errored" : "no source"));
      if (outage) err.outage = true;
      throw err;
    }
    servedSomething = true;
    brokeStreak = 0;
    V.log("resolve", id + " OK -> " + V.host(out.url) + " (" + (Date.now() - t0) + "ms, " + out.kind + ")");
    V.streamCache.set(key, out);
    return out;
  }

  /**
   * Drops the cached streams for a video.
   * @param {string} id Video id.
   * @param {boolean} [penalizeSource] Put the server that served it on cooldown; default true.
   */
  function invalidate(id, penalizeSource) {
    for (const key of Array.from(V.streamCache.keys())) {
      if (key !== id && key.indexOf(id + "|") !== 0) continue;
      const hit = V.streamCache.get(key);
      if (penalizeSource !== false && hit && hit.base) V.markBad(hit.base, "stream");
      V.streamCache.delete(key);
    }
  }
})();
