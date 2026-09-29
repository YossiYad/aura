(function () {
  const V = window.Aura.views;
  // The markup of each settings section.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    aboutSettingsHtml: { get: () => aboutSettingsHtml },
    aiSettingsHtml: { get: () => aiSettingsHtml },
    appearanceSettingsHtml: { get: () => appearanceSettingsHtml },
    backupSettingsHtml: { get: () => backupSettingsHtml },
    blockedCardHtml: { get: () => blockedCardHtml },
    blockedSettingsHtml: { get: () => blockedSettingsHtml },
    dangerSettingsHtml: { get: () => dangerSettingsHtml },
    drivingSettingsHtml: { get: () => drivingSettingsHtml },
    notificationSettingsHtml: { get: () => notificationSettingsHtml },
    playbackSettingsHtml: { get: () => playbackSettingsHtml },
    privateSessionSettingsHtml: { get: () => privateSessionSettingsHtml },
    storageSettingsHtml: { get: () => storageSettingsHtml }
  });

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

  function appearanceSettingsHtml(s) {
    const swatches = '<div class="swatches">' + V.ACCENT_CHOICES.map(a =>
      '<button type="button" class="swatch' + ((s.accent || "green") === a[0] ? ' on' : '') + '" data-accent-pick="' + a[0] + '" style="--sw:' + a[1] + '" aria-label="Use ' + a[0] + ' accent" aria-pressed="' + ((s.accent || "green") === a[0]) + '"></button>').join('') + '</div>';
    return V.setSection("appearance", "Appearance",
      // Titled in both languages, so it can be found by someone who reads only one of them.
      V.choiceRow("Language · שפה", "Menus, messages, voice replies and AI answers follow this choice. Song titles and artist names stay as they are.",
        V.segControl("set-interface-lang", [["en", "English"], ["he", "עברית"]], window.I18n ? I18n.language() : "en")) +
      V.choiceRow("Text size", "Makes lists, menus and messages easier to read",
        V.segControl("set-text-size", V.TEXT_SIZES, V.TEXT_SIZES.some(z => z[0] === s.textSize) ? s.textSize : "default")) +
      V.toggleRow("set-contrast", "High contrast", "Brighter secondary text and clearer outlines. Turns on by itself when your device asks for more contrast.", s.highContrast === true) +
      V.choiceRow("Accent color", "Highlights, active states and buttons across the app", swatches) +
      V.choiceRow("Song timeline", "How a song's progress is drawn in the players and in driving mode",
        V.segControl("set-progress-style", [["wave", "Wave"], ["line", "Line"]], s.progressStyle === "line" ? "line" : "wave")) +
      V.toggleRow("set-anims", "Animations", "Turn off for an instant, static interface", !!s.animations) +
      V.toggleRow("set-portrait-lock", "Lock portrait orientation", "Keep the app upright when you turn your phone. Turn off to allow rotation.", s.portraitLock !== false) +
      '<div class="set-note" id="set-orientation-status" role="status">' + V.esc(window.AppOrientation ? AppOrientation.status() : "Orientation control is unavailable in this browser.") + '</div>');
  }

  function playbackSettingsHtml(s) {
    return V.setSection("playback", "Playback",
      V.toggleRow("set-autoplay", "Autoplay similar songs", "Keeps the music going when the queue ends", !!s.autoplay) +
      V.toggleRow("set-rempos", "Remember episode position", "Resume podcasts and spoken word where you left them", !!s.rememberPosition) +
      V.toggleRow("set-skipseg", "Skip intros & sponsors", "Jumps over known sponsor reads, intros and outros inside a track", !!s.skipSegments) +
      V.toggleRow("set-musiconly", "Songs only", "Keep sketches, interviews and watch-videos out of autoplay", !!s.musicOnly) +
      V.toggleRow("set-normalize", "Even out volume", "Levels the loudness differences between tracks", !!s.normalize) +
      V.toggleRow("set-noyt", "Never fall back to YouTube", "Skips songs instead - no ads, keeps background play", !!s.noYtFallback) +
      V.choiceRow("Audio quality", "Higher quality uses more data", V.segControl("set-quality-seg", [["best", "Best"], ["normal", "Normal"], ["data", "Data saver"]], s.audioQuality || "best")) +
      V.choiceRow("Crossfade", "Blends the end of a song into the next", V.segControl("set-xfade-seg", [[0, "Off"], [2, "2s"], [4, "4s"], [8, "8s"], [12, "12s"]], s.crossfade != null ? s.crossfade : 4)));
  }

  function drivingSettingsHtml(s) {
    return V.setSection("driving", "Driving mode",
      '<div class="set-note">A stripped-down screen with three large controls, opened from the Drive button in the player.</div>' +
      V.toggleRow("set-drive", "Driving mode", "Turn off to hide the Drive button from the player", s.driveMode !== false) +
      V.choiceRow("Look", "Night is easier at the wheel after dark; day survives direct sun",
        V.segControl("set-drive-look", [["night", "Night"], ["day", "Day"]], s.driveLook === "day" ? "day" : "night")) +
      V.toggleRow("set-drive-awake", "Keep the screen on", "Stops the phone dimming while driving mode is open", s.driveKeepAwake !== false));
  }

  function notificationSettingsHtml(s) {
    return V.setSection("notifications", "Notifications",
      '<div class="set-status status-card" id="set-push-status">Checking…</div>' +
      '<div class="settings-actions"><button class="btn ghost" id="set-push-toggle" hidden></button></div>' +
      V.toggleRow("set-notify-new", "New release alerts", "Notify when someone you follow drops a new song, album or episode", s.notifyNewReleases !== false));
  }

  function storageSettingsHtml(s) {
    const cacheLimit = Number(s.cacheLimitMB);
    return V.setSection("storage", "Storage & data",
      V.toggleRow("set-wifi", "Download over Wi-Fi only", "connection" in navigator
        ? "Queued downloads wait instead of using mobile data"
        : "This browser does not report the connection type, so downloads cannot wait for Wi-Fi here", !!s.wifiOnlyDownloads) +
      V.settingsLink("set-stats", "Listening stats", "See your most-played songs, artists and time", "playback") +
      V.choiceRow("Song cache limit", "When the limit is reached, the least recently played cached songs go first. Songs not played for 30 days are removed",
        V.segControl("set-cache-seg", [[200, "200 MB"], [400, "400 MB"], [800, "800 MB"]], [200, 400, 800].includes(cacheLimit) ? cacheLimit : 400)) +
      V.settingsLink("set-clearcache", "Clear song cache", "Remove downloaded audio without touching your library", "storage") +
      V.settingsLink("set-clearsearches", "Clear search history", "Remove your recent searches from this device", "blocked") +
      V.settingsLink("set-clearhistory", "Clear listening history", "Reset recents, stats and listening-based recommendations", "blocked"));
  }

  function aiSettingsHtml(s) {
    return V.setSection("ai", "AI playlists",
      '<div class="set-note">Describe a playlist in your own words and it suggests the songs. Playlist requests go from this device to the provider. Daily prep below controls whether your key is also stored on your private server for overnight mixes.</div>' +
      V.choiceRow("Provider", "\"Both\" tries every Gemini key first, then falls back to Groq only once all of them have failed",
        V.segControl("set-ai-mode", [["gemini", "Gemini"], ["groq", "Groq"], ["both", "Both"]], Ai.getMode())) +
      Ai.providers.map(p => aiProviderBlockHtml(p)).join('<div class="ai-provider-sep"></div>') +
      V.choiceRow("Speech language", "What the orb listens for when you tap it. Recognition is done by the browser and may use an online service.",
        V.segControl("set-voice-lang", [["he-IL", "עברית"], ["en-US", "English"]], (window.I18n ? I18n.speechLanguage() : s.voiceLanguage || "he-IL"))) +
      V.toggleRow("set-voice-reply", "Spoken replies", "Answers a voice request out loud, with a voice stored on this device. On iPhone the answer stays on screen: iOS speaks only right after a tap, and speaking would keep your next request from being heard.", Voice.repliesOn ? Voice.repliesOn() : s.voiceReply !== false) +
      V.toggleRow("set-ai-home", "AI picks on Home", "Adds a “Picked for you today” row to Home, built from your own listening history and refreshed about once a day. It works without a key too, from the artists you play most; a key makes the picks wider, and a self-hosted server can build it overnight.", s.aiHomeSection === true));
  }

  function privateSessionSettingsHtml(s) {
    return V.setSection("private", "Private session",
      '<div class="set-note">A private session plays everything normally - your library, your playlists, the lot - and records none of it. Nothing played while it is on reaches your history, your stats, or what the AI is told you like, which is what keeps someone else\u2019s taste out of your recommendations after they have had the aux in the car. It is switched on with the detective at the top of the screen, and stays on until it is switched off.</div>' +
      V.toggleRow("set-private", "Private session", "Turn off to hide the detective from the top bar. Hiding it also ends a session already running.", s.privateSession !== false) +
      '<div class="set-status" id="set-private-status">' + V.esc(V.privateStatusText()) + '</div>');
  }

  function blockedSettingsHtml() {
    return V.setSection("blocked", "Blocked from autoplay",
      '<div id="blocked-card">' + blockedCardHtml() + '</div>');
  }

  function backupSettingsHtml(lastBackup) {
    // Silence was the worst answer here: on a phone the option simply did not exist, so
    // "automatic backup" looked like something the app had and was quietly doing.
    const canAutoBackup = "showSaveFilePicker" in window;
    const autoBackupButton = canAutoBackup ? '<button class="btn ghost" id="set-autobackup">Enable automatic backup</button>' : "";
    const autoBackupNote = canAutoBackup ? "" :
      '<div class="set-note">Automatic backup needs a desktop browser. On this device, use Download backup and keep the file somewhere safe.</div>';
    return V.setSection("backup", "Backup & transfer",
      '<div class="set-note">Your library, playlists, likes, listening history, settings and queue - in one file.</div>' +
      '<div class="set-status status-card" id="set-backup-status">' + V.esc(lastBackup) + '</div>' + autoBackupNote +
      '<div class="set-status status-card" id="set-sync-status">Checking sync…</div>' +
      '<div class="settings-actions">' + autoBackupButton + '<button class="btn ghost" id="set-sync-now" hidden>Sync now</button><button class="btn ghost" id="set-sync-conflict" hidden>Recover other-device copy</button><button class="btn ghost" id="set-backup">Download backup</button><button class="btn ghost" id="set-restore">Restore backup</button></div>' +
      '<input type="file" id="set-restore-file" accept="application/json,.json" hidden />');
  }

  function aboutSettingsHtml() {
    return V.setSection("about", "About Aura",
      '<div class="set-note">Open source under AGPL-3.0-only. <a href="https://github.com/YossiYad/aura" target="_blank" rel="noopener noreferrer">Source code</a> · <a href="https://github.com/YossiYad/aura/blob/main/THIRD-PARTY-NOTICES.md" target="_blank" rel="noopener noreferrer">Third-party notices</a></div>' +
      V.settingsLink("set-refresh", "Refresh app version", "Check for and load the latest available build", "backup") +
      V.settingsLink("set-logs", "Diagnostics", "View technical logs for troubleshooting", "about") +
      '<div class="set-version" id="set-version">Aura ' + V.APP_VERSION + '</div>');
  }

  function dangerSettingsHtml() {
    return V.setSection("danger", "Danger zone",
      V.settingsLink("set-clear", "Delete Aura data", "Permanently remove your library, playlists and history", "danger", true), "danger-zone");
  }
})();
