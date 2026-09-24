// Run with Playwright available via NODE_PATH. The collapsed bar is dragged up into the
// full player and the player is dragged back down; a tap and a sideways swipe keep their
// own meanings. Physical iOS feel still needs a phone check.
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
    const page = await browser.newPage({ viewport: { width: 393, height: 793 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => window.Views && window.Player);
    await page.evaluate(() => {
      const track = { id: 'bar-drag-song', title: 'Drag test song', artist: 'Test artist' };
      Player.current = () => track;
      window.dismissals = 0;
      Player.dismiss = () => dismissals++;
      document.getElementById('playerbar').hidden = false;
    });
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: /End|Cancel/.test(type) ? [] : [{ x, y }]
    });
    const drag = async (x0, y0, x1, y1, stepDelay) => {
      await touch('touchStart', x0, y0);
      for (let i = 1; i <= 10; i++) {
        await touch('touchMove', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10);
        await page.waitForTimeout(stepDelay);
      }
      await page.waitForTimeout(40);
      const during = await player();
      await touch('touchEnd');
      return during;
    };
    const player = () => page.evaluate(() => {
      const el = document.getElementById('fullplayer');
      return {
        hidden: el.hidden,
        top: Math.round(el.getBoundingClientRect().top),
        dragging: el.classList.contains('dragging'),
        animations: el.getAnimations().map(a => a.animationName).filter(Boolean)
      };
    });
    const settle = () => page.waitForTimeout(450);
    const bar = await page.locator('#pb-now').boundingBox();
    const x = bar.x + 60;
    const y = bar.y + bar.height / 2;

    // A short, slow pull shows the player under the finger and drops it back.
    let during = await drag(x, y, x, y - 60, 40);
    assert.equal(during.hidden, false);
    assert.equal(during.dragging, true);
    assert.ok(during.top > 600 && during.top < 793, 'player follows the finger: ' + during.top);
    await settle();
    assert.equal((await player()).hidden, true, 'short pull falls back');

    // A long pull opens it, and it does not replay the slide-in once it has settled.
    during = await drag(x, y, x, y - 400, 16);
    assert.ok(during.top > 300 && during.top < 500, 'player follows the finger: ' + during.top);
    await page.waitForTimeout(300);
    let state = await player();
    assert.equal(state.hidden, false);
    assert.deepEqual(state.animations, [], 'settled player does not slide in again');
    await settle();
    assert.equal((await player()).top, 0);

    // Dragged down a little it springs back without replaying the slide-in either.
    const art = await page.locator('#fullplayer .fp-art').boundingBox();
    const ay = art.y + 40;
    await drag(200, ay, 200, ay + 50, 40);
    await page.waitForTimeout(300);
    state = await player();
    assert.equal(state.hidden, false);
    assert.deepEqual(state.animations, []);
    await settle();
    assert.equal((await player()).top, 0);

    // Dragged down far enough it closes back to the bar.
    during = await drag(200, ay, 200, ay + 350, 16);
    assert.ok(during.top > 250, 'player follows the finger down: ' + during.top);
    await settle();
    assert.equal((await player()).hidden, true, 'long downward drag closes the player');

    // Dragging the bar down does nothing.
    await drag(x, y, x, y + 40, 16);
    await settle();
    assert.equal((await player()).hidden, true);

    // A tap still opens it with the slide-in, and the close button still closes it.
    await page.locator('#pb-now').tap();
    await page.waitForTimeout(60);
    state = await player();
    assert.equal(state.hidden, false);
    assert.deepEqual(state.animations, ['fp-in']);
    await settle();
    await page.locator('#fp-close').tap();
    await settle();
    assert.equal((await player()).hidden, true);

    // A sideways swipe still throws the bar away.
    await drag(x, y, x + 250, y + 4, 16);
    await settle();
    assert.equal(await page.evaluate(() => dismissals), 1);
    assert.equal((await player()).hidden, true);

    assert.deepEqual(errors, []);
    console.log('player bar drag up, full player drag down, tap and sideways swipe passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
