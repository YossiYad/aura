(function () {
  const V = window.Aura.api;
  // Published on V for the other files of this module; see src/api.js.
  Object.defineProperties(V, {
    findVersions: { get: () => findVersions },
    looksLikeMusic: { get: () => looksLikeMusic },
    notMusic: { get: () => notMusic }
  });

  // Words that say "this is something to watch", in Hebrew and English. Kept to markers
  // that name the format rather than the subject, so an ordinary song keeps passing.
  const NOT_MUSIC = ["מערכון", "פרק מלא", "ראיון", "פודקאסט", "סטנד אפ", "סטנדאפ", "טריילר",
    "כתבה", "הרצאה", "חדשות", "מבזק", "וידאו בלוג", "משחק",
    "sketch", "full episode", "interview", "podcast", "trailer", "review", "reaction",
    "vlog", "documentary", "tutorial", "gameplay", "walkthrough", "highlights",
    "compilation", "prank", "unboxing", "stand up", "standup", "behind the scenes",
    "explained", "news", "recap"];
  const IS_MUSIC = ["official video", "official audio", "official music video", "lyric video",
    "audio oficial", "קליפ", "רשמי", "שיר"];

  // Radio and recommendations pull from a video's related list, which for anything that is
  // not a song is full of more things to watch. This keeps those out of the queue.
  /**
   * @param {Track | null | undefined} track
   * @returns {boolean}
   */
  function looksLikeMusic(track) {
    if (!track) return false;
    // Classify the upload, not words such as Official/Topic in its uploader name.
    // Even verified music channels can publish interviews and other non-music clips.
    const hay = V.normMatch(track.title);
    for (const word of NOT_MUSIC) {
      if (V.hasWord(hay, word)) return false;
    }
    for (const word of IS_MUSIC) {
      if (V.hasWord(hay, word)) return true;
    }
    // Nothing either way: fall back to length. Songs sit in a much narrower band than
    // the clips, episodes and compilations that share a related list with them.
    const secs = track.duration || 0;
    return secs >= 75 && secs <= 600;
  }

  // True only when the title itself names the upload as something other than music - an
  // interview, a trailer, a vlog. Unlike looksLikeMusic, an upload it cannot place comes back
  // false, not "not music": on an artist's own channel feed, which carries no durations to
  // weigh, that is what lets a plainly titled single through while still turning away the
  // non-music the artist also posts.
  /**
   * @param {Track | null | undefined} track
   * @returns {boolean} True only when the title names the upload as something other than music.
   */
  function notMusic(track) {
    const hay = V.normMatch(track && track.title);
    return NOT_MUSIC.some(word => V.hasWord(hay, word));
  }

  // Automatic matching gets it wrong sometimes - a live take, the wrong upload, bad audio.
  // Rather than leave the listener stuck with it, offer the other results for the same
  // song so they can switch, the way Spotube's sibling tracks sheet does.
  /**
   * Other uploads of the same song, best match first.
   * @param {Track} track
   * @returns {Promise<Track[]>}
   */
  async function findVersions(track) {
    const title = String((track && track.title) || "").replace(/\s*[([][^)\]]*[)\]]\s*/g, " ").trim();
    const artist = String((track && track.artist) || "").replace(/\s*-\s*topic\s*$/i, "").trim();
    if (!title) return [];
    const res = await V.search((title + " " + artist).trim(), true);
    return (res.items || [])
      .filter(t => t.id !== (track && track.id) && t.duration > 45 && t.duration < 1800)
      .map(t => ({ t, score: V.scoreMatch(t, title, artist).score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(x => x.t);
  }
})();
