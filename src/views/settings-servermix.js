(function () {
  const V = window.Aura.views;
  // Daily prep and the server-built mix: the key handoff to the server and its status row.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    bindDailyPrep: { get: () => bindDailyPrep },
    bindServerMix: { get: () => bindServerMix },
    dailyPrepSettingsHtml: { get: () => dailyPrepSettingsHtml },
    syncServerMixKey: { get: () => syncServerMixKey }
  });

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
  /** @type {Promise<any>} The last sync queued; the next one runs after it. */
  let serverMixSyncing = Promise.resolve(null);

  function syncServerMixKey(known) {
    // The switch flipped while the page-load sync is still out runs after it, reading
    // the switch as it is then; a null here read as "no server", hiding the row behind a
    // false error although the setting had been saved.
    serverMixSyncing = serverMixSyncing.then(() => syncServerMixKeyNow(known));
    return serverMixSyncing;
  }

  async function syncServerMixKeyNow(known) {
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

  function dailyPrepSettingsHtml(s) {
    return V.setSection("daily", "Daily prep",
      '<div class="set-note">Home is put together once a night - the AI row, the rows below it, the recommendations and their artwork - so opening the app hands you what is already there instead of building it while you wait.</div>' +
      V.toggleRow("set-nightly", "Prepare Home overnight", "With this off, every row is built the moment Home opens and you wait for it", s.nightlyPrebuild !== false) +
      V.choiceRow("Time", "This device's own clock. If it is asleep or offline then, the run happens the next time you open the app - and while the browser allows it, in the background.",
        V.nightlyHourPicker(window.Nightly ? Nightly.hour() : 4)) +
      '<div class="set-status" id="set-nightly-status">' + V.esc(V.nightlyStatusText()) + '</div>' +
      '<div class="settings-actions"><button class="btn ghost" id="set-nightly-now">Prepare now</button></div>' +
      '<div id="set-servermix-row" hidden>' +
        V.toggleRow("set-servermix", "Let the server use my key",
          "The nightly mix is built with your own AI key, so it has to be on the server. It is stored there in the clear, and turning this off deletes it again. Only leave it on for a server you run yourself.",
          s.serverMixKey !== false) + '</div>' +
      '<div class="set-status" id="set-servermix-status" hidden></div>');
  }

  function bindDailyPrep() {
    const nightlyHour = /** @type {HTMLSelectElement} */ (document.getElementById("set-nightly-hour"));
    if (nightlyHour) {
      nightlyHour.onchange = () => {
        Store.patchSettings({ nightlyHour: Number(nightlyHour.value) });
        if (window.Nightly) Nightly.applySettings();
        V.updateNightlyStatus();
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
          V.updateNightlyStatus();
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
})();
