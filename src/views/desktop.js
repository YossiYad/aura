(function () {
  const V = window.Aura.views;
  // The desktop layout: the same app laid out for a computer. One switch decides it -
  // wanted() below - and everything that follows hangs off the "desktop" class it puts on
  // <html>: src/desktop.css only has rules under that class, and the parts that exist only
  // on a computer (this file's top bar, the library column in desktop-library.js, the
  // player bar's extra controls in desktop-player.js) are built the first time the switch
  // turns on. A phone or a tablet is never switched by itself, whatever its size, so none
  // of this is built there and nothing of it is styled.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    desktop: { get: () => desktop },
    desktopMode: { get: () => desktopMode },
    desktopDownload: { get: () => desktopDownload },
    desktopParts: { get: () => desktopParts },
    openDesktopAppDialog: { get: () => openDesktopAppDialog },
    setDesktopMode: { get: () => setDesktopMode },
    syncDesktop: { get: () => syncDesktop }
  });

  // Wide enough for the three columns in their narrowest form (src/desktop.css). A browser
  // zoomed in counts as the narrower window it then is: 1920 screen pixels at 140% on a
  // scaled display is about 1000 here, which is why this is not set at a round 1024.
  const QUERY = "(min-width: 800px) and (hover: hover) and (pointer: fine)";
  // For a device whose owner asked for the layout in Settings: room for it is all it needs.
  const ROOM = "(min-width: 700px)";
  const wide = typeof matchMedia === "function" ? matchMedia(QUERY) : null;
  const room = typeof matchMedia === "function" ? matchMedia(ROOM) : null;
  // "auto", or the layout chosen for this device in Settings. Kept beside the settings and
  // not in them: they travel in a backup, and a phone restoring one made on a computer
  // must not come up in the computer's layout.
  const MODE_KEY = "aura.layout";
  /** @type {"auto" | "desktop" | "phone"} */
  let desktopMode = "auto";
  try {
    const kept = localStorage.getItem(MODE_KEY);
    if (kept === "desktop" || kept === "phone") desktopMode = kept;
  } catch (e) {}
  let desktop = false;
  let mounted = false;
  /**
   * What a part of the desktop layout does: build itself once, step in or out when the
   * window crosses the switch, and catch up after a screen is drawn.
   * @type {{ mount: (app: HTMLElement) => void, show: (on: boolean) => void, sync: () => void }[]}
   */
  const desktopParts = [];

  const ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>',
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>'
  };

  /** @type {HTMLElement} */
  let top = null;
  /** @type {HTMLInputElement} */
  let field = null;
  // Where the two controls borrowed from the phone's top bar came from, so that a window
  // made narrow again finds them back in their own row, in their own order.
  /** @type {{ el: HTMLElement, parent: HTMLElement, next: Node | null }[]} */
  let borrowed = [];

  // A phone or a tablet, by the system it says it runs. Size cannot tell: a tablet is as
  // wide as a small laptop, and one with a keyboard case has a pointer as well. An iPad
  // introduces itself as a Mac, and its touch screen is what gives it away.
  function handheld() {
    const nav = typeof navigator === "object" && navigator ? navigator : null;
    if (!nav) return false;
    const ua = String(nav.userAgent || "");
    if (/** @type {any} */ (nav).userAgentData && /** @type {any} */ (nav).userAgentData.mobile) return true;
    return /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(ua) ||
      (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  }

  // The desktop app (desktop/ in the repository) is a computer by definition, whatever
  // its window system reports about the pointer. It names itself in its user agent.
  function desktopApp() {
    return typeof navigator === "object" && !!navigator && /\bAuraDesktop\//.test(String(navigator.userAgent || ""));
  }

  // The installers a server may hold, one for each system, and which one this browser's
  // computer takes (Settings > About). Inside the app itself there is nothing to get.
  const DESKTOP_DOWNLOADS = {
    linux: { file: "desktop/download/Aura.AppImage", label: "Download for Linux",
      steps: "1. Download it, then let the file run: right-click it, Properties, Permissions, and tick Is executable.<br>" +
        "2. Open it. It adds itself to your applications, and sends this browser to a page that signs it in - press Continue there." },
    windows: { file: "desktop/download/Aura-Setup.exe", label: "Download for Windows",
      steps: "1. Download it and open it. Windows may say it protected your PC: choose More info, then Run anyway.<br>" +
        "2. It installs and opens, and sends this browser to a page that signs it in - press Continue there." }
  };

  /** @returns {"linux" | "windows" | ""} */
  function desktopAppOffered() {
    const ua = typeof navigator === "object" && navigator ? String(navigator.userAgent || "") : "";
    if (handheld() || desktopApp()) return "";
    if (/Windows NT/.test(ua)) return "windows";
    if (/Linux/.test(ua)) return "linux";
    return "";
  }

  function desktopDownload() {
    return DESKTOP_DOWNLOADS[desktopAppOffered()] || null;
  }

  function openDesktopAppDialog() {
    const download = desktopDownload();
    if (!download) return;
    V.openModal(
      '<div class="modal"><h3>Aura for this computer</h3>' +
      '<p class="import-hint">Aura in a window of its own, with a tray icon that keeps the music playing.</p>' +
      '<p class="import-hint">' + download.steps + '</p>' +
      '<div class="modal-actions"><button class="btn ghost" id="modal-cancel">Close</button>' +
      '<a class="btn primary" href="' + download.file + '" download>' + download.label + '</a></div></div>'
    );
    document.getElementById("modal-cancel").onclick = () => V.dismissViaHistory(() => { V.closeModal(); V.scrimEl.hidden = true; });
  }

  // A computer gets the layout by itself: not a handheld system, a mouse or a trackpad
  // for a pointer, and a window wide enough. Any device gets it when its owner chose
  // "Computer" in Settings and there is room, and none does when they chose "Phone".
  function wanted() {
    if (desktopMode === "phone") return false;
    if (desktopMode === "desktop" || desktopApp()) return !!(room && room.matches);
    return !!(wide && wide.matches) && !handheld();
  }

  /** @param {string} next "auto", "desktop" or "phone". */
  function setDesktopMode(next) {
    desktopMode = next === "desktop" || next === "phone" ? next : "auto";
    try {
      if (desktopMode === "auto") localStorage.removeItem(MODE_KEY);
      else localStorage.setItem(MODE_KEY, desktopMode);
    } catch (e) {}
    apply();
  }

  function onSearchScreen() {
    return V.currentTab === "search" && !V.subView;
  }

  // The field in the top bar is the search screen's own field moved to where a desktop
  // keeps it: what is typed here is typed there, so the live search, the suggestions and
  // the library matches are the ones the screen already has.
  function forwardSearch() {
    // Drawing the search screen brings this field in step with the screen's; what was
    // just typed is the newer of the two.
    const typed = field.value;
    if (!onSearchScreen()) Views.showTab("search");
    field.value = typed;
    const real = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    if (!real) return;
    real.value = typed;
    real.dispatchEvent(new Event("input", { bubbles: true }));
    syncSearchClear();
  }

  function syncSearchClear() {
    const clear = top.querySelector(".dk-search-clear");
    if (clear) /** @type {HTMLElement} */ (clear).hidden = !field.value;
  }

  // The other way round: a recent search tapped, a result set restored. Never under a
  // hand that is typing here.
  function syncSearchField() {
    if (!field || document.activeElement === field) return;
    const real = /** @type {HTMLInputElement} */ (document.getElementById("disc-input"));
    const value = onSearchScreen() && real ? real.value : "";
    if (field.value !== value) field.value = value;
    syncSearchClear();
  }

  function buildTop(app) {
    top = document.createElement("header");
    top.className = "dk-top";
    top.innerHTML =
      '<div class="dk-top-side"><button class="dk-brand" data-dk="home" aria-label="Aura">' +
      '<img src="icon.svg" alt="" /></button></div>' +
      '<div class="dk-top-center">' +
      '<button class="dk-round" data-dk="home" aria-label="Home">' + ICON.home + '</button>' +
      '<form class="dk-search" role="search">' + ICON.search +
      '<input type="text" id="dk-search-input" dir="auto" enterkeyhint="search" autocomplete="off" spellcheck="false"' +
      ' aria-label="Search" placeholder="What do you want to play?" />' +
      '<button type="button" class="dk-search-clear" aria-label="Clear search" hidden>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
      (window.Voice && Voice.supported() ? '<button type="button" class="dk-search-mic" aria-label="Voice request">' + ICON.mic + '</button>' : "") +
      '</form></div>' +
      '<div class="dk-top-side dk-top-end"><button class="dk-pill" data-dk="ai">' + ICON.ai + '<span>Ask AI</span></button></div>';
    app.insertBefore(top, app.firstChild);
    field = /** @type {HTMLInputElement} */ (top.querySelector("#dk-search-input"));

    top.addEventListener("click", e => {
      const target = /** @type {HTMLElement} */ (e.target);
      const go = /** @type {HTMLElement} */ (target.closest("[data-dk]"));
      if (go) { Views.showTab(go.dataset.dk); return; }
      if (target.closest(".dk-search-clear")) {
        field.value = "";
        if (onSearchScreen()) forwardSearch();
        syncSearchClear();
        field.focus();
        return;
      }
      if (target.closest(".dk-search-mic")) { Views.showTab("ai"); V.voiceStart("ask"); }
    });
    top.querySelector(".dk-search").addEventListener("submit", e => e.preventDefault());
    // Clicking into the field opens the search screen, the way it does in a desktop
    // player: what to browse is on show before a letter is typed.
    field.addEventListener("focus", () => { if (!onSearchScreen()) Views.showTab("search"); });
    field.addEventListener("input", forwardSearch);
    field.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = field.value.trim();
      V.cancelLiveSearch();
      if (!q) return;
      if (!onSearchScreen()) Views.showTab("search");
      V.doSearch(q);
    });
    // A chip or a suggestion tapped on the screen fills the screen's field, not this one.
    V.view.addEventListener("click", () => setTimeout(syncSearchField, 0));
    document.addEventListener("keydown", e => {
      if (!desktop || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      field.focus();
      field.select();
    });
  }

  // The private session glyph and the profile circle are the phone's own, with the state
  // and the handlers they already have; on a desktop they sit at the end of the top bar.
  function borrowChrome(on) {
    if (on && !borrowed.length) {
      const end = top.querySelector(".dk-top-end");
      for (const id of ["btn-private", "btn-profile"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        borrowed.push({ el, parent: el.parentElement, next: el.nextSibling });
        end.appendChild(el);
      }
    } else if (!on && borrowed.length) {
      for (const item of borrowed.reverse()) item.parent.insertBefore(item.el, item.next);
      borrowed = [];
    }
  }

  // A row of cards shows what fits on one line; "Show all" opens the rest. Which rows
  // have a rest depends on the window and on what has arrived, so it is measured.
  let railFrame = 0;
  function markRails() {
    railFrame = 0;
    if (!desktop) return;
    /** @type {NodeListOf<HTMLElement>} */ (V.view.querySelectorAll(".rail")).forEach(rail => {
      if (rail.classList.contains("dk-all")) return;
      rail.classList.toggle("dk-more", rail.scrollHeight > rail.clientHeight + 4);
    });
  }
  function queueRailMarks() {
    if (!desktop || railFrame) return;
    railFrame = requestAnimationFrame(markRails);
  }

  function watchRails() {
    if (window.MutationObserver) new MutationObserver(queueRailMarks).observe(V.view, { childList: true, subtree: true });
    window.addEventListener("resize", queueRailMarks);
    V.view.addEventListener("click", e => {
      if (!desktop) return;
      const target = /** @type {HTMLElement} */ (e.target);
      const head = target.closest(".section-head, .section-title");
      if (!head || target.closest("button, a, input")) return;
      const rail = head.nextElementSibling;
      if (!rail || !rail.classList.contains("rail")) return;
      if (!rail.classList.contains("dk-more") && !rail.classList.contains("dk-all")) return;
      rail.classList.toggle("dk-all");
      queueRailMarks();
    });
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const app = /** @type {HTMLElement} */ (document.querySelector(".app"));
    buildTop(app);
    watchRails();
    desktopParts.forEach(part => part.mount(app));
  }

  function apply() {
    const on = wanted();
    if (on === desktop) return;
    desktop = on;
    document.documentElement.classList.toggle("desktop", on);
    if (!on && !mounted) return;
    mount();
    top.hidden = !on;
    borrowChrome(on);
    desktopParts.forEach(part => part.show(on));
    if (on) syncDesktop();
    // The private glyph is shown on Home alone on a phone and everywhere on a desktop.
    V.syncPrivateButton();
  }

  /** Brings the desktop chrome in step with the screen that was just drawn. */
  function syncDesktop() {
    if (!desktop || !mounted) return;
    const home = V.currentTab === "home" && !V.subView;
    const ai = V.currentTab === "ai" && !V.subView;
    top.querySelector('.dk-round[data-dk="home"]').classList.toggle("on", home);
    top.querySelector('.dk-pill[data-dk="ai"]').classList.toggle("on", ai);
    syncSearchField();
    desktopParts.forEach(part => part.sync());
    queueRailMarks();
  }

  // The class goes on at once, before the first paint; the parts are built once every
  // file of the module has loaded, which is by the time the document is ready.
  if (wanted()) document.documentElement.classList.add("desktop");
  function start() {
    apply();
    for (const query of [wide, room]) if (query.addEventListener) query.addEventListener("change", apply);
  }
  if (wide) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
})();
