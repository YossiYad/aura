const CACHE = "aura-v204";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./aura.css",
  "./tokens.css",
  "./icon.svg",
  "./icon-180.png",
  "./src/app.css",
  "./src/progress.css",
  "./src/log.js",
  "./src/api.js",
  "./src/api/normalize.js",
  "./src/api/search-servers.js",
  "./src/api/artists.js",
  "./src/api/search.js",
  "./src/api/relays.js",
  "./src/api/import.js",
  "./src/api/match.js",
  "./src/api/classify.js",
  "./src/api/streams.js",
  "./src/api/blobs.js",
  "./src/api/segments.js",
  "./src/api/lyrics.js",
  "./src/api/public.js",
  "./src/ai.js",
  "./src/store.js",
  "./src/store/text.js",
  "./src/store/library.js",
  "./src/store/playlists.js",
  "./src/store/media.js",
  "./src/store/listening.js",
  "./src/store/follows.js",
  "./src/store/backup.js",
  "./src/store/positions.js",
  "./src/store/blocked.js",
  "./src/store/caches.js",
  "./src/store/podcasts.js",
  "./src/store/private.js",
  "./src/store/searches.js",
  "./src/store/collections.js",
  "./src/store/public.js",
  "./guest/i18n.js",
  "./src/orientation.js",
  "./src/sync.js",
  "./src/sync/shared.js",
  "./src/push.js",
  "./src/nightly.js",
  "./src/cast.js",
  "./src/player.js",
  "./src/player/remote.js",
  "./src/player/session.js",
  "./src/player/events.js",
  "./src/player/youtube.js",
  "./src/player/downloads.js",
  "./src/player/cache.js",
  "./src/player/sources.js",
  "./src/player/sleep.js",
  "./src/player/load.js",
  "./src/player/radio.js",
  "./src/player/queue.js",
  "./src/player/transport.js",
  "./src/player/levels.js",
  "./src/player/controls.js",
  "./src/player/media-session.js",
  "./src/player/stall.js",
  "./src/player/crossfade.js",
  "./src/player/elements.js",
  "./src/player/network.js",
  "./src/player/public.js",
  "./src/voice.js",
  "./src/voice/requests.js",
  "./src/shared-queue.js",
  "./src/vendor/thinking-orbs.js",
  "./src/orbs.js",
  "./src/views.js",
  "./src/views/covers.js",
  "./src/views/home.js",
  "./src/views/following.js",
  "./src/views/library.js",
  "./src/views/ask.js",
  "./src/views/search.js",
  "./src/views/collections.js",
  "./src/views/artist.js",
  "./src/views/shared.js",
  "./src/views/router.js",
  "./src/views/sheets.js",
  "./src/views/queue.js",
  "./src/views/app-version.js",
  "./src/views/import.js",
  "./src/views/settings.js",
  "./src/views/gestures.js",
  "./src/views/swipe.js",
  "./src/views/clicks.js",
  "./src/views/public.js",
  "./src/progress.js",
  "./src/main.js",
  "./src/main/viewport.js",
  "./src/main/lyrics.js",
  "./src/main/bar.js",
  "./src/main/failures.js",
  "./src/main/gestures.js",
  "./src/main/drive.js",
  "./src/main/controls.js",
  "./src/main/keyboard.js",
  "./src/main/updates.js",
  "./src/main/launch.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => /^aura-v\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Report the cache belonging to the worker controlling this page, even while offline.
self.addEventListener("message", e => {
  if (e.data && e.data.type === "GET_CACHE_VERSION" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ cache: CACHE });
  }
  if (e.data && e.data.type === "SYNC_SHELL" && e.ports && e.ports[0]) {
    const port = e.ports[0];
    e.waitUntil(syncShell().then(changed => port.postMessage({ changed }), () => port.postMessage({ changed: false, failed: true })));
  }
});

// A deploy that leaves CACHE alone is invisible to the browser: sw.js is byte for byte
// what it was, no new worker installs, and the shell stays exactly as it was installed.
// Online and offline alike that is an old app, and nothing short of a manual refresh
// moved it. So after an update check that found no new worker the page asks for this:
// read the whole shell again and compare it with what is kept. Nothing is written unless
// every file arrived, and then all of it is, so the installed shell still moves as one.
let shellSync = null;

// The shell is a hundred files, and reading them all on every return to the app is a
// hundred requests through the login proxy while the app is being picked back up. A
// deploy from auto-deploy.sh writes the commit it serves to app-revision.txt, and while
// that is the commit the last full comparison saw, nothing can have changed: one small
// request stands in for the hundred. A host without the file (no deploy script, or a
// lapsed login answering with its sign-in page) gets the full comparison every time.
const REVISION = "./app-revision.txt";

