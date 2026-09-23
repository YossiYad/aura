// Run with Playwright available via NODE_PATH. Simulates visual viewport changes;
// real on-screen keyboard behavior still needs a phone check.
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
    for (const mode of ['visual-only', 'layout-and-visual']) {
      const page = await browser.newPage({ viewport: { width: 393, height: 793 }, hasTouch: true, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        window.viewportTest = Object.assign(new EventTarget(), { height: 793, width: 393, offsetTop: 0, scale: 1, inner: 793 });
        Object.defineProperty(window, 'visualViewport', { value: viewportTest });
        Object.defineProperty(window, 'innerHeight', { get: () => viewportTest.inner });
        window.captures = [];
        window.SpeechRecognition = class {
          constructor() { captures.push(this); }
          start() { this.onstart?.(); }
          stop() { this.stopped = true; }
          abort() { this.aborted = true; }
        };
      });
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Voice);
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-top', '59px');
        // A spoken request runs on the Ask screen itself: the words arrive in its own field.
        Views.showTab('ai');
        Views.startVoice('ask');
        captures[0].onresult({ results: [Object.assign([{ transcript: 'תשים לי ואיך בשמים' }], { isFinal: true })] });
        window.frameBeforeKeyboard = document.documentElement.style.getPropertyValue('--app-height');
      });
      assert.equal(await page.locator('#ask-voice').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#modal').isVisible(), false, 'no dialog opens for a spoken request');
      await page.locator('#ask-prompt').tap();
      assert.equal(await page.locator('#ask-prompt').evaluate(el => el.readOnly), false, 'the field holding the transcript can be typed into');
      assert.equal(await page.evaluate(() => !!captures[0].aborted), false, 'focus alone keeps the microphone open');
      await page.locator('#ask-prompt').press('End');
      await page.locator('#ask-prompt').press('Space');
      await page.locator('#ask-prompt').press('Backspace');
      assert.equal(await page.evaluate(() => captures[0].aborted), true, 'typing cancels speech and its submission timer');
      assert.equal(await page.locator('#ask-prompt').evaluate(el => el === document.activeElement), true, 'native tap focuses the editable field');
      assert.equal(await page.locator('#ask-prompt').inputValue(), 'תשים לי ואיך בשמים');
      await page.evaluate(mode => {
        Object.assign(viewportTest, { height: 350, inner: mode === 'visual-only' ? 793 : 350, offsetTop: mode === 'visual-only' ? 142 : 0 });
        // Panning on focus can displace the nav. It must not enlarge the app frame.
        document.getElementById('tabs').style.top = '-142px';
        document.getElementById('tabs').style.position = 'relative';
        viewportTest.dispatchEvent(new Event('resize'));
      }, mode);
      await page.waitForTimeout(100);
      const measure = () => page.evaluate(() => {
        const input = document.getElementById('ask-prompt');
        const box = input.getBoundingClientRect();
        const actions = document.getElementById('ask-go').getBoundingClientRect();
        return {
          keyboard: document.documentElement.classList.contains('keyboard-open'),
          inputTop: box.top, inputBottom: box.bottom,
          visibleTop: viewportTest.offsetTop,
          visibleBottom: Math.min(viewportTest.offsetTop + viewportTest.height, actions.top),
          actionsBottom: actions.bottom, viewportBottom: viewportTest.offsetTop + viewportTest.height,
          frame: document.documentElement.style.getPropertyValue('--app-height'), before: frameBeforeKeyboard
        };
      });
      const beforeTyping = await measure();
      assert.equal(beforeTyping.keyboard, true, mode + ': keyboard detected');
      assert.equal(beforeTyping.frame, beforeTyping.before, mode + ': no frame inflation');
      assert(beforeTyping.inputTop >= beforeTyping.visibleTop && beforeTyping.inputBottom <= beforeTyping.visibleBottom, mode + ': focused input visible ' + JSON.stringify(beforeTyping));
      assert(beforeTyping.actionsBottom <= beforeTyping.viewportBottom, mode + ': actions above keyboard');
      await page.locator('#ask-prompt').fill('תשים לי ואיך בשמים של אייל גולן');
      assert.equal(await page.locator('#ask-prompt').inputValue(), 'תשים לי ואיך בשמים של אייל גולן');
      await page.evaluate(() => { viewportTest.offsetTop += 25; viewportTest.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(100);
      const afterPan = await measure();
      assert(afterPan.inputTop >= afterPan.visibleTop && afterPan.inputBottom <= afterPan.visibleBottom, mode + ': input follows viewport pan');
      await page.evaluate(() => {
        document.getElementById('tabs').style.removeProperty('top');
        document.getElementById('tabs').style.removeProperty('position');
        Object.assign(viewportTest, { height: 793, inner: 793, offsetTop: 0 });
        viewportTest.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('keyboard-open')), false);
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height')), beforeTyping.before);
      // Pinch zoom is not a keyboard opening.
      await page.evaluate(() => { Object.assign(viewportTest, { height: 350, scale: 2 }); viewportTest.dispatchEvent(new Event('resize')); });
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('keyboard-open')), false);
      await page.evaluate(() => { Object.assign(viewportTest, { height: 793, scale: 1 }); viewportTest.dispatchEvent(new Event('resize')); });
      // Editing also wins if the silence timer has already called recognition.stop
      // but the recognizer is still delivering its final result.
      await page.locator('#ask-voice').tap({ force: true });
      assert.equal(await page.locator('#ask-prompt').evaluate(el => el === document.activeElement), false);
      await page.evaluate(() => {
        const capture = captures.at(-1);
        capture.onresult({ results: [Object.assign([{ transcript: 'בבקשה' }], { isFinal: true })] });
        window.lateResult = capture.onresult;
        window.lateEnd = capture.onend;
      });
      await page.waitForFunction(() => captures.at(-1).stopped);
      await page.locator('#ask-prompt').tap();
      assert.equal(await page.locator('#ask-go').isEnabled(), true);
      await page.locator('#ask-prompt').fill('תשים לי שיר אחר');
      assert.equal(await page.evaluate(() => captures.at(-1).aborted), true);
      await page.evaluate(() => {
        lateResult({ results: [Object.assign([{ transcript: 'late correction' }], { isFinal: true })] });
        lateEnd();
      });
      await page.waitForTimeout(1600);
      assert.equal(await page.locator('#ask-prompt').inputValue(), 'תשים לי שיר אחר');
      assert.equal(await page.evaluate(() => Views.voiceOpen()), true, 'typing cancels automatic submission: the request is still open, unsent');
      assert.deepEqual(errors, []);
      console.log(mode + ': visible input, typing, actions, panning, frame restoration and zoom passed');
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 393, height: 793 }, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' });
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await page.goto(origin);
    await page.waitForFunction(() => window.Views);
    const checks = await page.evaluate(() => {
      const view = document.getElementById('view');
      view.innerHTML = '<div class="rail" id="gesture-rail" style="width:100%;height:100px"><button id="edge-button" style="flex:0 0 1100px">Tap</button></div><div style="height:1600px"></div>';
      const rail = document.getElementById('gesture-rail'), button = document.getElementById('edge-button');
      let taps = 0;
      button.onclick = () => taps++;
      const send = (type, x, y = 200, count = 1) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: Array.from({ length: type === 'touchend' ? 0 : count }, () => ({ clientX: x, clientY: y })) });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const out = { overscroll: getComputedStyle(rail).overscrollBehaviorX };
      rail.scrollLeft = 0;
      send('touchstart', 160); out.leftBoundary = send('touchmove', 220); send('touchend', 220);
      rail.scrollLeft = 100;
      send('touchstart', 160); out.interior = send('touchmove', 200); send('touchend', 200);
      rail.scrollLeft = rail.scrollWidth;
      send('touchstart', 220); out.rightBoundary = send('touchmove', 160); send('touchend', 160);
      rail.style.direction = 'rtl'; rail.scrollLeft = 0;
      send('touchstart', 220); out.rtlBoundary = send('touchmove', 160); send('touchend', 160);
      send('touchstart', 160); out.rtlInterior = send('touchmove', 220); send('touchend', 220);
      rail.style.direction = 'ltr'; rail.scrollLeft = 0;
      out.edgeStart = send('touchstart', 390); send('touchmove', 300); send('touchend', 300);
      out.edgeScroll = rail.scrollLeft;
      out.tapsAfterDrag = taps;
      send('touchstart', 390); send('touchend', 390);
      out.tapsAfterTap = taps;
      view.scrollTop = 0;
      send('touchstart', 5, 300); send('touchmove', 5, 200); send('touchend', 5, 200);
      out.verticalEdgeScroll = view.scrollTop;
      send('touchstart', 160); out.verticalInterior = send('touchmove', 160, 280); send('touchend', 160, 280);
      out.multitouch = send('touchstart', 5, 200, 2);
      return out;
    });
    assert.equal(checks.overscroll, 'none');
    for (const key of ['leftBoundary', 'rightBoundary', 'rtlBoundary', 'edgeStart']) assert.equal(checks[key], true, key);
    for (const key of ['interior', 'rtlInterior', 'verticalInterior', 'multitouch']) assert.equal(checks[key], false, key);
    assert(checks.edgeScroll > 0, 'edge swipe scrolls the rail');
    assert(checks.verticalEdgeScroll > 0, 'edge vertical swipe scrolls the list');
    assert.equal(checks.tapsAfterDrag, 0);
    assert.equal(checks.tapsAfterTap, 1);
    console.log('swipe boundaries: LTR/RTL containment, edge scrolling/taps and vertical scrolling passed');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
