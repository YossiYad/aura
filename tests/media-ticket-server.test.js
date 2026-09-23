const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHmac } = require('node:crypto');
const { createMediaService, loadKey, fileTicketStore } = require('../selfhost/private-app/media/server');

async function harness(t, options = {}) {
  let clock = Date.now();
  const origin = 'https://aura.example';
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    if (options.respond) return options.respond(req, res);
    res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Length': 4,
      'Content-Range': 'bytes 0-3/100', 'Accept-Ranges': 'bytes', 'Set-Cookie': 'upstream=secret' });
    res.end('song');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const key = options.key || randomBytes(32);
  const service = createMediaService({ origin, key, now: () => clock,
    ticketStore: options.ticketStore,
    upstream: 'http://127.0.0.1:' + upstream.address().port });
  const servers = [upstream, ...Object.values(service)];
  await Promise.all(Object.values(service).map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  t.after(() => servers.forEach(s => { s.closeAllConnections(); s.close(); }));
  const url = '/videoplayback?id=song&sig=original&expire=' + Math.floor((clock + 3600000) / 1000);
  const call = (kind, route, options) => fetch('http://127.0.0.1:' + service[kind].address().port + route, options);
  const issue = (source = origin + url, headers = {}) => call('issuer', '/api/media/ticket', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-Email': 'owner@example.test', ...headers },
    body: JSON.stringify({ url: source }) });
  const ticket = async () => { const res = await issue(); assert.equal(res.status, 201); return res.json(); };
  const play = (ticket, options) => { const u = new URL(ticket.url); return call('playback', u.pathname + u.search, options); };
  return { origin, url, key, service, received, call, issue, ticket, play, advance: ms => { clock += ms; } };
}

