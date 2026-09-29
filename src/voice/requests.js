(function () {
  const V = window.Aura.voice;
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
    artistScore: { get: () => artistScore },
    artistUploadLooksLikeMusic: { get: () => artistUploadLooksLikeMusic },
    basicIntent: { get: () => basicIntent },
    isCommand: { get: () => isCommand },
    skipRequest: { get: () => skipRequest },
    musicIntent: { get: () => musicIntent },
    named: { get: () => named },
    otherVersion: { get: () => otherVersion },
    performerNames: { get: () => performerNames },
    playable: { get: () => playable },
    playbackRequest: { get: () => playbackRequest },
    shuffled: { get: () => shuffled },
    uniqueMatch: { get: () => uniqueMatch },
    VERSION_WORDS: { get: () => VERSION_WORDS }
  });

  // Understanding a request: the commands and the "play next" and "add" wording are read
  // here without a model, the rest goes to Ai.interpretPlayback when online with a key, and
  // resolve() looks the result up and returns the tracks without touching playback.
  function clean(value) {
    const courtesy = /(?:\s+|^)(?:בבקשה|תודה(?:\s+רבה)?|please|thank\s+you|thanks)$/i;
    return String(value || "").trim().replace(/\u2019/g, "'").replace(/[.!?…,;]+$/g, "")
      .replace(courtesy, "").replace(/[.!?…,;]+$/g, "").trim();
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
    const appendPrefix = /^((?:(?:בבקשה|אפשר|please|can you|could you)\s+)?(?:תוסיף|תוסיפי|הוסף|הוסיפי|תצרף|תצרפי|צרף|צרפי|תשים|תשימי|שים|שימי|add|append)(?:\s+לי)?\s+)(?:(?:לסוף|בסוף)\s+ה?תור|ל(?:ה?תור)|to\s+(?:the\s+)?(?:end\s+of\s+the\s+)?queue)\s+/i;
    if (appendPrefix.test(text)) { text = text.replace(appendPrefix, "$1").trim(); action = "append"; }
    // Match placement at the edges of a request, so titles like Next to Me
    // and The Next Episode keep their names. Song lookup receives only the title.
    const suffix = /\s+(?:(?:שיהיה\s+)?(?:בתור\s+(?:ה?שיר\s+)?|כ(?:ה?שיר\s+)?|לשיר\s+)הבא|שיהיה\s+(?:ה?שיר\s+)?הבא|אחרי\s+השיר\s+(?:הזה|הנוכחי)|(?:up\s+)?next|as\s+the\s+next\s+song)[.!?…]*$/i;
    if (suffix.test(text)) { text = text.replace(suffix, "").trim(); action = "next"; }
    const prefix = /^((?:(?:בבקשה|אפשר|please|can you|could you)\s+)?(?:תשים|תשימי|שים|שימי|תפעיל|תפעילי|הפעל|תנגן|תנגני|נגן|תשמיע|תשמיעי|השמע|תוסיף|תוסיפי|הוסף|הוסיפי|play|put on|queue|enqueue)(?:\s+לי)?\s+)(?:את\s+)?(?:(?:בתור\s+(?:ה?שיר\s+)?|כ(?:ה?שיר\s+)?)הבא|ה?שיר\s+הבא|next(?=\s+(?:the\s+)?song\s))(?:\s+|$)/i;
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
  // "Next", "skip", "השיר הבא": the one request that names no music at all. Read before
  // the parsers below, which would go looking for a song called "next song".
  function skipRequest(request) {
    const text = clean(V.requestStart(request))
      .replace(/^(?:(?:היי|אורה|בבקשה|אפשר|אתה יכול|את יכולה|can you|could you|please)\s+)+/i, "");
    return /^(?:(?:play|put on|go to|skip to|תשים|תשימי|שים|שימי|תפעיל|תפעילי|תנגן|תנגני|נגן|תעבור|תעברי|עבור|עברי)\s+(?:לי\s+)?(?:את\s+)?)?(?:(?:the\s+)?next(?:\s+(?:song|track|one))?|(?:ל?ה?שיר\s+)?הבא|skip(?:\s+(?:this|it|this\s+(?:song|track|one)|the\s+(?:song|track)))?|תדלג|תדלגי|דלג|דלגי)$/i.test(text);
  }
  function isCommand(request) {
    if (skipRequest(request)) return true;
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
        (m = /^(.+?)(?:'s|')?\s+(?:new|newest|latest|last|most\s+recent)\s+(?:song|single|track|release)$/i.exec(q)))
      return { kind: "latest", query: clean(m[1]), artist: "" };
    q = q.replace(/^(?:ה?שיר|(?:the )?song)\s+/i, "");
    // The last "by", not the first: titles carry one of their own ("Stand by Me", "ילדה של
    // אבא"), and a performer's name almost never does.
    if ((m = /^(.+)\s+(?:של|by)\s+(.+)$/i.exec(q))) return { kind: "song", query: clean(m[1]), artist: clean(m[2]) };
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
  /**
   * The names to look a performer up by: the one the listener said, then any other spellings
   * the model supplied, each once, leaving out any a first pass already looked up.
   * @param {{ query: string, names?: string[], tried?: string[] }} intent
   * @returns {string[]}
   */
  function performerNames(intent) {
    const seen = new Set((Array.isArray(intent.tried) ? intent.tried : []).map(V.fold)), out = [];
    for (const name of [intent.query].concat(Array.isArray(intent.names) ? intent.names : [])) {
      const key = V.fold(name);
      if (key && !seen.has(key)) { seen.add(key); out.push(String(name).trim()); }
    }
    return out;
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
  /**
   * A copy of the list in random order (Fisher-Yates), so an artist request does not open
   * with the same song every time.
   * @template T
   * @param {T[]} items
   * @returns {T[]}
   */
  function shuffled(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
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

})();
