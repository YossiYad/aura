const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

function positiveInt(value, fallback, min) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= (min || 1) ? parsed : fallback;
}

const PORT = positiveInt(process.env.PORT, 8089);
const DATA_DIR = process.env.PUSH_DATA_DIR || "/data";
const SYNC_DIR = process.env.SYNC_DATA_DIR || "/sync-data";
const INVIDIOUS_BASE = (process.env.INVIDIOUS_BASE || "http://invidious:3000").replace(/\/+$/, "");
const POLL_MINUTES = positiveInt(process.env.POLL_MINUTES, 20, 5);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:push@localhost";

fs.mkdirSync(DATA_DIR, { recursive: true });

// aura-sync keys each listener's synced data by their email, sanitized to a safe filename.
// Push subscriptions are looked up by the same key so the two services agree on who's who
// without either one needing to know the other's identity format.
function identityKey(email) {
  const base = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\.\.+/g, "_")
    .replace(/[^a-z0-9@._-]/g, "_");
  if (!base || base.startsWith(".")) throw new Error("unusable identity");
  return base;
}

function subsFile(key) {
  const dir = path.resolve(DATA_DIR, "subs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key + ".json");
  if (!file.startsWith(dir + path.sep)) throw new Error("unusable identity");
  return file;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---- VAPID keys: generated once, kept on the data volume so a container restart never
// invalidates every subscription already handed out. ----
const vapidFile = path.join(DATA_DIR, "vapid.json");
let vapid = readJson(vapidFile, null);
if (!vapid || !vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  writeJson(vapidFile, vapid);
  console.log("generated a new VAPID keypair - stored in " + vapidFile);
}
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

function send(res, code, obj) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limit) { reject(Object.assign(new Error("payload too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getSubs(key) { return readJson(subsFile(key), []); }
function saveSubs(key, list) { writeJson(subsFile(key), list); }

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) { send(res, 400, { error: "bad request" }); return; }
  const route = url.pathname.replace(/\/+$/, "").replace(/^\/api\/push/, "");

  // The public key is not a secret and is needed before there is anyone to authenticate,
  // so it is the one route that does not require the identity header.
  if (route === "/public-key" && req.method === "GET") {
    send(res, 200, { key: vapid.publicKey });
    return;
  }

  const email = String(req.headers["x-forwarded-email"] || "").trim();
  if (!email) { send(res, 401, { error: "not authenticated" }); return; }
  let key;
  try { key = identityKey(email); }
  catch (e) { send(res, 400, { error: "unusable identity" }); return; }

  if (route === "/status" && req.method === "GET") {
    const subs = getSubs(key);
    send(res, 200, { subscribed: subs.length > 0, count: subs.length });
    return;
  }

  if (route === "/subscribe" && req.method === "POST") {
    readBody(req, 16 * 1024).then(raw => {
      let sub;
      try { sub = JSON.parse(raw.toString("utf8")); } catch (e) { send(res, 400, { error: "bad json" }); return; }
      if (!sub || !sub.endpoint || !sub.keys) { send(res, 400, { error: "not a push subscription" }); return; }
      const subs = getSubs(key).filter(s => s.endpoint !== sub.endpoint);
      subs.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() });
      saveSubs(key, subs);
      send(res, 200, { ok: true, count: subs.length });
    }).catch(e => send(res, e && e.code === 413 ? 413 : 400, { error: e.message || "bad request" }));
    return;
  }

  if (route === "/unsubscribe" && req.method === "POST") {
    readBody(req, 16 * 1024).then(raw => {
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch (e) { body = {}; }
      const subs = getSubs(key).filter(s => s.endpoint !== body.endpoint);
      saveSubs(key, subs);
      send(res, 200, { ok: true });
    }).catch(e => send(res, e && e.code === 413 ? 413 : 400, { error: e.message || "bad request" }));
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log("aura-push listening on " + PORT + ", polling every " + POLL_MINUTES + "m"));

// ---------------- Background: poll followed channels for new releases ----------------

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// aura-sync's data directory is mounted read-only here. Each file is one listener's whole
// synced state; only the follows list inside it is read.
function listFollowers() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(SYNC_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".conflict.json")); }
  catch (e) { return out; }
  for (const file of files) {
    const key = file.slice(0, -5);
    const record = readJson(path.join(SYNC_DIR, file), null);
    const follows = record && record.data && record.data.data && Array.isArray(record.data.data.follows)
      ? record.data.data.follows : [];
    const settings = record && record.data && record.data.data && record.data.data.settings;
    if (follows.length && (!settings || settings.notifyNewReleases !== false)) out.set(key, follows);
  }
  return out;
}

const notifiedFile = path.join(DATA_DIR, "notified.json");
let notified = readJson(notifiedFile, {});

