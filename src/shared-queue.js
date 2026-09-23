(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  let available = false, room = null, device = '', timer = 0, initialized = false;
  let tail = Promise.resolve(), lastError = '', peekedError = '', openSheet = null, creationMode = 'standalone', requestedMode = '';
  const delivered = new Set();
  const joinPermissions = new Map();
  let activity = [], activityId = 0, noticesExpanded = false, noticeBusy = false, noticePeek = false, noticeTimer = 0;
  let positionNotices = () => {};
  const activityKeys = new Set();
  const labels = { approval: 'כל שיר באישור', direct: 'הוספה חופשית', vote: 'צפייה והצבעה' };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const $ = id => document.getElementById(id);
  function serial(run) { const work = tail.catch(() => {}).then(run); tail = work; return work; }
  async function request(path = '', method = 'GET', body) {
    const response = await fetch('/api/queue/' + path, { method, cache: 'no-store', redirect: 'error',
      headers: { 'X-Queue-Device': device, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let result;
    try { result = await response.json(); } catch { throw Error(tr('AuraShare אינו זמין בשרת כרגע.')); }
    if (!response.ok) throw Object.assign(Error(tr(result.error) || tr('לא ניתן לעדכן את התור כרגע.')), { status: response.status });
    return result;
  }
  // The list markup is rewritten only when it changes, so a poll landing mid-tap does not
  // replace the button under the finger. The markup read back from the browser never
  // equals the string written (boolean attributes, entities), so remember the string.
  function setHtml(el, html) {
    if (!el || el.__html === html) return;
    el.__html = html;
    el.innerHTML = html;
  }
  function options(selected) { return Object.keys(labels).map(key => '<option value="' + key + '"' + (key === selected ? ' selected' : '') + '>' + tr(labels[key]) + '</option>').join(''); }
  function error(message) {
    lastError = message;
    const el = $('sq-message'); if (el) el.textContent = message;
    // A failure the poll repeats every five seconds (a blocked song approved for the
    // queue, a server out of reach) is announced once; otherwise the panel would open
    // again a moment after every dismissal for as long as the failure lasts.
    if (room && message !== peekedError) { peekedError = message; peekNotice(); }
    renderNotices();
  }
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
    const pending = room && ((room.joinRequests || []).length || room.requests.some(item => item.status === 'pending'));
    if (!pending) noticeTimer = setTimeout(() => { noticePeek = false; renderNotices(); }, 6500);
  }
  function observeActivity(previous) {
    if (!room) {
      if (previous && window.Views) Views.toast(tr('השיתוף הסתיים או שפג תוקפו. ההזמנה אינה פעילה יותר.'));
      return;
    }
    const sameRoom = previous && previous.id === room.id;
    const oldJoins = new Map((sameRoom ? previous.joinRequests || [] : []).map(g => [g.id, g]));
    const oldGuests = new Map((sameRoom ? previous.guests || [] : []).map(g => [g.id, g]));
    const oldRequests = new Map((sameRoom ? previous.requests : []).map(item => [item.id, item]));
    const joins = room.joinRequests || [], guests = room.guests || [];
    if (joins.some(g => !oldJoins.has(g.id)) || room.requests.some(item => item.status === 'pending' && !oldRequests.has(item.id))) peekNotice();
    if (!sameRoom) return; // Pending actions reappear after reload; old activity does not.
    if (previous.isController !== room.isController) addActivity(room.isController
      ? tr('ניהול ההוספות עבר למכשיר הזה.') : tr('ניהול ההוספות עבר למכשיר אחר.'));
    if (previous.permission !== room.permission) addActivity(tr('ההרשאה המוצעת לאורחים חדשים עודכנה: ') + tr(labels[room.permission]));
    for (const guest of guests) {
      const old = oldGuests.get(guest.id);
      if (!old) addActivity(guest.name + tr(' הצטרף/ה לשיתוף · ') + tr(labels[guest.permission]));
      else {
        if (old.permission !== guest.permission) addActivity(tr('ההרשאה של ') + guest.name + tr(' עודכנה: ') + tr(labels[guest.permission]));
        if (old.online !== guest.online) addActivity(guest.name + (guest.online ? tr(' חזר/ה להיות פעיל/ה.') : tr(' אינו/ה פעיל/ה כרגע.')));
      }
    }
    for (const guest of oldJoins.values()) {
      if (!joins.some(g => g.id === guest.id) && !guests.some(g => g.id === guest.id)) addActivity(tr('בקשת ההצטרפות של ') + guest.name + tr(' נדחתה.'));
    }
    for (const item of room.requests) {
      const old = oldRequests.get(item.id);
      if (item.delivered && (!old || !old.delivered)) addActivity((item.fromHost === true ? tr('המארחים') : item.name) + tr(' הוסיף/ה לתור: ') + item.track.title, 'delivered:' + item.id);
      else if (item.status === 'approved' && (!old || old.status !== 'approved') && !item.deliver)
        addActivity(tr('אושר להוספה: ') + item.track.title + ' · ' + item.name);
      if (old && old.status !== item.status && item.status === 'rejected') addActivity(tr('ההצעה לשיר ') + item.track.title + tr(' נדחתה.'));
      if (old && old.votes !== item.votes && item.status === 'pending') addActivity(tr('עודכנו ההצבעות על ') + item.track.title + ': ' + item.votes);
    }
  }
  function makeNoticeBubble(root) {
    const bubble = $('sq-notices-toggle'), body = $('sq-notices-body'), parent = root.parentElement;
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
    let root = $('sq-notices');
    if (!root) {
      const anchor = $('toasts');
      if (!anchor || !room) return;
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
        if (select && room) joinPermissions.set(room.id + ':' + select.dataset.noticePermission, select.value);
      };
      root.onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.id === 'sq-notices-toggle') { noticesExpanded = !(noticesExpanded || noticePeek); noticePeek = false; renderNotices(); return; }
        if (button.id === 'sq-notices-close') { noticesExpanded = false; noticePeek = false; renderNotices(); return; }
        if (button.id === 'sq-notices-all') { noticesExpanded = true; renderNotices(); return; }
        if (button.id === 'sq-notices-qr') { if (room) Views.openSharedQueue(); return; }
        if (button.dataset.noticeDismiss) {
          activity = activity.filter(item => String(item.id) !== button.dataset.noticeDismiss);
          renderNotices(); return;
        }
        if (!room || noticeBusy) return;
        const roomId = room.id, id = button.dataset.noticeId, kind = button.dataset.noticeKind;
        if (!id || !['guest', 'song'].includes(kind)) return;
        const selected = joinPermissions.get(roomId + ':' + id) || room.permission;
        noticeBusy = true; renderNotices();
        const work = kind === 'guest'
          ? moderateGuest(button, roomId, id, button.dataset.action, selected)
          : moderateSong(button, roomId, id, button.dataset.action);
        Promise.resolve(work).finally(() => { noticeBusy = false; renderNotices(); });
      };
    }
    root.dir = window.I18n ? I18n.direction() : 'rtl';
    root.setAttribute('aria-label', tr('התראות AuraShare'));
    $('sq-notices-toggle').title = tr('AuraShare · גררו לדופן להזזה, או השתמשו בחיצים');
    $('sq-notices-qr').textContent = tr('QR להזמנה');
    $('sq-notices-qr').setAttribute('aria-label', tr('הצגת QR והזמנת משתתפים'));
    $('sq-notices-close').setAttribute('aria-label', tr('מזעור התראות AuraShare'));
    $('sq-notices-all').textContent = tr('כל הבקשות והעדכונים');
    root.hidden = !!$('shared-queue-panel') || !room;
    const joins = room ? room.joinRequests || [] : [];
    const songs = room ? room.requests.filter(item => item.status === 'pending') : [];
    const count = joins.length + songs.length;
    const toggle = $('sq-notices-toggle');
    $('sq-notices-badge').textContent = count > 99 ? '99+' : String(count);
    $('sq-notices-badge').hidden = !count;
    toggle.setAttribute('aria-label', 'AuraShare' + (count ? ', ' + count + tr(' בקשות ממתינות') : tr(', הזמנה ועדכונים')));
    toggle.setAttribute('aria-expanded', String(noticesExpanded || noticePeek));
    $('sq-notices-qr').hidden = !room;
    $('sq-notices-body').hidden = !noticesExpanded && !noticePeek;
    $('sq-notices-all').hidden = noticesExpanded;
    $('sq-notices-title').textContent = count ? count + tr(' בקשות ממתינות') : 'AuraShare';
    $('sq-notices-error').textContent = lastError;
    const liveText = count + tr(' בקשות ממתינות.') + (activity.length ? ' ' + activity[activity.length - 1].message : '');
    if ($('sq-notices-live').textContent !== liveText) $('sq-notices-live').textContent = liveText;
    const disabled = noticeBusy ? ' disabled' : '';
    const buttons = (kind, id, approveDisabled = false) => '<div class="sq-actions"><button type="button" class="sq-primary" data-notice-kind="' + kind + '" data-notice-id="' + esc(id) + '" data-action="approve"' + (noticeBusy || approveDisabled ? ' disabled' : '') + tr('>אישור</button>') +
      '<button type="button" data-notice-kind="' + kind + '" data-notice-id="' + esc(id) + '" data-action="reject"' + disabled + tr('>דחייה</button></div>');
    const cards = joins.map(guest => ({ key: 'guest:' + guest.id, html: '<p dir="auto">' + esc(guest.name) + tr(' מבקש/ת להצטרף</p>') +
      tr('<label>הרשאה לאחר האישור<select data-notice-permission="') + esc(guest.id) + '"' + disabled + '>' + options(joinPermissions.get(room.id + ':' + guest.id) || room.permission) + '</select></label>' + buttons('guest', guest.id) }));
    cards.push(...songs.map(item => ({ key: 'song:' + item.id, html: '<p dir="auto">' + esc(item.fromHost === true ? tr('המארחים') : item.name) + tr(' מבקש/ת להוסיף: <strong>') + esc(item.track.title) + '</strong></p>' +
      '<p class="sq-note" dir="auto">' + esc(item.track.artist) + '</p>' + (!room.isController ? tr('<p class="sq-note">אישור שירים זמין במכשיר שמנהל את הניגון.</p>') : '') +
      buttons('song', item.id, !room.isController) })));
    cards.push(...activity.slice().reverse().map(item => ({ key: 'event:' + item.id, html: '<p dir="auto">' + esc(item.message) + '</p><button type="button" class="sq-notice-dismiss" data-notice-dismiss="' + item.id + tr('" aria-label="סגירת העדכון">×</button>') })));
    if (!cards.length) cards.push({ key: 'empty', html: tr('<p class="sq-note">כאן יופיעו בקשות הצטרפות, בקשות לשירים ועדכונים מהשיתוף.</p>') });
    const shown = noticesExpanded ? cards : cards.slice(0, 1);
    const list = $('sq-notices-list'), keys = new Set(shown.map(card => card.key));
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
  function adopt(result) {
    const previous = room;
    if (result.room && (!previous || result.room.id !== previous.id)) {
      activity = []; activityKeys.clear(); joinPermissions.clear(); noticesExpanded = false; noticePeek = false;
      peekedError = '';
      clearTimeout(noticeTimer);
    }
    room = result.room; available = true; lastError = '';
    observeActivity(previous);
    if (!room) { clearTimeout(noticeTimer); noticePeek = false; noticesExpanded = false; }
    const pendingGuests = new Set((room ? room.joinRequests || [] : []).map(g => room.id + ':' + g.id));
    for (const key of joinPermissions.keys()) if (!pendingGuests.has(key)) joinPermissions.delete(key);
    if (room && room.isController && room.mode !== 'existing-queue') Player.beginShare(room.id);
    else if (Player.shareSession()) Player.endShare();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (room) timer = setTimeout(() => { refresh().catch(() => {}); }, 5000);
  }
  async function deliver() {
    if (!room || !room.isController) return;
    for (const item of room.requests.filter(item => item.deliver).sort((a, b) =>
      (a.queueOrder ?? a.createdAt ?? 0) - (b.queueOrder ?? b.createdAt ?? 0))) {
      const key = room.id + ':' + item.id;
      if (!delivered.has(key) && !Store.sharedQueueDelivered(key)) {
        if (Store.isBlocked(item.track)) { error(tr('שיר שאושר חסום אצלכם: ') + item.track.title + tr('. בטלו את החסימה כדי להוסיף אותו.')); continue; }
        const current = Player.current();
        const alreadyQueued = room.mode === 'existing-queue'
          ? Player.queue().some(track => track.id === item.track.id)
          : (current && current.id === item.track.id && Player.playbackRequested()) ||
            Player.upcoming().some(track => track.id === item.track.id && !track.auraShareAuto);
        if (!alreadyQueued && !Player.addToQueue(item.track)) {
          // A paused current song is already attached and can be resumed with Play.
          if (!current || current.id !== item.track.id) { error(tr('לא ניתן להוסיף את ') + item.track.title + tr(' כרגע.')); continue; }
        }
        delivered.add(key);
        Store.sharedQueueDelivered(key, true);
        addActivity((item.fromHost === true ? tr('המארחים') : item.name || tr('אורח/ת')) + (alreadyQueued ? tr(' בחר/ה שיר שכבר נמצא בתור: ') : tr(' הוסיף/ה לתור: ')) + item.track.title, 'delivered:' + item.id);
      }
      // Approval is retained on the server until delivery is acknowledged. A failed
      // response can be retried without adding the same suggestion twice on this tab.
      await request(room.id + '/requests/' + item.id + '/ack', 'POST', {});
      item.deliver = false; item.delivered = true;
    }
  }
  function refresh() {
    return serial(async () => {
      try { adopt(await request()); await deliver(); render(); }
      catch (err) { error(err.message || tr('החיבור נקטע. ננסה שוב.')); }
      finally { renderNotices(); schedule(); }
    });
  }
  if (window.addEventListener) window.addEventListener('aura-language', () => {
    // Activity is a transient announcement log; pending requests remain in room state.
    activity = []; lastError = ''; peekedError = '';
    if ($('shared-queue-panel')) shell();
    render();
  });
  function shell() {
    if (!openSheet) return;
    openSheet('<div id="shared-queue-panel" class="shared-queue-panel" dir="' + (window.I18n ? I18n.direction() : 'rtl') + '">' +
      tr('<div class="sq-heading" data-sheet-drag-handle><div><p class="sq-eyebrow">בוחרים יחד מה לשמוע</p><h2 dir="ltr">AuraShare</h2><p id="sq-summary" class="sq-note"></p></div>') +
      tr('<button type="button" class="text-action" id="sq-refresh">רענון</button></div>') +
      '<p id="sq-message" class="sq-message" role="status" aria-live="polite"></p><div id="sq-content"></div></div>');
    const sheet = $('sheet'); if (sheet) sheet.classList.add('expanded');
    $('sq-refresh').onclick = () => { const qr = /** @type {HTMLImageElement} */ ($('sq-qr')); if (qr && !qr.naturalWidth) qr.src = '/api/queue/qr.svg?room=' + encodeURIComponent(room.id) + '&retry=' + Date.now(); refresh(); };
  }
  function render() {
    renderNotices();
    const container = $('sq-content'); if (!container) return;
    $('sq-message').textContent = lastError;
    if (!room) {
      $('sq-summary').textContent = '';
      const mode = creationMode, existingQueue = mode === 'existing-queue';
      if (container.dataset.room === 'new:' + mode) return;
      container.dataset.room = 'new:' + mode;
      container.innerHTML = '<p class="sq-note">' + (existingQueue
        ? tr('מזמינים אורחים להוסיף שירים לתור הקיים. הניגון, סדר השירים והגדרות הנגן נשארים כפי שהם.')
        : tr('פותחים AuraShare עם תור ריק. המוזיקה מתחילה כשמוסיפים את השיר הראשון.')) + tr(' האורחים סורקים QR ומבקשים להצטרף, בלי התקנה או חשבון.</p>') +
        tr('<form id="sq-create" class="sq-form"><label for="sq-title">שם התור</label><input id="sq-title" maxlength="80" value="המוזיקה שלנו" required>') +
        tr('<label for="sq-hours">תוקף ההצטרפות</label><select id="sq-hours"><option value="1">שעה</option><option value="4">4 שעות</option><option value="8" selected>8 שעות</option><option value="24">24 שעות</option></select>') +
        tr('<label for="sq-permission">הרשאה מוצעת באישור אורח</label><select id="sq-permission">') + options('approval') + '</select>' +
        tr('<p class="sq-note">מאשרים כל אורח בנפרד עם הרשאה לבחירתכם. אין מגבלה אישית על מספר השירים. ') + (existingQueue
          ? tr('בסיום השיתוף השירים שנוספו נשארים בתור והניגון ממשיך כרגיל.')
          : tr('כשהתור מתרוקן, Aura מוסיפה שיר מתאים אחד.')) + '</p>' +
        tr('<button type="submit" class="sq-primary">יצירת QR להזמנה</button></form>');
      $('sq-create').onsubmit = event => {
        event.preventDefault();
        const body = { title: /** @type {HTMLInputElement} */ ($('sq-title')).value, hours: Number(/** @type {HTMLSelectElement} */ ($('sq-hours')).value), permission: /** @type {HTMLSelectElement} */ ($('sq-permission')).value, mode };
        run($('sq-create').querySelector('button'), async () => { adopt(await request('', 'POST', body)); });
      };
      return;
    }
    if (container.dataset.room !== room.id) {
      container.dataset.room = room.id;
      container.innerHTML = tr('<p id="sq-mode-note" class="sq-message" role="status" hidden></p><div class="sq-invite"><h3 id="sq-room-title"></h3><img id="sq-qr" alt="QR להצטרפות ל־AuraShare" width="240" height="240">') +
        tr('<p class="sq-note">סורקים כדי להצטרף</p><p id="sq-expiry" class="sq-note"></p><div class="sq-actions"><button type="button" id="sq-share">שיתוף הזמנה</button>') +
        tr('<button type="button" id="sq-copy">העתקת קישור</button></div><input id="sq-link" readonly aria-label="קישור להזמנה" dir="ltr" hidden></div>') +
        tr('<div id="sq-controller" class="sq-note"></div><button type="button" id="sq-control" hidden>העברת הניהול למכשיר הזה</button>') +
        tr('<section class="sq-section" id="sq-playback-section"><h3>הניגון ב־AuraShare</h3><p id="sq-playback-status" class="sq-note" role="status"></p><button type="button" id="sq-playback" class="sq-primary" hidden>הפעלת הניגון</button><div id="sq-upcoming"></div></section>') +
        tr('<section class="sq-section"><h3 id="sq-joins-title">בקשות הצטרפות</h3><p class="sq-note">בחרו הרשאה ואשרו כל אורח בנפרד.</p><div id="sq-joins"></div></section>') +
        tr('<section class="sq-section"><h3>הוספת שירים משלכם</h3><form id="sq-search" class="sq-form"><label for="sq-query">שם שיר או אמן</label><input id="sq-query" type="search" minlength="2" maxlength="160" required dir="auto"><button type="submit">חיפוש</button></form><div id="sq-results"></div></section>') +
        tr('<section class="sq-section"><h3 id="sq-people-title">משתתפים והרשאות</h3><label class="sq-person"><span>הרשאה מוצעת לאורחים חדשים</span><select id="sq-default">') + options(room.permission) + '</select></label><div id="sq-guests"></div></section>' +
        tr('<section class="sq-section"><h3 id="sq-count">הצעות לשירים</h3><div id="sq-requests"></div></section>') +
        '<button type="button" id="sq-end" class="sq-danger">' + (room.mode === 'existing-queue' ? tr('סיום השיתוף וביטול ה־QR') : tr('סגירת התור וביטול ה־QR')) + '</button>';
      /** @type {HTMLImageElement} */ ($('sq-qr')).src = '/api/queue/qr.svg?room=' + encodeURIComponent(room.id);
      $('sq-qr').onerror = () => error(tr('לא ניתן לטעון את ה־QR. לחצו על רענון כדי לנסות שוב.'));
      $('sq-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(room.inviteUrl); Views.toast(tr('קישור ההזמנה הועתק')); }
        catch { const link = /** @type {HTMLInputElement} */ ($('sq-link')); link.hidden = false; link.value = room.inviteUrl; link.select(); }
      };
      $('sq-share').onclick = async () => {
        if (!navigator.share) { $('sq-copy').click(); return; }
        try { await navigator.share({ title: room.title, text: tr('מצטרפים ל־AuraShare שלנו'), url: room.inviteUrl }); }
        catch (err) { if (err.name !== 'AbortError') error(tr('לא ניתן לשתף כרגע. אפשר להעתיק את הקישור.')); }
      };
      $('sq-default').onchange = event => permission(event.target, null);
      $('sq-joins').onchange = /** @param {Event & { target: HTMLElement }} event */ event => {
        const select = /** @type {HTMLSelectElement} */ (event.target.closest('[data-join-permission]'));
        if (select) joinPermissions.set(room.id + ':' + select.dataset.joinPermission, select.value);
      };
      $('sq-joins').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-join]')); if (!button) return;
        const roomId = room.id, guestId = button.dataset.join;
        const selected = joinPermissions.get(roomId + ':' + guestId) || room.permission;
        moderateGuest(button, roomId, guestId, button.dataset.action, selected);
      };
      $('sq-search').onsubmit = event => {
        event.preventDefault(); const roomId = room.id, query = /** @type {HTMLInputElement} */ ($('sq-query')).value;
        run($('sq-search').querySelector('button'), async () => {
          const result = await request(roomId + '/search', 'POST', { query });
          if (!room || room.id !== roomId || !$('sq-results')) return;
          $('sq-results').innerHTML = result.tracks.map(track => '<div class="sq-request"><div class="sq-track"><strong dir="auto">' + esc(track.title) + '</strong><span dir="auto">' + esc(track.artist) + '</span></div><button type="button" data-add="' + esc(track.id) + tr('">הוספה ל־AuraShare</button></div>')).join('') || tr('<p class="sq-note">לא נמצאו שירים.</p>');
        });
      };
      $('sq-results').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-add]')); if (!button) return;
        const roomId = room.id;
        run(button, async () => { adopt(await request(roomId + '/requests', 'POST', { trackId: button.dataset.add })); });
      };
      $('sq-playback').onclick = () => { Player.toggle(); renderPlayback(); };
      $('sq-guests').onchange = /** @param {Event & { target: HTMLElement }} event */ event => { if (event.target.matches('select')) permission(event.target, event.target.dataset.guest); };
      $('sq-control').onclick = () => {
        // The action waits its turn behind a pending refresh that may close the room.
        const roomId = room && room.id; if (!roomId) return;
        run($('sq-control'), async () => { adopt(await request(roomId + '/control', 'POST', {})); });
      };
      $('sq-end').onclick = () => {
        const roomId = room && room.id; if (!roomId) return;
        run($('sq-end'), async () => { await request(roomId, 'DELETE'); adopt({ room: null }); });
      };
      $('sq-requests').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-request]')); if (!button) return;
        moderateSong(button, room.id, button.dataset.request, button.dataset.action);
      };
    }
    const joins = room.joinRequests || [];
    $('sq-summary').textContent = room.guests.length + tr(' משתתפים · ') + room.guests.filter(guest => guest.online).length + tr(' מחוברים') + (joins.length ? ' · ' + joins.length + tr(' ממתינים להצטרפות') : '');
    $('sq-joins-title').textContent = tr('בקשות הצטרפות · ') + joins.length + tr(' ממתינות');
    const keys = new Set(joins.map(guest => room.id + ':' + guest.id));
    for (const key of joinPermissions.keys()) if (!keys.has(key)) joinPermissions.delete(key);
    const joinsHtml = joins.map(guest => '<div class="sq-request"><label class="sq-person"><span dir="auto">' + esc(guest.name) + '<small class="sq-presence' + (guest.online ? ' online' : '') + '">' + (guest.online ? tr('מחובר/ת וממתין/ה') : tr('לא פעיל/ה כרגע')) + '</small></span><select data-join-permission="' + esc(guest.id) + tr('" aria-label="הרשאה באישור ') + esc(guest.name) + '">' + options(joinPermissions.get(room.id + ':' + guest.id) || room.permission) + '</select></label><div class="sq-actions"><button type="button" class="sq-primary" data-join="' + esc(guest.id) + tr('" data-action="approve">אישור הצטרפות</button><button type="button" data-join="') + esc(guest.id) + tr('" data-action="reject">דחייה</button></div></div>')).join('') || tr('<p class="sq-note">אין בקשות הצטרפות חדשות.</p>');
    const joinIds = joins.map(guest => guest.id).join(',');
    if (!$('sq-joins').contains(document.activeElement) || $('sq-joins').dataset.ids !== joinIds) setHtml($('sq-joins'), joinsHtml);
    $('sq-joins').dataset.ids = joinIds;
    $('sq-room-title').textContent = room.title;
    $('sq-expiry').textContent = tr('בתוקף עד ') + new Date(room.expiresAt).toLocaleString(window.I18n ? I18n.locale() : 'he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    // The mode belongs to the invitation. Create promises a fresh queue, so say why the
    // music kept playing instead of showing an invitation that silently does otherwise.
    const mismatch = requestedMode === 'standalone' && room.mode === 'existing-queue';
    $('sq-mode-note').hidden = !mismatch;
    $('sq-mode-note').textContent = mismatch ? tr('כבר פעילה הזמנה שמחוברת לתור הקיים, ולכן הניגון לא נעצר ולא נפתח תור חדש. כדי לפתוח AuraShare נפרד עם תור ריק, סיימו קודם את השיתוף הזה.') : '';
    $('sq-controller').textContent = room.isController
      ? (room.mode === 'existing-queue' ? tr('ההזמנה מחוברת לתור הקיים במכשיר הזה. הניגון והגדרות הנגן ממשיכים כרגיל. ') : tr('השירים יתווספו לתור במכשיר הזה. ')) + tr('השאירו את האפליקציה פתוחה כדי לקבל שירים חדשים.')
      : tr('הוספת השירים פעילה במכשיר אחר. אפשר להעביר לכאן את הניהול.') + (room.mode === 'existing-queue' ? tr(' ההוספות הבאות יצטרפו לתור המקומי במכשיר הזה.')
        : tr(' ההעברה תשהה את הניגון האישי במכשיר הזה ותפתח כאן תור שיתוף ריק.'));
    $('sq-control').hidden = room.isController;
    renderPlayback();
    if (document.activeElement !== $('sq-default')) /** @type {HTMLSelectElement} */ ($('sq-default')).value = room.permission;
    $('sq-people-title').textContent = tr('משתתפים והרשאות · ') + room.guests.filter(guest => guest.online).length + tr(' מחוברים');
    const guestsHtml = room.guests.map(guest => '<label class="sq-person"><span dir="auto">' + esc(guest.name) + '<small class="sq-presence' + (guest.online ? ' online' : '') + '">' + (guest.online ? tr('מחובר/ת עכשיו') : tr('לא פעיל/ה כרגע')) + '</small></span><select data-guest="' + esc(guest.id) + tr('" aria-label="הרשאה עבור ') + esc(guest.name) + '">' + options(guest.permission) + '</select></label>').join('') || tr('<p class="sq-note">המשתתפים יופיעו כאן אחרי שיסרקו ויצטרפו.</p>');
    if (!$('sq-guests').contains(document.activeElement)) setHtml($('sq-guests'), guestsHtml);
    const pending = room.requests.filter(item => item.status === 'pending');
    $('sq-count').textContent = tr('הצעות לשירים · ') + pending.length + tr(' ממתינות');
    const items = pending.concat(room.requests.filter(item => item.status !== 'pending'));
    const html = items.map(item => '<div class="sq-request"><div class="sq-track"><strong dir="auto">' + esc(item.track.title) + '</strong><span dir="auto">' + esc(item.track.artist) + '</span><small dir="auto">' + esc(item.fromHost === true ? tr('המארחים') : item.name) + ' · ' + item.votes + tr(' הצבעות</small></div>') +
      (item.status === 'pending' ? '<div class="sq-actions"><button type="button" data-request="' + esc(item.id) + '" data-action="approve"' + (!room.isController ? ' disabled' : '') + tr('>אישור</button><button type="button" data-request="') + esc(item.id) + tr('" data-action="reject">דחייה</button></div>') :
        '<span class="sq-status">' + (item.status === 'rejected' ? tr('נדחתה') : item.delivered ? tr('נוספה לתור') : tr('אושרה, ממתינה להוספה')) + '</span>') + '</div>').join('') || tr('<p class="sq-note">עדיין אין הצעות. הציגו את ה־QR כדי להזמין משתתפים.</p>');
    setHtml($('sq-requests'), html);
  }
  function renderPlayback() {
    if (!room || !$('sq-playback-section')) return;
    $('sq-playback-section').hidden = !room.isController;
    if (!room.isController) return;
    const current = Player.current(), paused = Player.isPaused(), existingQueue = room.mode === 'existing-queue';
    $('sq-playback-status').textContent = !current ? (existingQueue ? tr('התור כרגע ריק. שירים שיתווספו יפעלו לפי כללי הנגן הרגילים.') : tr('מחכים לשיר הראשון שלכם. הניגון יתחיל אחרי הוספה או אישור של שיר.')) :
      Player.needsPlaybackGesture() ? tr('הדפדפן ממתין ללחיצה על הפעלת הניגון.') :
      (paused ? tr('הניגון מושהה: ') : tr('מתנגן עכשיו: ')) + current.title;
    $('sq-playback').hidden = !current || !paused || Player.playbackRequested();
    const upcoming = Player.upcoming();
    const html = upcoming.map(track => '<div class="sq-track"><strong dir="auto">' + esc(track.title) + '</strong><small>' + (!existingQueue && track.auraShareAuto ? tr('השלמה של Aura') : tr('בתור להשמעה')) + '</small></div>').join('') || '<p class="sq-note">' + (existingQueue
      ? tr('אין שירים נוספים בתור. המשך הניגון תלוי בהגדרות הנגן שלכם.')
      : tr('השירים שתוסיפו מקבלים עדיפות. כשהתור מתרוקן, Aura בוחרת שיר אחד לפי המוזיקה שבחרתם.')) + '</p>';
    setHtml($('sq-upcoming'), html);
  }
  function permission(select, guestId) {
    const value = select.value, roomId = room && room.id;
    if (!roomId) return;
    run(select, async () => { adopt(await request(roomId + '/permissions', 'POST', { guestId, permission: value })); });
  }
  function moderateGuest(button, roomId, guestId, action, selected) {
    return run(button, async () => {
      adopt(await request(roomId + '/guests/' + guestId + '/' + action, 'POST', { permission: selected }));
    });
  }
  function moderateSong(button, roomId, requestId, action) {
    const item = room && room.id === roomId && room.requests.find(item => item.id === requestId);
    if (action === 'approve' && item && Store.isBlocked(item.track)) {
      error(tr('השיר חסום אצלכם. בטלו את החסימה לפני אישור.')); return;
    }
    return run(button, async () => { adopt(await request(roomId + '/requests/' + requestId + '/' + action, 'POST', {})); });
  }
  function run(button, work) {
    button.disabled = true;
    return serial(async () => {
      try { await work(); await deliver(); }
      catch (err) {
        // A decision on another device can make this card stale while it is visible.
        if ([404, 409, 410].includes(err.status)) { try { adopt(await request()); } catch {} }
        error(err.message || tr('לא ניתן לעדכן את התור כרגע.'));
      }
      finally { button.disabled = false; render(); schedule(); }
    });
  }
  function init() {
    if (initialized) return;
    initialized = true;
    device = Store.sharedQueueDevice();
    Player.onChange(event => {
      if (['queue', 'track', 'state', 'playback-permission', 'queue-end'].includes(event.type)) renderPlayback();
    });
    refresh();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && room) refresh(); });
  }
  window.SharedQueue = {
    init, available: () => available, refreshNotifications: renderNotices,
    // The floating control reopens the invitation without asking for a mode of its own.
    open(showSheet, mode) {
      init(); requestedMode = ['standalone', 'existing-queue'].includes(mode) ? mode : '';
      if (requestedMode) creationMode = requestedMode;
      else if (room) creationMode = room.mode === 'existing-queue' ? 'existing-queue' : 'standalone';
      openSheet = showSheet; shell(); render(); refresh();
    }
  };
})();
