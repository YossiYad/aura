// Run with Playwright, pngjs and jsqr on NODE_PATH, and an installed Chromium.
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createQueueService } = require('../selfhost/private-app/queue/server');
const root = path.resolve(__dirname, '..');
let service;
const proxy = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const guest = pathname.startsWith('/guest/');
  const signedIn = /(?:^|; )test_host=yes(?:;|$)/.test(req.headers.cookie || '');
  if (!guest && !signedIn) return res.writeHead(401).end('Sign in required');
  if (pathname.startsWith('/api/queue/') || pathname.startsWith('/guest/api/')) {
    const backend = guest ? service.guest : service.host;
    const headers = { ...req.headers, 'x-forwarded-email': guest ? '' : 'owner@example.test' };
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.address().port, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream); return;
  }
  if (pathname.startsWith('/api/')) return res.writeHead(404).end('{}');
  if (pathname === '/config.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname === '/guest/' ? 'guest/index.html' : pathname);
  if (!file.startsWith(root + '/')) return res.writeHead(403).end();
  fs.readFile(file, (error, body) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    if (pathname === '/guest/') res.setHeader('Content-Security-Policy', fs.readFileSync(path.join(root, 'selfhost/private-app/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)" always/)[1]);
    res.end(body);
  });
});

(async () => {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  service = createQueueService({ origin, fetch: async () => new Response(JSON.stringify([
    { type: 'video', videoId: 'song0000001', title: 'לשוב הביתה', author: 'אמן לדוגמה', lengthSeconds: 180 },
    { type: 'video', videoId: 'song0000002', title: 'שיר לדרך', author: 'אמן לדוגמה', lengthSeconds: 200 },
    { type: 'video', videoId: 'song0000003', title: '<img src=x onerror=alert(1)>', author: 'Untrusted title', lengthSeconds: 190 }
  ])) });
  await Promise.all(Object.values(service).map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const browser = await chromium.launch({ headless: true, ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    const hostContext = await browser.newContext({ viewport: { width: 393, height: 850 }, serviceWorkers: 'block', locale: 'he-IL' });
    await hostContext.addCookies([{ name: 'test_host', value: 'yes', url: origin }]);
    await hostContext.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await hostContext.addInitScript(() => localStorage.setItem('aura.settings', JSON.stringify({ interfaceLanguage: 'he', autoplay: false, noYtFallback: true, aiHomeSection: false })));
    const host = await hostContext.newPage(), errors = [];
    host.on('pageerror', error => errors.push(error.message));
    await host.goto(origin);
    await host.waitForFunction(() => window.SharedQueue && SharedQueue.available());
    await host.evaluate(() => { Api.resolve = () => new Promise(() => {}); Views.openCreateSheet(); });
    await host.locator('[data-act="sharedqueue"]').click();
    await host.locator('#sq-title').fill('הנסיעה שלנו');
    await host.locator('#sq-create button').click();
    await host.locator('#sq-qr').waitFor();
    await host.waitForFunction(() => document.getElementById('sq-qr').naturalWidth > 0);
    const png = PNG.sync.read(await host.locator('#sq-qr').screenshot());
    const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert(qr, 'The QR can be decoded from its rendered image');
    assert(qr.data.startsWith(origin + '/guest/#'));

    const guestContext = await browser.newContext({ viewport: { width: 393, height: 850 }, serviceWorkers: 'block', locale: 'he-IL' });
    // Serve deterministic artwork so the test works without external image requests.
    const cover = new PNG({ width: 64, height: 52 });
    for (let i = 0; i < cover.data.length; i += 4) { cover.data[i] = 62; cover.data[i + 1] = 93; cover.data[i + 2] = 142; cover.data[i + 3] = 255; }
    await guestContext.route('https://i.ytimg.com/**', route => route.fulfill({ contentType: 'image/png', body: PNG.sync.write(cover) }));
    const guest = await guestContext.newPage();
    guest.on('pageerror', error => errors.push(error.message));
    assert.equal((await guestContext.request.get(origin + '/')).status(), 401);
    assert.equal((await guestContext.request.get(origin + '/api/queue/')).status(), 401);
    await guest.goto(qr.data);
    await guest.locator('#name').fill('נועה');
    await guest.locator('#join button').click();
    await guest.locator('#waiting').waitFor({ state: 'visible' });
    assert(await guest.locator('#joined').isHidden());
    await host.locator('#sq-refresh').click();
    await host.locator('#sq-joins').getByText('נועה', { exact: false }).waitFor();
    await host.locator('#sq-joins [data-action="approve"]').click();
    await guest.reload();
    await guest.locator('#joined').waitFor({ state: 'visible' });
    await host.locator('#sq-refresh').click();
    await host.locator('#sq-guests').getByText('נועה', { exact: false }).waitFor();
    assert.match(await host.locator('#sq-people-title').textContent(), /1 מחוברים/);
    await guest.locator('#query').fill('לשוב הביתה');
    // Typing starts the same live-search interaction as the app's Search page.
    await guest.locator('[data-suggest="song0000001"]').waitFor();
    assert.match(await guest.locator('[data-suggest="song0000001"]').textContent(), /בקש להוסיף/);
    await guest.waitForFunction(() => document.querySelector('#results img')?.naturalWidth > 0);
    await guest.locator('[data-suggest="song0000001"]').click();
    await guest.waitForFunction(() => document.querySelector('[data-suggest="song0000001"]').textContent.includes('נשלחה בקשה'));
    assert(await guest.locator('[data-suggest="song0000001"]').isDisabled());
    await host.locator('#sq-refresh').click();
    // The floating control carries the same decision; the panel's own button is meant here.
    await host.locator('#sq-requests [data-action="approve"]').waitFor();
    assert.equal(await host.evaluate(() => Player.queue().length), 0);
    await host.locator('#sq-requests [data-action="approve"]').click();
    await host.waitForFunction(() => Player.queue().some(t => t.id === 'song0000001'));
    await host.locator('#sq-guests select').selectOption('direct');
    await guest.reload();
    await guest.locator('#permission').getByText('הוספה חופשית לתור').waitFor();
    await guest.locator('#query').fill('שיר לדרך');
    await guest.locator('#search-submit').click();
    await guest.locator('[data-suggest="song0000002"]').waitFor();
    assert.match(await guest.locator('[data-suggest="song0000002"]').textContent(), /הוסף/);
    assert(await guest.locator('[data-suggest="song0000001"]').isDisabled(), 'Already approved songs remain disabled after another search');
    await guest.locator('[data-suggest="song0000002"]').click();
    await guest.waitForFunction(() => document.querySelector('[data-suggest="song0000002"]').textContent.includes('נוסף לתור'));
    assert(await guest.locator('[data-suggest="song0000002"]').isDisabled());
    await host.locator('#sq-refresh').click();
    await host.waitForFunction(() => Player.queue().some(t => t.id === 'song0000002'));
    await host.locator('#sq-refresh').click();
    assert.equal(await host.evaluate(() => Player.queue().filter(t => t.id === 'song0000002').length), 1);
    assert.equal(await guest.locator('#results .track-title img').count(), 0, 'Search metadata renders as text');
    assert.equal(await guest.locator('#results img').count(), 3, 'Only the validated cover images are rendered');
    assert.match(await guest.locator('#results .track-title').last().textContent(), /<img src=x onerror=alert\(1\)>/);

    // Another named participant votes independently, with no private application session.
    const secondContext = await browser.newContext({ viewport: { width: 320, height: 740 }, serviceWorkers: 'block', locale: 'he-IL' });
    const second = await secondContext.newPage();
    await second.goto(qr.data);
    await second.locator('#name').fill('איתי');
    await second.locator('#join button').click();
    await second.locator('#waiting').waitFor({ state: 'visible' });
    await host.locator('#sq-refresh').click();
    await host.locator('#sq-joins [data-action="approve"]').click();
    await second.reload();
    await second.locator('#joined').waitFor({ state: 'visible' });
    await second.locator('#query').fill('שיר');
    await second.locator('#search-submit').click();
    await second.locator('[data-suggest="song0000003"]').click();
    await second.locator('#menu-toggle').click();
    await second.locator('#nav-home').click();
    assert(await second.locator('#page-home').isVisible());
    assert(await second.locator('#search-area').isHidden());
    await second.locator('[data-vote]').click();
    await second.waitForFunction(() => document.querySelector('[data-vote]')?.getAttribute('aria-pressed') === 'true');
    await host.locator('#sq-refresh').click();
    await host.locator('#sq-guests').getByText('איתי', { exact: false }).waitFor();
    await host.locator('#sq-requests').getByText(/1 הצבעות/).waitFor();

    for (const page of [host, guest, second]) {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow on mobile');
    }
    await host.screenshot({ path: process.env.AURA_HOST_PREVIEW || '/tmp/aura-shared-queue-host.png' });
    await guest.screenshot({ path: process.env.AURA_GUEST_PREVIEW || '/tmp/aura-shared-queue-guest.png', fullPage: true });
    await guest.locator('#menu-toggle').click();
    assert.equal(await guest.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    await guest.screenshot({ path: '/tmp/aura-guest-menu.png' });
    await guest.keyboard.press('Escape');
    assert(await guest.locator('#navigation').isHidden());
    assert.equal(await guest.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    await guest.locator('#menu-toggle').click();
    await guest.locator('#nav-home').click();
    assert.equal(await guest.locator('#nav-home').getAttribute('aria-current'), 'page');
    assert.equal(await guest.locator('#approved-tracks .music-card').count(), 2);
    await guest.screenshot({ path: '/tmp/aura-guest-home.png', fullPage: true });
    for (const width of [320, 720, 1280]) {
      await guest.setViewportSize({ width, height: 850 });
      assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No home overflow at ' + width);
      await guest.locator('#home-search').click();
      assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No search overflow at ' + width);
      await guest.locator('#menu-toggle').click();
      await guest.locator('#nav-home').click();
    }
    await guest.locator('#home-search').click();
    assert.equal(await guest.locator('#query').inputValue(), 'שיר לדרך', 'Navigation preserves the search');
    await guest.locator('#search-clear').click();
    assert.equal(await guest.locator('#query').inputValue(), '');
    assert(await guest.locator('#results-section').isHidden());
    assert(await guest.locator('#search-empty').isVisible());
    // Empty/error recovery and responses superseded by a newer search.
    let releaseOld;
    const oldSearchGate = new Promise(resolve => { releaseOld = resolve; });
    await guestContext.route('**/guest/api/search', async route => {
      const query = route.request().postDataJSON().query;
      if (query === 'תקלה') return route.fulfill({ status: 503, json: { error: 'החיפוש אינו זמין. נסו שוב.' } });
      if (query === 'ישן') {
        await oldSearchGate;
        return route.fulfill({ json: { tracks: [{ id: 'song0000009', title: 'תוצאה ישנה', artist: 'ישן' }] } }).catch(() => {});
      }
      return route.fulfill({ json: { tracks: query === 'ריק' ? [] : [{ id: 'song0000008', title: 'תוצאה חדשה', artist: 'חדש' }] } });
    });
    await guest.locator('#query').fill('ריק');
    await guest.locator('#search-status').getByText(/לא נמצאו שירים/).waitFor();
    await guest.locator('#query').fill('תקלה');
    await guest.locator('#search-status').getByText(/החיפוש אינו זמין/).waitFor();
    await guest.locator('#query').fill('ישן');
    await guest.locator('#search-status').getByText('מחפשים שירים…').waitFor();
    await guest.locator('#query').fill('חדש');
    await guest.locator('[data-suggest="song0000008"]').waitFor();
    releaseOld();
    assert.equal(await guest.locator('[data-suggest="song0000009"]').count(), 0);
    await host.locator('#sq-guests select').first().selectOption('approval');
    await guest.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await guest.waitForFunction(() => document.querySelector('[data-suggest="song0000008"]')?.textContent.includes('בקש להוסיף'));
    await host.locator('#sq-guests select').first().selectOption('vote');
    await guest.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await guest.locator('#permission').getByText('צפייה והצבעה').waitFor();
    assert(await guest.locator('#search').isHidden());
    assert(await guest.locator('#page-home').isVisible());
    await guest.locator('#menu-toggle').click();
    assert(await guest.locator('#nav-search').isHidden());
    await guest.locator('#menu-close').click();
    await host.locator('#sq-end').click();
    await host.locator('#sq-create').waitFor();
    await guest.reload();
    await guest.locator('#message').getByText('AuraShare נסגר או שהקישור פג תוקף.').waitFor();
    assert(await guest.locator('#joined').isHidden());
    // The mode belongs to the invitation: Create says why an invitation made from Queue
    // did not pause the music, and the floating control reopens it without that note.
    assert.equal(await host.evaluate(() => Player.shareSession()), '');
    await host.evaluate(() => Views.openQueueSheet());
    await host.locator('#queue-shared').click();
    await host.locator('#sq-create button').click();
    await host.locator('#sq-qr').waitFor();
    assert.equal(await host.evaluate(() => Player.shareSession()), '', 'An invitation from Queue leaves the personal queue in charge');
    assert(await host.locator('#sq-mode-note').isHidden());
    await host.evaluate(() => Views.openCreateSheet());
    await host.locator('[data-act="sharedqueue"]').click();
    await host.locator('#sq-mode-note').getByText(/מחוברת לתור הקיים/).waitFor();
    await host.evaluate(() => Views.openSharedQueue());
    await host.locator('#sq-qr').waitFor();
    assert(await host.locator('#sq-mode-note').isHidden());
    await host.locator('#sq-end').click();
    await host.locator('#sq-create').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: rendered QR, named guests, presence, private access, approvals, direct additions, votes, permission changes, mobile layout and revocation');
  } finally {
    await browser.close();
    for (const server of [proxy, ...Object.values(service)]) { server.closeAllConnections(); server.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
