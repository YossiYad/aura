const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueService } = require('../selfhost/private-app/queue/server');
const device = 'a'.repeat(32), otherDevice = 'b'.repeat(32);
const tracks = Array.from({ length: 12 }, (_, i) => ({ type: 'video', videoId: 'track' + String(i).padStart(6, '0'), title: 'Song ' + i, author: 'Artist', lengthSeconds: 180 }));

async function harness(t, options = {}) {
  let clock = Date.now();
  const origin = 'https://aura.example';
  const service = createQueueService({ origin, now: () => clock,
    fetch: async () => new Response(JSON.stringify(tracks)), ...options });
  await Promise.all(Object.values(service).map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  t.after(() => { for (const server of Object.values(service)) { server.closeAllConnections(); server.close(); } });
  async function call(kind, path, method = 'GET', body, headers = {}) {
    const res = await fetch('http://127.0.0.1:' + service[kind].address().port + path, { method,
      headers: { origin, ...(kind === 'host' ? { 'x-forwarded-email': 'owner@example.test', 'x-queue-device': device } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: res.status, data, cookie: res.headers.get('set-cookie'), headers: res.headers };
  }
  const host = (path = '', method, body, headers) => call('host', '/api/queue/' + path, method, body, headers);
  const create = async permission => (await host('', 'POST', { permission, hours: 1 })).data.room;
  const guest = (room, cookie, action, body, headers) => call('guest', '/guest/api/' + action, body === undefined ? 'GET' : 'POST', body,
    { 'x-queue-invite': room.id, ...(cookie ? { cookie } : {}), ...headers });
  const join = async (room, name = 'Guest') => {
    const result = await guest(room, null, 'join', { name });
    assert.equal(result.status, 200);
    const state = (await host()).data.room;
    const person = state.joinRequests.find(person => person.id === result.cookie.split('=')[1].split(';')[0]);
    assert(person);
    assert.equal((await host(room.id + '/guests/' + person.id + '/approve', 'POST', { permission: state.permission })).status, 200);
    return result.cookie.split(';')[0];
  };
  return { call, host, create, guest, join, advance: ms => { clock += ms; } };
}

test('public listener cannot access host controls, even with spoofed identity', async t => {
  const h = await harness(t);
  assert.equal((await h.call('guest', '/api/queue/', 'POST', {}, { 'x-forwarded-email': 'owner@example.test' })).status, 404);
  assert.equal((await h.host('', 'GET', undefined, { 'x-forwarded-email': '' })).status, 401);
  const room = await h.create();
  assert.equal((await h.host(room.id, 'DELETE', undefined, { 'x-forwarded-email': 'other@example.test' })).status, 410);
  assert.equal((await h.call('guest', '/guest/api/state', 'GET', undefined, { 'x-queue-invite': 'z'.repeat(32) })).status, 410);
  assert.equal((await h.guest(room, null, 'search', { query: 'Artist' })).status, 401);
  assert.equal((await h.guest(room, null, 'join', { name: 'Guest' }, { origin: 'https://evil.example' })).status, 403);
});

test('room mode defaults to standalone, rejects unknown values and cannot change after creation', async t => {
  const h = await harness(t);
  for (const mode of ['other', '', null, 0]) assert.equal((await h.host('', 'POST', { mode })).status, 400);
  assert.equal((await h.host()).data.room, null);
  const legacy = await h.create();
  assert.equal(legacy.mode, 'standalone');
  const reopened = (await h.host('', 'POST', { mode: 'existing-queue' })).data.room;
  assert.equal(reopened.id, legacy.id);
  assert.equal(reopened.mode, 'standalone');
  await h.host(legacy.id, 'DELETE');
  const room = (await h.host('', 'POST', { mode: 'existing-queue' })).data.room;
  assert.equal(room.mode, 'existing-queue');
  assert.equal((await h.host()).data.room.mode, 'existing-queue');
  const fromCreate = (await h.host('', 'POST', { mode: 'standalone' })).data.room;
  assert.equal(fromCreate.id, room.id);
  assert.equal(fromCreate.mode, 'existing-queue');
});

test('existing-queue preserves admission, song approval, direct additions, device transfer and expiry', async t => {
  const h = await harness(t);
  const room = (await h.host('', 'POST', { mode: 'existing-queue', permission: 'approval', hours: 1 })).data.room;
  const cookie = await h.join(room, 'Guest');
  const state = (await h.guest(room, cookie, 'state')).data.room;
  for (const key of ['mode', 'queue', 'owner', 'controller', 'isController']) assert.equal(key in state, false);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId });
  let host = (await h.host()).data.room;
  assert.equal(host.requests[0].status, 'pending');
  assert.equal(host.requests[0].deliver, false);
  const approved = await h.host(room.id + '/requests/' + host.requests[0].id + '/approve', 'POST', {});
  assert.equal(approved.data.room.mode, 'existing-queue');
  assert.equal(approved.data.room.requests[0].deliver, true);
  await h.host(room.id + '/requests/' + host.requests[0].id + '/ack', 'POST', {});
  await h.host(room.id + '/permissions', 'POST', { guestId: host.guests[0].id, permission: 'direct' });
  await h.guest(room, cookie, 'suggest', { trackId: tracks[1].videoId });
  const moved = (await h.host(room.id + '/control', 'POST', {}, { 'x-queue-device': otherDevice })).data.room;
  assert.equal(moved.mode, 'existing-queue');
  assert.equal(moved.requests[0].deliver, false);
  assert.equal(moved.requests[1].deliver, true);
  host = (await h.host()).data.room;
  assert.equal(host.isController, false);
  assert.equal(host.requests[1].deliver, false);
  h.advance(3600001);
  assert.equal((await h.guest(room, cookie, 'state')).status, 410);
  assert.equal((await h.host()).data.room, null);
  const next = (await h.host('', 'POST', { mode: 'existing-queue' })).data.room;
  const nextCookie = await h.join(next);
  await h.host(next.id, 'DELETE');
  assert.equal((await h.guest(next, nextCookie, 'state')).status, 410);
});

test('each named arrival waits for an individual host decision and permission', async t => {
  const h = await harness(t), room = await h.create('direct');
  const a = await h.guest(room, null, 'join', { name: 'Alice', permission: 'direct', status: 'approved' });
  const b = await h.guest(room, null, 'join', { name: 'Bob' });
  const cookieA = a.cookie.split(';')[0], cookieB = b.cookie.split(';')[0];
  assert.equal(a.data.room.joined, false);
  assert.equal(a.data.room.joinStatus, 'pending');
  assert.equal(a.data.room.permission, null);
  assert.deepEqual(a.data.room.requests, []);
  assert.equal('joinRequests' in a.data.room, false);
  for (const action of ['search', 'suggest', 'vote']) assert.equal((await h.guest(room, cookieA, action, { query: 'Artist' })).status, 403);
  let state = (await h.host()).data.room;
  assert.equal(state.guests.length, 0); assert.equal(state.joinRequests.length, 2);
  const path = room.id + '/guests/' + state.joinRequests[0].id;
  assert.equal((await h.host(path + '/approve', 'POST', { permission: 'admin' })).status, 400);
  assert.equal((await h.host(path + '/approve', 'POST', { permission: 'vote' })).status, 200);
  assert.equal((await h.guest(room, cookieA, 'state')).data.room.permission, 'vote');
  assert.equal((await h.guest(room, cookieB, 'state')).data.room.joinStatus, 'pending');
  assert.equal((await h.host(path + '/approve', 'POST', { permission: 'vote' })).status, 200);
  assert.equal((await h.host(path + '/reject', 'POST', {})).status, 409);
  state = (await h.host()).data.room;
  const reject = room.id + '/guests/' + state.joinRequests[0].id + '/reject';
  assert.equal((await h.host(reject, 'POST', {})).status, 200);
  assert.equal((await h.guest(room, cookieB, 'join', { name: 'Retry' })).data.room.joinStatus, 'rejected');
  assert.equal((await h.guest(room, cookieB, 'search', { query: 'Artist' })).status, 403);
});

test('owners add validated songs to the same delivery flow without guest approval', async t => {
  const h = await harness(t), room = await h.create();
  assert.equal((await h.host(room.id + '/search', 'POST', { query: 'Artist' })).status, 200);
  const added = await h.host(room.id + '/requests', 'POST', { trackId: tracks[0].videoId });
  assert.equal(added.status, 201);
  assert.equal(added.data.room.requests[0].name, 'המארחים');
  assert.equal(added.data.room.requests[0].deliver, true);
  assert.equal((await h.host(room.id + '/requests', 'POST', { trackId: 'untrusted' })).status, 400);
});

test('QR encodes a temporary guest invite and guest payloads expose no host identity or controls', async t => {
  const h = await harness(t), room = await h.create();
  assert.match(room.inviteUrl, /^https:\/\/aura\.example\/guest\/#[A-Za-z0-9_-]{32}$/);
  const qr = await h.host('qr.svg');
  assert.equal(qr.status, 200); assert.match(qr.data, /^<svg/);
  assert.equal(qr.headers.get('cache-control'), 'no-store');
  const cookie = await h.join(room, '<script>alert(1)</script>');
  const state = (await h.guest(room, cookie, 'state')).data.room;
  assert.equal(state.name, '<script>alert(1)</script>');
  for (const key of ['owner', 'guests', 'inviteUrl', 'controller', 'isController']) assert.equal(key in state, false);
  assert.equal(JSON.stringify(state).includes('owner@example.test'), false);
});

test('approval guests can submit more than three songs, using server-resolved metadata only', async t => {
  const h = await harness(t), room = await h.create('approval'), cookie = await h.join(room);
  assert.equal((await h.guest(room, cookie, 'search', { query: 'Artist' })).status, 200);
  for (const track of tracks.slice(0, 5)) {
    const result = await h.guest(room, cookie, 'suggest', { trackId: track.videoId, track: { title: 'forged', url: 'http://private' } });
    assert.equal(result.status, 201);
  }
  const state = (await h.host()).data.room;
  assert.equal(state.requests.length, 5);
  assert(state.requests.every(item => item.status === 'pending' && item.track.title.startsWith('Song')));
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: 'notsearched' })).status, 400);
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).status, 409);
});

