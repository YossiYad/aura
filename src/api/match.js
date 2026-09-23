(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    coverage: { get: () => coverage },
    hasWord: { get: () => hasWord },
    matchTokens: { get: () => matchTokens },
    matchTrack: { get: () => matchTrack },
    normMatch: { get: () => normMatch },
    scoreMatch: { get: () => scoreMatch }
  });

  function normMatch(s) {
    return String(s || "").toLowerCase().replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, "")
      .replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  }

  // Words that mark a different recording of the same song. Only counted against a
  // candidate when the request did not ask for them - searching for a live version
  // should still find one.
  const OTHER_VERSION = ["live", "cover", "remix", "karaoke", "instrumental", "reaction",
    "nightcore", "mashup", "sped up", "slowed", "reverb", "8d", "loop", "tutorial",
    "teaser", "trailer", "acapella", "concert", "shorts"];
  // "ft" and "feat" mean the same thing, and neither says anything about which
  // recording this is, so they should not decide a match either way.
  const MATCH_STOPWORDS = ["official", "video", "audio", "music", "hd", "hq", "lyric",
    "lyrics", "ft", "feat", "featuring", "the", "a"];

  function matchTokens(s) {
    return normMatch(s).split(" ").filter(w => w && MATCH_STOPWORDS.indexOf(w) === -1)
      // Speech and catalogues differ on full/defective Hebrew spelling (בשמים /
      // בשמיים, איל / אייל). Normalize doubled vowel letters only within Hebrew.
      .map(w => /^[א-ת]+$/.test(w) ? w.replace(/([יו])\1+/g, "$1") : w);
  }

  function coverage(wanted, found) {
    if (!wanted.length) return 1;
    const have = new Set(found);
    return wanted.filter(w => have.has(w)).length / wanted.length;
  }

  // Ranks a search result against the track actually being looked for, rather than
  // trusting whatever the source happened to return first.
  function scoreMatch(candidate, wantTitle, wantArtist) {
    const candTitle = matchTokens(candidate.title);
    const candArtist = matchTokens(candidate.artist);
    const titleScore = coverage(matchTokens(wantTitle), candTitle.concat(candArtist));
    const wantedArtist = matchTokens(wantArtist);
    const artistScore = wantedArtist.length
      ? Math.max(coverage(wantedArtist, candArtist), coverage(wantedArtist, candTitle))
      : 1;
    let score = titleScore * 3 + artistScore * 2;
    const asked = normMatch(wantTitle + " " + wantArtist);
    const got = normMatch(candidate.title + " " + candidate.artist);
    let other = 0;
    for (const word of OTHER_VERSION) {
      if (hasWord(got, word) && !hasWord(asked, word)) { score -= 1.5; other++; }
    }
    // YouTube generates "<artist> - Topic" channels for the official audio: no intro,
    // no video, correct length. Worth a nudge when it shows up.
    if (/ topic$/.test(normMatch(candidate.artist))) score += 1;
    // Tie-breaker only - enough to separate the canonical upload from a reupload.
    if (candidate.views > 0) score += Math.min(0.5, Math.log10(candidate.views) / 20);
    return { score, title: titleScore, artist: artistScore, other,
      performer: wantedArtist.length > 0 && coverage(wantedArtist, candArtist) === 1 };
  }

  // Whole-word presence: "session" is not in "obsession", and סט is not in היסטוריה.
  function hasWord(hay, word) {
    const w = normMatch(word);
    return !!w && (" " + hay + " ").indexOf(" " + w + " ") !== -1;
  }

  function voiceMatchCandidates(items, title, artist) {
    const asked = " " + normMatch(title) + " ";
    const versions = OTHER_VERSION.concat(["קאבר", "קריוקי", "רמיקס", "בהופעה", "הופעה חיה", "חידוש"]);
    const contains = (text, word) => (" " + normMatch(text) + " ").includes(" " + word + " ");
    const hasCover = t => ["cover", "קאבר", "חידוש"].some(w => contains(t.title, w));
    const wanted = matchTokens(artist);
    let candidates = items.filter(t => {
      const samePerformer = wanted.length && coverage(wanted, matchTokens(t.artist)) === 1;
      if (versions.some(w => contains(t.title, w) && !asked.includes(" " + w + " ") &&
          !(samePerformer && ["cover", "קאבר", "חידוש"].includes(w)))) return false;
      if (wanted.length && !samePerformer && (hasCover(t) || coverage(wanted, matchTokens(t.title)) < 1)) return false;
      return scoreMatch(t, title, artist).title >= 0.8;
    });
    if (!wanted.length) {
      // Metadata cannot prove recording provenance. Prefer official releases; if
      // several performers plausibly own this title, ask the request interpreter.
      // A verified channel is the performer's own even when its title carries no
      // marker word, so a plain "Song" on it is not passed over for a reupload.
      candidates = candidates.filter(t => t.artistVerified === true || /(?: topic|vevo)$/.test(normMatch(t.artist)) ||
        /official (?:music |lyric )?(?:video|audio)|קליפ רשמי/.test(normMatch(t.title)));
      const performers = new Set(candidates.map(t => normMatch(t.artist).replace(/(?: topic|vevo| official)+$/g, "").trim()));
      if (performers.size !== 1) return [];
    }
    return candidates;
  }

  /**
   * Finds the upload of a song named by title and artist.
   * @param {string} title
   * @param {string} [artist]
   * @param {{ original?: string }} [options] `original` is the spoken request, for voice search.
   * @returns {Promise<Track | null>} Null rather than a doubtful match.
   */
  async function matchTrack(title, artist, options) {
    const q = encodeURIComponent((title + " " + (artist || "")).trim());
    const inst = await V.instances();
    let res = null;
    try {
      res = await V.raceOk(
        V.prioritize(inst.piped, inst.lastGood, "search").slice(0, 6).map(b => V.searchPipedOne(b, q))
          .concat(V.prioritize(inst.invidious, inst.lastGood, "search").slice(0, 6).map(b => V.searchInvidiousOne(b, q)))
      );
    } catch (e) {
      if (window.Log && options && options.original) Log.add("match", "voice search failed before results");
      return null;
    }
    let items = res.items.filter(t => t.duration > 45 && t.duration < 1200);
    const durationCount = items.length;
    const voice = !!(options && options.original);
    if (voice) items = voiceMatchCandidates(items, title, artist);
    const wantedKnown = matchTokens(artist || "").length > 0;
    let best = null;
    for (const item of items) {
      const scored = scoreMatch(item, title, artist);
      // A live, karaoke or cover upload by someone other than the performer asked for
      // is another recording, not a lower-scored match for the import.
      if (!voice && scored.other && wantedKnown && !scored.performer) continue;
      if (!best || scored.score > best.score) best = { item, score: scored.score, title: scored.title, artist: scored.artist };
    }
    if (window.Log && options && options.original) {
      Log.add("match", "voice candidates " + res.items.length + ", duration " + durationCount +
        ", accepted " + items.length + (best ? ", selected " + best.item.id + ", title " + best.title.toFixed(2) : ", no match"));
    }
    // No plausible candidate is a better answer than the wrong song: an import reports
    // the track as not found instead of quietly filling the playlist with a cover.
    if (!best || best.title < 0.5 || best.score < 1.5) return null;
    // With a performer named, a title alone is not enough: "Hello" by Lionel Richie is
    // not "Hello" by Adele, however well the title matches.
    if (!voice && wantedKnown && !(best.artist > 0)) return null;
    return best.item;
  }
})();
