const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// selfhost/install.sh, run for real against stand-ins for everything that would touch the
// machine: docker, curl, systemctl and caddy only record how they were called.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  for (const file of ['selfhost/install.sh', 'selfhost/invidious/docker-compose.yml',
    'selfhost/private-app/setup.sh', 'selfhost/private-app/authenticated-emails.example.txt']) {
    fs.mkdirSync(path.join(root, 'repo', path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, 'repo', file));
  }
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name),
    '#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> "$CALLS"\n' + body + '\n', { mode: 0o755 });
  stub('id', 'echo "${FAKE_UID:-0}"');
  stub('docker', 'exit 0');
  stub('curl', 'echo 200');
  stub('systemctl', '[ "$1" = is-active ] && exit 3; exit 0');
  stub('caddy', 'exit 0');
  stub('ss', 'exit 0');
  stub('ufw', 'echo "Status: inactive"');
  // HTTPS is off for the first CERT_AFTER reads, as on a tailnet that has not enabled it.
  stub('tailscale', [
    'case "$1" in',
    '  status)',
    '    if [ "$2" = --json ]; then',
    '      n=$(cat "$TS_COUNT" 2>/dev/null || echo 0); echo $((n + 1)) > "$TS_COUNT"',
    '      if [ "$n" -lt "${CERT_AFTER:-0}" ]; then certs=null; else certs=\'["box.tail1234.ts.net"]\'; fi',
    '      printf \'{"BackendState": "Running", "Self": {"HostName": "box", "DNSName": "box.tail1234.ts.net."}, "CertDomains": %s}\\n\' "$certs"',
    '    fi',
    '    exit 0 ;;',
    'esac',
    'exit 0'].join('\n'));
  const calls = path.join(root, 'calls');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CALLS: calls,
    TS_COUNT: path.join(root, 'ts-count'), TS_AUTHKEY: '',
    CADDYFILE: path.join(root, 'Caddyfile'), AURA_PROXY: '', AURA_AUTO_UPDATE: '',
    AURA_DOMAIN: 'music.example.test', GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-secret_value', AURA_EMAILS: 'listener@mail.test, second@mail.test' };
  const repo = path.join(root, 'repo');
  const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
  return {
    root, repo, read,
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    caddyfile: () => fs.readFileSync(env.CADDYFILE, 'utf8'),
    run: values => spawnSync('sh', [path.join(repo, 'selfhost/install.sh')], { env: { ...env, ...values }, encoding: 'utf8' })
  };
}

test('install sets up Invidious, sign-in, the app and Caddy in one run', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'Caddyfile'),
    '# The Caddyfile is an easy way to configure your Caddy web server.\n:80 {\n\t# comment\n\troot * /usr/share/caddy\n\n\tfile_server\n}\n');
  const run = f.run({});
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const invidious = f.read('.local/invidious/docker-compose.yml');
  assert.doesNotMatch(invidious, /CHANGEME16CHARS0|CHANGE_ME_HMAC_KEY/);
  const keys = [...invidious.matchAll(/(?:invidious_companion_key|SERVER_SECRET_KEY): "([^"]*)"/g)].map(m => m[1]);
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^[0-9a-f]{16}$/, 'the companion takes exactly 16 letters and digits');
  assert.equal(keys[0], keys[1], 'the same companion key in both places');
  assert.match(invidious, /hmac_key: "[0-9a-f]{64}"/);
  assert.match(invidious, /"127\.0\.0\.1:3000:3000"/, 'the raw Invidious port stays on this machine');
  assert.match(f.calls(), /docker compose -p invidious -f \S+\/\.local\/invidious\/docker-compose\.yml up -d/);

  const oauth = f.read('selfhost/private-app/oauth.env');
  assert.match(oauth, /^OAUTH2_PROXY_CLIENT_ID=1234-abc\.apps\.googleusercontent\.com$/m);
  assert.match(oauth, /^OAUTH2_PROXY_CLIENT_SECRET=GOCSPX-secret_value$/m);
  assert.match(oauth, /^OAUTH2_PROXY_COOKIE_SECRET=[A-Za-z0-9_=-]{40,}$/m);
  assert.equal(fs.statSync(path.join(f.repo, 'selfhost/private-app/oauth.env')).mode & 0o777, 0o600);
  assert.equal(f.read('selfhost/private-app/authenticated-emails.txt'), 'listener@mail.test\nsecond@mail.test\n');

  assert.deepEqual(JSON.parse(f.read('config.json')).invidiousInstances, ['https://music.example.test']);
  assert.match(f.calls(), /docker compose -f \S+ up -d --build --force-recreate/);

  // Caddy's own placeholder site is replaced; the site points at the sign-in proxy.
  assert.equal(f.caddyfile(), '# BEGIN aura - written by selfhost/install.sh, rewritten on every run\n' +
    'music.example.test {\n\treverse_proxy 127.0.0.1:4180\n}\n# END aura\n');
  assert.match(f.calls(), /caddy validate --config \S+ --adapter caddyfile/);
  assert.match(f.calls(), /systemctl enable --now caddy/);
  assert.match(run.stdout, /https:\/\/music\.example\.test\/oauth2\/callback/);
  assert.doesNotMatch(f.calls(), /crontab/, 'no automatic updates unless asked for');
});