test('direct, approval and voting permissions are enforced per guest and can be changed', async t => {
  const h = await harness(t), room = await h.create('approval'), alice = await h.join(room, 'Alice');
  const aliceId = (await h.host()).data.room.guests[0].id;
  await h.host(room.id + '/permissions', 'POST', { guestId: aliceId, permission: 'direct' });
  await h.guest(room, alice, 'search', { query: 'Artist' });
  const direct = await h.guest(room, alice, 'suggest', { trackId: tracks[0].videoId });
  assert.equal(direct.data.room.requests[0].status, 'approved');
  assert.equal((await h.host()).data.room.requests[0].deliver, true);
  await h.host(room.id + '/permissions', 'POST', { guestId: aliceId, permission: 'vote' });
  assert.equal((await h.guest(room, alice, 'suggest', { trackId: tracks[1].videoId })).status, 403);
  await h.host(room.id + '/permissions', 'POST', { permission: 'direct' });
  const bob = await h.join(room, 'Bob');
  assert.equal((await h.guest(room, bob, 'state')).data.room.permission, 'direct');
  assert.equal((await h.guest(room, alice, 'state')).data.room.permission, 'vote');
});

test('voting is idempotent, counts distinct participants and stops after moderation', async t => {
  const h = await harness(t), room = await h.create(), a = await h.join(room, 'A'), b = await h.join(room, 'B');
  await h.guest(room, a, 'search', { query: 'Artist' });
  const item = (await h.guest(room, a, 'suggest', { trackId: tracks[0].videoId })).data.room.requests[0];
  for (const cookie of [a, a, b]) await h.guest(room, cookie, 'vote', { id: item.id, voted: true });
  assert.equal((await h.host()).data.room.requests[0].votes, 2);
  await h.guest(room, a, 'vote', { id: item.id, voted: false });
  assert.equal((await h.host()).data.room.requests[0].votes, 1);
  await h.host(room.id + '/requests/' + item.id + '/reject', 'POST', {});
  assert.equal((await h.guest(room, a, 'vote', { id: item.id, voted: true })).status, 409);
});

