const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, flushMicrotasks } = require('./harness');
const { readModule } = require('./source');
const source = readModule('shared-queue');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function client(options = {}) {
  const timers = new Map(), recorded = options.recorded || new Set(), queued = [];
  let timer = 0, adds = 0, acknowledgments = 0, acknowledged = false, active = true, session = '';
  const room = { id: 'room', mode: options.mode, isController: options.controller !== false,
    requests: [{ id: 'suggestion', status: 'approved', deliver: true, track: { id: 'song', title: 'Song' } }] };
  if (options.noRequests) room.requests = [];
  const context = {
    window: {}, document: { hidden: false, getElementById: () => null, addEventListener() {} },
    Store: { sharedQueueDevice: () => 'device', isBlocked: () => !!options.blocked,
      sharedQueueDelivered: (id, write) => { if (write) recorded.add(id); return recorded.has(id); } },
    Player: { queue: () => queued, upcoming: () => queued, current: () => null, playbackRequested: () => false,
      beginShare(id) { session = id; }, endShare() { session = ''; }, shareSession: () => session,
      onChange() {}, addToQueue: track => { adds++; queued.push(track); return true; } },
    AbortSignal, Date, Set, Promise,
    setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id),
    fetch: async (path, init) => {
      if (init.method === 'GET') return { ok: true, json: async () => ({ room: active ? {
        ...room, requests: room.requests.map(item => ({ ...item, deliver: !acknowledged })) } : null }) };
      assert(path.endsWith('/ack'));
      acknowledgments++;
      if (options.failFirstAck && acknowledgments === 1) throw Error('connection lost');
      acknowledged = true;
      return { ok: true, json: async () => ({}) };
    }
  };
  if (options.player) context.Player = options.player;
  vm.runInNewContext(source, context);
  context.window.SharedQueue.init();
  return { queued, recorded, room, get adds() { return adds; }, get acknowledgments() { return acknowledgments; },
    close() { active = false; },
    suggest(id = 'song') { acknowledged = false; room.requests = [{ id, track: { id, title: id } }]; },
    async poll() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await settle(); } };
}

test('lost delivery acknowledgment retries without re-adding a song, even if it left the local queue', async () => {
  const h = client({ failFirstAck: true }); await settle();
  assert.equal(h.adds, 1); assert.equal(h.acknowledgments, 1);
  h.queued.length = 0;
  await h.poll();
  assert.equal(h.adds, 1); assert.equal(h.acknowledgments, 2);
});

test('reloading the controller uses its delivery journal before acknowledging a retry', async () => {
  const recorded = new Set(['room:suggestion']);
  const h = client({ recorded }); await settle();
  assert.equal(h.adds, 0); assert.equal(h.acknowledgments, 1);
});

test('another device cannot automatically add requests assigned to the active controller', async () => {
  const h = client({ controller: false }); await settle();
  assert.equal(h.adds, 0); assert.equal(h.acknowledgments, 0);
});

test('blocked songs remain undelivered instead of silently bypassing personal exclusions', async () => {
  const h = client({ blocked: true }); await settle();
  assert.equal(h.adds, 0); assert.equal(h.acknowledgments, 0);
});

function existingPlayer() {
  const h = createHarness({ tracks: ['earlier', 'current', 'next'].map(id => ({ id, title: id })), pos: 1,
    settings: { autoplay: false, noYtFallback: true } });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.getSkipSegments = async () => [];
  return h;
}

for (const paused of [false, true]) {
  test(`existing-queue keeps ${paused ? 'paused' : 'playing'} playback and settings through joining and closing`, async () => {
    const h = existingPlayer(), player = h.window.Player;
    player.setShuffle(true);
    player.cycleRepeat(); player.cycleRepeat();
    h.play(); await flushMicrotasks(60);
    if (paused) player.pause();
    h.audio.currentTime = 47;
    const snapshot = () => JSON.stringify({ queue: player.queue(), upcoming: player.upcoming(), pos: player.pos(),
      history: player.queueHistory(), historySession: player.queueHistorySession(), time: player.getTime(),
      paused: player.isPaused(), requested: player.playbackRequested(), shuffle: player.shuffle(), repeat: player.repeat() });
    const before = snapshot(), playCalls = h.audio.playCalls;
    const c = client({ player, mode: 'existing-queue', noRequests: true }); await settle();
    assert.equal(snapshot(), before);
    assert.equal(player.shareSession(), '');
    c.suggest('guest'); await c.poll();
    assert.deepEqual(Array.from(player.queue(), t => t.id), ['earlier', 'current', 'next', 'guest']);
    assert.deepEqual(Array.from(player.upcoming(), t => t.id).slice(-1), ['guest']);
    assert.equal(h.audio.currentTime, 47);
    assert.equal(h.audio.playCalls, playCalls);
    assert.equal(player.isPaused(), paused);
    assert.equal(player.shuffle(), true);
    assert.equal(player.repeat(), 'one');
    assert.equal(h.savedQueues.at(-1).extra.at(-1).id, 'guest');
    assert.equal(c.acknowledgments, 1);
    const after = snapshot();
    c.close(); await c.poll();
    assert.equal(snapshot(), after);
    player.dismiss();
  });
}

