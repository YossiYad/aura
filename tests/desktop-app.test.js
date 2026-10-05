const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const handoff = require('../desktop/handoff');
const config = require('../desktop/config');
const install = require('../desktop/install');

const SESSION = 'c2Vzc2lvbi12YWx1ZS1mb3ItdGVzdHM=|1700000000|c2lnbmF0dXJl_-A=';
const answer = (state, extra = '') => 'state=' + state + '&s=' + SESSION + '&s0=&s1=&s2=&s3=' + extra;

// The desktop app signs in through the listener's browser: it waits on a port of this
// computer for the session the server's page hands back. Everything that makes the wait
// answer only the person who started it is held here.
test('the answer is taken only with the secret of the attempt it was made for', () => {
  const state = 'S'.repeat(43);
  assert.deepEqual(handoff.parseAnswer(answer(state), state), [{ name: '_oauth2_proxy', value: SESSION }]);
  assert.deepEqual(handoff.parseAnswer('#' + answer(state), state), [{ name: '_oauth2_proxy', value: SESSION }]);
  assert.equal(handoff.parseAnswer(answer('T'.repeat(43)), state), null);
  assert.equal(handoff.parseAnswer(answer(state.slice(1)), state), null);
  assert.equal(handoff.parseAnswer(answer(''), state), null);
  assert.equal(handoff.parseAnswer(answer(state), ''), null);
  // A session cut into numbered cookies comes back as those cookies.
  const cut = handoff.parseAnswer('state=' + state + '&s=&s0=' + 'a'.repeat(40) + '&s1=' + 'b'.repeat(40), state);
  assert.deepEqual(cut.map(cookie => cookie.name), ['_oauth2_proxy_0', '_oauth2_proxy_1']);
  // No session, or something that is not one, is no answer.
  assert.equal(handoff.parseAnswer('state=' + state + '&s=&s0=', state), null);
  assert.equal(handoff.parseAnswer('state=' + state + '&s=has spaces and "quotes" in it', state), null);
  assert.equal(handoff.parseAnswer('state=' + state + '&s=short', state), null);
});

test('the browser is sent to the server\'s own page, with the port and the secret', () => {
  const url = new URL(handoff.requestUrl('https://aura.example/', 43210, 'S'.repeat(43)));
  assert.equal(url.origin + url.pathname, 'https://aura.example/desktop/handoff');
  assert.equal(url.searchParams.get('port'), '43210');
  assert.equal(url.searchParams.get('state'), 'S'.repeat(43));
});

test('the waiting port serves its page, takes the right answer once and refuses the rest', async () => {
  const wait = await handoff.listen();
  const base = 'http://127.0.0.1:' + wait.port;
  const post = (body, headers = {}) => fetch(base + '/handoff', { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain', Origin: base }, headers), body });
  assert.match(wait.state, /^[A-Za-z0-9_-]{43}$/);

  const page = await fetch(base + '/handoff');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // The page takes the session out of the address before anything else.
  const html = await page.text();
  assert.ok(html.indexOf('history.replaceState') < html.indexOf('fetch('), 'the address is cleared first');

  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch('http://localhost:' + wait.port + '/handoff').catch(() => ({ status: 404 }))).status, 404);
  assert.equal((await post(answer('wrong'.repeat(9)))).status, 400);
  assert.equal((await post(answer(wait.state), { Origin: 'https://elsewhere.example' })).status, 405);
  assert.equal((await fetch(base + '/handoff', { method: 'PUT', body: answer(wait.state) })).status, 405);

  assert.equal((await post(answer(wait.state))).status, 204);
  assert.deepEqual(await wait.cookies, [{ name: '_oauth2_proxy', value: SESSION }]);
  // One answer and the port is gone.
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(post(answer(wait.state)));
});

test('a wait that nobody answers ends by itself, and one given up ends at once', async () => {
  const slow = await handoff.listen({ waitMs: 40 });
  await assert.rejects(slow.cookies, /timed out/);
  await assert.rejects(fetch('http://127.0.0.1:' + slow.port + '/handoff'));
  const dropped = await handoff.listen();
  dropped.cancel();
  await assert.rejects(dropped.cookies, /cancelled/);
});

