// Types for the Player module. Declared outside the closure so the editor sees them from
// any file; comments only, nothing at runtime.

/**
 * What a Player listener receives. `type` says what changed; a few events carry more.
 * @typedef {Object} PlayerEvent
 * @property {"state" | "track" | "time" | "queue" | "queue-end" | "loading" | "restored" |
 *   "downloads" | "sleep" | "rate" | "remote" | "remote-ready" | "remote-error" |
 *   "playback-permission" | "source-outage" | "offline-skip" | "offline-unavailable" |
 *   "fallback-yt" | "fallback-skip" | "error"} type
 * @property {Track} [track] The track concerned, on "track", "loading" and the playback notices.
 * @property {string} [message] Text to show, on "remote-error".
 * @property {number} [rate] The new speed, on "rate".
 * @property {any} [error] What went wrong, on "error".
 */

/**
 * One row of the queue sheet's history view.
 * @typedef {Object} QueueHistoryEntry
 * @property {Track} track
 * @property {"earlier" | "current" | "upcoming" | "removed"} status
 */

/**
 * @typedef {Object} RemotePlaybackStatus
 * @property {boolean} supported Whether AirPlay or Cast can be offered at all.
 * @property {string} state
 * @property {boolean} preparing
 * @property {string} deviceName
 * @property {boolean} canDisconnect True while casting.
 */