test('running install again keeps keys, sign-in and other Caddy sites', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'Caddyfile'), 'other.example.test {\n\trespond "other"\n}\n');
  assert.equal(f.run({}).status, 0);
  const invidious = f.read('.local/invidious/docker-compose.yml');
  const oauth = f.read('selfhost/private-app/oauth.env');
  // A later run needs neither the domain nor the Google details again.
  const again = f.run({ AURA_DOMAIN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', AURA_EMAILS: '' });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(f.read('.local/invidious/docker-compose.yml'), invidious, 'Invidious keeps its keys');
  assert.equal(f.read('selfhost/private-app/oauth.env'), oauth);
  const caddyfile = f.caddyfile();
  assert.match(caddyfile, /^other\.example\.test \{\n\trespond "other"\n\}\n/);
  assert.equal(caddyfile.match(/# BEGIN aura/g).length, 1);
});

test('install stops before changing anything when a detail is missing or wrong', t => {
  const cases = [
    [{ FAKE_UID: '1000' }, /sudo/],
    [{ AURA_DOMAIN: '' }, /AURA_DOMAIN/],
    [{ AURA_DOMAIN: 'music.example.com' }, /AURA_DOMAIN/],
    [{ AURA_DOMAIN: 'https://music.example.test' }, /AURA_DOMAIN/],
    [{ AURA_DOMAIN: 'music.example.test/app' }, /AURA_DOMAIN/],
    [{ AURA_DOMAIN: 'music.example.test:443' }, /AURA_DOMAIN/],
    [{ AURA_DOMAIN: 'music.example.test\nX=1' }, /AURA_DOMAIN/],
    [{ GOOGLE_CLIENT_ID: '' }, /GOOGLE_CLIENT_ID/],
    [{ GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID' }, /GOOGLE_CLIENT_ID/],
    [{ GOOGLE_CLIENT_SECRET: 'has space' }, /GOOGLE_CLIENT_SECRET/],
    [{ AURA_EMAILS: '' }, /AURA_EMAILS/],
    [{ AURA_EMAILS: 'you@example.com' }, /AURA_EMAILS/],
    [{ AURA_EMAILS: 'listener@mail.test, not-an-address' }, /AURA_EMAILS/],
    [{ AURA_PROXY: 'nginx' }, /AURA_PROXY/],
    [{ AURA_AUTO_UPDATE: 'sometimes' }, /AURA_AUTO_UPDATE/]
  ];
  for (const [values, message] of cases) {
    const f = fixture(t);
    const run = f.run(values);
    assert.notEqual(run.status, 0, JSON.stringify(values));
    assert.match(run.stderr, message, JSON.stringify(values));
    assert.equal(f.calls().replace(/^id .*\n/gm, ''), '', 'nothing ran for ' + JSON.stringify(values));
    assert.equal(fs.existsSync(path.join(f.repo, '.local')), false);
    assert.equal(fs.existsSync(path.join(f.repo, 'selfhost/private-app/oauth.env')), false);
  }
});

test('install without a domain gets a free address from Tailscale and publishes it with Funnel', t => {
  const f = fixture(t);
  // The domain line of the block may be left as it is: Tailscale names the server.
  const run = f.run({ AURA_PROXY: 'tailscale', AURA_DOMAIN: 'music.example.com', CERT_AFTER: '1' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Enable HTTPS/, 'it waits for the tailnet to turn HTTPS on');
  assert.deepEqual(JSON.parse(f.read('config.json')).invidiousInstances, ['https://box.tail1234.ts.net']);
  assert.match(f.read('selfhost/private-app/.env'), /^PUBLIC_HOST=box\.tail1234\.ts\.net$/m);
  assert.match(f.calls(), /tailscale funnel --bg 4180/);
  assert.doesNotMatch(f.calls(), /caddy|systemctl (reload|enable --now) caddy/);
  assert.equal(fs.existsSync(path.join(f.root, 'Caddyfile')), false);
  assert.match(run.stdout, /https:\/\/box\.tail1234\.ts\.net\/oauth2\/callback/);
});

test('install leaves the HTTPS proxy alone when told to', t => {
  const f = fixture(t);
  const run = f.run({ AURA_PROXY: 'none' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'Caddyfile')), false);
  assert.doesNotMatch(f.calls(), /caddy|systemctl/);
  assert.match(run.stdout, /http:\/\/127\.0\.0\.1:4180/);
});

test('install stops when another web server holds the HTTPS ports', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'bin/ss'),
    '#!/bin/sh\necho \'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1,fd=6))\'\n', { mode: 0o755 });
  const run = f.run({});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /port 80 is already used by nginx|port 443 is already used by nginx/);
  assert.match(run.stderr, /AURA_PROXY=none/);
  assert.equal(fs.existsSync(path.join(f.repo, '.local')), false);
});