test('only an https address, or this computer, is taken for a server', () => {
  assert.equal(config.serverAddress('aura.example'), 'https://aura.example/');
  assert.equal(config.serverAddress(' https://aura.example/some/page?x=1 '), 'https://aura.example/');
  assert.equal(config.serverAddress('http://localhost:8477'), 'http://localhost:8477/');
  assert.equal(config.serverAddress('http://127.0.0.1:8477/'), 'http://127.0.0.1:8477/');
  for (const bad of ['', 'http://aura.example', 'ftp://aura.example', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@aura.example', 'https://']) {
    assert.equal(config.serverAddress(bad), '', bad);
  }
});

test('the app\'s settings survive a broken file and keep what was saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-desktop-'));
  const file = path.join(dir, 'nested', 'settings.json');
  assert.deepEqual(config.load(file), config.DEFAULTS);
  config.save(file, { server: 'https://aura.example/', keepPlaying: false, bounds: { x: 10, y: 20, width: 900, height: 700, maximized: true } });
  assert.deepEqual(config.load(file), { server: 'https://aura.example/', keepPlaying: false, bounds: { x: 10, y: 20, width: 900, height: 700, maximized: true } });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(config.load(file), config.DEFAULTS);
  fs.writeFileSync(file, JSON.stringify({ server: 'http://aura.example', bounds: { width: 5, height: 5 } }));
  assert.deepEqual(config.load(file), config.DEFAULTS);
  fs.rmSync(dir, { recursive: true });
});

// A downloaded file is not an installed app. Run from one, the app keeps a copy of itself
// where the user's applications live and puts itself in the menu.
test('the app installs itself from a downloaded file, and a newer download replaces it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-'));
  const home = path.join(dir, 'home'), downloads = path.join(home, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const icon = path.join(dir, 'icon.png');
  fs.writeFileSync(icon, 'picture');
  const download = path.join(downloads, 'Aura@music.example.AppImage');
  fs.writeFileSync(download, 'first version');
  const from = appImage => ({ appImage, home, env: {}, icon });

  const first = install.install(from(download));
  assert.equal(first.target, path.join(home, '.local/share/aura-desktop/Aura.AppImage'));
  assert.equal(first.copied, true);
  assert.equal(fs.readFileSync(first.target, 'utf8'), 'first version');
  assert.equal(fs.statSync(first.target).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(first.icon, 'utf8'), 'picture');
  const entry = fs.readFileSync(first.entry, 'utf8');
  assert.equal(first.entry, path.join(home, '.local/share/applications/aura-desktop.desktop'));
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=Aura\n/);
  assert.ok(entry.includes('Exec="' + first.target + '" %U\n'));
  // The window is matched to this entry by the name package.json gives the app.
  assert.match(entry, /StartupWMClass=aura-desktop\n/);
  assert.equal(JSON.parse(read('desktop/package.json')).desktopName, 'aura-desktop.desktop');

  // Opened again from the same download, or from the installed copy: nothing to do.
  assert.equal(install.install(from(download)).copied, false);
  assert.equal(install.install(from(first.target)).copied, false);
  // A newer download takes its place.
  const newer = path.join(downloads, 'Aura@music.example(1).AppImage');
  fs.writeFileSync(newer, 'second version, longer');
  assert.equal(install.install(from(newer)).copied, true);
  assert.equal(fs.readFileSync(first.target, 'utf8'), 'second version, longer');
  // A data folder set by the system is honoured.
  const moved = install.install({ appImage: newer, home, env: { XDG_DATA_HOME: path.join(dir, 'data') }, icon });
  assert.equal(moved.target, path.join(dir, 'data/aura-desktop/Aura.AppImage'));
  fs.rmSync(dir, { recursive: true });
});

