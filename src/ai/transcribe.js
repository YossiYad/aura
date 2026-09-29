(function () {
  const V = window.Aura.ai;
  // A recording turned into words by a provider, and the public face of the module.
  // Published on V for the other files of this module; see src/ai.js.
  Object.defineProperties(V, {
  });

  // ---------------- Transcription ----------------

  // On iPhone the built-in speech recognizer hears only the first request of a page load,
  // so later voice requests are recorded and sent here (see src/voice.js). Whisper on Groq
  // is built for this and answers in about a second; Gemini's multimodal model is the
  // fallback. Groq goes first even when both are allowed: Gemini's route hangs on some
  // networks (docs/ai-providers.md), and a spoken request cannot wait out that timeout.
  const TRANSCRIBE_MS = 20000;

  // Gemini's inline audio list names audio/m4a and audio/wav; iOS MediaRecorder reports
  // its recording as audio/mp4, which is the same container under the name it does not list.
  function geminiAudioMime(type) {
    const mime = String(type || "audio/mp4").split(";")[0].trim().toLowerCase();
    if (mime === "audio/mp4" || mime === "audio/x-m4a") return "audio/m4a";
    if (mime === "audio/x-wav") return "audio/wav";
    return mime;
  }

  function audioFilename(type) {
    const sub = String(type || "").split(";")[0].split("/")[1] || "";
    if (/mp4|m4a|aac/.test(sub)) return "request.m4a";
    if (sub === "webm") return "request.webm";
    if (sub === "ogg") return "request.ogg";
    if (sub === "wav" || sub === "x-wav") return "request.wav";
    if (sub === "mpeg" || sub === "mp3") return "request.mp3";
    return "request.m4a";
  }

  async function audioBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function transcribeGroq(key, blob, lang) {
    const form = new FormData();
    form.append("file", blob, audioFilename(blob.type));
    form.append("model", "whisper-large-v3-turbo");
    if (lang) form.append("language", lang);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TRANSCRIBE_MS);
    let res, data;
    try {
      res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { "Authorization": "Bearer " + key }, body: form, signal: ctl.signal
      });
      if (res.ok) data = await V.readJson(res, "Groq");
    } catch (e) {
      throw V.extractError(e, timedOut, TRANSCRIBE_MS / 1000);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("Rejected the request - check the Groq key in Settings"), { keyBad: true });
    }
    if (res.status === 429) throw Object.assign(new Error("Groq's free quota is used up for now"), { keyBad: true });
    if (!res.ok) throw new Error("Groq transcription error (HTTP " + res.status + ")");
    return String((data && data.text) || "").trim();
  }

  async function transcribeGemini(key, blob, lang) {
    const audio = await audioBase64(blob);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(V.getModel("gemini")) + ":generateContent?key=" + encodeURIComponent(key);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TRANSCRIBE_MS);
    let res, data;
    try {
      // text/plain, as in callGemini: no CORS preflight, and Gemini parses the JSON anyway.
      res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "text/plain" }, signal: ctl.signal,
        body: JSON.stringify({ contents: [{ parts: [
          { text: "Transcribe this spoken request word for word" + (lang === "he" ? ", in Hebrew" : "") +
            ". Reply with only the words that were said, nothing else, and with nothing at all if no words were said." },
          { inlineData: { mimeType: geminiAudioMime(blob.type), data: audio } }
        ] }] })
      });
      if (res.ok) data = await V.readJson(res, "Gemini");
    } catch (e) {
      throw V.extractError(e, timedOut, TRANSCRIBE_MS / 1000);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("Rejected the request - check the Gemini key in Settings"), { keyBad: true });
    }
    if (res.status === 429) throw Object.assign(new Error("Gemini's free quota is used up for now"), { keyBad: true });
    if (!res.ok) throw new Error("Gemini transcription error (HTTP " + res.status + ")");
    const parts = ((((data.candidates || [])[0] || {}).content || {}).parts) || [];
    return parts.map(part => (part && part.text) || "").join("").trim();
  }

  /**
   * Turns a recorded voice request into its words.
   * @param {Blob} blob The recording.
   * @param {string} [language] Language of the request, e.g. "he-IL".
   * @returns {Promise<string>} The words, trimmed; empty when nothing was said.
   * @throws {Error} With noKey set when no key is saved for the providers in use.
   */
  async function transcribe(blob, language) {
    if (!blob || !blob.size) throw new Error("Nothing was recorded");
    const lang = String(language || "").split(/[-_]/)[0].toLowerCase();
    const allowed = V.activeProviders();
    const items = [];
    for (const provider of /** @type {AiProvider[]} */ (["groq", "gemini"])) {
      if (!allowed.includes(provider)) continue;
      for (const key of V.getKeys(provider)) items.push({ id: provider + "|" + key, provider, key });
    }
    if (!items.length) {
      throw Object.assign(new Error("Add a Groq or Gemini API key in Settings to talk on this device"), { noKey: true });
    }
    const live = V.liveOrAll(items);
    const queue = live.concat(items.filter(item => live.indexOf(item) === -1));
    let lastErr = null;
    for (const item of queue) {
      try {
        const text = item.provider === "groq" ? await transcribeGroq(item.key, blob, lang) : await transcribeGemini(item.key, blob, lang);
        V.log("ai", item.provider + " transcribed via key ..." + item.key.slice(-4) + ", " + text.length + " characters");
        return text;
      } catch (e) {
        lastErr = e;
        V.log("ai", item.provider + " transcription via key ..." + item.key.slice(-4) + " failed: " + String(e.message || e).slice(0, 70));
        if (e.keyBad) V.markBad(item.id);
      }
    }
    throw lastErr || new Error("Could not transcribe the recording");
  }

  window.Ai = {
    providers: V.PROVIDER_ORDER,
    label: p => V.PROVIDERS[p].label,
    keyUrl: p => V.PROVIDERS[p].keyUrl,
    keyUrlLabel: p => V.PROVIDERS[p].keyUrlLabel,
    defaultModel: p => V.PROVIDERS[p].defaultModel,
    hasKey: V.hasKey, hasAnyKey: V.hasAnyKey, getKeys: V.getKeys, addKey: V.addKey, removeKey: V.removeKey,
    getMode: V.getMode, setMode: V.setMode,
    models: p => V.PROVIDERS[p].models || [],
    getModel: V.getModel, getModelStored: V.getModelStored, setModel: V.setModel,
    testKey: V.testKey,
    generatePlaylist: V.generatePlaylist, interpretPlayback: V.interpretPlayback,
    suggestPodcastShows: V.suggestPodcastShows,
    transcribe
  };
})();
