const http = require("http");
const fs = require("fs");
const path = require("path");

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = positiveInt(process.env.PORT, 8088);
const DATA_DIR = process.env.SYNC_DATA_DIR || "/data";
const MAX_BYTES = positiveInt(process.env.SYNC_MAX_BYTES, 2 * 1024 * 1024);
// Personal sync is one blob per identity and never crosses accounts. Shared playlists are
// the opposite by design: one file per playlist, readable and appendable by everyone
// oauth2-proxy lets through, because the whole point is that the household builds a list
// together. Only the person who created one can rename, replace or delete it.
const SHARED_DIR = path.join(DATA_DIR, "shared");
const SHARED_MAX_TRACKS = positiveInt(process.env.SYNC_SHARED_MAX_TRACKS, 600);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHARED_DIR, { recursive: true });

function accountFile(email) {
  const base = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\.\.+/g, "_")
    .replace(/[^a-z0-9@._-]/g, "_");
  if (!base || base.startsWith(".")) throw new Error("unusable identity");
  const dir = path.resolve(DATA_DIR);
  const file = path.join(dir, base + ".json");
  if (!file.startsWith(dir + path.sep)) throw new Error("unusable identity");
  return file;
}

function conflictFile(email) {
  return accountFile(email).replace(/\.json$/, ".conflict.json");
}

const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return null; }
}

function writeRecord(file, record) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit, onTooLarge) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", chunk => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        req.pause();
        onTooLarge();
        reject(Object.assign(new Error("payload too large"), { code: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", err => { if (!over) reject(err); });
  });
}

function payloadSize(record) {
  return Buffer.byteLength(JSON.stringify(record.data));
}

function sharedFile(id) {
  if (!/^sp_[a-z0-9]{6,32}$/.test(String(id || ""))) throw new Error("bad playlist id");
  return path.join(SHARED_DIR, id + ".json");
}