test('a download says which server it came from, and nothing else passes for that', () => {
  assert.equal(install.serverHint('/home/me/Downloads/Aura@music.example.AppImage'), 'music.example');
  assert.equal(install.serverHint('/home/me/Downloads/Aura@my-box.tail1234.ts.net(1).AppImage'), 'my-box.tail1234.ts.net');
  assert.equal(install.serverHint('/home/me/Downloads/Aura@music.example (2).AppImage'), 'music.example');
  assert.equal(install.serverHint('Aura@music.example.AppImage'), 'music.example');
  // The Windows installer, as a browser saves it and as the installer writes its own name down.
  assert.equal(install.serverHint('C:\\Users\\me\\Downloads\\Aura@music.example.exe'), 'music.example');
  assert.equal(install.serverHint('Aura@music.example (1).exe'), 'music.example');
  assert.equal(install.serverHint('Aura@music.example.exe\r\n'), 'music.example');
  for (const other of ['', '/opt/Aura-x86_64.AppImage', 'Aura-Setup-x64.exe', 'Aura@music.example.exe.lnk', '/home/me/.local/share/aura-desktop/Aura.AppImage', '/tmp/NotAura@music.example.AppImage', '/tmp/Aura@bad host.AppImage', '/tmp/Aura@a/b.AppImage']) {
    assert.equal(install.serverHint(other), '', other);
  }
  // What it names is still only offered, as an https address, for the listener to accept.
  assert.equal(config.serverAddress(install.serverHint('/x/Aura@music.example.AppImage')), 'https://music.example/');
  assert.match(read('desktop/pages/setup.js'), /address\.value = state\.server \|\| state\.hint/);
});

test('a server offers the installer only when asked to build it, and only behind the login', () => {
  const conf = read('selfhost/private-app/nginx.conf');
  const at = conf.indexOf('location = /desktop/download/Aura.AppImage {');
  assert.ok(at > 0, 'the download is missing');
  const block = conf.slice(at, conf.indexOf('\n    }\n', at));
  assert.match(block, /alias \/usr\/share\/nginx\/html\/desktop\/dist\/Aura-x86_64\.AppImage;/);
  assert.match(block, /Content-Disposition 'attachment; filename="Aura@\$host\.AppImage"'/);
  const build = JSON.parse(read('desktop/package.json')).build;
  assert.equal(build.linux.artifactName, 'Aura-${arch}.${ext}');
  // Windows: the installer the builder writes, served under a name that carries the server.
  const win = conf.slice(conf.indexOf('location = /desktop/download/Aura-Setup.exe {'));
  assert.match(win.slice(0, win.indexOf('\n    }\n')), /alias \/usr\/share\/nginx\/html\/desktop\/dist\/Aura-Setup-x64\.exe;[\s\S]*filename="Aura@\$host\.exe"/);
  assert.equal(build.nsis.artifactName, 'Aura-Setup-${arch}.${ext}');
  assert.equal(build.nsis.perMachine, false);
  // The installer writes down the name it was saved under, which is where main.js looks.
  assert.match(read('desktop/build/installer.nsh'), /!macro customInstall[\s\S]*FileOpen \$0 "\$INSTDIR\\installed-from\.txt" w[\s\S]*FileWrite \$0 "\$EXEFILE"/);
  assert.match(read('desktop/main.js'), /path\.join\(path\.dirname\(process\.execPath\), "installed-from\.txt"\)/);
  const skip = read('selfhost/private-app/docker-compose.yml').match(/OAUTH2_PROXY_SKIP_AUTH_ROUTES: "([^"]*)"/)[1];
  assert.doesNotMatch(skip, /desktop/);
  // Off unless the owner asks, remembered once asked, and never in the way of the server.
  const setup = read('selfhost/private-app/setup.sh');
  assert.match(setup, /AURA_DESKTOP_APP="\$\{AURA_DESKTOP_APP:-no\}"/);
  assert.match(setup, /\nAURA_DESKTOP_APP=\$AURA_DESKTOP_APP\n/);
  // yes is Linux alone, as it was; all adds Windows, which needs the large image.
  assert.match(setup, /\n  yes\) sh "\$REPO_DIR\/desktop\/build\.sh" linux \|\| echo /);
  assert.match(setup, /\n  all\) sh "\$REPO_DIR\/desktop\/build\.sh" all \|\| echo /);
  assert.ok(setup.indexOf('desktop/build.sh') > setup.indexOf('docker compose'), 'the server comes up first');
  const deploy = read('selfhost/private-app/auto-deploy.sh');
  assert.match(deploy, /case "\$DESKTOP_APP" in yes\) DESKTOP_TARGETS=linux ;; all\) DESKTOP_TARGETS=all ;;/);
  assert.match(deploy, /timeout 30m sh "\$REPO_DIR\/desktop\/build\.sh" --if-changed "\$DESKTOP_TARGETS" \|\|/);
  // A failed build is not tried again every minute.
  const script = read('desktop/build.sh');
  assert.ok(script.indexOf('echo "$NOW" > "$STAMP"') < script.indexOf('" run --rm'), 'the attempt is recorded before it is made');
  // Only the large image when Windows is asked for.
  assert.ok(script.indexOf('electronuserland/builder:wine') > script.indexOf('if [ "$TARGETS" = all ]; then'));
});

