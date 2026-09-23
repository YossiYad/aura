// Run with Playwright on NODE_PATH and Chromium installed. Uses only local demo data.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname === '/guest/' ? 'guest/index.html' : pathname);
  if (!file.startsWith(root + '/')) return res.writeHead(403).end();
  fs.readFile(file, (error, body) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    for (const width of [393, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 850 }, locale: 'en-US', serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/api/queue/')) return route.fulfill({ json: { room: null } });
        return url.startsWith(origin) ? route.continue() : route.abort();
      });
      await page.addInitScript(() => {
        if (!localStorage.getItem('aura.settings')) localStorage.setItem('aura.settings', JSON.stringify({ autoplay: false, nightlyPrebuild: false, aiHomeSection: false }));
        localStorage.setItem('aura.library', JSON.stringify([{ id: 'hebrew-song', title: 'חיפוש', artist: 'אמן לדוגמה', duration: 180, kind: 'music' }]));
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.I18n && window.SharedQueue && SharedQueue.available());
      await page.evaluate(() => Views.showTab('ai'));
      assert.equal(await page.locator('#ask-note').textContent(), 'Tap to speak');
      assert.equal(await page.locator('#ask-voice').getAttribute('aria-label'), 'Voice request, tap to speak');
      assert.equal(await page.locator('#drive-voice').getAttribute('aria-label'), 'Voice request with Aura AI');
      await page.evaluate(() => { window.languageMarker = 42; Views.openSettings(); });
      await page.locator('#set-interface-lang [data-val="he"]').click();
      assert.equal(await page.evaluate(() => window.languageMarker), 42, 'switching does not reload the player');
      assert.equal(await page.evaluate(() => Store.settings().interfaceLanguage), 'he');
      await page.evaluate(() => Views.showTab('ai'));
      assert.equal(await page.locator('#ask-note').textContent(), 'לחצו ודברו');
      await page.reload();
      await page.waitForFunction(() => window.Views && window.I18n);
      assert.equal(await page.evaluate(() => I18n.language()), 'he');
      await page.evaluate(() => Views.openSettings());
      await page.locator('#set-interface-lang [data-val="en"]').click();
      await page.evaluate(() => Views.showTab('library'));
      await page.locator('[data-chip="songs"]').click();
      assert.match(await page.locator('.song[data-id="hebrew-song"]').textContent(), /חיפוש/);
      await page.evaluate(() => Views.openSharedQueue());
      await page.locator('#sq-create').waitFor();
      assert.equal(await page.locator('#shared-queue-panel').getAttribute('dir'), 'ltr');
      assert.equal(await page.locator('#sq-title').inputValue(), 'Our music');
      assert.equal(await page.locator('#sq-create button').textContent(), 'Create invitation QR');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 393, height: 850 }, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const room = { title: 'Evening together', expiresAt: Date.now() + 3600000, name: 'חיפוש', joined: true, joinStatus: 'approved', permission: 'approval', requests: [
      { id: 'guest-song', name: 'חיפוש', fromHost: false, status: 'pending', votes: 2, track: { id: 'demo', title: 'לחצו ודברו', artist: 'אמן לדוגמה' } },
      { id: 'host-song', name: 'המארחים', fromHost: true, status: 'approved', votes: 0, track: { id: 'hostdemo', title: 'Evening light', artist: 'Demo artist' } }
    ] };
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/guest/api/')) return route.fulfill({ json: { room } });
      return url.startsWith(origin) ? route.continue() : route.abort();
    });
    await page.goto(origin + '/guest/#' + 'a'.repeat(32));
    await page.locator('#welcome').waitFor();
    assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
    assert.equal(await page.locator('#welcome').textContent(), 'Hi חיפוש');
    assert.match(await page.locator('#requests').textContent(), /לחצו ודברו/);
    assert.match(await page.locator('#requests').textContent(), /חיפוש/);
    assert.match(await page.locator('#approved-tracks').textContent(), /Hosts/);
    await page.locator('#guest-language').selectOption('he');
    await page.waitForURL('**/guest/?lang=he#*');
    await page.locator('#welcome').waitFor();
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#welcome').textContent(), 'היי חיפוש');
    assert.equal(new URL(page.url()).hash, '#' + 'a'.repeat(32));
    assert.deepEqual(errors, []);
    await page.close();
    console.log('Language switching, persistence, mixed Hebrew UI, guest layout and unchanged content passed.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
