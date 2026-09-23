// Run with Playwright available via NODE_PATH and an installed Chromium browser.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { castSdk } = require('./cast-sdk-harness');
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
    for (const width of [320, 393, 1280]) for (const mode of ['native', 'sdk']) {
      const page = await browser.newPage({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('aura.settings', JSON.stringify({ autoplay: false, aiHomeSection: false }));
        localStorage.setItem('aura.queue', JSON.stringify({ extra: [{ id: 'one', title: 'Test song', artist: 'Artist', duration: 180 }], pos: 0 }));
        const remotes = new WeakMap();
        Object.defineProperty(HTMLMediaElement.prototype, 'remote', { get() {
          if (!remotes.has(this)) {
            const remote = new EventTarget();
            remote.state = 'disconnected';
            remote.prompt = () => {
              window.pickerCalls = (window.pickerCalls || 0) + 1;
              remote.state = 'connected';
              remote.dispatchEvent(new Event('connect'));
              return Promise.resolve();
            };
            remotes.set(this, remote);
          }
          return remotes.get(this);
        }});
      });
      if (mode === 'sdk') await page.addInitScript({ content:
        'window.testReceiver = (' + castSdk.toString() + ')(); window.cast = testReceiver.sdk.cast; window.chrome = Object.assign(window.chrome || {}, testReceiver.sdk.chrome);' });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Player);
      // Keep media requests pending: this check covers the controls and route events,
      // while receiver playback requires a physical device.
      await page.route(origin + '/test.mp3', () => {});
      await page.evaluate(origin => { Api.resolve = async () => ({ url: origin + '/test.mp3' }); }, origin);
      await page.locator('#pb-now').click();
      assert.equal(await page.locator('#fp-remote').count(), 0, 'connection is removed from the full player');
      await page.locator('#fp-more').click();
      const remoteButton = page.locator('[data-act="remote"]');
      await remoteButton.click();
      await page.waitForFunction(() => !document.querySelector('[data-act="remote"]').disabled);
      assert.equal(await page.evaluate(() => window.testReceiver ? !!testReceiver.context.getCurrentSession() : !!window.pickerCalls), false);
      await remoteButton.click();
      await page.waitForFunction(() => Player.remotePlaybackStatus().state === 'connected');
      assert.equal(await remoteButton.textContent(), mode === 'sdk' ? 'Disconnect from Living room' : 'AirPlay / output: TV');
      assert.equal(await page.evaluate(() => window.testReceiver ? !!testReceiver.context.getCurrentSession() : window.pickerCalls === 1), true);
      if (mode === 'sdk') {
        await page.waitForFunction(() => window.testReceiver.loads.length === 1);
        const metadata = await page.evaluate(() => window.testReceiver.loads[0].media.metadata);
        assert.equal(metadata.title, 'Test song');
        assert.ok(metadata.images.every(image => image.url.startsWith('https://')));
      }
      const fits = await page.locator('.fp-bottom').evaluate(el => Array.from(el.querySelectorAll('button')).every(button => {
        const box = button.getBoundingClientRect();
        return !box.width || (box.left >= 0 && box.right <= innerWidth);
      }));
      assert.equal(fits, true, 'TV controls fit at ' + width + 'px');
      if (mode === 'sdk') await remoteButton.click();
      else await page.evaluate(() => {
        const remote = document.getElementById('audio').remote;
        remote.state = 'disconnected';
        remote.dispatchEvent(new Event('disconnect'));
      });
      assert.equal(await page.evaluate(() => Player.remotePlaybackStatus().state), 'disconnected');
      assert.equal(await remoteButton.textContent(), 'Connect to TV');
      assert.deepEqual(errors, []);
      if (process.env.AURA_REMOTE_PREVIEW && width === 393 && mode === 'sdk') await page.screenshot({ path: process.env.AURA_REMOTE_PREVIEW });
      await page.close();
    }
    console.log('TV connection controls passed at 320px, 393px and 1280px');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
