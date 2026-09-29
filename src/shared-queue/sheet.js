(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  const V = window.Aura.sharedQueue;
  // The AuraShare sheet: the room, its guests and requests, the playback row, and the public face of the module.
  // Published on V for the other files of this module; see src/shared-queue.js.
  Object.defineProperties(V, {
    moderateGuest: { get: () => moderateGuest },
    moderateSong: { get: () => moderateSong },
    render: { get: () => render },
    renderPlayback: { get: () => renderPlayback },
    shell: { get: () => shell }
  });

  function shell() {
    if (!V.openSheet) return;
    V.openSheet('<div id="shared-queue-panel" class="shared-queue-panel" dir="' + (window.I18n ? I18n.direction() : 'rtl') + '">' +
      tr('<div class="sq-heading" data-sheet-drag-handle><div><p class="sq-eyebrow">בוחרים יחד מה לשמוע</p><h2 dir="ltr">AuraShare</h2><p id="sq-summary" class="sq-note"></p></div>') +
      tr('<button type="button" class="text-action" id="sq-refresh">רענון</button></div>') +
      '<p id="sq-message" class="sq-message" role="status" aria-live="polite"></p><div id="sq-content"></div></div>');
    const sheet = V.$('sheet'); if (sheet) sheet.classList.add('expanded');
    V.$('sq-refresh').onclick = () => { const qr = /** @type {HTMLImageElement} */ (V.$('sq-qr')); if (qr && !qr.naturalWidth) qr.src = '/api/queue/qr.svg?room=' + encodeURIComponent(V.room.id) + '&retry=' + Date.now(); V.refresh(); };
  }

  function render() {
    V.renderNotices();
    const container = V.$('sq-content'); if (!container) return;
    V.$('sq-message').textContent = V.lastError;
    if (!V.room) {
      V.$('sq-summary').textContent = '';
      const mode = V.creationMode, existingQueue = mode === 'existing-queue';
      if (container.dataset.room === 'new:' + mode) return;
      container.dataset.room = 'new:' + mode;
      container.innerHTML = '<p class="sq-note">' + (existingQueue
        ? tr('מזמינים אורחים להוסיף שירים לתור הקיים. הניגון, סדר השירים והגדרות הנגן נשארים כפי שהם.')
        : tr('פותחים AuraShare עם תור ריק. המוזיקה מתחילה כשמוסיפים את השיר הראשון.')) + tr(' האורחים סורקים QR ומבקשים להצטרף, בלי התקנה או חשבון.</p>') +
        tr('<form id="sq-create" class="sq-form"><label for="sq-title">שם התור</label><input id="sq-title" maxlength="80" value="המוזיקה שלנו" required>') +
        tr('<label for="sq-hours">תוקף ההצטרפות</label><select id="sq-hours"><option value="1">שעה</option><option value="4">4 שעות</option><option value="8" selected>8 שעות</option><option value="24">24 שעות</option></select>') +
        tr('<label for="sq-permission">הרשאה מוצעת באישור אורח</label><select id="sq-permission">') + V.options('approval') + '</select>' +
        tr('<p class="sq-note">מאשרים כל אורח בנפרד עם הרשאה לבחירתכם. אין מגבלה אישית על מספר השירים. ') + (existingQueue
          ? tr('בסיום AuraShare השירים שנוספו נשארים בתור והניגון ממשיך כרגיל.')
          : tr('כשהתור מתרוקן, Aura מוסיפה שיר מתאים אחד.')) + '</p>' +
        tr('<button type="submit" class="sq-primary">יצירת QR להזמנה</button></form>');
      V.$('sq-create').onsubmit = event => {
        event.preventDefault();
        const body = { title: /** @type {HTMLInputElement} */ (V.$('sq-title')).value, hours: Number(/** @type {HTMLSelectElement} */ (V.$('sq-hours')).value), permission: /** @type {HTMLSelectElement} */ (V.$('sq-permission')).value, mode };
        run(V.$('sq-create').querySelector('button'), async () => { V.adopt(await V.request('', 'POST', body)); });
      };
      return;
    }
    if (container.dataset.room !== V.room.id) {
      container.dataset.room = V.room.id;
      container.innerHTML = tr('<p id="sq-mode-note" class="sq-message" role="status" hidden></p><div class="sq-invite"><h3 id="sq-room-title"></h3><img id="sq-qr" alt="QR להצטרפות ל־AuraShare" width="240" height="240">') +
        tr('<p class="sq-note">סורקים כדי להצטרף</p><p id="sq-expiry" class="sq-note"></p><div class="sq-actions"><button type="button" id="sq-share">שיתוף הזמנה</button>') +
        tr('<button type="button" id="sq-copy">העתקת קישור</button></div><input id="sq-link" readonly aria-label="קישור להזמנה" dir="ltr" hidden></div>') +
        tr('<div id="sq-controller" class="sq-note"></div><button type="button" id="sq-control" hidden>העברת הניהול למכשיר הזה</button>') +
        tr('<section class="sq-section" id="sq-playback-section"><h3>הניגון ב־AuraShare</h3><p id="sq-playback-status" class="sq-note" role="status"></p><button type="button" id="sq-playback" class="sq-primary" hidden>הפעלת הניגון</button><div id="sq-upcoming"></div></section>') +
        tr('<section class="sq-section"><h3 id="sq-joins-title">בקשות הצטרפות</h3><p class="sq-note">בחרו הרשאה ואשרו כל אורח בנפרד.</p><div id="sq-joins"></div></section>') +
        tr('<section class="sq-section"><h3>הוספת שירים משלכם</h3><form id="sq-search" class="sq-form"><label for="sq-query">שם שיר או אמן</label><input id="sq-query" type="search" minlength="2" maxlength="160" required dir="auto"><button type="submit">חיפוש</button></form><div id="sq-results"></div></section>') +
        tr('<section class="sq-section"><h3 id="sq-people-title">משתתפים והרשאות</h3><label class="sq-person"><span>הרשאה מוצעת לאורחים חדשים</span><select id="sq-default">') + V.options(V.room.permission) + '</select></label><div id="sq-guests"></div></section>' +
        tr('<section class="sq-section"><h3 id="sq-count">הצעות לשירים</h3><div id="sq-requests"></div></section>') +
        '<button type="button" id="sq-end" class="sq-danger">' + (V.room.mode === 'existing-queue' ? tr('סיום AuraShare וביטול ה־QR') : tr('סגירת התור וביטול ה־QR')) + '</button>';
      /** @type {HTMLImageElement} */ (V.$('sq-qr')).src = '/api/queue/qr.svg?room=' + encodeURIComponent(V.room.id);
      V.$('sq-qr').onerror = () => V.error(tr('לא ניתן לטעון את ה־QR. לחצו על רענון כדי לנסות שוב.'));
      V.$('sq-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(V.room.inviteUrl); Views.toast(tr('קישור ההזמנה הועתק')); }
        catch { const link = /** @type {HTMLInputElement} */ (V.$('sq-link')); link.hidden = false; link.value = V.room.inviteUrl; link.select(); }
      };
      V.$('sq-share').onclick = async () => {
        if (!navigator.share) { V.$('sq-copy').click(); return; }
        try { await navigator.share({ title: V.room.title, text: tr('מצטרפים ל־AuraShare שלנו'), url: V.room.inviteUrl }); }
        catch (err) { if (err.name !== 'AbortError') V.error(tr('לא ניתן לשתף כרגע. אפשר להעתיק את הקישור.')); }
      };
      V.$('sq-default').onchange = event => permission(event.target, null);
      V.$('sq-joins').onchange = /** @param {Event & { target: HTMLElement }} event */ event => {
        const select = /** @type {HTMLSelectElement} */ (event.target.closest('[data-join-permission]'));
        if (select) V.joinPermissions.set(V.room.id + ':' + select.dataset.joinPermission, select.value);
      };
      V.$('sq-joins').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-join]')); if (!button) return;
        const roomId = V.room.id, guestId = button.dataset.join;
        const selected = V.joinPermissions.get(roomId + ':' + guestId) || V.room.permission;
        moderateGuest(button, roomId, guestId, button.dataset.action, selected);
      };
      V.$('sq-search').onsubmit = event => {
        event.preventDefault(); const roomId = V.room.id, query = /** @type {HTMLInputElement} */ (V.$('sq-query')).value;
        run(V.$('sq-search').querySelector('button'), async () => {
          const result = await V.request(roomId + '/search', 'POST', { query });
          if (!V.room || V.room.id !== roomId || !V.$('sq-results')) return;
          V.$('sq-results').innerHTML = result.tracks.map(track => '<div class="sq-request"><div class="sq-track"><strong dir="auto">' + V.esc(track.title) + '</strong><span dir="auto">' + V.esc(track.artist) + '</span></div><button type="button" data-add="' + V.esc(track.id) + tr('">הוספה ל־AuraShare</button></div>')).join('') || tr('<p class="sq-note">לא נמצאו שירים.</p>');
        });
      };
      V.$('sq-results').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-add]')); if (!button) return;
        const roomId = V.room.id;
        run(button, async () => { V.adopt(await V.request(roomId + '/requests', 'POST', { trackId: button.dataset.add })); });
      };
      V.$('sq-playback').onclick = () => { Player.toggle(); renderPlayback(); };
      V.$('sq-guests').onchange = /** @param {Event & { target: HTMLElement }} event */ event => { if (event.target.matches('select')) permission(event.target, event.target.dataset.guest); };
      V.$('sq-control').onclick = () => {
        // The action waits its turn behind a pending refresh that may close the room.
        const roomId = V.room && V.room.id; if (!roomId) return;
        run(V.$('sq-control'), async () => { V.adopt(await V.request(roomId + '/control', 'POST', {})); });
      };
      V.$('sq-end').onclick = () => {
        const roomId = V.room && V.room.id; if (!roomId) return;
        run(V.$('sq-end'), async () => { await V.request(roomId, 'DELETE'); V.adopt({ room: null }); });
      };
      V.$('sq-requests').onclick = /** @param {PointerEvent & { target: HTMLElement }} event */ event => {
        const button = /** @type {HTMLButtonElement} */ (event.target.closest('[data-request]')); if (!button) return;
        moderateSong(button, V.room.id, button.dataset.request, button.dataset.action);
      };
    }
    const joins = V.room.joinRequests || [];
    V.$('sq-summary').textContent = V.room.guests.length + tr(' משתתפים · ') + V.room.guests.filter(guest => guest.online).length + tr(' מחוברים') + (joins.length ? ' · ' + joins.length + tr(' ממתינים להצטרפות') : '');
    V.$('sq-joins-title').textContent = tr('בקשות הצטרפות · ') + joins.length + tr(' ממתינות');
    const keys = new Set(joins.map(guest => V.room.id + ':' + guest.id));
    for (const key of V.joinPermissions.keys()) if (!keys.has(key)) V.joinPermissions.delete(key);
    const joinsHtml = joins.map(guest => '<div class="sq-request"><label class="sq-person"><span dir="auto">' + V.esc(guest.name) + '<small class="sq-presence' + (guest.online ? ' online' : '') + '">' + (guest.online ? tr('מחובר/ת וממתין/ה') : tr('לא פעיל/ה כרגע')) + '</small></span><select data-join-permission="' + V.esc(guest.id) + tr('" aria-label="הרשאה באישור ') + V.esc(guest.name) + '">' + V.options(V.joinPermissions.get(V.room.id + ':' + guest.id) || V.room.permission) + '</select></label><div class="sq-actions"><button type="button" class="sq-primary" data-join="' + V.esc(guest.id) + tr('" data-action="approve">אישור הצטרפות</button><button type="button" data-join="') + V.esc(guest.id) + tr('" data-action="reject">דחייה</button></div></div>')).join('') || tr('<p class="sq-note">אין בקשות הצטרפות חדשות.</p>');
    const joinIds = joins.map(guest => guest.id).join(',');
    if (!V.$('sq-joins').contains(document.activeElement) || V.$('sq-joins').dataset.ids !== joinIds) V.setHtml(V.$('sq-joins'), joinsHtml);
    V.$('sq-joins').dataset.ids = joinIds;
    V.$('sq-room-title').textContent = V.room.title;
    V.$('sq-expiry').textContent = tr('בתוקף עד ') + new Date(V.room.expiresAt).toLocaleString(window.I18n ? I18n.locale() : 'he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    // The mode belongs to the invitation. Create promises a fresh queue, so say why the
    // music kept playing instead of showing an invitation that silently does otherwise.
    const mismatch = V.requestedMode === 'standalone' && V.room.mode === 'existing-queue';
    V.$('sq-mode-note').hidden = !mismatch;
    V.$('sq-mode-note').textContent = mismatch ? tr('כבר פעילה הזמנה שמחוברת לתור הקיים, ולכן הניגון לא נעצר ולא נפתח תור חדש. כדי לפתוח AuraShare נפרד עם תור ריק, סיימו קודם את ה-AuraShare הזה.') : '';
    V.$('sq-controller').textContent = V.room.isController
      ? (V.room.mode === 'existing-queue' ? tr('ההזמנה מחוברת לתור הקיים במכשיר הזה. הניגון והגדרות הנגן ממשיכים כרגיל. ') : tr('השירים יתווספו לתור במכשיר הזה. ')) + tr('השאירו את האפליקציה פתוחה כדי לקבל שירים חדשים.')
      : tr('הוספת השירים פעילה במכשיר אחר. אפשר להעביר לכאן את הניהול.') + (V.room.mode === 'existing-queue' ? tr(' ההוספות הבאות יצטרפו לתור המקומי במכשיר הזה.')
        : tr(' ההעברה תשהה את הניגון האישי במכשיר הזה ותפתח כאן תור AuraShare ריק.'));
    V.$('sq-control').hidden = V.room.isController;
    renderPlayback();
    if (document.activeElement !== V.$('sq-default')) /** @type {HTMLSelectElement} */ (V.$('sq-default')).value = V.room.permission;
    V.$('sq-people-title').textContent = tr('משתתפים והרשאות · ') + V.room.guests.filter(guest => guest.online).length + tr(' מחוברים');
    const guestsHtml = V.room.guests.map(guest => '<label class="sq-person"><span dir="auto">' + V.esc(guest.name) + '<small class="sq-presence' + (guest.online ? ' online' : '') + '">' + (guest.online ? tr('מחובר/ת עכשיו') : tr('לא פעיל/ה כרגע')) + '</small></span><select data-guest="' + V.esc(guest.id) + tr('" aria-label="הרשאה עבור ') + V.esc(guest.name) + '">' + V.options(guest.permission) + '</select></label>').join('') || tr('<p class="sq-note">המשתתפים יופיעו כאן אחרי שיסרקו ויצטרפו.</p>');
    if (!V.$('sq-guests').contains(document.activeElement)) V.setHtml(V.$('sq-guests'), guestsHtml);
    const pending = V.room.requests.filter(item => item.status === 'pending');
    V.$('sq-count').textContent = tr('הצעות לשירים · ') + pending.length + tr(' ממתינות');
    const items = pending.concat(V.room.requests.filter(item => item.status !== 'pending'));
    const html = items.map(item => '<div class="sq-request"><div class="sq-track"><strong dir="auto">' + V.esc(item.track.title) + '</strong><span dir="auto">' + V.esc(item.track.artist) + '</span><small dir="auto">' + V.esc(item.fromHost === true ? tr('המארחים') : item.name) + ' · ' + item.votes + tr(' הצבעות</small></div>') +
      (item.status === 'pending' ? '<div class="sq-actions"><button type="button" data-request="' + V.esc(item.id) + '" data-action="approve"' + (!V.room.isController ? ' disabled' : '') + tr('>אישור</button><button type="button" data-request="') + V.esc(item.id) + tr('" data-action="reject">דחייה</button></div>') :
        '<span class="sq-status">' + (item.status === 'rejected' ? tr('נדחתה') : item.delivered ? tr('נוספה לתור') : tr('אושרה, ממתינה להוספה')) + '</span>') + '</div>').join('') || tr('<p class="sq-note">עדיין אין הצעות. הציגו את ה־QR כדי להזמין משתתפים.</p>');
    V.setHtml(V.$('sq-requests'), html);
  }

  function renderPlayback() {
    if (!V.room || !V.$('sq-playback-section')) return;
    V.$('sq-playback-section').hidden = !V.room.isController;
    if (!V.room.isController) return;
    const current = Player.current(), paused = Player.isPaused(), existingQueue = V.room.mode === 'existing-queue';
    V.$('sq-playback-status').textContent = !current ? (existingQueue ? tr('התור כרגע ריק. שירים שיתווספו יפעלו לפי כללי הנגן הרגילים.') : tr('מחכים לשיר הראשון שלכם. הניגון יתחיל אחרי הוספה או אישור של שיר.')) :
      Player.needsPlaybackGesture() ? tr('הדפדפן ממתין ללחיצה על הפעלת הניגון.') :
      (paused ? tr('הניגון מושהה: ') : tr('מתנגן עכשיו: ')) + current.title;
    V.$('sq-playback').hidden = !current || !paused || Player.playbackRequested();
    const upcoming = Player.upcoming();
    const html = upcoming.map(track => '<div class="sq-track"><strong dir="auto">' + V.esc(track.title) + '</strong><small>' + (!existingQueue && track.auraShareAuto ? tr('השלמה של Aura') : tr('בתור להשמעה')) + '</small></div>').join('') || '<p class="sq-note">' + (existingQueue
      ? tr('אין שירים נוספים בתור. המשך הניגון תלוי בהגדרות הנגן שלכם.')
      : tr('השירים שתוסיפו מקבלים עדיפות. כשהתור מתרוקן, Aura בוחרת שיר אחד לפי המוזיקה שבחרתם.')) + '</p>';
    V.setHtml(V.$('sq-upcoming'), html);
  }

  function permission(select, guestId) {
    const value = select.value, roomId = V.room && V.room.id;
    if (!roomId) return;
    run(select, async () => { V.adopt(await V.request(roomId + '/permissions', 'POST', { guestId, permission: value })); });
  }

  function moderateGuest(button, roomId, guestId, action, selected) {
    return run(button, async () => {
      V.adopt(await V.request(roomId + '/guests/' + guestId + '/' + action, 'POST', { permission: selected }));
    });
  }

  function moderateSong(button, roomId, requestId, action) {
    const item = V.room && V.room.id === roomId && V.room.requests.find(item => item.id === requestId);
    if (action === 'approve' && item && Store.isBlocked(item.track)) {
      V.error(tr('השיר חסום אצלכם. בטלו את החסימה לפני אישור.')); return;
    }
    return run(button, async () => { V.adopt(await V.request(roomId + '/requests/' + requestId + '/' + action, 'POST', {})); });
  }

  function run(button, work) {
    button.disabled = true;
    return V.serial(async () => {
      try { await work(); await V.deliver(); }
      catch (err) {
        // A decision on another device can make this card stale while it is visible.
        if ([404, 409, 410].includes(err.status)) { try { V.adopt(await V.request()); } catch {} }
        V.error(err.message || tr('לא ניתן לעדכן את התור כרגע.'));
      }
      finally { button.disabled = false; render(); V.schedule(); }
    });
  }

  window.SharedQueue = {
    init: V.init, available: () => V.available, refreshNotifications: V.renderNotices,
    // The floating control reopens the invitation without asking for a mode of its own.
    open(showSheet, mode) {
      V.init(); V.requestedMode = ['standalone', 'existing-queue'].includes(mode) ? mode : '';
      if (V.requestedMode) V.creationMode = V.requestedMode;
      else if (V.room) V.creationMode = V.room.mode === 'existing-queue' ? 'existing-queue' : 'standalone';
      V.openSheet = showSheet; shell(); render(); V.refresh();
    }
  };
})();
