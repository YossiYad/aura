const vm = require("node:vm");
const { readModule, readModuleExposing } = require("./source");

const playerSource = readModule("player");

// The functions some tests drive directly, handed out on window.__playerInternals.
const playerSourceWithInternals = readModuleExposing("player", ["prefetchNext", "next", "keepPreparedSource",
  "playPreparedInstantly", "playViaAudio", "playViaYt", "stopAudio", "scheduleSourceRetry", "resetListenTracking",
  "countListen", "isSpokenWord"], "__playerInternals");

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(item => item !== listener));
  }

  dispatch(type) {
    for (const listener of (this.listeners.get(type) || []).slice()) listener({ type });
  }
}

class FakeAudio extends FakeEventTarget {
  constructor() {
    super();
    this.currentTime = 12;
    this.duration = 180;
    this.ended = false;
    this.paused = true;
    this.playbackRate = 1;
    this.preload = "";
    this.readyState = 4;
    this.src = "";
    this.volume = 1;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    // What the engines report about where the sound is going: the Safari property for
    // AirPlay, and the Remote Playback API the other engines expose.
    this.webkitCurrentPlaybackTargetIsWireless = false;
    this.remote = new FakeEventTarget();
    this.remote.state = "disconnected";
  }

  setAttribute(name, value) { (this.attributes = this.attributes || {})[name] = String(value); }

  getAttribute(name) { return this.attributes && name in this.attributes ? this.attributes[name] : null; }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  load() {}

  play() {
    this.playCalls++;
    if (this.paused) {
      this.paused = false;
      this.dispatch("play");
    }
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls++;
    if (this.paused) return;
    this.paused = true;
    this.dispatch("pause");
  }
}

