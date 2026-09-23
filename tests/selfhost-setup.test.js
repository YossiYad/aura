const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'selfhost/private-app');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, '../selfhost/private-app/setup.sh'), path.join(dir, 'setup.sh'));
  fs.writeFileSync(path.join(dir, 'oauth.env'), '# local test fixture\n');
  fs.writeFileSync(path.join(dir, 'authenticated-emails.txt'), 'listener@example.test\n');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SETUP_CALL_LOG"\nexit 0\n', { mode: 0o755 });
  // Any attempt to use the old network provider must fail the test.
  fs.writeFileSync(path.join(bin, 'tailscale'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    PUBLIC_HOST: '', APP_PORT: '', OAUTH_PORT: '', INVIDIOUS_NETWORK: '',
    SETUP_CALL_LOG: path.join(root, 'docker-calls') };
  return { root, dir, run: values => spawnSync('sh', [path.join(dir, 'setup.sh')],
    { env: { ...env, ...values }, encoding: 'utf8' }) };
}

test('setup uses an explicit domain and reuses it on unattended updates', t => {
  const f = fixture(t);
  let run = f.run({ PUBLIC_HOST: 'music.example.test', OAUTH_PORT: '4280' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'))).invidiousInstances,
    ['https://music.example.test']);
  assert.match(run.stdout, /reverse_proxy 127\.0\.0\.1:4280/);
  run = f.run({});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /https:\/\/music\.example\.test/);
  assert.match(run.stdout, /reverse_proxy 127\.0\.0\.1:4280/);
  run = f.run({ PUBLIC_HOST: 'new.example.test' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(fs.readFileSync(path.join(f.dir, '.env'), 'utf8'), /^PUBLIC_HOST=new\.example\.test$/m);
  assert.match(fs.readFileSync(path.join(f.root, 'docker-calls'), 'utf8'), /up -d --build --force-recreate/);
});

test('setup rejects missing or malformed domains before changing configuration', t => {
  const f = fixture(t);
  for (const host of ['', 'https://music.example.test', 'music.example.test/path',
    'music.example.test:443', '-bad.example.test', 'music.example.test\nINJECTED=value']) {
    const run = f.run({ PUBLIC_HOST: host });
    assert.notEqual(run.status, 0, host);
    assert.match(run.stdout, /PUBLIC_HOST/);
    assert.equal(fs.existsSync(path.join(f.root, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(f.dir, '.env')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'docker-calls')), false);
  }
});

test('setup requires OAuth configuration before starting services', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'oauth.env'));
  const run = f.run({ PUBLIC_HOST: 'music.example.test' });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /oauth.env/);
  assert.equal(fs.existsSync(path.join(f.root, 'docker-calls')), false);
});
