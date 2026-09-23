const http = require('node:http');
const { randomBytes } = require('node:crypto');

// Separate listeners are an authorization boundary: the public listener has no host
// routes, regardless of any identity headers a visitor supplies.
function createQueueService(options = {}) {
  const now = options.now || Date.now;
  const searchFetch = options.fetch || fetch;
  const origin = new URL(options.origin || process.env.PUBLIC_ORIGIN || 'http://localhost');
  const upstream = options.upstream || process.env.INVIDIOUS_BASE || 'http://invidious:3000';
  const rooms = new Map(), rates = new Map();
  const token = () => randomBytes(24).toString('base64url');
  const permissions = ['approval', 'direct', 'vote'];
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  // Control characters and bidi overrides would reorder or hide the moderation card
  // a guest name is shown on; they are data, not formatting.
  const text = (value, max) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, max) : '';
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
  const REJECTED_JOIN_TTL = 15 * 60000;
  const MAX_REQUESTS = 200;
  function prune() {
    for (const [id, room] of rooms) {
      if (room.expiresAt <= now()) { rooms.delete(id); continue; }
      // A rejected join keeps its cookie's answer for a while, then frees its slot:
      // a hundred rejected attempts used to fill the room for its whole lifetime.
      for (const [gid, g] of room.guests) {
        // Counted from the decision: a request rejected after a long wait was dropped at
        // once, which freed the guest to ask again and left the hosts' undo with a 404.
        if (g.status === 'rejected' && now() - (g.decidedAt || g.createdAt) > REJECTED_JOIN_TTL) room.guests.delete(gid);
      }
    }
    for (const [id, rate] of rates) if (rate.until <= now()) rates.delete(id);
  }
  function limit(key, max) {
    let rate = rates.get(key);
    if (!rate || rate.until <= now()) { rate = { until: now() + 60000, count: 0 }; rates.set(key, rate); }
    if (++rate.count > max) fail(429, 'יותר מדי בקשות. נסו שוב בעוד דקה.');
  }
  function send(res, status, body, extra = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(data);
  }
  async function readBody(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON required');
    let length = 0; const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) fail(413, 'Request too large');
      chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks));
      if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'Invalid request');
      return value;
    } catch { fail(400, 'Invalid request'); }
  }
  function checkOrigin(req) {
    if (req.headers.origin && req.headers.origin !== origin.origin) fail(403, 'Origin not allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Origin not allowed');
  }
  function snapshot(room, guest, host = false, device = '') {
    const joinStatus = guest ? guest.status || 'approved' : 'none';
    const joined = joinStatus === 'approved';
    const participants = Array.from(room.guests.values()).filter(g => !g.status || g.status === 'approved');
    const requests = host || joined ? room.requests.map(item => ({
      id: item.id, track: item.track, name: item.name || (room.guests.get(item.guest) || {}).name || '',
      fromHost: item.guest === null, status: item.status, votes: item.votes.size, voted: !!guest && item.votes.has(guest.id),
      mine: !!guest && item.guest === guest.id, createdAt: item.createdAt, queueOrder: item.queueOrder,
      ...(host ? { deliver: item.status === 'approved' && !item.delivered && item.device === device,
        delivered: !!item.delivered } : {})
    })).sort((a, b) => {
      const rank = { pending: 0, approved: 1, rejected: 2 };
      if (a.status !== b.status) return rank[a.status] - rank[b.status];
      // Votes rank proposals only. Once accepted, songs keep their acceptance order.
      return a.status === 'approved' ? a.queueOrder - b.queueOrder : b.votes - a.votes || a.createdAt - b.createdAt;
    }) : [];
    return { id: room.id, title: room.title, expiresAt: room.expiresAt,
      joined, joinStatus, name: guest ? guest.name : '', permission: joined ? guest.permission : null, requests,
      ...(host ? { inviteUrl: origin.origin + '/guest/#' + room.id, guestCount: participants.length,
        permission: room.permission, mode: room.mode, isController: room.controller === device,
        guests: participants.map(g => ({ id: g.id, name: g.name, permission: g.permission, online: now() - g.lastSeen < 30000 })),
        joinRequests: Array.from(room.guests.values()).filter(g => g.status === 'pending')
          .map(g => ({ id: g.id, name: g.name, createdAt: g.createdAt, online: now() - g.lastSeen < 30000 })) } : {}) };
  }
  function ensureActive(room) {
    if (!rooms.has(room.id) || room.expiresAt <= now()) fail(410, 'AuraShare נסגר או שהקישור פג תוקף.');
  }
  function getGuest(req, room) {
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)aura_queue_guest=([A-Za-z0-9_-]{32})(?:;|$)/);
    return cookie ? room.guests.get(cookie[1]) : null;
  }
  function cleanTrack(item) {
    if (!item || item.type !== 'video' || !/^[A-Za-z0-9_-]{11}$/.test(item.videoId) || item.liveNow) return null;
    return { id: item.videoId, title: text(item.title, 300), artist: text(item.author, 200),
      duration: Math.max(0, Math.min(86400, Number(item.lengthSeconds) || 0)),
      thumb: 'https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg',
      artistId: /^UC[A-Za-z0-9_-]{22}$/.test(item.authorId) ? item.authorId : null };
  }
  async function search(room, query) {
    const url = new URL('/api/v1/search', upstream);
    url.search = new URLSearchParams({ q: query, type: 'video' }).toString();
    let items;
    try {
      const response = await searchFetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw Error('search unavailable');
      // Bound responses from the upstream as well as requests from guests.
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 2097152) throw Error('search too large'); chunks.push(Buffer.from(value));
      } } finally { await reader.cancel(); }
      items = JSON.parse(Buffer.concat(chunks));
      if (!Array.isArray(items)) throw Error('invalid search');
    } catch { fail(502, 'החיפוש לא זמין כרגע. נסו שוב.'); }
    if (!rooms.has(room.id) || room.expiresAt <= now()) fail(410, 'AuraShare נסגר או שהקישור פג תוקף.');
    const tracks = items.map(cleanTrack).filter(Boolean).slice(0, 20);
    for (const track of tracks) room.results.set(track.id, { track, at: now() });
    while (room.results.size > 500) room.results.delete(room.results.keys().next().value);
    return tracks;
  }
  function handler(host) {
    return async (req, res) => {
      try {
        prune(); checkOrigin(req);
        const path = new URL(req.url, origin).pathname;
        const method = req.method;
        if (host) {
          if (!path.startsWith('/api/queue/')) fail(404, 'Not found');
          const email = text(req.headers['x-forwarded-email'], 254).toLowerCase();
          if (!email || !email.includes('@')) fail(401, 'Sign in required');
          limit('host:' + email, 180);
          const device = req.headers['x-queue-device'] || '';
          const current = () => Array.from(rooms.values()).find(room => room.owner === email);
          if (path === '/api/queue/' && method === 'GET') {
            const room = current(); return send(res, 200, { available: true, room: room ? snapshot(room, null, true, device) : null });
          }
          if (path === '/api/queue/' && method === 'POST') {
            const body = await readBody(req);
            const mode = body.mode === undefined ? 'standalone' : body.mode;
            if (!['standalone', 'existing-queue'].includes(mode)) fail(400, 'Invalid queue mode');
            const existing = current();
            if (existing) return send(res, 200, { room: snapshot(existing, null, true, device) });
            if (rooms.size >= 100) fail(503, 'Shared queue capacity reached');
            if (!validToken(device)) fail(400, 'Device ID required');
            const hours = [1, 4, 8, 24].includes(body.hours) ? body.hours : 8;
            const room = { id: token(), owner: email, title: text(body.title, 80) || 'AuraShare', mode,
              permission: permissions.includes(body.permission) ? body.permission : 'approval', controller: device,
              expiresAt: now() + hours * 3600000, guests: new Map(), requests: [], results: new Map(), nextQueueOrder: 0 };
            rooms.set(room.id, room);
            return send(res, 201, { room: snapshot(room, null, true, device) });
          }
          const room = current();
          if (!room) fail(410, 'AuraShare נסגר או שהקישור פג תוקף.');
          if (path === '/api/queue/' + room.id + '/search' && method === 'POST') {
            const body = await readBody(req); ensureActive(room);
            limit('search:' + room.id, 60);
            const query = text(body.query, 160);
            if (query.length < 2) fail(400, 'הקלידו לפחות שני תווים.');
            return send(res, 200, { tracks: await search(room, query) });
          }
          if (path === '/api/queue/' + room.id + '/requests' && method === 'POST') {
            const body = await readBody(req); ensureActive(room);
            const found = room.results.get(body.trackId);
            if (!found || now() - found.at > 600000) fail(400, 'חפשו את השיר שוב לפני ההוספה.');
            if (room.requests.some(item => item.track.id === body.trackId && item.status !== 'rejected')) fail(409, 'השיר כבר נמצא בתור.');
            room.requests.push({ id: token(), guest: null, name: 'המארחים', track: found.track,
              status: 'approved', device: room.controller, votes: new Set(), createdAt: now(), queueOrder: ++room.nextQueueOrder });
            return send(res, 201, { room: snapshot(room, null, true, device) });
          }
          if (path === '/api/queue/qr.svg' && method === 'GET') {
            const requestedRoom = new URL(req.url, origin).searchParams.get('room');
            if (requestedRoom && requestedRoom !== room.id) fail(410, 'Invite expired');
            const svg = await require('qrcode').toString(origin.origin + '/guest/#' + room.id,
              { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 280 });
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store',
              'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
            return res.end(svg);
          }
          const guestMatch = path.match(/^\/api\/queue\/([A-Za-z0-9_-]{32})\/guests\/([A-Za-z0-9_-]{32})\/(approve|reject)$/);
          if (guestMatch && guestMatch[1] === room.id && method === 'POST') {
            const body = await readBody(req); ensureActive(room);
            const person = room.guests.get(guestMatch[2]);
            if (!person) fail(404, 'בקשת ההצטרפות לא נמצאה.');
            const approving = guestMatch[3] === 'approve';
            if (approving && !permissions.includes(body.permission)) fail(400, 'בחרו הרשאה לאורח.');
            const status = approving ? 'approved' : 'rejected';
            // Retrying the same decision is safe. A conflicting decision cannot
            // overwrite another host tab's approval or a later permission change.
            if (person.status === 'rejected' && approving) {
              // A mis-tap on "reject" must not lock a guest out for the room's lifetime.
              person.status = 'approved';
              person.permission = body.permission;
            } else if (person.status !== 'pending') {
              if (person.status !== status || (approving && person.permission !== body.permission)) fail(409, 'בקשת ההצטרפות כבר טופלה.');
            } else {
              person.status = status;
              if (approving) person.permission = body.permission;
              else person.decidedAt = now();
            }
            return send(res, 200, { room: snapshot(room, null, true, device) });
          }
          const settingsMatch = path.match(/^\/api\/queue\/([A-Za-z0-9_-]{32})\/(permissions|control)$/);
          if (settingsMatch && settingsMatch[1] === room.id && method === 'POST') {
            const body = await readBody(req); ensureActive(room);
            if (settingsMatch[2] === 'control') {
              if (!validToken(device)) fail(400, 'Device ID required');
              room.controller = device;
              for (const item of room.requests) if (item.status === 'approved' && !item.delivered) item.device = device;
            } else {
              if (!permissions.includes(body.permission)) fail(400, 'Invalid permission');
              if (body.guestId) {
                const guest = room.guests.get(body.guestId); if (!guest) fail(404, 'Guest not found');
                if (guest.status && guest.status !== 'approved') fail(409, 'יש לאשר את בקשת ההצטרפות תחילה.');
                guest.permission = body.permission;
              } else room.permission = body.permission;
            }
            return send(res, 200, { room: snapshot(room, null, true, device) });
          }
          // Session ID on every mutation prevents a stale sheet closing or modifying a new room.
          const match = path.match(/^\/api\/queue\/([A-Za-z0-9_-]{32})(?:\/requests\/([A-Za-z0-9_-]{32})\/(approve|reject|ack))?$/);
          if (!match || match[1] !== room.id) fail(404, 'Not found');
          if (method === 'DELETE' && !match[2]) { rooms.delete(room.id); return send(res, 200, { closed: true }); }
          if (method !== 'POST' || !match[2]) fail(405, 'Method not allowed');
          await readBody(req); ensureActive(room);
          const item = room.requests.find(item => item.id === match[2]);
          if (!item) fail(404, 'Request not found');
          const action = match[3];
          if (action === 'approve') {
            if (room.controller !== device) fail(409, 'הניהול פעיל במכשיר אחר. העבירו את הניהול למכשיר הזה כדי לאשר.');
            if (!validToken(device)) fail(400, 'Device ID required');
            if (item.status === 'pending') { item.status = 'approved'; item.device = device; item.queueOrder = ++room.nextQueueOrder; }
            else if (item.status !== 'approved' || item.device !== device) fail(409, 'ההצעה כבר טופלה במכשיר אחר.');
          } else if (action === 'ack') {
            if (item.status !== 'approved' || item.device !== device) fail(409, 'Approval belongs to another device');
            item.delivered = true;
          } else {
            if (item.status !== 'pending') fail(409, 'ההצעה כבר טופלה.');
            item.status = 'rejected';
            item.decidedAt = now();
          }
          return send(res, 200, { room: snapshot(room, null, true, device) });
        }
        // Ignore X-Forwarded-Email here. Possession of a QR invite grants guest actions only.
        if (!/^\/guest\/api\/(state|join|search|suggest|vote)$/.test(path)) fail(404, 'Not found');
        const invite = req.headers['x-queue-invite'];
        const room = validToken(invite) && rooms.get(invite);
        if (!room) fail(410, 'AuraShare נסגר או שהקישור פג תוקף.');
        // The shared budget counts only requests carrying a valid invite. Charged before
        // the check, anyone on the internet could spend it with bogus invites and lock
        // every guest of every room out for the rest of the minute.
        // Polls have a budget of their own: at eight seconds a page, the room's action
        // budget was spent by eighty open guest pages, and nobody could join or vote.
        if (path === '/guest/api/state' && method === 'GET') limit('poll:' + room.id, 1500);
        else { limit('public', 1200); limit('room:' + room.id, 600); }
        let guest = getGuest(req, room);
        if (guest) guest.lastSeen = now();
        if (path === '/guest/api/state' && method === 'GET') return send(res, 200, { room: snapshot(room, guest) });
        if (path === '/guest/api/join' && method === 'POST') {
          const body = await readBody(req); ensureActive(room);
          if (!guest) {
            limit('join:' + room.id, 20);
            if (Array.from(room.guests.values()).filter(g => g.status !== 'rejected').length >= 100) fail(429, 'התור מלא כרגע.');
            const name = text(body.name, 40); if (!name) fail(400, 'בחרו שם להצטרפות.');
            guest = { id: token(), name, status: 'pending', permission: null, createdAt: now(), lastSeen: now() }; room.guests.set(guest.id, guest);
          }
          return send(res, 200, { room: snapshot(room, guest) }, { 'Set-Cookie':
            'aura_queue_guest=' + guest.id + '; Path=/guest/; HttpOnly; SameSite=Strict; Max-Age=86400' +
            (origin.protocol === 'https:' ? '; Secure' : '') });
        }
        if (!guest) fail(401, 'הצטרפו לתור כדי להציע שירים.');
        if (guest.status && guest.status !== 'approved') fail(403, guest.status === 'pending' ? 'בקשת ההצטרפות ממתינה לאישור המארחים.' : 'בקשת ההצטרפות לא אושרה.');
        limit('guest:' + guest.id, 90);
        if (path === '/guest/api/search' && method === 'POST') {
          // The guest's own cap first: searches it refuses must not be charged to the
          // room, or one guest typing could shut search for everyone, hosts included.
          limit('search:' + guest.id, 12); limit('search:' + room.id, 60);
          const body = await readBody(req); const query = text(body.query, 160);
          if (query.length < 2) fail(400, 'הקלידו לפחות שני תווים.');
          return send(res, 200, { tracks: await search(room, query) });
        }
        if (path === '/guest/api/suggest' && method === 'POST') {
          const body = await readBody(req); ensureActive(room);
          if (guest.permission === 'vote') fail(403, 'ההרשאה שלך מאפשרת צפייה והצבעה בלבד.');
          const found = room.results.get(body.trackId);
          if (!found || now() - found.at > 600000) fail(400, 'חפשו את השיר שוב לפני ההצעה.');
          if (room.requests.some(item => item.track.id === body.trackId && item.status !== 'rejected')) fail(409, 'השיר כבר הוצע. אפשר להצביע לו.');
          if (room.requests.some(item => item.track.id === body.trackId && item.status === 'rejected' && now() - (item.decidedAt || item.createdAt) < 600000)) {
            fail(409, 'השיר נדחה לפני זמן קצר. נסו שוב מאוחר יותר.');
          }
          room.requests.push({ id: token(), guest: guest.id, track: found.track, status: guest.permission === 'direct' ? 'approved' : 'pending',
            device: guest.permission === 'direct' ? room.controller : '',
            votes: new Set(), createdAt: now(), queueOrder: guest.permission === 'direct' ? ++room.nextQueueOrder : undefined });
          // Every poll serialises the whole list; the oldest settled entries go first.
          while (room.requests.length > MAX_REQUESTS) {
            const settled = room.requests.findIndex(item => item.status === 'rejected' || (item.status === 'approved' && item.delivered));
            room.requests.splice(settled === -1 ? 0 : settled, 1);
          }
          return send(res, 201, { room: snapshot(room, guest) });
        }
        if (path === '/guest/api/vote' && method === 'POST') {
          const body = await readBody(req); ensureActive(room);
          if (typeof body.voted !== 'boolean') fail(400, 'Invalid vote');
          const item = room.requests.find(item => item.id === body.id && item.status === 'pending');
          if (!item) fail(409, 'ההצעה כבר טופלה.');
          if (body.voted) item.votes.add(guest.id); else item.votes.delete(guest.id);
          return send(res, 200, { room: snapshot(room, guest) });
        }
        fail(405, 'Method not allowed');
      } catch (error) {
        if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'השירות לא זמין כרגע. נסו שוב.' });
        else res.end();
      }
    };
  }
  return { host: http.createServer(handler(true)), guest: http.createServer(handler(false)) };
}

if (require.main === module) {
  if (!process.env.PUBLIC_ORIGIN || !/^https:\/\//.test(process.env.PUBLIC_ORIGIN)) throw Error('PUBLIC_ORIGIN must be the public HTTPS origin');
  const service = createQueueService();
  service.host.listen(Number(process.env.PORT) || 8091, '0.0.0.0');
  service.guest.listen(Number(process.env.GUEST_PORT) || 8092, '0.0.0.0');
}
module.exports = { createQueueService };
