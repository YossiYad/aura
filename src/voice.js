// Types for the Voice module. Declared outside the closure so the editor sees them from
// any file; comments only, nothing at runtime.

/**
 * @typedef {Object} ListenOptions
 * @property {string} [lang] Recognition language, e.g. "he-IL".
 * @property {boolean} [settle] Let the iOS audio session settle first, after playback.
 * @property {Promise<void> | null} [released] Settles once the player's audio has been let go;
 *   the microphone waits for it.
 * @property {(active: boolean) => void} [onlistening] Whether speech is being heard.
 * @property {() => void} [onrecover] The recognizer stopped early and is being restarted.
 * @property {(text: string, final: boolean) => void} [ontext] The transcript so far.
 * @property {() => void} [onfinishing] Silence was heard; the transcript is being closed.
 * @property {(text: string) => void} onfinish The final transcript.
 * @property {(code: string, text: string) => void} onerror
 */

/**
 * A request parsed without the model.
 * @typedef {Object} VoiceIntent
 * @property {"song" | "artist" | "latest" | "playlist" | "liked"} kind
 * @property {string} query
 * @property {string} artist
 * @property {"play" | "next" | "append"} action Replace the queue, play next, or add at the end.
 */

/**
 * @typedef {Object} ResolvedRequest
 * @property {Track[]} tracks
 * @property {string} label What to call the result on screen.
 * @property {"play" | "next" | "append" | "skip"} action Skip names no music: the queue moves on.
 * @property {string} [playlist] Id of the listener's own playlist the tracks were taken from, if they were.
 */

