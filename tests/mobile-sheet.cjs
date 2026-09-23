// Run with Playwright available via NODE_PATH. Native touch scrolling is exercised
// in mobile Chromium; physical iOS animation smoothness still needs a phone check.
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
  const browser = await chromium.launch({ headless: true, ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    for (const height of [793, 600]) {
      const page = await browser.newPage({ viewport: { width: 393, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      let sharedRoom = null;
      await page.route(origin + '/api/queue/', route => route.fulfill({ json: { room: sharedRoom } }));
      await page.route(origin + '/api/queue/qr.svg?*', route => route.fulfill({
        contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"/>'
      }));
      await page.addInitScript(() => localStorage.setItem('aura.settings', JSON.stringify({ interfaceLanguage: 'en' })));
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Player);
      await page.evaluate(() => {
        window.track = { id: 'sheet-test-song', title: 'Menu test song', artist: 'Test artist' };
        Store.addTrack(track);
        window.plays = 0;
        Player.playQueue = () => plays++;
        document.getElementById('view').innerHTML = '<button class="card" data-recent="sheet-test-song" style="height:160px;width:160px"><div class="card-art"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt=""></div>Menu test song</button><div style="height:1500px"></div>';
        window.sheet = document.getElementById('sheet');
        window.sendSheetTouch = (type, x, y, options = {}) => {
          const event = new Event(type, { bubbles: true, cancelable: options.cancelable !== false });
          Object.defineProperty(event, 'touches', { value: Array.from({ length: /end|cancel/.test(type) ? 0 : (options.count || 1) }, () => ({ clientX: x, clientY: y })) });
          (options.target || sheet).dispatchEvent(event);
          return event.defaultPrevented;
        };
        window.sheetBox = () => {
          const rect = sheet.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, scroll: sheet.scrollTop, expanded: sheet.classList.contains('expanded'), dragging: sheet.classList.contains('dragging') };
        };
      });
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, x = 180, y = 300) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: /End|Cancel/.test(type) ? [] : [{ x, y }]
      });
      const tile = await page.locator('[data-recent="sheet-test-song"]').boundingBox();
      await touch('touchStart', tile.x + 70, tile.y + 70);
      await page.waitForFunction(() => !sheet.hidden);
      await touch('touchMove', tile.x + 70, tile.y + 180);
      await page.waitForTimeout(40);
      assert.equal(await page.locator('#view').evaluate(el => el.getBoundingClientRect().top - el.offsetTop), 0, 'continuing the long hold must not pull the home screen');
      await touch('touchEnd');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => plays), 0, 'long hold does not play the song');
      assert.equal(await page.locator('#sheet .song-title').textContent(), 'Menu test song');

      const nativeMenu = await page.evaluate(() => {
        const image = document.querySelector('[data-recent="sheet-test-song"] img');
        const header = sheet.querySelector('[data-track-menu]');
        const invoke = el => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const first = invoke(image);
        sendSheetTouch('touchcancel', 0, 0, { target: image });
        const afterCancel = invoke(image);
        const onHeader = invoke(header.querySelector('img'));
        return { first, afterCancel, onHeader, sameHeader: sheet.querySelector('[data-track-menu]') === header,
          artworkIsControl: getComputedStyle(image).pointerEvents === 'none' };
      });
      for (const [key, value] of Object.entries(nativeMenu)) assert.equal(value, true, key);

      // Scrolling the collapsed action list must not move or reconstruct its sheet.
      const beforeScroll = await page.evaluate(() => sheetBox());
      const option = await page.locator('#sheet [data-act="playnext"]').boundingBox();
      await touch('touchStart', 180, option.y + option.height / 2);
      for (const dy of [20, 45, 80, 120]) {
        await touch('touchMove', 180, option.y + option.height / 2 - dy);
        await page.waitForTimeout(20);
      }
      await touch('touchEnd');
      await page.waitForTimeout(300);
      const afterScroll = await page.evaluate(() => sheetBox());
      assert.equal(afterScroll.expanded, false, 'browsing collapsed actions does not expand the sheet');
      assert(afterScroll.scroll > 20, 'collapsed actions scroll natively');
      assert(Math.abs(afterScroll.top - beforeScroll.top) < 1, 'scrolling leaves the sheet in place');
      await page.evaluate(() => { sheet.scrollTop = 0; });

      const collapsed = await page.evaluate(() => sheetBox());
      await page.evaluate(() => { sendSheetTouch('touchstart', 180, 400); sendSheetTouch('touchmove', 180, 280); });
      await page.waitForTimeout(40);
      const held = await page.evaluate(() => sheetBox());
      assert.equal(held.expanded, false, 'expansion waits for release');
      assert(Math.abs(held.height - (collapsed.height + 40)) < 1, 'upward drag reveals more menu without translating its bottom');
      assert(Math.abs(held.bottom - collapsed.bottom) < 1, 'upward drag never opens a gap beneath the menu');
      assert(Math.abs(held.top - (collapsed.top - 40)) < 1, 'upward drag retains its resistance');
      const snap = await page.evaluate(async () => {
        sendSheetTouch('touchend', 180, 280);
        const immediate = sheetBox();
        const frames = [immediate];
        const start = performance.now();
        while (performance.now() - start < 300) {
          await new Promise(requestAnimationFrame);
          frames.push(sheetBox());
        }
        return { immediate, frames, final: sheetBox() };
      });
      assert(Math.abs(snap.immediate.top - held.top) < 2, 'release does not jump before the first animation frame');
      assert.equal(snap.final.expanded, true);
      assert(snap.final.height > collapsed.height + 50, 'release expands the menu');
      for (let i = 1; i < snap.frames.length; i++) {
        assert(snap.frames[i].top <= snap.frames[i - 1].top + 1, 'expansion never reverses direction');
      }
      // The expanded menu must hand an upward swipe to the native scroller.
      const scrollRange = await page.evaluate(() => sheet.scrollHeight - sheet.clientHeight);
      await touch('touchStart', 180, 400);
      for (const y of [380, 350, 310, 270, 230]) { await touch('touchMove', 180, y); await page.waitForTimeout(20); }
      await touch('touchEnd');
      await page.waitForTimeout(300);
      assert(await page.evaluate(range => range <= 1 ? sheet.scrollTop === 0 : sheet.scrollTop >= Math.min(range, 30), scrollRange), 'expanded options scroll natively when they overflow');
      assert.equal(await page.evaluate(() => sheet.classList.contains('dragging')), false);

      await page.evaluate(() => sheet.classList.remove('expanded'));
      await page.waitForTimeout(300);
      const checks = await page.evaluate(() => {
        const out = {};
        // A scroll that starts below the top stays a scroll in either direction,
        // even if it reaches the top before the finger is released.
        sheet.classList.remove('expanded');
        sheet.scrollTop = 80;
        sendSheetTouch('touchstart', 180, 400);
        out.scrolledUp = sendSheetTouch('touchmove', 180, 300);
        sheet.scrollTop = 0;
        out.reachedTop = sendSheetTouch('touchmove', 180, 450);
        sendSheetTouch('touchend', 180, 450);
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 250, 410);
        out.horizontal = sheet.classList.contains('dragging');
        sendSheetTouch('touchend', 250, 410);
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 180, 300, { cancelable: false });
        out.nativeOwnedDragging = sheet.classList.contains('dragging');
        sendSheetTouch('touchend', 180, 300);
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 180, 370);
        sendSheetTouch('touchcancel', 180, 370);
        out.cancelledStyles = sheet.getAttribute('style');
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 180, 300);
        sendSheetTouch('touchstart', 180, 300, { count: 2 });
        out.multitouchDragging = sheet.classList.contains('dragging');
        sendSheetTouch('touchend', 180, 300);
        return out;
      });
      for (const key of ['scrolledUp', 'reachedTop', 'horizontal', 'nativeOwnedDragging', 'multitouchDragging']) assert.equal(checks[key], false, key);
      assert(!checks.cancelledStyles, 'cancellation clears temporary geometry');
      await page.waitForTimeout(300);

      // A move and release in the same frame must still produce a snap, and a
      // compatibility click after that drag must not trigger Play now.
      await page.evaluate(() => {
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 180, 300);
        sendSheetTouch('touchend', 180, 300);
        sheet.querySelector('[data-act="play"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      });
      assert.equal(await page.evaluate(() => plays), 0);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => sheet.classList.contains('expanded')), true);
      await page.evaluate(() => { sendSheetTouch('touchstart', 180, 200); sendSheetTouch('touchmove', 180, 340); sendSheetTouch('touchend', 180, 340); });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => sheet.classList.contains('expanded')), false, 'downward drag collapses first');
      assert.equal(await page.evaluate(() => sheet.hidden), false);
      await page.evaluate(() => { sendSheetTouch('touchstart', 180, 400); sendSheetTouch('touchmove', 180, 540); sendSheetTouch('touchend', 180, 540); });
      await page.waitForFunction(() => sheet.hidden);
      assert.equal(await page.locator('#scrim').isVisible(), false, 'second downward drag dismisses');

      // Pick the menu up while its entrance animation still owns transform.
      const entry = await page.evaluate(async () => {
        Views.openTrackMenu(track);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const before = sheetBox();
        sendSheetTouch('touchstart', 180, 650);
        sendSheetTouch('touchmove', 180, 620);
        await new Promise(requestAnimationFrame);
        const during = sheetBox();
        sendSheetTouch('touchend', 180, 620);
        return { before, during };
      });
      assert(Math.abs(entry.during.top - (entry.before.top - 10)) < 2, 'entry yields immediately to the finger without a jump');
      await page.waitForTimeout(300);
      const interrupted = await page.evaluate(async () => {
        sendSheetTouch('touchstart', 180, 400);
        sendSheetTouch('touchmove', 180, 300);
        sendSheetTouch('touchend', 180, 300);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const before = sheetBox();
        sendSheetTouch('touchstart', 180, 300);
        sendSheetTouch('touchmove', 180, 320);
        await new Promise(requestAnimationFrame);
        const during = sheetBox();
        sendSheetTouch('touchcancel', 180, 320);
        return { before, during };
      });
      assert(Math.abs(interrupted.during.height - interrupted.before.height) < 2, 'a new drag freezes the visible height during a snap');
      assert(Math.abs(interrupted.during.top - (interrupted.before.top + 20)) < 2, 'a new drag continues from the visible snap position');
      await page.waitForTimeout(300);
      await page.evaluate(() => { sheet.classList.remove('expanded'); sheet.scrollTop = 0; });
      await page.waitForTimeout(300);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { sendSheetTouch('touchstart', 180, 400); sendSheetTouch('touchmove', 180, 300); sendSheetTouch('touchend', 180, 300); });
      assert.equal(await page.evaluate(() => sheet.classList.contains('expanded')), true, 'reduced motion still expands');
      assert.equal(await page.evaluate(() => sheet.style.transform), '');
      // Keyboard activation is not a compatibility touch click.
      await page.locator('#sheet [data-act="play"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => sheet.hidden);
      assert.equal(await page.evaluate(() => plays), 1, 'keyboard menu actions remain usable');

      // Some Android browsers deliver contextmenu before our timer, others after it.
      // Either order opens exactly one menu and suppresses the release click.
      await page.evaluate(() => {
        const image = document.querySelector('[data-recent="sheet-test-song"] img');
        sendSheetTouch('touchstart', 80, 120, { target: image });
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        image.dispatchEvent(event);
        window.earlyContextPrevented = event.defaultPrevented;
        window.earlyMenuHeader = sheet.querySelector('[data-track-menu]');
      });
      await page.waitForTimeout(550);
      const earlyContext = await page.evaluate(() => {
        const image = document.querySelector('[data-recent="sheet-test-song"] img');
        sendSheetTouch('touchend', 80, 120, { target: image });
        image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        const input = document.createElement('input');
        document.getElementById('view').appendChild(input);
        const inputMenuAllowed = input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        input.remove();
        return { prevented: earlyContextPrevented, same: earlyMenuHeader === sheet.querySelector('[data-track-menu]'), inputMenuAllowed, plays };
      });
      assert.deepEqual(earlyContext, { prevented: true, same: true, inputMenuAllowed: true, plays: 1 });

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(() => SharedQueue.available());
      // Both entry points and both room states must use the common sheet gesture.
      for (const active of [false, true]) {
        sharedRoom = active ? { id: 'sheet-room', title: 'Shared sheet test', isController: false,
          permission: 'approval', guests: [], requests: [], joinRequests: [],
          expiresAt: Date.now() + 3600000, inviteUrl: origin + '/guest/#test' } : null;
        for (const entryPoint of ['create', 'queue']) {
          await page.evaluate(entry => entry === 'create' ? Views.openCreateSheet() : Views.openQueueSheet(), entryPoint);
          await page.locator(entryPoint === 'create' ? '[data-act="sharedqueue"]' : '#queue-shared').click();
          await page.locator(active ? '#sq-room-title' : '#sq-title').waitFor();
          await page.waitForTimeout(300);
          const heading = await page.locator('.sq-heading h2').boundingBox();
          const x = heading.x + heading.width / 2, y = heading.y + heading.height / 2;
          const before = await page.evaluate(() => sheetBox());
          await touch('touchStart', x, y);
          for (const dy of [10, 25, 50]) {
            await touch('touchMove', x, y + dy);
            await page.waitForTimeout(25);
          }
          const during = await page.evaluate(() => sheetBox());
          assert(during.dragging, entryPoint + ': sharing header follows native touch');
          assert(Math.abs(during.top - before.top - 50) < 2, 'sharing sheet tracks downward finger movement');
          await touch('touchCancel');
          await page.waitForTimeout(300);
          assert(Math.abs((await page.evaluate(() => sheetBox())).top - before.top) < 2, 'cancel restores sharing sheet');

          await page.evaluate(() => {
            const target = sheet.querySelector('.sq-heading h2');
            sendSheetTouch('touchstart', 180, 100, { target });
            sendSheetTouch('touchmove', 180, 240, { target });
            sendSheetTouch('touchend', 180, 240, { target });
          });
          await page.waitForTimeout(300);
          assert.equal(await page.evaluate(() => sheetBox().expanded), false, 'sharing sheet collapses');
          const collapsedShare = await page.evaluate(() => sheetBox());
          // Form and invitation content still scrolls rather than dragging the sheet.
          const body = await page.locator(active ? '.sq-invite h3' : '#sq-content > .sq-note').boundingBox();
          await touch('touchStart', 180, body.y + body.height / 2);
          for (const dy of [20, 45, 80]) {
            await touch('touchMove', 180, body.y + body.height / 2 - dy);
            await page.waitForTimeout(25);
          }
          await touch('touchEnd');
          await page.waitForTimeout(300);
          const scrolled = await page.evaluate(() => sheetBox());
          assert(scrolled.scroll > 10, 'sharing content scrolls natively');
          assert.equal(scrolled.expanded, false);
          assert(Math.abs(scrolled.top - collapsedShare.top) < 2, 'scrolling sharing content leaves the sheet in place');
          await page.evaluate(() => {
            sheet.scrollTop = 0;
            const target = sheet.querySelector('.sq-heading h2');
            sendSheetTouch('touchstart', 180, 400, { target });
            sendSheetTouch('touchmove', 180, 310, { target });
          });
          await page.waitForTimeout(40);
          const raised = await page.evaluate(() => sheetBox());
          assert(raised.dragging && raised.height > collapsedShare.height + 20, 'sharing header reveals content on upward drag');
          assert(Math.abs(raised.bottom - collapsedShare.bottom) < 2, 'sharing sheet stays anchored at the bottom');
          await page.evaluate(() => sendSheetTouch('touchend', 180, 310));
          await page.waitForTimeout(300);
          assert.equal(await page.evaluate(() => sheetBox().expanded), true, 'sharing sheet expands on release');
          for (let swipe = 0; swipe < 2; swipe++) {
            await page.evaluate(() => {
              // As with other sheets, return native scrolling to the top before grabbing.
              sheet.scrollTop = 0;
              const target = sheet.querySelector('.sq-heading');
              sendSheetTouch('touchstart', 180, 100, { target });
              sendSheetTouch('touchmove', 180, 240, { target });
              sendSheetTouch('touchend', 180, 240, { target });
            });
            await page.waitForTimeout(300);
          }
          await page.waitForFunction(() => sheet.hidden);
          assert.equal(await page.locator('#scrim').isVisible(), false);
        }
      }
      assert.deepEqual(errors, []);
      console.log(height + 'px: menu and sharing sheet touch tracking, native scrolling, continuous snap, cancellation, collapse and dismissal passed');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