function createHarness(options = {}) {
  class HarnessAudio extends FakeAudio {
    constructor() {
      super();
      if (options.withRemote) {
        this.remote = new FakeEventTarget();
        this.remote.state = "disconnected";
        this.remote.promptCalls = 0;
        this.remote.prompt = () => { this.remote.promptCalls++; return Promise.resolve(); };
      }
      if (options.withAirPlay) {
        this.webkitCurrentPlaybackTargetIsWireless = false;
        this.pickerCalls = 0;
        this.webkitShowPlaybackTargetPicker = () => { this.pickerCalls++; };
      }
    }
  }
  const audio = new HarnessAudio();
  const audioElements = [audio];
  const document = new FakeEventTarget();
  document.body = { appendChild(el) { if (el instanceof FakeAudio) audioElements.push(el); } };
  document.head = { appendChild() {} };
  document.hidden = false;
  document.visibilityState = "visible";
  document.getElementById = id => id === "audio" ? audio : null;
  document.createElement = () => ({ id: "", src: "", style: {}, addEventListener() {} });

  const window = new FakeEventTarget();
  const logs = [];
  const Log = { add(tag, message) { logs.push({ tag, message }); } };
  window.Log = Log;
  const audioSession = new FakeEventTarget();
  audioSession.state = "inactive";
  audioSession.type = "auto";

  const actions = new Map();
  const mediaSession = {
    metadata: null,
    playbackState: "none",
    setActionHandler(action, handler) {
      if ((options.unsupportedMediaActions || []).includes(action)) {
        const error = new Error("Unsupported media action: " + action);
        error.name = "NotSupportedError";
        throw error;
      }
      actions.set(action, handler);
    },
    setPositionState() {}
  };
  const navigator = { mediaSession, onLine: true, ...options.navigator };
  if (options.withAudioSession !== false) navigator.audioSession = audioSession;

  const savedQueues = [];
  const Store = {
    loadQueue() {
      return {
        extra: options.tracks || [{ id: "track-1", title: "Track", artist: "Artist", duration: 180 }],
        pos: options.pos || 0,
        repeat: "off",
        shuffle: false
      };
    },
    isBlocked() { return false; },
    onChange() {},
    recents() { return []; },
    likedTracks() { return []; },
    library() { return []; },
    // Kept, so a test can check what a dismissal wrote over the stored session.
    saveQueue(q) { savedQueues.push(q); },
    settings() { return options.settings || {}; },
    topListeningTracks() { return []; },
    pushRecent() {}
  };
  const Api = {
    looksLikeMusic() { return true; },
    search() { return Promise.resolve({ items: [] }); },
    thumbFor: id => "https://example.test/" + id + ".jpg"
  };

  const storageRequest = result => {
    const request = { result };
    Promise.resolve().then(() => { if (request.onsuccess) request.onsuccess(); });
    return request;
  };
  const storageDb = {
    objectStoreNames: { contains: () => true },
    transaction() {
      return { objectStore: () => ({ get: () => storageRequest(null) }) };
    }
  };

  let timerId = 0;
  const timers = [];
  const intervals = new Map();
  const setTimeoutFake = (callback, delay = 0) => {
    const timer = { callback, delay, id: ++timerId, stopped: false };
    timers.push(timer);
    return timer.id;
  };
  const clearTimeoutFake = id => {
    const timer = timers.find(item => item.id === id);
    if (timer) timer.stopped = true;
  };

  const savedLocal = new Map();
  Object.assign(window, { Api, Store });
  const context = {
    Api,
    Audio: HarnessAudio,
    Blob,
    Date: options.Date || Date,
    Log,
    Map,
    Math,
    MediaMetadata: class MediaMetadata { constructor(data) { Object.assign(this, data); } },
    Promise,
    Set,
    Store,
    URL,
    clearInterval: id => intervals.delete(id),
    clearTimeout: clearTimeoutFake,
    console,
    Event, EventTarget,
    document,
    localStorage: { getItem: key => savedLocal.get(key) || null, setItem: (key, value) => savedLocal.set(key, value),
      removeItem: key => { savedLocal.delete(key); } },
    performance: { now: () => 0 },
    requestAnimationFrame: fn => setTimeoutFake(() => fn(16), 16),
    cancelAnimationFrame: clearTimeoutFake,
    navigator,
    setInterval: (callback, delay) => { intervals.set(++timerId, { callback, delay }); return timerId; },
    setTimeout: setTimeoutFake,
    window
  };
  if (options.withStorage) context.indexedDB = { open: () => storageRequest(options.storageDb || storageDb) };
  // The audio-session kick context. resume() never moves the state by itself:
  // like on a phone, only the platform (the test) grants audio, via setState.
  const audioContexts = [];
  if (options.withAudioContext) {
    class FakeAudioContext extends FakeEventTarget {
      constructor() {
        super();
        this.state = "suspended";
        this.sampleRate = 48000;
        this.resumeCalls = 0;
        this.suspendCalls = 0;
        this.pendingResumes = [];
        this.destination = { connections: 0 };
        this.silentSources = [];
        audioContexts.push(this);
      }
      createBuffer(channels, length, sampleRate) {
        return { channels, length, sampleRate };
      }
      createBufferSource() {
        const context = this;
        const source = { buffer: null, loop: false, started: false, connected: null,
          connect(target) { this.connected = target; if (target === context.destination) context.destination.connections++; },
          start() { this.started = true; } };
        this.silentSources.push(source);
        return source;
      }
      resume() {
        this.resumeCalls++;
        return new Promise(resolve => this.pendingResumes.push(resolve));
      }
      suspend() {
        this.suspendCalls++;
        this.setState("suspended");
        return Promise.resolve();
      }
      close() {
        this.closeCalls = (this.closeCalls || 0) + 1;
        this.setState("closed");
        return Promise.resolve();
      }
      setState(state) {
        if (this.state === state) return;
        this.state = state;
        if (state === "running") this.pendingResumes.splice(0).forEach(resolve => resolve());
        this.dispatch("statechange");
      }
    }
    context.AudioContext = FakeAudioContext;
    window.AudioContext = FakeAudioContext;
  }
  let ytPlayer = null;
  if (options.withYt) {
    const YT = {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 },
      Player: function Player(id, config) {
        ytPlayer = {
          id,
          loadCalls: 0,
          pauseCalls: 0,
          playCalls: 0,
          state: 2,
          getPlayerState() { return this.state; },
          dispatchState(state) {
            this.state = state;
            config.events.onStateChange({ data: state });
          },
          loadVideoById() {
            this.loadCalls++;
            this.state = 1;
            config.events.onStateChange({ data: 1 });
          },
          pauseVideo() {
            this.pauseCalls++;
            this.state = 2;
            config.events.onStateChange({ data: 2 });
          },
          playVideo() {
            this.playCalls++;
            if (this.playCalls <= (options.ytSilentResumeCount || 0)) return;
            this.state = 1;
            Promise.resolve().then(() => config.events.onStateChange({ data: 1 }));
          },
          setPlaybackRate() {},
          setVolume() {},
          stopVideo() { this.state = 2; }
        };
        Promise.resolve().then(() => config.events.onReady());
        return ytPlayer;
      }
    };
    context.YT = YT;
    window.YT = YT;
  }

  if (options.castSdk) {
    Object.assign(context, options.castSdk);
    Object.assign(window, options.castSdk);
    vm.runInNewContext(readModule("cast"), context, { filename: "src/cast.js" });
    context.CastPlayback = window.CastPlayback;
  }

  const source = options.exposeInternals ? playerSourceWithInternals : playerSource;
  vm.runInNewContext(source, context, { filename: "src/player.js" });
  window.Player.restore();
  audio.src = "https://example.test/track-1.mp3";

  return {
    actions,
    Api,
    audio,
    audioContexts,
    audioElements,
    audioSession,
    document,
    logs,
    navigator,
    Store,
    savedQueues,
    savedLocal,
    window,
    ytPlayer: () => ytPlayer,
    play() { actions.get("play")(); },
    pause() { actions.get("pause")(); },
    runIntervals(delay) {
      for (const timer of [...intervals.values()]) if (timer.delay === delay) timer.callback();
    },
    pendingTimers(delay) {
      return timers.filter(item => !item.stopped && item.delay === delay).length;
    },
    runImmediateTimers() {
      let timer;
      while ((timer = timers.find(item => !item.stopped && item.delay === 0))) {
        timer.stopped = true;
        timer.callback();
      }
    },
    // One pass over the timers waiting at this delay, so a retry that schedules the next
    // one does not run inside the same call.
    runTimers(delay) {
      const due = timers.filter(item => !item.stopped && item.delay === delay);
      due.forEach(timer => {
        timer.stopped = true;
        timer.callback();
      });
      return due.length;
    }
  };
}

async function flushMicrotasks(turns = 12) {
  while (turns-- > 0) await Promise.resolve();
}

module.exports = { FakeEventTarget, FakeAudio, createHarness, flushMicrotasks };