function newSharedId() {
  return "sp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Only what a track needs to be found and shown again. Anything else a client happens to
// send - resume positions, download flags, whatever a future version adds - is another
// household's business and does not belong in a file everyone can read.
function cleanTrack(t) {
  if (!t || typeof t !== "object" || !t.id || typeof t.id !== "string") return null;
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  return {
    id: t.id.slice(0, 64),
    title: str(t.title, 300),
    artist: str(t.artist, 200),
    album: str(t.album, 200),
    thumb: str(t.thumb, 500),
    duration: Number(t.duration) || 0,
    artistId: t.artistId ? str(t.artistId, 64) : null,
    artistThumb: str(t.artistThumb, 500),
    artistVerified: t.artistVerified === true,
    kind: t.kind === "podcast" || t.kind === "music" ? t.kind : undefined,
    podcast: t.kind === "podcast" ? str(t.podcast, 200) : ""
  };
}

function cleanTracks(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(raw => {
    const t = cleanTrack(raw);
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
  });
  return out;
}

function sharedSummary(record, email) {
  return {
    id: record.id,
    name: record.name,
    owner: record.owner,
    mine: record.owner === email,
    count: (record.tracks || []).length,
    updatedAt: record.updatedAt || 0,
    updatedBy: record.updatedBy || record.owner
  };
}

function listShared(email) {
  let names = [];
  try { names = fs.readdirSync(SHARED_DIR); } catch (e) { return []; }
  return names
    .filter(n => n.endsWith(".json"))
    .map(n => readRecord(path.join(SHARED_DIR, n)))
    .filter(r => r && r.id && r.owner)
    .map(r => sharedSummary(r, email))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// rest is what followed "/shared": "" for the index, "/sp_xyz" for one playlist, and
// "/sp_xyz/tracks" for the append everyone is allowed to do.
function handleShared(req, res, rest, email, startedAt) {
  const parts = rest.split("/").filter(Boolean);
  const id = parts[0] || "";
  const tail = parts[1] || "";
  let done = false;
  const finish = (code, obj) => {
    if (done) return;
    done = true;
    send(res, code, obj);
    console.log(new Date().toISOString(), "shared" + (id ? "/" + id : ""), req.method, code,
      (Date.now() - startedAt) + "ms");
  };
  const tooLarge = () => {
    finish(413, { error: "payload too large, limit is " + MAX_BYTES + " bytes" });
    setTimeout(() => req.destroy(), 1000);
  };

  if (parts.length > 2 || (tail && tail !== "tracks")) return finish(404, { error: "no such route" });

  if (!id) {
    if (req.method === "GET") return finish(200, { email, playlists: listShared(email) });
    if (req.method === "POST") {
      return readBody(req, MAX_BYTES, tooLarge).then(raw => {
        let body;
        try { body = JSON.parse(raw.toString("utf8")); }
        catch (e) { return finish(400, { error: "body is not valid JSON" }); }
        const name = String((body && body.name) || "").trim().slice(0, 120) || "Shared playlist";
        const record = {
          id: newSharedId(),
          name,
          owner: email,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updatedBy: email,
          tracks: cleanTracks(body && body.tracks)
        };
        if (record.tracks.length > SHARED_MAX_TRACKS) return finish(413, { error: "Shared playlist is full; no changes were saved" });
        writeRecord(sharedFile(record.id), record);
        finish(200, Object.assign({}, record, { mine: true }));
      }).catch(() => finish(500, { error: "Couldn't save the shared playlist" }));
    }
    return finish(405, { error: "method not allowed" });
  }

  let file;
  try { file = sharedFile(id); }
  catch (e) { return finish(400, { error: "bad playlist id" }); }

  if (req.method === "GET" && !tail) {
    const record = readRecord(file);
    if (!record || !record.id) return finish(404, { error: "no such playlist" });
    return finish(200, Object.assign({}, record, { mine: record.owner === email }));
  }

  if (req.method === "DELETE" && !tail) {
    return withLock(file, () => {
      const record = readRecord(file);
      if (!record || !record.id) return finish(404, { error: "no such playlist" });
      if (record.owner !== email) return finish(403, { error: "only the person who shared this can remove it" });
      removeQuietly(file);
      finish(200, { ok: true });
    }).catch(() => finish(500, { error: "Couldn't remove the shared playlist" }));
  }

  if (req.method === "PUT" || req.method === "POST") {
    return readBody(req, MAX_BYTES, tooLarge).then(raw => {
      let body;
      try { body = JSON.parse(raw.toString("utf8")); }
      catch (e) { return finish(400, { error: "body is not valid JSON" }); }
      return withLock(file, () => {
        const record = readRecord(file);
        if (!record || !record.id) return finish(404, { error: "no such playlist" });
        // Replacing the list wholesale, or renaming it, is the owner's call - one person
        // tidying up should not be able to wipe what everyone else added.
        if (req.method === "PUT" && record.owner !== email) {
          return finish(403, { error: "only the person who shared this can change it" });
        }
        if (req.method === "PUT") {
          record.name = String((body && body.name) || record.name).trim().slice(0, 120) || record.name;
          if (body && Array.isArray(body.removeIds)) {
            const remove = new Set(body.removeIds.filter(id => typeof id === "string"));
            record.tracks = (record.tracks || []).filter(t => !remove.has(t.id));
          } else if (body && body.merge === true) {
            const merged = cleanTracks(body.tracks);
            const have = new Set(merged.map(t => t.id));
            const extra = (record.tracks || []).filter(t => !have.has(t.id));
            if (merged.length + extra.length > SHARED_MAX_TRACKS) {
              return finish(413, { error: "Shared playlist is full; no changes were saved" });
            }
            record.tracks = merged.concat(extra);
          } else {
            return finish(428, { error: "Refresh the app to update shared playlists safely" });
          }
        } else {
          // The append anyone may do. Songs already in the list are left where they are
          // rather than jumping to the end.
          const have = new Set((record.tracks || []).map(t => t.id));
          const added = cleanTracks(body && body.tracks).filter(t => !have.has(t.id));
          if (!added.length) {
            return finish(200, Object.assign({}, record, { mine: record.owner === email, added: 0 }));
          }
          if ((record.tracks || []).length + added.length > SHARED_MAX_TRACKS) {
            return finish(413, { error: "Shared playlist is full; no changes were saved" });
          }
          record.tracks = (record.tracks || []).concat(added);
        }
        record.updatedAt = Date.now();
        record.updatedBy = email;
        writeRecord(file, record);
        finish(200, Object.assign({}, record, { mine: record.owner === email }));
      });
    }).catch(() => finish(500, { error: "Couldn't save the shared playlist" }));
  }

  return finish(405, { error: "method not allowed" });
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const email = String(req.headers["x-forwarded-email"] || "").trim();
  if (!email) {
    send(res, 401, { error: "not authenticated" });
    return;
  }
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) {
    send(res, 400, { error: "bad request" });
    return;
  }
  const route = url.pathname.replace(/\/+$/, "").replace(/^\/api\/sync/, "");
  const wantConflict = route === "/conflict";

  if (route === "/shared" || route.indexOf("/shared/") === 0) {
    handleShared(req, res, route.slice(7), email, startedAt);
    return;
  }
  if (route !== "" && !wantConflict) return send(res, 404, { error: "no such route" });

  let aFile;
  let cFile;
  try {
    aFile = accountFile(email);
    cFile = conflictFile(email);
  } catch (e) {
    send(res, 400, { error: "unusable identity" });
    return;
  }
  const target = wantConflict ? cFile : aFile;
  let done = false;

  const finish = (code, obj) => {
    if (done) return;
    done = true;
    send(res, code, obj);
    console.log(new Date().toISOString(), path.basename(target), req.method, code,
      obj && obj.size != null ? obj.size + "b" : "", (Date.now() - startedAt) + "ms");
  };

  if (req.method === "GET") {
    const record = readRecord(target);
    if (!record || typeof record !== "object" || !record.data) {
      if (wantConflict) {
        finish(404, {});
      } else {
        finish(200, { stamp: 0, savedAt: "", email, size: 0, hasConflict: fs.existsSync(cFile), data: null });
      }
      return;
    }
    finish(200, {
      stamp: record.stamp || 0,
      savedAt: record.savedAt || "",
      email,
      size: payloadSize(record),
      hasConflict: fs.existsSync(cFile),
      data: record.data
    });
    return;
  }

  if (req.method === "PUT") {
    readBody(req, MAX_BYTES, () => {
      finish(413, { error: "payload too large, limit is " + MAX_BYTES + " bytes" });
      setTimeout(() => req.destroy(), 1000);
    }).then(raw => {
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); }
      catch (e) {
        finish(400, { error: "body is not valid JSON" });
        return;
      }
      const shaped = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        parsed.data && typeof parsed.data === "object";
      if (!shaped) {
        finish(400, { error: "unexpected payload shape" });
        return;
      }
      return withLock(aFile, () => {
        const current = readRecord(target);
        const stamp = (current && current.stamp) || 0;
        if (!wantConflict) {
          const expected = req.headers["if-match"];
          if (expected == null) return finish(428, { error: "Refresh the app to sync safely" });
          if (expected !== String(stamp)) {
            return finish(409, { error: "Server copy changed", stamp, email,
              data: current ? current.data : null, hasConflict: fs.existsSync(cFile) });
          }
        } else if (current && current.data) {
          // One slot. A second device's copy must not overwrite the first device's
          // changes, which have nowhere else to live until they are restored or
          // discarded; that device keeps its own changes locally until then.
          const expected = req.headers["if-match"];
          if (expected == null || expected !== String(stamp)) {
            return finish(409, { error: "Another device's copy is already waiting", stamp, email, hasConflict: true });
          }
        }
        const record = { stamp: Math.max(Date.now(), stamp + 1), savedAt: new Date().toISOString(), data: parsed };
        writeRecord(target, record);
        finish(200, { stamp: record.stamp, savedAt: record.savedAt, email, size: payloadSize(record) });
      });
    }).catch(() => finish(500, { error: "Couldn't save the backup" }));
    return;
  }

  if (req.method === "DELETE") {
    withLock(aFile, () => {
      const current = readRecord(target);
      const expected = req.headers["if-match"];
      if (expected != null && expected !== String((current && current.stamp) || 0)) {
        return finish(409, { error: "Copy changed; it was kept" });
      }
      removeQuietly(target);
      if (!wantConflict) removeQuietly(cFile);
      finish(200, { ok: true });
    }).catch(() => finish(500, { error: "Couldn't remove the backup" }));
    return;
  }

  send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log("aura-sync listening on " + PORT + ", data dir " + DATA_DIR + ", max payload " + MAX_BYTES + " bytes");
});
