(function () {
  const V = window.Aura.views;
  // The player bar of the desktop layout (src/views/desktop.js). It is the phone's bar
  // with its own buttons, rearranged into the three groups a desktop player has - the song
  // on the left, the transport and the timeline in the middle, the queue and the volume on
  // the right - plus the controls a phone keeps on its full player because a narrow bar
  // has no room for them: repeat, the clock and the volume. The full player itself opens
  // beside the page as the "now playing" panel instead of over it.

  const PANEL_KEY = "aura.desktopPanel";
  const $ = id => document.getElementById(id);
  /** @type {Record<string, HTMLElement>} */
  let el = null;
  let shown = false;
  let clock = 0;
  let lastVolume = 1;
  // Whether the listener wants the panel: it stays open across songs and screens until
  // they close it, and anything else that hides the full player - opening the queue from
  // it, the way a phone makes room - does not count as closing it.
  let wantPanel = true;
  try { wantPanel = localStorage.getItem(PANEL_KEY) !== "0"; } catch (e) {}

  function make(tag, cls, html) {
    const node = document.createElement(tag);
    node.className = cls;
    if (html) node.innerHTML = html;
    return node;
  }

  function build() {
    el = {
      bar: $("playerbar"),
      row: /** @type {HTMLElement} */ ($("playerbar").querySelector(".player-row")),
      controls: /** @type {HTMLElement} */ ($("playerbar").querySelector(".controls")),
      full: $("fullplayer"),
      left: make("div", "dk-bar-left"),
      center: make("div", "dk-bar-center"),
      buttons: make("div", "dk-bar-buttons"),
      scrub: make("div", "dk-bar-scrub"),
      right: make("div", "dk-bar-right"),
      cur: make("span", "dk-time", "0:00"),
      dur: make("span", "dk-time", "0:00"),
      repeat: make("button", "ctl toggle", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span class="rep-one" hidden>1</span>'),
      panel: make("button", "ctl toggle", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="14.5" y1="4" x2="14.5" y2="20"/><polygon points="7,9.5 11,12 7,14.5" fill="currentColor" stroke="none"/></svg>'),
      mute: make("button", "ctl", ""),
      volume: make("input", "dk-volume")
    };
    el.repeat.setAttribute("aria-label", "Repeat");
    el.panel.setAttribute("aria-label", "Now playing view");
    const volume = /** @type {HTMLInputElement} */ (el.volume);
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    volume.setAttribute("aria-label", "Volume");
    el.buttons.append(el.repeat);
    el.scrub.append(el.cur, el.dur);
    el.center.append(el.buttons, el.scrub);
    el.right.append(el.panel, el.mute, el.volume);

    // The full player's own repeat button does the work and repaints both.
    el.repeat.onclick = e => { e.stopPropagation(); $("fp-repeat").click(); sync(); };
    el.panel.onclick = e => { e.stopPropagation(); setPanel(el.full.hidden); };
    el.mute.onclick = e => {
      e.stopPropagation();
      const now = Player.volume();
      if (now > 0) lastVolume = now;
      Player.setVolume(now > 0 ? 0 : lastVolume || 1);
      syncVolume();
    };
    volume.oninput = () => { Player.setVolume(Number(volume.value) / 100); syncVolume(); };
    volume.onclick = e => e.stopPropagation();
    // Capture, so the wish is on record before the handlers that act on it run.
    $("fp-close").addEventListener("click", () => { if (shown) rememberPanel(false); }, true);
    $("pb-now").addEventListener("click", () => { if (shown) rememberPanel(true); }, true);
    if (window.MutationObserver) new MutationObserver(panelMoved).observe(el.full, { attributes: true, attributeFilter: ["hidden"] });
    Player.onChange(() => { if (shown) sync(); });
  }

  function rememberPanel(open) {
    wantPanel = open;
    try { localStorage.setItem(PANEL_KEY, open ? "1" : "0"); } catch (e) {}
  }

  function setPanel(open) {
    rememberPanel(open);
    if (open === !el.full.hidden) return;
    if (open) $("pb-now").click();
    else $("fp-close").click();
  }

  function panelMoved() {
    if (!shown) return;
    if (el.full.hidden && wantPanel && Player.current()) { $("pb-now").click(); return; }
    sync();
  }

  // The phone's order, exactly, for a window that has been made narrow again.
  function arrange(on) {
    const now = $("pb-now"), like = $("pb-like"), queue = $("pb-queue"), progress = $("pb-progress");
    const transport = ["pb-shuffle", "pb-prev", "pb-play", "pb-next"].map($);
    if (on) {
      el.left.append(now, like);
      el.buttons.prepend(...transport);
      el.scrub.insertBefore(progress, el.dur);
      el.right.prepend(queue);
      el.bar.append(el.left, el.center, el.right);
    } else {
      el.bar.insertBefore(progress, el.row);
      el.row.insertBefore(now, el.controls);
      el.controls.append(...transport, like, queue);
      el.left.remove();
      el.center.remove();
      el.right.remove();
    }
  }

  function syncVolume() {
    const level = Player.volume();
    const volume = /** @type {HTMLInputElement} */ (el.volume);
    const value = String(Math.round(level * 100));
    if (volume.value !== value) volume.value = value;
    volume.style.setProperty("--dk-fill", value + "%");
    const state = level === 0 ? "off" : level < 0.5 ? "low" : "high";
    if (el.mute.dataset.state === state) return;
    el.mute.dataset.state = state;
    el.mute.setAttribute("aria-label", level === 0 ? "Unmute" : "Mute");
    el.mute.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor" stroke="none"/>' +
      (state === "off" ? '<line x1="16" y1="9" x2="22" y2="15"/><line x1="22" y1="9" x2="16" y2="15"/>' :
        '<path d="M15.5 8.5a5 5 0 0 1 0 7"/>' + (state === "high" ? '<path d="M18.5 5.5a9.5 9.5 0 0 1 0 13"/>' : "")) + '</svg>';
  }

  function tick() {
    if (!shown || document.hidden) return;
    const time = Player.getTime();
    const cur = V.fmt(time.cur);
    const dur = V.fmt(time.dur || (Player.current() || {}).duration || 0);
    if (el.cur.textContent !== cur) el.cur.textContent = cur;
    if (el.dur.textContent !== dur) el.dur.textContent = dur;
  }

  function sync() {
    if (!shown) return;
    const repeat = Player.repeat();
    const sharing = !!(Player.shareSession && Player.shareSession());
    el.repeat.classList.toggle("on", repeat !== "off");
    /** @type {HTMLElement} */ (el.repeat.querySelector(".rep-one")).hidden = repeat !== "one";
    /** @type {HTMLButtonElement} */ (el.repeat).disabled = sharing;
    const open = !el.full.hidden && !el.full.classList.contains("closing");
    el.panel.classList.toggle("on", open);
    el.bar.parentElement.classList.toggle("dk-now", !el.full.hidden);
    if (el.full.hidden && wantPanel && Player.current()) $("pb-now").click();
    syncVolume();
    tick();
  }

  V.desktopParts.push({
    mount: build,
    show(on) {
      shown = on;
      arrange(on);
      clearInterval(clock);
      clock = on ? window.setInterval(tick, 500) : 0;
      if (on) { sync(); return; }
      // Left open, the panel would be the phone's full player covering the whole window.
      el.bar.parentElement.classList.remove("dk-now");
      el.full.hidden = true;
    },
    sync
  });
})();
