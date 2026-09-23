// Run with Playwright available via NODE_PATH and an installed Chromium browser.
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
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [393, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('aura.settings', JSON.stringify({ autoplay: false, nightlyPrebuild: false, aiHomeSection: false }));
        localStorage.setItem('aura.library', JSON.stringify([
          { id: 'song', title: 'Saved song', artist: 'Publisher', duration: 180, kind: 'music' },
          { id: 'episode', title: 'Saved episode', artist: 'Publisher', duration: 1800, kind: 'podcast', podcast: 'Science Hour' }
        ]));
        localStorage.setItem('aura.liked', JSON.stringify(['song', 'episode']));
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Store);
      await page.evaluate(() => Views.showTab('library'));
      await page.locator('[data-chip="songs"]').click();
      assert.equal(await page.locator('.song[data-id="song"]').count(), 1);
      assert.equal(await page.locator('.song[data-id="episode"]').count(), 0);
      await page.locator('[data-chip="podcasts"]').click();
      assert.equal(await page.locator('.song[data-id="episode"]').count(), 1);
      assert.equal(await page.locator('.song[data-id="song"]').count(), 0);
      await page.locator('[data-quick="likedPodcast"]').click();
      assert.equal(await page.locator('.song[data-id="episode"]').count(), 1);
      assert.equal(await page.locator('.song[data-id="song"]').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Podcast library separation passed at mobile and desktop widths');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
