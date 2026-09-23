// The modules the app's scripts publish on window, described for the editor.
//
// Every file in src/ is a plain script that hands its API to the next one through a
// global (window.Store, window.Player and so on). TypeScript cannot follow those
// assignments, so without this file a call such as Store.findTrack() in views.js has no
// types at all. Nothing loads this file: browsers never see it, and nginx does not serve
// it. The data types it names (Track, Playlist, StreamInfo...) are the JSDoc typedefs at
// the top of the module that owns each one.
//
// tests/globals-types.test.js fails when a module gains or loses a member without this
// file following, so keep the two in step.

// ---------------- store.js ----------------

interface AuraStore {
  /** @returns This tab's 32-character id for the shared queue. */
  sharedQueueDevice(): string;
  /** @returns Whether the item had been delivered to this tab before this call. */
  sharedQueueDelivered(id: string, delivered?: boolean): boolean;
  /** Reads, and optionally first replaces, the queue of the shared session played here. Null clears it. */
  sharedQueuePlayback(value?: (SavedQueue & { id: string }) | null): (SavedQueue & { id: string }) | null;
  onChange(fn: (what: StoreChange) => void): void;

  /** Newest first. */
  library(kind?: MediaFilter): Track[];
  /** The library in the order chosen in settings. */
  sortedLibrary(kind?: MediaFilter): Track[];
  findTrack(id: string): Track | null;
  /** @returns False when it was already there. */
  addTrack(track: Track): boolean;
  /** Removes a track from the library, its likes and every playlist. */
  removeTrack(id: string): Undo;
  rememberDownload(track: Track): void;
  forgetDownload(id: string): void;
  /** Newest first. */
  downloadedTracks(kind?: MediaFilter): Track[];
  artistIdFor(name: string): string | null;

  isLiked(id: string): boolean;
  /** @returns Whether the track is liked now. */
  toggleLike(id: string): boolean;
  likedTracks(kind?: MediaFilter): Track[];

  playlists(): Playlist[];
  createPlaylist(name: string): Playlist;
  getPlaylist(pid: string): Playlist | null;
  renamePlaylist(pid: string, name: string): void;
  deletePlaylist(pid: string): Undo;
  /** @param cover A data URL, or empty to remove the picture. */
  setPlaylistCover(pid: string, cover: string | null): void;
  /** @returns False when the playlist is missing or already has the track. */
  addToPlaylist(pid: string, id: string): boolean;
  removeFromPlaylist(pid: string, id: string): void;
  /** Moves a track to where another one sits in the same playlist. */
  movePlaylistTrack(pid: string, id: string, targetId: string): boolean;
  playlistTracks(pid: string): Track[];
  setPlaylistShared(pid: string, sharedId: string | null): void;

  /** Most recent first. */
  recents(kind?: MediaFilter): Track[];
  /** Records a play. Does nothing in a private session. */
  pushRecent(track: Track, kind?: MediaKind): void;
  topListeningTracks(limit?: number, kind?: MediaFilter): Track[];
  topListeningArtists(limit?: number): { name: string, plays: number, lastPlayed: number, thumb: string, artistId: string | null }[];
  topListeningPodcasts(limit?: number): { name: string, channel: string, channelId: string, plays: number, lastPlayed: number }[];
  mediaKind(track: Track | null | undefined): MediaKind;
  rememberMedia(track: Track): Track;
  matchingPodcastShow(track: Track | null | undefined): PodcastShow | null;

  searches(): string[];
  pushSearch(query: string): void;
  clearSearches(): void;
  clearHistory(): void;

  savePosition(id: string, seconds: number): void;
  /** @returns Seconds, or 0. */
  getPosition(id: string): number;
  clearPosition(id: string): void;

  isBlocked(track: Track | null | undefined): boolean;
  blockTrack(track: Track): Undo;
  blockArtist(name: string): Undo;
  blockedList(): BlockedList;
  unblockTrack(id: string): void;
  unblockArtist(name: string): void;

  foldText(value: any): string;
  matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean;

  cachedLyrics(id: string): LyricsEntry | null;
  cacheLyrics(id: string, data: LyricsEntry | null): void;
  searchLyrics(query: string, limit?: number): { id: string, line: string }[];
  cachedSegments(id: string): SkipSegment[] | null;
  cacheSegments(id: string, list: SkipSegment[]): void;

