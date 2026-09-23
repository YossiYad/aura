(function () {
  const tr = value => window.I18n ? window.I18n.t(value) : value;
  if (window.I18n) I18n.initGuest();
  const $ = id => document.getElementById(id);
  const invite = location.hash.slice(1);
  const languagePicker = $('guest-language');
  if (languagePicker && window.I18n) {
    languagePicker.value = I18n.language();
    languagePicker.onchange = () => {
      const url = new URL(location.href);
      url.searchParams.set('lang', languagePicker.value);
      // The URL keeps the choice across reloads without writing the host's preferences.
      // The invitation fragment and the server-managed guest session are preserved.
      location.replace(url.href);
    };
  }
  let room = null, stopped = false, busy = false, polling = false, revision = 0;
  let tracks = [], searchTimer, searchController, searchRevision = 0, searchQuery = '', noticeTimer;
  let page = null, lastRequestsHtml = '', lastApprovedHtml = '';
  const icon = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  const plus = icon('<path d="M12 5v14M5 12h14"/>'), check = icon('<path d="m5 12 4 4L19 6"/>');
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function closeMenu() { $('navigation').close(); $('menu-toggle').setAttribute('aria-expanded', 'false'); }
  function showPage(next, focus = false) {
    page = next === 'search' && room && room.permission !== 'vote' ? 'search' : 'home';
    $('search-area').hidden = page !== 'search'; $('page-home').hidden = page !== 'home';
    ['home', 'search'].forEach(name => {
      if (name === page) $('nav-' + name).setAttribute('aria-current', 'page');
      else $('nav-' + name).removeAttribute('aria-current');
    });
    if (focus) { closeMenu(); $(page + '-heading').focus(); window.scrollTo({ top: 0 }); }
  }
  $('menu-toggle').onclick = () => { $('navigation').showModal(); $('menu-toggle').setAttribute('aria-expanded', 'true'); };
  $('menu-close').onclick = closeMenu;
  $('navigation').addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
  $('navigation').addEventListener('close', () => $('menu-toggle').setAttribute('aria-expanded', 'false'));
  $('navigation').onclick = event => {
    const button = event.target.closest('[data-page]');
    if (button) showPage(button.dataset.page, true);
    else if (event.target === $('navigation')) {
      const bounds = $('navigation').getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu();
    }
  };
  $('home-search').onclick = () => showPage('search', true);
  function message(value, error = false) {
    clearTimeout(noticeTimer);
    $('message').textContent = value; $('message').classList.toggle('error', error);
    if (value && !error && room && room.joined) noticeTimer = setTimeout(() => { $('message').textContent = ''; }, 6000);
  }
  function cancelSearch() {
    clearTimeout(searchTimer); searchRevision++;
    if (searchController) searchController.abort();
    searchController = null;
    $('results').setAttribute('aria-busy', 'false');
  }
  function close(messageText) {
    stopped = true; $('join').hidden = true; $('joined').hidden = true; $('waiting').hidden = true;
    cancelSearch(); closeMenu(); $('menu-toggle').hidden = true; document.body.classList.remove('joined');
    $('description').textContent = tr('כדי להצטרף לתור חדש, סרקו QR חדש מהמארחים.');
    message(messageText, true);
  }
  async function request(action, body, signal) {
    let response, value;
    try {
      response = await fetch('/guest/api/' + action, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Queue-Invite': invite, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal: signal || AbortSignal.timeout(15000) });
      value = await response.json();
    } catch (error) {
      // A failed fetch and a gateway's HTML error page both carry a browser's English text.
      if (error && error.name === 'AbortError') throw error;
      throw Error(tr('אין חיבור כרגע. נסו שוב.'));
    }
    if (response.status === 410) close(tr(value.error));
    if (response.status === 401) { room = null; cancelSearch(); closeMenu(); $('menu-toggle').hidden = true; document.body.classList.remove('joined'); $('joined').hidden = true; $('waiting').hidden = true; $('join').hidden = false; }
    if (!response.ok) throw Error(tr(value.error) || tr('הבקשה לא הצליחה. נסו שוב.'));
    return value;
  }
  function info(track) {
    return '<div class="track-info"><div class="track-title" dir="auto">' + escape(track.title) +
      '</div><div class="track-artist" dir="auto">' + escape(track.artist) + '</div>';
  }
  function artwork(track) {
    const seconds = Math.max(0, Math.floor(Number(track.duration) || 0));
    const duration = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    // Construct artwork only from the validated video ID, never from search HTML or URLs.
    const image = /^[A-Za-z0-9_-]{11}$/.test(track.id) ? '<img src="https://i.ytimg.com/vi/' + escape(track.id) + '/mqdefault.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
    return '<div class="dr-thumb" aria-hidden="true">' + icon('<path d="M9 18V5l11-2v13M9 8l11-2"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>') + image +
      (seconds ? '<span class="duration" dir="ltr">' + duration + '</span>' : '') + '</div>';
  }
  function updateResultButtons() {
    if (!room || !room.joined) return;
    $('results').querySelectorAll('[data-suggest]').forEach(button => {
      const item = room.requests.find(item => item.track.id === button.dataset.suggest && item.status !== 'rejected');
      const label = item ? (item.status === 'approved' ? tr('נוסף לתור') : tr('נשלחה בקשה')) : (room.permission === 'direct' ? tr('הוסף') : tr('בקש להוסיף'));
      const html = (item ? check : plus) + '<span>' + label + '</span>';
      if (button.innerHTML !== html) button.innerHTML = html;
      button.classList.toggle('added', !!item);
      button.disabled = !!item || busy || room.permission === 'vote';
      const track = tracks.find(track => track.id === button.dataset.suggest);
      button.setAttribute('aria-label', label + ': ' + (track ? track.title : ''));
    });
  }
  function render(value) {
    const wasWaiting = room && room.joinStatus === 'pending';
    room = value;
    $('title').textContent = room.title;
    $('expiry').textContent = tr('פתוח עד ') + new Date(room.expiresAt).toLocaleString(window.I18n ? I18n.locale() : 'he-IL', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' });
    const waiting = room.joinStatus === 'pending', rejected = room.joinStatus === 'rejected';
    $('join').hidden = room.joined || waiting || rejected; $('joined').hidden = !room.joined;
    document.body.classList.toggle('joined', !!room.joined);
    $('menu-toggle').hidden = !room.joined;
    $('navigation-room').textContent = room.title;
    $('waiting').hidden = !waiting && !rejected;
    if (waiting || rejected) {
      $('waiting-title').textContent = waiting ? tr('הבקשה נשלחה, ') + room.name : tr('בקשת ההצטרפות לא אושרה');
      $('waiting-description').textContent = waiting ? tr('ממתינים לאישור המארחים. המסך יתעדכן אוטומטית כשיאשרו אותך.') : tr('אפשר לפנות למארחים כדי לברר לגבי ההצטרפות.');
      $('results-section').hidden = true;
    }
    if (wasWaiting && room.joined) message(tr('ההצטרפות אושרה. אפשר להתחיל לבחור שירים.'));
    if (!room.joined) { cancelSearch(); closeMenu(); page = null; return; }
    $('welcome').textContent = tr('היי ') + room.name;
    $('permission').textContent = { approval: tr('הצעות באישור המארחים'), direct: tr('הוספה חופשית לתור'), vote: tr('צפייה והצבעה') }[room.permission];
    $('search').hidden = room.permission === 'vote';
    $('nav-search').hidden = room.permission === 'vote';
    $('home-search').hidden = room.permission === 'vote';
    $('home-hint').textContent = room.permission === 'vote' ? tr('אפשר להצביע להצעות שאהבתם. הוספת שירים זמינה לפי הרשאת המארחים.') : room.permission === 'direct' ? tr('אפשר להוסיף שירים ישירות לתור וגם להצביע להצעות של כולם.') : tr('אפשר לבקש להוסיף שירים ולהצביע להצעות. המארחים מאשרים מה נכנס לתור.');
    showPage(page || (room.permission === 'vote' ? 'home' : 'search'));
    $('search-hint').textContent = room.permission === 'direct' ? tr('הוסיפו שירים לתור. המוזיקה מתנגנת אצל המארחים.') : tr('בחרו שירים ושלחו בקשה להוספה. המארחים יאשרו אותם לפני הנגינה.');
    if (room.permission === 'vote') {
      cancelSearch(); tracks = []; searchQuery = ''; $('results').replaceChildren();
      $('results-section').hidden = true; $('search-empty').hidden = false; $('search-status').textContent = '';
    }
    updateResultButtons();
    const pending = room.requests.filter(item => item.status === 'pending');
    const approved = room.requests.filter(item => item.status === 'approved');
    $('approved-section').hidden = !approved.length;
    $('approved-count').textContent = approved.length + tr(' שירים');
    const approvedHtml = approved.map(item => '<li class="music-card">' + artwork(item.track) + info(item.track) +
      '<div class="track-detail" dir="auto">' + escape(item.fromHost === true ? tr('המארחים') : item.name) + '</div></div></li>').join('');
    if (lastApprovedHtml !== approvedHtml) { $('approved-tracks').innerHTML = approvedHtml; lastApprovedHtml = approvedHtml; }
    const items = pending.concat(room.requests.filter(item => item.status === 'rejected'));
    $('pending-count').textContent = pending.length + tr(' ממתינות לאישור');
    const html = items.map(item => '<li>' + artwork(item.track) + info(item.track) +
      '<div class="track-detail" dir="auto">' + escape(item.fromHost === true ? tr('המארחים') : item.name) + (item.mine ? tr(' · ההצעה שלך') : '') + '</div></div>' +
      (item.status === 'pending' ? '<button type="button" data-vote="' + escape(item.id) + '" aria-pressed="' + item.voted +
        '" aria-label="' + (item.voted ? tr('ביטול הצבעה ל') : tr('הצבעה ל')) + escape(item.track.title) + '">♡ ' + item.votes + '</button>' :
        '<span class="status ' + item.status + '">' + (item.status === 'approved' ? tr('אושרה') : tr('לא נבחרה הפעם')) + '</span>') + '</li>').join('');
    // Avoid replacing focused vote buttons on unchanged polling responses.
    if (lastRequestsHtml !== html) { $('requests').innerHTML = html; lastRequestsHtml = html; }
    $('empty').hidden = !!items.length;
    $('empty').textContent = room.permission === 'vote' ? tr('אין כרגע הצעות שממתינות להצבעה.') : approved.length ? tr('כל ההצעות אושרו. אפשר לבחור עוד שירים.') : tr('התור מחכה להצעה הראשונה שלך.');
  }
  async function action(button, run) {
    if (busy || stopped) return;
    busy = true; revision++; button.disabled = true;
    try { await run(); } catch (error) { if (!stopped) message(error.message || tr('אין חיבור כרגע. נסו שוב.'), true); }
    finally { busy = false; button.disabled = false; updateResultButtons(); }
  }
  $('join').onsubmit = event => {
    event.preventDefault();
    action($('join').querySelector('button'), async () => { const result = await request('join', { name: $('name').value }); render(result.room); message(room.joined ? tr('הצטרפת ל־AuraShare.') : ''); });
  };
  async function search(force = false) {
    clearTimeout(searchTimer);
    const query = $('query').value.trim();
    if (stopped || !room || !room.joined || room.permission === 'vote' || query.length < 2 || (query === searchQuery && (!force || searchController))) return;
    cancelSearch(); const current = searchRevision;
    searchQuery = query; searchController = new AbortController();
    const timeout = setTimeout(() => searchController && current === searchRevision && searchController.abort(), 15000);
    $('search-empty').hidden = true; $('results-section').hidden = true;
    $('search-status').textContent = tr('מחפשים שירים…'); $('results').setAttribute('aria-busy', 'true');
    try {
      const result = await request('search', { query }, searchController.signal);
      if (current !== searchRevision || stopped || !room || !room.joined || room.permission === 'vote') return;
      tracks = result.tracks;
      $('results').innerHTML = tracks.map(track => '<li class="dr">' + artwork(track) + info(track) + '</div><button class="add-btn" type="button" data-suggest="' + escape(track.id) + '"></button></li>').join('');
      $('results-section').hidden = !tracks.length;
      $('results-count').textContent = tracks.length + tr(' תוצאות');
      $('search-status').textContent = tracks.length ? '' : tr('לא נמצאו שירים. נסו שם אחר של שיר או אמן.');
      updateResultButtons();
    } catch (error) {
      if (current !== searchRevision || stopped) return;
      searchQuery = '';
      $('search-status').textContent = error.name === 'AbortError' ? tr('החיפוש לקח יותר מדי זמן. נסו שוב.') : (error.message || tr('לא הצלחנו לחפש. נסו שוב.'));
    } finally {
      clearTimeout(timeout);
      if (current === searchRevision) { searchController = null; $('results').setAttribute('aria-busy', 'false'); }
    }
  }
  $('search').onsubmit = event => { event.preventDefault(); search(true); };
  $('query').oninput = () => {
    cancelSearch(); searchQuery = ''; tracks = [];
    const query = $('query').value.trim();
    $('search-clear').hidden = !$('query').value;
    $('results').replaceChildren(); $('results-section').hidden = true;
    $('search-empty').hidden = query.length >= 2;
    $('search-status').textContent = query.length === 1 ? tr('הקלידו לפחות שני תווים לחיפוש.') : '';
    if (query.length >= 2) searchTimer = setTimeout(search, 450);
  };
  $('search-clear').onclick = () => { $('query').value = ''; $('query').oninput(); $('query').focus(); };
  $('joined').addEventListener('error', event => {
    if (event.target.tagName === 'IMG') event.target.remove();
  }, true);
  $('results').onclick = event => {
    const button = event.target.closest('[data-suggest]'); if (!button) return;
    action(button, async () => { const result = await request('suggest', { trackId: button.dataset.suggest }); render(result.room);
      message(room.permission === 'direct' ? tr('השיר אושר אוטומטית ויתווסף במכשיר המארחים כשהוא מחובר.') : tr('הבקשה נשלחה למארחים.')); });
  };
  $('requests').onclick = event => {
    const button = event.target.closest('[data-vote]'); if (!button) return;
    action(button, async () => { const result = await request('vote', { id: button.dataset.vote, voted: button.getAttribute('aria-pressed') !== 'true' }); render(result.room); message(tr('ההצבעה עודכנה.')); });
  };
  async function poll(initial = false) {
    if (stopped || busy || polling || document.hidden) return;
    polling = true; const startedAt = revision;
    try {
      const result = await request('state');
      if (!busy && startedAt === revision) { render(result.room); if (initial || $('message').dataset.connectionError) { message(''); delete $('message').dataset.connectionError; } }
    } catch (error) {
      if (!stopped) { message(tr('החיבור נקטע. ננסה להתחבר שוב אוטומטית.'), true); $('message').dataset.connectionError = 'true'; }
    } finally { polling = false; }
  }
  if (!/^[A-Za-z0-9_-]{32}$/.test(invite)) { close(tr('הקישור אינו תקין. בקשו מהמארחים לסרוק QR חדש.')); return; }
  poll(true);
  setInterval(() => poll(), 8000);
  document.addEventListener('visibilitychange', () => poll());
})();
