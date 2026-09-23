(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.voice;

  // Understanding a request: the commands and the "play next" and "add" wording are read
  // here without a model, the rest goes to Ai.interpretPlayback when online with a key, and
  // resolve() looks the result up and returns the tracks without touching playback.
  function clean(value) {
    return String(value || "").trim().replace(/[.!?…]+$/g, "")
      .replace(/(?:\s+|^)(?:בבקשה|תודה|please|thanks)$/i, "").trim();
  }
  /**
   * Splits where a request wants its music from what it asks for.
   * @param {string} request
   * @returns {{ text: string, action: "play" | "next" | "append" }}
   */
  function playbackRequest(request) {
    let text = clean(V.requestStart(request));
    /** @type {"play" | "next" | "append"} */
    let action = /^(?:(?:בבקשה|אפשר|please|can you|could you)\s+)?(?:תוסיף|תוסיפי|הוסף|הוסיפי|תצרף|תצרפי|צרף|צרפי|add|append|queue|enqueue)\s/i.test(text) ? "append" : "play";
    const appendSuffix = /\s+(?:(?:לסוף|בסוף|אל\s+סוף)\s+(?:ה?תור|רשימת\s+ההשמעה)|ל(?:ה?תור)|(?:to|at)\s+the\s+end\s+of\s+(?:the\s+|my\s+)?queue|to\s+(?:the\s+|my\s+)?queue)[.!?…]*$/i;
    if (appendSuffix.test(text)) { text = text.replace(appendSuffix, "").trim(); action = "append"; }
    const appendPrefix = /^((?:(?:בבקשה|אפשר|please|can you|could you)\s+)?(?:תוסיף|תוסיפי|הוסף|הוסיפי|תצרף|תצרפי|צרף|צרפי|תשים|שים|add|append)(?:\s+לי)?\s+)(?:(?:לסוף|בסוף)\s+ה?תור|ל(?:ה?תור)|to\s+(?:the\s+)?(?:end\s+of\s+the\s+)?queue)\s+/i;
    if (appendPrefix.test(text)) { text = text.replace(appendPrefix, "$1").trim(); action = "append"; }
    // Match placement at the edges of a request, so titles like Next to Me
    // and The Next Episode keep their names. Song lookup receives only the title.
    const suffix = /\s+(?:(?:שיהיה\s+)?(?:בתור\s+(?:ה?שיר\s+)?|כ(?:ה?שיר\s+)?|לשיר\s+)הבא|שיהיה\s+(?:ה?שיר\s+)?הבא|אחרי\s+השיר\s+(?:הזה|הנוכחי)|(?:up\s+)?next|as\s+the\s+next\s+song)[.!?…]*$/i;
    if (suffix.test(text)) { text = text.replace(suffix, "").trim(); action = "next"; }
    const prefix = /^((?:(?:בבקשה|אפשר|please|can you|could you)\s+)?(?:תשים|תשימי|שים|שימי|תנגן|תנגני|נגן|תשמיע|תשמיעי|תוסיף|תוסיפי|הוסף|הוסיפי|play|queue|enqueue)(?:\s+לי)?\s+)(?:את\s+)?(?:(?:בתור\s+(?:ה?שיר\s+)?|כ(?:ה?שיר\s+)?)הבא|ה?שיר\s+הבא|next(?=\s+(?:the\s+)?song\s))(?:\s+|$)/i;
    if (prefix.test(text)) { text = text.replace(prefix, "$1").trim(); action = "next"; }
    const namedNext = /^(?:ה?שיר\s+הבא\s+(?:יהיה|הוא)|next\s+song\s+is)\s+/i;
    if (namedNext.test(text)) { text = text.replace(namedNext, ""); action = "next"; }
    return { text, action };
  }
  // True when typed words ask for playback themselves: they open with a verb such as play
  // or add, or they name a place in the queue. Deliberately narrower than what speech is
  // allowed to mean - "playlist for studying" and "music from the 80s" describe a playlist
  // to build, and only an explicit verb turns a description into an order.
  /**
   * @param {string} request Typed text.
   * @returns {boolean} True when the words ask for playback themselves, not describe a playlist.
   */
  function isCommand(request) {
    if (playbackRequest(request).action !== "play") return true;
    const text = clean(V.requestStart(request)).replace(/^(?:(?:היי|אורה|בבקשה|אפשר|אתה יכול|את יכולה|אני רוצה|בא לי|אני אשמח|can you|could you|i want to|please)\s+)+/i, "");
    return /^(?:שתשים|שתשימי|שתפעיל|שתפעילי|שתנגן|שתנגני|תשים|תשימי|שים|שימי|תפעיל|תפעילי|הפעל|תנגן|תנגני|נגן|תשמיע|תשמיעי|השמע|תוסיף|תוסיפי|הוסף|הוסיפי|play|put on|queue|enqueue)(?:\s|$)/i.test(text);
  }
  /**
   * @param {string} request
   * @returns {VoiceIntent}
   */
  function basicIntent(request) {
    const placement = playbackRequest(request);
    return { ...musicIntent(placement.text), action: placement.action };
  }
  /**
   * @param {string} request
   * @returns {{ kind: VoiceIntent["kind"], query: string, artist: string }}
   */
  function musicIntent(request) {
    let q = clean(V.requestStart(request));
    q = q.replace(/^(?:(?:היי|אורה|בבקשה|אפשר|אתה יכול|את יכולה|אני רוצה|בא לי|אני אשמח|can you|could you|i want to|please)\s+)+/i, "");
    q = q.replace(/^(?:שתשים|שתשימי|שתפעיל|שתפעילי|שתנגן|שתנגני|תשים|תשימי|שים|שימי|תפעיל|תפעילי|הפעל|תנגן|תנגני|נגן|תשמיע|תשמיעי|השמע|תוסיף|תוסיפי|הוסף|הוסיפי|תצרף|תצרפי|צרף|צרפי|לשמוע|להקשיב|play|put on|queue|enqueue|add|append)(?:\s+לי)?(?:\s+|$)/i, "");
    q = q.replace(/^(?:בבקשה\s+)?(?:את\s+)?/i, "");
    q = clean(q);
    let m;
    if (/^(?:השירים שאהבתי|השירים האהובים שלי|המועדפים שלי|liked songs|my liked songs)$/i.test(q)) return { kind: "liked", query: "", artist: "" };
    if ((m = /^(?:ה?פלייליסט|רשימת\s+ה?השמעה|(?:the |my )?playlist)\s+(?:(?:שלי|בשם|שנקרא|called|named)\s+)?(.+)$/i.exec(q))) return { kind: "playlist", query: clean(m[1]), artist: "" };
    if ((m = /^(?:(?:ה?שירים|מוזיקה|שיר)\s+של|(?:ה?אמן|ה?זמר|ה?זמרת|ה?להקה)|(?:songs?|music)\s+(?:by|from))\s+(.+)$/i.exec(q))) return { kind: "artist", query: clean(m[1]), artist: "" };
    // "The newest song of X" asks for one artist's most recent release, not a title called
    // "new". Caught before the plain song parse turns "החדש" into a song name of its own.
    // The Hebrew cue takes the adjective with or without its article ("השיר החדש של X" and
    // the terser "שיר חדש של X" both read as newest). The English "...song by X" form insists
    // on a leading "the" or a possessive, so a bare "New Song by Howard Jones" - the shape of
    // a real title - still falls through to the song parser rather than being read as newest.
    if ((m = /^(?:ה?שיר|ה?סינגל)?\s*(?:הכי\s+ה?חדשה?|ה?חדשה?(?:\s+ביותר)?|הכי\s+ה?אחרו(?:ן|נה)|ה?אחרו(?:ן|נה))\s+של\s+(.+)$/i.exec(q)) ||
        (m = /^the\s+(?:new|newest|latest|most\s+recent)\s+(?:song|single|track|release)\s+(?:by|from)\s+(.+)$/i.exec(q)) ||
        (m = /^(.+?)'?s\s+(?:new|newest|latest|last|most\s+recent)\s+(?:song|single|track|release)$/i.exec(q)))
      return { kind: "latest", query: clean(m[1]), artist: "" };
    q = q.replace(/^(?:ה?שיר|(?:the )?song)\s+/i, "");
    if ((m = /^(.+?)\s+(?:של|by)\s+(.+)$/i.exec(q))) return { kind: "song", query: clean(m[1]), artist: clean(m[2]) };
    return { kind: "song", query: q, artist: "" };
  }
  function named(items, query, name) {
    const wanted = V.fold(query);
    if (!wanted) return [];
    const exact = items.filter(item => V.fold(name(item)) === wanted);
    if (exact.length) return exact;
    return items.filter(item => (" " + V.fold(name(item)) + " ").includes(" " + wanted + " "));
  }
  const VERSION_WORDS = ["live", "remix", "karaoke", "instrumental", "acapella", "concert", "sped up", "slowed",
    "nightcore", "mashup", "קריוקי", "רמיקס", "בהופעה", "הופעה חיה"];
  function otherVersion(title, asked) {
    const got = " " + V.fold(title) + " ", wanted = " " + V.fold(asked) + " ";
    return VERSION_WORDS.some(word => got.includes(" " + word + " ") && !wanted.includes(" " + word + " "));
  }
  function uniqueMatch(items, message) {
    if (items.length > 1) throw new Error(message);
    return items[0];
  }
  function artistScore(value, query) {
    const raw = String(value || "");
    const wanted = V.fold(query);
    if (!wanted) return 0;
    const name = V.fold(raw.replace(/VEVO$/i, "")).replace(/(?:^|\s)(?:topic|official|channel|הערוץ הרשמי|ערוץ רשמי|הרשמי)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
    // A name embedded in a fan/tribute channel is not the requested performer.
    if (/(?:^|\s)(?:fans?|covers?|tribute|karaoke|מעריצים|מחווה|קאברים|קריוקי)(?:\s|$)/i.test(name) && name !== wanted) return 0;
    let score = name === wanted || V.fold(raw) === wanted ? 100 : 0;
    if (!score && (" " + name + " ").includes(" " + wanted + " ")) {
      const rest = (" " + name + " ").replace(" " + wanted + " ", " ").trim();
      // Official Israeli channels commonly display both Hebrew and Latin names.
      // Do not accept arbitrary same-language suffixes (e.g. Queen Latifah).
      if (/^[\p{Script=Hebrew}\s]+$/u.test(wanted) && /^[a-z\s]+$/i.test(rest) ||
          /^[a-z\s]+$/i.test(wanted) && /^[\p{Script=Hebrew}\s]+$/u.test(rest)) score = 90;
    }
    if (!score) return 0;
    return score;
  }
  /**
   * @param {Track[]} tracks
   * @returns {Track[]} Music tracks that are not blocked, without duplicates.
   */
  function playable(tracks) {
    const seen = new Set();
    return tracks.filter(t => t && t.id && (!Store.mediaKind || Store.mediaKind(t) === "music") && !Store.isBlocked(t) && !seen.has(t.id) && seen.add(t.id));
  }
  function artistUploadLooksLikeMusic(track, query, channel) {
    if (!track || !Api.looksLikeMusic(track)) return false;
    const title = V.fold(track.title);
    // A matching uploader name, including the word Official, cannot establish
    // musical provenance. Require verification or evidence in the upload itself.
    const verifiedChannel = channel && channel.verified === true && track.artistId === channel.id;
    return track.artistVerified === true || !!verifiedChannel ||
      (" " + title + " ").includes(" " + V.fold(query) + " ");
  }

  // Cache only in memory. Repeating or retrying a request must not spend another AI
  // call, and transcripts must not become persisted listening history.
  const interpretations = new Map(), mixes = new Map();
  async function cached(cache, key, create) {
    const prior = cache.get(key);
    if (prior && Date.now() - prior.at < 10 * 60 * 1000) return prior.value;
    const entry = { at: Date.now(), value: Promise.resolve().then(create) };
    cache.set(key, entry);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    try { return await entry.value; }
    catch (e) { if (cache.get(key) === entry) cache.delete(key); throw e; }
  }
  function simpleRequest(raw, intent) {
    const q = intent.query;
    if (intent.kind === "playlist" && Store.playlists().some(p => V.fold(p.name) === V.fold(q))) return true;
    // Explicit qualifications, corrections and combinations need semantic parsing.
    // Keep short music titles intact, including titles containing 'love' or 'night'.
    if (/(?:^|\s)(?:אבל|בעצם|בלי|ללא|חוץ|רק|וגם|ואחר כך|משהו|שיהיה|but|except|without|only|instead|actually|something|and then)(?:\s|$)/i.test(raw)) return false;
    if (/^(?:that song|this song|השיר הזה|מה ששמעתי)/i.test(q)) return false;
    if (intent.kind === "liked") return true;
    // A parsed "newest song of X" resolves straight from the artist's channel feed; if that
    // name finds nothing, resolve() still retries through the model.
    if (intent.kind === "latest") return true;
    if (!q || q.split(/\s+/).length > 10) return false;
    return !/^(?:אני|בא לי|אפשר|i |can |could )/i.test(q);
  }
  function directMix(raw) {
    return /(?:^|\s)(?:משהו\s+(?:רגוע|שקט|קצבי)|מוזיקה\s+(?:רגועה|שקטה|קצבית|לריצה|לאימון|ללימודים)|something\s+(?:calm|relaxing|upbeat)|music\s+for\s+(?:studying|running|a workout))(?:\s|$)/i.test(raw) &&
      !/(?:ה?שיר|ה?פלייליסט|song|playlist)\s/i.test(raw);
  }

  // Resolving never changes playback. The view checks that this request is still
  // current before committing its queue, so Cancel also works during network calls.
  /**
   * Turns a request into the tracks to play. Never changes playback itself.
   * @param {string} request
   * @param {(status: string) => void} [onstatus] Progress text for the screen.
   * @param {() => boolean} [active] Returns false once the request was cancelled.
   * @param {PlaybackIntent} [interpreted] A reading already made by the model.
   * @returns {Promise<ResolvedRequest>}
   * @throws {Error} With a message to show, in Hebrew, when nothing was found.
   */
  async function resolve(request, onstatus, active, interpreted) {
    const isActive = active || (() => true);
    function check() { if (!isActive()) throw new Error("cancelled"); }
    const original = String(request || "").trim();
    if (!original) throw new Error(tr("צריך לומר או לכתוב מה לנגן."));
    const placement = playbackRequest(original);
    const raw = placement.action !== "play" ? placement.text : original;
    const hasAI = navigator.onLine !== false && window.Ai && Ai.hasAnyKey();
    let intent = interpreted || basicIntent(raw);
    if (placement.action !== "play") {
      const placed = musicIntent(raw);
      if (placed.kind !== "liked" && !placed.query) throw new Error(tr("איזה שיר להוסיף לתור? ציינו את שם השיר והאמן."));
    }
    const cacheKey = raw + JSON.stringify(Store.playlists().map(p => p.name));
    async function understand() {
      if (onstatus) onstatus(tr("מבין את הבקשה…"));
      try { return await cached(interpretations, cacheKey, () => Ai.interpretPlayback(raw)); }
      catch (e) { throw new Error(tr("לא הצלחתי להבין את הבקשה כרגע. בדקו את חיבור ה־AI בהגדרות ונסו שוב.")); }
    }
    let usedAI = !!interpreted;
    async function retryInterpretation() {
      if (!hasAI || usedAI) return null;
      const clarified = await understand();
      check();
      if (clarified.kind !== intent.kind || V.fold(clarified.query) !== V.fold(intent.query) ||
          V.fold(clarified.artist) !== V.fold(intent.artist)) return resolve(original, onstatus, active, clarified);
      return null;
    }
    if (!interpreted && hasAI && directMix(raw)) { intent = /** @type {PlaybackIntent} */ ({ kind: "mix", query: raw }); usedAI = true; }
    else if (!interpreted && hasAI && !simpleRequest(raw, intent)) { intent = await understand(); usedAI = true; }
    // A bare saved playlist or known artist name does not need an AI call.
    if (!usedAI && intent.kind === "song" && !intent.artist) {
      if (Store.playlists().some(p => V.fold(p.name) === V.fold(intent.query))) intent.kind = "playlist";
      else if (Store.library("music").some(t => V.fold(t.artist) === V.fold(intent.query)) ||
          Store.followsList().some(a => a.kind === "artist" && V.fold(a.name) === V.fold(intent.query))) intent.kind = "artist";
    }
    check();
    if (intent.kind === "clarify") throw new Error(intent.query || tr("איזה שיר, אמן או פלייליסט לנגן?"));
    if (onstatus) onstatus(tr("מחפש את המוזיקה שביקשת…"));
    let tracks = [], label = intent.query;
    const local = playable(Store.library("music").concat(Store.recents("music"), Player.queue()));
    if (intent.kind === "liked") {
      tracks = Store.likedTracks("music");
      label = tr("השירים שאהבתי");
    } else if (intent.kind === "playlist") {
      const playlist = uniqueMatch(named(Store.playlists(), intent.query, p => p.name), tr("יש כמה פלייליסטים בשם דומה. כתבו את השם המלא."));
      if (playlist) { tracks = Store.playlistTracks(playlist.id); label = playlist.name; }
      else {
        const result = await Api.searchPlaylists(intent.query);
        check();
        const match = uniqueMatch(named(result.items, intent.query, p => p.name), tr("מצאתי כמה פלייליסטים מתאימים. אמרו את השם המלא של הפלייליסט."));
        if (!match) {
          const retry = await retryInterpretation();
          if (retry) return retry;
          throw new Error(tr("לא מצאתי פלייליסט בשם הזה. נסו את השם המלא או שמרו אותו בספרייה."));
        }
        const info = await Api.getPlaylistInfo(match.id);
        tracks = info.tracks; label = info.name || match.name;
      }
    } else if (intent.kind === "artist") {
      const matches = local.filter(t => artistScore(t.artist, intent.query) > 0 && artistUploadLooksLikeMusic(t, intent.query));
      tracks = matches;
      if (navigator.onLine !== false) {
        const result = await Api.search(intent.query, true).catch(error => {
          if (tracks.length) return { items: [] };
          throw error;
        });
        check();
        // Fresh source metadata wins over an old record for the same video ID.
        const refreshed = new Set(result.items.map(t => t.id));
        const remote = playable(result.items.filter(t => artistScore(t.artist, intent.query) > 0 && artistUploadLooksLikeMusic(t, intent.query)));
        tracks = playable(remote.concat(tracks.filter(t => !refreshed.has(t.id))))
          .sort((a, b) => Number(b.artistVerified === true) - Number(a.artistVerified === true));
        V.log("artist search accepted " + remote.length + " of " + result.items.length + ", local " + (tracks.length - remote.length));
        if (!tracks.length) {
          const artists = await Api.searchArtists(intent.query);
          check();
          const seen = new Set();
          const candidates = artists.items.map(artist => ({ artist, score: artistScore(artist.name, intent.query) }))
            .filter(({ artist, score }) => score > 0 && artist.id && !seen.has(artist.id) && seen.add(artist.id))
            .sort((a, b) => Number(b.artist.verified === true) - Number(a.artist.verified === true) ||
              (Number(b.artist.subscribers) || 0) - (Number(a.artist.subscribers) || 0) || b.score - a.score);
          // Prefer provider verification and audience size, never "Official" in a
          // display name. Try alternatives if the channel has no eligible music.
          for (const { artist } of candidates.slice(0, 3)) {
            check();
            const info = await Api.getArtist(artist.id, artist).catch(() => ({ videos: [] }));
            check();
            // A channel endpoint can return recommendations or a stale response.
            // Check each upload instead of trusting the requested channel URL.
            tracks = playable((info.videos || []).filter(t =>
              (!t.artistId || t.artistId === artist.id) &&
              artistScore(t.artist, intent.query) > 0 && artistUploadLooksLikeMusic(t, intent.query, artist)))
              .map(t => artist.verified === true && t.artistId === artist.id ? { ...t, artistVerified: true } : t);
            V.log("artist channel " + artist.id + ", accepted " + tracks.length + " of " + (info.videos || []).length);
            if (tracks.length) { label = intent.query; break; }
          }
        }
      }
    } else if (intent.kind === "latest") {
      // The newest release by one artist. Its date is read from the feed YouTube publishes
      // for every channel - the one source still carrying exact upload times, newest first -
      // not from a relevance-ranked search, which orders by popularity and would hand back an
      // old hit for "the new song".
      let channelId = "", channel = null, trusted = false;
      const followed = Store.followsList().find(a => a.kind === "artist" && artistScore(a.name, intent.query) > 0);
      if (followed && followed.id) { channelId = followed.id; channel = followed; trusted = true; }
      // A name from the listening history is one the listener already plays - trusted the
      // same way a followed channel is, so its feed needs only the music test, not provenance.
      if (!channelId) { const known = Store.artistIdFor(intent.query); if (known) { channelId = known; trusted = true; } }
      if (!channelId && navigator.onLine !== false) {
        const found = await Api.searchArtists(intent.query);
        check();
        const seen = new Set();
        const best = found.items.map(a => ({ a, score: artistScore(a.name, intent.query) }))
          .filter(({ a, score }) => score > 0 && a.id && !seen.has(a.id) && seen.add(a.id))
          .sort((x, y) => Number(y.a.verified === true) - Number(x.a.verified === true) ||
            (Number(y.a.subscribers) || 0) - (Number(x.a.subscribers) || 0) || y.score - x.score)[0];
        if (best) { channelId = best.a.id; channel = best.a; trusted = best.a.verified === true; }
      }
      if (channelId && navigator.onLine !== false) {
        // On the artist's own channel an upload is a song unless something marks it otherwise:
        // this feed carries no durations for looksLikeMusic to weigh, so a plainly titled single
        // would be dropped without the relaxation. The relaxation still turns away every non-music
        // signal the app knows - a NOT_MUSIC title, a spoken-word clip (looksLikePodcast catches
        // interviews, panels, talks even at length zero) and a promo short or teaser - so the
        // newest of those never stands in for the newest song. A relevance match that is not
        // verified is not trusted that far and keeps the strict music test.
        const promo = /(?:^|[^\p{L}])(?:shorts?|teaser|snippet|preview|טיזר)(?![\p{L}])/iu;
        const isSong = t => Api.looksLikeMusic(t) || (trusted && Api.notMusic && !Api.notMusic(t) &&
          !(Api.looksLikePodcast && Api.looksLikePodcast(t)) && !promo.test(String((t && t.title) || "")));
        const feed = await Api.channelFeed(channelId).catch(() => []);
        check();
        tracks = playable(feed.filter(isSong)).sort((a, b) => (b.published || 0) - (a.published || 0));
        // The feed failed or held no song - fall back to the artist's catalog, which has
        // durations to judge by but no dependable order, so "newest" becomes best-effort.
        if (!tracks.length) {
          const data = await Api.getArtist(channelId, channel || undefined).catch(() => ({ videos: [] }));
          check();
          tracks = playable((data.videos || []).filter(t =>
            (!t.artistId || t.artistId === channelId) && Api.looksLikeMusic(t)))
            .sort((a, b) => (b.published || 0) - (a.published || 0));
        }
        // "The newest song" is one song. Playing it opens a queue that flows on into the rest of
        // the recent releases, but sending it next or to the end of the queue inserts just the
        // one - a whole channel's worth behind the current song is not what was asked.
        if (tracks.length && placement.action !== "play") tracks = tracks.slice(0, 1);
        if (tracks.length) label = tracks[0].title;
      }
    } else if (intent.kind === "song") {
      const matches = named(local, intent.query, t => t.title).filter(t => !intent.artist || artistScore(t.artist, intent.artist) > 0);
      // A saved cover with the same title must not become the default recording.
      // Once a performer is explicitly requested (or identified), a unique exact local
      // title/performer match can still play immediately without a network lookup.
      // A title that only contains the request may be another recording of it: a saved
      // "Song (Live)" is not what "play Song" asks for unless nothing else can be found.
      const plain = matches.filter(t => !otherVersion(t.title, intent.query));
      const track = intent.artist && plain.length === 1 ? plain[0]
        : await Api.matchTrack(intent.query, intent.artist, { original: true }) ||
          (intent.artist && matches.length === 1 ? matches[0] : null);
      tracks = track ? [track] : [];
      if (track) label = track.title;
    } else if (intent.kind === "mix") {
      const mix = intent.tracks && intent.tracks.length
        ? { name: intent.query, tracks: intent.tracks }
        : await cached(mixes, raw, () => Ai.generatePlaylist(raw, 20));
      check();
      // Small batches avoid flooding music sources while still resolving a mix promptly.
      label = mix.name;
      for (let i = 0; i < mix.tracks.length; i += 4) {
        check();
        const batch = await Promise.all(mix.tracks.slice(i, i + 4).map(t => Api.matchTrack(t.title, t.artist, { original: true })));
        tracks.push(...batch.filter(Boolean));
      }
    } else throw new Error(tr("לא הצלחתי להבין מה לנגן. נסו לציין שיר, אמן או פלייליסט."));
    check();
    tracks = playable(tracks);
    if (intent.kind === "artist" && tracks.some(t => t.artistVerified === true)) {
      tracks = tracks.filter(t => t.artistVerified === true);
    }
    if (!tracks.length && hasAI && !usedAI) {
      // A phonetic name or an ambiguous short request gets one interpretation only
      // after a direct lookup failed. Never call the model for a successful lookup.
      const retry = await retryInterpretation();
      if (retry) return retry;
    }
    if (!tracks.length) throw new Error(
      intent.kind === "latest" ? tr("לא מצאתי שיר חדש של \"") + intent.query + tr("\". נסו שם מדויק יותר של האמן.")
      : intent.kind === "song" && !intent.artist
      ? tr("לא מצאתי ביצוע מקורי מספיק ברור. הוסיפו את שם הזמר לבקשה") + (!hasAI ? tr(" או הגדירו מפתח AI לזיהוי המבצע.") : ".")
      : tr("לא נמצאו שירים זמינים לבקשה הזאת. נסו שם מדויק יותר ובדקו את החיבור."));
    V.log("resolved " + intent.kind + ", " + tracks.length + " tracks, first " + tracks[0].id);
    // A song request that resolved to several uploads is ambiguous; a list (liked
    // songs, a playlist, an artist) goes in next as a whole, in order.
    if (placement.action === "next" && tracks.length !== 1 && intent.kind === "song") throw new Error(tr("כדי להוסיף שיר הבא, ציינו שיר אחד ואת שם האמן."));
    return { tracks, label, action: placement.action };
  }
  window.Voice = {
    supported: () => !!V.speechCtor(), isListening: () => !!V.currentCapture, listen: V.listen, resolve,
    basicIntent, isCommand, reply: V.reply, stopReply: V.stopReply, repliesOn: V.repliesOn
  };
})();
