const http = require('node:http');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TTL = 6 * 60 * 60 * 1000;
const MAX_SOURCE = 4096;

function loadKey(file) {
  try { fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('Invalid media signing key');
  return key;
}

// Keep receiver URLs short. Some TVs truncate the old self-contained tickets,
// which carried the entire upstream URL and routinely exceeded 2 KB.
// Files share the signing key's persistent volume, so restarts retain playback.
function fileTicketStore(directory, now = Date.now) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = id => {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) throw new Error('Invalid ticket ID');
    return path.join(directory, id + '.json');
  };
  let nextCleanup = 0;
  async function cleanup() {
    if (now() < nextCleanup) return;
    nextCleanup = now() + 600000;
    for (const name of await fs.promises.readdir(directory)) {
      if (!/^[A-Za-z0-9_-]{24}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs + TTL < now()) await fs.promises.unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return {
    async set(id, data) {
      // Each ID is random and is returned only after the complete write. Never
      // overwrite an existing capability or expose a partially written record.
      await fs.promises.writeFile(filename(id), data, { flag: 'wx', mode: 0o600 });
      await cleanup().catch(() => console.warn('Expired media ticket cleanup failed'));
    },
    async get(id) {
      try { return await fs.promises.readFile(filename(id), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  };
}

// Only the issuer receives the trusted identity from the authentication gateway.
// The public listener can serve a signed stream, but cannot create a ticket.
function createMediaService({ origin, key, upstream = 'http://invidious:3000', now = Date.now,
  ticketStore = new Map() }) {
  origin = new URL(origin).origin;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A media signing key is required');
  const base = new URL(upstream);
  if (base.protocol !== 'http:') throw new Error('Expected an internal HTTP upstream');
  const rates = new Map();
  const mac = payload => createHmac('sha256', key).update(payload).digest();
  function sourceUrl(value) {
    if (typeof value !== 'string' || value.length > MAX_SOURCE || /[\s\\#]/.test(value)) throw new Error('Invalid source');
    const url = new URL(value, origin);
    if (url.href.length > MAX_SOURCE || url.origin !== origin || url.username || url.password || url.pathname !== '/videoplayback' || !url.search) {
      throw new Error('Invalid source');
    }
    return url;
  }
  function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
  const issuer = http.createServer(async (req, res) => {
    if (req.url !== '/api/media/ticket') return send(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    const email = req.headers['x-forwarded-email'];
    if (!email) return send(res, 401, { error: 'Sign in required' });
    if (req.headers.origin !== origin) return send(res, 403, { error: 'Origin rejected' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      return send(res, 415, { error: 'JSON required' });
    }
    for (const [id, entry] of rates) if (entry.until <= now()) rates.delete(id);
    const rate = rates.get(email) || { count: 0, until: now() + 600000 };
    rates.set(email, rate);
    if (++rate.count > 240) return send(res, 429, { error: 'Too many tickets' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) return send(res, 413, { error: 'Request too large' });
      }
      const source = sourceUrl(JSON.parse(body).url);
      let expiresAt = now() + TTL;
      if (source.searchParams.has('expire')) {
        const expiry = source.searchParams.get('expire');
        if (!/^\d{1,12}$/.test(expiry)) throw new Error('Invalid expiry');
        expiresAt = Math.min(expiresAt, Number(expiry) * 1000);
      }
      if (expiresAt <= now() + 30000) return send(res, 410, { error: 'Source expired' });
      const id = randomBytes(18).toString('base64url');
      await ticketStore.set(id, JSON.stringify({ path: source.pathname + source.search, expiresAt }));
      const payload = 'v2.' + id;
      const ticket = payload + '.' + mac(payload).toString('base64url');
      send(res, 201, { url: origin + '/media/play?ticket=' + ticket, expiresAt });
    } catch { if (!res.destroyed) send(res, 400, { error: 'Invalid media source' }); }
  });
  issuer.requestTimeout = 15000;

  const playback = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, origin); }
    catch { return send(res, 400, { error: 'Invalid URL' }); }
    if (url.pathname !== '/media/play') return send(res, 404, { error: 'Not found' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Read only' });
    let source;
    try {
      const tickets = url.searchParams.getAll('ticket');
      if (tickets.length !== 1 || [...url.searchParams.keys()].some(k => k !== 'ticket')) throw new Error();
      const ticket = tickets[0];
      const compact = /^v2\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(ticket);
      if (ticket.length > 7000 || (!compact && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket))) throw new Error();
      const separator = ticket.lastIndexOf('.');
      const payload = ticket.slice(0, separator), signature = ticket.slice(separator + 1);
      const expected = mac(payload);
      const provided = Buffer.from(signature, 'base64url');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error();
      // Verify before reading a stored capability. Legacy URLs remain usable on
      // phones and existing receiver sessions until their original expiry.
      const data = JSON.parse(compact ? await ticketStore.get(payload.slice(3)) : Buffer.from(payload, 'base64url'));
      if (!data) throw new Error();
      if (!Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now() || data.expiresAt > now() + TTL) throw new Error();
      source = sourceUrl(data.path);
    } catch { return send(res, 403, { error: 'Invalid or expired media ticket' }); }

    // The destination is fixed. No browser credentials or caller-supplied host headers
    // leave this service, and upstream redirects cannot escape the signed media path.
    const headers = {};
    for (const name of ['range', 'if-range']) if (req.headers[name]) headers[name] = req.headers[name];
    const proxy = http.request({ hostname: base.hostname, port: base.port || 80,
      path: source.pathname + source.search, method: req.method, headers }, incoming => {
      const status = incoming.statusCode;
      const type = incoming.headers['content-type'] || '';
      if (![200, 206].includes(status) || !/^(?:audio\/|video\/mp4|application\/octet-stream)/i.test(type)) {
        incoming.destroy();
        if (status === 416 && incoming.headers['content-range']) res.setHeader('Content-Range', incoming.headers['content-range']);
        return send(res, status >= 400 && status < 500 ? status : 502, { error: 'Stream unavailable' });
      }
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        if (incoming.headers[name]) res.setHeader(name, incoming.headers[name]);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.writeHead(status);
      // The idle timer is for an upstream that never answers. Once the body is flowing, a
      // quiet socket is a player that has buffered enough and stopped reading, and cutting
      // it ended a healthy stream twenty seconds into a pause.
      proxy.setTimeout(0);
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    proxy.setTimeout(20000, () => proxy.destroy(new Error('Upstream timeout')));
    proxy.on('error', () => {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) send(res, 502, { error: 'Stream unavailable' });
    });
    res.on('close', () => proxy.destroy());
    proxy.end();
  });
  return { issuer, playback };
}

if (require.main === module) {
  const service = createMediaService({ origin: process.env.PUBLIC_ORIGIN,
    key: loadKey('/data/signing-key'), upstream: process.env.INVIDIOUS_BASE,
    ticketStore: fileTicketStore('/data/tickets') });
  service.issuer.listen(8093, '0.0.0.0');
  service.playback.listen(8094, '0.0.0.0');
  console.log('Media ticket issuer and playback listener ready');
}
module.exports = { createMediaService, loadKey, fileTicketStore };
