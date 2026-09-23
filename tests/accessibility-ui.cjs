// Run with Playwright on NODE_PATH and Chromium installed. Uses only local demo data.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
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
    for (const width of [320, 393, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, locale: 'en-US', serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        if (!localStorage.getItem('aura.settings')) localStorage.setItem('aura.settings', JSON.stringify({ interfaceLanguage: 'en', autoplay: false, nightlyPrebuild: false, aiHomeSection: false }));
        localStorage.setItem('aura.library', JSON.stringify([{ id: 'demo', title: 'Evening light', artist: 'Demo artist', duration: 180, kind: 'music' }]));
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Store);

      // The tab bar is navigation: the page on show is marked, and follows every switch.
      assert.equal(await page.locator('#tabs').getAttribute('role'), null);
      assert.equal(await page.locator('#tabs [aria-current="page"]').getAttribute('data-tab'), 'home');
      await page.evaluate(() => Views.showTab('library'));
      assert.equal(await page.locator('#tabs [aria-current="page"]').getAttribute('data-tab'), 'library');
      assert.equal(await page.locator('#tabs [aria-current]').count(), 1);
      assert.equal(await page.locator('#toasts').getAttribute('aria-live'), 'polite');

      // Language is the first setting, titled so a reader of either language finds it,
      // and every choice group is named for a screen reader.
      await page.evaluate(() => Views.openSettings());
      assert.match(await page.locator('#settings-appearance .set-title').first().textContent(), /Language · שפה/);
      assert.equal(await page.locator('#set-text-size').getAttribute('aria-label'), 'Text size');
      assert.equal(await page.locator('#set-interface-lang').getAttribute('aria-label'), 'Language · שפה');

      // Text size scales what is read, is saved, and survives a reload.
      const titleSize = () => page.locator('#settings-appearance .set-title').first().evaluate(el => el.getBoundingClientRect().height);
      const before = await titleSize();
      await page.locator('#set-text-size [data-val="larger"]').click();
      assert.equal(await page.locator('html').getAttribute('data-text-size'), 'larger');
      assert.equal(await page.evaluate(() => Store.settings().textSize), 'larger');
      assert.ok(await titleSize() > before * 1.2, 'larger text is drawn larger');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling');
      await page.reload();
      await page.waitForFunction(() => window.Views && window.Store);
      assert.equal(await page.locator('html').getAttribute('data-text-size'), 'larger');

      // A dialog at the largest size still fits on the screen, and Escape closes it.
      await page.evaluate(() => { const s = Store.settings(); delete s.interfaceLanguage; localStorage.setItem('aura.settings', JSON.stringify(s)); });
      await page.reload();
      await page.locator('.lang-welcome').waitFor();
      const dialog = await page.locator('.lang-welcome').boundingBox();
      assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= 800 && dialog.x >= 0 && dialog.x + dialog.width <= width, 'dialog fits: ' + JSON.stringify(dialog));
      await page.keyboard.press('Escape');
      await page.locator('.lang-welcome').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => Store.settings().interfaceLanguage), 'en');

      // Escape closes a sheet too.
      await page.evaluate(() => Views.openCreateSheet());
      await page.waitForFunction(() => !document.getElementById('sheet').hidden);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.getElementById('sheet').hidden);

      // High contrast brightens secondary text, from Settings or from the system.
      const muted = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim());
      const normal = await muted();
      await page.evaluate(() => Views.openSettings());
      await page.locator('label:has(#set-contrast)').click();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('high-contrast')), true);
      assert.notEqual(await muted(), normal);
      await page.locator('label:has(#set-contrast)').click();
      assert.equal(await muted(), normal);
      await page.emulateMedia({ contrast: 'more' });
      assert.notEqual(await muted(), normal, 'the system preference applies without the setting');
      await page.emulateMedia({ contrast: 'no-preference' });

      // Back to the default size, and the design is exactly as drawn.
      await page.locator('#set-text-size [data-val="default"]').click();
      assert.equal(await page.locator('html').getAttribute('data-text-size'), null);
      assert.ok(Math.abs(await titleSize() - before) < 0.5);
      assert.deepEqual(errors, []);
      await page.close();
      console.log('Accessibility settings passed at ' + width + 'px');
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
