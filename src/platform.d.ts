// Browser features the app uses that TypeScript's DOM library does not describe yet:
// ones only some engines ship (Safari's audio session, Chromium's network information and
// periodic sync), older prefixed names, and the globals index.html and the third-party
// loaders set on window. Like src/globals.d.ts this is for the type check and the editor
// only; nothing loads it and nginx does not serve it.

// ---------------- navigator ----------------

/** Safari's audio session (WebKit): how this page's audio mixes with other apps. */
interface AudioSession extends EventTarget {
  type: "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";
  readonly state?: "inactive" | "active" | "interrupted";
  onstatechange?: ((this: AudioSession, ev: Event) => any) | null;
}

/** Network Information API (Chromium). */
interface NetworkInformation extends EventTarget {
  readonly type?: string;
  readonly effectiveType?: string;
  readonly saveData?: boolean;
  readonly downlink?: number;
}

interface Navigator {
  readonly audioSession?: AudioSession;
  readonly connection?: NetworkInformation;
  readonly mozConnection?: NetworkInformation;
  readonly webkitConnection?: NetworkInformation;
  /** iOS Safari: true when running from the home screen. */
  readonly standalone?: boolean;
}

// ---------------- service worker, screen ----------------

/** Periodic Background Sync (Chromium). */
interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval?: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

interface ServiceWorkerRegistration {
  readonly periodicSync?: PeriodicSyncManager;
}

interface ScreenOrientation {
  /** Missing from the DOM library; Chromium on Android ships it for installed apps. */
  lock?(orientation: "any" | "natural" | "landscape" | "portrait" | "portrait-primary" |
    "portrait-secondary" | "landscape-primary" | "landscape-secondary"): Promise<void>;
}

// ---------------- window ----------------

interface Window {
  /** The launch cover index.html puts up before the first paint; src/main/updates.js lifts it. */
  AppLaunch?: {
    finish(): void;
    /** @returns Whether the cover is still up, so an update can reload under it. */
    coverUpdate(): boolean;
    cancelUpdate(): void;
  };
  webkitAudioContext?: typeof AudioContext;
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
  /** File System Access API (Chromium). */
  showSaveFilePicker?(options?: {
    suggestedName?: string;
    types?: { description?: string, accept: Record<string, string[]> }[];
  }): Promise<any>;
  /** Called by the Cast sender SDK once it has loaded. */
  __onGCastApiAvailable?: (available: boolean) => void;
  /** Called by the YouTube IFrame API once it has loaded. */
  onYouTubeIframeAPIReady?: () => void;
}

// ---------------- the app's own elements ----------------

/** A container views paint whole: paint() remembers the markup it last wrote and the node it
 *  produced, so repainting identical markup costs nothing. Setting __painted to null forces
 *  the next paint. */
type PaintedElement = HTMLElement & { __painted?: string | null, __paintedNode?: ChildNode | null };
