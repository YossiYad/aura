(function () {
  let preference;
  let request = 0;
  let message = "";

  function report(text) {
    message = text;
    const label = document.getElementById("set-orientation-status");
    if (label) label.textContent = text;
  }

  async function apply(force) {
    const locked = Store.settings().portraitLock !== false;
    if (!force && locked === preference) return;
    preference = locked;
    const current = ++request;
    if (document.hidden) return;
    const orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.lock !== "function") {
      report("This browser cannot control rotation. Use your device's rotation lock.");
      return;
    }
    report("Applying orientation preference...");
    try {
      // unlock() restores the manifest's portrait default. Use any to let the
      // installed app rotate when the user switches the setting off.
      await orientation.lock(locked ? "portrait" : "any");
      if (current !== request) return;
      report(locked ? "Portrait orientation is locked." : "Rotation is allowed, subject to your device's rotation setting.");
    } catch (error) {
      if (current !== request) return;
      report("This browser could not apply the preference. Try the installed app, or use your device's rotation setting.");
    }
  }

  window.AppOrientation = { status: () => message };
  Store.onChange(() => { apply(false); });
  window.addEventListener("pageshow", () => { apply(true); });
  document.addEventListener("visibilitychange", () => { apply(true); });
  document.addEventListener("fullscreenchange", () => { apply(true); });
  // Some browsers accept a lock only after the first user interaction.
  document.addEventListener("pointerup", () => { apply(true); }, { once: true });
  apply(true);
})();
