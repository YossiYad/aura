(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    activeGain: { get: () => activeGain, set: value => { activeGain = value; } },
    applyRate: { get: () => applyRate },
    gainFor: { get: () => gainFor },
    levelled: { get: () => levelled },
    localGain: { get: () => localGain },
    noteStreamLoudness: { get: () => noteStreamLoudness },
    rate: { get: () => rate },
    RATE_CHOICES: { get: () => RATE_CHOICES },
    setRate: { get: () => setRate },
    setVolume: { get: () => setVolume }
  });

  // Uploads sit up to 10dB apart, so one track blasts after a quiet one and the volume
  // slider becomes a per-track control. YouTube reports how far each upload is from its
  // reference level; attenuating the loud ones evens them out. Doing this with the element
  // volume rather than a Web Audio graph is deliberate: createMediaElementSource on a
  // cross-origin stream silences it permanently, and these streams are cross-origin.
  let activeGain = 1;

  // The loudness a stream reported, kept per track so a copy played from the cache or
  // a download is levelled like the stream it was taken from, rather than at full gain.
  const STREAM_LOUDNESS_KEY = "aura.streamLoudness";
  let streamLoudness = null;
  function loadStreamLoudness() {
    if (streamLoudness) return streamLoudness;
    streamLoudness = {};
    try {
      const raw = JSON.parse(localStorage.getItem(STREAM_LOUDNESS_KEY) || "{}");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) streamLoudness = raw;
    } catch (e) {}
    return streamLoudness;
  }
  function noteStreamLoudness(id, loudnessDb) {
    const db = parseFloat(loudnessDb);
    if (id && !isNaN(db)) {
      const map = loadStreamLoudness();
      delete map[id];
      map[id] = db;
      const keys = Object.keys(map);
      if (keys.length > 300) delete map[keys[0]];
      try { localStorage.setItem(STREAM_LOUDNESS_KEY, JSON.stringify(map)); } catch (e) {}
    }
    return loudnessDb;
  }
  function localGain(id) {
    const db = loadStreamLoudness()[id];
    return db == null ? 1 : gainFor(db);
  }

  function gainFor(loudnessDb) {
    if (Store.settings().normalize === false) return 1;
    const db = parseFloat(loudnessDb);
    if (isNaN(db) || db <= 0) return 1;
    return Math.max(0.25, Math.min(1, Math.pow(10, -db / 20)));
  }

  function levelled(factor) {
    return Math.max(0, Math.min(1, V.volume * activeGain * (factor == null ? 1 : factor)));
  }

  /**
   * @param {number} v 0 to 1.
   */
  function setVolume(v) {
    V.volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem("aura.volume", String(V.volume)); } catch (e) {}
    V.audio.volume = levelled();
    if (V.yt && V.ytReady) { try { V.yt.setVolume(Math.round(v * 100)); } catch (e) {} }
  }

  // A 90 minute episode at 1.5x is an hour, which is the whole reason this exists - and why
  // it is remembered across sessions rather than reset per track. Applied to both elements,
  // not only the one playing: the track prepared in the background for a crossfade would
  // otherwise drop back to 1x the moment it takes over. preservesPitch keeps a voice
  // sounding like the person it belongs to instead of a chipmunk.
  const RATE_CHOICES = [0.75, 1, 1.25, 1.5, 1.75, 2];

  /**
   * @returns {number} Playback speed; always 1 while casting.
   */
  function rate() {
    if (V.audio.isCast) return 1;
    const r = parseFloat(String(Store.settings().playbackRate));
    return RATE_CHOICES.indexOf(r) === -1 ? 1 : r;
  }

  function applyRate(el) {
    const r = rate();
    (el ? [el] : [V.audioA, V.audioB]).forEach(target => {
      try {
        if ("preservesPitch" in target) target.preservesPitch = true;
        target.playbackRate = r;
      } catch (e) {}
    });
    if (!el && V.yt && V.ytReady) { try { V.yt.setPlaybackRate(r); } catch (e) {} }
  }

  /**
   * @param {number} v One of the speeds in rateChoices(); anything else becomes 1.
   * @returns {number} The speed applied.
   */
  function setRate(v) {
    if (V.audio.isCast) {
      V.emit({ type: "remote-error", message: "Playback speed is controlled by the TV while casting." });
      return 1;
    }
    const value = RATE_CHOICES.indexOf(v) === -1 ? 1 : v;
    Store.patchSettings({ playbackRate: value });
    applyRate();
    V.updatePositionState();
    V.emit({ type: "rate", rate: value });
    return value;
  }
})();
