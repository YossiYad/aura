const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule } = require('./source');

function client(fetch, options = {}) {
 let subscription = null, removed = 0;
 const window = { PushManager: {}, Notification: {} };
 const sub = { toJSON: () => ({ endpoint: 'https://push.test/sub' }), unsubscribe: async () => {
  if (options.failUnsubscribe) throw Error('unsubscribe failed');
  removed++;
  subscription = null;
  return true;
 } };
 if (options.subscribed) subscription = sub;
 const navigator = { serviceWorker: { addEventListener() {}, ready: Promise.resolve({ pushManager: {
  getSubscription: async () => subscription,
  subscribe: async () => { subscription = sub; return sub; }
 } }) } };
 vm.runInNewContext(readModule('push'), {
  window, navigator, fetch, atob, Uint8Array,
  Notification: { permission: 'granted', requestPermission: async () => 'granted' }
 });
 return { Push: window.Push, removed: () => removed };
}

const keyResponse = () => ({ ok: true, status: 200, json: async () => ({ key: 'AQID' }) });

test('push backend discovery retries after an offline launch', async () => {
 let calls = 0;
 const c = client(async () => {
  if (++calls === 1) throw new Error('offline');
  return keyResponse();
 });
 assert.equal((await c.Push.status()).backendAvailable, false);
 assert.equal((await c.Push.status()).backendAvailable, true);
 assert.equal(calls, 2);
});

test('concurrent push status requests wait for the same backend discovery', async () => {
 let finish, calls = 0;
 const c = client(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
 const first = c.Push.status();
 const second = c.Push.status();
 finish(keyResponse());
 assert.equal((await first).backendAvailable, true);
 assert.equal((await second).backendAvailable, true);
 assert.equal(calls, 1);
});

test('a missing push backend is cached without repeated requests', async () => {
 let calls = 0;
 const c = client(async () => { calls++; return { ok: false, status: 404 }; });
 assert.equal((await c.Push.status()).backendAvailable, false);
 assert.equal((await c.Push.status()).backendAvailable, false);
 assert.equal(calls, 1);
});

test('push registration network failure rolls back the browser subscription', async () => {
 const c = client(async url => {
  if (url.endsWith('public-key')) return keyResponse();
  throw new Error('connection lost');
 });
 await assert.rejects(c.Push.enable(), /connection lost/);
 assert.equal(c.removed(), 1);
 assert.equal((await c.Push.status()).subscribed, false);
});

test('a registration retry cannot revoke an existing subscription after a server failure', async () => {
 const c = client(async url => {
  if (url.endsWith('public-key')) return keyResponse();
  throw Error('offline');
 }, { subscribed: true });
 await assert.rejects(c.Push.enable(), /offline/);
 assert.equal(c.removed(), 0);
 assert.equal((await c.Push.status()).subscribed, true);
});

test('failed notification removal is reported so the control can be retried', async () => {
 const c = client(async url => url.endsWith('public-key') ? keyResponse() : { ok: true, status: 200 },
  { subscribed: true, failUnsubscribe: true });
 await assert.rejects(c.Push.disable(), /unsubscribe failed/);
 assert.equal((await c.Push.status()).subscribed, true);
});
