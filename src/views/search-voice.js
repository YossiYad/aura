(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.views;
  // A spoken or typed request on the Ask screen: the orb, the reply line, the run from words to playback.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    submitAsk: { get: () => submitAsk },
    voice: { get: () => voice },
    voiceEdit: { get: () => voiceEdit },
    voiceEnd: { get: () => voiceEnd },
    voiceOrbState: { get: () => voiceOrbState },
    voiceStart: { get: () => voiceStart }
  });

  // ---- Voice requests ----
  // A spoken request happens on the screen it was started from, and there is no dialog:
  // the orb listens, the words land in the Ask field where typed ones go, and the line
  // under the orb says what is happening. Driving mode shows the same request on a layer
  // of its own. `voice` is the request that is open, or null.
  let voice = null;

  const VOICE_DONE = /(?:^|\s)(?:סיימתי[,.!?\s]+תנגן|(?:i'm |i am )?done[,.!?\s]+play)[.!?\s]*$/i;

  // Short on purpose: they sit under the orb on a screen meant to stay clean, and they
  // are read out loud as well.
  const VOICE_ERRORS = {
    "not-allowed": "אין הרשאה למיקרופון. אפשר לכתוב את הבקשה למעלה.",
    "service-not-allowed": "זיהוי הדיבור חסום כאן. אפשר לכתוב את הבקשה למעלה.",
    "audio-capture": "המיקרופון לא זמין.",
    "recognition-timeout": "לא נקלט דיבור. נסו שוב או כתבו את הבקשה.",
    "network": "זיהוי הדיבור לא זמין כרגע. נסו שוב או כתבו למעלה.",
    "no-speech": "לא שמעתי המשך. אפשר לשלוח או להמשיך לדבר.",
    "language-not-supported": "השפה הזו לא נתמכת בזיהוי הדיבור כאן.",
    // After its first request an iPhone also records each one, transcribed only when the
    // built-in recognizer heard nothing; see src/voice.js.
    "transcribe-failed": "לא הצלחתי לתמלל את הבקשה. נסו שוב או כתבו למעלה.",
    "no-key": "זיהוי הדיבור לא שמע. עם מפתח Groq או Gemini בהגדרות ההקלטה תתומלל. אפשר גם לכתוב למעלה.",
    "mic-silent": "המיקרופון לא העביר קול. נסו שוב, ואם זה חוזר - סגרו ופתחו את האפליקציה."
  };

  // Spoken answers are part of the interface: in English they are always English, even
  // when the request itself was spoken in Hebrew. Hebrew keeps following the speech setting.
  function replyLanguage() {
    if (window.I18n && I18n.language() === "en") return "en-US";
    return window.I18n ? I18n.speechLanguage() : Store.settings().voiceLanguage || "he-IL";
  }

  function voiceOrbState() {
    return !voice ? "breathing" : voice.busy ? "searching" : voice.finishing ? "working"
      : voice.hearing ? "listening" : voice.recording ? "connecting" : "breathing";
  }

  function voiceLog(message) { if (window.Log) Log.add("voice", message); }

  // What the orb last showed. Each change is logged, so the log shows what the screen
  // claimed - listening or not - next to what the recognizer was actually doing.
  let shownState = "breathing";

  // Shows the open request wherever it can be seen: in place on the Ask screen, and as an
  // event for anything else that draws it - driving mode does.
  function voicePaint() {
    const state = voiceOrbState();
    if (state !== shownState) { voiceLog("screen " + shownState + " -> " + state); shownState = state; }
    V.paintAskOrb();
    window.dispatchEvent(new CustomEvent("aura-voice", { detail: voice ? {
      surface: voice.surface, state, status: voice.status,
      text: V.askState.spoken ? V.askState.prompt : ""
    } : null }));
  }

  function voiceSay(text) {
    if (!voice) return;
    voice.status = text;
    voicePaint();
  }

  // The field and what it remembers, together. `spoken` marks words that came from the
  // microphone: corrected by hand or not, they are still a request to play something.
  function setAskText(text, spoken) {
    V.askState.prompt = text;
    V.askState.spoken = !!spoken && !!text;
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("ask-prompt"));
    if (!input) return;
    input.value = text;
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }

  // The song that was paused to open the microphone comes back once the microphone is
  // closed and nothing else was started - unless it changed in the meantime.
  function voiceResume() {
    if (!voice || !voice.pausedTrack) return;
    const track = voice.pausedTrack;
    voice.pausedTrack = null;
    if (Player.current() === track && Player.isPaused()) Player.toggle();
  }

  // Closes the microphone and keeps the request: the words stay, and so does the note.
  function voiceHush(resume) {
    if (!voice) return;
    if (voice.capture) voice.capture.cancel();
    voice.capture = null;
    voice.recording = voice.hearing = voice.finishing = false;
    if (resume) voiceResume();
  }

  // The request is over, finished or called off. Its spoken words go with it: left in
  // the field, the next request would carry them in front of its own.
  /** Ends the voice request in progress, if any. */
  function voiceEnd() {
    if (!voice) return;
    voiceHush(true);
    Voice.stopReply();
    if (V.askState.spoken) setAskText("", false);
    voice = null;
    voiceLog("request ended");
    voicePaint();
  }

  // Only a text edit takes over from talking. Focus or a tap can happen without
  // typing and must not cancel the microphone or its automatic submission.
  function voiceEdit() {
    if (!voice || voice.busy || !(voice.recording || voice.finishing)) return;
    voiceHush(true);
    Voice.stopReply();
    voiceSay(tr("ההאזנה נעצרה לעריכה"));
  }

  /**
   * Starts a voice request, or stops the one listening.
   * @param {"ask" | "drive"} [surface] Which screen shows the request; default "ask".
   */
  function voiceStart(surface) {
    // A tap while it is looking something up means never mind.
    if (voice && voice.busy) { voiceEnd(); return; }
    if (voice && (voice.recording || voice.finishing)) {
      voiceHush(true);
      voiceSay(tr("ההאזנה נעצרה"));
      return;
    }
    // Every microphone activation is a new request. Give it its own identity so
    // callbacks and delayed notes from an earlier attempt cannot change this one.
    const pausedTrack = voice && voice.pausedTrack;
    voiceHush(false);
    voice = { surface: surface || "ask", status: "", capture: null, recording: false, hearing: false, finishing: false, busy: false, pausedTrack };
    const me = voice;
    if (!Voice.supported()) { voiceSay(tr("אין כאן זיהוי דיבור. אפשר לכתוב את הבקשה למעלה.")); return; }
    Voice.stopReply();
    const input = document.getElementById("ask-prompt");
    if (input) input.blur();
    const cleared = V.askState.spoken;
    if (cleared) setAskText("", false);
    const pauseNeeded = Player.playbackRequested() || !Player.isPaused();
    voiceLog("request started on " + me.surface + (cleared ? ", previous spoken words cleared" : "") +
      (pauseNeeded ? ", pausing playback" : ""));
    if (!me.pausedTrack && pauseNeeded) me.pausedTrack = Player.current();
    // An interrupted or buffering player can appear paused while still intending
    // to resume. Clear that intent before microphone audio focus becomes active.
    if (pauseNeeded) Player.pause();
    // A loaded media element holds the iOS audio session and starves the microphone even
    // when it is only paused or waiting for a play tap (WebKit 321436; seen on device with
    // src:true and pauseNeeded false). Release it on every capture, not just when pausing;
    // releaseForVoice is a no-op when nothing is loaded, and the song reloads in place.
    const released = Player.releaseForVoice ? Player.releaseForVoice() : null;
    me.recording = true;
    voiceSay(tr("רגע…"));
    me.capture = Voice.listen({
      lang: (window.I18n ? I18n.speechLanguage() : Store.settings().voiceLanguage || "he-IL"),
      // Music playing until now leaves the iOS audio session warm; let listen() idle and
      // settle it first so this request is not deaf on the second onward (WebKit 321436).
      settle: pauseNeeded,
      // And the microphone waits for the player's audio context to finish closing.
      released,
      onrecover() { if (voice === me) voiceSay(tr("מחדש האזנה…")); },
      onfinishing() { if (voice !== me) return; me.finishing = true; me.hearing = false; voiceSay(tr("רגע…")); },
      onlistening(active) {
        if (voice !== me) return;
        me.hearing = active && !me.finishing;
        if (me.finishing) voicePaint();
        else voiceSay(active ? tr("מקשיב…") : tr("רגע…"));
      },
      ontext(text, final) {
        if (voice !== me) return;
        setAskText(text, true);
        voicePaint();
        if (final && VOICE_DONE.test(text)) voiceFinish();
      },
      onfinish(text) { if (voice !== me) return; setAskText(text, true); voiceRun(); },
      onerror(code, text) {
        if (voice !== me) return;
        if (text) setAskText(text, true);
        me.capture = null;
        me.recording = me.hearing = me.finishing = false;
        const message = tr(VOICE_ERRORS[code]) || tr("זיהוי הדיבור נעצר. אפשר לנסות שוב או לכתוב למעלה.");
        voiceSay(message);
        voiceAfterNote(me, { he: message, en: "Voice input stopped. You can retry or type your request." });
      }
    });
  }

  // A note that is also read out: the paused song waits for the reading to finish, and in
  // driving mode the layer does not wait for a hand to dismiss it.
  function voiceAfterNote(me, messages) {
    Promise.resolve(Voice.reply(messages, replyLanguage())).then(() => {
      if (voice !== me || me.recording || me.busy) return;
      voiceResume();
      if (me.surface === "drive") setTimeout(() => { if (voice === me && !me.recording && !me.busy) voiceEnd(); }, 6000);
    });
  }

  // Sends what is in the field now: waits for the last words if the microphone is open.
  function voiceFinish() {
    if (!voice || voice.busy || voice.finishing) return;
    if (!voice.capture || !voice.recording) { voiceRun(); return; }
    voice.finishing = true;
    voicePaint();
    voice.capture.finish();
  }

  async function voiceRun() {
    if (!voice) voice = { surface: "ask", status: "", capture: null, recording: false, hearing: false, finishing: false, busy: false, pausedTrack: null };
    const me = voice;
    if (me.busy) return;
    voiceHush(false);
    const request = V.askState.prompt.replace(VOICE_DONE, "").trim();
    if (!request) {
      voiceLog("request empty, nothing submitted");
      voiceSay(tr("לא שמעתי בקשה"));
      voiceResume();
      return;
    }
    voiceLog("request submitted, " + request.length + " characters");
    me.busy = true;
    voiceSay(tr("מחפש…"));
    const live = () => voice === me;
    const language = replyLanguage();
    try {
      const result = await Voice.resolve(request, text => { if (live()) voiceSay(text); }, live);
      if (!live()) return;
      if (result.action === "skip") {
        if (!Player.current()) throw new Error(tr("אין שיר לדלג עליו."));
        if (!Player.upcoming().length) throw new Error(tr("זה השיר האחרון בתור."));
        voiceSay(tr("עובר לשיר הבא"));
        await Voice.reply({ he: "עובר לשיר הבא", en: "Skipping to the next song" }, language);
        if (!live()) return;
        // The song the microphone paused is not coming back: the next one is the point.
        me.pausedTrack = null;
        Player.next();
        setAskText("", false);
        voiceEnd();
        V.toast(tr("עובר לשיר הבא"));
        return;
      }
      voiceSay(tr("מצאתי: ") + result.label);
      const next = result.action === "next";
      const append = result.action === "append";
      await Voice.reply(next
        ? { he: "מצאתי. מכין את " + result.label + " לשיר הבא", en: "Found it. Queuing " + result.label + " next" }
        : append ? { he: "מצאתי. מוסיף את " + result.label + " לסוף התור", en: "Found it. Adding " + result.label + " to the end of the queue" }
        : { he: "מצאתי. מפעיל את " + result.label, en: "Found it. Starting " + result.label }, language);
      if (!live()) return;
      const queued = (next || append) && !!Player.current();
      let added = 0;
      let sharedAlready = false;
      // playQueue answers false for blocked tracks, and in an AuraShare session also for
      // ones already in it. The second is a request that was met, not a song that
      // cannot play; spoken as a failure it sent the listener looking for another match.
      const mustBeShared = list => {
        if (Player.shareSession && Player.shareSession() && list.some(track => !Store.isBlocked(track))) return true;
        throw new Error(tr("לא ניתן לנגן את השירים האלה."));
      };
      if (next) {
        const tracks = result.tracks.filter(track => !Store.isBlocked(track));
        if (!tracks.length) throw new Error(tr("לא ניתן להוסיף את השיר הזה לתור."));
        // Each goes in right after the current song, so inserting them last-first
        // keeps the list's own order. With nothing playing there is no current song to
        // insert after: the first playNext starts a queue of one and the rest landed
        // behind it out of order. A shared queue files each contribution after the
        // earlier ones, so there the list goes in first-first.
        if (!queued) {
          if (!Player.playQueue(tracks, 0)) sharedAlready = mustBeShared(tracks);
        } else if (Player.shareSession && Player.shareSession()) tracks.forEach(track => Player.playNext(track));
        else tracks.slice().reverse().forEach(track => Player.playNext(track));
      } else if (append) {
        const tracks = result.tracks.filter(track => !Store.isBlocked(track));
        if (!tracks.length) throw new Error(tr("לא ניתן להוסיף את השירים האלה לתור."));
        for (const track of tracks) { if (Player.addToQueue(track)) added++; }
      } else if (!Player.playQueue(result.tracks, 0, result.playlist ? { playlist: result.playlist } : undefined)) sharedAlready = mustBeShared(result.tracks);
      // A request that only queued something hands the paused song back. One that
      // started new music must not: the song it paused is no longer the point.
      if (!queued) me.pausedTrack = null;
      setAskText("", false);
      voiceEnd();
      V.toast((queued ? next ? tr("השיר הבא בתור: ") : added ? tr("נוסף לסוף התור: ") : tr("כבר נמצא בתור: ")
        : sharedAlready ? tr("כבר נמצא ב-AuraShare: ") : tr("הבקשה נשלחה לנגן: ")) + result.label);
    } catch (e) {
      if (!live()) return;
      voiceLog("request not played, its note is shown and the microphone is ready again");
      me.busy = false;
      voiceSay(String(e.message || e));
      voiceAfterNote(me, { he: String(e.message || e), en: "I couldn't find a clear match. Please try the song and artist name." });
    }
  }

  // The browser closes the microphone on its own when the app leaves the screen. The
  // words stay in the field, and the paused song stays paused until someone is back to
  // decide - starting audio from the background is the player's business, not this one's.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !voice || !(voice.recording || voice.finishing)) return;
    voiceHush(false);
    voiceSay(tr("ההאזנה נעצרה"));
  });

  // One field for both kinds of asking. Words that came from the microphone, or that say
  // what to do with music ("play ...", "... next", "add ... to the queue"), are a request
  // to play something and go the way a spoken one does. Anything else describes a
  // playlist, and gets one built to look through.
  function submitAsk(text) {
    const ask = String(text || "").trim();
    if (!ask || V.askState.status === "loading" || (voice && voice.busy)) return;
    V.askState.prompt = ask;
    if (voice && (voice.recording || voice.finishing)) { voiceFinish(); return; }
    // A typed "play ..." command resolves and plays seconds later, outside this tap, so on
    // iOS hand the player its playback permission now, inside the tap, the same way the mic
    // path does through releaseForVoice. Safe here because the microphone is not open on
    // this branch (recording/finishing was handled above).
    if (V.askState.spoken || Voice.isCommand(ask)) {
      if (Player.primeForPlayback) Player.primeForPlayback();
      voiceRun();
      return;
    }
    voiceEnd();
    V.runAsk(ask, false);
  }
})();
