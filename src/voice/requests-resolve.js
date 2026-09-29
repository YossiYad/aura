(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.voice;
  // From an understood request to the tracks it asks for, and the public face of the module.
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
  });

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
    if (V.skipRequest(original)) return { tracks: [], label: "", action: "skip" };
    const placement = V.playbackRequest(original);
    const raw = placement.action !== "play" ? placement.text : original;
    const hasAI = navigator.onLine !== false && window.Ai && Ai.hasAnyKey();
    let intent = interpreted || V.basicIntent(raw);
    if (placement.action !== "play") {
      const placed = V.musicIntent(raw);
      if (placed.kind !== "liked" && !placed.query) throw new Error(tr("איזה שיר להוסיף לתור? ציינו את שם השיר והאמן."));
    }
    // A verb and nothing after it - a pause right after "תשים לי" - names nothing to look
    // for. Searching for the empty string only failed slowly, or matched an artist with no
    // name in the library.
    if (!interpreted && intent.kind !== "liked" && !intent.query) throw new Error(tr("איזה שיר, אמן או פלייליסט לנגן?"));
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
      // A reading that only adds other spellings of the same performer is still news: the
      // spoken name found no channel, and those are what the channel may be called. The
      // names already looked up are not looked up again on the second pass.
      if (clarified.kind !== intent.kind || V.fold(clarified.query) !== V.fold(intent.query) ||
          V.fold(clarified.artist) !== V.fold(intent.artist) ||
          V.performerNames(clarified).length > V.performerNames(intent).length) {
        const again = clarified.kind === intent.kind ? { ...clarified, tried: V.performerNames(intent) } : clarified;
        return resolve(original, onstatus, active, again);
      }
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
    const local = V.playable(Store.library("music").concat(Store.recents("music"), Player.queue()));
    /**
     * Every playable upload by the performer called `name`: the saved and recent ones, the
     * ones a search turns up, and failing those, the uploads of the performer's own channel.
     * @param {string} name
     * @returns {Promise<Track[]>}
     */
    async function artistTracks(name) {
      let found = local.filter(t => V.artistScore(t.artist, name) > 0 && V.artistUploadLooksLikeMusic(t, name));
      if (navigator.onLine === false) return found;
      const result = await Api.search(name, true).catch(error => {
        if (found.length) return { items: [] };
        throw error;
      });
      check();
      // Fresh source metadata wins over an old record for the same video ID.
      const refreshed = new Set(result.items.map(t => t.id));
      const remote = V.playable(result.items.filter(t => V.artistScore(t.artist, name) > 0 && V.artistUploadLooksLikeMusic(t, name)));
      found = V.playable(remote.concat(found.filter(t => !refreshed.has(t.id))))
        .sort((a, b) => Number(b.artistVerified === true) - Number(a.artistVerified === true));
      V.log("artist search for " + name + " accepted " + remote.length + " of " + result.items.length + ", local " + (found.length - remote.length));
      if (found.length) return found;
      const artists = await Api.searchArtists(name);
      check();
      const seen = new Set();
      const candidates = artists.items.map(artist => ({ artist, score: V.artistScore(artist.name, name) }))
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
        found = V.playable((info.videos || []).filter(t =>
          (!t.artistId || t.artistId === artist.id) &&
          V.artistScore(t.artist, name) > 0 && V.artistUploadLooksLikeMusic(t, name, artist)))
          .map(t => artist.verified === true && t.artistId === artist.id ? { ...t, artistVerified: true } : t);
        V.log("artist channel " + artist.id + ", accepted " + found.length + " of " + (info.videos || []).length);
        if (found.length) return found;
      }
      return [];
    }
    if (intent.kind === "liked") {
      tracks = Store.likedTracks("music");
      label = tr("השירים שאהבתי");
    } else if (intent.kind === "playlist") {
      const playlist = V.uniqueMatch(V.named(Store.playlists(), intent.query, p => p.name), tr("יש כמה פלייליסטים בשם דומה. כתבו את השם המלא."));
      if (playlist) { tracks = Store.playlistTracks(playlist.id); label = playlist.name; }
      else {
        const result = await Api.searchPlaylists(intent.query);
        check();
        const match = V.uniqueMatch(V.named(result.items, intent.query, p => p.name), tr("מצאתי כמה פלייליסטים מתאימים. אמרו את השם המלא של הפלייליסט."));
        if (!match) {
          const retry = await retryInterpretation();
          if (retry) return retry;
          throw new Error(tr("לא מצאתי פלייליסט בשם הזה. נסו את השם המלא או שמרו אותו בספרייה."));
        }
        const info = await Api.getPlaylistInfo(match.id);
        tracks = info.tracks; label = info.name || match.name;
      }
    } else if (intent.kind === "artist") {
      // The spoken name first, then the other spellings the model knows the performer by:
      // an Israeli singer's channel is often named in Latin letters while the request
      // came in Hebrew, and the name test above would turn every upload away.
      for (const name of V.performerNames(intent)) {
        tracks = await artistTracks(name);
        if (tracks.length) break;
      }
    } else if (intent.kind === "latest") {
      // The newest release by one artist. Its date is read from the feed YouTube publishes
      // for every channel - the one source still carrying exact upload times, newest first -
      // not from a relevance-ranked search, which orders by popularity and would hand back an
      // old hit for "the new song".
      let channelId = "", channel = null, trusted = false;
      const followed = Store.followsList().find(a => a.kind === "artist" && V.artistScore(a.name, intent.query) > 0);
      if (followed && followed.id) { channelId = followed.id; channel = followed; trusted = true; }
      // A name from the listening history is one the listener already plays - trusted the
      // same way a followed channel is, so its feed needs only the music test, not provenance.
      if (!channelId) { const known = Store.artistIdFor(intent.query); if (known) { channelId = known; trusted = true; } }
      // The spoken name first, then the other spellings the model knows the performer by.
      for (const name of V.performerNames(intent)) {
        if (channelId || navigator.onLine === false) break;
        const found = await Api.searchArtists(name);
        check();
        const seen = new Set();
        const best = found.items.map(a => ({ a, score: V.artistScore(a.name, name) }))
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
        tracks = V.playable(feed.filter(isSong)).sort((a, b) => (b.published || 0) - (a.published || 0));
        // The feed failed or held no song - fall back to the artist's catalog, which has
        // durations to judge by but no dependable order, so "newest" becomes best-effort.
        if (!tracks.length) {
          const data = await Api.getArtist(channelId, channel || undefined).catch(() => ({ videos: [] }));
          check();
          tracks = V.playable((data.videos || []).filter(t =>
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
      const matches = V.named(local, intent.query, t => t.title).filter(t => !intent.artist || V.artistScore(t.artist, intent.artist) > 0);
      // A saved cover with the same title must not become the default recording.
      // Once a performer is explicitly requested (or identified), a unique exact local
      // title/performer match can still play immediately without a network lookup.
      // A title that only contains the request may be another recording of it: a saved
      // "Song (Live)" is not what "play Song" asks for unless nothing else can be found.
      const plain = matches.filter(t => !V.otherVersion(t.title, intent.query));
      // Exact, as the comment above promises: "Hello, Goodbye" contains "Hello" and is not
      // it. A request that names the version itself ("... live") may match a longer title.
      const exact = t => V.fold(t.title) === V.fold(intent.query) || V.VERSION_WORDS.some(word => (" " + V.fold(intent.query) + " ").includes(" " + word + " "));
      const track = intent.artist && plain.length === 1 && exact(plain[0]) ? plain[0]
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
    tracks = V.playable(tracks);
    if (intent.kind === "artist" && tracks.some(t => t.artistVerified === true)) {
      tracks = tracks.filter(t => t.artistVerified === true);
    }
    // "A song by X" means any song by X. Search ranks the same hit first every time, so
    // the whole list is dealt out at random - nothing is remembered between requests,
    // the order is simply different each time.
    if (intent.kind === "artist") tracks = V.shuffled(tracks);
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
    basicIntent: V.basicIntent, isCommand: V.isCommand, reply: V.reply, stopReply: V.stopReply, repliesOn: V.repliesOn
  };
})();
