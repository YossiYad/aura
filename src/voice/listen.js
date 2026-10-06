(function () {
  const V = window.Aura.voice;
  // Listening through the browser's own recognizer, once per page on iOS.
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
    listen: { get: () => listen }
  });

  // Keep complete sessions as well as interim results. Submit after two seconds
  // of silence with a transcript, using speech events and a result-based fallback.
  /**
   * Opens the microphone and transcribes one request, finishing after two seconds of silence.
   * @param {ListenOptions} options
   * @returns {{ cancel: () => void, finish: () => void }}
   * @throws {Error} When speech recognition is unavailable.
   */
  function listen(options) {
    const Ctor = V.speechCtor();
    if (!Ctor) throw new Error("Speech recognition is unavailable");
    if (V.currentCapture) V.currentCapture();
    if (V.isIOS && V.recognizerRan && V.canRecord()) return V.record(options);
    const id = ++V.captureCount;
    const trace = message => V.log("capture " + id + ": " + message);
    let recognition, timer, finishTimer, finishing = false, closed = false;
    let inputTimer, previousAudioType, microphone;
    let recoveries = 0, runs = 0;
    const ios = V.isIOS;
    const audioSession = navigator.audioSession;
    V.currentCapture = cancel;
    // The player uses playback for background music. Note that output-only category;
    // arm() releases it for the microphone once any post-reply settle has passed.
    try { if (audioSession) previousAudioType = audioSession.type; }
    catch (e) { trace("could not read microphone audio session"); }
    let silenceTimer = null, speaking = false;
    let committed = [], session = [], emptyEnds = 0;
    const parts = () => V.transcriptParts(committed.concat(session));
    const text = () => V.requestStart(parts().map(part => part.text).join(" "));
    // The audio session and this capture's microphone tracks, for the log. A live track
    // alone does not prove audio is arriving, so mute and enabled are shown as well.
    function inputState() {
      let state = "no audio session";
      try { if (audioSession) state = "session " + audioSession.type + "/" + (audioSession.state || "unknown"); } catch (e) {}
      const tracks = microphone ? microphone.getTracks().map(track => (track.readyState || "unknown") +
        (track.muted ? " muted" : "") + (track.enabled === false ? " disabled" : "")).join(", ") : "none";
      return state + ", microphone " + tracks;
    }
    trace("opened on the " + (ios ? "iOS" : "standard") + " path" + (ios && V.recognizerRan ? " after an earlier recognition" : "") +
      ", transcript reset, " + inputState());
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
      if (V.currentCapture === cancel) V.currentCapture = null;
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
      if (!recognition) { trace("finished before recognition started"); complete(); return; }
      trace("run " + runs + " stop requested");
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
        note("audio started, " + inputState() + ", player " + V.playerState());
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
        if (options.ontext) options.ontext(text(), final);
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
      try { run.start(); V.recognizerRan = true; }
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
      const spokeRecently = !!V.lastSpokeAt && Date.now() - V.lastSpokeAt < 8000;
      if (ios && audioSession && (spokeRecently || options.settle)) {
        trace("settling audio session before listening, " + (spokeRecently ? "after reply" : "after playback") + ", player " + V.playerState());
        try { audioSession.type = "auto"; } catch (e) {}
        timer = setTimeout(() => { if (!closed && !finishing) arm(); }, 800);
      } else arm();
    }
    V.afterRelease(options.released, trace, () => { if (!closed && !finishing) open(); });
    return { cancel, finish };
  }
})();
