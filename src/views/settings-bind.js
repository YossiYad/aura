(function () {
  const V = window.Aura.views;
  // The controls of the settings sections: toggles, choices, speech and AI keys, push.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    bindAiKeys: { get: () => bindAiKeys },
    bindPushStatus: { get: () => bindPushStatus },
    bindSettingsChoices: { get: () => bindSettingsChoices },
    bindSettingsToggles: { get: () => bindSettingsToggles },
    bindSpeechAndProvider: { get: () => bindSpeechAndProvider }
  });

  function bindSettingsToggles() {
    const bindToggle = (id, key) => {
      const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
      if (!el) return;
      el.onchange = () => {
        const patch = {};
        patch[key] = el.checked;
        Store.patchSettings(patch);
        if (key === "animations" || key === "highContrast") V.applyAppearance();
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
          if (status) status.textContent = V.privateStatusText();
          if (!el.checked) V.toast("Private session hidden - plays are recorded again");
        }
        if (key === "nightlyPrebuild" && window.Nightly) { Nightly.applySettings(); V.updateNightlyStatus(); }
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

  function bindSpeechAndProvider() {
    const interfaceLangSeg = document.getElementById("set-interface-lang");
    if (interfaceLangSeg) interfaceLangSeg.onclick = /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
      const button = /** @type {HTMLElement} */ (e.target.closest("[data-val]"));
      if (!button || button.classList.contains("on") || !window.I18n) return;
      try {
        I18n.setLanguage(button.dataset.val);
        V.renderSettingsPage();
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
          V.renderSettingsPage();
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
          V.renderSettingsPage();
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
    bindSeg("set-progress-style", "progressStyle", null, V.applyAppearance);
    bindSeg("set-text-size", "textSize", null, V.applyAppearance);
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
        V.applyAppearance();
      };
    });
  }
})();
