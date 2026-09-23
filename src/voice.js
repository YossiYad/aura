// Types for the Voice module. Declared outside the closure so the editor sees them from
// any file; comments only, nothing at runtime.

/**
 * @typedef {Object} ListenOptions
 * @property {string} [lang] Recognition language, e.g. "he-IL".
 * @property {boolean} [settle] Let the iOS audio session settle first, after playback.
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
  let currentCapture = null;
  // When a spoken reply last ended. A recognition opened soon after playback can go
  // deaf on iOS (WebKit bug 321436), so listen() settles the audio session first.
  let lastSpokeAt = 0;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  // iOS feeds audio to webkitSpeechRecognition only for the FIRST instance created per page
  // load; a fresh instance for the next request fires audio start but stays deaf (WebKit bug
  // 321436). So on iOS reuse one recognizer for every capture instead of creating new ones.
  let sharedRecognition = null;
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
    let recognition, timer, finishTimer, finishing = false, closed = false;
    let inputTimer, previousAudioType, microphone;
    let recoveries = 0, runToken = 0;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
      navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const audioSession = navigator.audioSession;
    currentCapture = cancel;
    // The player uses playback for background music. Note that output-only category;
    // arm() releases it for the microphone once any post-reply settle has passed.
    try { if (audioSession) previousAudioType = audioSession.type; }
    catch (e) { log("could not read microphone audio session"); }
    let silenceTimer = null, speaking = false;
    let committed = [], session = [], emptyEnds = 0;
    const parts = () => transcriptParts(committed.concat(session));
    const text = () => requestStart(parts().map(part => part.text).join(" "));
    function detach(ended) {
      if (!recognition) return;
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.onspeechstart = recognition.onspeechend = null;
      recognition.onaudiostart = recognition.onaudioend = null;
      if (!ended) { try { recognition.abort(); } catch (e) {} }
      recognition = null;
    }
    function releaseMicrophone() {
      if (!microphone) return;
      microphone.getTracks().forEach(track => track.stop());
      microphone = null;
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
      currentCapture = null;
      try { if (audioSession && previousAudioType != null) audioSession.type = previousAudioType; } catch (e) {}
      log("capture closed");
    }
    function watchInput(ms) {
      clearTimeout(inputTimer);
      // Some mobile recognizers start but never return a result, error or end.
      // Bound that empty session without limiting the length of a spoken request.
      if (!text()) inputTimer = setTimeout(() => {
        if (!recover("recognition-timeout")) fail("recognition-timeout");
      }, ios && recognition && !recoveries ? 5000 : ms);
    }
    function recover(reason) {
      // WebKit can report audio start after playback but never deliver another
      // event (bug 321436). Recover once, only before any words have arrived.
      if (!ios || closed || finishing || text() || recoveries || !recognition) return false;
      recoveries++;
      log("restarting empty recognition after " + reason);
      clearTimeout(timer);
      clearTimeout(inputTimer);
      clearSilence();
      detach();
      releaseMicrophone();
      speaking = false;
      try { if (audioSession) audioSession.type = "auto"; } catch (e) {}
      if (options.onlistening) options.onlistening(false);
      if (options.onrecover) options.onrecover();
      // Release both capture clients and let the previous native session settle.
      // The retry uses recognition's own microphone, without another permission call.
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
      finishTimer = setTimeout(complete, 1500);
      try { recognition.stop(); } catch (e) { complete(); }
    }
    function complete() {
      if (closed) return;
      const value = text();
      log("capture finished, " + value.length + " characters");
      cancel();
      options.onfinish(value);
    }
    function fail(code) {
      if (closed) return;
      const value = text();
      log("capture error: " + code + ", " + value.length + " characters");
      cancel();
      options.onerror(code, value);
    }
    function start() {
      if (closed || finishing) return;
      committed = parts();
      session = [];
      // Reuse the one iOS recognizer; a second instance would be deaf (bug 321436). A run
      // token, not instance identity, marks stale callbacks, since the reused object never
      // changes between a reconnect or a recover and the run it belongs to.
      const fresh = !ios || !sharedRecognition;
      try { recognition = ios ? (sharedRecognition || (sharedRecognition = new Ctor())) : new Ctor(); }
      catch (e) { fail("start-failed"); return; }
      const run = recognition;
      const myToken = ++runToken;
      const active = () => !closed && runToken === myToken;
      recognition.lang = options.lang || "he-IL";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => { if (active()) log("recognition started, " + run.lang + ", recovery " + recoveries + (fresh ? "" : ", reused")); };
      recognition.onaudiostart = () => {
        if (!active() || finishing) return;
        log("microphone audio started, player " + playerState());
        watchInput(12000);
        if (options.onlistening) options.onlistening(true);
      };
      recognition.onaudioend = () => { if (active()) log("microphone audio ended"); };
      recognition.onspeechstart = () => {
        if (!active() || finishing) return;
        log("speech started");
        speaking = true;
        clearSilence();
      };
      recognition.onspeechend = () => {
        if (!active()) return;
        log("speech ended");
        speaking = false;
        waitForSilence();
      };
      recognition.onresult = event => {
        if (!active()) return;
        // Rebuild the current session snapshot, so interim replacements/removals
        // and final corrections never get appended to an older version.
        const before = text();
        session = Array.from(event.results, result => ({ text: result[0].transcript.trim(), final: !!result.isFinal }));
        if (session.some(part => part.text)) {
          emptyEnds = 0;
          clearTimeout(inputTimer);
          if (!finishing && options.onlistening) options.onlistening(true);
        }
        const final = !!(event.results.length && event.results[event.results.length - 1].isFinal);
        log("recognition result, " + text().length + " characters, final " + final);
        if (final) speaking = false;
        // An unchanged final hypothesis is not more speech. Keep its original
        // silence deadline even if the browser repeats it before disconnecting.
        if (text() !== before) clearSilence();
        options.ontext(text(), final);
        waitForSilence();
      };
      recognition.onerror = event => {
        if (!active()) return;
        if (event.error === "no-speech") return;
        // After Finish the words are already in hand; a late network or audio error
        // must not throw the request away and ask for another tap.
        if (finishing && (event.error === "aborted" || text())) return;
        if (event.error === "audio-capture" && recover(event.error)) return;
        fail(event.error || "network");
      };
      recognition.onend = () => {
        if (!active()) return;
        log("recognition ended");
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
      try { recognition.start(); } catch (e) { fail("start-failed"); }
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
        const unavailable = error => fail(error && (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "not-allowed" : "audio-capture");
        try {
          navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            // Permission may resolve after cancellation, timeout or a newer request.
            if (closed || finishing) { stream.getTracks().forEach(track => track.stop()); return; }
            microphone = stream;
            log("microphone stream ready");
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
    const spokeRecently = !!lastSpokeAt && Date.now() - lastSpokeAt < 8000;
    if (ios && audioSession && (spokeRecently || options.settle)) {
      log("settling audio session before listening, " + (spokeRecently ? "after reply" : "after playback") + ", player " + playerState());
      try { audioSession.type = "auto"; } catch (e) {}
      timer = setTimeout(() => { if (!closed && !finishing) arm(); }, 800);
    } else arm();
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
