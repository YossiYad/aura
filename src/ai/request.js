(function () {
  const V = window.Aura.ai;
  // One request to a provider: the call to Gemini or Groq, the key rotation and cooldown, the answer read as JSON.
  // Published on V for the other files of this module; see src/ai.js.
  Object.defineProperties(V, {
    callOnce: { get: () => callOnce },
    extractError: { get: () => extractError },
    GEMINI_FALLBACK_MODEL: { get: () => GEMINI_FALLBACK_MODEL },
    generateContent: { get: () => generateContent },
    JSON_SHAPE: { get: () => JSON_SHAPE },
    liveOrAll: { get: () => liveOrAll },
    markBad: { get: () => markBad },
    readJson: { get: () => readJson },
    replyLanguage: { get: () => replyLanguage }
  });

  // A key that just hit its quota, or turns out not to be valid, is worth skipping for a
  // while rather than asking it again on every request - the same reasoning resolve() in
  // api.js uses for a streaming source that just failed. Keyed by provider+key so the same
  // literal key string under two providers can never collide.
  const failedAt = new Map();

  const COOLDOWN = 10 * 60 * 1000;

  function markBad(id) { failedAt.set(id, Date.now()); }

  function liveOrAll(list) {
    const live = list.filter(item => {
      const at = failedAt.get(item.id);
      return !at || Date.now() - at > COOLDOWN;
    });
    return live.length ? live : list;
  }

  // What both providers are told to produce, spelled out once so a provider with no
  // schema enforcement (Groq's JSON mode only guarantees valid JSON, not this shape) has
  // just as clear an instruction as the one that does (Gemini's responseSchema).
  const JSON_SHAPE = 'Reply with only a JSON object shaped exactly like this, nothing else: ' +
    '{"name": "playlist name", "targetMinutes": 90, "tracks": [{"title": "song title", "artist": "artist name"}]}. ' +
    'Omit the targetMinutes field entirely if no duration applies.';

  // Anything a model writes for the listener to read - a playlist name, a question back -
  // comes out in the interface language they picked. Song titles and artist names are
  // real names, so they stay as the artists wrote them.
  function replyLanguage() {
    return window.I18n ? window.I18n.aiLanguage() : "English";
  }

  const GEMINI_SCHEMA = {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "A short, catchy playlist name, 3-6 words" },
      targetMinutes: {
        type: "NUMBER",
        description: "Only if the request states or clearly implies a total listening duration " +
          "(a trip length, a workout time, etc.) - your best estimate of that duration in minutes. " +
          "Omit this field entirely otherwise."
      },
      tracks: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { title: { type: "STRING" }, artist: { type: "STRING" } },
          required: ["title", "artist"]
        }
      }
    },
    required: ["name", "tracks"]
  };

  function extractError(e, timedOut, seconds) {
    const detail = String((e && (e.name + ": " + e.message)) || e).slice(0, 120);
    if (e && e.notJson) return e;
    if (timedOut) {
      return Object.assign(new Error("Didn't respond within " + seconds + "s - likely blocked or unreachable on this network, not an app problem"), { network: true });
    }
    return Object.assign(new Error("Couldn't reach it (" + detail + ") - check your connection"), { detail, network: true });
  }

  // A 200 whose body does not parse (a proxy or captive portal injecting a page, an empty
  // answer) is the provider's answer, not a connectivity problem: reported as such, so the
  // key test does not blame the network for it.
  async function readJson(res, label) {
    try { return await res.json(); }
    catch (e) { throw Object.assign(new Error(label + " answered with something that was not JSON"), { notJson: true }); }
  }

  // One call against one Gemini key. Server-side 5xx answers are usually momentary
  // capacity blips rather than a verdict on the key, so one retry follows a short pause
  // before moving on. When the configured default itself is unavailable or retired, the
  // rolling alias takes the request - a model chosen by hand in Settings is respected
  // and never substituted.
  const GEMINI_FALLBACK_MODEL = "gemini-flash-latest";

  async function callGemini(key, model, prompt, schema) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, 55000);
    const send = candidate => {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(candidate) + ":generateContent?key=" + encodeURIComponent(key);
      // application/json is not a CORS-safelisted content type, so a cross-origin POST
      // with it forces an invisible OPTIONS preflight first. text/plain skips that -
      // Gemini parses the JSON body the same regardless of the declared Content-Type.
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        signal: ctl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema || GEMINI_SCHEMA }
        })
      });
    };
    // The retried-with-a-pause pass is spent only on the last candidate: when a pinned
    // fallback exists there is no point leaning on a model that just said 503 twice -
    // handing off immediately reaches a working answer sooner.
    const sendWithRetry = async (candidate, allowRetry) => {
      let r = await send(candidate);
      if (allowRetry && r.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        r = await send(candidate);
      }
      return r;
    };
    const candidates = model === V.PROVIDERS.gemini.defaultModel && GEMINI_FALLBACK_MODEL !== model
      ? [model, GEMINI_FALLBACK_MODEL] : [model];
    let res, data, tried = candidates[0];
    try {
      res = await sendWithRetry(candidates[0], candidates.length === 1);
      for (let i = 1; i < candidates.length && (res.status >= 500 || res.status === 404); i++) {
        V.log("ai", "gemini " + candidates[0] + " unavailable (HTTP " + res.status + "), trying " + candidates[i]);
        tried = candidates[i];
        res = await sendWithRetry(candidates[i], i === candidates.length - 1);
      }
      if (res.ok) data = await readJson(res, "Gemini");
    } catch (e) {
      V.log("ai", "gemini fetch failed (" + String((e && e.name) || e) + ")");
      throw extractError(e, timedOut, 55);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 400 || res.status === 403) {
      // A 400 also answers an unsupported location (a VPN exit, say), which is not the
      // key's fault and not worth resting the key over.
      let detail = "";
      try { const err = await res.json(); detail = String((err && err.error && (err.error.message || err.error.status)) || ""); } catch (e) {}
      const keyBad = res.status === 403 || !detail || /api key|API_KEY|permission/i.test(detail);
      throw Object.assign(new Error(keyBad ? "Rejected the request - check the Gemini key in Settings"
        : "Gemini rejected the request: " + detail.slice(0, 120)), { keyBad });
    }
    if (res.status === 429) {
      throw Object.assign(new Error("Gemini's free quota is used up for now"), { keyBad: true });
    }
    if (res.status === 404) throw new Error("Gemini couldn't find the model \"" + tried + "\" - check the Model field in Settings");
    if (!res.ok) {
      if (res.status >= 500) throw new Error("Gemini is overloaded right now (HTTP " + res.status + ") - it usually clears within minutes");
      throw new Error("Gemini error (HTTP " + res.status + ")");
    }
    const text = ((((data.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join("");
    if (!text) throw new Error("Gemini returned nothing usable");
    return text;
  }

  // One call against one Groq key - the OpenAI-compatible chat completions shape. Same
  // single-retry-on-5xx as the Gemini path: capacity blips are not key verdicts.
  async function callGroq(key, model, prompt) {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, 55000);
    const send = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      })
    });
    let res, data;
    try {
      res = await send();
      if (res.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        res = await send();
      }
      if (res.ok) data = await readJson(res, "Groq");
    } catch (e) {
      V.log("ai", "groq fetch failed (" + String((e && e.name) || e) + ")");
      throw extractError(e, timedOut, 55);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("Rejected the request - check the Groq key in Settings"), { keyBad: true });
    }
    if (res.status === 429) {
      throw Object.assign(new Error("Groq's free quota is used up for now"), { keyBad: true });
    }
    if (res.status === 404) throw new Error("Groq couldn't find the model \"" + model + "\" - check the Model field in Settings");
    if (!res.ok) {
      if (res.status >= 500) throw new Error("Groq is overloaded right now (HTTP " + res.status + ") - it usually clears within minutes");
      throw new Error("Groq error (HTTP " + res.status + ")");
    }
    const text = ((((data.choices || [])[0] || {}).message || {}).content || "");
    if (!text) throw new Error("Groq returned nothing usable");
    return text;
  }

  /**
   * @param {AiProvider} provider
   * @param {string} key
   * @param {string} prompt
   * @param {Object} [schema] Gemini response schema.
   * @returns {Promise<any>} The parsed JSON reply.
   */
  async function callOnce(provider, key, prompt, schema) {
    const model = V.getModel(provider);
    const text = provider === "gemini" ? await callGemini(key, model, prompt, schema) : await callGroq(key, model, prompt);
    try { return JSON.parse(text); }
    catch (e) { throw new Error(V.PROVIDERS[provider].label + " returned something that wasn't valid JSON"); }
  }

  // Every live key across both providers, Gemini first - one flat queue so a request
  // falls all the way through to Groq only once every Gemini key has actually failed.
  /**
   * Asks every live key in turn until one answers with JSON.
   * @param {string} prompt
   * @param {Object} [schema] Gemini response schema.
   * @returns {Promise<any>}
   */
  async function generateContent(prompt, schema) {
    if (!V.hasAnyKey()) throw new Error("Add a Gemini or Groq API key in Settings first");
    const providers = V.activeProviders();
    // Live keys first across both providers: applied per provider, a provider with one
    // cooling key would still be asked first on every request.
    const items = [];
    for (const provider of providers) {
      for (const key of V.getKeys(provider)) items.push({ id: provider + "|" + key, provider, key });
    }
    // A cooling key is asked last rather than never: when the live ones fail for a reason
    // of their own (an overloaded provider, a blocked route), it is the only one left.
    const live = liveOrAll(items);
    const queue = live.concat(items.filter(item => live.indexOf(item) === -1));
    if (!queue.length) {
      throw new Error("No key added for " + providers.map(p => V.PROVIDERS[p].label).join(" or ") +
        " - add one, or switch the provider in Settings");
    }
    let lastErr = null;
    for (const item of queue) {
      try {
        const out = await callOnce(item.provider, item.key, prompt, schema);
        V.log("ai", item.provider + " OK via key ..." + item.key.slice(-4));
        return out;
      } catch (e) {
        lastErr = e;
        V.log("ai", item.provider + " key ..." + item.key.slice(-4) + " failed: " + String(e.message || e).slice(0, 70));
        if (e.keyBad) markBad(item.id);
      }
    }
    throw lastErr || new Error("Request failed");
  }
})();
