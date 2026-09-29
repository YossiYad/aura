// Types for the Ai module. Declared outside the closure so the editor sees them from any
// file; comments only, nothing at runtime.

/** @typedef {"gemini" | "groq"} AiProvider */

/**
 * A song the model suggested, before it is matched to an upload.
 * @typedef {Object} SuggestedSong
 * @property {string} title
 * @property {string} artist
 */

/**
 * @typedef {Object} GeneratedPlaylist
 * @property {string} name
 * @property {SuggestedSong[]} tracks
 * @property {number} requestedCount
 * @property {number | null} targetSeconds Total length asked for, when the request named one.
 */

/**
 * A spoken playback request, read by the model.
 * @typedef {Object} PlaybackIntent
 * @property {"song" | "artist" | "latest" | "playlist" | "liked" | "mix" | "clarify"} kind
 * @property {string} query Song title, artist, playlist or mix name, or the question to ask back.
 * @property {string} artist Performer, when a song names one.
 * @property {SuggestedSong[]} tracks The songs of a mix; empty for every other kind.
 * @property {string[]} [names] Other spellings the performer goes by on YouTube, for artist and
 * latest requests: the Latin name of a Hebrew one and the other way round. Tried in turn when
 * the spoken name finds no channel.
 */

/**
 * @typedef {Object} KeyTestStep
 * @property {string} text
 * @property {boolean} ok
 * @property {string} note
 * @property {number} ms
 */