test('existing-queue acknowledges duplicates anywhere in the personal queue without reinserting them', async () => {
  const h = existingPlayer(), player = h.window.Player;
  const c = client({ player, mode: 'existing-queue', noRequests: true }); await settle();
  for (const id of ['earlier', 'current', 'next']) { c.suggest(id); await c.poll(); }
  assert.equal(c.acknowledgments, 3);
  assert.deepEqual(Array.from(player.queue(), t => t.id), ['earlier', 'current', 'next']);
  player.dismiss();
});

test('existing-queue retries a lost acknowledgment after a host replaces the queue without re-adding', async () => {
  const h = existingPlayer(), player = h.window.Player;
  const c = client({ player, mode: 'existing-queue', failFirstAck: true }); await settle();
  player.playQueue([{ id: 'replacement' }]); await flushMicrotasks(60);
  await c.poll();
  assert.equal(c.acknowledgments, 2);
  assert.deepEqual(Array.from(player.queue(), t => t.id), ['replacement']);
  player.dismiss();
});

test('existing-queue control loss leaves local playback running and control acquisition uses the local queue', async () => {
  const h = existingPlayer(), player = h.window.Player;
  h.play(); await flushMicrotasks(60);
  const c = client({ player, mode: 'existing-queue', controller: false }); await settle();
  assert.equal(c.acknowledgments, 0);
  c.room.isController = true; await c.poll();
  assert.deepEqual(Array.from(player.queue(), t => t.id), ['earlier', 'current', 'next', 'song']);
  c.room.isController = false; c.suggest('another'); await c.poll();
  assert.equal(player.current().id, 'current');
  assert.equal(player.isPaused(), false);
  assert.equal(player.queue().length, 4);
  assert.equal(c.acknowledgments, 1);
  player.dismiss();
});

test('existing-queue uses normal behavior for empty and exhausted queues and retains blocking', async () => {
  const h = existingPlayer(), player = h.window.Player;
  player.playQueue([]);
  const c = client({ player, mode: 'existing-queue', noRequests: true }); await settle();
  c.suggest('first'); await c.poll();
  assert.equal(player.current().id, 'first');
  assert.equal(player.playbackRequested(), true);
  // A real element announces its start; without it the load is forever pending
  // and the ended event below would be ignored as arriving mid-load.
  h.audio.dispatch('playing'); await settle();
  h.audio.currentTime = h.audio.duration;
  h.audio.ended = true; h.audio.paused = true; h.audio.dispatch('ended');
  await settle();
  assert.equal(player.playbackRequested(), false);
  c.suggest('second'); await c.poll();
  assert.equal(player.current().id, 'first');
  assert.equal(player.playbackRequested(), false);
  assert.deepEqual(Array.from(player.upcoming(), t => t.id), ['second']);
  const blocked = client({ player, mode: 'existing-queue', blocked: true }); await settle();
  assert.equal(blocked.acknowledgments, 0);
  assert.equal(player.queue().length, 2);
  player.dismiss();
});

for (const mode of [undefined, 'standalone']) {
  test(`standalone adoption (${mode || 'legacy'}) still isolates playback and restores the personal queue paused`, async () => {
    const h = existingPlayer(), player = h.window.Player;
    let sharePlayback = null;
    h.Store.sharedQueuePlayback = value => { if (value !== undefined) sharePlayback = value; return sharePlayback; };
    h.play(); await flushMicrotasks(60);
    const c = client({ player, mode, noRequests: true }); await settle();
    assert.equal(player.shareSession(), 'room');
    assert.equal(player.current(), null);
    assert.equal(player.isPaused(), true);
    c.suggest('guest'); await c.poll();
    assert.equal(player.current().id, 'guest');
    assert.equal(player.playbackRequested(), true);
    c.close(); await c.poll();
    assert.equal(player.shareSession(), '');
    assert.deepEqual(Array.from(player.queue(), t => t.id), ['earlier', 'current', 'next']);
    assert.equal(player.isPaused(), true);
    player.dismiss();
  });
}