async function servedRevision(signal) {
  try {
    const res = await fetch(REVISION, { cache: "no-cache", signal });
    if (!res.ok || res.status !== 200 || res.redirected) return "";
    const text = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(text) ? text : "";
  } catch (e) { return ""; }
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function syncShell() {
  if (shellSync) return shellSync;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  shellSync = (async () => {
    const cache = await caches.open(CACHE);
    const revision = await servedRevision(ctl.signal);
    const compared = revision && await cache.match(REVISION);
    if (compared && await compared.text() === revision) return false;
    const fresh = await Promise.all(SHELL.map(async entry => {
      const res = await fetch(entry, { cache: "no-cache", signal: ctl.signal });
      // A lapsed login answers with its sign-in page, and that is not the app.
      if (!res.ok || res.status !== 200 || res.redirected) throw new Error("unavailable");
      const kept = await cache.match(entry);
      const same = !!kept && sameBytes(await res.clone().arrayBuffer(), await kept.arrayBuffer());
      return { entry, res, same };
    }));
    const changed = !fresh.every(f => f.same);
    if (changed) for (const f of fresh) await cache.put(f.entry, f.res);
    if (revision) await cache.put(REVISION, new Response(revision));
    return changed;
  })().finally(() => { clearTimeout(timer); shellSync = null; });
  return shellSync;
}

// The app's own files. Everything here is served from the cache first, because a phone
// with no route to the server does not fail fast - the connection sits there until it
// times out, and every one of these was being waited on before the first paint. That is
// the app hanging on its splash screen for a minute with a perfectly good copy on disk.
function isShellRequest(request, url) {
  if (request.mode === "navigate") return true;
  const path = url.pathname.replace(/\/+$/, "");
  return SHELL.some(entry => {
    const name = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return name && (path === "/" + name || path.endsWith("/" + name));
  });
}

function revalidate(request) {
  return fetch(request, { cache: "no-cache" }).then(async res => {
    if (res && res.ok && res.status === 200) {
      const copy = res.clone();
      await caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
    }
    return res;
  });
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== "GET") return;
  if (e.request.headers.has("range")) return;
  // /relay reads a live page somewhere else and the address it reads is in the query
  // string. The fallback below matches with ignoreSearch, so a reply kept from one
  // playlist would be handed back for a different one the moment a read failed - the
  // wrong playlist imported, with nothing on screen to say so. Never cache it, never
  // answer it from the cache.
  // Receiver pages are independent of the phone shell, including under a Pages subpath.
  // The login proxy's own pages (sign-in, start, callback) are navigations too; answering
  // them with the cached shell would swallow the sign-in redirect, and a lapsed session
  // could never be re-established while the worker is installed.
  if (/\/tv(?:\/|$)/.test(url.pathname) ||
      url.pathname.endsWith("/audio-check.html") ||
      (url.pathname.startsWith("/guest/") && !url.pathname.endsWith("/guest/i18n.js")) ||
      url.pathname.startsWith("/oauth2/") ||
      url.pathname.endsWith("/config.json") ||
      url.pathname.endsWith("/relay") ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/media/") ||
      url.pathname.startsWith("/videoplayback") ||
      url.pathname.startsWith("/latest_version") ||
      url.pathname.startsWith("/vi/")) return;

  if (isShellRequest(e.request, url)) {
    e.respondWith((async () => {
      // A manual refresh must fetch both the document and its scripts/styles afresh.
      // Its subresource URLs have no refresh query, but their same-origin referrer does.
      let refresh = url.searchParams.has("refresh");
      try {
        const referrer = new URL(e.request.referrer);
        refresh = refresh || (referrer.origin === url.origin && referrer.searchParams.has("refresh"));
      } catch (err) {}
      if (refresh) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        try {
          const response = await fetch(e.request, { cache: "reload", signal: ctl.signal });
          if (response && response.ok) {
            const copy = response.clone();
            // Kept under the plain address. Under the refresh one it sat beside the
            // installed document, which is older and is the one a later launch matched.
            e.waitUntil(caches.open(CACHE).then(cache => cache.put(url.origin + url.pathname, copy)).catch(() => {}));
            return response;
          }
        } catch (err) {
          // Offline refreshes can still open the installed app.
        } finally { clearTimeout(timer); }
      }
      const cache = await caches.open(CACHE);
      const cached = await cache.match(e.request, { ignoreSearch: true }) ||
        (e.request.mode === "navigate" ? await cache.match("./index.html") : null);
      if (cached) {
        // Keep the installed shell together. Updating individual files in the background
        // can mix old HTML with new styles/scripts; installation prepares the next version.
        return cached;
      }
      try { return await revalidate(e.request); }
      catch (err) { return Response.error(); }
    })());
    return;
  }

  e.respondWith(
    revalidate(e.request).then(async res => {
      if (!res.ok) {
        const cached = await (await caches.open(CACHE)).match(e.request);
        return cached || res;
      }
      return res;
    }).catch(async () => {
      const cached = await (await caches.open(CACHE)).match(e.request);
      if (cached) return cached;
      return Response.error();
    })
  );
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// The daily Home prep. The work itself cannot happen here - the AI keys and every cache
// it writes live in localStorage, which a service worker cannot reach - so this wakes the
// page instead and lets it do the run. With no window open there is nothing to wake, and
// the next launch catches the missed slot up on its own.
self.addEventListener("periodicsync", e => {
  if (e.tag !== "aura-nightly") return;
  e.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach(c => c.postMessage({ type: "RUN_NIGHTLY" }));
  })());
});

// A new-release push from the self-hosted backend, or a local one raised straight from the
// foreground check in views.js by calling registration.showNotification() directly - either
// way it lands here for the actual OS notification.
self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || "Aura";
  const options = {
    body: data.body || "",
    icon: "icon-180.png",
    badge: "icon-180.png",
    tag: data.tag || undefined,
    data: { artistId: data.artistId || null }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const artistId = e.notification.data && e.notification.data.artistId;
  e.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of allClients) {
      if ("focus" in c) {
        if (artistId) c.postMessage({ type: "OPEN_ARTIST", artistId });
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow("./index.html" + (artistId ? "?artist=" + encodeURIComponent(artistId) : ""));
  })());
});