async function latestForChannel(id) {
  const [chan, releases] = await Promise.all([
    fetchJson(INVIDIOUS_BASE + "/api/v1/channels/" + encodeURIComponent(id), 12000).catch(() => null),
    fetchJson(INVIDIOUS_BASE + "/api/v1/channels/" + encodeURIComponent(id) + "/releases", 12000).catch(() => null)
  ]);
  // undefined is a lookup that failed, null a channel that answered with nothing. Read as
  // the same thing, one timeout on the first check made the next one announce an upload
  // from years ago as new.
  const video = !chan ? undefined : Array.isArray(chan.latestVideos) && chan.latestVideos[0]
    ? { id: chan.latestVideos[0].videoId, title: chan.latestVideos[0].title } : null;
  const album = !releases ? undefined : Array.isArray(releases.playlists) && releases.playlists[0]
    ? { id: releases.playlists[0].playlistId, title: releases.playlists[0].title } : null;
  return { video, album };
}

async function sendPush(key, payload) {
  const subs = getSubs(key);
  if (!subs.length) return true;
  const expired = [];
  let delivered = false;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      delivered = true;
    } catch (e) {
      const code = e && e.statusCode;
      // A confirmed-gone endpoint (uninstalled, permission revoked) is dropped so it stops
      // being retried forever; anything else (a timeout, a 5xx) is kept for the next cycle.
      if (code === 404 || code === 410) expired.push(sub);
      console.log("push to " + key + " failed" + (code ? " (" + code + ")" : ": " + (e && e.message)));
    }
  }
  if (expired.length) {
    // Subscription changes can arrive while notification delivery is pending.
    saveSubs(key, getSubs(key).filter(sub => !expired.some(old =>
      old.endpoint === sub.endpoint && old.addedAt === sub.addedAt &&
      JSON.stringify(old.keys) === JSON.stringify(sub.keys))));
  }
  return delivered;
}

let polling = false;
async function pollFollows() {
  if (polling) return;
  polling = true;
  try { await pollFollowsOnce(); }
  finally { polling = false; }
}

async function pollFollowsOnce() {
  const followers = listFollowers();
  if (!followers.size) return;

  const byChannel = new Map();
  const ownKey = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  followers.forEach((list, key) => {
    list.forEach(f => {
      // Ids are synced from the listener's device, so they are data, not trusted keys:
      // "__proto__" as a plain object key would write through to Object.prototype.
      if (!f || typeof f.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id) || f.id === "__proto__") return;
      if (!byChannel.has(f.id)) byChannel.set(f.id, []);
      byChannel.get(f.id).push({ key, name: f.name || "", kind: f.kind === "podcast" ? "podcast" : "artist" });
    });
  });

  console.log("checking " + byChannel.size + " followed channel(s) for " + followers.size + " listener(s)");
  let dirty = false;

  for (const [channelId, followersOfChannel] of byChannel) {
    let latest;
    try { latest = await latestForChannel(channelId); }
    catch (e) { continue; }
    if (!latest.video && !latest.album) continue;

    for (const f of followersOfChannel) {
      const bucket = ownKey(notified, f.key) ? notified[f.key] : (notified[f.key] = {});
      const prior = ownKey(bucket, channelId) ? bucket[channelId] : null;
      if (!prior) {
        // First time this listener/channel pair has been checked: record where things
        // stand without notifying, so following an artist never dumps their back catalog
        // on someone as a wall of "new" pushes.
        // Only the sides that were actually read; the other is recorded when it first answers.
        bucket[channelId] = {};
        if (latest.video !== undefined) bucket[channelId].video = latest.video ? latest.video.id : null;
        if (latest.album !== undefined) bucket[channelId].album = latest.album ? latest.album.id : null;
        dirty = true;
        continue;
      }
      if (prior.video === undefined && latest.video !== undefined) { prior.video = latest.video ? latest.video.id : null; dirty = true; }
      if (prior.album === undefined && latest.album !== undefined) { prior.album = latest.album ? latest.album.id : null; dirty = true; }
      const newVideo = latest.video && latest.video.id !== prior.video;
      const newAlbum = latest.album && latest.album.id !== prior.album;
      if (!newVideo && !newAlbum) continue;

      const title = newAlbum
        ? (f.kind === "podcast" ? "New from " + f.name : "New album from " + f.name)
        : (f.kind === "podcast" ? "New episode from " + f.name : "New from " + f.name);
      const body = newAlbum ? (latest.album.title || "New release") : (latest.video.title || "New upload");

      // Do not advance the watermark until at least one endpoint accepted the push. A
      // temporary outage used to make the notification disappear permanently because the
      // asynchronous send was started and the release was marked as seen immediately.
      const delivered = await sendPush(f.key, { title, body, tag: "follow-" + channelId, artistId: channelId });
      if (!delivered) continue;

      if (latest.video) prior.video = latest.video.id;
      if (latest.album) prior.album = latest.album.id;
      dirty = true;
    }
  }
  if (dirty) writeJson(notifiedFile, notified);
}

setTimeout(() => pollFollows().catch(e => console.log("poll failed: " + e.message)), 15000);
setInterval(() => pollFollows().catch(e => console.log("poll failed: " + e.message)), POLL_MINUTES * 60 * 1000);
