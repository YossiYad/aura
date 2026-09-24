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
 * @property {"play" | "next" | "append"} action
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
    currentCapture: { get: () => currentCapture },
    fold: { get: () => fold },
    listen: { get: () => listen },
    log: { get: () => log },
    repliesOn: { get: () => repliesOn },
    reply: { get: () => reply },
    requestStart: { get: () => requestStart },
    speechCtor: { get: () => speechCtor },
    stopReply: { get: () => stopReply }
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
  // The built-in recognizer on iOS is fed audio only for the first recognition of a page
  // load; every later one reports audio start and receives nothing. Tried on device with new
  // and reused recognizers and every audio-session reset: WebKit runs that capture apart from
  // the page's own microphone, and nothing on the page reaches it. The page's microphone
  // keeps working, so once the recognizer has run, an iPhone records each later request and
  // has it transcribed (record) - with the Groq or Gemini key from Settings.
  let recognizerRan = false;
  function canTranscribe() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      window.Ai && Ai.transcribe && Ai.hasAnyKey());
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

  // Keep complete sessions as well as interim results. Submit after two seconds
  // of silence with a transcript, using speech events and a result-based fallback.
  /**
   * Opens the microphone and transcribes one request, finishing after two seconds of silence.
   * @param {ListenOptions} options
   * @returns {{ cancel: () => void, finish: () => void }}
   * @throws {Error} When speech recognition is unavailable.
   */
  function listen(options) {
    const Ctor = speechCtor();
    if (!Ctor) throw new Error("Speech recognition is unavailable");
    if (currentCapture) currentCapture();
    if (isIOS && recognizerRan && canTranscribe()) return record(options);
    const id = ++captureCount;
    const trace = message => log("capture " + id + ": " + message);
    // Without a key to transcribe with, a later iPhone request still tries the recognizer,
    // and when it hears nothing the message names the missing key instead.
    const needsKey = isIOS && recognizerRan && !(window.Ai && Ai.hasAnyKey());
    let recognition, timer, finishTimer, finishing = false, closed = false;
    let inputTimer, previousAudioType, microphone;
    let recoveries = 0, runs = 0;
    const ios = isIOS;
    const audioSession = navigator.audioSession;
    currentCapture = cancel;
    // The player uses playback for background music. Note that output-only category;
    // arm() releases it for the microphone once any post-reply settle has passed.
    try { if (audioSession) previousAudioType = audioSession.type; }
    catch (e) { trace("could not read microphone audio session"); }
    let silenceTimer = null, speaking = false;
    let committed = [], session = [], emptyEnds = 0;
    const parts = () => transcriptParts(committed.concat(session));
    const text = () => requestStart(parts().map(part => part.text).join(" "));
    // The audio session and this capture's microphone tracks, for the log. A live track
    // alone does not prove audio is arriving, so mute and enabled are shown as well.
    function inputState() {
      let state = "no audio session";
      try { if (audioSession) state = "session " + audioSession.type + "/" + (audioSession.state || "unknown"); } catch (e) {}
      const tracks = microphone ? microphone.getTracks().map(track => (track.readyState || "unknown") +
        (track.muted ? " muted" : "") + (track.enabled === false ? " disabled" : "")).join(", ") : "none";
      return state + ", microphone " + tracks;
    }
    trace("opened on the " + (ios ? "iOS" : "standard") + " path" + (ios && recognizerRan ? " after an earlier recognition" +
      (needsKey ? ", no key to transcribe with" : "") : "") + ", transcript reset, " + inputState());
    // Takes the handlers off the current recognizer, which is never started again, and
    // aborts it unless it already ended. Whatever its native run still sends reaches no one.
    function detach(ended) {
      if (!recognition) return;
      const run = recognition;
      recognition = null;
      run.onstart = run.onresult = run.onerror = run.onend = null;
      run.onspeechstart = run.onspeechend = null;
      run.onsoundstart = run.onsoundend = null;
      run.onaudiostart = run.onaudioend = null;
      if (ended) return;
      trace("run " + runs + " aborted");
      try { run.abort(); } catch (e) {}
    }
    function releaseMicrophone() {
      if (!microphone) return;
      const tracks = microphone.getTracks();
      microphone = null;
      tracks.forEach(track => track.stop());
      trace("microphone released, tracks " + tracks.map(track => track.readyState || "stopped").join(", "));
    }
    function cancel() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(finishTimer);
      clearTimeout(inputTimer);
      clearSilence();
      detach();
      releaseMicrophone();
      if (currentCapture === cancel) currentCapture = null;
      try { if (audioSession && previousAudioType != null) audioSession.type = previousAudioType; } catch (e) {}
      trace("closed, cleanup complete, " + inputState());
    }
    function watchInput(ms) {
      clearTimeout(inputTimer);
      // Some mobile recognizers start but never return a result, error or end.
      // Bound that empty session without limiting the length of a spoken request.
      if (!text()) inputTimer = setTimeout(() => {
        trace("no words by the input deadline, " + inputState());
        if (!recover("recognition-timeout")) fail("recognition-timeout");
      }, ios && recognition && !recoveries ? 5000 : ms);
    }
    function recover(reason) {
      // WebKit can report audio start after playback but never deliver another
      // event (bug 321436). Recover once, only before any words have arrived.
      if (!ios || closed || finishing || text() || recoveries || !recognition) return false;
      recoveries++;
      trace("restarting empty recognition after " + reason);
      clearTimeout(timer);
      clearTimeout(inputTimer);
      clearSilence();
      detach();
      releaseMicrophone();
      speaking = false;
      try { if (audioSession) audioSession.type = "auto"; } catch (e) {}
      if (options.onlistening) options.onlistening(false);
      if (options.onrecover) options.onrecover();
      // Release both capture clients and let the previous native session settle. The retry
      // is a new recognizer on recognition's own microphone, without another permission call.
      timer = setTimeout(() => {
        if (closed || finishing) return;
        try { if (audioSession) audioSession.type = "play-and-record"; } catch (e) {}
        start();
      }, 1000);
      return true;
    }
    function clearSilence() {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    function waitForSilence() {
      if (closed || finishing || speaking || !text() || silenceTimer !== null) return;
      silenceTimer = setTimeout(() => { silenceTimer = null; finish(); }, 2000);
    }
    function finish() {
      if (closed || finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearTimeout(inputTimer);
      clearSilence();
      if (options.onfinishing) options.onfinishing();
      // Some implementations omit onend after stop. Preserve the latest transcript
      // in that case, while giving a final recognition correction time to arrive.
      finishTimer = setTimeout(() => { trace("no end within 1.5s of stop"); complete(); }, 1500);
      trace(recognition ? "run " + runs + " stop requested" : "finished before recognition started");
      try { recognition.stop(); } catch (e) { complete(); }
    }
    function complete() {
      if (closed) return;
      const value = text();
      trace("finished, " + value.length + " characters");
      cancel();
      options.onfinish(value);
    }
    function fail(code) {
      if (closed) return;
      if (needsKey && code === "recognition-timeout") code = "no-key";
      const value = text();
      trace("error " + code + ", " + value.length + " characters");
      cancel();
      options.onerror(code, value);
    }
    function start() {
      if (closed || finishing) return;
      committed = parts();
      session = [];
      // Every run gets a recognizer of its own, on every platform. WebKit hands each native
      // event to a recognizer object by that object's one client identifier, and accepts
      // start() only while the object is inactive, after the native end of its last run.
      // Reused across requests, one object took the previous run's late end, error and
      // results as the new request's own, and could not start while that run was still
      // stopping - or ever again, when its end never came. A new object has a new
      // identifier: the old run's stragglers go to the detached object, and WebKit stops the
      // old run's capture before this run's begins.
      let run;
      try { run = new Ctor(); }
      catch (e) { trace("recognizer could not be created"); fail("start-failed"); return; }
      recognition = run;
      const runId = ++runs;
      const note = message => trace("run " + runId + " " + message);
      // Only the current run's own object may change the capture.
      const active = () => !closed && recognition === run;
      let audioEnded = false;
      run.lang = options.lang || "he-IL";
      run.continuous = true;
      run.interimResults = true;
      run.maxAlternatives = 1;
      run.onstart = () => { if (active()) note("started, " + run.lang + (recoveries ? ", recovery " + recoveries : "")); };
      run.onaudiostart = () => {
        if (!active() || finishing) return;
        note("audio started, " + inputState() + ", player " + playerState());
        watchInput(12000);
        if (options.onlistening) options.onlistening(true);
      };
      run.onaudioend = () => {
        if (!active()) return;
        note("audio ended");
        audioEnded = true;
        // The microphone is closed even while the run winds down: stop saying it listens.
        if (!finishing && options.onlistening) options.onlistening(false);
      };
      run.onsoundstart = () => { if (active()) note("sound detected"); };
      run.onsoundend = () => { if (active()) note("sound ended"); };
      run.onspeechstart = () => {
        if (!active() || finishing) return;
        note("speech started");
        speaking = true;
        clearSilence();
      };
      run.onspeechend = () => {
        if (!active()) return;
        note("speech ended");
        speaking = false;
        waitForSilence();
      };
      run.onresult = event => {
        if (!active()) return;
        // Rebuild the current session snapshot, so interim replacements/removals
        // and final corrections never get appended to an older version.
        const before = text();
        session = Array.from(event.results, result => ({ text: result[0].transcript.trim(), final: !!result.isFinal }));
        if (session.some(part => part.text)) {
          emptyEnds = 0;
          clearTimeout(inputTimer);
          if (!finishing && !audioEnded && options.onlistening) options.onlistening(true);
        }
        const final = !!(event.results.length && event.results[event.results.length - 1].isFinal);
        note("result, " + text().length + " characters, final " + final);
        if (final) speaking = false;
        // An unchanged final hypothesis is not more speech. Keep its original
        // silence deadline even if the browser repeats it before disconnecting.
        if (text() !== before) clearSilence();
        options.ontext(text(), final);
        waitForSilence();
      };
      run.onerror = event => {
        if (!active()) return;
        note("error " + (event.error || "unknown"));
        if (event.error === "no-speech") return;
        // After Finish the words are already in hand; a late network or audio error
        // must not throw the request away and ask for another tap.
        if (finishing && (event.error === "aborted" || text())) return;
        if (event.error === "audio-capture" && recover(event.error)) return;
        fail(event.error || "network");
      };
      run.onend = () => {
        if (!active()) return;
        note("ended");
        if (options.onlistening) options.onlistening(false);
        detach(true);
        if (finishing) { complete(); return; }
        speaking = false;
        waitForSilence();
        // Stop a service that keeps disconnecting without results. Preserve the text
        // and let the listener restart explicitly instead of repeatedly asking permission.
        if (!session.some(part => part.text) && ++emptyEnds >= 3) {
          // A pending spoken request can still finish on its silence deadline.
          if (!text()) fail("no-speech");
          return;
        }
        timer = setTimeout(start, 300);
      };
      note("created, start requested");
      try { run.start(); recognizerRan = true; }
      catch (e) { note("start threw " + ((e && e.name) || "an error")); fail("start-failed"); }
      if (active() && !finishing) watchInput(recoveries ? 12000 : 20000);
    }
    function arm() {
      // Take the record category, then open the microphone. On the hot path this runs
      // at once; after a spoken reply it runs once the idled session has settled.
      try { if (audioSession) audioSession.type = "play-and-record"; } catch (e) {}
      watchInput(20000);
      // On iOS, speech recognition alone may not keep the audio session active
      // after playback or a spoken reply (WebKit bug 317741). Hold a microphone
      // stream for this capture, including recognition reconnects, and release it
      // before restoring playback. No recorder or additional upload is involved.
      if (ios && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const unavailable = error => {
          trace("microphone unavailable, " + ((error && error.name) || "error"));
          fail(error && (error.name === "NotAllowedError" || error.name === "SecurityError") ? "not-allowed" : "audio-capture");
        };
        trace("microphone requested, " + inputState());
        try {
          navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            // Permission may resolve after cancellation, timeout or a newer request.
            if (closed || finishing) {
              stream.getTracks().forEach(track => track.stop());
              trace("late microphone stream released");
              return;
            }
            microphone = stream;
            trace("microphone ready, " + inputState());
            start();
          }, unavailable);
        } catch (e) { unavailable(e); }
      } else start();
    }
    // A recognition opened right after audio played reports audio start but receives no
    // input (WebKit bug 321436). Two triggers leave the session warm: a spoken reply
    // (lastSpokeAt) and music that was playing until this capture paused it (settle,
    // from the caller). In either case idle the session and let it settle before opening
    // the mic, so the first attempt starts fresh instead of waiting for recover().
    // setTimeout only, never a promise hop on the getUserMedia -> start path tests time.
    function open() {
      const spokeRecently = !!lastSpokeAt && Date.now() - lastSpokeAt < 8000;
      if (ios && audioSession && (spokeRecently || options.settle)) {
        trace("settling audio session before listening, " + (spokeRecently ? "after reply" : "after playback") + ", player " + playerState());
        try { audioSession.type = "auto"; } catch (e) {}
        timer = setTimeout(() => { if (!closed && !finishing) arm(); }, 800);
      } else arm();
    }
    afterRelease(options.released, trace, () => { if (!closed && !finishing) open(); });
    return { cancel, finish };
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
  // Ways to open the microphone for a recording, tried in turn while one delivers no audio;
  // the one that last did goes first next time. The default capture on an iPhone runs
  // through voice processing - the unit WebKit's own recognizer captures with - and after
  // music had played it delivered nothing at all, twice in a row, on a live track. Without
  // voice processing iOS captures through a different, plainer unit.
  const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  /** @type {{ name: string, audio: MediaTrackConstraints | boolean, session: AudioSession["type"] }[]} */
  const MICROPHONES = [
    { name: "without voice processing", audio: RAW_AUDIO, session: "play-and-record" },
    { name: "with voice processing", audio: true, session: "play-and-record" },
    { name: "without voice processing, session left to the browser", audio: RAW_AUDIO, session: "auto" }
  ];
  let workingMicrophone = 0;
  /**
   * Records one request through the page's microphone, ends it on silence and has it
   * transcribed: the iPhone path once the built-in recognizer has run (see recognizerRan).
   * The same contract as listen(), except that the words arrive once, from the transcript.
   * @param {ListenOptions} options
   * @returns {{ cancel: () => void, finish: () => void }}
   */
  function record(options) {
    const id = ++captureCount;
    const trace = message => log("capture " + id + ": " + message);
    let closed = false, finishing = false, attempt = 0;
    const order = MICROPHONES.map((_, i) => (workingMicrophone + i) % MICROPHONES.length);
    /** @type {MediaRecorder | null} */
    let recorder = null;
    /** @type {MediaStream | null} */
    let stream = null;
    /** @type {Blob[]} */
    let chunks = [];
    let liveTimer = null, waitTimer = null, capTimer = null;
    let heard = false, sound = false, startedAt = 0;
    // The meter: how much of the decoded recording has been measured, the quietest slice of
    // the first half second, and how long it has been quiet since the voice.
    const Offline = window.OfflineAudioContext;
    /** @type {OfflineAudioContext | null} */
    let decoder = null;
    let meterBroken = !Offline, decoding = false, measured = 0, room = Infinity, threshold = VOICE_MAX, quiet = 0;
    const audioSession = navigator.audioSession;
    let previousAudioType = null;
    currentCapture = cancel;
    trace("opened on the recording path, the recognizer already ran in this page load; transcript reset");
    function sessionType() {
      try { return audioSession ? String(audioSession.type) : "none"; } catch (e) { return "unreadable"; }
    }
    // Which microphone, in what state: built in or external (a headset or the car), live or
    // muted, and whether its audio is processed. Never the device's own name.
    function trackState() {
      if (!stream) return "no stream";
      return stream.getTracks().map(track => {
        let detail = "";
        try {
          const settings = track.getSettings ? track.getSettings() : null;
          if (settings && settings.sampleRate) detail += " " + settings.sampleRate + "Hz";
          if (settings && settings.echoCancellation != null) detail += settings.echoCancellation ? " processed" : " unprocessed";
        } catch (e) {}
        const kind = !track.label ? "unnamed" : /iphone|ipad|built.?in/i.test(track.label) ? "built-in" : "external";
        return kind + " " + (track.readyState || "unknown") + (track.muted ? " muted" : "") + (track.enabled === false ? " disabled" : "") + detail;
      }).join(", ");
    }
    function bytes() { return chunks.reduce((sum, chunk) => sum + chunk.size, 0); }
    function dropRecorder() {
      if (!recorder) return;
      const old = recorder;
      recorder = null;
      old.ondataavailable = old.onstop = old.onerror = null;
      try { if (old.state !== "inactive") old.stop(); } catch (e) {}
    }
    function dropStream() {
      if (!stream) return;
      const tracks = stream.getTracks();
      stream = null;
      tracks.forEach(track => { track.onmute = track.onunmute = null; track.stop(); });
      trace("microphone released, tracks " + tracks.map(track => track.readyState || "stopped").join(", "));
    }
    // Everything that holds the microphone, let go before the recording is sent.
    function release() {
      clearTimeout(liveTimer);
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      dropRecorder();
      dropStream();
      if (previousAudioType != null) {
        try { if (audioSession) audioSession.type = previousAudioType; } catch (e) {}
        previousAudioType = null;
      }
    }
    function cancel() {
      if (closed) return;
      closed = true;
      release();
      if (currentCapture === cancel) currentCapture = null;
      trace("closed, cleanup complete, session " + sessionType());
    }
    function fail(code) {
      if (closed) return;
      trace("error " + code);
      cancel();
      options.onerror(code, "");
    }
    function finish() {
      if (closed || finishing) return;
      finishing = true;
      clearTimeout(liveTimer);
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      if (options.onfinishing) options.onfinishing();
      trace("recording stopped after " + (startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) + "s" : "none") +
        ", " + bytes() + " bytes, voice heard " + heard + ", sound " + sound + (meterBroken ? ", no meter" : ""));
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); return; } catch (e) {}
      }
      send();
    }
    // Sent only with the microphone closed, and only with a voice in it when the meter could
    // tell: given room noise alone, a transcriber makes words up.
    function send() {
      if (closed) return;
      const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/mp4" });
      release();
      if (!blob.size) { fail("recognition-timeout"); return; }
      if (!meterBroken && !heard) { fail(sound ? "recognition-timeout" : "mic-silent"); return; }
      trace("recorded " + Math.max(1, Math.round(blob.size / 1024)) + "KB, transcribing");
      Promise.resolve().then(() => Ai.transcribe(blob, options.lang || "he-IL")).then(raw => {
        if (closed) return;
        const value = requestStart(String(raw || "").trim());
        trace("transcribed, " + value.length + " characters");
        if (!value) { fail("recognition-timeout"); return; }
        cancel();
        options.onfinish(value);
      }, error => {
        if (closed) return;
        fail(error && error.noKey ? "no-key" : "transcribe-failed");
      });
    }
    function measure() {
      if (meterBroken || decoding || closed || finishing || !chunks.length) return;
      decoding = true;
      const recording = new Blob(chunks, { type: chunks[0].type || "audio/mp4" });
      recording.arrayBuffer().then(buffer => {
        if (!decoder) decoder = new Offline(1, 1, METER_RATE);
        return decoder.decodeAudioData(buffer);
      }).then(audio => {
        decoding = false;
        if (closed || finishing) return;
        const samples = audio.getChannelData(0);
        if (samples.length <= measured) return;
        let sum = 0;
        for (let i = measured; i < samples.length; i++) sum += samples[i] * samples[i];
        const from = measured / audio.sampleRate, seconds = (samples.length - measured) / audio.sampleRate;
        const level = Math.sqrt(sum / (samples.length - measured));
        measured = samples.length;
        if (level > 0 && !sound) { sound = true; workingMicrophone = order[attempt]; trace("sound in the recording"); }
        if (from < 0.5) {
          room = Math.min(room, level);
          if (from + seconds >= 0.5) {
            threshold = Math.min(VOICE_MAX, Math.max(VOICE_MIN, room * 3));
            trace("voice threshold " + threshold.toFixed(3) + ", room level " + room.toFixed(4));
          }
        }
        if (level >= threshold) {
          if (!heard) trace("voice detected");
          heard = true;
          quiet = 0;
        } else if (heard && (quiet += seconds) >= 1.5) finish();
      }, error => {
        decoding = false;
        if (closed || meterBroken) return;
        meterBroken = true;
        trace("no level meter, " + ((error && error.name) || "decoding failed") + "; the recording ends at 8s");
        clearTimeout(waitTimer);
        clearTimeout(capTimer);
        capTimer = setTimeout(finish, Math.max(0, 8000 - (Date.now() - startedAt)));
      });
    }
    // No bytes at all, or only exact silence, means the microphone delivers nothing - the
    // silent capture an iPhone showed after playback. The next way of opening it is tried.
    function noAudio() {
      if (closed || finishing) return;
      trace("no audio in 2.5s, " + bytes() + " bytes, " + trackState() + ", session " + sessionType());
      if (attempt + 1 >= order.length) { fail("mic-silent"); return; }
      attempt++;
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      dropRecorder();
      dropStream();
      chunks = [];
      measured = 0;
      room = Infinity;
      threshold = VOICE_MAX;
      heard = sound = false;
      quiet = 0;
      openMicrophone();
    }
    function begin() {
      let current;
      try { current = recorder = new window.MediaRecorder(stream); }
      catch (e) { trace("recorder unavailable, " + ((e && e.name) || "error")); fail("audio-capture"); return; }
      current.ondataavailable = event => {
        if (recorder !== current || !event.data || !event.data.size) return;
        if (!chunks.length) {
          // Bytes alone may be encoded silence; the meter confirms the way works (measure).
          if (meterBroken) workingMicrophone = order[attempt];
          trace("audio arriving after " + (Date.now() - startedAt) + "ms, " + (event.data.type || "untyped") +
            ", " + MICROPHONES[order[attempt]].name);
        }
        chunks.push(event.data);
        measure();
      };
      current.onstop = () => { if (recorder === current) send(); };
      current.onerror = () => { if (recorder !== current) return; trace("recorder failed"); fail("audio-capture"); };
      try { current.start(SLICE_MS); }
      catch (e) { trace("recorder could not start, " + ((e && e.name) || "error")); fail("audio-capture"); return; }
      startedAt = Date.now();
      trace("recording in " + SLICE_MS + "ms slices, " + (current.mimeType || "default format") + ", microphone " + trackState());
      if (options.onlistening) options.onlistening(true);
      liveTimer = setTimeout(() => {
        if (!chunks.length || (!meterBroken && measured > 0 && !sound)) noAudio();
      }, 2500);
      // A request nobody speaks into ends without sending anything; one the meter cannot
      // judge is sent at its time limit, for the transcriber to judge.
      waitTimer = setTimeout(() => {
        if (heard) return;
        if (meterBroken) finish();
        else fail("recognition-timeout");
      }, 10000);
      capTimer = setTimeout(finish, 20000);
    }
    const unavailable = error => {
      trace("microphone unavailable, " + ((error && error.name) || "error"));
      fail(error && (error.name === "NotAllowedError" || error.name === "SecurityError") ? "not-allowed" : "audio-capture");
    };
    function openMicrophone() {
      const setup = MICROPHONES[order[attempt]];
      try { if (audioSession) audioSession.type = setup.session; }
      catch (e) { trace("could not set the audio session for recording"); }
      trace("microphone requested, attempt " + (attempt + 1) + " of " + order.length + ": " + setup.name + ", session " + sessionType());
      try {
        navigator.mediaDevices.getUserMedia({ audio: setup.audio }).then(got => {
          // Permission may resolve after cancellation or a newer request.
          if (closed || finishing) {
            got.getTracks().forEach(track => track.stop());
            trace("late microphone stream released");
            return;
          }
          stream = got;
          got.getTracks().forEach(track => {
            track.onmute = () => trace("microphone track muted");
            track.onunmute = () => trace("microphone track unmuted");
          });
          trace("microphone ready, " + trackState());
          begin();
        }, unavailable);
      } catch (e) { unavailable(e); }
    }
    afterRelease(options.released, trace, () => {
      if (closed || finishing) return;
      // Recording takes the record category, as the recognizer does; release() hands back
      // the category the player had, once, before anything is sent or played.
      try { if (audioSession) previousAudioType = audioSession.type; } catch (e) {}
      openMicrophone();
    });
    return { cancel, finish };
  }

  let pendingReply = null;
  /** Stops a spoken reply. */
  function stopReply() { if (pendingReply) pendingReply(); }
  /**
   * Speaks a short reply with an on-device voice, when replies are on.
   * @param {Record<string, string>} messages Text by language code, e.g. { he: "...", en: "..." }.
   * @param {string} [language] Preferred language; default "he".
   * @returns {Promise<boolean>} Whether the reply was spoken to the end.
   */
  function reply(messages, language) {
    stopReply();
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance || !repliesOn()) return Promise.resolve(false);
    // iOS speaks only inside a tap, and a reply comes seconds after one: it never starts,
    // holds the song back for the whole eight-second guard, and leaves one more audio client
    // in front of the next request's microphone. There the reply stays on screen.
    if (isIOS && !(navigator.userActivation && navigator.userActivation.isActive)) {
      log("spoken reply skipped: iOS speaks only right after a tap");
      return Promise.resolve(false);
    }
    const voices = synth.getVoices().filter(voice => voice.localService === true);
    // Voice tags arrive as "he-IL" on most engines and "he_IL" on some Android builds.
    const langOf = v => String(v.lang || "").replace("_", "-");
    const preferred = String(language || "he").split(/[-_]/)[0];
    const voice = voices.find(v => langOf(v).split("-")[0] === preferred && messages[preferred]) ||
      voices.find(v => /^en(?:-|$)/i.test(langOf(v)) && messages.en);
    if (!voice) return Promise.resolve(false);
    return new Promise(resolve => {
      const utterance = new window.SpeechSynthesisUtterance(messages[langOf(voice).split("-")[0]] || messages.en);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      let finished = false;
      function done(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        utterance.onend = utterance.onerror = null;
        pendingReply = null;
        if (!ok) synth.cancel();
        lastSpokeAt = Date.now();
        log("spoken reply " + (ok ? "ended" : "cancelled or failed"));
        resolve(ok);
      }
      // A missing OS speech callback must never prevent the song starting.
      const timer = setTimeout(() => done(false), 8000);
      pendingReply = () => done(false);
      utterance.onend = () => done(true);
      utterance.onerror = () => done(false);
      try { log("spoken reply started"); synth.speak(utterance); } catch (e) { done(false); }
    });
  }
  // Start asynchronous voice discovery before a reply is needed. No audio or request
  // is sent, and remote voices are never selected, even as a fallback.
  if (window.speechSynthesis) window.speechSynthesis.getVoices();
})();
