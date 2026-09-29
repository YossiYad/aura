(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  // AuraShare on the host's phone, in several files: this one holds the room state and the
  // requests to the server, and src/shared-queue/ holds the notices and the sheet, loaded
  // after it in the order index.html lists them. Each file is its own closure; what one
  // file needs from another it reaches through V, window.Aura.sharedQueue. The public face,
  // window.SharedQueue, is put together in the last file.
  /** @type {AuraNamespace} */
  const V = (window.Aura = window.Aura || /** @type {typeof Aura} */ ({})).sharedQueue = {};
  // Published on V for the other files of this module; see src/shared-queue.js.
  Object.defineProperties(V, {
    $: { get: () => $ },
    adopt: { get: () => adopt },
    available: { get: () => available },
    creationMode: { get: () => creationMode, set: value => { creationMode = value; } },
    deliver: { get: () => deliver },
    error: { get: () => error },
    esc: { get: () => esc },
    init: { get: () => init },
    joinPermissions: { get: () => joinPermissions },
    labels: { get: () => labels },
    lastError: { get: () => lastError },
    openSheet: { get: () => openSheet, set: value => { openSheet = value; } },
    options: { get: () => options },
    refresh: { get: () => refresh },
    request: { get: () => request },
    requestedMode: { get: () => requestedMode, set: value => { requestedMode = value; } },
    room: { get: () => room },
    schedule: { get: () => schedule },
    serial: { get: () => serial },
    setHtml: { get: () => setHtml }
  });
  let available = false, room = null, device = '', timer = 0, initialized = false;
  let tail = Promise.resolve(), lastError = '', peekedError = '', openSheet = null, creationMode = 'standalone', requestedMode = '';
  const delivered = new Set();
  const joinPermissions = new Map();
  const labels = { approval: 'כל שיר באישור', direct: 'הוספה חופשית', vote: 'צפייה והצבעה' };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const $ = id => document.getElementById(id);
  function serial(run) { const work = tail.catch(() => {}).then(run); tail = work; return work; }
  // Older WebKit has no AbortSignal.timeout; the request then runs without a limit.
  function timeLimit(ms) { try { return AbortSignal.timeout(ms); } catch { return undefined; } }
  async function request(path = '', method = 'GET', body) {
    const response = await fetch('/api/queue/' + path, { method, cache: 'no-store', redirect: 'error',
      headers: { 'X-Queue-Device': device, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: timeLimit(15000) });
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
    if (room && message !== peekedError) { peekedError = message; V.peekNotice(); }
    V.renderNotices();
  }
  function adopt(result) {
    const previous = room;
    if (result.room && (!previous || result.room.id !== previous.id)) {
      V.activity = []; V.activityKeys.clear(); joinPermissions.clear(); V.noticesExpanded = false; V.noticePeek = false;
      peekedError = '';
      clearTimeout(V.noticeTimer);
    }
    room = result.room; available = true; lastError = '';
    V.observeActivity(previous);
    if (!room) { clearTimeout(V.noticeTimer); V.noticePeek = false; V.noticesExpanded = false; }
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
        V.addActivity((item.fromHost === true ? tr('המארחים') : item.name || tr('אורח/ת')) + (alreadyQueued ? tr(' בחר/ה שיר שכבר נמצא בתור: ') : tr(' הוסיף/ה לתור: ')) + item.track.title, 'delivered:' + item.id);
      }
      // Approval is retained on the server until delivery is acknowledged. A failed
      // response can be retried without adding the same suggestion twice on this tab.
      await request(room.id + '/requests/' + item.id + '/ack', 'POST', {});
      item.deliver = false; item.delivered = true;
    }
  }
  function refresh() {
    return serial(async () => {
      try { adopt(await request()); await deliver(); V.render(); }
      catch (err) { error(err.message || tr('החיבור נקטע. ננסה שוב.')); }
      finally { V.renderNotices(); schedule(); }
    });
  }
  if (window.addEventListener) window.addEventListener('aura-language', () => {
    // Activity is a transient announcement log; pending requests remain in room state.
    V.activity = []; lastError = ''; peekedError = '';
    if ($('shared-queue-panel')) V.shell();
    V.render();
  });
  function init() {
    if (initialized) return;
    initialized = true;
    device = Store.sharedQueueDevice();
    Player.onChange(event => {
      if (['queue', 'track', 'state', 'playback-permission', 'queue-end'].includes(event.type)) V.renderPlayback();
    });
    refresh();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && room) refresh(); });
  }
})();
