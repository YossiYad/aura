function castSdk() {
  const events = new Map();
  const loads = [];
  let active = null;
  let sessionOpen = false;
  let pendingLoad = null;
  const notify = () => active && active.listeners.forEach(fn => fn(true));
  const makeMedia = request => ({
    media: request.media, playerState: request.autoplay ? 'PLAYING' : 'PAUSED',
    currentTime: request.currentTime || 0, currentItemId: 1, items: [{ itemId: 1, media: request.media }],
    volume: { level: 1, muted: false }, listeners: [],
    addUpdateListener(fn) { this.listeners.push(fn); },
    removeUpdateListener(fn) { this.listeners = this.listeners.filter(item => item !== fn); },
    getEstimatedTime() { return this.currentTime; },
    pause(req, ok) { this.playerState = 'PAUSED'; notify(); ok(); },
    play(req, ok) { this.playerState = 'PLAYING'; notify(); ok(); },
    stop(req, ok) { this.playerState = 'IDLE'; this.idleReason = 'CANCELLED'; notify(); ok(); },
    seek(req, ok) { this.currentTime = req.currentTime; notify(); ok(); },
    setVolume(req, ok) { this.volume = req.volume; ok(); },
    queueInsertItems(req, ok) {
      this.items.push(...req.items.map((item, i) => ({ ...item, itemId: Math.max(...this.items.map(item => item.itemId)) + i + 1 })));
      ok();
    },
    queueRemoveItems(req, ok) { this.items = this.items.filter(item => !req.itemIds.includes(item.itemId)); ok(); }
  });
  const session = {
    getMediaSession: () => active,
    getCastDevice: () => ({ friendlyName: 'Living room' }),
    async loadMedia(request) {
      loads.push(request);
      if (pendingLoad) await pendingLoad;
      active = makeMedia(request);
    }
  };
  const context = {
    setOptions(options) { this.options = options; },
    addEventListener(event, fn) { events.set(event, fn); },
    getCurrentSession: () => sessionOpen ? session : null,
    requestSession() { sessionOpen = true; events.get('session')({ sessionState: 'started' }); return Promise.resolve(); },
    endCurrentSession() { sessionOpen = false; events.get('session')({ sessionState: 'ended' }); }
  };
  class MediaInfo { constructor(contentId, contentType) { Object.assign(this, { contentId, contentType }); } }
  const sdk = {
    cast: { framework: { CastContext: { getInstance: () => context },
      CastContextEventType: { SESSION_STATE_CHANGED: 'session' },
      SessionState: { SESSION_STARTED: 'started', SESSION_RESUMED: 'resumed', SESSION_ENDED: 'ended' } } },
    chrome: { cast: {
      AutoJoinPolicy: { PAGE_SCOPED: 'page' },
      Image: class Image { constructor(url) { this.url = url; } },
      Volume: class Volume { constructor(level, muted) { Object.assign(this, { level, muted }); } },
      media: { MediaInfo, MusicTrackMediaMetadata: class {}, SeekRequest: class {},
        StreamType: { BUFFERED: 'BUFFERED' }, DEFAULT_MEDIA_RECEIVER_APP_ID: 'default',
        LoadRequest: class LoadRequest { constructor(media) { this.media = media; } },
        VolumeRequest: class VolumeRequest { constructor(volume) { this.volume = volume; } },
        QueueItem: class QueueItem { constructor(media) { this.media = media; } },
        QueueInsertItemsRequest: class QueueInsertItemsRequest { constructor(items) { this.items = items; } },
        QueueRemoveItemsRequest: class QueueRemoveItemsRequest { constructor(itemIds) { this.itemIds = itemIds; } }
      }
    } }
  };
  return { sdk, loads, context, media: () => active, notify,
    blockLoad: () => { let release; pendingLoad = new Promise(resolve => { release = resolve; }); return () => { pendingLoad = null; release(); }; },
    advance: () => {
      const at = active.items.findIndex(item => item.itemId === active.currentItemId);
      const next = active.items[at + 1];
      if (!next) { active.playerState = 'IDLE'; active.idleReason = 'FINISHED'; notify(); return; }
      active.currentItemId = next.itemId; active.media = next.media; active.currentTime = 0; active.playerState = 'PLAYING'; notify();
    }
  };
}
module.exports = { castSdk };