test('receiver without a login can GET/HEAD only its signed stream, with byte ranges', async t => {
  const h = await harness(t), ticket = await h.ticket();
  const res = await h.play(ticket, { headers: { Range: 'bytes=0-3', 'If-Range': 'etag', Cookie: 'private=secret',
    Authorization: 'Bearer secret', 'X-Forwarded-Email': 'owner@example.test' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'song');
  assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(h.received[0].url, h.url);
  assert.equal(h.received[0].headers.range, 'bytes=0-3');
  assert.equal(h.received[0].headers['if-range'], 'etag');
  for (const name of ['cookie', 'authorization', 'x-forwarded-email']) assert.equal(h.received[0].headers[name], undefined);
  const head = await h.play(ticket, { method: 'HEAD' });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  assert.equal(h.received[1].method, 'HEAD');
  const preflight = await h.play(ticket, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(h.received.length, 2);
});

test('ticket creation requires authentication, same origin and JSON on the private listener', async t => {
  const h = await harness(t);
  assert.equal((await h.issue(undefined, { 'X-Forwarded-Email': '' })).status, 401);
  assert.equal((await h.issue(undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.issue(undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await h.call('issuer', '/api/media/ticket')).status, 405);
  assert.equal((await h.call('playback', '/api/media/ticket', { method: 'POST',
    headers: { 'X-Forwarded-Email': 'owner@example.test' } })).status, 404);
  assert.equal(h.received.length, 0);
});

test('issuer rejects arbitrary destinations, private APIs, expired URLs and malformed bodies', async t => {
  const h = await harness(t);
  for (const source of ['https://evil.example/videoplayback?id=song', '/api/sync/?id=song',
    '/latest_version?id=song', '//evil.example/videoplayback?id=song', '/videoplayback',
    'https://user:pass@aura.example/videoplayback?id=song', '/videoplayback?id=song#fragment',
    '/videoplayback?expire=invalid', '/videoplayback?value=' + 'x'.repeat(4096)]) {
    assert.equal((await h.issue(source)).status, 400, source.slice(0, 80));
  }
  assert.equal((await h.issue('/videoplayback?expire=1')).status, 410);
  const malformed = await h.call('issuer', '/api/media/ticket', { method: 'POST', body: '{',
    headers: { Origin: h.origin, 'Content-Type': 'application/json', 'X-Forwarded-Email': 'owner' } });
  assert.equal(malformed.status, 400);
  assert.equal(h.received.length, 0);
});

test('missing, tampered, expired and repurposed tickets never reach the upstream', async t => {
  const h = await harness(t), ticket = await h.ticket();
  assert.equal((await h.call('playback', '/media/play')).status, 403);
  assert.equal((await h.call('playback', '/media/play?ticket=invalid')).status, 403);
  const u = new URL(ticket.url);
  const [version, id, signature] = u.searchParams.get('ticket').split('.');
  const changedId = (id[0] === 'a' ? 'b' : 'a') + id.slice(1);
  u.searchParams.set('ticket', version + '.' + changedId + '.' + signature);
  assert.equal((await h.play({ url: u.href })).status, 403);
  assert.equal((await h.play({ url: ticket.url + '&url=https://evil.example' })).status, 403);
  assert.equal((await h.play({ url: ticket.url + '&ticket=extra' })).status, 403);
  assert.equal((await h.play(ticket, { method: 'POST' })).status, 405);
  assert.equal((await h.call('playback', '/api/sync/')).status, 404);
  h.advance(3600000);
  assert.equal((await h.play(ticket)).status, 403);
  assert.equal(h.received.length, 0);
});

test('long upstream URLs produce short links that survive a receiver URL limit', async t => {
  const h = await harness(t);
  const source = h.origin + '/videoplayback?id=song&sig=' + 'x'.repeat(3500);
  const issued = await h.issue(source);
  assert.equal(issued.status, 201);
  const ticket = await issued.json();
  assert.ok(ticket.url.length < 200, 'URL length does not grow with the upstream signature');
  assert.equal(ticket.url.includes('xxxx'), false);
  const receiverUrl = ticket.url.slice(0, 2048);
  const res = await h.play({ url: receiverUrl }, { headers: { Range: 'bytes=0-', 'User-Agent': 'samsung-agent/1.1' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'song');
  assert.equal(h.received[0].url, new URL(source).pathname + new URL(source).search);
});

test('legacy self-contained links remain valid and retain their original expiry', async t => {
  const h = await harness(t);
  const payload = Buffer.from(JSON.stringify({ path: h.url, expiresAt: Date.now() + 60000 })).toString('base64url');
  const signature = createHmac('sha256', h.key).update(payload).digest('base64url');
  const ticket = { url: h.origin + '/media/play?ticket=' + payload + '.' + signature };
  assert.equal((await h.play(ticket)).status, 206);
  h.advance(61000);
  assert.equal((await h.play(ticket)).status, 403);
  assert.equal(h.received.length, 1);
});

test('invalid signatures cannot read stored tickets and missing records fail closed', async t => {
  let reads = 0;
  const h = await harness(t, { ticketStore: { set() {}, get() { reads++; return null; } } });
  const ticket = await h.ticket();
  const url = new URL(ticket.url);
  const value = url.searchParams.get('ticket');
  const dot = value.lastIndexOf('.') + 1;
  url.searchParams.set('ticket', value.slice(0, dot) + (value[dot] === 'a' ? 'b' : 'a') + value.slice(dot + 1));
  assert.equal((await h.play({ url: url.href })).status, 403);
  assert.equal(reads, 0);
  assert.equal((await h.play(ticket)).status, 403);
  assert.equal(reads, 1);
  assert.equal(h.received.length, 0);
});

test('compact links survive a service restart using the persistent ticket directory', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-media-tickets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const first = await harness(t, { key, ticketStore: fileTicketStore(dir) });
  const ticket = await first.ticket();
  const second = await harness(t, { key, ticketStore: fileTicketStore(dir) });
  const response = await second.play(ticket);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'song');
  assert.equal(second.received[0].url, first.url);
  const file = fs.readdirSync(dir)[0];
  assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, file), 'incomplete');
  assert.equal((await second.play(ticket)).status, 403);
  assert.equal(second.received.length, 1);
});

test('ticket storage failures do not issue unusable links', async t => {
  const h = await harness(t, { ticketStore: { set() { throw new Error('storage unavailable'); } } });
  const response = await h.issue();
  assert.notEqual(response.status, 201);
  assert.equal((await response.json()).url, undefined);
});

test('persistent ticket cleanup removes only records older than the maximum lifetime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-media-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expired = 'a'.repeat(24), current = 'b'.repeat(24);
  const old = path.join(dir, expired + '.json');
  fs.writeFileSync(old, '{}');
  const past = new Date(Date.now() - 7 * 3600000);
  fs.utimesSync(old, past, past);
  fs.writeFileSync(path.join(dir, 'unrelated'), 'retain');
  const store = fileTicketStore(dir);
  await store.set(current, '{"path":"/videoplayback?id=current"}');
  assert.equal(await store.get(expired), null);
  assert.match(await store.get(current), /current/);
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated'), 'utf8'), 'retain');
  await assert.rejects(store.get('../signing-key'));
});

test('tickets are bounded by six hours and the original source expiry', async t => {
  const h = await harness(t);
  const ticket = await h.ticket();
  assert.equal(ticket.expiresAt, Number(new URL(h.url, h.origin).searchParams.get('expire')) * 1000);
  const long = await (await h.issue('/videoplayback?id=long')).json();
  h.advance(6 * 3600000);
  assert.equal((await h.play(long)).status, 403);
});

for (const scenario of ['redirect', 'html', 'range', 'disconnect']) {
  test('upstream ' + scenario + ' cannot leak private pages or escape the media proxy', async t => {
    const h = await harness(t, { respond(req, res) {
      if (scenario === 'redirect') { res.writeHead(302, { Location: 'http://private.internal/secret' }); res.end(); }
      if (scenario === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('private page'); }
      if (scenario === 'range') { res.writeHead(416, { 'Content-Range': 'bytes */100' }); res.end('upstream error'); }
      if (scenario === 'disconnect') req.socket.destroy();
    } });
    const res = await h.play(await h.ticket());
    assert.equal(res.status, scenario === 'range' ? 416 : 502);
    assert.equal(res.headers.get('location'), null);
    assert.equal((await res.text()).includes('private'), false);
    if (scenario === 'range') assert.equal(res.headers.get('content-range'), 'bytes */100');
    assert.equal(h.received.length, 1);
  });
}

test('signing key survives restarts and is private on disk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-media-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key');
  const first = loadKey(file);
  assert.deepEqual(loadKey(file), first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'broken');
  assert.throws(() => loadKey(file), /Invalid media signing key/);
});
