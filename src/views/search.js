(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    BLOCKED_MSG: { get: () => BLOCKED_MSG },
    blockedAvoidLabels: { get: () => blockedAvoidLabels },
    cancelLiveSearch: { get: () => cancelLiveSearch },
    categorySearch: { get: () => categorySearch },
    discoverState: { get: () => discoverState },
    doSearch: { get: () => doSearch },
    drRow: { get: () => drRow },
    openArtistByName: { get: () => openArtistByName },
    renderCategory: { get: () => renderCategory },
    renderSearch: { get: () => renderSearch },
    submitAsk: { get: () => submitAsk },
    unblocked: { get: () => unblocked },
    voice: { get: () => voice },
    voiceEdit: { get: () => voiceEdit },
    voiceEnd: { get: () => voiceEnd },
    voiceOrbState: { get: () => voiceOrbState },
    voiceStart: { get: () => voiceStart },
    watchLoadMore: { get: () => watchLoadMore }
  });

  // ---------------- Search ----------------

  /**
   * What the search screen shows for the query typed into it.
   * @typedef {Object} DiscoverState
   * @property {string} q
   * @property {Track[]} items
   * @property {ArtistSummary[]} artists
   * @property {string} source
   * @property {boolean} busy
   * @property {string | null} error
   * @property {SourceKind | "proxy" | null} kind
   * @property {string | null} nextpage
   * @property {string} [base]
   * @property {string} [filter]
   * @property {number} [page]
   * @property {boolean} [loadingMore] While the next page is being fetched.
   * @property {boolean} [moreError] The next page failed, so scrolling no longer loads more by itself.
   */
  /** @type {DiscoverState} */
  let discoverState = { q: "", items: [], artists: [], source: "", busy: false, error: null, kind: null, nextpage: null, loadingMore: false };

  function drRow(t) {
    const inPlaylist = Store.playlists().some(p => p.ids.includes(t.id));
    const active = Player.current() && Player.current().id === t.id;
    return '<li class="dr' + (active ? " active" : "") + '" data-id="' + V.esc(t.id) + '">' +
      '<div class="dr-thumb"><img decoding="async" src="' + V.esc(t.thumb) + '" loading="lazy" alt="" />' +
      // Both are drawn and one is hidden, so markNowPlaying can move the bars to whichever
      // result is playing without the list being painted again.
      '<div class="eq"' + (active ? "" : " hidden") + ' style="position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:8px;background:rgba(0,0,0,.55)"><span></span><span></span><span></span><span></span></div>' +
      '<div class="play-fab" data-play="1"' + (active ? " hidden" : "") + '>' + V.PLAY_ICON + '</div>' +
      '<span class="duration">' + V.fmt(t.duration) + '</span></div>' +
      '<div class="meta"><div class="title" dir="auto">' + V.esc(t.title) + '</div><div class="sub" dir="auto">' + V.artistHtml(t) + (t.views != null && t.views >= 0 ? " · " + V.fmtViews(t.views) : "") + '</div></div>' +
      V.rowDlBtn(t.id) +
      (inPlaylist
        ? '<button class="add-btn added" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Added</button>'
        : '<button class="add-btn add" data-add="' + V.esc(t.id) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add</button>') +
      '<button class="kebab" data-menu="' + V.esc(t.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>' +
      '</li>';
  }

  const BLOCKED_MSG = "Blocked - unblock it in Settings";
  function unblocked(list) { return list.filter(t => !Store.isBlocked(t)); }

  // Fed to the AI prompt so blocked songs and artists are not suggested in the first
  // place; matching filters whatever slips through anyway.
  function blockedAvoidLabels() {
    const list = Store.blockedList();
    return list.tracks.filter(t => t.title).map(t => t.title + (t.artist ? " - " + t.artist : "")).concat(list.artists);
  }

  function ytResultsHtml(d) {
    const items = unblocked(d.items);
    return (d.busy ? '<div class="status-line"><span class="ring"></span> Searching YouTube…</div>' :
      d.error ? '<div class="status-line err">' + V.esc(d.error) + '</div>' +
        '<div class="row-actions"><button class="btn ghost" id="search-retry">Try again</button></div>' :
      items.length ? '<div class="status-line"><span class="results-count">' + items.length + ' results</span><span style="color:var(--fg-faint)">·</span><span class="via">via ' + V.esc(d.source) + '</span></div>' : "") +
      (d.artists.length
        ? '<h3 class="section-title">Artists</h3><div class="rail artists">' + d.artists.map(a =>
            '<button class="card" data-ytartist="' + V.esc(a.id) + '" data-ytname="' + V.esc(a.name) + '" data-ytthumb="' + V.esc(a.thumb) + '">' +
            '<div class="card-art"><img decoding="async" src="' + V.esc(a.thumb) + '" loading="lazy" alt="" /></div>' +
            '<div class="card-title" dir="auto">' + V.esc(a.name) + '</div><div class="card-sub">' + V.fmtSubs(a.subscribers) + '</div></button>'
          ).join("") + '</div>'
        : "") +
      (items.length ? '<h3 class="section-title">Songs</h3>' : "") +
      '<ul class="song-list">' + items.map(drRow).join("") + '</ul>' +
      (items.length && d.nextpage
        ? '<div class="load-more-wrap"><button class="btn ghost" id="load-more">' + (d.loadingMore ? '<span class="ring"></span> Loading…' : "Load more") + '</button></div>'
        : "") +
      (items.length ? '<p class="footnote">Tap the play button to listen instantly. Swipe a song right to queue it, left to keep it - pull further for the second action.</p>' : "");
  }

  /**
   * @param {string} [q]
   * @returns {DiscoverState}
   */
  function emptyDiscoverState(q) {
    return { q: q || "", items: [], artists: [], source: "", busy: false, error: null, kind: null, nextpage: null };
  }

  function searchDiscoveryHtml() {
    const d = discoverState;
    if (d.q || d.items.length) return "";
    const searches = Store.searches();
    return '<section class="search-discovery">' +
      (searches.length ? '<div class="section-head"><h3>Recent searches</h3><button id="clear-searches">Clear</button></div><div class="recent-searches">' + searches.map(q => '<button data-search="' + V.esc(q) + '">' + V.esc(q) + '</button>').join("") + '</div>' : "") +
      V.freshSearchHtml() + '<h3 class="search-browse-head">Browse all</h3>' + V.browseHtml() + '</section>';
  }

  // Reaching the end of a list is itself the request for more, so the button fires when it
  // scrolls into view. It stays in the DOM and still works on tap, as the fallback for
  // browsers without IntersectionObserver and for anyone who reaches for it.
  let loadMoreWatcher = null;
  function watchLoadMore(el, run) {
    if (loadMoreWatcher) { loadMoreWatcher.disconnect(); loadMoreWatcher = null; }
    if (!el || typeof IntersectionObserver !== "function") return;
    loadMoreWatcher = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) run();
    }, { root: V.view, rootMargin: "300px" });
    loadMoreWatcher.observe(el);
  }

  // A lyric is cached for anything whose words were ever looked up, which is a wider set
  // than the library - a song played once from search has them too.
  function knownTrack(id) {
    return Store.findTrack(id) || Store.recents().find(track => track.id === id) || null;
  }

  function lyricHitRow(track, line) {
    const cur = Player.current();
    const active = cur && cur.id === track.id;
    return '<li class="song' + (active ? " active" : "") + '" data-id="' + V.esc(track.id) + '" data-ctx="library">' +
      V.artHtml(track, "lg") +
      '<div class="meta"><div class="song-title" dir="auto">' + V.esc(track.title) + '</div>' +
      '<div class="song-sub lyric-hit" dir="auto">' + V.esc(line) + '</div></div>' +
      V.rowDlBtn(track.id) +
      '<button class="kebab" data-menu="' + V.esc(track.id) + '" aria-label="Actions"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button></li>';
  }

  function renderSearchHits() {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    const hits = document.getElementById("lib-hits");
    if (!input || !hits) return;
    const q = input.value.trim().toLowerCase();
    const matches = q ? Store.library().filter(t => !Store.isBlocked(t) && Store.matchesQuery(q, t.title, t.artist)).slice(0, 10) : [];
    // Titles first, then the songs that only matched on their words - a listener typing a
    // title wants the title, and one typing a half-remembered line has nothing else to go
    // on. Anything already listed above is not repeated down here.
    const seen = new Set(matches.map(track => track.id));
    const lyricHits = (q ? Store.searchLyrics(q, 8) : [])
      .map(hit => ({ line: hit.line, track: knownTrack(hit.id) }))
      .filter(hit => hit.track && !seen.has(hit.track.id) && !Store.isBlocked(hit.track));
    hits.innerHTML =
      (matches.length
        ? '<div class="status-line">In your library</div><ul class="song-list">' + matches.map(t => V.trackRow(t, "library")).join("") + '</ul>'
        : "") +
      (lyricHits.length
        ? '<div class="status-line">Matching lyrics</div><ul class="song-list">' +
          lyricHits.map(hit => lyricHitRow(hit.track, hit.line)).join("") + '</ul>'
        : "");
  }

  // Recent searches narrowed to whatever is being typed, so a returning query costs a
  // tap rather than a retyping. Hidden the moment a search actually commits, so it
  // never fights the results it just produced.
  let committedSearchQ = null;

  function renderSearchSuggestions(raw) {
    const box = document.getElementById("search-suggest");
    if (!box) return;
    const value = String(raw || "").trim();
    const matches = !value || value === committedSearchQ ? [] :
      Store.searches().filter(s =>
        s !== value && Store.foldText(s).indexOf(Store.foldText(value)) !== -1
      ).slice(0, 6);
    box.innerHTML = matches.length
      ? '<div class="section-head"><h3>Suggestions</h3></div><div class="recent-searches">' +
        matches.map(q => '<button data-search="' + V.esc(q) + '">' + V.esc(q) + '</button>').join("") + '</div>'
      : "";
  }

  // Repaints everything on the search tab except the text field itself, so typing
  // is never interrupted by a re-render (results, playback events, store updates).
  function refreshSearchView() {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    if (!input) return false;
    const clear = document.getElementById("disc-clear");
    if (clear) clear.style.display = input.value ? "" : "none";
    renderSearchSuggestions(input.value);
    const discovery = document.getElementById("search-discovery");
    if (discovery) discovery.innerHTML = searchDiscoveryHtml();
    const results = document.getElementById("yt-results");
    if (results) results.innerHTML = ytResultsHtml(discoverState);
    renderSearchHits();
    const more = document.getElementById("load-more");
    if (more) more.onclick = () => loadMore();
    watchLoadMore(discoverState.moreError ? null : more, loadMore);
    const retry = document.getElementById("search-retry");
    if (retry) retry.onclick = () => doSearch(discoverState.q);
    const clearSearches = document.getElementById("clear-searches");
    if (clearSearches) clearSearches.onclick = () => { Store.clearSearches(); refreshSearchView(); };
    return true;
  }

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
    "language-not-supported": "השפה הזו לא נתמכת בזיהוי הדיבור כאן."
  };

  function voiceOrbState() {
    return !voice ? "breathing" : voice.busy ? "searching" : voice.finishing ? "working"
      : voice.hearing ? "listening" : voice.recording ? "connecting" : "breathing";
  }

  // Shows the open request wherever it can be seen: in place on the Ask screen, and as an
  // event for anything else that draws it - driving mode does.
  function voicePaint() {
    V.paintAskOrb();
    window.dispatchEvent(new CustomEvent("aura-voice", { detail: voice ? {
      surface: voice.surface, state: voiceOrbState(), status: voice.status,
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
    if (V.askState.spoken) setAskText("", false);
    const pauseNeeded = Player.playbackRequested() || !Player.isPaused();
    if (!me.pausedTrack && pauseNeeded) me.pausedTrack = Player.current();
    // An interrupted or buffering player can appear paused while still intending
    // to resume. Clear that intent before microphone audio focus becomes active.
    if (pauseNeeded) Player.pause();
    // A loaded media element holds the iOS audio session and starves the microphone even
    // when it is only paused or waiting for a play tap (WebKit 321436; seen on device with
    // src:true and pauseNeeded false). Release it on every capture, not just when pausing;
    // releaseForVoice is a no-op when nothing is loaded, and the song reloads in place.
    if (Player.releaseForVoice) Player.releaseForVoice();
    me.recording = true;
    voiceSay(tr("רגע…"));
    me.capture = Voice.listen({
      lang: (window.I18n ? I18n.speechLanguage() : Store.settings().voiceLanguage || "he-IL"),
      // Music playing until now leaves the iOS audio session warm; let listen() idle and
      // settle it first so this request is not deaf on the second onward (WebKit 321436).
      settle: pauseNeeded,
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
    Promise.resolve(Voice.reply(messages, (window.I18n ? I18n.speechLanguage() : Store.settings().voiceLanguage || "he-IL"))).then(() => {
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
      voiceSay(tr("לא שמעתי בקשה"));
      voiceResume();
      return;
    }
    me.busy = true;
    voiceSay(tr("מחפש…"));
    const live = () => voice === me;
    const language = (window.I18n ? I18n.speechLanguage() : Store.settings().voiceLanguage || "he-IL");
    try {
      const result = await Voice.resolve(request, text => { if (live()) voiceSay(text); }, live);
      if (!live()) return;
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
      if (next) {
        const tracks = result.tracks.filter(track => !Store.isBlocked(track));
        if (!tracks.length) throw new Error(tr("לא ניתן להוסיף את השיר הזה לתור."));
        // Each goes in right after the current song, so inserting them last-first
        // keeps the list's own order.
        tracks.slice().reverse().forEach(track => Player.playNext(track));
      } else if (append) {
        const tracks = result.tracks.filter(track => !Store.isBlocked(track));
        if (!tracks.length) throw new Error(tr("לא ניתן להוסיף את השירים האלה לתור."));
        for (const track of tracks) { if (Player.addToQueue(track)) added++; }
      } else if (!Player.playQueue(result.tracks, 0)) throw new Error(tr("לא ניתן לנגן את השירים האלה."));
      // A request that only queued something hands the paused song back. One that
      // started new music must not: the song it paused is no longer the point.
      if (!queued) me.pausedTrack = null;
      setAskText("", false);
      voiceEnd();
      V.toast((queued ? next ? tr("השיר הבא בתור: ") : added ? tr("נוסף לסוף התור: ") : tr("כבר נמצא בתור: ")
        : tr("הבקשה נשלחה לנגן: ")) + result.label);
    } catch (e) {
      if (!live()) return;
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

  let liveSearchTimer = null;
  function cancelLiveSearch() {
    clearTimeout(liveSearchTimer);
    liveSearchTimer = null;
  }
  function renderSearch() {
    if (refreshSearchView()) return;
    const d = discoverState;
    V.view.innerHTML =
      '<div class="search-wrap"><div class="search-input">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>' +
      '<input type="search" id="disc-input" dir="auto" enterkeyhint="search" placeholder="Search any song, artist, album…" value="' + V.esc(d.q) + '" />' +
      '<button class="search-clear" id="disc-clear"' + (d.q ? "" : ' style="display:none"') + '>×</button>' +
      (Voice.supported() ? tr('<button class="search-mic" id="disc-mic" aria-label="בקשה קולית">') +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg></button>' : "") +
      '</div></div>' +
      '<div id="search-suggest"></div>' +
      '<div id="lib-hits"></div>' +
      '<div id="search-discovery">' + searchDiscoveryHtml() + '</div>' +
      '<div id="yt-results">' + ytResultsHtml(d) + '</div>';

    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    cancelLiveSearch();
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { cancelLiveSearch(); committedSearchQ = input.value.trim(); input.blur(); doSearch(input.value.trim()); }
    });
    const mic = document.getElementById("disc-mic");
    if (mic) mic.onclick = () => { Views.showTab("ai"); voiceStart("ask"); };
    document.getElementById("disc-clear").onclick = () => {
      cancelLiveSearch();
      searchRequest++;
      committedSearchQ = null;
      input.value = "";
      discoverState = emptyDiscoverState();
      refreshSearchView();
      input.focus();
    };
    input.addEventListener("input", () => {
      cancelLiveSearch();
      const value = input.value.trim();
      if (value !== discoverState.q) {
        searchRequest++;
        if (discoverState.busy) discoverState = emptyDiscoverState();
      }
      if (!value && discoverState.q) discoverState = emptyDiscoverState();
      refreshSearchView();
      if (value.length >= 2 && value !== discoverState.q) liveSearchTimer = setTimeout(() => doSearch(value), 450);
    });
    renderSearchHits();
    const more = document.getElementById("load-more");
    if (more) more.onclick = () => loadMore();
    watchLoadMore(discoverState.moreError ? null : more, loadMore);
    const retry = document.getElementById("search-retry");
    if (retry) retry.onclick = () => doSearch(discoverState.q);
    const clearSearches = document.getElementById("clear-searches");
    if (clearSearches) clearSearches.onclick = () => { Store.clearSearches(); refreshSearchView(); };
  }

  let searchRequest = 0;
  function showSearchState(q) {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    if (V.currentTab !== "search" || V.subView || !input) { V.render(); return; }
    if (q != null && document.activeElement !== input && input.value.trim() !== q) input.value = q;
    refreshSearchView();
  }

  async function doSearch(q) {
    if (!q) return;
    const request = ++searchRequest;
    committedSearchQ = q;
    discoverState = { q, items: [], artists: [], source: "", busy: true, error: null, kind: null, nextpage: null };
    showSearchState(q);
    try {
      const res = await Api.search(q);
      if (request !== searchRequest) return;
      Store.pushSearch(q);
      discoverState = { q, items: res.items.filter(t => !Store.isBlocked(t)), artists: res.artists || [], source: res.source, busy: false, error: null, kind: res.kind, base: res.base, filter: res.filter, page: res.page, nextpage: res.nextpage || null };
    } catch (e) {
      if (request !== searchRequest) return;
      discoverState = { q, items: [], artists: [], source: "", busy: false, error: "Search failed - no server reachable right now. Check your connection and try again.", kind: null, nextpage: null };
    }
    if (V.currentTab === "search" && !V.subView) showSearchState(q);
  }

  async function loadMore() {
    const state = discoverState;
    if (state.loadingMore || !state.nextpage) return;
    state.loadingMore = true;
    state.moreError = false;
    V.render();
    try {
      const more = await Api.searchMore(state, state.q);
      if (state !== discoverState) return;
      const seen = new Set(state.items.map(t => t.id));
      state.items = state.items.concat(more.items.filter(t => !seen.has(t.id) && seen.add(t.id) && !Store.isBlocked(t)));
      state.nextpage = more.nextpage || null;
      state.page = more.page;
    } catch (e) {
      state.moreError = true;
      if (state === discoverState) V.toast("Couldn't load more results - tap Load more to retry", "err");
    } finally {
      state.loadingMore = false;
      if (state === discoverState && V.currentTab === "search" && !V.subView) V.render();
    }
  }

  function openArtistByName(name, thumb) {
    // Tapping an artist should open that artist. It only did when they happened to be in
    // the library; everyone else - which is most of "Your top artists", built from what
    // was listened to rather than what was saved - fell through to a search box with
    // their name typed into it.
    const artistId = Store.artistIdFor ? Store.artistIdFor(name) : null;
    if (artistId) {
      V.pushSubView({ kind: "ytArtist", id: artistId, name, thumb: thumb || "" });
      return;
    }
    if (Store.artists().some(artist => artist.name === name)) { V.pushSubView({ kind: "artist", name }); return; }
    // Falling through to a search abandons any stacked screens; their entries go with
    // them. (The ytArtist branch above pushes a fresh entry instead, so it must not
    // spend anything here - a back() and a pushState in the same tick race.)
    V.spendSubViewEntries();
    V.currentTab = "search";
    V.subView = null;
    V.subViewStack = [];
    V.subViewScrollStack = [];
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
    doSearch(name);
  }

  function categorySpecs(sv) {
    return [
      ["Popular " + sv.title, sv.query + " popular hits"],
      ["New in " + sv.title, sv.query + " new releases"],
      [sv.title + " classics", sv.query + " classics"],
      ["Essential " + sv.title, sv.query + " essentials"]
    ];
  }

  function categoryCard(track, sectionIndex, trackIndex) {
    return V.gridCard(
      track.thumb,
      track.title,
      track.artist || "",
      'data-category-section="' + sectionIndex + '" data-category-track="' + trackIndex + '"',
      true
    );
  }

  function categorySearch(query) {
    // Search owns the per-request deadlines and tries relays after the primary APIs.
    // An outer ten-second timer discarded valid fallback results without stopping work.
    return Api.search(query, true);
  }

  // Everything the page is showing, top row first, so the button plays what is on screen
  // rather than some other idea of the category.
  function categoryTracks(sv) {
    const seen = new Set();
    const out = [];
    (sv.sections || []).forEach(section => {
      (section.tracks || []).forEach(track => {
        if (!track || !track.id || seen.has(track.id)) return;
        if (Store.isBlocked(track)) return;
        seen.add(track.id);
        out.push(track);
      });
    });
    return out;
  }

  function renderCategory(sv) {
    if (!sv.initialized) {
      sv.initialized = true;
      sv.sections = categorySpecs(sv).map(spec => ({ title: spec[0], query: spec[1], tracks: [], status: "loading" }));
      sv.sections.forEach(section => {
        categorySearch(section.query).then(result => {
          const seen = new Set(sv.sections.flatMap(item => item.tracks).map(track => track.id));
          section.tracks = (result.items || []).filter(track => !seen.has(track.id) && seen.add(track.id) && !Store.isBlocked(track)).slice(0, 10);
          section.status = "ready";
          if (V.subView === sv) V.render();
        }).catch(() => {
          section.status = "error";
          if (V.subView === sv) V.render();
        });
      });
    }

    const sections = sv.sections || [];
    const visibleSections = sections.filter(section => section.status === "loading" || section.tracks.length);
    const allDone = sections.length && sections.every(section => section.status !== "loading");
    V.view.innerHTML =
      '<section class="category-page" style="--category-color:' + V.esc(sv.color || "#477d95") + '">' +
      '<header class="category-hero"><div class="category-actions">' +
      '<button id="category-back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '<button id="category-share" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/></svg></button>' +
      '</div><div class="category-title-row"><h2 dir="auto">' + V.esc(sv.title) + '</h2>' +
      '<button class="category-play" id="category-play" aria-label="Play ' + V.esc(sv.title) + '"' +
      (categoryTracks(sv).length ? "" : " disabled") +
      '><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4.5 19.5,12 7,19.5"/></svg></button></div></header>' +
      '<div class="category-sticky" dir="auto">' + V.esc(sv.title) + '</div>' +
      '<div class="category-content">' +
      (visibleSections.length ? visibleSections.map(section => {
        const sectionIndex = sections.indexOf(section);
        return '<section class="category-section"><h3 dir="auto">' + V.esc(section.title) + '</h3>' +
          (section.status === "loading" ? '<div class="category-skeleton"><i></i><i></i><i></i></div>' :
            '<div class="category-rail">' + unblocked(section.tracks).map((track, trackIndex) => categoryCard(track, sectionIndex, trackIndex)).join("") + '</div>') +
          '</section>';
      }).join("") : allDone ? '<div class="category-loading"><strong>Nothing to show right now</strong><span>Check your connection and try again.</span><button class="btn ghost" id="category-retry">Try again</button></div>' : "") +
      '</div></section>';

    const playBtn = document.getElementById("category-play");
    if (playBtn) playBtn.onclick = () => {
      const all = categoryTracks(sv);
      if (!all.length) return;
      Player.setShuffle(false);
      Player.playQueue(all, 0);
    };
    document.getElementById("category-back").onclick = () => V.dismissViaHistory(V.popSubView);
    document.getElementById("category-share").onclick = async () => {
      const data = { title: sv.title + " on Aura", text: "Listen to " + sv.title + " on Aura", url: location.href };
      try {
        if (navigator.share) await navigator.share(data);
        else {
          await navigator.clipboard.writeText(location.href);
          V.toast("Link copied");
        }
      } catch (e) {}
    };
    const retry = document.getElementById("category-retry");
    if (retry) retry.onclick = () => { sv.initialized = false; sv.sections = []; V.render(); };
  }
})();
