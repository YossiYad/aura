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
    browser = await chromium.launch({ headless: true, ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
    for (const width of [320, 393, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width < 500, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Store);
      await page.evaluate(() => {
        Store.patchSettings({ autoplay: false, nightlyPrebuild: false, aiHomeSection: false });
        const p = Store.createPlaylist('Test mix');
        for (let i = 0; i < 12; i++) {
          Store.addTrack({ id: 'song' + i, title: 'Song ' + i, artist: 'Artist', duration: 180 });
          Store.addToPlaylist(p.id, 'song' + i);
        }
        Views.showTab('library');
      });
      const open = async () => page.locator('#view [data-pl]').first().click();
      await open();
      await page.locator('#collection-query').fill('Song 3');
      await page.locator('#collection-sort').click();
      await page.locator('#playlist-reorder').click();
      assert.equal(await page.locator('[data-order-id]').count(), 12);
      assert.equal(await page.locator('#collection-query').count(), 0);
      assert.equal(await page.locator('[data-playlist-move]').count(), 0);
      const handle = page.locator('[data-order-id="song0"] .reorder-handle');
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      const target = await page.locator('[data-order-id="song1"]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, target.y + target.height * .75, { steps: 12 });
      await page.waitForTimeout(80);
      await page.mouse.up();
      assert.deepEqual(await page.locator('[data-order-id]').evaluateAll(rows => rows.slice(0, 3).map(r => r.dataset.orderId)), ['song1', 'song0', 'song2']);
      assert.equal(await page.evaluate(() => Player.current()), null);
      assert.equal(await page.evaluate(() => document.activeElement.closest('[data-order-id]').dataset.orderId), 'song0');
      assert.equal(await page.locator('[data-order-id="song0"]').evaluate(row => Array.from(row.querySelectorAll('button')).every(b => {
        const box = b.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth;
      })), true);
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.locator('[data-order-id]').first().getAttribute('data-order-id'), 'song0');
      await page.keyboard.press('ArrowDown');
      const cancelBox = await page.locator('[data-order-id="song0"] .reorder-handle').boundingBox();
      await page.mouse.move(cancelBox.x + 22, cancelBox.y + 22);
      await page.mouse.down();
      await page.mouse.move(cancelBox.x + 22, cancelBox.y + 100, { steps: 8 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      assert.deepEqual(await page.locator('[data-order-id]').evaluateAll(rows => rows.slice(0, 3).map(r => r.dataset.orderId)), ['song1', 'song0', 'song2']);
      await page.locator('#playlist-reorder').click();
      assert.equal(await page.locator('#collection-sort').innerText(), 'Playlist order');
      await page.reload();
      await page.waitForFunction(() => window.Views && window.Store);
      await page.evaluate(() => Views.showTab('library'));
      await open();
      assert.deepEqual(await page.locator('#collection-list .song').evaluateAll(rows => rows.slice(0, 3).map(r => r.dataset.id)), ['song1', 'song0', 'song2']);
      // Exercise real queue construction while holding stream lookup pending.
      await page.evaluate(() => {
        Api.resolve = () => new Promise(() => {});
        Player.setShuffle(true);
      });
      const playlistIds = await page.evaluate(() => Store.playlists()[0].ids);
      const playback = () => page.evaluate(() => ({
        current: Player.current().id, shuffle: Player.shuffle(),
        ids: Player.queue().map(t => t.id), upcoming: Player.upcoming().map(t => t.id)
      }));
      await page.locator('#hero-play').click();
      assert.deepEqual(await playback(), {
        current: playlistIds[0], shuffle: false, ids: playlistIds, upcoming: playlistIds.slice(1)
      });
      await page.evaluate(() => Player.setShuffle(true));
      await page.locator('#collection-list [data-id="song3"] .song-title').click();
      assert.deepEqual(await playback(), {
        current: 'song3', shuffle: false, ids: playlistIds, upcoming: playlistIds.slice(4)
      });
      await page.evaluate(() => Player.setShuffle(true));
      await page.locator('#collection-list [data-menu="song2"]').click();
      await page.locator('#sheet [data-act="play"]').click();
      assert.deepEqual(await playback(), {
        current: 'song2', shuffle: false, ids: playlistIds, upcoming: playlistIds.slice(3)
      });
      await page.waitForFunction(() => document.getElementById('sheet').hidden);
      await page.locator('#hero-shuffle').click();
      assert.equal((await playback()).shuffle, true, 'Explicit shuffle remains available');
      await page.locator('#collection-query').fill('Song 3');
      await page.locator('#hero-play').click();
      assert.deepEqual(await playback(), {
        current: 'song3', shuffle: false, ids: ['song3'], upcoming: []
      });
      await page.locator('#collection-query').fill('');
      await page.evaluate(() => Player.dismiss());
      await page.locator('#back-btn').click();
      await page.waitForSelector('#view [data-plmenu]');
      await page.evaluate(() => Player.setShuffle(true));
      await page.locator('#view [data-plmenu]').first().click();
      await page.locator('#sheet [data-act="play"]').click();
      assert.deepEqual(await playback(), {
        current: playlistIds[0], shuffle: false, ids: playlistIds, upcoming: playlistIds.slice(1)
      });
      await page.waitForFunction(() => document.getElementById('sheet').hidden);
      await page.evaluate(() => Player.dismiss());
      await open();
      await page.evaluate(() => { Player.playQueue = tracks => { window.playedIds = tracks.map(t => t.id); }; });
      await page.locator('#hero-play').click();
      assert.deepEqual(await page.evaluate(() => window.playedIds.slice(0, 3)), ['song1', 'song0', 'song2']);
      // Native touch input verifies pan-y arbitration and the removal threshold.
      const session = await page.context().newCDPSession(page);
      const swipe = async (locator, dx) => {
        await locator.scrollIntoViewIfNeeded();
        const b = await locator.boundingBox();
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 8; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 8, y }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await swipe(page.locator('#collection-list [data-id="song0"]'), 35);
      assert.equal(await page.locator('#collection-list [data-id="song0"]').count(), 1);
      await swipe(page.locator('#collection-list [data-id="song0"]'), -145);
      assert.equal(await page.locator('#collection-list [data-id="song0"]').count(), 0);
      await page.locator('.toast button').click();
      assert.deepEqual(await page.locator('#collection-list .song').evaluateAll(rows => rows.slice(0, 3).map(r => r.dataset.id)), ['song1', 'song0', 'song2']);
      // A hold owns the gesture once its menu opens, even if the finger then slides.
      const heldRow = page.locator('#collection-list [data-id="song0"]');
      await heldRow.scrollIntoViewIfNeeded();
      const heldBox = await heldRow.boundingBox();
      const heldX = heldBox.x + heldBox.width / 2, heldY = heldBox.y + heldBox.height / 2;
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: heldX, y: heldY }] });
      await page.waitForTimeout(550);
      assert.equal(await page.locator('#sheet [data-track-menu="song0"]').count(), 1);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: heldX - 145, y: heldY }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await heldRow.count(), 1);
      assert.equal(await page.evaluate(() => Store.playlists()[0].ids.includes('song0')), true);
      assert.deepEqual(errors, []);
      await page.close();
      console.log('Playlist reorder, persistence and playback passed at ' + width + 'px');
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
