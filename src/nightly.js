// Types for the Nightly module. Declared outside the closure so the editor sees them from
// any file; comments only, nothing at runtime.

/**
 * @typedef {Object} NightlyStatus
 * @property {boolean} enabled
 * @property {number} hour Local hour the run is due, 0-23.
 * @property {boolean} running
 * @property {number} at When the last run finished, in ms; 0 before the first.
 * @property {number} ok Tasks that finished in the last run.
 * @property {number} failed Tasks that failed in the last run.
 * @property {string} reason What started the last run.
 * @property {boolean} due
 * @property {number} next When the next run is due, in ms.
 */

(function () {
  // Home costs a handful of network round trips to put together - an AI request and the
  // song matching behind it, a search per feed row, a related-tracks lookup per seed.
  // Doing that while someone waits on the screen is the thing this module exists to stop:
  // once a night everything is built and written to its cache, and opening the app just
  // serves what is already there.
  //
  // There is no server in this: the AI keys live in localStorage on this device and stay
  // there, so the run has to happen in the page. Three things can start it - the app being
  // open when the hour comes round, a background wake-up from the service worker, or the
  // next launch after a missed slot - and whichever gets there first marks the day done.
  const STATE_KEY = "aura.nightly";
  const SYNC_TAG = "aura-nightly";
  const CHECK_MS = 5 * 60 * 1000;
  // The browser decides when a periodic sync actually fires; asking for twelve hours is
  // asking for "about daily, please", not for a time.
  const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const DEFAULT_HOUR = 4;
  // A first run is held back a few seconds so the launch it lands on paints from cache
  // before the rebuild starts competing for the connection.
  const STARTUP_DELAY_MS = 5000;

  const tasks = [];
  const listeners = [];
  let running = false;
  let started = false;

  function log(msg) { if (window.Log) Log.add("nightly", msg); }
  /** @returns {Partial<Settings>} */
  function settings() { return (window.Store && Store.settings()) || {}; }

  /**
   * @returns {boolean}
   */
  function enabled() { return settings().nightlyPrebuild !== false; }

  /**
   * @returns {number} Local hour of the nightly run, 0-23.
   */
  function hour() {
    const h = Number(settings().nightlyHour);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_HOUR;
  }

  function readState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // Local time on purpose: 4am means 4am where the phone is, and it follows the phone
  // across a timezone change instead of drifting against it.
  /**
   * @param {number} now In ms.
   * @returns {number} The most recent run time at or before `now`.
   */
  function lastSlot(now) {
    const d = new Date(now);
    d.setHours(hour(), 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  /**
   * @param {number} now In ms.
   * @returns {number} The next run time after `now`.
   */
  function nextSlot(now) {
    const d = new Date(lastSlot(now));
    d.setDate(d.getDate() + 1);
    d.setHours(hour(), 0, 0, 0);
    return d.getTime();
  }

  /**
   * @param {number} [now] Default: the current time.
   * @returns {boolean} True when no run has finished since the last slot.
   */
  function isDue(now) {
    now = now || Date.now();
    return Number(readState().at || 0) < lastSlot(now);
  }

  function notify() {
    listeners.forEach(fn => { try { fn(describe()); } catch (e) {} });
  }

  /**
   * @returns {NightlyStatus}
   */
  function describe() {
    const state = readState();
    const now = Date.now();
    return {
      enabled: enabled(),
      hour: hour(),
      running,
      at: Number(state.at || 0),
      ok: Number(state.ok || 0),
      failed: Number(state.failed || 0),
      reason: state.reason || "",
      due: isDue(now),
      next: nextSlot(now)
    };
  }

  // Registered once at load by whoever owns the work - the order they register in is the
  // order they run in, one at a time, so a nightly run never opens a dozen connections at
  // once on a phone that has just woken up.
  /**
   * Adds a task to every nightly run. Tasks run one at a time, in the order registered.
   * @param {string} name For the log.
   * @param {() => Promise<void> | void} fn
   */
  function register(name, fn) {
    if (typeof fn === "function") tasks.push({ name, fn });
  }

  /**
   * @param {(status: NightlyStatus) => void} fn
   */
  function onChange(fn) { if (typeof fn === "function") listeners.push(fn); }

  /**
   * Runs every registered task now.
   * @param {string} reason For the log.
   * @returns {Promise<boolean>} False when a run was already going or nothing is registered.
   */
  async function run(reason) {
    if (running || !tasks.length) return false;
    running = true;
    notify();
    const at = Date.now();
    let ok = 0;
    let failed = 0;
    log("daily prep started (" + reason + ")");
    for (const task of tasks) {
      try {
        await task.fn();
        ok++;
      } catch (e) {
        failed++;
        log(task.name + " failed: " + String((e && e.message) || e).slice(0, 80));
      }
    }
    // The day is marked done even when parts of it failed. A provider that is down at 4am
    // is not a reason to keep retrying it every five minutes all morning; the next slot
    // picks it up, and Home still has yesterday's copy to show in the meantime.
    // Recorded at the finish: a run started just before the slot hour that finishes just
    // after it would otherwise read as older than the slot and be repeated at once.
    writeState({ at: Date.now(), ok, failed, reason, hour: hour() });
    running = false;
    log("daily prep done in " + Math.round((Date.now() - at) / 1000) + "s - " + ok + " ready" +
      (failed ? ", " + failed + " failed" : ""));
    notify();
    return true;
  }

  /**
   * @param {string} reason For the log.
   * @returns {Promise<boolean>} Whether a run happened.
   */
  async function runIfDue(reason) {
    if (!enabled() || running || !isDue()) return false;
    // Offline is not a failed run, it is no run at all: leave the day marked undone so the
    // next check picks it up instead of writing off today's mix.
    if (navigator.onLine === false) return false;
    return run(reason);
  }

  /**
   * Asks the browser to wake the service worker daily, where it supports that.
   * @returns {Promise<void>}
   */
  async function registerBackgroundWake() {
    if (!("serviceWorker" in navigator)) return;
    if (!("periodicSync" in ServiceWorkerRegistration.prototype)) {
      log("this browser has no background wake-ups - the run happens on the next launch instead");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!enabled()) {
        try { await reg.periodicSync.unregister(SYNC_TAG); } catch (e) {}
        return;
      }
      // Chrome hands this out on its own terms - an installed app it considers used. A
      // refusal is ordinary, not an error: the launch-time catch-up covers the same ground.
      if (navigator.permissions) {
        const status = await navigator.permissions.query({ name: /** @type {PermissionName} */ ("periodic-background-sync") }).catch(() => null);
        if (status && status.state !== "granted") {
          log("background wake-ups not granted - the run happens on the next launch instead");
          return;
        }
      }
      await reg.periodicSync.register(SYNC_TAG, { minInterval: SYNC_INTERVAL_MS });
      log("background wake-ups registered");
    } catch (e) {
      log("no background wake-ups: " + String((e && e.message) || e).slice(0, 80));
    }
  }

  // Called when the settings change, so turning the run off also stops the browser waking
  // the app for it, and turning it back on re-arms it.
  function applySettings() {
    notify();
    registerBackgroundWake();
    runIfDue("settings changed");
  }

  /** Starts checking for the nightly slot. Safe to call more than once. */
  function init() {
    if (started) return;
    started = true;
    setTimeout(() => runIfDue("app open"), STARTUP_DELAY_MS);
    // Catches the hour coming round while the app sits open overnight, which is the one
    // case where the run really does happen at the time it was asked for.
    setInterval(() => runIfDue("scheduled hour"), CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) runIfDue("back in the foreground");
    });
    window.addEventListener("online", () => runIfDue("back online"));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", e => {
        if (e.data && e.data.type === "RUN_NIGHTLY") runIfDue("background wake-up");
      });
    }
    registerBackgroundWake();
  }

  window.Nightly = {
    init, register, onChange, describe, applySettings,
    enabled, hour, isDue,
    run: reason => run(reason || "asked for"),
    runIfDue
  };
})();