  albums(): { key: string, name: string, artist: string, thumb: string, tracks: Track[] }[];
  artists(): { name: string, thumb: string, tracks: Track[] }[];

  isFollowing(id: string): boolean;
  getFollow(id: string): Follow | null;
  followsList(): Follow[];
  follow(entry: { id: string, name?: string, thumb?: string, kind?: string, latestId?: string | null }): boolean;
  unfollow(id: string): void;
  /** @returns True for a genuine new release. */
  refreshFollowLatest(id: string, latestId: string): boolean;
  markFollowSeen(id: string): void;
  hasNewFollow(id: string): boolean;

  podcastShowsList(): PodcastShow[];
  /** @returns Milliseconds since the show list was saved. */
  podcastShowsAge(): number;
  podcastShowsLang(): string;
  savePodcastShows(list: Partial<PodcastShow>[], lang?: string): void;
  notePodcastChannel(name: string, channel: string, channelId?: string, addIfMissing?: boolean): void;
  isPodcastChannel(name: string): boolean;

  /** A copy. */
  settings(): Settings;
  rememberInstance(base: string): void;
  /** Whether a private session is running. */
  privateSession(): boolean;
  /** @returns Whether a private session is running now. */
  setPrivateSession(on: boolean): boolean;
  patchSettings(patch: Partial<Settings>): void;
  saveQueue(q: SavedQueue): void;
  loadQueue(): SavedQueue | null;
  exportData(): AuraBackup;
  /** @throws When the backup is not valid; nothing is restored then. */
  importData(backup: AuraBackup, options?: { preserveDownloads?: boolean }): { songs: number, playlists: number, history: number };
  /** Erases the library and listening data. Downloads, follows and settings stay. */
  clearAll(): void;
}

// ---------------- api.js ----------------

interface AuraApi {
  /** The optional config.json served next to the app. */
  siteConfig(): Promise<Record<string, any>>;
  search(query: string, tracksOnly?: boolean): Promise<SearchPage>;
  searchMore(prev: SearchPage, query: string): Promise<SearchPage>;
  searchArtists(query: string): Promise<{ items: ArtistSummary[], base: string | null }>;
  searchPlaylists(query: string): Promise<{ items: PlaylistSummary[] }>;
  getArtist(channelId: string, fallback?: { name?: string, thumb?: string }): Promise<ArtistPage>;
  artistMore(prev: ArtistPageCursor): Promise<{ items: Track[], nextpage: string | null, page?: number }>;
  getAlbumTracks(listId: string): Promise<Track[]>;
  getPlaylistInfo(listId: string): Promise<{ name: string, tracks: Track[] }>;
  resolve(id: string, opts?: ResolveOptions): Promise<StreamInfo>;
  invalidate(id: string, penalizeSource?: boolean): void;
  fetchStreamBlob(id: string, maxBytes: number, onProgress?: (received: number, total: number) => void, options?: ResolveOptions): Promise<Blob>;
  fetchImageBlob(url: string): Promise<Blob>;
  /** A channel's fifteen newest uploads. Durations are 0. */
  channelFeed(channelId: string): Promise<Track[]>;
  /** @returns Null when no lyrics were found; rejects when the lookup failed. */
  getLyrics(track: Track): Promise<LyricsEntry | null>;
  lyricsQuery(track: Track): { title: string, artist: string };
  getSkipSegments(id: string): Promise<SkipSegment[]>;
  importPlaylist(url: string): Promise<ImportedPlaylist>;
  matchTrack(title: string, artist?: string, options?: { original?: string | boolean }): Promise<Track | null>;
  findVersions(track: Track): Promise<Track[]>;
  looksLikeMusic(track: Track | null | undefined): boolean;
  notMusic(track: Track | null | undefined): boolean;
  looksLikePodcast(track: Track | null | undefined): boolean;
  thumbFor(id: string): string;
  defaults: { piped: string[], invidious: string[], cobalt: string[] };
}

// ---------------- ai.js ----------------

