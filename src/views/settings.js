(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    ACCENT_CHOICES: { get: () => ACCENT_CHOICES },
    applyAppearance: { get: () => applyAppearance },
    askLanguage: { get: () => askLanguage },
    choiceRow: { get: () => choiceRow },
    nightlyHourPicker: { get: () => nightlyHourPicker },
    nightlyStatusText: { get: () => nightlyStatusText },
    openLogs: { get: () => openLogs },
    openSettings: { get: () => openSettings },
    privateStatusText: { get: () => privateStatusText },
    renderSettingsPage: { get: () => renderSettingsPage },
    renderStatsPage: { get: () => renderStatsPage },
    segControl: { get: () => segControl },
    setSection: { get: () => setSection },
    TEXT_SIZES: { get: () => TEXT_SIZES },
    settingsLink: { get: () => settingsLink },
    toggleRow: { get: () => toggleRow },
    updateNightlyStatus: { get: () => updateNightlyStatus }
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

  function renderSettingsPage() {
    const s = Store.settings();
    const lastBackupAt = parseInt(localStorage.getItem("aura.lastBackupAt") || "0", 10);
    const lastBackup = lastBackupAt ? new Date(lastBackupAt).toLocaleString() : "No backup saved yet";
    V.paint(V.view, settingsPageHtml(s, lastBackup));

    V.showCacheVersion();
    bindSettingsTabs(s);
    V.bindSettingsToggles();
    V.bindDailyPrep();
    V.bindServerMix();
    V.bindSpeechAndProvider();
    V.bindAiKeys();
    V.bindPushStatus();
    V.bindSettingsChoices();
    bindSettingsBack();
    V.bindBackupControls(lastBackup);
    V.bindSyncStatus();
    V.bindStorageActions();
    V.bindBlockedCard();
    V.bindDangerZone();
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
      V.appearanceSettingsHtml(s) +
      V.playbackSettingsHtml(s) +
      V.drivingSettingsHtml(s) +
      V.notificationSettingsHtml(s) +
      V.storageSettingsHtml(s) +
      V.aiSettingsHtml(s) +
      V.dailyPrepSettingsHtml(s) +
      V.privateSessionSettingsHtml(s) +
      V.blockedSettingsHtml() +
      V.backupSettingsHtml(lastBackup) +
      V.aboutSettingsHtml() +
      V.dangerSettingsHtml() +
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

  function bindSettingsBack() {
    const backBtn = document.getElementById("set-back");
    if (backBtn) backBtn.onclick = () => V.dismissViaHistory(V.popSubView);
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
