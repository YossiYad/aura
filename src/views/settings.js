(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    applyAppearance: { get: () => applyAppearance },
    askLanguage: { get: () => askLanguage },
    openSettings: { get: () => openSettings },
    renderSettingsPage: { get: () => renderSettingsPage },
    renderStatsPage: { get: () => renderStatsPage },
    syncServerMixKey: { get: () => syncServerMixKey }
  });

  /** Opens the settings screen. */
  function openSettings() {
    if (V.subView && V.subView.kind === "settings") return;
    V.pushSubView({ kind: "settings" });
  }

  // Asked once, on the first launch that has no language saved. Both languages speak for
  // themselves on the same card, so the question is readable before it is answered, and
  // the one the browser prefers takes the focus. Closing the card without picking keeps
  // English, the default, and saves it so the question is not asked again.
  /** Asks which interface language to use, unless the listener has already chosen. */
  function askLanguage() {
    if (!window.I18n || I18n.chosen()) return;
    const choice = (code, name, note) =>
      '<button type="button" class="lang-choice" data-lang-pick="' + code + '" lang="' + code + '" dir="' + (code === "he" ? "rtl" : "ltr") + '">' +
        '<strong>' + name + '</strong><span>' + note + '</span></button>';
    V.openModal(
      '<div class="modal lang-welcome" role="dialog" aria-modal="true" aria-labelledby="lang-welcome-title">' +
        '<h3 id="lang-welcome-title"><span lang="en">Choose your language</span> · <span lang="he" dir="rtl">בחרו שפה</span></h3>' +
        '<div class="lang-choices">' +
          choice("en", "English", "Aura and its AI answers in English") +
          choice("he", "עברית", "בקשות קוליות ותשובות AI בעברית") +
        '</div>' +
        '<p class="lang-hint"><span lang="en">You can change this any time in Settings › Look.</span> ' +
          '<span lang="he" dir="rtl">אפשר לשנות בכל עת בהגדרות.</span></p>' +
      '</div>');
    let picked = false;
    V.modalCleanup = () => {
      if (!picked) try { I18n.setLanguage(I18n.language()); } catch (e) {}
    };
    const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll("[data-lang-pick]"));
    buttons.forEach(button => {
      button.onclick = () => {
        if (picked) return;
        picked = true;
        try { I18n.setLanguage(button.dataset.langPick); } catch (e) {}
        V.dismissViaHistory(() => { V.closeModal(); V.scrimEl.hidden = true; });
        V.render();
      };
    });
    // The launch cover hides the page, and a hidden button cannot take focus, so the
    // suggested language is focused once the cover lifts.
    const suggested = /** @type {HTMLElement} */ (document.querySelector('[data-lang-pick="' + I18n.suggested() + '"]'));
    const root = document.documentElement;
    const focusSuggested = () => { if (suggested && suggested.isConnected && !picked) suggested.focus(); };
    if (!root.classList.contains("app-starting") || !window.MutationObserver) { focusSuggested(); return; }
    const cover = new MutationObserver(() => {
      if (root.classList.contains("app-starting")) return;
      cover.disconnect();
      focusSuggested();
    });
    cover.observe(root, { attributes: true, attributeFilter: ["class"] });
  }

  // iPhones have no system Back inside a standalone PWA - Android's hardware Back and
  // its history ledger never existed there. Those devices get an explicit way out,
  // rendered only for them so every other platform keeps the screen as it was.
  const IS_IPHONE = /iPhone|iPod/i.test(navigator.userAgent);

  // Accent presets are pure CSS-variable swaps keyed off <html data-accent>, so picking
  // one repaints every screen without touching a component. "green" is what the token
  // sheet ships, and clearing the attribute returns to it.
  const ACCENT_CHOICES = [
    ["green", "#1FE079"],
    ["blue", "#4A9DF8"],
    ["purple", "#A78BFA"],
    ["orange", "#FB923C"],
    ["pink", "#F472B6"],
    ["mono", "#E9EBE6"]
  ];

  // Text size scales what is read - lists, sheets, dialogs, labels - by one factor each,
  // set in CSS against <html data-text-size>. "default" is the design as drawn.
  const TEXT_SIZES = [["default", "Default"], ["large", "Large"], ["larger", "Larger"]];

  /** Applies the accent, animation, text size, contrast and timeline style settings to the page. */
  function applyAppearance() {
    const s = Store.settings();
    const root = document.documentElement;
    if (s.accent && s.accent !== "green" && ACCENT_CHOICES.some(a => a[0] === s.accent)) root.setAttribute("data-accent", s.accent);
    else root.removeAttribute("data-accent");
    root.classList.toggle("no-anim", s.animations === false);
    if (s.textSize && s.textSize !== "default" && TEXT_SIZES.some(z => z[0] === s.textSize)) root.setAttribute("data-text-size", s.textSize);
    else root.removeAttribute("data-text-size");
    root.classList.toggle("high-contrast", s.highContrast === true);
    // Loaded after this file, and absent on a page that shows no timeline.
    if (window.SongProgress) SongProgress.setStyle(s.progressStyle);
  }

  // What the scrobbler rule already recorded, finally shown back: the same half-the-track
  // threshold that feeds recents and recommendations, so nothing here counts a tap.
  function statTile(num, label) {
    return '<div class="stat-tile"><span class="stat-num">' + V.esc(num) + '</span><span class="stat-label">' + V.esc(label) + '</span></div>';
  }

  function renderStatsPage() {
    const allTracks = Store.topListeningTracks(99999);
    const artists = Store.topListeningArtists(50);
    const tracks = allTracks.slice(0, 50);
    let totalPlays = 0;
    let estSeconds = 0;
    allTracks.forEach(t => {
      totalPlays += t.plays || 0;
      if (t.duration > 0) estSeconds += t.duration * t.plays;
    });
    const hours = Math.floor(estSeconds / 3600);
    const mins = Math.round((estSeconds % 3600) / 60);
    const timeLabel = hours ? hours + " h " + mins + " min" : mins + " min";

    V.view.innerHTML =
      '<div class="setpage">' +
      '<div class="setpage-head">' +
      (IS_IPHONE ? '<button class="back-btn" id="stats-back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' : '') +
      '<h2>Listening stats</h2>' +
      '<p>Counted as played: half the track or four minutes, whichever comes first.</p></div>' +
      (!allTracks.length
        ? V.emptyState("Nothing counted yet", "Songs show up here once they are listened through.", "Find music")
        : '<div class="stats-grid">' +
          statTile(totalPlays, "plays") +
          statTile(allTracks.length, "songs") +
          statTile(timeLabel, "listened") +
          '</div>') +
      (artists.length ? '<div class="section-head"><h3>Top artists</h3></div><div class="rail artists home-artists">' +
        artists.map(a => V.gridCard(a.thumb, a.name, a.plays + " plays", 'data-artist="' + V.esc(a.name) + '"', false)).join("") + '</div>' : "") +
      (tracks.length ? '<div class="section-head"><h3>Top songs</h3></div><ul class="song-list">' +
        tracks.map(t => V.trackRow(t, "library")).join("") + '</ul>' : "") +
      '</div>';

    const backBtn = document.getElementById("stats-back");
    if (backBtn) backBtn.onclick = () => V.dismissViaHistory(V.popSubView);
    const cta = document.getElementById("empty-cta");
    if (cta) cta.onclick = () => Views.showTab("search");
  }

  const SETTINGS_ICONS = {
    appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z"/>',
    playback: '<path d="M8 5v14l11-7z"/>',
    driving: '<path d="M3 13l1.8-5.2A2 2 0 0 1 6.7 6.5h10.6a2 2 0 0 1 1.9 1.3L21 13"/><path d="M3 13h18v4H3z"/><path d="M7 17.5h.01"/><path d="M17 17.5h.01"/>',
    notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    ai: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>',
    blocked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    private: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><path d="M4 4l16 16"/>',
    backup: '<path d="M12 16V4"/><path d="M8 8l4-4 4 4"/><path d="M5 13v6h14v-6"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
    danger: '<path d="M12 3L2.7 20h18.6z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
  };

  function settingsIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SETTINGS_ICONS[name] || SETTINGS_ICONS.ai) + '</svg>';
  }
  let activeSettingsTab = "appearance";
  function setSection(id, label, inner, tone) {
    const tab = id === "daily" ? "ai" : id === "backup" ? "storage" : id === "danger" || id === "private" ? "blocked" : id;
    return '<section class="set-block' + (tone ? ' ' + tone : '') + '" id="settings-' + id + '" role="tabpanel" aria-labelledby="settings-tab-' + tab + '" data-settings-panel="' + tab + '"' + (tab !== activeSettingsTab ? ' hidden' : '') + '>' +
      '<div class="set-sec-head"><span class="set-sec-icon">' + settingsIcon(id) + '</span><div class="set-sec-label">' + V.esc(label) + '</div></div>' +
      '<div class="set-card">' + inner + '</div></section>';
  }
  function setTextPair(title, sub) {
    return '<span class="set-text"><span class="set-title">' + V.esc(title) + '</span>' +
      (sub ? '<span class="set-sub">' + V.esc(sub) + '</span>' : '') + '</span>';
  }
  function toggleRow(id, title, sub, on) {
    return '<label class="set-item">' + setTextPair(title, sub) +
      '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' /><span class="switch"></span></label>';
  }
  // The buttons of a choice are named by the row's title, so a screen reader says what
  // "Large" or "Night" is a choice of.
  function choiceRow(title, sub, inner) {
    return '<div class="set-item col">' + setTextPair(title, sub) +
      inner.replace('role="group"', 'role="group" aria-label="' + V.esc(title) + '"') + '</div>';
  }
  // The lit button in the player is the only other place this shows, and the player is not
  // on screen while Settings is. Someone who came here to check has come to the right place.
  function privateStatusText() {
    if (Store.settings().privateSession === false) return "Hidden. Everything you play is recorded.";
    return Store.privateSession()
      ? "A private session is running - nothing you play is being recorded. It ends when you close the app."
      : "Off. Everything you play is recorded as usual.";
  }

  function nightlyStatusText() {
    if (!window.Nightly) return "";
    const state = Nightly.describe();
    if (state.running) return "Preparing Home now…";
    if (!state.enabled) return "Home is built as you open it.";
    const clock = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = ts => {
      const then = new Date(ts); then.setHours(0, 0, 0, 0);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((today.getTime() - then.getTime()) / 86400000);
      return diff <= 0 ? "today" : diff === 1 ? "yesterday" : new Date(ts).toLocaleDateString();
    };
    if (!state.at) return "Hasn't run yet · next at " + clock(state.next);
    return "Last prepared " + day(state.at) + " at " + clock(state.at) +
      (state.failed ? " · " + state.failed + " part" + (state.failed === 1 ? "" : "s") + " failed" : "") +
      " · next at " + clock(state.next);
  }

  function updateNightlyStatus() {
    const el = document.getElementById("set-nightly-status");
    if (el && el.isConnected) el.textContent = nightlyStatusText();
  }
  if (window.Nightly) Nightly.onChange(updateNightlyStatus);

  // ---- Handing your AI key to the server that builds the mix ----
  //
  // Everyone has their own key, so a mix built on the server has to be built with the key
  // of the person it is for. That means the key leaving this device, which is the one
  // thing the app otherwise never does - so it only ever goes to a server that is
  // same-origin, behind this listener's own sign-in, and answering as the mix builder.
  // There is nowhere else it can go: the public app has no such server and none of this
  // runs there. The switch in Settings turns it off, and turning it off deletes the copy
  // already on the server rather than merely stopping the next one.
  const SERVER_MIX_SENT = "aura.serverMixKeySent";

  function serverMixWanted() { return Store.settings().serverMixKey !== false; }

  // Which keys were last handed over, as a short digest rather than a second copy of the
  // keys themselves. It exists so a launch that changed nothing does not send again.
  function serverMixFingerprint() {
    const parts = [Ai.getKeys("gemini").join(","), Ai.getKeys("groq").join(","),
      Ai.getMode(), Ai.getModelStored("gemini"), Ai.getModelStored("groq")].join("|");
    let h = 5381;
    for (let k = 0; k < parts.length; k++) h = ((h * 33) ^ parts.charCodeAt(k)) >>> 0;
    return parts.length + ":" + h.toString(36);
  }

  async function serverMixSendKey() {
    const res = await fetch("/api/mix/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gemini: Ai.getKeys("gemini"),
        groq: Ai.getKeys("groq"),
        mode: Ai.getMode(),
        geminiModel: Ai.getModelStored("gemini"),
        groqModel: Ai.getModelStored("groq")
      })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    try { localStorage.setItem(SERVER_MIX_SENT, serverMixFingerprint()); } catch (e) {}
  }

  async function serverMixForgetKey() {
    const res = await fetch("/api/mix/key", { method: "DELETE" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    try { localStorage.removeItem(SERVER_MIX_SENT); } catch (e) {}
  }

  // Runs at startup, and again whenever the switch or the keys change. Silent when there
  // is nothing to do, which is almost always: it sends only when the server holds no key
  // of this listener's yet, or when the keys on this device have changed since last time.
  let serverMixSyncing = false;
  async function syncServerMixKey(known) {
    if (serverMixSyncing) return null;
    serverMixSyncing = true;
    try {
      const info = known || await V.serverMixState();
      if (!info) return null;
      if (!serverMixWanted()) {
        try { localStorage.removeItem(SERVER_MIX_SENT); } catch (e) {}
        if (!info.ownKey) return info;
        await serverMixForgetKey();
        if (window.Log) Log.add("ai", "took this device's key back off the server");
        return await V.serverMixState();
      }
      // A different device may own the account's server key. Only an explicit switch
      // change revokes it; absence of a local key is not a deletion request.
      if (!Ai.hasAnyKey()) return info;
      let sent = "";
      try { sent = localStorage.getItem(SERVER_MIX_SENT) || ""; } catch (e) {}
      if (info.ownKey && sent === serverMixFingerprint()) return info;
      const updating = info.ownKey;
      await serverMixSendKey();
      if (window.Log) Log.add("ai", updating
        ? "updated the key the server builds your mix with"
        : "handed this device's key to the server that builds the nightly mix");
      return await V.serverMixState();
    } catch (e) {
      if (window.Log) Log.add("ai", "server mix key handoff failed: " + String((e && e.message) || e).slice(0, 60));
      return null;
    } finally {
      serverMixSyncing = false;
    }
  }

  function serverMixStatusText(info) {
    const at = h => new Date(2000, 0, 1, h, 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const built = info.at
      ? " Last built " + new Date(info.at).toLocaleDateString() + " at " +
        new Date(info.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "."
      : "";
    if (info.ownKey) return "Your key is on the server, which builds your mix at " + at(info.hour) + "." + built;
    if (!serverMixWanted()) {
      return info.sharedKey
        ? "Your key stays on this device. The server builds your mix at " + at(info.hour) + " with its own." + built
        : "Your key stays on this device, so the mix is built here instead.";
    }
    if (info.sharedKey) return "This server builds your mix at " + at(info.hour) + " with its own key." + built;
    return "Add an AI key above and it goes to the server on its own, so the mix is ready before you open the app.";
  }

  async function updateServerMix(known) {
    const row = document.getElementById("set-servermix-row");
    const statusEl = document.getElementById("set-servermix-status");
    if (!row || !row.isConnected || !statusEl) return;
    const info = known || await V.serverMixState();
    if (!row.isConnected) return;
    // No such server - the public app, or a self-hosted setup without the container.
    // Nothing to offer, so nothing is shown.
    if (!info) { row.hidden = true; statusEl.hidden = true; return; }
    row.hidden = false;
    statusEl.hidden = false;
    statusEl.textContent = serverMixStatusText(info);
  }

  function nightlyHourPicker(current) {
    let out = '<div class="ai-add-row"><select id="set-nightly-hour" aria-label="Daily prep time">';
    for (let h = 0; h < 24; h++) {
      const label = new Date(2000, 0, 1, h, 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      out += '<option value="' + h + '"' + (h === current ? " selected" : "") + '>' + V.esc(label) + '</option>';
    }
    return out + '</select></div>';
  }

  function segControl(id, options, current) {
    return '<div class="seg" id="' + id + '" role="group">' + options.map(o => {
      const selected = String(current) === String(o[0]);
      return '<button type="button" data-val="' + o[0] + '" aria-pressed="' + selected + '"' + (selected ? ' class="on"' : '') + '>' + V.esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function settingsLink(id, title, sub, icon, danger) {
    return '<button type="button" class="set-link' + (danger ? ' danger' : '') + '" id="' + id + '">' +
      '<span class="set-link-icon">' + settingsIcon(icon) + '</span>' + setTextPair(title, sub) +
      '<svg class="set-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>';
  }

  function aiKeysHtml(provider) {
    const keys = Ai.getKeys(provider);
    if (!keys.length) return "";
    return '<div class="ai-keys">' + keys.map((k, i) =>
      '<div class="ai-key-row"><span class="ai-key-mask">•••• ' + V.esc(k.slice(-4)) + '</span>' +
      '<span class="ai-key-actions">' +
      '<button class="text-action" data-ai-test="' + provider + '" data-ai-test-index="' + i + '">Test</button>' +
      '<button class="text-action" data-ai-remove="' + provider + '" data-ai-remove-index="' + i + '">Remove</button>' +
      '</span></div>'
    ).join("") + '</div>';
  }

  // The model is picked from a short list with an escape hatch: "Other…" reveals a text
  // field for any id the lists do not know about yet.
  function aiModelPickerHtml(provider) {
    const stored = Ai.getModelStored(provider);
    const models = Ai.models(provider);
    const custom = !!stored && models.indexOf(stored) === -1;
    const opt = (value, text, on) =>
      '<option value="' + V.esc(value) + '"' + (on ? " selected" : "") + '>' + V.esc(text) + '</option>';
    return '<div class="ai-add-row ai-model-row"><select id="set-ai-model-pick-' + provider + '" aria-label="' + V.esc(Ai.label(provider)) + ' model">' +
      opt("", "Default (" + Ai.defaultModel(provider) + ")", !stored) +
      models.map(m => opt(m, m, stored === m)).join("") +
      opt("__custom__", "Other…", custom) +
      '</select>' +
      '<input type="text" id="set-ai-model-' + provider + '" placeholder="Custom model id" autocomplete="off"' +
      (custom ? '' : ' style="display:none"') +
      ' value="' + V.esc(custom ? stored : "") + '" /></div>';
  }

  function aiProviderBlockHtml(provider) {
    const label = Ai.label(provider);
    return '<div class="set-text"><span class="set-title">' + V.esc(label) + '</span></div>' +
      '<div id="ai-keys-' + provider + '">' + aiKeysHtml(provider) + '</div>' +
      '<div class="ai-test-out" id="ai-test-' + provider + '" hidden></div>' +
      '<div class="ai-add-row"><input type="password" id="set-ai-newkey-' + provider + '" placeholder="Paste a ' + V.esc(label) + ' API key" autocomplete="off" />' +
      '<button class="btn ghost" data-ai-add="' + provider + '" aria-label="Add key">＋</button></div>' +
      aiModelPickerHtml(provider) +
      '<div class="set-note">Get a free key at <a href="' + V.esc(Ai.keyUrl(provider)) + '" target="_blank" rel="noopener">' + V.esc(Ai.keyUrlLabel(provider)) + '</a></div>';
  }

  // The blocklist has been write-only since it shipped: a tap hid a song or an artist
  // behind a six second undo window and then never surfaced again. This is the way back.
  function blockedCardHtml() {
    const list = Store.blockedList();
    const rows = [];
    list.tracks.forEach(entry => {
      const t = V.trackById(entry.id);
      rows.push({
        kind: "track", key: entry.id,
        title: (t && t.title) || entry.title || "Unknown track",
        sub: (t && t.artist) || entry.artist || "",
        art: t || (entry.thumb ? { thumb: entry.thumb } : null)
      });
    });
    list.artists.forEach(name => rows.push({ kind: "artist", key: name, title: name, sub: "Artist", art: null }));
    if (!rows.length) {
      return '<div class="set-note">Nothing is blocked. Use the track menu to keep a song or an artist out of search, radio and autoplay until you unblock them.</div>';
    }
    return '<div class="blocked-list">' + rows.map(r =>
      '<div class="blocked-row">' +
      (r.art ? V.artHtml(r.art, "") : '<div class="blocked-glyph">' + (r.kind === "artist" ? "@" : "&#9834;") + '</div>') +
      '<div class="meta"><div class="song-title" dir="auto">' + V.esc(r.title) + '</div>' +
      '<div class="song-sub" dir="auto">' + V.esc(r.sub || "") + '</div></div>' +
      '<button class="text-action" data-unblock="' + r.kind + '" data-key="' + V.esc(r.key) + '">Unblock</button>' +
      '</div>').join("") + '</div>';
  }

  function renderSettingsPage() {
    const s = Store.settings();
    const lastBackupAt = parseInt(localStorage.getItem("aura.lastBackupAt") || "0", 10);
    const lastBackup = lastBackupAt ? new Date(lastBackupAt).toLocaleString() : "No backup saved yet";
    V.paint(V.view, settingsPageHtml(s, lastBackup));

    V.showCacheVersion();
    bindSettingsTabs(s);
    bindSettingsToggles();
    bindDailyPrep();
    bindServerMix();
    bindSpeechAndProvider();
    bindAiKeys();
    bindPushStatus();
    bindSettingsChoices();
    bindSettingsBack();
    bindBackupControls(lastBackup);
    bindSyncStatus();
    bindStorageActions();
    bindBlockedCard();
    bindDangerZone();
  }

  // The page is built section by section, each from its own function, in the order the
  // tabs list them; the nav comes first, because it settles which tab is showing.
  function settingsPageHtml(s, lastBackup) {
    const settingsTabs = settingsNavHtml();
    return '<div class="setpage">' +
      '<div class="setpage-head settings-head">' +
      (IS_IPHONE ? '<button class="back-btn" id="set-back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' : '') +
      '<div class="setpage-mark" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div><span class="setpage-kicker">Your Aura</span><h2>Make it yours</h2><p>Tune how Aura looks, sounds and uses your data. Changes apply instantly.</p></div></div>' +
      '<nav class="set-nav" role="tablist" aria-label="Settings sections">' + settingsTabs + '</nav>' +
      '<div class="set-sections">' +
      appearanceSettingsHtml(s) +
      playbackSettingsHtml(s) +
      drivingSettingsHtml(s) +
      notificationSettingsHtml(s) +
      storageSettingsHtml(s) +
      aiSettingsHtml(s) +
      dailyPrepSettingsHtml(s) +
      privateSessionSettingsHtml(s) +
      blockedSettingsHtml() +
      backupSettingsHtml(lastBackup) +
      aboutSettingsHtml() +
      dangerSettingsHtml() +
      '</div></div>';
  }

  function settingsNavHtml() {
    const settingsNav = [
      ["appearance", "Look"], ["playback", "Playback"], ["driving", "Driving"], ["notifications", "Alerts"],
      ["storage", "Data"], ["ai", "AI"], ["blocked", "Privacy"], ["about", "About"]
    ];
    if (!settingsNav.some(item => item[0] === activeSettingsTab)) activeSettingsTab = "appearance";
    const settingsTabs = settingsNav.map(item => {
      const controls = item[0] === "storage" ? "settings-storage settings-backup" :
        item[0] === "blocked" ? "settings-private settings-blocked settings-danger" : "settings-" + item[0];
      return '<button type="button" role="tab" id="settings-tab-' + item[0] + '" data-settings-target="' + item[0] + '" aria-controls="' + controls + '" aria-selected="' + (activeSettingsTab === item[0]) + '" tabindex="' + (activeSettingsTab === item[0] ? '0' : '-1') + '"' + (activeSettingsTab === item[0] ? ' class="on"' : '') + '>' +
        settingsIcon(item[0]) + '<span>' + item[1] + '</span></button>';
    }).join('');
    return settingsTabs;
  }

  function appearanceSettingsHtml(s) {
    const swatches = '<div class="swatches">' + ACCENT_CHOICES.map(a =>
      '<button type="button" class="swatch' + ((s.accent || "green") === a[0] ? ' on' : '') + '" data-accent-pick="' + a[0] + '" style="--sw:' + a[1] + '" aria-label="Use ' + a[0] + ' accent" aria-pressed="' + ((s.accent || "green") === a[0]) + '"></button>').join('') + '</div>';
    return setSection("appearance", "Appearance",
      // Titled in both languages, so it can be found by someone who reads only one of them.
      choiceRow("Language · שפה", "Menus, messages, voice replies and AI answers follow this choice. Song titles and artist names stay as they are.",
        segControl("set-interface-lang", [["en", "English"], ["he", "עברית"]], window.I18n ? I18n.language() : "en")) +
      choiceRow("Text size", "Makes lists, menus and messages easier to read",
        segControl("set-text-size", TEXT_SIZES, TEXT_SIZES.some(z => z[0] === s.textSize) ? s.textSize : "default")) +
      toggleRow("set-contrast", "High contrast", "Brighter secondary text and clearer outlines. Turns on by itself when your device asks for more contrast.", s.highContrast === true) +
      choiceRow("Accent color", "Highlights, active states and buttons across the app", swatches) +
      choiceRow("Song timeline", "How a song's progress is drawn in the players and in driving mode",
        segControl("set-progress-style", [["wave", "Wave"], ["line", "Line"]], s.progressStyle === "line" ? "line" : "wave")) +
      toggleRow("set-anims", "Animations", "Turn off for an instant, static interface", !!s.animations) +
      toggleRow("set-portrait-lock", "Lock portrait orientation", "Keep the app upright when you turn your phone. Turn off to allow rotation.", s.portraitLock !== false) +
      '<div class="set-note" id="set-orientation-status" role="status">' + V.esc(window.AppOrientation ? AppOrientation.status() : "Orientation control is unavailable in this browser.") + '</div>');
  }

  function playbackSettingsHtml(s) {
    return setSection("playback", "Playback",
      toggleRow("set-autoplay", "Autoplay similar songs", "Keeps the music going when the queue ends", !!s.autoplay) +
      toggleRow("set-rempos", "Remember episode position", "Resume podcasts and spoken word where you left them", !!s.rememberPosition) +
      toggleRow("set-skipseg", "Skip intros & sponsors", "Jumps over known sponsor reads, intros and outros inside a track", !!s.skipSegments) +
      toggleRow("set-musiconly", "Songs only", "Keep sketches, interviews and watch-videos out of autoplay", !!s.musicOnly) +
      toggleRow("set-normalize", "Even out volume", "Levels the loudness differences between tracks", !!s.normalize) +
      toggleRow("set-noyt", "Never fall back to YouTube", "Skips songs instead - no ads, keeps background play", !!s.noYtFallback) +
      choiceRow("Audio quality", "Higher quality uses more data", segControl("set-quality-seg", [["best", "Best"], ["normal", "Normal"], ["data", "Data saver"]], s.audioQuality || "best")) +
      choiceRow("Crossfade", "Blends the end of a song into the next", segControl("set-xfade-seg", [[0, "Off"], [2, "2s"], [4, "4s"], [8, "8s"], [12, "12s"]], s.crossfade != null ? s.crossfade : 4)));
  }

  function drivingSettingsHtml(s) {
    return setSection("driving", "Driving mode",
      '<div class="set-note">A stripped-down screen with three large controls, opened from the Drive button in the player.</div>' +
      toggleRow("set-drive", "Driving mode", "Turn off to hide the Drive button from the player", s.driveMode !== false) +
      choiceRow("Look", "Night is easier at the wheel after dark; day survives direct sun",
        segControl("set-drive-look", [["night", "Night"], ["day", "Day"]], s.driveLook === "day" ? "day" : "night")) +
      toggleRow("set-drive-awake", "Keep the screen on", "Stops the phone dimming while driving mode is open", s.driveKeepAwake !== false));
  }

  function notificationSettingsHtml(s) {
    return setSection("notifications", "Notifications",
      '<div class="set-status status-card" id="set-push-status">Checking…</div>' +
      '<div class="settings-actions"><button class="btn ghost" id="set-push-toggle" hidden></button></div>' +
      toggleRow("set-notify-new", "New release alerts", "Notify when someone you follow drops a new song, album or episode", s.notifyNewReleases !== false));
  }

  function storageSettingsHtml(s) {
    const cacheLimit = Number(s.cacheLimitMB);
    return setSection("storage", "Storage & data",
      toggleRow("set-wifi", "Download over Wi-Fi only", "connection" in navigator
        ? "Queued downloads wait instead of using mobile data"
        : "This browser does not report the connection type, so downloads cannot wait for Wi-Fi here", !!s.wifiOnlyDownloads) +
      settingsLink("set-stats", "Listening stats", "See your most-played songs, artists and time", "playback") +
      choiceRow("Song cache limit", "When the limit is reached, the least recently played cached songs go first",
        segControl("set-cache-seg", [[200, "200 MB"], [400, "400 MB"], [800, "800 MB"], [0, "Unlimited"]], isNaN(cacheLimit) ? 400 : cacheLimit)) +
      settingsLink("set-clearcache", "Clear song cache", "Remove downloaded audio without touching your library", "storage") +
      settingsLink("set-clearsearches", "Clear search history", "Remove your recent searches from this device", "blocked") +
      settingsLink("set-clearhistory", "Clear listening history", "Reset recents, stats and listening-based recommendations", "blocked"));
  }

  function aiSettingsHtml(s) {
    return setSection("ai", "AI playlists",
      '<div class="set-note">Describe a playlist in your own words and it suggests the songs. Playlist requests go from this device to the provider. Daily prep below controls whether your key is also stored on your private server for overnight mixes.</div>' +
      choiceRow("Provider", "\"Both\" tries every Gemini key first, then falls back to Groq only once all of them have failed",
        segControl("set-ai-mode", [["gemini", "Gemini"], ["groq", "Groq"], ["both", "Both"]], Ai.getMode())) +
      Ai.providers.map(p => aiProviderBlockHtml(p)).join('<div class="ai-provider-sep"></div>') +
      choiceRow("Speech language", "What the orb listens for when you tap it. Recognition is done by the browser and may use an online service.",
        segControl("set-voice-lang", [["he-IL", "עברית"], ["en-US", "English"]], (window.I18n ? I18n.speechLanguage() : s.voiceLanguage || "he-IL"))) +
      toggleRow("set-voice-reply", "Spoken replies", "Answers a voice request out loud, with a voice stored on this device. On iPhone it can keep your next request from being heard, so it starts off there.", Voice.repliesOn ? Voice.repliesOn() : s.voiceReply !== false) +
      toggleRow("set-ai-home", "AI picks on Home", "Adds a “Picked for you today” row to Home, built from your own listening history and refreshed about once a day. On a self-hosted server that builds it overnight, this works without a key on this device.", s.aiHomeSection === true));
  }

  function dailyPrepSettingsHtml(s) {
    return setSection("daily", "Daily prep",
      '<div class="set-note">Home is put together once a night - the AI row, the rows below it, the recommendations and their artwork - so opening the app hands you what is already there instead of building it while you wait.</div>' +
      toggleRow("set-nightly", "Prepare Home overnight", "With this off, every row is built the moment Home opens and you wait for it", s.nightlyPrebuild !== false) +
      choiceRow("Time", "This device's own clock. If it is asleep or offline then, the run happens the next time you open the app - and while the browser allows it, in the background.",
        nightlyHourPicker(window.Nightly ? Nightly.hour() : 4)) +
      '<div class="set-status" id="set-nightly-status">' + V.esc(nightlyStatusText()) + '</div>' +
      '<div class="settings-actions"><button class="btn ghost" id="set-nightly-now">Prepare now</button></div>' +
      '<div id="set-servermix-row" hidden>' +
        toggleRow("set-servermix", "Let the server use my key",
          "The nightly mix is built with your own AI key, so it has to be on the server. It is stored there in the clear, and turning this off deletes it again. Only leave it on for a server you run yourself.",
          s.serverMixKey !== false) + '</div>' +
      '<div class="set-status" id="set-servermix-status" hidden></div>');
  }

  function privateSessionSettingsHtml(s) {
    return setSection("private", "Private session",
      '<div class="set-note">A private session plays everything normally - your library, your playlists, the lot - and records none of it. Nothing played while it is on reaches your history, your stats, or what the AI is told you like, which is what keeps someone else\u2019s taste out of your recommendations after they have had the aux in the car. It is switched on with the detective at the top of the screen, and stays on until it is switched off.</div>' +
      toggleRow("set-private", "Private session", "Turn off to hide the detective from the top bar. Hiding it also ends a session already running.", s.privateSession !== false) +
      '<div class="set-status" id="set-private-status">' + V.esc(privateStatusText()) + '</div>');
  }

  function blockedSettingsHtml() {
    return setSection("blocked", "Blocked from autoplay",
      '<div id="blocked-card">' + blockedCardHtml() + '</div>');
  }

  function backupSettingsHtml(lastBackup) {
    // Silence was the worst answer here: on a phone the option simply did not exist, so
    // "automatic backup" looked like something the app had and was quietly doing.
    const canAutoBackup = "showSaveFilePicker" in window;
    const autoBackupButton = canAutoBackup ? '<button class="btn ghost" id="set-autobackup">Enable automatic backup</button>' : "";
    const autoBackupNote = canAutoBackup ? "" :
      '<div class="set-note">Automatic backup needs a desktop browser. On this device, use Download backup and keep the file somewhere safe.</div>';
    return setSection("backup", "Backup & transfer",
      '<div class="set-note">Your library, playlists, likes, listening history, settings and queue - in one file.</div>' +
      '<div class="set-status status-card" id="set-backup-status">' + V.esc(lastBackup) + '</div>' + autoBackupNote +
      '<div class="set-status status-card" id="set-sync-status">Checking sync…</div>' +
      '<div class="settings-actions">' + autoBackupButton + '<button class="btn ghost" id="set-sync-now" hidden>Sync now</button><button class="btn ghost" id="set-sync-conflict" hidden>Recover other-device copy</button><button class="btn ghost" id="set-backup">Download backup</button><button class="btn ghost" id="set-restore">Restore backup</button></div>' +
      '<input type="file" id="set-restore-file" accept="application/json,.json" hidden />');
  }

  function aboutSettingsHtml() {
    return setSection("about", "About Aura",
      '<div class="set-note">Open source under AGPL-3.0-only. <a href="https://github.com/YossiYad/aura" target="_blank" rel="noopener noreferrer">Source code</a> · <a href="https://github.com/YossiYad/aura/blob/main/THIRD-PARTY-NOTICES.md" target="_blank" rel="noopener noreferrer">Third-party notices</a></div>' +
      settingsLink("set-refresh", "Refresh app version", "Check for and load the latest available build", "backup") +
      settingsLink("set-logs", "Diagnostics", "View technical logs for troubleshooting", "about") +
      '<div class="set-version" id="set-version">Aura ' + V.APP_VERSION + '</div>');
  }

  function dangerSettingsHtml() {
    return setSection("danger", "Danger zone",
      settingsLink("set-clear", "Delete Aura data", "Permanently remove your library, playlists and history", "danger", true), "danger-zone");
  }

  function bindSettingsTabs(s) {
    const tabButtons = Array.from(V.view.querySelectorAll("[data-settings-target]"));
    const selectSettingsTab = (button, moveFocus) => {
      activeSettingsTab = button.dataset.settingsTarget;
      tabButtons.forEach(item => {
          const selected = item === button;
          item.classList.toggle("on", selected);
          item.setAttribute("aria-selected", String(selected));
          item.tabIndex = selected ? 0 : -1;
      });
      V.view.querySelectorAll("[data-settings-panel]").forEach(panel => {
        panel.hidden = panel.dataset.settingsPanel !== activeSettingsTab;
      });
      button.scrollIntoView({ behavior: s.animations === false ? "auto" : "smooth", block: "nearest", inline: "center" });
      const nav = V.view.querySelector(".set-nav");
      V.view.scrollTo({ top: nav ? nav.offsetTop : 0, behavior: s.animations === false ? "auto" : "smooth" });
      if (moveFocus) button.focus();
    };
    tabButtons.forEach((button, index) => {
      button.onclick = () => selectSettingsTab(button, false);
      button.onkeydown = e => {
        let nextIndex = index;
        if (e.key === "ArrowRight") nextIndex = (index + 1) % tabButtons.length;
        else if (e.key === "ArrowLeft") nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
        else if (e.key === "Home") nextIndex = 0;
        else if (e.key === "End") nextIndex = tabButtons.length - 1;
        else return;
        e.preventDefault();
        selectSettingsTab(tabButtons[nextIndex], true);
      };
    });
  }

  function bindSettingsToggles() {
    const bindToggle = (id, key) => {
      const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
      if (!el) return;
      el.onchange = () => {
        const patch = {};
        patch[key] = el.checked;
        Store.patchSettings(patch);
        if (key === "animations" || key === "highContrast") applyAppearance();
        if (key === "voiceReply" && !el.checked) Voice.stopReply();
        // The Drive button lives in the player, which is not on screen while Settings is,
        // so nothing else would pick this up before it is next looked for.
        if (key === "driveMode") {
          const driveBtn = document.getElementById("fp-drive");
          if (driveBtn) driveBtn.hidden = !el.checked;
        }
        if (key === "privateSession") {
          V.syncPrivateButton();
          const status = document.getElementById("set-private-status");
          if (status) status.textContent = privateStatusText();
          if (!el.checked) V.toast("Private session hidden - plays are recorded again");
        }
        if (key === "nightlyPrebuild" && window.Nightly) { Nightly.applySettings(); updateNightlyStatus(); }
      };
    };
    bindToggle("set-anims", "animations");
    bindToggle("set-contrast", "highContrast");
    bindToggle("set-voice-reply", "voiceReply");
    bindToggle("set-portrait-lock", "portraitLock");
    bindToggle("set-autoplay", "autoplay");
    bindToggle("set-rempos", "rememberPosition");
    bindToggle("set-private", "privateSession");
    bindToggle("set-drive", "driveMode");
    bindToggle("set-drive-awake", "driveKeepAwake");
    bindToggle("set-skipseg", "skipSegments");
    bindToggle("set-musiconly", "musicOnly");
    bindToggle("set-normalize", "normalize");
    bindToggle("set-noyt", "noYtFallback");
    bindToggle("set-notify-new", "notifyNewReleases");
    bindToggle("set-wifi", "wifiOnlyDownloads");
    bindToggle("set-ai-home", "aiHomeSection");
    bindToggle("set-nightly", "nightlyPrebuild");
  }

  function bindDailyPrep() {
    const nightlyHour = /** @type {HTMLSelectElement} */ (document.getElementById("set-nightly-hour"));
    if (nightlyHour) {
      nightlyHour.onchange = () => {
        Store.patchSettings({ nightlyHour: Number(nightlyHour.value) });
        if (window.Nightly) Nightly.applySettings();
        updateNightlyStatus();
      };
    }
    const nightlyNow = /** @type {HTMLButtonElement} */ (document.getElementById("set-nightly-now"));
    if (nightlyNow) {
      nightlyNow.onclick = async () => {
        if (!window.Nightly) return;
        nightlyNow.disabled = true;
        try {
          const ran = await Nightly.run("asked for from Settings");
          V.toast(ran ? "Home is ready" : "Already preparing");
        } finally {
          if (nightlyNow.isConnected) nightlyNow.disabled = false;
          updateNightlyStatus();
        }
      };
    }
  }

  function bindServerMix() {
    const serverMixSwitch = /** @type {HTMLInputElement} */ (document.getElementById("set-servermix"));
    if (serverMixSwitch) {
      serverMixSwitch.onchange = async () => {
        const on = serverMixSwitch.checked;
        Store.patchSettings({ serverMixKey: on });
        serverMixSwitch.disabled = true;
        const info = await syncServerMixKey();
        serverMixSwitch.disabled = false;
        updateServerMix(info);
        // No answer, or a key still there, is not "off the server": the switch is kept and
        // the two are put in step the next time the server answers.
        if (!info || (!on && info.ownKey)) V.toast("Couldn't reach the server - this takes effect the next time it answers", "err");
        else V.toast(on ? "The server builds your mix from now on" : "Your key is off the server");
      };
    }
    // Show what the server currently holds, and put the two in step if they are not.
    V.serverMixState().then(info => {
      updateServerMix(info);
      return syncServerMixKey(info);
    }).then(after => { if (after) updateServerMix(after); }).catch(() => {});
  }

  function bindSpeechAndProvider() {
    const interfaceLangSeg = document.getElementById("set-interface-lang");
    if (interfaceLangSeg) interfaceLangSeg.onclick = /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
      const button = /** @type {HTMLElement} */ (e.target.closest("[data-val]"));
      if (!button || button.classList.contains("on") || !window.I18n) return;
      try {
        I18n.setLanguage(button.dataset.val);
        renderSettingsPage();
        /** @type {HTMLElement} */ (document.querySelector('#set-interface-lang [data-val="' + I18n.language() + '"]')).focus();
      } catch (error) { V.toast("Could not save the language setting", "err"); }
    };
    const voiceLangSeg = document.getElementById("set-voice-lang");
    if (voiceLangSeg) {
      voiceLangSeg.onclick = /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
        const b = /** @type {HTMLElement} */ (e.target.closest("[data-val]"));
        if (!b || b.classList.contains("on")) return;
        voiceLangSeg.querySelectorAll("[data-val]").forEach(x => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
        Store.patchSettings({ voiceLanguage: b.dataset.val });
      };
    }
    const aiModeSeg = document.getElementById("set-ai-mode");
    if (aiModeSeg) {
      aiModeSeg.onclick = /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
        const b = /** @type {HTMLElement} */ (e.target.closest("[data-val]"));
        if (!b || b.classList.contains("on")) return;
        aiModeSeg.querySelectorAll("[data-val]").forEach(x => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
        Ai.setMode(/** @type {AiProvider | "both"} */ (b.dataset.val));
      };
    }
  }

  function bindAiKeys() {
    Ai.providers.forEach(provider => {
      const label = Ai.label(provider);
      const newKey = /** @type {HTMLInputElement} */ (document.getElementById("set-ai-newkey-" + provider));
      if (newKey) {
        const addNewKey = () => {
          const v = newKey.value.trim();
          if (!v) return;
          try { Ai.addKey(provider, v); }
          catch (e) { V.toast("Couldn't save the key. Check device storage and try again.", "err"); return; }
          V.toast(label + " key added");
          renderSettingsPage();
        };
        const addBtn = /** @type {HTMLButtonElement} */ (document.querySelector('[data-ai-add="' + provider + '"]'));
        if (addBtn) addBtn.onclick = addNewKey;
        newKey.onkeydown = e => { if (e.key === "Enter") addNewKey(); };
      }
      // A stage arrives the moment it resolves rather than at the end, because the
      // failures worth diagnosing are the ones that hang: watching a line sit unanswered
      // for eight seconds is itself the finding.
      /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-ai-test="' + provider + '"]')).forEach(btn => {
        btn.onclick = async () => {
          const key = Ai.getKeys(provider)[parseInt(btn.dataset.aiTestIndex, 10)];
          const out = document.getElementById("ai-test-" + provider);
          if (!key || !out) return;
          const ms = n => n < 1000 ? n + "ms" : (n / 1000).toFixed(1) + "s";
          const stepHtml = st =>
            '<div class="ai-test-step' + (st.ok ? "" : " bad") + '">' +
            '<span class="ai-test-mark">' + (st.ok ? "✓" : "✗") + '</span>' +
            '<span>' + V.esc(st.text) + (st.ms ? ' <span class="ai-test-ms">' + V.esc(ms(st.ms)) + '</span>' : '') +
            (st.note ? '<span class="ai-test-note">' + V.esc(st.note) + '</span>' : '') + '</span></div>';
          let lines = "";
          const paint = tail => { out.innerHTML = lines + (tail || ""); };
          const waiting = '<div class="ai-test-step waiting"><span class="ai-test-mark">•</span><span>Waiting…</span></div>';
          btn.disabled = true;
          out.hidden = false;
          paint(waiting);
          try {
            const r = await Ai.testKey(provider, key, st => { lines += stepHtml(st); paint(waiting); });
            paint('<div class="ai-test-verdict' + (r.ok ? "" : " bad") + '">' + V.esc(r.verdict) + '</div>');
          } catch (e) {
            paint('<div class="ai-test-verdict bad">' + V.esc(String((e && e.message) || e)) + '</div>');
          } finally {
            btn.disabled = false;
          }
        };
      });
      /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-ai-remove="' + provider + '"]')).forEach(btn => {
        btn.onclick = () => {
          const keys = Ai.getKeys(provider);
          const key = keys[parseInt(btn.dataset.aiRemoveIndex, 10)];
          try { if (key) Ai.removeKey(provider, key); }
          catch (e) { V.toast("Couldn't remove the key. Check device storage and try again.", "err"); return; }
          V.toast(label + " key removed");
          renderSettingsPage();
        };
      });
      const modelInput = /** @type {HTMLInputElement} */ (document.getElementById("set-ai-model-" + provider));
      if (modelInput) {
        modelInput.onchange = () => {
          Ai.setModel(provider, modelInput.value);
          V.toast(modelInput.value.trim() ? label + " model updated" : "Back to the default model");
        };
      }
      const modelPick = /** @type {HTMLSelectElement} */ (document.getElementById("set-ai-model-pick-" + provider));
      if (modelPick) {
        modelPick.onchange = () => {
          const input = document.getElementById("set-ai-model-" + provider);
          if (modelPick.value === "__custom__") {
            if (input) { input.style.display = ""; input.focus(); }
            return;
          }
          if (input) input.style.display = "none";
          Ai.setModel(provider, modelPick.value);
          V.toast(modelPick.value ? label + " model set to " + modelPick.value : label + " back to the default model");
        };
      }
    });
  }

  function bindPushStatus() {
    if (window.Push) {
      const pushStatus = document.getElementById("set-push-status");
      const pushBtn = /** @type {HTMLButtonElement} */ (document.getElementById("set-push-toggle"));
      const paintPush = async () => {
        if (!pushStatus.isConnected) return;
        const st = await Push.status();
        pushBtn.disabled = false;
        if (!st.supported) {
          pushStatus.textContent = "Notifications aren't supported in this browser";
          pushBtn.hidden = true;
        } else if (st.permission === "denied") {
          pushStatus.textContent = "Notifications are blocked - allow them for Aura in your browser or OS settings";
          pushBtn.hidden = true;
        } else if (st.subscribed) {
          pushStatus.textContent = "Push notifications are active on this device";
          pushBtn.hidden = false;
          pushBtn.textContent = "Turn off";
          pushBtn.onclick = async () => {
            pushBtn.disabled = true;
            try { await Push.disable(); } catch (e) { V.toast(e.message || "Couldn't disable notifications", "err"); }
            paintPush();
          };
        } else if (st.backendAvailable) {
          pushStatus.textContent = "Get a push notification on this device when a followed artist or podcast has something new";
          pushBtn.hidden = false;
          pushBtn.textContent = "Enable push notifications";
          pushBtn.onclick = async () => {
            pushBtn.disabled = true;
            try { await Push.enable(); } catch (e) { V.toast(e.message || "Couldn't enable notifications", "err"); }
            paintPush();
          };
        } else if (st.permission === "granted") {
          pushStatus.textContent = "This server doesn't run push, but new-release alerts still show while the app is open";
          pushBtn.hidden = true;
        } else {
          pushStatus.textContent = "This server doesn't run push, but Aura can still alert you for new releases while it's open";
          pushBtn.hidden = false;
          pushBtn.textContent = "Allow in-app alerts";
          pushBtn.onclick = async () => {
            pushBtn.disabled = true;
            try { await Push.enable(); } catch (e) { V.toast(e.message || "Couldn't enable notifications", "err"); }
            paintPush();
          };
        }
      };
      paintPush();
    } else {
      const pushStatus = document.getElementById("set-push-status");
      if (pushStatus) pushStatus.textContent = "Notifications aren't available in this build";
    }
  }

  function bindSettingsChoices() {
    const bindSeg = (id, key, parse, after) => {
      const box = document.getElementById(id);
      if (!box) return;
      box.onclick = /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
        const b = /** @type {HTMLElement} */ (e.target.closest("[data-val]"));
        if (!b || b.classList.contains("on")) return;
        box.querySelectorAll("[data-val]").forEach(x => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
        const patch = {};
        patch[key] = parse ? parse(b.dataset.val) : b.dataset.val;
        Store.patchSettings(patch);
        if (after) after();
      };
    };
    bindSeg("set-quality-seg", "audioQuality");
    bindSeg("set-progress-style", "progressStyle", null, applyAppearance);
    bindSeg("set-text-size", "textSize", null, applyAppearance);
    bindSeg("set-drive-look", "driveLook");
    bindSeg("set-xfade-seg", "crossfade", v => parseInt(v, 10) || 0);
    bindSeg("set-cache-seg", "cacheLimitMB", v => parseInt(v, 10) || 0);

    V.view.querySelectorAll("[data-accent-pick]").forEach(b => {
      b.onclick = () => {
        Store.patchSettings({ accent: b.dataset.accentPick });
        V.view.querySelectorAll("[data-accent-pick]").forEach(x => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
        applyAppearance();
      };
    });
  }

  function bindSettingsBack() {
    const backBtn = document.getElementById("set-back");
    if (backBtn) backBtn.onclick = () => V.dismissViaHistory(V.popSubView);
  }

  function bindBackupControls(lastBackup) {
    document.getElementById("set-refresh").onclick = e => V.refreshAppVersion(e.currentTarget);
    document.getElementById("set-backup").onclick = () => {
      V.downloadBackup();
      V.toast("Backup downloaded");
    };
    const autoBackup = document.getElementById("set-autobackup");
    if (autoBackup) {
      // A stored handle loses its permission when the browser restarts, and the writes
      // then failed silently forever - the only sign was a backup date that stopped
      // moving. Say it out loud, and let the button put it right.
      V.backupHandle("get").then(async handle => {
        if (!handle) return;
        autoBackup.textContent = "Update automatic backup file";
        let state = "granted";
        try { state = await handle.queryPermission({ mode: "readwrite" }); } catch (e) { state = "prompt"; }
        const status = document.getElementById("set-backup-status");
        if (state === "granted") {
          if (status) status.textContent = "Automatic backup is active - last saved " + lastBackup;
          return;
        }
        autoBackup.textContent = "Automatic backup needs permission again";
        if (status) status.textContent = "Automatic backup is paused - it lost permission to write the file";
      }).catch(() => {});
      autoBackup.onclick = async () => {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: "aura-backup.json",
            types: [{ description: "Aura backup", accept: { "application/json": [".json"] } }]
          });
          await V.backupHandle("set", handle);
          await V.writeBackupFile(handle);
          autoBackup.textContent = "Update automatic backup file";
          document.getElementById("set-backup-status").textContent = "Automatic backup is active";
          V.toast("Automatic backup enabled");
        } catch (error) {
          if (error.name !== "AbortError") V.toast("Could not enable automatic backup", "err");
        }
      };
    }
    const restoreFile = /** @type {HTMLInputElement} */ (document.getElementById("set-restore-file"));
    document.getElementById("set-restore").onclick = () => restoreFile.click();
    restoreFile.onchange = async () => {
      const file = restoreFile.files && restoreFile.files[0];
      if (!file) return;
      try {
        const result = Store.importData(JSON.parse(await file.text()));
        V.toast("Restored " + result.songs + " songs and " + result.playlists + " playlists");
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        V.toast(error.message || "Could not restore this backup", "err");
      }
    };
    document.getElementById("set-logs").onclick = () => openLogs();
  }

  function bindSyncStatus() {
    if (window.Sync) {
      const syncStatus = document.getElementById("set-sync-status");
      const syncNow = /** @type {HTMLButtonElement} */ (document.getElementById("set-sync-now"));
      const syncConflict = /** @type {HTMLButtonElement} */ (document.getElementById("set-sync-conflict"));
      const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
      const paintSync = () => {
        // The subscription outlives the page - a sync event can land after the user has
        // left, and the captured nodes are then detached. Nothing to paint then.
        if (!syncStatus.isConnected) return;
        const d = Sync.describe();
        if (!d.ready) {
          syncStatus.textContent = d.error && !d.available ? "Sync is offline right now - changes stay on this device and upload when it returns" : "Checking sync…";
          syncNow.hidden = true;
          syncConflict.hidden = true;
          return;
        }
        if (!d.available) {
          // Only a server that answered without sync has none. One that was synced with
          // before and cannot be reached now read the same, and hid the way to try again.
          syncStatus.textContent = d.unsupported
            ? "This server does not run sync - your data lives only on this device"
            : "Sync is offline right now - changes stay on this device and upload when it returns";
          syncNow.hidden = !!d.unsupported;
          syncConflict.hidden = true;
          return;
        }
        let line = "Server copy for " + d.email;
        if (d.size) line += " · " + fmtBytes(d.size);
        line += d.at ? " · updated " + new Date(d.at).toLocaleString() : " · not uploaded yet";
        if (d.dirty) line = "Changes waiting to upload · " + line;
        if (d.error) line = d.error + " · " + line;
        syncStatus.textContent = line;
        syncNow.hidden = false;
        Sync.hasConflict().then(has => { syncConflict.hidden = !has; }).catch(() => {});
      };
      // A subscription cannot be removed, and this page is rendered again and again;
      // one standing subscription forwards to whichever painter belongs to the current
      // nodes instead of keeping every painter ever made alive.
      V.syncStatusPainter = paintSync;
      if (!V.syncStatusSubscribed) {
        V.syncStatusSubscribed = true;
        Sync.onChange(() => { if (V.syncStatusPainter) V.syncStatusPainter(); });
      }
      paintSync();
      syncNow.onclick = () => {
        syncNow.disabled = true;
        Promise.resolve(Sync.pushNow()).catch(() => {}).finally(() => {
          syncNow.disabled = false;
          paintSync();
        });
      };
      syncConflict.onclick = async () => {
        syncConflict.disabled = true;
        try {
          await Sync.recoverConflict();
        } catch (error) {
          V.toast(error.message || "Could not recover that copy", "err");
          syncConflict.disabled = false;
        }
      };
    } else {
      const syncStatus = document.getElementById("set-sync-status");
      if (syncStatus) syncStatus.textContent = "Sync isn't configured - your data stays on this device";
    }
  }

  function bindStorageActions() {
    const cacheBtn = /** @type {HTMLButtonElement} */ (document.getElementById("set-clearcache"));
    Player.cacheStats().then(st => {
      const title = cacheBtn.querySelector(".set-title");
      if (st.count && title && cacheBtn.isConnected) title.textContent = "Clear song cache (" + st.count + " songs, " + Math.round(st.bytes / 1048576) + " MB)";
    }).catch(() => {});
    cacheBtn.onclick = () => {
      cacheBtn.disabled = true;
      Player.clearCache().then(() => {
        const title = cacheBtn.querySelector(".set-title");
        if (title) title.textContent = "Clear song cache";
        V.toast("Song cache cleared");
      }).catch(error => {
        V.toast((error && error.message) || "Could not clear the song cache", "err");
      }).finally(() => { cacheBtn.disabled = false; });
    };
    document.getElementById("set-clearsearches").onclick = () => {
      Store.clearSearches();
      V.toast("Search history cleared");
    };
    document.getElementById("set-clearhistory").onclick = () => {
      Store.clearHistory();
      V.toast("Listening history cleared");
    };
    document.getElementById("set-stats").onclick = () => V.pushSubView({ kind: "stats" });
  }

  function bindBlockedCard() {
    const card = document.getElementById("blocked-card");
    if (!card) return;
    /** @type {NodeListOf<HTMLButtonElement>} */ (card.querySelectorAll("[data-unblock]")).forEach(b => {
      b.onclick = () => {
        if (b.dataset.unblock === "artist") Store.unblockArtist(b.dataset.key);
        else Store.unblockTrack(b.dataset.key);
        card.innerHTML = blockedCardHtml();
        bindBlockedCard();
        V.toast("No longer blocked");
      };
    });
  }

  function bindDangerZone() {
    document.getElementById("set-clear").onclick = () => {
      if (confirm("Delete your entire library, playlists and history?")) {
        Store.clearAll();
        V.toast("Library, playlists and history deleted");
        V.render(true);
      }
    };
  }

  function openLogs() {
    const text = window.Log ? Log.dump() : "(logger not loaded)";
    V.openModal(
      '<div class="modal logs-modal"><h3>Logs <span id="log-count">(' + (window.Log ? Log.count() : 0) + ')</span></h3>' +
      '<textarea id="log-text" rows="14" readonly>' + V.esc(text) + '</textarea>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost danger" id="log-clear">Clear</button>' +
      '<button class="btn ghost" id="log-copy">Copy</button>' +
      '<button class="btn primary" id="log-close">Close</button></div></div>'
    );
    const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById("log-text"));
    ta.scrollTop = ta.scrollHeight;
    document.getElementById("log-close").onclick = () => V.dismissViaHistory(() => { V.closeModal(); V.scrimEl.hidden = true; });
    document.getElementById("log-copy").onclick = async () => {
      const t = window.Log ? Log.dump() : "";
      let ok = false;
      try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {}
      if (!ok) {
        ta.removeAttribute("readonly");
        ta.focus(); ta.select();
        try { ok = document.execCommand("copy"); } catch (e) {}
        ta.setAttribute("readonly", "");
      }
      V.toast(ok ? "Logs copied" : "Copy failed - select the text manually", ok ? "" : "err");
    };
    document.getElementById("log-clear").onclick = () => {
      if (window.Log) Log.clear();
      ta.value = window.Log ? Log.dump() : "";
      const c = document.getElementById("log-count");
      if (c) c.textContent = "(" + (window.Log ? Log.count() : 0) + ")";
      V.toast("Logs cleared");
    };
  }
})();
