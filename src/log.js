(function () {
  const entries = [];
  const MAX = 500;
  // Android can finish the app's activity outright on a Back press (no pagehide, no
  // unload - the process is just gone), which loses anything kept only in memory. Mirroring
  // each line to localStorage means the log from the session that just disappeared is still
  // there to read once the app is reopened, instead of starting blank at "logger started".
  const STORAGE_KEY = "aura-log-v1";

  function ts() {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, entries.join("\n")); } catch (e) {}
  }

  /**
   * Appends a line to the diagnostic log, which survives the app being killed.
   * @param {string} tag Area of the app, e.g. "player" or "sync".
   * @param {*} msg
   */
  function add(tag, msg) {
    entries.push(ts() + " [" + tag + "] " + String(msg));
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    persist();
  }

  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) {
      entries.push("--- previous session (may end abruptly if the app was killed) ---");
      entries.push(...prev.split("\n").slice(-(MAX - 3)));
      entries.push("--- new session ---");
    }
  } catch (e) {}

  window.addEventListener("error", e => {
    add("js-error", (e.message || "error") + " @ " + String(e.filename || "").split("/").pop() + ":" + e.lineno);
  });
  window.addEventListener("unhandledrejection", e => {
    const r = e.reason;
    add("promise", String((r && (r.message || r)) || "unhandled rejection"));
  });

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = function () { add("warn", Array.from(arguments).map(String).join(" ")); origWarn.apply(null, arguments); };
  console.error = function () { add("error", Array.from(arguments).map(String).join(" ")); origError.apply(null, arguments); };

  add("app", "logger started, page loaded");

  window.Log = {
    add,
    dump: () => entries.join("\n"),
    count: () => entries.length,
    clear: () => { entries.length = 0; persist(); add("app", "log cleared"); }
  };
})();