(function () {
  // The AI module in several files: this one holds the providers, keys, mode and model
  // settings, and src/ai/ holds one file per area, loaded after it in the order index.html
  // lists them. Each file is its own closure; what one file needs from another it reaches
  // through V, window.Aura.ai, where each file publishes at its top the names the others
  // use. The public face, window.Ai, is put together in the last file.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).ai = {};
  // Published on V for the other files of this module; see src/ai.js.
  Object.defineProperties(V, {
    activeProviders: { get: () => activeProviders },
    addKey: { get: () => addKey },
    getKeys: { get: () => getKeys },
    getMode: { get: () => getMode },
    getModel: { get: () => getModel },
    getModelStored: { get: () => getModelStored },
    hasAnyKey: { get: () => hasAnyKey },
    hasKey: { get: () => hasKey },
    hostName: { get: () => hostName },
    log: { get: () => log },
    PROVIDER_ORDER: { get: () => PROVIDER_ORDER },
    PROVIDERS: { get: () => PROVIDERS },
    removeKey: { get: () => removeKey },
    setMode: { get: () => setMode },
    setModel: { get: () => setModel }
  });
  // Keys live outside Store on purpose: Store.settings() rides along in
  // Store.exportData(), which is what gets pushed to the sync server and written into
  // backup files. An API key has no business leaving this device either way.
  const LEGACY_SINGLE_KEY = "aura.geminiKey";
  const LEGACY_GEMINI_KEYS = "aura.geminiKeys";
  const LEGACY_GEMINI_MODEL = "aura.geminiModel";

  const PROVIDERS = {
    gemini: {
      label: "Gemini",
      keysStorage: "aura.aiKeys.gemini",
      modelStorage: "aura.aiModel.gemini",
      // Pinned rather than rolling, at the owner's call: a stable model answers more
      // reliably than whichever one the alias currently points at. When this model is
      // eventually retired (2.5 Flash is slated for October 2026), GEMINI_FALLBACK_MODEL
      // below picks the request up, so the sunset degrades into a silent handoff instead
      // of a wall of 404s.
      defaultModel: "gemini-2.5-flash",
      models: ["gemini-2.5-flash", "gemini-flash-latest"],
      host: "https://generativelanguage.googleapis.com",
      keyUrl: "https://aistudio.google.com/apikey",
      keyUrlLabel: "aistudio.google.com/apikey"
    },
    groq: {
      label: "Groq",
      keysStorage: "aura.aiKeys.groq",
      modelStorage: "aura.aiModel.groq",
      // llama-3.3-70b-versatile is Enterprise-tier only, not free - this one is the
      // larger of the two models Groq actually lists as available on the free tier.
      defaultModel: "openai/gpt-oss-120b",
      models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
      host: "https://api.groq.com",
      keyUrl: "https://console.groq.com/keys",
      keyUrlLabel: "console.groq.com/keys"
    }
  };
  // Tried in this order: every live Gemini key before any Groq key. Not a ranking of
  // quality - Gemini was simply the first one this app supported, so an existing Gemini
  // setup keeps behaving exactly as it did before Groq existed.
  /** @type {AiProvider[]} */
  const PROVIDER_ORDER = ["gemini", "groq"];
  const MODE_STORAGE = "aura.aiMode";

  function log(tag, msg) { if (window.Log) Log.add(tag, msg); }
  function hostName(provider) { return PROVIDERS[provider].host.replace(/^https?:\/\//, ""); }

  // "both" (the default) is the fallback behavior generateContent() always had - gemini
  // then groq. Picking one provider here means only that one is ever tried, even if the
  // other also has a key saved.
  /**
   * @returns {AiProvider | "both"}
   */
  function getMode() {
    try {
      const m = localStorage.getItem(MODE_STORAGE);
      return (m === "gemini" || m === "groq") ? m : "both";
    } catch (e) { return "both"; }
  }
  /**
   * @param {AiProvider | "both"} mode
   */
  function setMode(mode) {
    try {
      if (mode === "gemini" || mode === "groq") localStorage.setItem(MODE_STORAGE, mode);
      else localStorage.removeItem(MODE_STORAGE);
    } catch (e) {}
  }
  /**
   * @returns {AiProvider[]}
   */
  function activeProviders() {
    const mode = getMode();
    return mode === "both" ? PROVIDER_ORDER : [mode];
  }

  /**
   * @param {AiProvider} provider
   * @returns {string[]}
   */
  function getKeys(provider) {
    try {
      const raw = JSON.parse(localStorage.getItem(PROVIDERS[provider].keysStorage) || "[]");
      return Array.isArray(raw) ? raw.filter(k => typeof k === "string" && k.trim()) : [];
    } catch (e) { return []; }
  }
  /**
   * @param {AiProvider} provider
   * @param {string[]} list
   */
  function saveKeys(provider, list) {
    localStorage.setItem(PROVIDERS[provider].keysStorage, JSON.stringify(list));
  }
  /**
   * @param {AiProvider} provider
   * @param {string} key
   * @returns {string[]} The provider's keys after adding.
   */
  function addKey(provider, key) {
    const v = String(key || "").trim();
    if (!v) return getKeys(provider);
    const keys = getKeys(provider);
    if (keys.includes(v)) return keys;
    keys.push(v);
    saveKeys(provider, keys);
    return keys;
  }
  /**
   * @param {AiProvider} provider
   * @param {string} key
   * @returns {string[]} The provider's keys after removing.
   */
  function removeKey(provider, key) {
    const keys = getKeys(provider).filter(k => k !== key);
    saveKeys(provider, keys);
    return keys;
  }
  /**
   * @param {AiProvider} provider
   * @returns {boolean}
   */
  function hasKey(provider) { return getKeys(provider).length > 0; }
  /**
   * @returns {boolean}
   */
  function hasAnyKey() { return PROVIDER_ORDER.some(p => hasKey(p)); }

  // Carried over once from before Groq existed, when this only ever talked to Gemini and
  // stored things under its own name.
  (function migrateLegacy() {
    try {
      const oldMultiKeys = JSON.parse(localStorage.getItem(LEGACY_GEMINI_KEYS) || "null");
      if (Array.isArray(oldMultiKeys) && oldMultiKeys.length && !getKeys("gemini").length) {
        saveKeys("gemini", oldMultiKeys.filter(k => typeof k === "string" && k.trim()));
      }
      const oldSingle = (localStorage.getItem(LEGACY_SINGLE_KEY) || "").trim();
      if (oldSingle) {
        if (!getKeys("gemini").includes(oldSingle)) saveKeys("gemini", getKeys("gemini").concat([oldSingle]));
        localStorage.removeItem(LEGACY_SINGLE_KEY);
      }
      localStorage.removeItem(LEGACY_GEMINI_KEYS);
      const oldModel = localStorage.getItem(LEGACY_GEMINI_MODEL);
      if (oldModel && !localStorage.getItem(PROVIDERS.gemini.modelStorage)) {
        localStorage.setItem(PROVIDERS.gemini.modelStorage, oldModel);
      }
      localStorage.removeItem(LEGACY_GEMINI_MODEL);
    } catch (e) {}
  })();

  /**
   * @param {AiProvider} provider
   * @returns {string} The chosen model, or the default.
   */
  function getModel(provider) {
    try { return (localStorage.getItem(PROVIDERS[provider].modelStorage) || "").trim() || PROVIDERS[provider].defaultModel; }
    catch (e) { return PROVIDERS[provider].defaultModel; }
  }
  // What was actually stored, empty when unset - unlike getModel, which fills in the
  // default and so cannot tell "left on default" from "pinned to the default's value".
  /**
   * @param {AiProvider} provider
   * @returns {string} The chosen model; empty when left on the default.
   */
  function getModelStored(provider) {
    try { return (localStorage.getItem(PROVIDERS[provider].modelStorage) || "").trim(); }
    catch (e) { return ""; }
  }
  /**
   * @param {AiProvider} provider
   * @param {string} model Empty or the default model clears the choice.
   */
  function setModel(provider, model) {
    try {
      const v = String(model || "").trim();
      if (v && v !== PROVIDERS[provider].defaultModel) localStorage.setItem(PROVIDERS[provider].modelStorage, v);
      else localStorage.removeItem(PROVIDERS[provider].modelStorage);
    } catch (e) {}
  }

})();
