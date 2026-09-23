// Exercise the deployed nginx rules and real login gateway around the media service.
// Requires Podman with nginx:alpine and the configured oauth2-proxy image available.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createMediaService } = require('../selfhost/private-app/media/server');
const root = path.resolve(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'selfhost/private-app/docker-compose.yml'), 'utf8');
const routes = compose.match(/OAUTH2_PROXY_SKIP_AUTH_ROUTES: "([^"]+)"/)[1].replace(/\$\$/g, '$').split(',');
const image = compose.match(/image: (quay\.io\/oauth2-proxy\/oauth2-proxy:[^\s]+)/)[1];
const servers = [], containers = [];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-media-stack-'));
const listen = server => new Promise(resolve => {
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function port() {
  const reserve = http.createServer();
  const value = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve));
  return value;
}
async function container(label, args, readyUrl) {
  const name = 'aura-media-' + label + '-' + process.pid;
  const child = spawn('podman', ['run', '--rm', '--network=host', '--name', name, ...args]);
  containers.push({ name, child });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(readyUrl)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Service failed to start: ' + logs);
}
(async () => {
  const publicPort = await port(), nginxPort = await port();
  const origin = 'http://127.0.0.1:' + publicPort;
  const internal = 'http://127.0.0.1:' + nginxPort;
  let mediaRequests = 0;
  const upstreamPort = await listen(http.createServer((req, res) => {
    mediaRequests++;
    assert.equal(req.url, '/videoplayback?id=song');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Length': 4, 'Content-Range': 'bytes 0-3/100' });
    res.end('song');
  }));
  const service = createMediaService({ origin, key: randomBytes(32), upstream: 'http://127.0.0.1:' + upstreamPort });
  const issuerPort = await listen(service.issuer), playbackPort = await listen(service.playback);
  const nginx = fs.readFileSync(path.join(root, 'selfhost/private-app/nginx.conf'), 'utf8')
    .replace('listen 80;', 'listen 127.0.0.1:' + nginxPort + ';')
    .replace('http://aura-media:8093', 'http://127.0.0.1:' + issuerPort)
    .replace('http://aura-media:8094', 'http://127.0.0.1:' + playbackPort);
  fs.writeFileSync(path.join(temp, 'nginx.conf'), nginx);
  await container('nginx', ['-v', temp + '/nginx.conf:/etc/nginx/conf.d/default.conf:ro,Z', 'nginx:alpine'], internal);
  await container('gateway', [image, '--provider=google', '--client-id=fixture', '--client-secret=fixture',
    '--cookie-secret=' + randomBytes(32).toString('base64url'), '--cookie-secure=false',
    '--email-domain=example.test', '--http-address=127.0.0.1:' + publicPort,
    '--redirect-url=' + origin + '/oauth2/callback', '--skip-auth-strip-headers=true',
    '--exclude-logging-path=/media/play', '--upstream=' + internal,
    ...routes.map(route => '--skip-auth-route=' + route)], origin + '/ping');

  // Trusted identity is inserted at the internal boundary solely for this fixture.
  const response = await fetch(internal + '/api/media/ticket', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-Email': 'owner@example.test' },
    body: JSON.stringify({ url: origin + '/videoplayback?id=song' }) });
  assert.equal(response.status, 201);
  const ticket = await response.json();
  for (const method of ['GET', 'HEAD']) {
    const audio = await fetch(ticket.url, { method, headers: { Range: 'bytes=0-3' } });
    assert.equal(audio.status, 206, 'receiver media ' + method);
    assert.equal(audio.headers.get('content-type'), 'audio/mp4');
    assert.equal(audio.headers.get('content-range'), 'bytes 0-3/100');
    assert.equal(audio.headers.get('access-control-allow-origin'), '*');
    assert.equal(await audio.text(), method === 'GET' ? 'song' : '');
  }
  assert.equal((await fetch(ticket.url, { method: 'OPTIONS' })).status, 204);
  assert.equal(mediaRequests, 2);
  const tampered = new URL(ticket.url);
  tampered.searchParams.set('ticket', 'invalid');
  assert.equal((await fetch(tampered)).status, 403);
  assert.equal((await fetch(origin + '/media/play')).status, 403);
  for (const [method, route] of [['GET', '/'], ['GET', '/api/sync/'], ['GET', '/config.json'],
    ['GET', '/videoplayback?id=song'], ['POST', '/api/media/ticket'], ['GET', '/api/media/ticket'],
    ['POST', '/media/play'], ['GET', '/media/play/extra']]) {
    const res = await fetch(origin + route, { method, redirect: 'manual', headers: {
      Origin: origin, 'X-Forwarded-Email': 'owner@example.test', Authorization: 'Bearer forged' } });
    assert.equal(res.status, 403, method + ' ' + route);
    await res.text();
  }
  assert.equal(mediaRequests, 2, 'unauthorized paths never reach the source');
  console.log('PASS: nginx + real login gateway + media service deliver signed GET/HEAD audio and reject unsigned media, forged identity and private APIs');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const { name, child } of containers.reverse()) {
    try { execFileSync('podman', ['rm', '--force', name], { stdio: 'ignore', timeout: 10000 }); } catch {}
    child.kill();
  }
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  fs.rmSync(temp, { recursive: true, force: true });
});
