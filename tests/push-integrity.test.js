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

// A body over the limit was answered by destroying the request, which closed the socket
// before the 413 could be written: behind the proxy that reached the app as a bad gateway.
for (const service of ['push', 'mix']) test(service + ' server answers an oversized body with 413 instead of dropping the connection', async () => {
 const fs = require('node:fs'), http = require('node:http');
 const source = fs.readFileSync(require.resolve('../selfhost/private-app/' + service + '/server.js'), 'utf8');
 const start = source.indexOf('function readBody(');
 const readBody = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n}\n', start) + 2) + ')', { Buffer, Object, Error });
 const server = http.createServer((req, res) => {
  readBody(req, 1024).then(() => { res.writeHead(200); res.end('ok'); },
   e => { res.writeHead(e.code === 413 ? 413 : 400); res.end('too large'); });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const big = await fetch(url, { method: 'POST', body: 'x'.repeat(20 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(await big.text(), 'too large');
  const small = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(small.status, 200);
 } finally { server.closeAllConnections(); server.close(); }
});