(function () {
  // Voice is one module in two files: this one is the speech itself - the microphone and
  // its transcript, and the spoken reply, with the iOS audio-session care both need - and
  // src/voice/requests.js, loaded after it, turns what was said into tracks to play and
  // holds the module's public face, window.Voice. Each file is its own closure and reaches
  // the other through V, window.Aura.voice, where this file publishes, at its top, the
  // names the other uses.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).voice = {};
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
    afterRelease: { get: () => afterRelease },
    canRecord: { get: () => canRecord },
    captureCount: { get: () => captureCount, set: value => { captureCount = value; } },
    currentCapture: { get: () => currentCapture, set: value => { currentCapture = value; } },
    DEAD_MS: { get: () => DEAD_MS },
    DEAD_SECONDS: { get: () => DEAD_SECONDS },
    fold: { get: () => fold },
    isIOS: { get: () => isIOS },
    lastSpokeAt: { get: () => lastSpokeAt, set: value => { lastSpokeAt = value; } },
    log: { get: () => log },
    METER_RATE: { get: () => METER_RATE },
    MICROPHONES: { get: () => MICROPHONES },
    playerState: { get: () => playerState },
    recognizerRan: { get: () => recognizerRan, set: value => { recognizerRan = value; } },
    repliesOn: { get: () => repliesOn },
    requestStart: { get: () => requestStart },
    SLICE_MS: { get: () => SLICE_MS },
    speechCtor: { get: () => speechCtor },
    transcriptParts: { get: () => transcriptParts },
    VOICE_MAX: { get: () => VOICE_MAX },
    VOICE_MIN: { get: () => VOICE_MIN }
  });

  function speechCtor() { return window.SpeechRecognition || window.webkitSpeechRecognition; }
  function log(message) { if (window.Log) window.Log.add("voice", message); }
  // What the player is holding when the mic opens, for the WebKit 321436 deafness hunt:
  // if the mic goes deaf with src false and kick suspended, no JS teardown can free it.
  function playerState() {
    try { return window.Player && window.Player.captureState ? JSON.stringify(window.Player.captureState()) : "no-player"; }
    catch (e) { return "err"; }
  }
  // The open capture's cancel, and how many captures this page has opened: each one is
  // numbered in the log, so the lines of one request can be told from the next one's.
  let currentCapture = null, captureCount = 0;
  // When a spoken reply last ended. A recognition opened soon after playback can go
  // deaf on iOS (WebKit bug 321436), so listen() settles the audio session first.
  let lastSpokeAt = 0;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  // On iOS the built-in recognizer heard only the first request of a page load: every later
  // one reported audio start and received nothing, on new and reused recognizers and after
  // every audio-session reset. The page's own microphone, opened the default way, delivered
  // nothing either - until a capture without voice processing had run first (MICROPHONES).
  // So once the recognizer has run, an iPhone opens each later request's microphone that way
  // and records it (record), and the recognizer listens alongside once the microphone
  // delivers. Its words are the request; only when it heard nothing is the recording
  // transcribed, with the Groq or Gemini key from Settings.
  let recognizerRan = false;
  function canRecord() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  // Spoken replies use speechSynthesis, which on iOS leaves WebKit unable to feed the next
  // recognition (WebKit bug 321436): speaking a reply deafens the very next voice request.
  // So default replies off on iOS and on elsewhere; the Spoken replies setting overrides.
  /**
   * @returns {boolean} Whether answers are spoken aloud.
   */
  function repliesOn() {
    const setting = Store.settings().voiceReply;
    return setting == null ? !isIOS : setting;
  }

  /**
   * @param {string} value
   * @returns {string} The request with a repeated opening verb ("play play ...") said once.
   */
  function requestStart(value) {
    // Only deduplicate the invocation at the beginning, never words in a title.
    return String(value || "").trim().replace(/^(תשים|תשימי|שים|שימי|תפעיל|תפעילי|תנגן|תנגני|נגן|תשמיע|תשמיעי|play|put on)(?:[\s,]+\1)+(?=\s)/i, "$1");
  }

  /**
   * @param {*} value
   * @returns {string} Folded for comparison, with punctuation removed.
   */
  function fold(value) {
    return Store.foldText(String(value || "")).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  function transcriptParts(parts) {
    const merged = [];
    for (const part of parts) {
      if (!part.text) continue;
      const previous = merged[merged.length - 1];
      const before = previous && fold(previous.text), next = fold(part.text);
      // Some recognizers append growing hypotheses as separate results, sometimes
      // even marking them final. Collapse that prefix chain, not repeated words
      // inside a song title or independent, identical final utterances.
      const extendsPrevious = before && next.startsWith(before + " ");
      const repeatsHypothesis = before && next === before && (!previous.final || previous.growing);
      if (extendsPrevious || repeatsHypothesis) {
        merged[merged.length - 1] = { ...part, growing: previous.growing || extendsPrevious };
      } else merged.push({ ...part });
    }
    return merged;
  }

  // The microphone opens only once the player's audio context has closed (see
  // Player.releaseForVoice): one still closing leaves an iPhone's capture as silent as a
  // live one. Bounded, so a close that never completes cannot hold the request.
  function afterRelease(released, trace, next) {
    if (!released || typeof released.then !== "function") { next(); return; }
    const began = Date.now();
    let done = false;
    const go = outcome => {
      if (done) return;
      done = true;
      clearTimeout(bound);
      trace("player audio " + outcome + " after " + (Date.now() - began) + "ms");
      next();
    };
    const bound = setTimeout(() => go("still closing"), 2000);
    released.then(() => go("released"), () => go("release failed"));
  }

  // The meter counts a voice at three times the room's own level, learned over the first
  // half second - no stricter than someone speaking close to the phone (VOICE_MAX), and
  // never down in the noise of a quiet room (VOICE_MIN), so a softer voice or a phone in a
  // car mount is still heard.
  const VOICE_MIN = 0.015, VOICE_MAX = 0.045;
  // Levels come from decoding what has been recorded so far in an offline context, which
  // never touches the audio hardware. A live context would: on an iPhone even a suspended
  // one left the microphone silent, and WebKit gives a page with any live context a
  // 128-frame audio buffer. The recording arrives in slices, and each one is measured.
  const SLICE_MS = 300, METER_RATE = 16000;
  // A way of opening the microphone is dead when no bytes arrive in a second and a half, or
  // when the first 0.6s it recorded is exact digital silence: a live microphone, even in a
  // quiet room, never reads exactly zero. The next way opens at once, while the screen still
  // says to wait, so no words are spoken into a dead one.
  const DEAD_MS = 1500, DEAD_SECONDS = 0.6;
  // Ways to open the microphone for a recording, tried in turn while one delivers no audio,
  // from the first on every request. The default capture on an iPhone runs through voice
  // processing - the unit WebKit's own recognizer captures with - and after music had played
  // it delivered nothing at all, twice in a row, on a live track. Opened right after a
  // capture without voice processing, one that itself recorded only exact silence, it
  // delivered the request. So the plainer way always goes first, even after the processed
  // one worked: opened first, that one is the capture that delivered nothing.
  const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  /** @type {{ name: string, audio: MediaTrackConstraints | boolean, session: AudioSession["type"] }[]} */
  const MICROPHONES = [
    { name: "without voice processing", audio: RAW_AUDIO, session: "play-and-record" },
    { name: "with voice processing", audio: true, session: "play-and-record" },
    { name: "without voice processing, session left to the browser", audio: RAW_AUDIO, session: "auto" }
  ];

})();