(function () {
  // The player is one module in several files: this one holds the two audio elements and
  // the state every part reads (the queue, what is loading, what the platform last did to
  // the audio), and src/player/ holds one file per concern - remote routes, the audio
  // session, downloads, the cache, radio, the queue, transport, the media session,
  // crossfades, the element events, the network - loaded after it in the order index.html
  // lists them. Each file is its own closure. What one file needs from another it reaches
  // through V, window.Aura.player, where each file publishes, at its top, the names the
  // others use: V.loadAndPlay(), V.queue. A name that another file assigns is published
  // with a setter, so V.pos = 0 changes the variable itself. Nothing outside the module uses
  // V; the public face is window.Player, put together in src/player/public.js.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).player = {};
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    activeLocalKind: { get: () => activeLocalKind, set: value => { activeLocalKind = value; } },
    attachedAudioSourceToken: { get: () => attachedAudioSourceToken, set: value => { attachedAudioSourceToken = value; } },
    audio: { get: () => audio, set: value => { audio = value; } },
    audioA: { get: () => audioA },
    audioB: { get: () => audioB },
    audioFocusResumeAttempts: { get: () => audioFocusResumeAttempts, set: value => { audioFocusResumeAttempts = value; } },
    audioFocusResumeTimer: { get: () => audioFocusResumeTimer, set: value => { audioFocusResumeTimer = value; } },
    audioSessionBound: { get: () => audioSessionBound, set: value => { audioSessionBound = value; } },
    audioSessionGeneration: { get: () => audioSessionGeneration, set: value => { audioSessionGeneration = value; } },
    audioSessionInterrupted: { get: () => audioSessionInterrupted, set: value => { audioSessionInterrupted = value; } },
    backend: { get: () => backend, set: value => { backend = value; } },
    backgroundHoldWatch: { get: () => backgroundHoldWatch, set: value => { backgroundHoldWatch = value; } },
    failedQueueIds: { get: () => failedQueueIds },
    fallbackHandledToken: { get: () => fallbackHandledToken, set: value => { fallbackHandledToken = value; } },
    focusResumeAttemptGeneration: { get: () => focusResumeAttemptGeneration, set: value => { focusResumeAttemptGeneration = value; } },
    focusResumeAttempting: { get: () => focusResumeAttempting, set: value => { focusResumeAttempting = value; } },
    focusResumeConfirmed: { get: () => focusResumeConfirmed, set: value => { focusResumeConfirmed = value; } },
    focusResumePending: { get: () => focusResumePending, set: value => { focusResumePending = value; } },
    handledEndGeneration: { get: () => handledEndGeneration, set: value => { handledEndGeneration = value; } },
    history: { get: () => history, set: value => { history = value; } },
    interruptionCheckpoint: { get: () => interruptionCheckpoint, set: value => { interruptionCheckpoint = value; } },
    isIOS: { get: () => isIOS },
    lastAudioProgressAt: { get: () => lastAudioProgressAt, set: value => { lastAudioProgressAt = value; } },
    lastAudioTime: { get: () => lastAudioTime, set: value => { lastAudioTime = value; } },
    loadingInProgress: { get: () => loadingInProgress, set: value => { loadingInProgress = value; } },
    loadingToken: { get: () => loadingToken, set: value => { loadingToken = value; } },
    log: { get: () => log },
    mediaSessionPauseDecisionTimer: { get: () => mediaSessionPauseDecisionTimer, set: value => { mediaSessionPauseDecisionTimer = value; } },
    mediaSessionPauseExpectationTimer: { get: () => mediaSessionPauseExpectationTimer, set: value => { mediaSessionPauseExpectationTimer = value; } },
    mediaSessionPauseExpected: { get: () => mediaSessionPauseExpected, set: value => { mediaSessionPauseExpected = value; } },
    nativeResumeCheck: { get: () => nativeResumeCheck, set: value => { nativeResumeCheck = value; } },
    nativeResumeTimer: { get: () => nativeResumeTimer, set: value => { nativeResumeTimer = value; } },
    otherEl: { get: () => otherEl },
    pausedByNetwork: { get: () => pausedByNetwork, set: value => { pausedByNetwork = value; } },
    pendingPlaybackPermission: { get: () => pendingPlaybackPermission, set: value => { pendingPlaybackPermission = value; } },
    platformPaused: { get: () => platformPaused, set: value => { platformPaused = value; } },
    platformPausedAt: { get: () => platformPausedAt, set: value => { platformPausedAt = value; } },
    playbackGeneration: { get: () => playbackGeneration, set: value => { playbackGeneration = value; } },
    playbackPrimed: { get: () => playbackPrimed, set: value => { playbackPrimed = value; } },
    pos: { get: () => pos, set: value => { pos = value; } },
    queue: { get: () => queue, set: value => { queue = value; } },
    repeat: { get: () => repeat, set: value => { repeat = value; } },
    reportedDurations: { get: () => reportedDurations },
    sessionKick: { get: () => sessionKick, set: value => { sessionKick = value; } },
    sessionKickResuming: { get: () => sessionKickResuming, set: value => { sessionKickResuming = value; } },
    sessionKickSource: { get: () => sessionKickSource, set: value => { sessionKickSource = value; } },
    shareExhausted: { get: () => shareExhausted, set: value => { shareExhausted = value; } },
    shareSession: { get: () => shareSession, set: value => { shareSession = value; } },
    shuffle: { get: () => shuffle, set: value => { shuffle = value; } },
    SILENT_PRIME_CLIP: { get: () => SILENT_PRIME_CLIP },
    SOURCE_RETRY_DELAYS: { get: () => SOURCE_RETRY_DELAYS },
    sourceRetryAt: { get: () => sourceRetryAt, set: value => { sourceRetryAt = value; } },
    sourceRetryReason: { get: () => sourceRetryReason, set: value => { sourceRetryReason = value; } },
    sourceRetryStep: { get: () => sourceRetryStep, set: value => { sourceRetryStep = value; } },
    sourceRetryTimer: { get: () => sourceRetryTimer, set: value => { sourceRetryTimer = value; } },
    sourceRetryTrack: { get: () => sourceRetryTrack, set: value => { sourceRetryTrack = value; } },
    stallRecoveries: { get: () => stallRecoveries, set: value => { stallRecoveries = value; } },
    stallRecovering: { get: () => stallRecovering, set: value => { stallRecovering = value; } },
    stallTimer: { get: () => stallTimer, set: value => { stallTimer = value; } },
    streamDurations: { get: () => streamDurations },
    unconfirmedFocusResumeTimer: { get: () => unconfirmedFocusResumeTimer, set: value => { unconfirmedFocusResumeTimer = value; } },
    unreadableOffline: { get: () => unreadableOffline },
    volume: { get: () => volume, set: value => { volume = value; } },
    wantsPlayback: { get: () => wantsPlayback, set: value => { wantsPlayback = value; } },
    ytFocusResumeAttempts: { get: () => ytFocusResumeAttempts, set: value => { ytFocusResumeAttempts = value; } },
    ytFocusResumeTimer: { get: () => ytFocusResumeTimer, set: value => { ytFocusResumeTimer = value; } }
  });

  const audioA = document.getElementById("audio");
  const audioB = new Audio();
  audioB.id = "audio-crossfade";
  audioB.preload = "auto";
  audioA.setAttribute("playsinline", "");
  audioB.setAttribute("playsinline", "");
  document.body.appendChild(audioB);
  let audio = audioA;
  // iOS playback permission belongs to the element started by the listener.
  // Keep using it between songs, including while the app is visible. iPadOS
  // can identify itself as a Mac when requesting desktop sites.
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // A few milliseconds of PCM silence (mono, 8kHz, 8-bit). Playing it on the element
  // inside a user gesture hands the element iOS playback permission without a sound;
  // see primeForPlayback.
  const SILENT_PRIME_CLIP = "data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
  function otherEl() { return audio === audioA ? audioB : audioA; }
  function log(tag, msg) { if (window.Log) Log.add(tag, msg); }

  let queue = [];
  let pos = -1;
  let shuffle = false;
  let repeat = "off";
  let history = [];
  let shareSession = "", shareExhausted = false;
  let loadingToken = 0;
  let attachedAudioSourceToken = -1;
  let backend = "audio";
  // The level survives restarts: whatever the slider was left at comes back, instead of
  // every launch starting loud again.
  let volume = (() => {
    try {
      const saved = parseFloat(localStorage.getItem("aura.volume"));
      return saved >= 0 && saved <= 1 ? saved : 1;
    } catch (e) { return 1; }
  })();
  let wantsPlayback = false;
  let platformPaused = false;
  let audioSessionInterrupted = false;
  let audioSessionGeneration = 0;
  let focusResumePending = false;
  let focusResumeConfirmed = false;
  let focusResumeAttempting = false;
  let focusResumeAttemptGeneration = -1;
  let audioFocusResumeTimer = null;
  let audioFocusResumeAttempts = 0;
  let mediaSessionPauseDecisionTimer = null;
  let mediaSessionPauseExpected = false;
  let mediaSessionPauseExpectationTimer = null;
  let platformPausedAt = 0;
  let unconfirmedFocusResumeTimer = null;
  let nativeResumeCheck = null;
  let nativeResumeTimer = null;
  let interruptionCheckpoint = null;
  let ytFocusResumeTimer = null;
  let ytFocusResumeAttempts = 0;
  let loadingInProgress = false;
  let pendingPlaybackPermission = null;
  // Set once the element has been handed iOS playback permission inside a gesture, so a
  // later AI-resolved play() is allowed without a manual tap. Diagnostic only.
  let playbackPrimed = false;
  let audioSessionBound = false;
  let sessionKick = null;
  let sessionKickSource = null;
  let sessionKickResuming = false;
  let backgroundHoldWatch = null;
  let playbackGeneration = 0;
  let handledEndGeneration = -1;
  let lastAudioProgressAt = Date.now();
  let lastAudioTime = 0;
  let stallTimer = null;
  let stallRecovering = false;
  let stallRecoveries = 0;
  let activeLocalKind = null;
  const streamDurations = new Map();
  const reportedDurations = new WeakMap();
  let pausedByNetwork = false;
  let fallbackHandledToken = -1;
  const failedQueueIds = new Set();
  // Listed as saved, yet it would not play with no signal: bytes the device cannot read
  // back. Still eligible, repeat-all came straight round to it and the load re-entered
  // itself without end.
  const unreadableOffline = new Set();
  const SOURCE_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000];
  let sourceRetryTimer = null;
  let sourceRetryStep = 0;
  let sourceRetryTrack = null;
  let sourceRetryAt = 0;
  let sourceRetryReason = "";
})();
