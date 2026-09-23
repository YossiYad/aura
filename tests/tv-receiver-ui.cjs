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
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        const callbacks = {};
        const data = { state: 'PLAYING', time: 94, duration: 173, at: 0,
          items: [
            { itemId: 1, media: { metadata: { title: 'Great Expectation', artist: 'SIENNA SPIRO', albumName: 'Aura · Your music', images: [] } } },
            { itemId: 2, media: { metadata: { title: 'השיר הבא', artist: 'אמן', images: [] } } }
          ] };
        const emit = () => (callbacks.status || []).forEach(fn => fn({}));
        const manager = {
          getMediaInformation: () => data.state === 'IDLE' ? null : data.items[data.at].media,
          getPlayerState: () => data.state,
          getCurrentTimeSec: () => data.time,
          getDurationSec: () => data.duration,
          getQueueManager: () => ({ getItems: () => data.items, getCurrentItemIndex: () => data.at }),
          addEventListener: (event, fn) => { (callbacks[event] ||= []).push(fn); },
          pause: () => { data.state = 'PAUSED'; emit(); },
          play: () => { data.state = 'PLAYING'; emit(); },
          seek: value => { data.time = value; emit(); },
          sendLocalMediaRequest: request => { data.at += request.jump; data.time = 0; emit(); }
        };
        window.receiverTest = { data, emit, error: () => callbacks.error.forEach(fn => fn({})) };
        window.cast = { framework: {
          CastReceiverContext: { getInstance: () => ({ getPlayerManager: () => manager, start: () => {} }) },
          events: { EventType: { MEDIA_STATUS: 'status', TIME_UPDATE: 'time', LOADED_METADATA: 'metadata', ERROR: 'error' } },
          messages: { QueueUpdateRequestData: class {}, Command: { PAUSE: 1, SEEK: 2, STREAM_VOLUME: 4, STREAM_MUTE: 8, QUEUE_NEXT: 16, QUEUE_PREV: 32 } }
        } };
      });
      await page.goto(origin + '/tv/index.html');
      await page.waitForFunction(() => document.getElementById('art').naturalWidth > 0 && document.querySelector('.brand img').naturalWidth > 0);
      assert.equal(await page.locator('#title').textContent(), 'Great Expectation');
      assert.equal(await page.locator('#elapsed').textContent(), '1:34');
      assert.equal(await page.locator('#remaining').textContent(), '−1:19');
      assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Pause');
      assert.equal(await page.locator('#previous').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
      if (width === 1920) await page.screenshot({ path: process.env.AURA_TV_PREVIEW || '/tmp/aura-tv-preview.png' });
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'play');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#status').textContent(), 'Paused');
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'seek');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'next', 'the remote can leave the seek slider');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-toggle');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#queue-panel').isHidden(), false);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-toggle');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'theme');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#theme').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Enter');
      await page.locator('#play').click();
      assert.equal(await page.locator('#status').textContent(), 'Paused');
      await page.locator('#play').click();
      await page.locator('#seek').fill('500');
      await page.locator('#seek').dispatchEvent('change');
      assert.equal(await page.evaluate(() => receiverTest.data.time), 86.5);
      await page.locator('#next').click();
      assert.equal(await page.locator('#title').textContent(), 'השיר הבא');
      assert.equal(await page.locator('#next').isDisabled(), true);
      await page.locator('#previous').click();
      await page.locator('#queue-toggle').click();
      assert.equal(await page.locator('#queue li').count(), 2);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#queue-panel').isHidden(), true);
      await page.locator('#theme').click();
      assert.equal(await page.locator('#theme').getAttribute('aria-pressed'), 'true');
      await page.evaluate(() => { receiverTest.data.items[0].media.metadata.title = '<img src=x onerror=alert(1)>'; receiverTest.emit(); });
      assert.equal(await page.locator('#title img').count(), 0);
      await page.evaluate(() => receiverTest.error());
      assert.match(await page.locator('#status').textContent(), /could not play/);
      await page.evaluate(() => { receiverTest.data.state = 'IDLE'; receiverTest.emit(); });
      assert.equal(await page.locator('#play').isDisabled(), true);
      assert.equal(await page.locator('#title').textContent(), 'Your music. A bigger stage.');
      assert.deepEqual(errors, []);
      await page.close();
    }
    // An ordinary browser or an unavailable SDK must leave a usable waiting screen.
    const page = await browser.newPage();
    await page.route('https://www.gstatic.com/**', route => route.abort());
    await page.goto(origin + '/tv/index.html');
    assert.equal(await page.locator('#play').isDisabled(), true);
    assert.match(await page.locator('#status').textContent(), /Cast-enabled TV/);
    console.log('TV receiver layout, metadata, queue and controls passed at 720p, 1080p and 4K');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
