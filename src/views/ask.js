(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    askHistoryContext: { get: () => askHistoryContext },
    getTasteAnchor: { get: () => getTasteAnchor },
    inTasteWorld: { get: () => inTasteWorld },
    paintAskOrb: { get: () => paintAskOrb },
    renderAsk: { get: () => renderAsk },
    runAsk: { get: () => runAsk }
  });

  // ---------------- Ask (AI playlists) ----------------

  // What the request gets told about this listener, so "something for tonight" comes
  // back shaped like their taste instead of generic chart fodder. Kept as a plain
  // sentence rather than raw objects - it is the model's context, not data it acts on.
  function askHistoryContext() {
    const artists = Store.topListeningArtists(8)
      .filter(a => a.name)
      .sort((a, b) => b.plays - a.plays)
      .map(a => a.name + " (" + a.plays + ")");
    const tracks = Store.topListeningTracks(10).map(t => t.title + (t.artist ? " by " + t.artist : ""));
    const parts = [];
    if (artists.length) parts.push("Artists this listener plays most, with play counts: " + artists.join(", ") + ".");
    if (tracks.length) parts.push("Recently played: " + tracks.join("; ") + ".");
    return parts.join(" ");
  }

  // Prompts steer a model, they do not bind it, so taste is enforced structurally too.
  // A suggestion belongs to this listener's world when its artist is one they actually
  // play - history, library, downloads - or when YouTube itself files the video next to
  // music they play, which clusters by scene better than any genre tag would. Derived
  // entirely from the device; nothing here is specific to one listener's taste.
  let tasteAnchor = { sig: null, known: null, related: null };
  async function getTasteAnchor() {
    const seeds = Store.topListeningTracks(5);
    const sig = seeds.map(t => t.id).join(":");
    if (!sig) return null;
    if (tasteAnchor.sig === sig) return tasteAnchor;
    const known = new Set();
    const addArtist = name => {
      const key = Store.foldText(name);
      if (key) known.add(key);
    };
    Store.topListeningArtists(20).forEach(a => addArtist(a.name));
    Store.library("music").forEach(t => addArtist(t.artist));
    Store.recents().filter(t => Store.mediaKind(t) === "music").forEach(t => addArtist(t.artist));
    if (Store.downloadedTracks) Store.downloadedTracks("music").forEach(t => addArtist(t.artist));
    const related = new Set();
    await Promise.all(seeds.map(async seed => {
      try {
        const info = await Api.resolve(seed.id);
        ((info && info.related) || []).forEach(r => { if (r && r.id) related.add(r.id); });
      } catch (e) {}
    }));
    // Built with no answers - offline, every server down - it is not worth remembering:
    // kept, it left the related half of the filter empty for the rest of the session.
    if (!related.size) return { sig, known, related };
    tasteAnchor = { sig, known, related };
    return tasteAnchor;
  }
  function inTasteWorld(anchor, track) {
    if (!anchor) return true;
    if (track.artist && anchor.known.has(Store.foldText(track.artist))) return true;
    return anchor.related.has(track.id);
  }

  // The orb on the Ask screen is the AI. At rest it breathes and takes a voice request;
  // while a request is out it shows the step that is actually running, with a few words
  // for it underneath, so the wait reports what it is made of: [orb state, words].
  const ASK_STEPS = {
    taste: ["weaving", "Reading your taste\u2026"],
    writing: ["composing", "Writing the playlist\u2026"],
    matching: ["searching", "Finding the songs\u2026"]
  };

  // The one line under the orb: the step of a request that is out, else what a spoken
  // request is doing, else the invitation to make one. One line on purpose - the screen
  // is the orb, and the orb already says most of it.
  function askNote() {
    if (V.askState.status === "loading") return (ASK_STEPS[V.askState.step] || ASK_STEPS.taste)[1];
    if (V.voice && V.voice.status) return V.voice.status;
    return tr("לחצו ודברו");
  }

  // The orb and its words change in place. Repainting would rebuild the text field, and
  // someone typing into it - or watching their own words arrive in it - would lose it.
  function paintAskOrb() {
    const loading = V.askState.status === "loading";
    const state = loading ? (ASK_STEPS[V.askState.step] || ASK_STEPS.taste)[0] : V.voiceOrbState();
    ["ask-orb", "ask-go-orb"].forEach(id => {
      const orb = document.getElementById(id);
      if (orb) orb.setAttribute("state", state);
    });
    const note = document.getElementById("ask-note");
    if (note) note.textContent = askNote();
    const mic = document.getElementById("ask-voice");
    if (!mic) return;
    const open = !!V.voice && (V.voice.recording || V.voice.finishing);
    mic.classList.toggle("listening", !!V.voice && V.voice.hearing);
    mic.setAttribute("aria-pressed", open ? "true" : "false");
    mic.setAttribute("aria-label", V.voice && V.voice.busy ? tr("ביטול הבקשה") : open ? tr("עצירת האזנה") : tr("בקשה קולית, לחצו ודברו"));
  }

  function askStep(name) {
    V.askState.step = name;
    paintAskOrb();
  }

  function askHtml() {
    const has = V.askState.tracks.length > 0;
    const loading = V.askState.status === "loading";
    const state = loading ? (ASK_STEPS[V.askState.step] || ASK_STEPS.taste)[0] : V.voiceOrbState();
    const listening = !!V.voice && (V.voice.recording || V.voice.finishing);
    return '<div class="search-wrap"><div class="search-input ask-input">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>' +
      '<textarea id="ask-prompt" rows="1" dir="auto" placeholder="Something calm for studying, 2000s pop-rock for a road trip…">' + V.esc(V.askState.prompt) + '</textarea>' +
      '</div></div>' +
      '<div class="row-actions"><button class="btn primary" id="ask-go"' + (loading ? " disabled" : "") + '>' +
      (loading ? '<thinking-orb id="ask-go-orb" state="' + state + '" size="20" theme="light" aria-hidden="true"></thinking-orb> Thinking…' : "Ask AI") + '</button></div>' +
      '<div class="voice-entry">' +
      '<button type="button" class="voice-orb' + (V.voice && V.voice.hearing ? " listening" : "") + '" id="ask-voice" aria-pressed="' + listening + '"' +
      ' aria-label="' + (V.voice && V.voice.busy ? tr("ביטול הבקשה") : listening ? tr("עצירת האזנה") : tr("בקשה קולית, לחצו ודברו")) + '"' + (loading ? " disabled" : "") + '>' +
      '<thinking-orb id="ask-orb" state="' + state + '" px="160" aria-hidden="true"></thinking-orb></button>' +
      // Only the words are the live region: around the button too, every change would
      // read the button's name out again. Hebrew or English, the line finds its own side.
      '<p id="ask-note" role="status" dir="auto">' + V.esc(askNote()) + '</p>' +
      '</div>' +
      (V.askState.status === "error" ? '<div class="status-line err">' + V.esc(V.askState.error) + '</div>' : "") +
      (has ?
        '<div class="section-head"><h3 dir="auto">' + V.esc(V.askState.name) + '</h3></div>' +
        '<div class="status-line">' + V.askState.tracks.length + " song" + (V.askState.tracks.length === 1 ? "" : "s") +
        " · " + Math.round(V.askState.tracks.reduce((a, t) => a + (t.duration || 0), 0) / 60) + " min" +
        (V.askState.notFound ? " · " + V.askState.notFound + " suggestion(s) weren't found" : "") + '</div>' +
        '<div class="row-actions"><button class="btn ghost" id="ask-play-all"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Play all</button>' +
        '<button class="btn ghost" id="ask-shuffle">Shuffle</button>' +
        '<button class="btn ghost" id="ask-save">Save as playlist</button>' +
        '<button class="btn ghost" id="ask-retry"' + (loading ? " disabled" : "") + '>↻ Ask again</button></div>' +
        '<ul class="song-list">' + V.askState.tracks.map(t => V.trackRow(t, "ask")).join("") + '</ul>'
        : "");
  }

  function renderAsk() {
    V.paint(V.view, '<div class="ask-page">' + askHtml() + '</div>');
    wireAsk();
  }

  function paintAsk() {
    const holder = document.querySelector(".ask-page");
    if (holder) V.paint(holder, askHtml());
    wireAsk();
  }

  function wireAsk() {
    const mic = document.getElementById("ask-voice");
    if (mic) mic.onclick = () => V.voiceStart("ask");
    const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("ask-prompt"));
    const go = document.getElementById("ask-go");
    if (go) go.onclick = () => V.submitAsk(input.value);
    if (input) {
      input.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) V.submitAsk(input.value); });
      input.addEventListener("beforeinput", V.voiceEdit);
      // Starts the same height as the search bar and only grows past one line once
      // there is more to show, instead of always showing empty extra rows.
      const grow = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
      input.addEventListener("input", () => {
        V.voiceEdit();
        V.askState.prompt = input.value;
        // An emptied field forgets where its words came from.
        if (!input.value.trim()) V.askState.spoken = false;
        grow();
      });
      grow();
    }
    const playAll = document.getElementById("ask-play-all");
    if (playAll) playAll.onclick = () => { if (V.askState.tracks.length) Player.playQueue(V.askState.tracks.slice(), 0); };
    const shuffle = document.getElementById("ask-shuffle");
    if (shuffle) shuffle.onclick = () => {
      if (!V.askState.tracks.length) return;
      Player.setShuffle(true);
      Player.playQueue(V.askState.tracks.slice(), Math.floor(Math.random() * V.askState.tracks.length));
    };
    const save = document.getElementById("ask-save");
    if (save) save.onclick = () => { if (V.askState.tracks.length) V.openPlaylistPickerBulk(V.askState.tracks, V.askState.name); };
    const retry = document.getElementById("ask-retry");
    if (retry) retry.onclick = () => runAsk(V.askState.prompt, true);
  }

  // One request-and-match round: asks for songs, resolves each to a real track, and
  // keeps only the ones that both matched and actually look like music - a suggested
  // "song" occasionally matches something that is not one at all (a shofar recording, a
  // sketch, whatever the closest title match on YouTube happens to be), and the model's
  // word for it is not proof either way.
  async function fetchAndMatch(prompt, history, avoidList) {
    askStep("writing");
    const parsed = await Ai.generatePlaylist(prompt, null, history, (avoidList || []).concat(V.blockedAvoidLabels()));
    askStep("matching");
    const list = parsed.tracks.map((item, index) => ({ item, index }));
    const suggestedLabels = parsed.tracks.map(t => t.title + " - " + t.artist);
    const matches = new Array(list.length);
    const workers = Array.from({ length: 3 }, async () => {
      while (list.length) {
        const entry = list.shift();
        try {
          const t = await Api.matchTrack(entry.item.title, entry.item.artist);
          if (t && Api.looksLikeMusic(t) && !Store.isBlocked(t)) matches[entry.index] = t;
        } catch (e) {}
      }
    });
    await Promise.all(workers);
    // Two suggestions ("Song" and "Song (Remastered)") can land on the same upload.
    const seen = new Set();
    const found = matches.filter(t => t && !seen.has(t.id) && seen.add(t.id));
    return { name: parsed.name, targetSeconds: parsed.targetSeconds, requestedCount: parsed.requestedCount, suggestedLabels, found };
  }

  async function runAsk(promptText, isRetry) {
    const ask = String(promptText || "").trim();
    if (!ask || V.askState.status === "loading") return;
    if (!window.Ai || !Ai.hasAnyKey()) {
      V.toast("Add a Gemini or Groq API key in Settings first");
      V.openSettings();
      return;
    }
    const avoid = isRetry ? V.askState.tracks.map(t => t.title + " - " + t.artist) : null;
    V.askState.prompt = ask;
    V.askState.status = "loading";
    V.askState.step = "taste";
    V.askState.error = "";
    paintAsk();
    const history = askHistoryContext();
    let anchor, result, suggestedTotal;
    try {
      anchor = await getTasteAnchor();
      result = await fetchAndMatch(ask, history, avoid);
      suggestedTotal = result.suggestedLabels.length;
    } catch (e) {
      V.askState.status = "error";
      V.askState.error = String(e.message || e);
      paintAsk();
      return;
    }
    let found = result.found;
    let strict = anchor ? found.filter(t => inTasteWorld(anchor, t)) : found;
    // Whatever was asked for - a number of songs or a length of listening - comes back
    // meaningfully short once matching and the taste gate have had their say. Follow-up
    // rounds ask for more of the same before settling for less. A stated length is
    // measured in the real seconds already in hand, so an hour and a half keeps asking
    // while the answer is still half an hour; the old guard gave up as soon as one full
    // reply had come back, which is exactly the shape a long request comes back in.
    const enoughFor = list => {
      if (result.targetSeconds) return list.reduce((a, t) => a + (t.duration || 0), 0) >= result.targetSeconds;
      const want = result.requestedCount || 0;
      return !want || list.length >= Math.max(5, Math.ceil(want * 0.6));
    };
    let asked = (avoid || []).concat(result.suggestedLabels);
    // A length worth filling is worth two extra rounds; a plain "some songs please" is
    // not, and keeps the single follow-up it always had.
    const maxRounds = result.targetSeconds ? 2 : 1;
    for (let round = 0; round < maxRounds && !enoughFor(strict); round++) {
      try {
        const more = await fetchAndMatch(ask, history, asked);
        const have = new Set(found.map(t => t.id));
        const freshRaw = more.found.filter(t => !have.has(t.id));
        found = found.concat(freshRaw);
        strict = strict.concat(anchor ? freshRaw.filter(t => inTasteWorld(anchor, t)) : freshRaw);
        suggestedTotal += more.suggestedLabels.length;
        asked = asked.concat(more.suggestedLabels);
        if (!freshRaw.length) break;
      } catch (e) { break; }
    }
    // The gated set wins whenever it holds enough to fill a playlist; a looser answer
    // still beats an empty one.
    const pool = strict.length >= 5 ? strict : found;
    if (!pool.length) {
      V.askState.status = "error";
      V.askState.error = "Couldn't find any of those songs - try rephrasing";
      paintAsk();
      return;
    }
    // A requested length is matched against the real durations that came back, not
    // the model's guess at them - stopping as soon as the running total reaches it, rather
    // than cutting a song short to land exactly on it.
    let fitted = pool;
    if (result.targetSeconds) {
      // The taste gate can still leave too little to fill a stated length. Its picks
      // lead, and the rest of what matched only tops up the tail - the playlist runs the
      // length that was asked for instead of ending twenty minutes early.
      const inPool = new Set(pool.map(t => t.id));
      const ordered = pool.concat(found.filter(t => !inPool.has(t.id)));
      fitted = [];
      let seconds = 0;
      for (const t of ordered) {
        fitted.push(t);
        seconds += t.duration || 0;
        if (seconds >= result.targetSeconds) break;
      }
      // A tiny or badly estimated length still never shrinks the answer below five songs,
      // when the matched pool holds more - a slightly longer playlist beats a stub.
      if (fitted.length < 5) fitted = ordered.slice(0, 5);
      if (window.Log) Log.add("ai", "fitted " + fitted.length + " song(s) to " +
        Math.round(result.targetSeconds / 60) + " min from " + pool.length + " in-world of " + found.length + " matched");
    }
    V.askState.status = "done";
    V.askState.name = result.name || ask;
    V.askState.tracks = fitted;
    V.askState.notFound = suggestedTotal - found.length;
    paintAsk();
  }
})();
