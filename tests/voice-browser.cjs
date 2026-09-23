// Run with Playwright via NODE_PATH. Recognition and microphone hardware are simulated.
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
    // Exercise the real view and capture lifecycle across repeated iPhone requests.
    // Hardware permission and recognition events are simulated, not Safari itself.
    const voicePage = await browser.newPage({ viewport: { width: 393, height: 793 }, hasTouch: true,
      serviceWorkers: 'block', locale: 'he-IL', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' });
    await voicePage.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await voicePage.addInitScript(() => {
      localStorage.setItem('aura.settings', JSON.stringify({ interfaceLanguage: 'he' }));
      window.captures = [];
      window.captureStarts = 0;
      window.microphones = [];
      navigator.mediaDevices.getUserMedia = async () => {
        const track = { stopped: false, stop() { this.stopped = true; } };
        microphones.push(track);
        return { getTracks: () => [track] };
      };
      window.SpeechRecognition = class {
        constructor() { captures.push(this); }
        start() {
          if (!microphones.length || microphones.at(-1).stopped) throw new Error('No live microphone');
          captureStarts++;
          this.onstart?.(); this.onaudiostart?.();
        }
        stop() { queueMicrotask(() => this.onend?.()); }
        abort() { this.aborted = true; }
      };
    });
    await voicePage.goto(origin);
    await voicePage.waitForFunction(() => window.Views && window.Voice);
    await voicePage.evaluate(() => {
      Views.showTab('ai');
      window.requests = [];
      Voice.reply = async () => false;
      Voice.resolve = async text => {
        requests.push(text);
        if (requests.length < 3) throw new Error('נא לציין שם שיר ואמן');
        return { tracks: [{ id: 'song', title: 'Song' }], label: 'Song', action: 'play' };
      };
      Player.playQueue = () => true;
    });
    const spoken = ['play First', 'play Second by Singer', 'play Third'];
    for (const [index, text] of spoken.entries()) {
      await voicePage.locator('#ask-voice').tap();
      await voicePage.waitForFunction(count => captureStarts === count && Voice.isListening(), index + 1);
      assert.equal(await voicePage.evaluate(() => captures.length), 1, 'iPhone reuses one recognizer across requests');
      assert.equal(await voicePage.evaluate(() => captures[0].lang), 'he-IL');
      assert.equal(await voicePage.locator('#ask-prompt').inputValue(), '');
      await voicePage.evaluate(text => captures.at(-1).onresult({
        results: [Object.assign([{ transcript: text }], { isFinal: true })]
      }), text);
      await voicePage.locator('#ask-prompt').tap();
      assert.equal(await voicePage.evaluate(() => Voice.isListening()), true, 'touching the transcript keeps listening');
      await voicePage.waitForFunction(count => requests.length === count && !Voice.isListening(), index + 1);
      assert.equal(await voicePage.evaluate(() => microphones.every(track => track.stopped)), true);
    }
    assert.deepEqual(await voicePage.evaluate(() => requests), spoken);
    assert.equal(await voicePage.locator('#ask-prompt').inputValue(), '');
    console.log('Repeated iPhone capture lifecycle: three requests submitted on silence, without pressing Ask AI');
    await voicePage.close();

  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