interface AuraAi {
  providers: AiProvider[];
  label(provider: AiProvider): string;
  keyUrl(provider: AiProvider): string;
  keyUrlLabel(provider: AiProvider): string;
  defaultModel(provider: AiProvider): string;
  hasKey(provider: AiProvider): boolean;
  hasAnyKey(): boolean;
  getKeys(provider: AiProvider): string[];
  addKey(provider: AiProvider, key: string): string[];
  removeKey(provider: AiProvider, key: string): string[];
  getMode(): AiProvider | "both";
  setMode(mode: AiProvider | "both"): void;
  models(provider: AiProvider): string[];
  getModel(provider: AiProvider): string;
  getModelStored(provider: AiProvider): string;
  setModel(provider: AiProvider, model: string): void;
  testKey(provider: AiProvider, key: string, onStep?: (step: KeyTestStep) => void): Promise<{ ok: boolean, steps: KeyTestStep[], verdict: string }>;
  generatePlaylist(prompt: string, count?: number, historyContext?: string, avoidList?: string[]): Promise<GeneratedPlaylist>;
  interpretPlayback(request: string): Promise<PlaybackIntent>;
  suggestPodcastShows(languageName?: string, followed?: string[]): Promise<{ name: string, host: string }[]>;
}

// ---------------- player.js ----------------

interface AuraPlayer {
  onChange(fn: (ev: PlayerEvent) => void): void;
  current(): Track | null;
  toggle(): void;
  pause(): void;
  next(): Promise<void>;
  prev(): void;
  /** Replaces the queue and starts playing; an empty list stops and clears it. */
  playQueue(tracks: Track[], startIndex?: number, options?: { shuffle?: boolean }): boolean;
  playNext(track: Track): boolean | void;
  addToQueue(track: Track): boolean;
  removeAt(i: number): void;
  moveAt(from: number, to: number): void;
  clearUpcoming(): void;
  jumpTo(i: number): boolean;
  replaceCurrent(track: Track): void;
  beginShare(id: string): void;
  endShare(): void;
  /** The shared session being played, or "". */
  shareSession(): string;
  queueHistory(): QueueHistoryEntry[];
  playFromQueueHistory(id: string): boolean;
  /** Changes whenever a new queue history starts. */
  queueHistorySession(): number;
  dismiss(): void;
  queue(): Track[];
  /** What plays after the current track, in order. */
  upcoming(): Track[];
  pos(): number;
  shuffle(): boolean;
  setShuffle(v: boolean): void;
  repeat(): RepeatMode;
  cycleRepeat(): RepeatMode;
  /** Position and length in seconds. */
  getTime(): { cur: number, dur: number };
  isPaused(): boolean;
  playbackRequested(): boolean;
  isLoading(): boolean;
  releaseForVoice(): void;
  primeForPlayback(): void;
  /** What the audio element holds, for the diagnostic log. */
  captureState(): { src: boolean, paused: boolean, ended: boolean, ready: number, kick: string, backend: string, tts: boolean };
  seekTo(sec: number): void;
  /** @param v 0 to 1. */
  setVolume(v: number): void;
  volume(): number;
  needsPlaybackGesture(): boolean;
  requestRemotePlayback(): Promise<void>;
  remotePlaybackStatus(): RemotePlaybackStatus;
  rate(): number;
  setRate(v: number): number;
  rateChoices(): number[];
  /** @param value Minutes, "track" for the end of this track, or "off". */
  setSleepTimer(value: string | number): void;
  sleepTimerState(): "track" | "on" | "off";
  download(track: Track): Promise<void>;
  deleteDownload(id: string): Promise<void>;
  getDownload(id: string): Promise<Blob | null>;
  getArt(id: string): Promise<Blob | null>;
  artIds(): Promise<Set<string>>;
  /** @returns How many were added. */
  queueDownloads(tracks: Track[]): number;
  downloadStatus(id: string): "pending" | "busy" | "done" | "failed" | null;
  downloadCounts(): { working: number, failed: number };
  downloadProgress(id?: string): { got: number, total: number } | null;
  downloadsBlockedByWifi(): boolean;
  cacheStats(): Promise<{ count: number, bytes: number }>;
  clearCache(): Promise<void>;
  cacheTrack(id: string): Promise<boolean>;
  /** Every track on the device, downloaded or cached. */
  localIds(): Promise<Set<string>>;
  /** Only the tracks the listener downloaded. */
  downloadedIds(): Promise<Set<string>>;
  restore(saved?: SavedQueue | null): void;
}

