(function () {
  const V = window.Aura.ai;
  // Testing a key from Settings: the host reached, the models listed, a real request answered.
  // Published on V for the other files of this module; see src/ai.js.
  Object.defineProperties(V, {
    testKey: { get: () => testKey }
  });

  // ---------------- Key diagnostics ----------------

  // "It works on my phone but not on hers" is the hardest report to act on, because every
  // failure above collapses into one line by the time a user sees it - a blocked route, a
  // dead key and a model the key has no access to all read as "AI didn't work". This walks
  // the same path a real request takes, stopping at the first stage that breaks, so the
  // answer names the stage instead of the symptom. Stages report as they finish: on the
  // networks this exists to diagnose, one can sit for its whole timeout before it speaks.
  const PROBE_MS = 8000;

  const LIST_MS = 20000;

  // True when the request physically reached the host. mode:"no-cors" makes the answer
  // opaque, which is exactly what is wanted here: any HTTP status counts as reached, so
  // this separates "the route to this host is dead" from "the host answered and said no".
  async function reaches(host) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_MS);
    try {
      await fetch(host + "/?" + Date.now(), { mode: "no-cors", cache: "no-store", signal: ctl.signal });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // The models this key is actually allowed to call, straight from the provider. A key can
  // be perfectly valid and still 404 on a model, which is what makes this its own stage.
  async function listModels(provider, key) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, LIST_MS);
    let res, data;
    const models = [];
    try {
      let pageToken = "";
      do {
        res = provider === "gemini"
          ? await fetch(V.PROVIDERS.gemini.host + "/v1beta/models?key=" + encodeURIComponent(key) +
              "&pageSize=1000" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""), { signal: ctl.signal })
          : await fetch(V.PROVIDERS.groq.host + "/openai/v1/models", {
              headers: { "Authorization": "Bearer " + key }, signal: ctl.signal
            });
        if (!res.ok) break;
        data = await V.readJson(res, V.PROVIDERS[provider].label);
        if (provider === "gemini") models.push(...(data.models || []));
        pageToken = provider === "gemini" ? data.nextPageToken : "";
      } while (pageToken);
    } catch (e) {
      throw V.extractError(e, timedOut, LIST_MS / 1000);
    } finally {
      clearTimeout(timer);
    }
    // A failing later page leaves the models already listed; only an empty list is a verdict.
    if (!res.ok && !models.length) {
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw Object.assign(new Error("the provider rejected this key (HTTP " + res.status + ")"), { keyBad: true });
      }
      if (res.status === 429) throw new Error("this key is out of free quota for now (HTTP 429)");
      throw new Error("the model list came back HTTP " + res.status);
    }
    // Gemini names a model "models/gemini-2.5-flash" and lists what it can be asked to do;
    // a model that exists but does not do generateContent answers 404 just like a missing
    // one, so it is filtered out here rather than passing as available.
    if (provider === "gemini") {
      return models
        .filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
        .map(m => String(m.name || "").replace(/^models\//, ""))
        .filter(Boolean);
    }
    return (data.data || []).map(m => String(m.id || "")).filter(Boolean);
  }

  /**
   * Walks the path a real request takes and reports the first stage that fails.
   * @param {AiProvider} provider
   * @param {string} key
   * @param {(step: KeyTestStep) => void} [onStep] Called as each stage finishes.
   * @returns {Promise<{ ok: boolean, steps: KeyTestStep[], verdict: string }>}
   */
  async function testKey(provider, key, onStep) {
    const label = V.PROVIDERS[provider].label;
    const other = V.PROVIDER_ORDER.filter(p => p !== provider)[0];
    const steps = [];
    const step = (text, ok, note, ms) => {
      const s = { text, ok, note: note || "", ms: ms || 0 };
      steps.push(s);
      try { if (onStep) onStep(s); } catch (e) {}
      return s;
    };
    const done = (verdict, ok) => {
      V.log("ai", "tested " + provider + " key ..." + String(key).slice(-4) + ": " + verdict.slice(0, 90));
      return { ok: ok === undefined ? steps.every(st => st.ok) : ok, steps, verdict };
    };
    const took = t0 => Date.now() - t0;

    if (navigator.onLine === false) {
      step("This device is online", false, "the browser reports no connection");
      return done("This device has no network at all - nothing else can be tested until it is back.");
    }

    // Both hosts at once: on its own, "Gemini is unreachable" could equally be a dead
    // connection, and the other provider's host is the control that tells them apart.
    let t0 = Date.now();
    const [here, there] = await Promise.all([reaches(V.PROVIDERS[provider].host), reaches(V.PROVIDERS[other].host)]);
    step(label + "'s server is reachable", here, V.hostName(provider), took(t0));
    step(V.PROVIDERS[other].label + "'s server is reachable", there, V.hostName(other), took(t0));
    if (!here) {
      return done(there
        ? label + " can't be reached from this network, while " + V.PROVIDERS[other].label + " answers fine from the " +
          "same device. That is this network dropping the route - not the key, not the app. Add a " +
          V.PROVIDERS[other].label + " key and leave Provider on Both, or try another network."
        : "Nothing answered on this network. The connection itself is down, or something in front of it " +
          "(a captive Wi-Fi portal, a VPN) is holding every request.");
    }

    t0 = Date.now();
    let models;
    try {
      models = await listModels(provider, key);
    } catch (e) {
      step("The key is accepted", false, String(e.message || e), took(t0));
      if (e.keyBad) return done("The key itself is the problem - " + label + " refuses it. Remove it here and paste a fresh one from " + V.PROVIDERS[provider].keyUrlLabel + ".");
      return done("The server is reachable but the request died on the way (" + String(e.message || e) + "). " +
        "A connection that opens and then goes quiet is the signature of a network filtering this host " +
        "rather than blocking it outright - a key for " + V.PROVIDERS[other].label + " is the way around it.");
    }
    step("The key is accepted", true, models.length + " model(s) available to it", took(t0));

    const model = V.getModel(provider);
    const has = models.indexOf(model) !== -1;
    const fallbackHas = provider === "gemini" && model === V.PROVIDERS.gemini.defaultModel && models.indexOf(V.GEMINI_FALLBACK_MODEL) !== -1;
    step("It can use " + model, has, has ? "" : (fallbackHas ? "not on this key - requests fall back to " + V.GEMINI_FALLBACK_MODEL : "not on this key"), 0);
    if (!has && !fallbackHas) {
      return done("The key works, but " + model + " is not one of the models it may call - that is where the 404 " +
        "comes from. Pick one of these under Model above: " + models.slice(0, 6).join(", ") + ".");
    }

    t0 = Date.now();
    try {
      await V.callOnce(provider, key, "Name one well-known song. " + V.JSON_SHAPE);
    } catch (e) {
      step("A real request comes back", false, String(e.message || e), took(t0));
      // Reaching the host and listing its models, then losing the request that carries a
      // real payload, is the exact shape of a route that filters rather than blocks - the
      // small request slips through and the large one is dropped in silence.
      if (e.network) {
        return done(label + " answers small requests from this network but the real one never came back (" +
          String(e.message || e) + "). Nothing here is fixable from the app or the key - a " +
          V.PROVIDERS[other].label + " key with Provider on Both is the way around it.");
      }
      return done("The network and the key are both fine - " + label + " itself refused this one: " +
        String(e.message || e) + ". If it keeps happening, a second provider stops a bad stretch on one " +
        "from meaning no AI at all.");
    }
    step("A real request comes back", true, "", took(t0));
    return done(has
      ? "All good - " + label + " answered on " + model + " in " + (steps[steps.length - 1].ms / 1000).toFixed(1) + "s."
      : "Working, but on " + V.GEMINI_FALLBACK_MODEL + " rather than " + model + ", which costs a wasted round trip " +
        "on every request. Set Model above to " + V.GEMINI_FALLBACK_MODEL + " to skip it.", true);
  }
})();