test('approvals survive retry and deliver only to the controlling device until acknowledged', async t => {
  const h = await harness(t), room = await h.create(), cookie = await h.join(room);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  const item = (await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).data.room.requests[0];
  const path = room.id + '/requests/' + item.id;
  assert.equal((await h.host(path + '/approve', 'POST', {}, { 'x-queue-device': otherDevice })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await h.host(path + '/approve', 'POST', {})).data.room.requests[0].deliver, true);
  assert.equal((await h.host('', 'GET', undefined, { 'x-queue-device': otherDevice })).data.room.requests[0].deliver, false);
  assert.equal((await h.host(path + '/ack', 'POST', {}, { 'x-queue-device': otherDevice })).status, 409);
  await h.host(path + '/ack', 'POST', {});
  assert.equal((await h.host()).data.room.requests[0].deliver, false);
});

test('explicit device transfer moves waiting direct additions without sharing personal queues', async t => {
  const h = await harness(t), room = await h.create('direct'), cookie = await h.join(room);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId });
  const moved = await h.host(room.id + '/control', 'POST', {}, { 'x-queue-device': otherDevice });
  assert.equal(moved.data.room.isController, true); assert.equal(moved.data.room.requests[0].deliver, true);
  assert.equal((await h.host()).data.room.requests[0].deliver, false);
});