// ---------------- the smaller modules ----------------

interface AuraLog {
  add(tag: string, msg: any): void;
  dump(): string;
  count(): number;
  clear(): void;
}

interface AuraSync {
  init(): void;
  pushNow(): Promise<void>;
  hasConflict(): Promise<boolean>;
  recoverConflict(): Promise<void>;
  onChange(fn: () => void): void;
  describe(): SyncStatus;
  sharedList(): Promise<{ email: string, playlists: SharedPlaylist[] }>;
  sharedOpen(id: string): Promise<SharedPlaylist>;
  sharedCreate(name: string, tracks: Track[]): Promise<SharedPlaylist>;
  sharedReplace(id: string, name: string, tracks: Track[]): Promise<SharedPlaylist>;
  sharedAppend(id: string, tracks: Track[]): Promise<SharedPlaylist>;
  sharedRemove(id: string): Promise<any>;
  sharedRemoveTrack(id: string, trackId: string): Promise<SharedPlaylist>;
  sharedCached(id: string): SharedPlaylist | null;
  sharedCached(): SharedPlaylist[];
  sharedForget(id: string): void;
}

interface AuraPush {
  status(): Promise<{ supported: boolean, backendAvailable: boolean, permission: NotificationPermission | "unsupported", subscribed: boolean }>;
  enable(): Promise<{ permission: NotificationPermission, subscribed: boolean }>;
  disable(): Promise<void>;
  notifyLocal(title: string, body?: string, opts?: { tag?: string, artistId?: string }): Promise<void>;
  supported(): boolean;
}

interface AuraNightly {
  init(): void;
  register(name: string, fn: () => Promise<unknown> | void): void;
  onChange(fn: (status: NightlyStatus) => void): void;
  describe(): NightlyStatus;
  applySettings(): void;
  enabled(): boolean;
  hour(): number;
  isDue(now?: number): boolean;
  run(reason?: string): Promise<boolean>;
  runIfDue(reason: string): Promise<boolean>;
}

interface AuraCastPlayback {
  /**
   * Stands in for an audio element while casting: an EventTarget with the play, pause,
   * currentTime and similar members the player uses, `isCast: true`, and `remote.state`.
   */
  audio: any;
  /** @returns False when Cast is not available in this browser. */
  initialize(): Promise<boolean>;
  ready(): boolean;
  connected(): boolean;
  request(): Promise<any>;
  disconnect(): void;
  deviceName(): string;
  /** "track" names the queue entry the TV moved on to by itself. */
  onChange(fn: (event: { type: "connected" | "disconnected" | "error" | "track", position?: number, message?: string, error?: any, id?: string }) => void): void;
  setNext(track: Track | null, url?: string, mime?: string): Promise<void>;
  appendUpcoming(entries: { track: Track, info: StreamInfo }[]): Promise<void>;
  artwork(track: Track): string[];
  /** @returns A chrome.cast.media.MediaInfo. */
  mediaInfo(track: Track, url: string, mime?: string): any;
}

interface AuraVoice {
  supported(): boolean;
  isListening(): boolean;
  listen(options: ListenOptions): { cancel: () => void, finish: () => void };
  resolve(request: string, onstatus?: (status: string) => void, active?: () => boolean, interpreted?: PlaybackIntent): Promise<ResolvedRequest>;
  basicIntent(request: string): VoiceIntent;
  isCommand(request: string): boolean;
  reply(messages: Record<string, string>, language?: string): Promise<boolean>;
  stopReply(): void;
  repliesOn(): boolean;
}

interface AuraSharedQueue {
  init(): void;
  available(): boolean;
  refreshNotifications(): void;
  /** Opens the shared queue sheet through the given sheet opener. */
  open(showSheet: (html: string) => void, mode?: "standalone" | "existing-queue"): void;
}

