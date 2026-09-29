(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.sharedQueue;
  // The notice strip on the host's screen: what guests did, one bubble at a time, expanded on request.
  // Published on V for the other files of this module; see src/shared-queue.js.
  Object.defineProperties(V, {
    activity: { get: () => activity, set: value => { activity = value; } },
    activityKeys: { get: () => activityKeys },
    addActivity: { get: () => addActivity },
    noticePeek: { get: () => noticePeek, set: value => { noticePeek = value; } },
    noticesExpanded: { get: () => noticesExpanded, set: value => { noticesExpanded = value; } },
    noticeTimer: { get: () => noticeTimer },
    observeActivity: { get: () => observeActivity },
    peekNotice: { get: () => peekNotice },
    renderNotices: { get: () => renderNotices }
  });

  let activity = [], activityId = 0, noticesExpanded = false, noticeBusy = false, noticePeek = false, noticeTimer = 0;

  let positionNotices = () => {};

  const activityKeys = new Set();

  function addActivity(message, key) {
    if (key && activityKeys.has(key)) return;
    if (key) activityKeys.add(key);
    activity.push({ id: ++activityId, message });
    activity = activity.slice(-20);
    peekNotice();
  }

  function peekNotice() {
    noticePeek = true;
    clearTimeout(noticeTimer);
    // Decisions stay available until handled or minimized. Informational previews fade.
    const pending = V.room && ((V.room.joinRequests || []).length || V.room.requests.some(item => item.status === 'pending'));
    if (!pending) noticeTimer = setTimeout(() => { noticePeek = false; renderNotices(); }, 6500);
  }

  function observeActivity(previous) {
    if (!V.room) {
      if (previous && window.Views) Views.toast(tr('AuraShare הסתיים או שפג תוקפו. ההזמנה אינה פעילה יותר.'));
      return;
    }
    const sameRoom = previous && previous.id === V.room.id;
    const oldJoins = new Map((sameRoom ? previous.joinRequests || [] : []).map(g => [g.id, g]));
    const oldGuests = new Map((sameRoom ? previous.guests || [] : []).map(g => [g.id, g]));
    const oldRequests = new Map((sameRoom ? previous.requests : []).map(item => [item.id, item]));
    const joins = V.room.joinRequests || [], guests = V.room.guests || [];
    if (joins.some(g => !oldJoins.has(g.id)) || V.room.requests.some(item => item.status === 'pending' && !oldRequests.has(item.id))) peekNotice();
    if (!sameRoom) return; // Pending actions reappear after reload; old activity does not.
    if (previous.isController !== V.room.isController) addActivity(V.room.isController
      ? tr('ניהול ההוספות עבר למכשיר הזה.') : tr('ניהול ההוספות עבר למכשיר אחר.'));
    if (previous.permission !== V.room.permission) addActivity(tr('ההרשאה המוצעת לאורחים חדשים עודכנה: ') + tr(V.labels[V.room.permission]));
    for (const guest of guests) {
      const old = oldGuests.get(guest.id);
      if (!old) addActivity(guest.name + tr(' הצטרף/ה ל-AuraShare · ') + tr(V.labels[guest.permission]));
      else {
        if (old.permission !== guest.permission) addActivity(tr('ההרשאה של ') + guest.name + tr(' עודכנה: ') + tr(V.labels[guest.permission]));
        if (old.online !== guest.online) addActivity(guest.name + (guest.online ? tr(' חזר/ה להיות פעיל/ה.') : tr(' אינו/ה פעיל/ה כרגע.')));
      }
    }
    for (const guest of oldJoins.values()) {
      if (!joins.some(g => g.id === guest.id) && !guests.some(g => g.id === guest.id)) addActivity(tr('בקשת ההצטרפות של ') + guest.name + tr(' נדחתה.'));
    }
    for (const item of V.room.requests) {
      const old = oldRequests.get(item.id);
      if (item.delivered && (!old || !old.delivered)) addActivity((item.fromHost === true ? tr('המארחים') : item.name) + tr(' הוסיף/ה לתור: ') + item.track.title, 'delivered:' + item.id);
      else if (item.status === 'approved' && (!old || old.status !== 'approved') && !item.deliver)
        addActivity(tr('אושר להוספה: ') + item.track.title + ' · ' + item.name);
      if (old && old.status !== item.status && item.status === 'rejected') addActivity(tr('ההצעה לשיר ') + item.track.title + tr(' נדחתה.'));
      if (old && old.votes !== item.votes && item.status === 'pending') addActivity(tr('עודכנו ההצבעות על ') + item.track.title + ': ' + item.votes);
    }
  }

  function makeNoticeBubble(root) {
    const bubble = V.$('sq-notices-toggle'), body = V.$('sq-notices-body'), parent = root.parentElement;
    const size = 52, gap = 12;
    let anchor = null, drag = null, ignoreClickUntil = 0;
    try {
      const saved = JSON.parse(localStorage.getItem('aura.shareBubble') || 'null');
      if (saved && ['left', 'right', 'top', 'bottom'].includes(saved.edge) && Number.isFinite(saved.ratio)) anchor = saved;
    } catch {}
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function bounds() {
      const style = getComputedStyle(parent);
      const top = gap + (parseFloat(style.getPropertyValue('--safe-top')) || 0);
      const bottomInset = gap + (parseFloat(style.getPropertyValue('--safe-bottom')) || 0);
      return { left: gap, right: Math.max(gap, parent.clientWidth - size - gap), top,
        bottom: Math.max(top, parent.clientHeight - size - bottomInset), bottomInset };
    }
    function save() {
      try { localStorage.setItem('aura.shareBubble', JSON.stringify(anchor)); } catch {}
    }
    function position(x, y) {
      root.style.left = x + 'px'; root.style.top = y + 'px';
    }
    function positionPanel(b) {
      if (root.hidden || body.hidden) return;
      const width = Math.min(340, parent.clientWidth - gap * 2);
      body.style.width = width + 'px';
      body.style.maxHeight = Math.max(100, parent.clientHeight - b.top - b.bottomInset) + 'px';
      const x = parseFloat(root.style.left), y = parseFloat(root.style.top), height = body.offsetHeight;
      const left = clamp(x + size / 2 - width / 2, gap, parent.clientWidth - width - gap);
      const preferredTop = y - height - gap >= b.top ? y - height - gap : y + size + gap;
      const top = clamp(preferredTop, b.top, parent.clientHeight - b.bottomInset - height);
      body.style.left = left - x + 'px'; body.style.top = top - y + 'px';
    }
    positionNotices = () => {
      if (drag || root.hidden) return;
      const b = bounds();
      if (!anchor) anchor = { edge: 'right', ratio: clamp((b.bottom - 132 - b.top) / (b.bottom - b.top || 1), 0, 1) };
      const ratio = clamp(anchor.ratio, 0, 1);
      const vertical = anchor.edge === 'left' || anchor.edge === 'right';
      position(vertical ? b[anchor.edge] : b.left + ratio * (b.right - b.left),
        vertical ? b.top + ratio * (b.bottom - b.top) : b[anchor.edge]);
      positionPanel(b);
    };
    function snap(x, y, edge) {
      const b = bounds();
      edge = edge || /** @type {[string, number][]} */ ([['left', Math.abs(x - b.left)], ['right', Math.abs(x - b.right)],
        ['top', Math.abs(y - b.top)], ['bottom', Math.abs(y - b.bottom)]]).sort((a, c) => a[1] - c[1])[0][0];
      const vertical = edge === 'left' || edge === 'right';
      anchor = { edge, ratio: clamp(vertical ? (y - b.top) / (b.bottom - b.top || 1) : (x - b.left) / (b.right - b.left || 1), 0, 1) };
      save(); positionNotices();
    }
    bubble.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: parseFloat(root.style.left), top: parseFloat(root.style.top), moved: false };
      bubble.setPointerCapture(event.pointerId);
    });
    bubble.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true; root.classList.add('sq-dragging');
      const b = bounds();
      position(clamp(drag.left + dx, b.left, b.right), clamp(drag.top + dy, b.top, b.bottom));
    });
    function finishDrag(event) {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null; root.classList.remove('sq-dragging');
      if (moved) {
        ignoreClickUntil = Date.now() + 400;
        snap(parseFloat(root.style.left), parseFloat(root.style.top));
      } else positionNotices();
    }
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) bubble.addEventListener(name, finishDrag);
    bubble.addEventListener('click', event => {
      if (event.detail && Date.now() < ignoreClickUntil) { event.preventDefault(); event.stopPropagation(); }
    });
    bubble.addEventListener('keydown', event => {
      const edge = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[event.key];
      if (!edge) return;
      event.preventDefault(); snap(parseFloat(root.style.left), parseFloat(root.style.top), edge);
    });
    document.addEventListener('pointerdown', event => {
      if (root.hidden || root.contains(event.target) || (!noticesExpanded && !noticePeek)) return;
      noticesExpanded = false; noticePeek = false; renderNotices();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || root.hidden || (!noticesExpanded && !noticePeek)) return;
      event.preventDefault(); event.stopPropagation();
      const hadFocus = root.contains(document.activeElement);
      noticesExpanded = false; noticePeek = false; renderNotices();
      if (hadFocus) bubble.focus();
    }, true);
    window.addEventListener('resize', positionNotices);
    if (window.ResizeObserver) new ResizeObserver(positionNotices).observe(parent);
    positionNotices();
  }

  function renderNotices() {
    let root = V.$('sq-notices');
    if (!root) {
      const anchor = V.$('toasts');
      if (!anchor || !V.room) return;
      root = document.createElement('section');
      root.id = 'sq-notices'; root.className = 'sq-notices'; root.dir = window.I18n ? I18n.direction() : 'rtl';
      root.setAttribute('aria-label', tr('התראות AuraShare'));
      root.innerHTML = tr('<button type="button" id="sq-notices-toggle" aria-controls="sq-notices-body" aria-expanded="false" title="AuraShare · גררו לדופן להזזה, או השתמשו בחיצים"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></svg><span id="sq-notices-badge" hidden></span></button>') +
        '<div id="sq-notices-body" hidden><div class="sq-notices-head"><strong id="sq-notices-title">AuraShare</strong>' +
        tr('<button type="button" id="sq-notices-qr" aria-label="הצגת QR והזמנת משתתפים">QR להזמנה</button>') +
        tr('<button type="button" id="sq-notices-close" aria-label="מזעור התראות AuraShare">×</button></div>') +
        '<p id="sq-notices-error" class="sq-message" role="alert"></p><div id="sq-notices-list"></div>' +
        tr('<button type="button" id="sq-notices-all">כל הבקשות והעדכונים</button></div>') +
        '<span id="sq-notices-live" class="sr-only" role="status" aria-live="polite"></span>';
      anchor.parentElement.appendChild(root);
      makeNoticeBubble(root);
      root.onchange = /** @param {Event & { target: HTMLElement }} event */ event => {
        const select = /** @type {HTMLSelectElement} */ (event.target.closest('[data-notice-permission]'));
        if (select && V.room) V.joinPermissions.set(V.room.id + ':' + select.dataset.noticePermission, select.value);
      };
      root.onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.id === 'sq-notices-toggle') { noticesExpanded = !(noticesExpanded || noticePeek); noticePeek = false; renderNotices(); return; }
        if (button.id === 'sq-notices-close') { noticesExpanded = false; noticePeek = false; renderNotices(); return; }
        if (button.id === 'sq-notices-all') { noticesExpanded = true; renderNotices(); return; }
        if (button.id === 'sq-notices-qr') { if (V.room) Views.openSharedQueue(); return; }
        if (button.dataset.noticeDismiss) {
          activity = activity.filter(item => String(item.id) !== button.dataset.noticeDismiss);
          renderNotices(); return;
        }
        if (!V.room || noticeBusy) return;
        const roomId = V.room.id, id = button.dataset.noticeId, kind = button.dataset.noticeKind;
        if (!id || !['guest', 'song'].includes(kind)) return;
        const selected = V.joinPermissions.get(roomId + ':' + id) || V.room.permission;
        noticeBusy = true; renderNotices();
        const work = kind === 'guest'
          ? V.moderateGuest(button, roomId, id, button.dataset.action, selected)
          : V.moderateSong(button, roomId, id, button.dataset.action);
        Promise.resolve(work).finally(() => { noticeBusy = false; renderNotices(); });
      };
    }
    root.dir = window.I18n ? I18n.direction() : 'rtl';
    root.setAttribute('aria-label', tr('התראות AuraShare'));
    V.$('sq-notices-toggle').title = tr('AuraShare · גררו לדופן להזזה, או השתמשו בחיצים');
    V.$('sq-notices-qr').textContent = tr('QR להזמנה');
    V.$('sq-notices-qr').setAttribute('aria-label', tr('הצגת QR והזמנת משתתפים'));
    V.$('sq-notices-close').setAttribute('aria-label', tr('מזעור התראות AuraShare'));
    V.$('sq-notices-all').textContent = tr('כל הבקשות והעדכונים');
    root.hidden = !!V.$('shared-queue-panel') || !V.room;
    const joins = V.room ? V.room.joinRequests || [] : [];
    const songs = V.room ? V.room.requests.filter(item => item.status === 'pending') : [];
    const count = joins.length + songs.length;
    const toggle = V.$('sq-notices-toggle');
    V.$('sq-notices-badge').textContent = count > 99 ? '99+' : String(count);
    V.$('sq-notices-badge').hidden = !count;
    toggle.setAttribute('aria-label', 'AuraShare' + (count ? ', ' + count + tr(' בקשות ממתינות') : tr(', הזמנה ועדכונים')));
    toggle.setAttribute('aria-expanded', String(noticesExpanded || noticePeek));
    V.$('sq-notices-qr').hidden = !V.room;
    V.$('sq-notices-body').hidden = !noticesExpanded && !noticePeek;
    V.$('sq-notices-all').hidden = noticesExpanded;
    V.$('sq-notices-title').textContent = count ? count + tr(' בקשות ממתינות') : 'AuraShare';
    V.$('sq-notices-error').textContent = V.lastError;
    const liveText = count + tr(' בקשות ממתינות.') + (activity.length ? ' ' + activity[activity.length - 1].message : '');
    if (V.$('sq-notices-live').textContent !== liveText) V.$('sq-notices-live').textContent = liveText;
    const disabled = noticeBusy ? ' disabled' : '';
    const buttons = (kind, id, approveDisabled = false) => '<div class="sq-actions"><button type="button" class="sq-primary" data-notice-kind="' + kind + '" data-notice-id="' + V.esc(id) + '" data-action="approve"' + (noticeBusy || approveDisabled ? ' disabled' : '') + tr('>אישור</button>') +
      '<button type="button" data-notice-kind="' + kind + '" data-notice-id="' + V.esc(id) + '" data-action="reject"' + disabled + tr('>דחייה</button></div>');
    const cards = joins.map(guest => ({ key: 'guest:' + guest.id, html: '<p dir="auto">' + V.esc(guest.name) + tr(' מבקש/ת להצטרף</p>') +
      tr('<label>הרשאה לאחר האישור<select data-notice-permission="') + V.esc(guest.id) + '"' + disabled + '>' + V.options(V.joinPermissions.get(V.room.id + ':' + guest.id) || V.room.permission) + '</select></label>' + buttons('guest', guest.id) }));
    cards.push(...songs.map(item => ({ key: 'song:' + item.id, html: '<p dir="auto">' + V.esc(item.fromHost === true ? tr('המארחים') : item.name) + tr(' מבקש/ת להוסיף: <strong>') + V.esc(item.track.title) + '</strong></p>' +
      '<p class="sq-note" dir="auto">' + V.esc(item.track.artist) + '</p>' + (!V.room.isController ? tr('<p class="sq-note">אישור שירים זמין במכשיר שמנהל את הניגון.</p>') : '') +
      buttons('song', item.id, !V.room.isController) })));
    cards.push(...activity.slice().reverse().map(item => ({ key: 'event:' + item.id, html: '<p dir="auto">' + V.esc(item.message) + '</p><button type="button" class="sq-notice-dismiss" data-notice-dismiss="' + item.id + tr('" aria-label="סגירת העדכון">×</button>') })));
    if (!cards.length) cards.push({ key: 'empty', html: tr('<p class="sq-note">כאן יופיעו בקשות הצטרפות, בקשות לשירים ועדכונים מ-AuraShare.</p>') });
    const shown = noticesExpanded ? cards : cards.slice(0, 1);
    const list = V.$('sq-notices-list'), keys = new Set(shown.map(card => card.key));
    for (const child of Array.from(/** @type {HTMLCollectionOf<HTMLElement>} */ (list.children))) if (!keys.has(child.dataset.key)) child.remove();
    shown.forEach((card, index) => {
      let node = Array.from(/** @type {HTMLCollectionOf<HTMLElement & { _noticeHtml?: string }>} */ (list.children)).find(child => child.dataset.key === card.key);
      if (!node) { node = document.createElement('article'); node.className = 'sq-notice'; node.dataset.key = card.key; }
      // Preserve focused controls and native permission pickers across polls.
      if (node._noticeHtml !== card.html) { node.innerHTML = card.html; node._noticeHtml = card.html; }
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    });
    positionNotices();
  }
})();
