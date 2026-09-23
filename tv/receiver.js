(function () {
  const $ = id => document.getElementById(id);
  const fallbackArt = '../icon.svg';
  let player = null, scrubbing = false, queueKey = '', receiverError = '';
  // Playback must not depend on the drawing: a TV that could not load the wave still plays.
  const progress = window.SongProgress ? SongProgress.create($('progress')) : { set() {} };
  const seconds = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function time(value) {
    const s = Math.floor(seconds(value));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function publicArt(metadata) {
    return ((metadata.images || []).find(image => /^https?:\/\//i.test(image.url || '')) || {}).url || fallbackArt;
  }
  function setArt(img, url) {
    if (img.dataset.artSource === url) return;
    img.dataset.artSource = url;
    img.onerror = () => { img.onerror = null; img.src = fallbackArt; };
    img.src = url;
  }
  function showQueue(open) {
    $('queue-panel').hidden = !open;
    $('queue-toggle').setAttribute('aria-expanded', String(open));
    (open ? $('queue-close') : $('queue-toggle')).focus();
  }
  $('queue-toggle').onclick = () => showQueue($('queue-panel').hidden);
  $('queue-close').onclick = () => showQueue(false);
  $('theme').onclick = () => {
    const dark = document.body.classList.toggle('dark');
    $('theme').setAttribute('aria-pressed', String(dark));
  };
  document.addEventListener('keydown', event => {
    if (['Escape', 'BrowserBack', 'GoBack'].includes(event.key) && !$('queue-panel').hidden) {
      event.preventDefault(); showQueue(false); return;
    }
    if (['Enter', 'Select'].includes(event.key) && document.activeElement.tagName === 'BUTTON') {
      event.preventDefault();
      if (!event.repeat) document.activeElement.click();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    // Left/right seek; up/down must still let a remote user leave the slider.
    if (event.target === $('seek') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (!$('queue-panel').hidden && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      $('queue-panel').scrollBy(0, event.key === 'ArrowUp' ? -120 : 120);
      event.preventDefault(); return;
    }
    const scope = $('queue-panel').hidden ? document : $('queue-panel');
    const controls = Array.from(scope.querySelectorAll('button:not(:disabled), input:not(:disabled)'))
      .filter(el => el.getClientRects().length);
    if (!controls.length) return;
    const next = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const at = controls.indexOf(document.activeElement);
    controls[at < 0 ? 0 : (at + next + controls.length) % controls.length].focus();
    event.preventDefault();
  });

  function renderQueue(active) {
    const queue = player.getQueueManager();
    const items = queue ? queue.getItems() : [];
    const current = queue ? queue.getCurrentItemIndex() : -1;
    $('previous').disabled = !active || current <= 0;
    $('next').disabled = !active || current < 0 || current >= items.length - 1;
    const key = JSON.stringify([current, items.map(item => [item.itemId, item.media && item.media.metadata])]);
    if (key === queueKey) return;
    queueKey = key;
    $('queue').replaceChildren();
    $('queue-empty').hidden = items.length > 0;
    items.forEach((item, index) => {
      const metadata = (item.media || {}).metadata || {};
      const row = document.createElement('li');
      if (index === current) { row.className = 'current'; row.setAttribute('aria-current', 'true'); }
      const img = document.createElement('img'); img.alt = ''; setArt(img, publicArt(metadata));
      const text = document.createElement('div');
      const title = document.createElement('span'); title.dir = 'auto'; title.textContent = metadata.title || 'Untitled track';
      const artist = document.createElement('small'); artist.dir = 'auto'; artist.textContent = metadata.artist || '';
      text.append(title, artist); row.append(img, text); $('queue').appendChild(row);
    });
  }
  function render() {
    const media = player.getMediaInformation();
    const metadata = media && media.metadata || {};
    const state = player.getPlayerState();
    const active = !!media && state !== 'IDLE';
    const playing = state === 'PLAYING' || state === 'BUFFERING';
    document.body.classList.toggle('connected', active);
    $('connection').textContent = active ? 'Playing on this TV' : 'Ready to connect';
    $('title').textContent = active ? metadata.title || 'Untitled track' : 'Your music. A bigger stage.';
    $('artist').textContent = active ? metadata.artist || '' : 'Choose a song in Aura to get started';
    $('album').textContent = active ? metadata.albumName || 'AURA ON TV' : 'AURA ON TV';
    setArt($('art'), active ? publicArt(metadata) : fallbackArt);
    $('play').disabled = !active;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('play-icon').setAttribute('d', playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M8 5v14l11-7z');
    const duration = seconds(player.getDurationSec());
    const elapsed = Math.min(seconds(player.getCurrentTimeSec()), duration || Infinity);
    $('seek').disabled = !active || !duration;
    if (!scrubbing) {
      $('seek').value = duration ? Math.round(elapsed / duration * 1000) : 0;
      progress.set(duration ? elapsed / duration * 100 : 0);
    }
    $('elapsed').textContent = time(elapsed);
    $('remaining').textContent = '−' + time(duration - elapsed);
    $('status').textContent = receiverError || (state === 'BUFFERING' ? 'Buffering…' : state === 'PAUSED' ? 'Paused' :
      active ? '' : 'Connect from the three-dot menu on your phone');
    renderQueue(active);
  }
  function command(action) {
    try { action(); }
    catch (e) { receiverError = 'Could not complete that command. Try again from your phone.'; render(); }
  }
  function jump(amount) {
    const request = new cast.framework.messages.QueueUpdateRequestData();
    request.jump = amount;
    player.sendLocalMediaRequest(request);
  }
  $('play').onclick = () => command(() => {
    if (player.getPlayerState() === 'PLAYING' || player.getPlayerState() === 'BUFFERING') player.pause();
    else player.play();
  });
  $('previous').onclick = () => command(() => jump(-1));
  $('next').onclick = () => command(() => jump(1));
  $('seek').oninput = () => { scrubbing = true; progress.set($('seek').value / 10); };
  $('seek').onchange = () => {
    scrubbing = false;
    command(() => player.seek(seconds(player.getDurationSec()) * Number($('seek').value) / 1000));
  };
  $('seek').onblur = () => { scrubbing = false; };

  if (!window.cast || !cast.framework || !cast.framework.CastReceiverContext) {
    $('status').textContent = 'Open Aura on your phone and connect to a Cast-enabled TV';
    return;
  }
  try {
    const context = cast.framework.CastReceiverContext.getInstance();
    player = context.getPlayerManager();
    const events = cast.framework.events.EventType;
    [events.MEDIA_STATUS, events.TIME_UPDATE].forEach(event => player.addEventListener(event, render));
    player.addEventListener(events.LOADED_METADATA, () => { receiverError = ''; render(); });
    player.addEventListener(events.ERROR, () => {
      receiverError = 'This song could not play. Choose another song on your phone.';
      render();
    });
    const commands = cast.framework.messages.Command;
    context.start({ supportedCommands: commands.PAUSE | commands.SEEK | commands.STREAM_VOLUME |
      commands.STREAM_MUTE | commands.QUEUE_NEXT | commands.QUEUE_PREV });
    render();
  } catch (e) {
    $('status').textContent = 'TV playback could not start. Disconnect and try connecting again.';
  }
})();