interface AuraSongProgress {
  create(root: HTMLElement, options?: {
    onSeek?: (pct: number) => void,
    onPreview?: (pct: number | null) => void,
    keyStep?: () => number,
    touch?: boolean
  }): { set: (pct: number) => void, scrubbing: () => boolean };
  setStyle(name: "wave" | "line"): void;
  wave(from: number, to: number, mid: number, half: number, amp: number): { d: string, x: number, y: number };
}

interface AuraOrbs {
  /** The drawing engine, exposed for tests/orbs.test.js. */
  engine: {
    resolvePreset(state: string, size: string): { mode: string, speed: number, opts: Record<string, any> };
    MODE_FRAMES: Record<string, any>;
    STATE_TO_MODE: Record<string, string>;
  };
}

interface AuraAppOrientation {
  status(): string;
}

// ---------------- guest/i18n.js ----------------

/** The interface language, shared by the app and the guest page. */
interface AuraI18n {
  /** "he" or "en". */
  language(): string;
  /** The English text for Hebrew interface text, or the text itself in Hebrew. */
  t<T>(value: T): T;
  /** The recognition language: the saved one, else the interface language's. */
  speechLanguage(): string;
  /** Saves the choice and fires "aura-language". @returns False for an unknown language. */
  setLanguage(value: string): boolean;
  initGuest(): void;
  /** Whether the listener has picked a language, rather than getting the English default. */
  chosen(): boolean;
  /** "he" or "en", from the browser: what to offer first when asking. */
  suggested(): string;
  /** "English" or "Hebrew": the language AI replies are written in. */
  aiLanguage(): string;
  direction(): "rtl" | "ltr";
  locale(): string;
}

// ---------------- views.js ----------------

interface AuraViews {
  openSharedQueue(): void;
  startVoice(surface?: "ask" | "drive"): void;
  stopVoice(): void;
  voiceOpen(): boolean;
  initServerMix(): void;
  render(animate?: boolean): void;
  markNowPlaying(): void;
  refreshIfStale(): void;
  toast(msg: string, kind?: "" | "err", undo?: () => void): void;
  syncPrivateButton(): void;
  openQueueSheet(showHistory?: boolean): void;
  openSettings(): void;
  /** @param ctx "pl:<id>", "shared:<id>", "library" or empty. */
  openTrackMenu(track: Track, ctx?: string): void;
  openPlaylistPicker(track: Track, onAdded?: (added: boolean) => void): void;
  openCreateSheet(): void;
  openSleepTimerSheet(): void;
  openSpeedSheet(): void;
  applyAppearance(): void;
  /** Asks which interface language to use, unless one has been chosen. */
  askLanguage(): void;
  artSrc(track: Track): string;
  /** Something Back should close before it leaves the screen. */
  addBackLayer(layer: { open: () => boolean, close: () => void }): void;
  focusLibrarySearch(): void;
  openCurrentArtist(): void;
  openFollowedArtist(id: string): void;
  /** @returns False for an unknown shortcut. */
  openShortcut(name: string): boolean;
  showTab(tab: string): void;
  currentTab(): string;
}

// ---------------- the globals themselves ----------------

declare var Store: AuraStore;
declare var Api: AuraApi;
declare var Ai: AuraAi;
declare var Player: AuraPlayer;
declare var Log: AuraLog;
declare var Sync: AuraSync;
declare var Push: AuraPush;
declare var Nightly: AuraNightly;
declare var CastPlayback: AuraCastPlayback;
declare var Voice: AuraVoice;
declare var SharedQueue: AuraSharedQueue;
declare var SongProgress: AuraSongProgress;
declare var Orbs: AuraOrbs;
declare var AppOrientation: AuraAppOrientation;
declare var Views: AuraViews;
declare var I18n: AuraI18n;

// Internal namespaces of the modules split into several files (see the header of each
// module's first file). Only the files of the same module use them. Each is optional
// because the module's first file is what creates it.
type AuraNamespace = Record<string, any>;
declare var Aura: {
  views?: AuraNamespace, player?: AuraNamespace, api?: AuraNamespace,
  main?: AuraNamespace, store?: AuraNamespace, orbs?: AuraNamespace,
  sync?: AuraNamespace, voice?: AuraNamespace
};

// Third-party SDKs loaded at runtime, with no type packages installed.
declare var YT: any;
declare var cast: any;
declare var chrome: any;
