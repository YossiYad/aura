(function () {
  const V = window.Aura.voice;
  // Recording the request when the recognizer cannot hear it, and handing the audio to a transcriber.
  // Published on V for the other files of this module; see src/voice.js.
  Object.defineProperties(V, {
    record: { get: () => record }
  });

  /**
   * The iPhone path once the built-in recognizer has run (see recognizerRan): records one
   * request through the page's microphone, opened a way that delivers (MICROPHONES), and has
   * the recognizer listen alongside once it does. The request is the recognizer's words,
   * shown as they come; the recording is transcribed only when it heard nothing. It ends on
   * silence - the recording's level, or two seconds without new words. The same contract as
   * listen().
   * @param {ListenOptions} options
   * @returns {{ cancel: () => void, finish: () => void }}
   */
  function record(options) {
    const id = ++V.captureCount;
    const trace = message => V.log("capture " + id + ": " + message);
    let closed = false, finishing = false, attempt = 0;
    /** @type {MediaRecorder | null} */
    let recorder = null;
    /** @type {MediaStream | null} */
    let stream = null;
    /** @type {Blob[]} */
    let chunks = [];
    let liveTimer = null, waitTimer = null, capTimer = null;
    let heard = false, sound = false, lit = false, stopped = false, startedAt = 0;
    // The meter: how much of the decoded recording has been measured, the quietest slice of
    // the first half second, and how long it has been quiet since the voice.
    const Offline = window.OfflineAudioContext;
    /** @type {OfflineAudioContext | null} */
    let decoder = null;
    let meterBroken = !Offline, decoding = false, measured = 0, room = Infinity, threshold = V.VOICE_MAX, quiet = 0;
    // The recognizer alongside: its current run, the words it has heard, whether they changed
    // in the last second and a half, and whether it hears speech right now.
    let recognition = null, runs = 0, stopTimer = null, restartTimer = null, wordsTimer = null, freshTimer = null;
    let speaking = false, fresh = false;
    /** @type {{ text: string, final: boolean }[]} */
    let committed = [], session = [];
    // Words said once: stopped just as it finishes a sentence on its own, iOS hands the same
    // final words over twice, and a request said once is never meant twice.
    const words = () => V.requestStart(V.transcriptParts(committed.concat(session))
      .filter((part, i, all) => !(i && all[i - 1].final && V.fold(part.text) === V.fold(all[i - 1].text)))
      .map(part => part.text).join(" "));
    const audioSession = navigator.audioSession;
    let previousAudioType = null;
    V.currentCapture = cancel;
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
    // Takes the handlers off the recognizer's current run, which is never started again, and
    // aborts it unless it already ended. Whatever the run still sends reaches no one.
    function dropRecognizer(ended) {
      clearTimeout(stopTimer);
      const run = recognition;
      if (!run) return;
      recognition = null;
      speaking = false;
      run.onstart = run.onresult = run.onerror = run.onend = null;
      run.onspeechstart = run.onspeechend = run.onaudiostart = null;
      if (ended) return;
      trace("recognizer run " + runs + " aborted");
      try { run.abort(); } catch (e) {}
    }
    // Everything that holds the microphone, let go before the recording is sent.
    function release() {
      clearTimeout(liveTimer);
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      clearTimeout(restartTimer);
      clearTimeout(freshTimer);
      clearWords();
      dropRecognizer(false);
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
      if (V.currentCapture === cancel) V.currentCapture = null;
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
      clearTimeout(restartTimer);
      clearWords();
      if (options.onfinishing) options.onfinishing();
      trace("recording stopped after " + (startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) + "s" : "none") +
        ", " + bytes() + " bytes, voice heard " + heard + ", sound " + sound + (meterBroken ? ", no meter" : "") +
        ", recognizer " + (runs ? words().length + " characters" : "not started"));
      // Stopped, the recognizer hands over its last words; some builds never say it ended.
      if (recognition) {
        const run = recognition;
        trace("recognizer run " + runs + " stop requested");
        stopTimer = setTimeout(() => { trace("recognizer gave no end within 1.5s of stop"); dropRecognizer(false); decide(); }, 1500);
        try { run.stop(); } catch (e) { dropRecognizer(false); }
      }
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); return; } catch (e) {}
      }
      recordingStopped();
    }
    function recordingStopped() {
      stopped = true;
      decide();
    }
    // Once the recording and the recognizer have both stopped: the recognizer's words when it
    // heard any, and nothing is sent; else the recording, for the transcriber.
    function decide() {
      if (closed || !finishing || !stopped || recognition) return;
      const value = words();
      if (value) {
        trace("the request is the recognizer's, " + value.length + " characters; the recording is not sent");
        cancel();
        options.onfinish(value);
        return;
      }
      if (runs) trace("the recognizer heard nothing; the recording goes to the transcriber");
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
      // Without a key there is nothing to transcribe it with, and it goes nowhere.
      if (!(window.Ai && Ai.transcribe && Ai.hasAnyKey())) { fail("no-key"); return; }
      trace("recorded " + Math.max(1, Math.round(blob.size / 1024)) + "KB, transcribing");
      Promise.resolve().then(() => Ai.transcribe(blob, options.lang || "he-IL")).then(raw => {
        if (closed) return;
        const value = V.requestStart(String(raw || "").trim());
        trace("transcribed, " + value.length + " characters");
        if (!value) { fail("recognition-timeout"); return; }
        cancel();
        options.onfinish(value);
      }, error => {
        if (closed) return;
        fail(error && error.noKey ? "no-key" : "transcribe-failed");
      });
    }
    // The screen says it is listening only once this way is known to deliver: sound in the
    // recording, or bytes where no meter can tell. Until then it says to wait.
    function listening() {
      if (lit || closed || finishing) return;
      lit = true;
      if (options.onlistening) options.onlistening(true);
      startRecognizer();
    }
    // The recognizer starts once the microphone delivers: by then the capture it shares
    // delivers too. A run that ends while the request goes on is replaced, twice at most, and
    // the words it heard are kept.
    function startRecognizer() {
      const Ctor = V.speechCtor();
      if (!Ctor || closed || finishing || recognition) return;
      committed = V.transcriptParts(committed.concat(session));
      session = [];
      let run;
      try { run = new Ctor(); }
      catch (e) { trace("recognizer could not be created; the recording is the request"); return; }
      recognition = run;
      const runId = ++runs;
      const note = message => trace("recognizer run " + runId + " " + message);
      const active = () => !closed && recognition === run;
      run.lang = options.lang || "he-IL";
      run.continuous = true;
      run.interimResults = true;
      run.maxAlternatives = 1;
      run.onstart = () => { if (active()) note("started, " + run.lang); };
      run.onaudiostart = () => { if (active()) note("audio started"); };
      run.onspeechstart = () => {
        if (!active() || finishing) return;
        note("speech started");
        speaking = true;
        clearWords();
      };
      run.onspeechend = () => {
        if (!active()) return;
        note("speech ended");
        speaking = false;
        waitAfterWords();
      };
      run.onresult = event => {
        if (!active()) return;
        const before = words();
        session = Array.from(event.results, result => ({ text: result[0].transcript.trim(), final: !!result.isFinal }));
        const final = !!(event.results.length && event.results[event.results.length - 1].isFinal);
        note("result, " + words().length + " characters, final " + final);
        if (final) speaking = false;
        if (words() !== before) {
          clearWords();
          fresh = true;
          clearTimeout(freshTimer);
          freshTimer = setTimeout(() => { fresh = false; }, 1500);
        }
        if (options.ontext) options.ontext(words(), final);
        waitAfterWords();
      };
      run.onerror = event => { if (active()) note("error " + (event.error || "unknown")); };
      run.onend = () => {
        if (!active()) return;
        note("ended");
        dropRecognizer(true);
        if (finishing) { decide(); return; }
        waitAfterWords();
        if (runs < 3) restartTimer = setTimeout(startRecognizer, 300);
      };
      note("created alongside the recording, start requested");
      try { run.start(); }
      catch (e) { note("start threw " + ((e && e.name) || "an error") + "; the recording is the request"); dropRecognizer(true); }
    }
    // Words, then two seconds without new ones, end the request as they end the first one;
    // the recording's level can end it sooner (measure).
    function waitAfterWords() {
      if (closed || finishing || speaking || !words() || wordsTimer !== null) return;
      wordsTimer = setTimeout(() => { wordsTimer = null; finish(); }, 2000);
    }
    function clearWords() {
      clearTimeout(wordsTimer);
      wordsTimer = null;
    }
    function measure() {
      if (meterBroken || decoding || closed || finishing || !chunks.length) return;
      decoding = true;
      // A decode still running when a dead way is dropped belongs to that way, not the next.
      const way = attempt;
      const recording = new Blob(chunks, { type: chunks[0].type || "audio/mp4" });
      recording.arrayBuffer().then(buffer => {
        if (!decoder) decoder = new Offline(1, 1, V.METER_RATE);
        return decoder.decodeAudioData(buffer);
      }).then(audio => {
        decoding = false;
        if (closed || finishing) return;
        if (way !== attempt) { measure(); return; }
        const samples = audio.getChannelData(0);
        if (samples.length <= measured) return;
        let sum = 0;
        for (let i = measured; i < samples.length; i++) sum += samples[i] * samples[i];
        const from = measured / audio.sampleRate, seconds = (samples.length - measured) / audio.sampleRate;
        const level = Math.sqrt(sum / (samples.length - measured));
        measured = samples.length;
        if (level > 0 && !sound) { sound = true; trace("sound in the recording"); listening(); }
        if (from < 0.5) {
          room = Math.min(room, level);
          if (from + seconds >= 0.5) {
            threshold = Math.min(V.VOICE_MAX, Math.max(V.VOICE_MIN, room * 3));
            trace("voice threshold " + threshold.toFixed(3) + ", room level " + room.toFixed(4));
          }
        }
        if (!sound) {
          if (measured >= V.DEAD_SECONDS * audio.sampleRate) noAudio();
          return;
        }
        // Quiet ends the request only once the recognizer's words have stopped changing too:
        // words still arriving are someone still speaking, whatever the level says.
        if (level >= threshold) {
          if (!heard) trace("voice detected");
          heard = true;
          quiet = 0;
        } else if (heard && (quiet += seconds) >= 1.5 && !fresh) finish();
      }, error => {
        decoding = false;
        if (closed || meterBroken) return;
        if (way !== attempt) { measure(); return; }
        meterBroken = true;
        trace("no level meter, " + ((error && error.name) || "decoding failed") + "; the recording ends at 8s");
        listening();
        clearTimeout(waitTimer);
        clearTimeout(capTimer);
        capTimer = setTimeout(finish, Math.max(0, 8000 - (Date.now() - startedAt)));
      }).catch(error => {
        // A throw inside the level handler itself (a decoder that hands back no audio, a
        // listener that throws): the meter is treated as broken rather than left waiting.
        if (closed || finishing || way !== attempt || meterBroken) return;
        meterBroken = true;
        trace("level meter failed, " + ((error && error.name) || error) + "; the recording ends at 8s");
        listening();
        clearTimeout(waitTimer);
        clearTimeout(capTimer);
        capTimer = setTimeout(finish, Math.max(0, 8000 - (Date.now() - startedAt)));
      });
    }
    // No bytes at all, or only exact silence, means the microphone delivers nothing - the
    // silent capture an iPhone showed after playback. The next way of opening it is tried.
    function noAudio() {
      if (closed || finishing) return;
      trace("no audio after " + (Date.now() - startedAt) + "ms, " + (chunks.length ? bytes() + " bytes of exact silence" : "no bytes") +
        ", " + trackState() + ", session " + sessionType());
      if (attempt + 1 >= V.MICROPHONES.length) { fail("mic-silent"); return; }
      attempt++;
      clearTimeout(liveTimer);
      clearTimeout(waitTimer);
      clearTimeout(capTimer);
      dropRecorder();
      dropStream();
      chunks = [];
      measured = 0;
      room = Infinity;
      threshold = V.VOICE_MAX;
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
          trace("audio arriving after " + (Date.now() - startedAt) + "ms, " + (event.data.type || "untyped") +
            ", " + V.MICROPHONES[attempt].name);
          // Bytes alone may be encoded silence: the meter tells (measure), where there is one.
          if (meterBroken) listening();
        }
        chunks.push(event.data);
        measure();
      };
      current.onstop = () => { if (recorder === current) recordingStopped(); };
      current.onerror = () => { if (recorder !== current) return; trace("recorder failed"); fail("audio-capture"); };
      try { current.start(V.SLICE_MS); }
      catch (e) { trace("recorder could not start, " + ((e && e.name) || "error")); fail("audio-capture"); return; }
      startedAt = Date.now();
      trace("recording in " + V.SLICE_MS + "ms slices, " + (current.mimeType || "default format") + ", microphone " + trackState());
      // Exact silence usually shows well before (measure); a meter slow to decode it gets
      // another second.
      liveTimer = setTimeout(() => {
        if (!chunks.length) { noAudio(); return; }
        liveTimer = setTimeout(() => { if (!meterBroken && measured > 0 && !sound) noAudio(); }, 1000);
      }, V.DEAD_MS);
      // A request nobody speaks into ends without sending anything; one the meter cannot
      // judge is sent at its time limit, for the transcriber to judge.
      waitTimer = setTimeout(() => {
        if (heard || words()) return;
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
      const setup = V.MICROPHONES[attempt];
      try { if (audioSession) audioSession.type = setup.session; }
      catch (e) { trace("could not set the audio session for recording"); }
      trace("microphone requested, attempt " + (attempt + 1) + " of " + V.MICROPHONES.length + ": " + setup.name + ", session " + sessionType());
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
    V.afterRelease(options.released, trace, () => {
      if (closed || finishing) return;
      // Recording takes the record category, as the recognizer does; release() hands back
      // the category the player had, once, before anything is sent or played.
      try { if (audioSession) previousAudioType = audioSession.type; } catch (e) {}
      openMicrophone();
    });
    return { cancel, finish };
  }
})();