// The server's half of the sign-in: one page behind the login, which hands the session
// to a port of the computer the browser runs on, and only on a click.
test('the server hands a session to the desktop app only behind the login, on a click, to this computer', () => {
  const conf = read('selfhost/private-app/nginx.conf');
  const at = conf.indexOf('location = /desktop/handoff {');
  assert.ok(at > 0, 'the handover page is missing');
  const block = conf.slice(at, conf.indexOf('\n    }\n', at));
  // The port and the secret are checked before they are written into the page.
  assert.match(block, /if \(\$arg_port !~ "\^\[1-9\]\[0-9\]\{3,4\}\$"\) \{ return 400; \}/);
  assert.match(block, /if \(\$arg_state !~ "\^\[A-Za-z0-9_-\]\{32,64\}\$"\) \{ return 400; \}/);
  assert.match(block, /if \(\$http_cookie ~ "[^\n]*"\) \{ return 400; \}/);
  // A page with a link, never a redirect: nothing leaves without the click.
  assert.match(block, /return 200 '/);
  assert.doesNotMatch(block, /return 30\d/);
  const targets = block.match(/href="[^"]+"/g);
  assert.equal(targets.length, 1);
  assert.match(targets[0], /^href="http:\/\/127\.0\.0\.1:\$arg_port\/handoff#state=\$arg_state&amp;s=\$cookie__oauth2_proxy&amp;/);
  assert.match(block, /X-Frame-Options "DENY" always/);
  assert.match(block, /frame-ancestors 'none'/);
  assert.match(block, /Cache-Control "no-store" always/);
  // It stays behind the login proxy: not one of the routes let through without a session.
  const skip = read('selfhost/private-app/docker-compose.yml').match(/OAUTH2_PROXY_SKIP_AUTH_ROUTES: "([^"]*)"/)[1];
  assert.doesNotMatch(skip, /desktop/);
  // And the app's own source, which sits in the served folder, is not served.
  const allow = conf.match(/location ~ (\^\/\(index\\\.html\|[^\s]+) \{/)[1];
  for (const file of ['/desktop/main.js', '/desktop/handoff.js', '/desktop/pages/signin.html', '/desktop/package.json']) {
    assert.equal(new RegExp(allow).test(file), false, file);
  }
});

test('the app shows remote pages with nothing of the computer in reach', () => {
  const main = read('desktop/main.js');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  // Its own pages may ask it things; a page from the server may not.
  assert.match(read('desktop/preload.js'), /if \(location\.protocol === "file:"\)/);
  const handlers = main.split('ipcMain.handle("aura:').slice(1);
  assert.equal(handlers.length, 5);
  // Each one asks who is calling before it does anything.
  for (const handler of handlers) assert.match(handler.split('\n').slice(0, 2).join('\n'), /fromOwnPage\(event\)/, handler.slice(0, 40));
});
