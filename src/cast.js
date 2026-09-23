(function () {
  // The Cast receiver gets its own media description and public artwork URLs.
  // Expose the small media-element surface the queue player already uses.
  let context = null;
  let initialization = null;
  let receiverApplicationId = "";
  let session = null;
  let media = null;
  let revision = 0;
  let loadedRevision = -1;
  let loadChain = Promise.resolve();
  let observedId = null;
  let clock = null;
  const listeners = [];
  const emit = event => listeners.forEach(fn => { try { fn(event); } catch (e) {} });
  // Stands in for the <audio> element while casting: the player drives it with the same
  // calls, properties and events, and it passes them on to the TV. It is built up property
  // by property below, so it is typed loosely.
  const audio = /** @type {any} */ (new EventTarget());
  audio.isCast = true;
  audio.remote = new EventTarget();
  audio.remote.state = "disconnected";
  audio.mediaTrack = null;
  audio.mediaMime = "";
  audio.error = null;
  audio.buffered = { length: 0 };
  let source = "", position = 0, paused = true, ended = false, ready = 0;
  let desiredVolume = 1, muted = false;
  let loading = null;
  let queueRevision = 0;
  let queueChain = Promise.resolve();
  const fire = type => audio.dispatchEvent(new Event(type));
  const fail = error => emit({ type: "error", message: "The TV did not accept the playback command. Try again.", error });
  const validMedia = () => loadedRevision === revision && media && media.media && media.media.contentId === source;

  /**
   * @param {Track} track
   * @returns {string[]} Public cover URLs the TV can load, largest first.
   */
  function artwork(track) {
    const urls = [String(track.thumb || "").replace("mqdefault.jpg", "hqdefault.jpg"),
      "https://i.ytimg.com/vi/" + encodeURIComponent(track.id) + "/hqdefault.jpg"];
    return Array.from(new Set(urls.filter(url => /^https?:\/\//i.test(url || ""))));
  }

  /**
   * Describes a track for the Cast receiver.
   * @param {Track} track
   * @param {string} url An http(s) address the TV can fetch.
   * @param {string} [mime] Default "audio/mpeg".
   * @returns {Object} A chrome.cast.media.MediaInfo.
   */
  function mediaInfo(track, url, mime) {
    if (!/^https?:\/\//i.test(url)) throw new Error("TV playback needs an HTTP media URL");
    const info = new chrome.cast.media.MediaInfo(url, mime || "audio/mpeg");
    const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
    metadata.title = track.title || "";
    metadata.artist = track.artist || "";
    metadata.albumName = track.album || "Aura";
    metadata.images = artwork(track).map(url => new chrome.cast.Image(url));
    info.metadata = metadata;
    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    if (track.duration > 0) info.duration = track.duration;
    info.customData = { auraTrackId: track.id };
    return info;
  }

  /**
   * Sends a command to the TV's media session.
   * @param {string} method
   * @param {*} request
   * @returns {Promise<void>}
   */
  function command(method, request) {
    const target = media;
    if (!target) return Promise.reject(new Error("No TV media session"));
    return new Promise((resolve, reject) => target[method](request, resolve, reject));
  }

  function update(alive) {
    if (!media) return;
    const state = media.playerState;
    const id = media.media && media.media.customData && media.media.customData.auraTrackId;
    if (id && id !== observedId && !loading && state !== "IDLE") {
      observedId = id;
      source = media.media.contentId;
      ended = false;
      audio.mediaMime = media.media.contentType;
      emit({ type: "track", id });
    }
    if (!validMedia()) return;
    if (state === "IDLE" && (media.loadingItemId != null || media.preloadedItemId != null)) return;
    position = media.getEstimatedTime ? media.getEstimatedTime() : media.currentTime || 0;
    const wasPaused = paused;
    paused = state !== "PLAYING" && state !== "BUFFERING";
    const finished = state === "IDLE" && media.idleReason === "FINISHED";
    // A finished item reports its end once. Its later statuses (a seek to zero for a
    // replay answered on the idle session) are not playback, and a timeupdate from
    // them re-ran the end handling in a loop.
    if (finished) { if (!ended) { ended = true; fire("ended"); } return; }
    if (alive === false || (state === "IDLE" && media.idleReason === "ERROR")) {
      if (!loading) { audio.error = { code: 2 }; fire("error"); }
      return;
    }
    ready = 4;
    if (wasPaused !== paused) fire(paused ? "pause" : "play");
    if (state === "PLAYING") fire("playing");
    else if (state === "BUFFERING") fire("waiting");
    fire("timeupdate");
  }

  function bindMedia() {
    const next = session && session.getMediaSession();
    if (!next || next === media) return;
    if (media && media.removeUpdateListener) media.removeUpdateListener(update);
    media = next;
    media.addUpdateListener(update);
  }

  async function load(autoplay) {
    if (loading) return loading;
    if (!session || !source || !audio.mediaTrack) throw new Error("TV is not connected");
    const token = revision;
    const targetSession = session;
    // A reload of a finished item starts it over. Left set, "ended" made the first
    // status after the reload finish the song again: repeat-one reloaded without end,
    // and the last song of a queue could not be played again from the phone.
    if (ended) { ended = false; position = 0; }
    const request = new chrome.cast.media.LoadRequest(mediaInfo(audio.mediaTrack, source, audio.mediaMime));
    request.autoplay = autoplay;
    request.currentTime = position;
    request.playbackRate = 1;
    observedId = audio.mediaTrack.id;
    const promise = loadChain.catch(() => {}).then(async () => {
      if (token !== revision || session !== targetSession) return;
      await targetSession.loadMedia(request);
      if (token !== revision || session !== targetSession) return;
      loadedRevision = token;
      bindMedia();
      ready = 4;
      audio.volume = desiredVolume;
      fire("loadedmetadata");
      update(true);
    });
    loadChain = promise;
    loading = promise;
    try { await promise; }
    finally { if (loading === promise) loading = null; }
  }

  Object.defineProperties(audio, {
    src: { get: () => source, set: value => {
      revision++; queueRevision++; loading = null; source = value; position = 0; paused = true; ended = false; ready = 0; audio.error = null;
      fire("loadstart");
    } },
    currentTime: { get: () => validMedia() && !loading && media.getEstimatedTime ? media.getEstimatedTime() : position,
      set: value => {
        position = Math.max(0, Number(value) || 0);
        if (validMedia() && !loading) {
          const request = new chrome.cast.media.SeekRequest();
          request.currentTime = position;
          command("seek", request).catch(fail);
        }
      } },
    duration: { get: () => validMedia() ? media.media.duration || (audio.mediaTrack || {}).duration || 0 : (audio.mediaTrack || {}).duration || 0 },
    paused: { get: () => paused }, ended: { get: () => ended }, readyState: { get: () => ready },
    volume: { get: () => desiredVolume, set: value => {
      desiredVolume = value;
      if (validMedia()) {
        const request = new chrome.cast.media.VolumeRequest(new chrome.cast.Volume(value, muted));
        command("setVolume", request).catch(fail);
      }
    } },
    muted: { get: () => muted, set: value => { muted = !!value; } },
    playbackRate: { get: () => 1, set: () => {} }
  });
  audio.setAttribute = () => {};
  audio.removeAttribute = name => { if (name === "src") { audio.src = ""; stop(); } };
  audio.load = () => {};
  audio.play = async () => {
    // A load already in flight may be the paused one a connection starts with; handing
    // it back as the answer to Play would leave the TV paused until a second tap.
    if (loading) await loading;
    // A receiver stopped from the TV side sits idle with the media unloaded; it
    // refuses a play command, so the song is loaded again instead.
    const idle = validMedia() && media.playerState === "IDLE" &&
      media.loadingItemId == null && media.preloadedItemId == null;
    if (!validMedia() || ended || idle) return load(true);
    if (paused) await command("play", null);
    update(true);
  };
  audio.pause = () => {
    if (paused) return;
    paused = true;
    if (validMedia()) command("pause", null).catch(fail);
    fire("pause");
  };
  audio.loadPaused = () => load(false);

  /** Stops what the TV is playing. */
  function stop() {
    revision++;
    queueRevision++;
    loading = null;
    paused = true;
    ready = 0;
    const token = revision;
    loadChain.catch(() => {}).then(() => {
      if (token !== revision || !session) return;
      bindMedia();
      if (media) command("stop", null).catch(() => {});
    });
  }

  /**
   * @returns {boolean} Whether a Cast session is running.
   */
  function connected() { return !!session && audio.remote.state === "connected"; }

  /**
   * Replaces what the TV plays after the current track.
   * @param {Track | null} track Null only clears the upcoming items.
   * @param {string} [url]
   * @param {string} [mime]
   * @returns {Promise<void>}
   */
  function setNext(track, url, mime) {
    const token = ++queueRevision;
    const sourceRevision = revision;
    const target = media;
    queueChain = queueChain.catch(() => {}).then(async () => {
      const current = () => token === queueRevision && sourceRevision === revision && media === target && connected();
      if (!current() || !validMedia()) return;
      const items = target.items || [];
      const at = items.findIndex(item => item.itemId === target.currentItemId);
      const upcoming = at < 0 ? [] : items.slice(at + 1).map(item => item.itemId);
      if (upcoming.length) {
        await command("queueRemoveItems", new chrome.cast.media.QueueRemoveItemsRequest(upcoming));
      }
      if (!current() || !track) return;
      const item = new chrome.cast.media.QueueItem(mediaInfo(track, url, mime));
      item.autoplay = true;
      item.preloadTime = 8;
      await command("queueInsertItems", new chrome.cast.media.QueueInsertItemsRequest([item]));
    }).catch(error => { if (token === queueRevision) fail(error); });
    return queueChain;
  }

  /**
   * @param {{ track: Track, info: StreamInfo }[]} entries
   * @returns {Promise<void>}
   */
  function appendUpcoming(entries) {
    const token = queueRevision;
    const sourceRevision = revision;
    queueChain = queueChain.catch(() => {}).then(async () => {
      if (!entries.length || token !== queueRevision || sourceRevision !== revision || !connected() || !validMedia()) return;
      const items = entries.map(entry => {
        const item = new chrome.cast.media.QueueItem(mediaInfo(entry.track, entry.info.url, entry.info.mime));
        item.autoplay = true;
        item.preloadTime = 8;
        return item;
      });
      await command("queueInsertItems", new chrome.cast.media.QueueInsertItemsRequest(items));
    }).catch(error => { if (token === queueRevision) fail(error); });
    return queueChain;
  }

  /**
   * Loads the Cast SDK and sets up the session, once.
   * @returns {Promise<boolean>} False when Cast is not available in this browser.
   */
  function initialize() {
    if (context) return Promise.resolve(true);
    if (initialization) return initialization;
    initialization = Promise.resolve().then(async () => {
      const config = window.Api && Api.siteConfig ? await Api.siteConfig() : {};
      const configured = String(config.castReceiverAppId || "").trim();
      receiverApplicationId = /^[A-F0-9]{8}$/i.test(configured) ? configured.toUpperCase() : "";
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { initialization = null; reject(new Error("Cast could not load")); }, 12000);
        const available = ok => {
          clearTimeout(timer);
          if (!ok || !window.cast || !window.chrome || !chrome.cast) {
            initialization = null; resolve(false); return;
          }
          // A retry after the load timeout appends the SDK a second time, and each copy
          // reports in; a second registration would run every connection twice.
          if (context) { resolve(true); return; }
          context = cast.framework.CastContext.getInstance();
          context.setOptions({ receiverApplicationId: receiverApplicationId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.PAGE_SCOPED, resumeSavedSession: false });
          context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, event => {
            const state = event.sessionState;
            if (state === cast.framework.SessionState.SESSION_STARTED || state === cast.framework.SessionState.SESSION_RESUMED) {
              session = context.getCurrentSession();
              audio.remote.state = "connected";
              clearInterval(clock);
              clock = setInterval(() => { if (connected() && validMedia() && !paused) fire("timeupdate"); }, 1000);
              emit({ type: "connected" });
            } else if (state === cast.framework.SessionState.SESSION_ENDED) {
              const at = audio.currentTime;
              revision++; loading = null; session = null;
              if (media && media.removeUpdateListener) media.removeUpdateListener(update);
              media = null; paused = true; ready = 0;
              clearInterval(clock);
              audio.remote.state = "disconnected";
              emit({ type: "disconnected", position: at });
            }
          });
          resolve(true);
        };
        if (window.cast && cast.framework && window.chrome && chrome.cast) { available(true); return; }
        window.__onGCastApiAvailable = available;
        const script = document.createElement("script");
        script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
        script.onerror = () => { clearTimeout(timer); initialization = null; reject(new Error("Cast could not load")); };
        document.head.appendChild(script);
      });
    }).catch(error => { initialization = null; throw error; });
    return initialization;
  }

  window.CastPlayback = {
    audio, initialize, ready: () => !!context, connected,
    request: () => context.requestSession(),
    disconnect: () => { if (context) context.endCurrentSession(true); },
    deviceName: () => session && session.getCastDevice().friendlyName || "TV",
    onChange: fn => listeners.push(fn), setNext, appendUpcoming,
    artwork, mediaInfo
  };
})();
