(function () {
  // The app's wiring is one module in several files: this one holds the tab bar, and
  // src/main/ holds one file per part of the screen - the viewport and keyboard insets,
  // lyrics, the mini player, playback failures, the full player's gestures, driving mode,
  // the full player's controls, the keyboard, app updates and launch - loaded after it in
  // the order index.html lists them. Most of it runs as it loads, binding the page, so a
  // file may only use what files before it have set up. Each file is its own closure and
  // reaches the others through V, window.Aura.main, where each file publishes, at its top,
  // the names the others use. A name that another file assigns is published with a setter.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).main = {};
  // Published on V for the other files of this module; see src/main.js.
  Object.defineProperties(V, {
    $: { get: () => $ }
  });

  const $ = id => document.getElementById(id);

  document.getElementById("tabs").addEventListener("click", /** @param {PointerEvent & { target: HTMLElement }} e */ e => {
    const tab = /** @type {HTMLElement} */ (e.target.closest(".bn-tab"));
    if (!tab) return;
    // Not a page like the others - it never becomes the active tab, it just opens a sheet
    // over whatever is already on screen.
    if (tab.dataset.tab === "create") { Views.openCreateSheet(); return; }
    Views.showTab(tab.dataset.tab);
  });
  // The bar is navigation between pages, so the page on show is marked aria-current for a
  // screen reader. Several places light a tab by its class; the mark follows the class.
  const markCurrentTab = () => document.querySelectorAll("#tabs .bn-tab").forEach(b => {
    if (b.classList.contains("active")) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (window.MutationObserver) new MutationObserver(markCurrentTab).observe($("tabs"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  markCurrentTab();
  $("btn-goto-discover").onclick = () => {
    if (Views.currentTab() === "library") Views.focusLibrarySearch();
    else Views.showTab("search");
  };
  $("btn-settings").onclick = () => Views.openSettings();
  $("btn-profile").onclick = () => Views.openSettings();
  // The detective sits next to the profile circle, on every screen, because a mode that
  // decides what is written down has to be one tap away and readable at a glance - lit in
  // the accent while it runs, grey while it does not, gone when Settings hides it.
  $("btn-private").onclick = () => {
    const on = Store.setPrivateSession(!Store.privateSession());
    Views.syncPrivateButton();
    Views.toast(on
      ? "Private session on - nothing you play is saved to your history until you close the app"
      : "Private session off - plays count again");
  };
  $("btn-library-add").onclick = () => Views.openCreateSheet();
})();