test('closing or expiring a session revokes both the QR and joined guest cookies', async t => {
  const h = await harness(t), room = await h.create(), cookie = await h.join(room);
  await h.host(room.id, 'DELETE');
  assert.equal((await h.guest(room, cookie, 'state')).status, 410);
  const next = await h.create(); assert.notEqual(next.id, room.id);
  assert.equal((await h.host(room.id, 'DELETE')).status, 404);
  assert.equal((await h.guest(next, cookie, 'state')).data.room.joined, false);
  h.advance(3600001);
  assert.equal((await h.guest(next, null, 'join', { name: 'A' })).status, 410);
  assert.equal((await h.host()).data.room, null);
});

test('joining requires a name, and host presence expires until the named guest reconnects', async t => {
  const h = await harness(t), room = await h.create();
  assert.equal((await h.guest(room, null, 'join', { name: '   ' })).status, 400);
  const cookie = await h.join(room, 'נועה');
  let person = (await h.host()).data.room.guests[0];
  assert.equal(person.name, 'נועה'); assert.equal(person.online, true);
  h.advance(31000);
  assert.equal((await h.host()).data.room.guests[0].online, false);
  await h.guest(room, cookie, 'state');
  person = (await h.host()).data.room.guests[0];
  assert.equal(person.name, 'נועה'); assert.equal(person.online, true);
});

test('guest cannot smuggle host operations or arbitrary upstream URLs through search', async t => {
  const urls = [];
  const h = await harness(t, { fetch: async url => { urls.push(String(url)); return new Response(JSON.stringify(tracks)); } });
  const room = await h.create(), cookie = await h.join(room);
  await h.guest(room, cookie, 'search', { query: 'http://127.0.0.1/admin?x=1' });
  assert.equal(new URL(urls[0]).origin, 'http://invidious:3000');
  assert.equal(new URL(urls[0]).pathname, '/api/v1/search');
  assert.equal((await h.call('guest', '/guest/api/permissions', 'POST', { permission: 'direct' }, { 'x-queue-invite': room.id, cookie })).status, 404);
});

test('upstream failures and expired search results never accept invented metadata', async t => {
  const h = await harness(t), room = await h.create(), cookie = await h.join(room);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  h.advance(600001);
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).status, 400);
  const broken = await harness(t, { fetch: async () => { throw Error('offline'); } });
  const other = await broken.create(), otherCookie = await broken.join(other);
  assert.equal((await broken.guest(other, otherCookie, 'search', { query: 'Artist' })).status, 502);
});

test('bogus invites cannot spend the budget shared by guests holding a valid one', async t => {
  const h = await harness(t);
  const room = await h.create();
  const cookie = await h.join(room);
  const bogus = { 'x-queue-invite': 'z'.repeat(32) };
  const statuses = new Set();
  for (let i = 0; i < 1250; i++) statuses.add((await h.call('guest', '/guest/api/state', 'GET', undefined, bogus)).status);
  assert.deepEqual(Array.from(statuses), [410], 'an invalid invite is refused, never throttled in place of the guests');
  assert.equal((await h.guest(room, cookie, 'state')).status, 200);
});


