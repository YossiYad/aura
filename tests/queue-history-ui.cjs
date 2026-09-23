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
  const browser = await chromium.launch({ headless: true,
    ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    for (const width of [393, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 793 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('aura.settings', JSON.stringify({ autoplay: false, noYtFallback: true, aiHomeSection: false }));
        const titles = ['לשוב הביתה', 'ואיך בשמיים', 'בזמן האחרון', 'שני משוגעים', 'עוד יום', 'בדרך אלייך', 'רגע של שקט', 'לילה טוב'];
        const colors = ['#a15f41', '#436882', '#6f5789', '#566c4d'];
        localStorage.setItem('aura.queue', JSON.stringify({
          extra: Array.from({ length: 30 }, (_, i) => ({ id: 'song' + i, title: titles[i] || 'Song ' + i, artist: 'Demo artist', duration: 180,
            thumb: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="' + colors[i % colors.length] + '"/><circle cx="75" cy="25" r="44" fill="white" opacity=".15"/><path d="M0 90 65 30 100 70V100H0Z" fill="black" opacity=".2"/></svg>') })),
          pos: 3, shuffle: false, repeat: 'off'
        }));
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Player);
      await page.evaluate(() => { Api.resolve = () => new Promise(() => {}); Views.openQueueSheet(); });
      assert.equal(await page.locator('#sheet [data-qi="0"]').count(), 0);
      assert.equal(await page.locator('#queue-history').textContent(), 'History');
      assert.equal(await page.locator('#queue-clear').textContent(), 'Clear');
      assert.equal(await page.locator('[data-qmove], [data-qrm]').count(), 0);
      assert.equal(await page.locator('[data-qi="3"] .reorder-handle').count(), 0);
      await page.waitForTimeout(350);
      const session = await page.context().newCDPSession(page);
      const touchDrag = async (locator, dx, dy, cancel = false) => {
        await locator.scrollIntoViewIfNeeded();
        const b = await locator.boundingBox();
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] });
        await page.waitForTimeout(60);
        await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      };
      await touchDrag(page.locator('[data-qi="4"] .reorder-handle'), 0, 75);
      assert.deepEqual(await page.evaluate(() => Player.upcoming().slice(0, 3).map(t => t.id)), ['song5', 'song4', 'song6']);
      assert.equal(await page.evaluate(() => Player.current().id), 'song3');
      await page.locator('[data-qi="5"] .reorder-handle').focus();
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => Player.upcoming()[0].id), 'song4');
      await touchDrag(page.locator('[data-qi="4"]'), 130, 0, true);
      assert.equal(await page.evaluate(() => Player.upcoming()[0].id), 'song4');
      await touchDrag(page.locator('[data-qi="4"]'), 30, 0);
      assert.equal(await page.evaluate(() => Player.upcoming()[0].id), 'song4');
      const scrollHandle = page.locator('[data-qi="4"] .reorder-handle');
      await scrollHandle.scrollIntoViewIfNeeded();
      const scrollBox = await scrollHandle.boundingBox();
      const edge = await page.locator('#sheet').evaluate(el => Math.min(innerHeight, el.getBoundingClientRect().bottom) - 12);
      const initialScroll = await page.locator('#sheet').evaluate(el => el.scrollTop);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: scrollBox.x + 22, y: scrollBox.y + 22 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: scrollBox.x + 22, y: edge }] });
      await page.waitForTimeout(450);
      assert.ok(await page.locator('#sheet').evaluate(el => el.scrollTop) > initialScroll, 'drag scrolls at the bottom edge');
      await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      assert.equal(await page.evaluate(() => Player.upcoming()[0].id), 'song4');
      // Remove a tail song and add it back so history tests retain their fixture.
      await touchDrag(page.locator('[data-qi="29"]'), -145, 0);
      assert.equal(await page.evaluate(() => Player.queue().some(t => t.id === 'song29')), false);
      await page.evaluate(() => Player.addToQueue(Player.queueHistory().find(e => e.track.id === 'song29').track));
      await page.evaluate(() => { document.getElementById('sheet').scrollTop = 0; });
      if (process.env.AURA_GESTURE_PREVIEW) await page.screenshot({ path: process.env.AURA_GESTURE_PREVIEW });
      await page.locator('#queue-history').click();
      assert.equal(await page.locator('#sheet [data-qhistory]').count(), 30);
      assert.equal(await page.locator('[data-qhistory="song0"] .queue-history-status').textContent(), 'Earlier');
      assert.equal(await page.locator('[data-qhistory="song3"]').getAttribute('aria-current'), 'true');
      await page.evaluate(() => {
        const sheet = document.getElementById('sheet');
        sheet.classList.add('expanded');
        sheet.scrollTop = 150;
        Player.addToQueue({ id: 'added', title: 'Added while open', artist: 'Artist', duration: 180 });
      });
      assert.equal(await page.locator('#sheet [data-qhistory]').count(), 31);
      assert.equal(await page.locator('#sheet').evaluate(el => el.scrollTop), 150);
      assert.equal(await page.locator('#sheet').evaluate(el => el.classList.contains('expanded')), true);
      await page.evaluate(() => { document.getElementById('sheet').scrollTop = 0; });
      const fits = await page.locator('.queue-head').evaluate(el => Array.from(el.querySelectorAll('button')).filter(button => !button.hidden).every(button => {
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.height >= 44;
      }));
      assert.equal(fits, true);
      if (width === 393 && process.env.AURA_QUEUE_PREVIEW) {
        await page.waitForTimeout(300);
        await page.screenshot({ path: process.env.AURA_QUEUE_PREVIEW + '-history.png' });
      }

      // Selection changes existing controls in place, without replaying a song.
      await page.locator('#queue-select').click();
      assert.equal(await page.locator('#queue-save-selection').isDisabled(), true);
      await page.evaluate(() => { window.selectionRow = document.querySelector('[data-qhistory="song0"]'); });
      await page.locator('[data-qhistory="song2"]').click();
      await page.locator('[data-qhistory="song0"]').click();
      assert.equal(await page.locator('#queue-sheet-title').textContent(), '2 selected');
      assert.equal(await page.evaluate(() => Player.current().id), 'song3');
      assert.equal(await page.evaluate(() => selectionRow === document.querySelector('[data-qhistory="song0"]')), true);
      assert.equal(await page.locator('[data-qhistory="song0"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#queue-save-selection').isDisabled(), false);
      const actionFits = await page.locator('#queue-save-selection').evaluate(el => {
        const box = el.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.height >= 44;
      });
      assert.equal(actionFits, true, 'playlist action stays visible without scrolling to the end');
      assert.equal(await page.locator('.queue-selection-check').count(), 0, 'selection is shown by row tint, without checkmarks');
      for (const accent of ['green', 'purple', 'orange', 'pink', 'mono', 'blue']) {
        await page.evaluate(value => { Store.patchSettings({ accent: value }); Views.applyAppearance(); }, accent);
        await page.waitForTimeout(200);
        const colors = await page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.cssText = 'background:var(--accent-soft);color:var(--accent)';
          document.body.appendChild(probe);
          const expected = getComputedStyle(probe);
          const result = {
            tint: getComputedStyle(document.querySelector('[data-qhistory="song0"]')).backgroundColor,
            button: getComputedStyle(document.getElementById('queue-save-selection')).backgroundColor,
            expectedTint: expected.backgroundColor, expectedButton: expected.color
          };
          probe.remove();
          return result;
        });
        assert.equal(colors.tint, colors.expectedTint, accent + ' selected rows use the translucent theme accent');
        assert.equal(colors.button, colors.expectedButton, accent + ' save action uses the theme accent');
      }
      if (width === 393 && process.env.AURA_QUEUE_PREVIEW) {
        await page.screenshot({ path: process.env.AURA_QUEUE_PREVIEW + '-selection.png' });
      }
      await page.evaluate(() => {
        Player.addToQueue({ id: 'refill', title: 'Newly added song', artist: 'Artist', duration: 180 });
      });
      assert.equal(await page.locator('#queue-sheet-title').textContent(), '2 selected');
      assert.equal(await page.locator('[data-qhistory="song0"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-qhistory="refill"]').getAttribute('aria-pressed'), 'false');

      const existingPlaylist = await page.evaluate(() => {
        const playlist = Store.createPlaylist('Already saved');
        Store.addTrack(Player.queueHistory()[0].track);
        Store.addToPlaylist(playlist.id, 'song0');
        return playlist.id;
      });
      await page.locator('#queue-save-selection').click();
      await page.locator('#sheet [data-pl="' + existingPlaylist + '"]').click();
      await page.waitForFunction(() => document.getElementById('sheet').hidden);
      assert.deepEqual(await page.evaluate(id => Store.getPlaylist(id).ids, existingPlaylist), ['song0', 'song2']);
      assert.equal(await page.evaluate(() => Player.current().id), 'song3');

      // The same selection can create a named playlist in history order.
      await page.evaluate(() => Views.openQueueSheet(true));
      await page.locator('#queue-select').click();
      await page.locator('[data-qhistory="song1"]').click();
      await page.locator('[data-qhistory="song0"]').click();
      await page.locator('#queue-save-selection').click();
      await page.locator('[data-act="newpl"]').click();
      await page.locator('#modal-input').fill('Road mix');
      await page.locator('#modal-ok').click();
      await page.waitForFunction(() => document.getElementById('modal').hidden);
      assert.deepEqual(await page.evaluate(() => Store.playlists().find(p => p.name === 'Road mix').ids), ['song0', 'song1']);
      assert.equal(await page.evaluate(() => Player.current().id), 'song3');

      await page.evaluate(() => Views.openQueueSheet(true));
      await page.locator('#queue-select').click();
      await page.locator('#queue-select-all').click();
      assert.equal(await page.locator('#queue-sheet-title').textContent(), '32 selected');
      await page.locator('#queue-select-all').click();
      assert.equal(await page.locator('#queue-sheet-title').textContent(), '0 selected');
      await page.locator('#queue-select').click();
      assert.equal(await page.locator('#queue-sheet-title').textContent(), 'Queue history');
      assert.equal(await page.locator('#queue-save-selection').isVisible(), false);
      assert.equal(await page.locator('[data-qhistory="song0"]').getAttribute('aria-pressed'), null);

      await page.locator('[data-qhistory="song0"]').click();
      await page.waitForFunction(() => document.getElementById('sheet').hidden);
      assert.equal(await page.evaluate(() => Player.current().id), 'song0');
      assert.equal(await page.evaluate(() => Player.queue()[Player.pos() + 1].id), 'song4');
      await page.evaluate(() => Views.openQueueSheet());
      await page.locator('#queue-history').click();
      assert.equal(await page.locator('#sheet [data-qhistory]').count(), 32);
      await page.locator('#queue-history').click();
      await page.locator('#queue-clear').click();
      await page.locator('#queue-history').click();
      assert.equal(await page.locator('#sheet [data-qhistory]').count(), 32);
      assert.equal(await page.locator('[data-qhistory="added"] .queue-history-status').textContent(), 'Removed from queue');
      await page.locator('#queue-select').click();
      await page.locator('[data-qhistory="song0"]').click();
      await page.evaluate(() => Player.playQueue([{ id: 'song0', title: 'Song 0', artist: 'Artist', duration: 180 }]));
      assert.equal(await page.locator('#queue-sheet-title').textContent(), 'Queue history');
      assert.equal(await page.locator('[data-qhistory="song0"]').getAttribute('aria-pressed'), null);
      await page.evaluate(() => Player.playQueue([{ id: 'new-session', title: 'New session', artist: 'Artist', duration: 180 }]));
      assert.equal(await page.locator('#sheet [data-qhistory]').count(), 1);
      assert.equal(await page.locator('[data-qhistory="new-session"]').getAttribute('aria-current'), 'true');

      // Keep the history open while shuffle advances through a different physical order.
      await page.evaluate(() => {
        Player.playQueue(['a', 'b', 'c', 'd'].map(id => ({ id, title: id, artist: 'Artist', duration: 180 })), 3);
        const random = Math.random;
        try { Math.random = () => 0; Player.setShuffle(true); }
        finally { Math.random = random; }
      });
      const historyRows = () => page.locator('#sheet [data-qhistory]').evaluateAll(rows => rows.map(row => [
        row.dataset.qhistory, row.querySelector('.queue-history-status').textContent
      ]));
      assert.deepEqual(await historyRows(), [['d', 'Now playing'], ['b', 'Up next'], ['c', 'Up next'], ['a', 'Up next']]);
      await page.evaluate(() => Player.next());
      assert.deepEqual(await historyRows(), [['d', 'Earlier'], ['b', 'Now playing'], ['c', 'Up next'], ['a', 'Up next']]);
      await page.evaluate(() => Player.next());
      assert.deepEqual(await historyRows(), [['d', 'Earlier'], ['b', 'Earlier'], ['c', 'Now playing'], ['a', 'Up next']]);
      assert.deepEqual(errors, []);
      await page.close();
      console.log('Queue history, selection, existing and new playlists, and session reset passed at ' + width + 'px');
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
