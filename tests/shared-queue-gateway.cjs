// Runs the real authentication gateway against a local fixture. Requires Podman and
// the same gateway image used by the deployment. No real sign-in credentials are used.
const http = require('node:http');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const compose = fs.readFileSync(require.resolve('../selfhost/private-app/docker-compose.yml'), 'utf8');
const routes = compose.match(/OAUTH2_PROXY_SKIP_AUTH_ROUTES: "([^"]+)"/)[1].replace(/\$\$/g, '$').split(',');
const image = compose.match(/image: (quay\.io\/oauth2-proxy\/oauth2-proxy:[^\s]+)/)[1];
const name = 'aura-queue-gateway-test-' + process.pid;
const received = [];
const upstream = http.createServer((req, res) => { received.push(req.method + ' ' + req.url); res.end('fixture'); });
const reserve = http.createServer();
let child;
(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  let logs = '';
  child = spawn('podman', ['run', '--rm', '--network=host', '--name', name, image,
    '--provider=google', '--client-id=local-fixture', '--client-secret=local-fixture',
    '--cookie-secret=' + randomBytes(32).toString('base64url'), '--cookie-secure=false',
    '--email-domain=example.test', '--http-address=127.0.0.1:' + port,
    '--redirect-url=https://music.example.test/oauth2/callback', '--skip-auth-strip-headers=true',
    '--reverse-proxy=' + compose.match(/OAUTH2_PROXY_REVERSE_PROXY: "([^"]+)"/)[1],
    '--upstream=http://127.0.0.1:' + upstream.address().port,
    ...routes.map(route => '--skip-auth-route=' + route)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(origin + '/ping')).ok; } catch {}
      if (ready) break;
      if (child.exitCode !== null) throw Error(logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, logs);
    const signIn = await fetch(origin + '/oauth2/start', { redirect: 'manual', headers: {
      Host: 'music.example.test', 'X-Forwarded-Proto': 'https' } });
    assert.equal(signIn.status, 302);
    assert.equal(new URL(signIn.headers.get('location')).searchParams.get('redirect_uri'),
      'https://music.example.test/oauth2/callback');
    for (const [method, path] of [['GET', '/guest/'], ['GET', '/guest/app.js'], ['GET', '/guest/i18n.js'], ['GET', '/guest/style.css'],
      ['GET', '/guest/api/state'], ['POST', '/guest/api/join'], ['POST', '/guest/api/search'],
      ['POST', '/guest/api/suggest'], ['POST', '/guest/api/vote'],
      ['GET', '/media/play?ticket=fixture'], ['HEAD', '/media/play?ticket=fixture'], ['OPTIONS', '/media/play']]) {
      const res = await fetch(origin + path, { method, redirect: 'manual' });
      assert.equal(res.status, 200, method + ' ' + path);
      assert.equal(await res.text(), method === 'HEAD' ? '' : 'fixture');
    }
    const count = received.length;
    for (const [method, path] of [['GET', '/'], ['GET', '/config.json'], ['GET', '/src/shared-queue.js'],
      ['GET', '/api/queue/'], ['POST', '/api/queue/'], ['GET', '/api/sync/'], ['GET', '/api/v1/search'],
      ['DELETE', '/guest/api/state'], ['POST', '/guest/api/state'], ['GET', '/guest/api/permissions'],
      ['GET', '/guest/index.html'], ['GET', '/guest/app.js/extra'], ['GET', '/guest/i18n.js/extra'], ['GET', '/guest/api/state/extra'],
      ['GET', '/guest/%2e%2e/api/queue/'], ['POST', '/api/media/ticket'], ['GET', '/api/media/ticket'],
      ['GET', '/videoplayback?id=song'], ['HEAD', '/videoplayback?id=song'],
      ['GET', '/media/play/extra'], ['POST', '/media/play'], ['GET', '/media/other'],
      ['GET', '/api/sync/?next=/media/play']]) {
      const res = await fetch(origin + path, { method, redirect: 'manual', headers: {
        'X-Forwarded-Email': 'owner@example.test', 'X-Forwarded-User': 'owner', Authorization: 'Bearer forged' } });
      assert.notEqual(res.status, 200, method + ' ' + path + ' must require authentication');
      await res.text();
      assert.equal(received.length, count, 'Protected route never reached the upstream');
    }
    console.log('PASS: real gateway allows only exact guest and media playback routes; ticket issuer, app, host API and spoofed identities remain protected');
  } finally {
    try { execFileSync('podman', ['rm', '--force', name], { stdio: 'ignore', timeout: 10000 }); } catch {}
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { upstream.closeAllConnections(); upstream.close(); });