test('a rejected join can be reversed, and rejected attempts free their slots in time', async t => {
  const h = await harness(t), room = await h.create();
  const first = await h.guest(room, null, 'join', { name: 'Mis-tapped' });
  const cookie = first.cookie.split(';')[0];
  let state = (await h.host()).data.room;
  const path = room.id + '/guests/' + state.joinRequests[0].id;
  assert.equal((await h.host(path + '/reject', 'POST', {})).status, 200);
  assert.equal((await h.guest(room, cookie, 'state')).data.room.joinStatus, 'rejected');
  assert.equal((await h.host(path + '/approve', 'POST', { permission: 'direct' })).status, 200, 'a mis-tap is not final');
  assert.equal((await h.guest(room, cookie, 'state')).data.room.joined, true);
  for (let i = 0; i < 15; i++) {
    assert.equal((await h.guest(room, null, 'join', { name: 'Attempt ' + i })).status, 200);
    state = (await h.host()).data.room;
    const pending = state.joinRequests.find(g => g.name === 'Attempt ' + i);
    assert.equal((await h.host(room.id + '/guests/' + pending.id + '/reject', 'POST', {})).status, 200);
  }
  assert.equal((await h.host()).data.room.joinRequests.length, 0);
  h.advance(16 * 60000);
  assert.equal((await h.guest(room, null, 'join', { name: 'Late' })).status, 200);
});

test('a rejected song waits before it can be suggested again, and names lose bidi overrides', async t => {
  const h = await harness(t), room = await h.create();
  const rlo = String.fromCharCode(0x202E), nul = String.fromCharCode(0);
  await h.guest(room, null, 'join', { name: rlo + 'evil' + nul + ' name' });
  assert.equal((await h.host()).data.room.joinRequests[0].name, 'evil name');
  const cookie = await h.join(room, 'A');
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  const item = (await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).data.room.requests[0];
  await h.host(room.id + '/requests/' + item.id + '/reject', 'POST', {});
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).status, 409);
  h.advance(11 * 60000);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: tracks[0].videoId })).status, 201);
});

test('guest polling has its own budget and cannot starve joins and votes', async t => {
  const h = await harness(t), room = await h.create(), cookie = await h.join(room);
  for (let i = 0; i < 700; i++) assert.equal((await h.guest(room, cookie, 'state')).status, 200);
  assert.equal((await h.guest(room, null, 'join', { name: 'Newcomer' })).status, 200);
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  assert.equal((await h.guest(room, cookie, 'suggest', { trackId: tracks[1].videoId })).status, 201);
});

test('a join rejected after a long wait stays rejected, and the hosts can still undo it', async t => {
  const h = await harness(t, {}), room = await h.create();
  const asked = await h.guest(room, null, 'join', { name: 'Patient' });
  const cookie = asked.cookie.split(';')[0];
  h.advance(16 * 60000);
  const person = (await h.host()).data.room.joinRequests[0];
  const path = room.id + '/guests/' + person.id;
  assert.equal((await h.host(path + '/reject', 'POST', {})).status, 200);
  assert.equal((await h.guest(room, cookie, 'state')).data.room.joinStatus, 'rejected');
  assert.equal((await h.host(path + '/approve', 'POST', { permission: 'direct' })).status, 200);
});

test('searches refused by one guest\'s own cap are not charged to the room', async t => {
  const h = await harness(t), room = await h.create('direct');
  const noisy = await h.join(room, 'Noisy'), quiet = await h.join(room, 'Quiet');
  let refused = 0;
  for (let i = 0; i < 70; i++) if ((await h.guest(room, noisy, 'search', { query: 'Artist' })).status === 429) refused++;
  assert.equal(refused, 58);
  assert.equal((await h.guest(room, quiet, 'search', { query: 'Artist' })).status, 200);
  assert.equal((await h.host(room.id + '/search', 'POST', { query: 'Artist' })).status, 200);
});

test('host suggestions carry a role flag without confusing a guest using the host display name', async t => {
  const h = await harness(t), room = await h.create(), cookie = await h.join(room, 'המארחים');
  await h.host(room.id + '/search', 'POST', { query: 'Artist' });
  await h.host(room.id + '/requests', 'POST', { trackId: tracks[0].videoId });
  await h.guest(room, cookie, 'search', { query: 'Artist' });
  await h.guest(room, cookie, 'suggest', { trackId: tracks[1].videoId });
  const state = (await h.guest(room, cookie, 'state')).data.room;
  assert.equal(state.requests.find(item => item.track.id === tracks[0].videoId).fromHost, true);
  assert.equal(state.requests.find(item => item.track.id === tracks[1].videoId).fromHost, false);
  assert.equal(JSON.stringify(state).includes('owner@example.test'), false);
});
