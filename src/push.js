(function () {
  const PUBKEY_ENDPOINT = "/api/push/public-key";
  const SUB_ENDPOINT = "/api/push/subscribe";
  const UNSUB_ENDPOINT = "/api/push/unsubscribe";

  function log(msg) { if (window.Log) Log.add("push", msg); }

  /**
   * @returns {boolean} Whether this browser has service workers, push and notifications.
   */
  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  // A VAPID key arrives base64url-encoded; PushManager.subscribe wants the raw bytes.
  /**
   * @param {string} base64String base64url, as VAPID keys are sent.
   * @returns {Uint8Array<ArrayBuffer>}
   */
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  let backendChecked = false;
  let backendAvailable = false;
  let backendRequest = null;
  let publicKey = "";

  // Most deployments of this app run with no server at all, so a missing push backend is
  // the ordinary case, not an error - checked once and cached, the same way Sync treats a
  // 404 as "this server doesn't run that" rather than something to retry.
  /**
   * @returns {Promise<boolean>} Whether this host runs the push service.
   */
  async function checkBackend() {
    if (backendChecked) return backendAvailable;
    if (backendRequest) return backendRequest;
    backendRequest = (async () => {
      try {
        const res = await fetch(PUBKEY_ENDPOINT, { cache: "no-store" });
        // Only a missing endpoint is permanent. An offline launch or a server error
        // must allow a later attempt, and concurrent callers share this lookup.
        if (res.status === 404) backendChecked = true;
        if (!res.ok) throw new Error("HTTP " + res.status);
        const body = await res.json();
        if (!body || !body.key) throw new Error("no key in response");
        publicKey = body.key;
        backendAvailable = true;
        backendChecked = true;
      } catch (e) {
        backendAvailable = false;
        log("push backend unavailable: " + String((e && e.message) || e));
      }
      return backendAvailable;
    })().finally(() => { backendRequest = null; });
    return backendRequest;
  }

  /**
   * @param {PushSubscription} sub
   * @returns {boolean} False when the subscription was made with another server key.
   */
  function sameServerKey(sub) {
    try {
      const key = sub.options && sub.options.applicationServerKey;
      if (!key) return true;
      const have = new Uint8Array(key), want = urlBase64ToUint8Array(publicKey);
      if (have.length !== want.length) return false;
      for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
      return true;
    } catch (e) { return true; }
  }

  /**
   * @returns {Promise<PushSubscription | null>}
   */
  async function currentSubscription() {
    if (!supported()) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (e) {
      return null;
    }
  }

  /**
   * @returns {Promise<{ supported: boolean, backendAvailable: boolean, permission: NotificationPermission | "unsupported", subscribed: boolean }>}
   */
  async function status() {
    if (!supported()) return { supported: false, backendAvailable: false, permission: "unsupported", subscribed: false };
    const backend = await checkBackend();
    const permission = Notification.permission;
    let subscribed = false;
    if (backend && permission === "granted") subscribed = !!(await currentSubscription());
    return { supported: true, backendAvailable: backend, permission, subscribed };
  }

  // Used for both "turn on push" and "turn on in-app alerts only" - both start with the
  // same permission prompt, and enable() itself decides how far it can actually go.
  /**
   * Asks for permission, then subscribes to push when this host runs the push service.
   * @returns {Promise<{ permission: NotificationPermission, subscribed: boolean }>}
   * @throws {Error} When notifications are unsupported, refused, or the server rejects the subscription.
   */
  async function enable() {
    if (!supported()) throw new Error("Notifications are not supported in this browser");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications were not allowed");
    const backend = await checkBackend();
    if (!backend) return { permission, subscribed: false };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameServerKey(sub)) {
      // Made against an earlier server key: the server would accept the endpoint and the
      // push service would refuse every send, with nothing on this side able to tell.
      log("subscription belongs to another server key, renewing it");
      try { await sub.unsubscribe(); } catch (e) {}
      sub = null;
    }
    const created = !sub;
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    try {
      const saved = await fetch(SUB_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON())
      });
      if (!saved.ok) throw new Error("Couldn't register notifications (HTTP " + saved.status + "). Try again.");
    } catch (e) {
      if (created) { try { await sub.unsubscribe(); } catch (e) {} }
      throw e;
    }
    log("subscribed to push");
    return { permission, subscribed: true };
  }

  /**
   * @returns {Promise<void>}
   */
  async function disable() {
    const sub = await currentSubscription();
    if (!sub) return;
    try {
      await fetch(UNSUB_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } catch (e) {}
    await sub.unsubscribe();
    log("unsubscribed from push");
  }

  // Fired from the foreground new-release check, so a listener with no server behind them
  // still sees a real OS notification the moment the app happens to be open and notices.
  /**
   * Shows a notification from the page itself, without the push server.
   * @param {string} title
   * @param {string} [body]
   * @param {{ tag?: string, artistId?: string }} [opts] `artistId` opens that artist when tapped.
   * @returns {Promise<void>}
   */
  async function notifyLocal(title, body, opts) {
    if (!supported() || Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body: body || "",
        icon: "icon-180.png",
        badge: "icon-180.png",
        tag: (opts && opts.tag) || undefined,
        data: { artistId: (opts && opts.artistId) || null }
      });
    } catch (e) { log("local notification failed: " + String((e && e.message) || e)); }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data && e.data.type === "OPEN_ARTIST" && e.data.artistId && window.Views && Views.openFollowedArtist) {
        Views.openFollowedArtist(e.data.artistId);
      }
    });
  }

  window.Push = { status, enable, disable, notifyLocal, supported };
})();
