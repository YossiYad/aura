(function () {
  const V = window.Aura.main;
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    auditHitTargets: { get: () => auditHitTargets },
    describeElement: { get: () => describeElement },
    isIOS: { get: () => isIOS },
    isStandalone: { get: () => isStandalone },
    resetViewportDrift: { get: () => resetViewportDrift },
    syncKeyboardViewport: { get: () => syncKeyboardViewport },
    tapControls: { get: () => tapControls },
    viewportSnapshot: { get: () => viewportSnapshot }
  });

  // The app frame is one full-height flex column, so the bottom nav can only sit above the
  // bottom of the screen if the frame itself is shorter than what the device paints. Phone
  // browsers do under-report that height (100dvh in an installed PWA is the usual culprit),
  // so measure it, then check the nav really landed at the bottom and close any leftover gap.
  let appHeight = 0;
  let cachedInset = null;
  let keyboardOpen = false, fullViewportHeight = 0, fullViewportWidth = 0;
  let keyboardScrollFrame = 0;

  // Reads a resolved safe-area inset (tokens.css maps them from env()).
  function insetPx(name) {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;bottom:0;left:0;width:0;pointer-events:none;visibility:hidden;height:var(" + name + ",0px)";
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return px;
  }

  function bottomInset() {
    if (cachedInset == null) cachedInset = insetPx("--safe-bottom");
    return cachedInset;
  }

  function isStandalone() {
    return !!(window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      navigator.standalone);
  }

  function isIOS() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  if (isIOS() && isStandalone()) {
    document.documentElement.classList.add("ios-standalone");
  }

  if (/Android/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("android");
  }

  function measuredViewport() {
    const inner = window.innerHeight || 0;
    const vv = window.visualViewport;
    // An open keyboard shrinks the visual viewport - keep the full frame in that case.
    const reported = (vv && vv.height > inner * 0.75) ? Math.max(inner, vv.height) : inner;
    if (!isStandalone() || !isIOS()) return reported;

    // Both corrections below are for a view that runs under the status bar, and a top
    // inset is how iOS says it does. Under an opaque status bar (index.html asks for one)
    // the view starts below the bar and ends at the screen's bottom edge, so being one
    // status bar shorter than the screen is correct there - the same 59px the bug leaves -
    // and stretching the frame would push the navigation off the screen. Read it fresh:
    // the insets arrive a moment after launch.
    const underStatusBar = insetPx("--safe-top") >= 1;

    // Some iOS releases reserve a status-bar-sized strip below the web layer. The bottom
    // inset is unreliable in this state, so identify it from the actual height mismatch.
    // No DOM element can enter the strip, and stretching the app would clip the nav.
    const physicalHeight = screen.height || 0;
    const gap = physicalHeight - reported;
    const systemGap = underStatusBar && inner > (window.innerWidth || 0) && gap >= 40 && gap <= 100;
    document.documentElement.classList.toggle("ios-system-gap", systemGap);
    if (systemGap) {
      document.documentElement.style.setProperty("--ios-system-gap-size", Math.round(gap) + "px");
      return physicalHeight;
    }
    document.documentElement.style.removeProperty("--ios-system-gap-size");
    if (!underStatusBar) return reported;

    // Installed iOS apps using black-translucent sometimes report innerHeight without
    // the lower part of the physical screen even though the web view still paints it.
    // That leaves the flex frame short and exposes a dead strip under the navigation.
    // screen.height describes that full painted area. Limit the correction so an odd
    // browser or desktop display-mode implementation cannot create a giant frame.
    const screenHeight = screen.availHeight || screen.height || 0;
    const missing = screenHeight - reported;
    return missing > 1 && missing < 240 ? screenHeight : reported;
  }

  function setAppHeight(px) {
    appHeight = Math.round(px);
    document.documentElement.style.setProperty("--app-height", appHeight + "px");
  }

  function syncAppHeight() {
    syncKeyboardViewport();
    if (keyboardOpen) return;
    const h = measuredViewport();
    if (h <= 0) return;
    setAppHeight(h);
    requestAnimationFrame(() => {
      const nav = V.$("tabs");
      if (!nav || !appHeight || keyboardOpen) return;
      // Measure inside the app frame: viewport panning is not missing layout height.
      const frame = document.querySelector(".app");
      const top = frame ? frame.getBoundingClientRect().top : 0;
      const gap = Math.round(h - (nav.getBoundingClientRect().bottom - top));
      if (gap > 1 && gap < 240) {
        setAppHeight(appHeight + gap);
        if (window.Log) Log.add("layout", "closed a " + gap + "px gap under the nav");
      }
      auditHitTargets("frame " + appHeight + "px");
    });
  }

  function note(msg) {
    if (window.Log) Log.add("layout", msg);
  }

  // Every screen is laid out inside one position: fixed frame, so where a tap lands is
  // decided by where the window, the visual viewport and the frame itself are scrolled -
  // and none of them is ever scrolled on purpose. iOS scrolls all three of its own accord:
  // to keep a focused field above the keyboard, on the way back from the keyboard, and at
  // times on the way back from the background. A frame left scrolled paints every control
  // some pixels away from where its taps are taken, and nothing on screen says so. Put them
  // back at zero, and write down what moved and when, so the log can name the trigger.
  function resetViewportDrift(reason) {
    const el = document.activeElement;
    if (el && el.matches && el.matches("input, textarea, select")) return false;
    const vv = window.visualViewport;
    if (vv && Math.abs((vv.scale || 1) - 1) > 0.01) {
      note("page is pinch-zoomed x" + vv.scale.toFixed(2) + " (" + reason + "), left alone");
      return false;
    }
    const frame = document.querySelector(".app");
    const doc = document.scrollingElement || document.documentElement;
    const body = document.body;
    const drift = [];
    if (window.scrollX || window.scrollY) drift.push("window " + Math.round(window.scrollX) + "," + Math.round(window.scrollY));
    if (vv && (vv.offsetLeft || vv.offsetTop || vv.pageTop)) {
      drift.push("visual " + Math.round(vv.offsetLeft) + "," + Math.round(vv.offsetTop) + " page " + Math.round(vv.pageTop));
    }
    if (doc && (doc.scrollTop || doc.scrollLeft)) drift.push("document " + doc.scrollLeft + "," + doc.scrollTop);
    if (body && (body.scrollTop || body.scrollLeft)) drift.push("body " + body.scrollLeft + "," + body.scrollTop);
    if (frame && (frame.scrollTop || frame.scrollLeft)) drift.push("frame " + frame.scrollLeft + "," + frame.scrollTop);
    if (!drift.length) return false;
    window.scrollTo(0, 0);
    if (doc) { doc.scrollTop = 0; doc.scrollLeft = 0; }
    if (body) { body.scrollTop = 0; body.scrollLeft = 0; }
    if (frame) { frame.scrollTop = 0; frame.scrollLeft = 0; }
    note("viewport drifted (" + reason + "): " + drift.join("; ") + " - reset to 0,0");
    return true;
  }

  // The controls whose taps the log follows: the bottom navigation, on every screen, and the
  // filters in the Home header. Only the ones laid out on screen right now.
  function tapControls() {
    return Array.from(/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab, #home-top-filters button")))
      .filter(el => el.offsetWidth > 0);
  }

  function describeElement(el) {
    if (!el || !el.tagName) return "nothing";
    const data = el.dataset || {};
    const name = data.tab || data.homeFilter;
    const cls = el.classList && el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls + (name ? "[" + name + "]" : "");
  }

  function rectText(r) {
    return Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height);
  }

  // Everything that decides where a tap lands, in one line for the log.
  function viewportSnapshot() {
    const vv = window.visualViewport;
    const frame = document.querySelector(".app");
    const box = frame ? frame.getBoundingClientRect() : null;
    const root = document.documentElement;
    const flags = ["ios-standalone", "ios-system-gap", "keyboard-open", "android"].filter(c => root.classList.contains(c));
    return "inner " + window.innerWidth + "x" + window.innerHeight +
      (vv ? " visual " + Math.round(vv.width) + "x" + Math.round(vv.height) + " at " + Math.round(vv.offsetLeft) + "," +
        Math.round(vv.offsetTop) + " page " + Math.round(vv.pageTop) + " scale " + (vv.scale || 1).toFixed(2) : "") +
      " scroll " + Math.round(window.scrollX) + "," + Math.round(window.scrollY) +
      " body " + (document.body ? document.body.scrollTop : 0) + " frame " + (frame ? frame.scrollTop : 0) +
      " app " + (box ? Math.round(box.top) + "+" + Math.round(box.height) : "?") + "/" + (root.style.getPropertyValue("--app-height") || "auto") +
      " view y " + (window.screenY != null ? window.screenY : window.screenTop) +
      (flags.length ? " " + flags.join(",") : "") +
      " focus " + describeElement(document.activeElement) + (document.hidden ? " hidden" : "");
  }

  let lastAudit = "";
  let auditRetries = 0;
  // Asks the page whether each visible control is what sits under its own centre. Anything
  // else there - an overlay, a control moved from under itself - is named. Written when the
  // answer changes, so the log carries the geometry every tap is judged against. The launch
  // cover (index.html) sits over everything until the update check settles, so the audit
  // waits for it to go rather than reporting it.
  function auditHitTargets(reason) {
    if (!document.elementFromPoint) return;
    if (document.documentElement.classList.contains("app-starting")) {
      if (auditRetries++ < 12) setTimeout(() => auditHitTargets(reason), 500);
      return;
    }
    auditRetries = 0;
    const parts = [];
    let mismatch = false;
    for (const el of tapControls()) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const ok = !!(hit && el.contains(hit));
      if (!ok) mismatch = true;
      parts.push((el.dataset.tab || el.dataset.homeFilter || describeElement(el)) + " " + rectText(r) + (ok ? "" : " under " + describeElement(hit)));
    }
    const text = parts.join(" | ");
    if (!text || text === lastAudit) return;
    lastAudit = text;
    note("controls (" + reason + "): " + text + (mismatch ? " - MISMATCH: a control is not under its own centre" : ""));
  }

  syncAppHeight();
  window.addEventListener("resize", syncAppHeight);
  window.addEventListener("orientationchange", () => { cachedInset = null; setTimeout(syncAppHeight, 250); });
  window.addEventListener("load", syncAppHeight);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", syncAppHeight);
  // Back from the background or from the page cache the insets, and at times the window
  // height, are reported afresh, without a resize. Measure again, and put back anything iOS
  // left scrolled while the app was away.
  function resume(reason) {
    if (document.hidden) return;
    cachedInset = null;
    resetViewportDrift(reason);
    syncAppHeight();
  }
  window.addEventListener("pageshow", () => resume("page shown"));
  document.addEventListener("visibilitychange", () => resume("app resumed"));
  // Installed iOS delivers its insets a moment after launch and does not always fire resize.
  if (isIOS() && isStandalone()) [300, 1500].forEach(ms => setTimeout(syncAppHeight, ms));
  if (window.Log) {
    const vv = window.visualViewport;
    Log.add("layout", "viewport " + window.innerWidth + "x" + window.innerHeight +
      " screen " + screen.width + "x" + screen.height +
      (vv ? " visual " + Math.round(vv.width) + "x" + Math.round(vv.height) : "") +
      " dpr " + (window.devicePixelRatio || 1) +
      " standalone " + isStandalone());
    Log.add("layout", "safe-area top " + insetPx("--safe-top") + "px bottom " + bottomInset() +
      "px, frame " + appHeight + "px, system gap " +
      document.documentElement.classList.contains("ios-system-gap"));
    // Where the web view sits on the physical screen. This is what says whether the
    // missing height is above the view or below it - the app can only fill its own view.
    Log.add("layout", "view offset y " + (window.screenY != null ? window.screenY : window.screenTop) +
      " client " + document.documentElement.clientHeight +
      " outer " + window.outerHeight +
      " nav bottom " + Math.round((V.$("tabs") || document.body).getBoundingClientRect().bottom));
  }

  function revealKeyboardInput() {
    keyboardScrollFrame = 0;
    if (!keyboardOpen) return;
    const input = document.activeElement;
    const panel = input && input.closest && input.closest(".modal");
    if (!panel || !input.matches("input, textarea, select")) return;
    const box = input.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
    const actions = panel.querySelector(".modal-actions");
    const bottom = actions ? Math.min(bounds.bottom, actions.getBoundingClientRect().top) : bounds.bottom;
    // Scroll only the dialog. scrollIntoView can pan the whole installed app again.
    if (box.bottom > bottom - 8) panel.scrollTop += box.bottom - bottom + 8;
    const updated = input.getBoundingClientRect();
    if (updated.top < bounds.top + 8) panel.scrollTop -= bounds.top + 8 - updated.top;
  }
  function syncKeyboardViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    const inner = window.innerHeight || 0;
    const width = window.innerWidth || vv.width;
    const el = document.activeElement;
    const editing = !!(el && el.matches("input, textarea, select"));
    const zoomed = Math.abs((vv.scale || 1) - 1) > 0.05;
    if (width !== fullViewportWidth) {
      fullViewportWidth = width;
      fullViewportHeight = Math.max(inner, vv.height);
    }
    // Some Android browsers resize BOTH viewports, so compare with the height
    // saved before focusing as well as innerHeight. Ignore pinch-zoom changes.
    keyboardOpen = !zoomed && (editing || keyboardOpen) && vv.height > 0 &&
      Math.max(inner, fullViewportHeight) > vv.height + 120;
    root.classList.toggle("keyboard-open", keyboardOpen);
    if (keyboardOpen) {
      root.style.setProperty("--keyboard-viewport-height", Math.round(vv.height) + "px");
      root.style.setProperty("--keyboard-viewport-top", Math.round(vv.offsetTop || 0) + "px");
      if (!keyboardScrollFrame) keyboardScrollFrame = requestAnimationFrame(revealKeyboardInput);
    } else {
      if (!zoomed) fullViewportHeight = Math.max(inner, vv.height);
      root.style.removeProperty("--keyboard-viewport-height");
      root.style.removeProperty("--keyboard-viewport-top");
    }
  }
})();
