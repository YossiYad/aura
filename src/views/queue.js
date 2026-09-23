(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    openQueueSheet: { get: () => openQueueSheet },
    refreshQueueSheet: { get: () => refreshQueueSheet },
    resetQueueSelection: { get: () => resetQueueSelection }
  });

  function resetQueueSelection() {
    V.queueSelection.session = null;
    V.queueSelection.active = false;
    V.queueSelection.ids.clear();
  }

  function updateQueueSelection() {
    const list = V.sheetEl.querySelector(".queue-history-list");
    if (!list) return;
    const active = V.queueSelection.active;
    const rows = Array.from(list.querySelectorAll("[data-qhistory]"));
    list.classList.toggle("selecting", active);
    for (const row of rows) {
      const selected = active && V.queueSelection.ids.has(row.dataset.qhistory);
      row.classList.toggle("selected", selected);
      if (active) row.setAttribute("aria-pressed", String(selected));
      else row.removeAttribute("aria-pressed");
    }
    const toggle = V.sheetEl.querySelector("#queue-select");
    toggle.textContent = active ? "Cancel" : "Select";
    toggle.setAttribute("aria-label", active ? "Cancel song selection" : "Select songs for a playlist");
    const all = V.sheetEl.querySelector("#queue-select-all");
    all.hidden = !active;
    const allSelected = rows.length && V.queueSelection.ids.size === rows.length;
    all.textContent = allSelected ? "None" : "All";
    all.setAttribute("aria-label", allSelected ? "Deselect all songs" : "Select all songs");
    V.sheetEl.querySelector("#queue-sheet-title").textContent = active ? V.queueSelection.ids.size + " selected" : "Queue history";
    V.sheetEl.querySelector("#queue-sheet-summary").textContent = active ? "Queue history" : rows.length + " songs in this session";
    V.sheetEl.querySelector("#queue-selection-note").textContent = active ? "Choose the songs you want to keep." : "Tap a song to replay it.";
    V.sheetEl.querySelector(".queue-head").classList.toggle("selecting", active);
    V.sheetEl.querySelector("#queue-history").hidden = active;
    V.sheetEl.querySelector(".queue-selection-footer").hidden = !active;
    V.sheetEl.querySelector("#queue-save-selection").disabled = !V.queueSelection.ids.size;
  }

  function refreshQueueSheet() {
    if (V.sheetEl.hidden) return;
    const header = V.sheetEl.querySelector("[data-queue-view]");
    if (!header) return;
    const scroll = V.sheetEl.scrollTop;
    const expanded = V.sheetEl.classList.contains("expanded");
    const focused = /** @type {HTMLElement} */ (V.sheetEl.contains(document.activeElement) ? document.activeElement : null);
    openQueueSheet(header.dataset.queueView === "history");
    V.sheetEl.classList.toggle("expanded", expanded);
    V.sheetEl.scrollTop = scroll;
    if (focused) {
      const target = Array.from(V.sheetEl.querySelectorAll("button")).find(b =>
        (focused.id && b.id === focused.id) ||
        (focused.dataset.qhistory && b.dataset.qhistory === focused.dataset.qhistory));
      if (target) target.focus({ preventScroll: true });
    }
  }

  /**
   * @param {boolean} [showHistory] Open on the queue history instead of the queue.
   */
  function openQueueSheet(showHistory = false) {
    const q = Player.queue();
    const pos = Player.pos();
    const queued = (Player.current() ? [Player.current()] : []).concat(Player.upcoming())
      .map(track => ({ track, index: q.indexOf(track) }));
    const archive = Player.queueHistory();
    const session = Player.queueHistorySession();
    if (!showHistory || V.queueSelection.session !== session) resetQueueSelection();
    V.queueSelection.session = session;
    const available = new Set(archive.map(entry => entry.track.id));
    for (const id of V.queueSelection.ids) if (!available.has(id)) V.queueSelection.ids.delete(id);
    const upcoming = Math.max(0, queued.length - 1);
    const labels = { current: "Now playing", upcoming: "Up next", earlier: "Earlier", removed: "Removed from queue" };
    const historyHtml = showHistory ?
      '<p class="queue-history-note" id="queue-selection-note">Tap a song to replay it.</p>' +
      '<ul class="song-list queue-list queue-history-list">' + archive.map(entry => {
        const t = entry.track;
        return '<li><button type="button" class="song queue-history-song' + (entry.status === "current" ? ' active' : '') +
          '" data-qhistory="' + V.esc(t.id) + '"' + (entry.status === "current" ? ' aria-current="true"' : '') + '>' + V.artHtml(t, "") +
          '<span class="meta"><span class="song-title" dir="auto">' + V.esc(t.title) + '</span><span class="song-sub" dir="auto">' +
          V.esc(t.artist) + '</span></span><span class="queue-history-status">' + labels[entry.status] + '</span></button></li>';
      }).join("") + '</ul><div class="queue-selection-footer" hidden><button type="button" id="queue-save-selection" disabled>' +
      V.IC.plus + '<span>Add to playlist</span></button></div>' : "";
    V.openSheet(
      '<div class="sheet-head queue-head" data-queue-view="' + (showHistory ? 'history' : 'upcoming') + '"><div class="meta"><div class="song-title" id="queue-sheet-title" dir="auto" role="status" aria-live="polite">' +
      (showHistory ? 'Queue history' : 'Queue') + '</div><div class="song-sub" id="queue-sheet-summary" dir="auto">' +
      (showHistory ? archive.length + ' songs in this session' : upcoming + ' up next') + '</div></div>' +
      '<button class="text-action" id="queue-history" aria-label="' + (showHistory ? 'Show upcoming queue' : 'Show queue history') + '">' +
      (showHistory ? 'Queue' : 'History') + '</button>' +
      (showHistory ? '<button type="button" class="text-action" id="queue-select-all" hidden>All</button>' +
        '<button type="button" class="text-action" id="queue-select"' + (!archive.length ? ' disabled' : '') + '>Select</button>' :
        upcoming ? '<button class="text-action" id="queue-clear" aria-label="Clear upcoming songs">Clear</button>' : "") + '</div>' +
      (!showHistory && window.SharedQueue && SharedQueue.available() ? '<button type="button" class="sheet-item" id="queue-shared">' + V.IC.person + tr('<span>AuraShare · QR להזמנה</span></button>') : '') +
      (showHistory ? historyHtml : (upcoming ? '<p class="queue-history-note">Drag the three lines to reorder. Swipe sideways to remove.</p>' : "") + '<ul class="song-list queue-list">' + queued.map(({ track: t, index: i }, order) =>
        '<li class="song' + (i === pos ? " active" : "") + '" data-qi="' + i + '">' + V.artHtml(t, "") +
        '<div class="meta"><div class="song-title" dir="auto">' + V.esc(t.title) + '</div><div class="song-sub" dir="auto">' + V.esc(t.artist) + '</div></div>' +
        (order > 0 ? V.reorderHandle(t.title) : '<span class="song-dur">now</span>') + '</li>'
      ).join("") + '</ul>'), showHistory
    );
    if (!showHistory) {
      const list = V.sheetEl.querySelector(".queue-list");
      V.bindTrackGestures(list, ".song[data-qi]:not(.active)", (row, target) => {
        const track = queued.find(entry => entry.index === Number(row.dataset.qi)).track;
        const destination = queued.find(entry => entry.index === Number(target.dataset.qi)).track;
        Player.moveAt(Player.queue().indexOf(track), Player.queue().indexOf(destination));
        const scroll = V.sheetEl.scrollTop;
        openQueueSheet();
        V.sheetEl.scrollTop = scroll;
        const index = Player.queue().indexOf(track);
        const handle = V.sheetEl.querySelector('[data-qi="' + index + '"] .reorder-handle');
        if (handle) handle.focus({ preventScroll: true });
      }, row => {
        const track = queued.find(entry => entry.index === Number(row.dataset.qi)).track;
        Player.removeAt(Player.queue().indexOf(track));
        const scroll = V.sheetEl.scrollTop;
        openQueueSheet();
        V.sheetEl.scrollTop = scroll;
        V.toast("Removed from queue. Available in History.");
      }, "Remove from queue");
    }
    if (showHistory) updateQueueSelection();
    V.sheetEl.onclick = e => {
      if (e.target.closest("#queue-select")) {
        V.queueSelection.active = !V.queueSelection.active;
        V.queueSelection.ids.clear();
        updateQueueSelection();
        return;
      }
      if (e.target.closest("#queue-select-all")) {
        const ids = Player.queueHistory().map(entry => entry.track.id);
        const clear = V.queueSelection.ids.size === ids.length;
        V.queueSelection.ids.clear();
        if (!clear) ids.forEach(id => V.queueSelection.ids.add(id));
        updateQueueSelection();
        return;
      }
      if (e.target.closest("#queue-save-selection")) {
        // Snapshot in history order, not tap order. Later refills never add songs to
        // a selection the listener already handed to the playlist picker.
        const tracks = Player.queueHistory().filter(entry => V.queueSelection.ids.has(entry.track.id)).map(entry => entry.track);
        if (tracks.length) V.openPlaylistPickerBulk(tracks, "Queue mix");
        return;
      }
      if (e.target.closest("#queue-shared")) { SharedQueue.open(V.openSheet, "existing-queue"); return; }
      if (e.target.closest("#queue-history")) { openQueueSheet(!showHistory); return; }
      const clear = e.target.closest("#queue-clear");
      // Rebuilds replace the sheet's content in place, so no history is pushed or spent.
      if (clear) { Player.clearUpcoming(); openQueueSheet(showHistory); return; }
      const archived = e.target.closest("[data-qhistory]");
      if (archived) {
        if (V.queueSelection.active) {
          const id = archived.dataset.qhistory;
          if (V.queueSelection.ids.has(id)) V.queueSelection.ids.delete(id);
          else V.queueSelection.ids.add(id);
          updateQueueSelection();
          return;
        }
        if (!Player.playFromQueueHistory(archived.dataset.qhistory)) { V.toast(V.BLOCKED_MSG, "err"); return; }
        V.dismissViaHistory(V.closeSheet);
        return;
      }
      const row = e.target.closest("[data-qi]");
      if (row) {
        const qi = parseInt(row.dataset.qi, 10);
        const entry = Player.queue()[qi];
        if (entry && Store.isBlocked(entry)) { V.toast(V.BLOCKED_MSG, "err"); return; }
        V.dismissViaHistory(V.closeSheet);
        if (qi !== Player.pos()) Player.jumpTo(qi);
      }
    };
  }
})();
