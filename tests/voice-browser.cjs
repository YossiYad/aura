// Run with Playwright via NODE_PATH. Recognition and microphone hardware are simulated.
//
// Drives the real app - the Ask screen, the voice module and the player - through the
// repeated-request scenarios, on the iPhone path and the Android path. The recognizer
// behaves as WebKit's does: start() is refused unless the object is inactive, a stopped
// or aborted run stays busy until its native end, and every event reaches whatever
// handler the object holds when the event arrives. On the iPhone path an <audio>
// element may only play once it has been played inside a tap, and keeps that permission
// afterwards, so a song the request resolves seconds later starts only if the tap that
// opened the request handed the element its permission.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

// Thirty seconds of silence, long enough to still be playing when the next request opens.
function silence(seconds) {
  const rate = 8000, samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  return wav;
}
const song = silence(30);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/test-song.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    return res.end(song);
  }
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + '/')) return res.writeHead(403).end();
  fs.readFile(file, (error, body) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});

const PLATFORMS = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  Android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
};

function simulateDevice(ios) {
  // The notes checked below are the Hebrew interface's; the app starts in English otherwise.
  localStorage.setItem('aura.settings', JSON.stringify({ interfaceLanguage: 'he' }));
  window.recognizers = [];
  window.microphones = [];
  // While set, stop() and abort() never deliver the native end: the run stays busy.
  window.hangEnds = false;
  const later = fn => setTimeout(fn, 5);
  if (ios) {
    navigator.mediaDevices.getUserMedia = async () => {
      const track = { readyState: 'live', muted: false, enabled: true, stop() { this.readyState = 'ended'; } };
      microphones.push(track);
      return { getTracks: () => [track] };
    };
    Object.defineProperty(navigator, 'audioSession', { configurable: true,
      value: { type: 'auto', state: 'inactive', addEventListener() {} } });
    // iOS playback permission: granted to an element by a play() inside a tap, kept after.
    let tapping = false;
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click']) {
      addEventListener(type, () => { tapping = true; setTimeout(() => { tapping = false; }, 0); }, true);
    }
    const permitted = new WeakSet(), play = HTMLMediaElement.prototype.play;
    window.refusedPlays = 0;
    window.primePlays = 0;
    HTMLMediaElement.prototype.play = function () {
      if (String(this.src).startsWith('data:audio/wav')) primePlays++;
      if (tapping) permitted.add(this);
      if (!permitted.has(this)) {
        refusedPlays++;
        return Promise.reject(new DOMException('Playback needs a tap first', 'NotAllowedError'));
      }
      return play.call(this);
    };
  }
  window.SpeechRecognition = class {
    constructor() { this.state = 'inactive'; recognizers.push(this); }
    start() {
      if (this.state !== 'inactive') throw new DOMException('Recognition is being started or already started', 'InvalidStateError');
      if (ios && !microphones.some(track => track.readyState === 'live')) throw new Error('No live microphone');
      this.state = 'running';
      later(() => { this.onstart?.(); later(() => this.onaudiostart?.()); });
    }
    stop() { if (this.state === 'running') { this.state = 'stopping'; this.nativeEnd(); } }
    abort() { if (this.state === 'running' || this.state === 'stopping') { this.state = 'aborting'; this.nativeEnd(); } }
    nativeEnd() {
      if (hangEnds) return;
      later(() => { this.onaudioend?.(); this.state = 'inactive'; this.onend?.(); });
    }
    // The listener's words, as this recognizer hears them.
    hear(words) { this.onresult?.({ results: [Object.assign([{ transcript: words }], { isFinal: true })] }); }
  };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.AURA_CHROMIUM ? { executablePath: process.env.AURA_CHROMIUM } : {}) });
  try {
    for (const [platform, userAgent] of Object.entries(PLATFORMS)) {
      const ios = platform === 'iPhone';
      const page = await browser.newPage({ viewport: { width: 393, height: 793 }, hasTouch: true, isMobile: true,
        serviceWorkers: 'block', locale: 'he-IL', userAgent });
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      await page.addInitScript(simulateDevice, ios);
      await page.goto(origin);
      await page.waitForFunction(() => window.Views && window.Voice && window.Player && window.Api);
      await page.evaluate(origin => {
        Views.showTab('ai');
        Store.patchSettings({ noYtFallback: true, voiceReply: false });
        window.requests = [];
        window.plans = [];
        Voice.reply = async () => false;
        Api.resolve = async () => ({ url: origin + '/test-song.wav' });
        // Stands in for understanding the request: each one follows the plan made for it.
        Voice.resolve = async text => {
          requests.push(text);
          const plan = plans.shift() || {};
          if (plan.delay) await new Promise(resolve => setTimeout(resolve, plan.delay));
          if (plan.error) throw new Error(plan.error);
          const id = plan.id || 'song-' + requests.length;
          return { tracks: [{ id, title: id, artist: 'Singer', duration: 30 }], label: id, action: 'play' };
        };
      }, origin);

      const state = () => page.evaluate(() => ({
        recognizers: recognizers.length, listening: Voice.isListening(), text: document.getElementById('ask-prompt').value,
        hearing: document.getElementById('ask-voice').classList.contains('listening'),
        liveMicrophones: microphones.filter(track => track.readyState === 'live').length,
        detached: recognizers.every((r, i) => i === recognizers.length - 1 && Voice.isListening() || r.onresult == null)
      }));

      // One spoken request: tap the orb, check it listens with a clear field on a new
      // recognizer, say the words, and let two seconds of silence send them.
      async function ask(words, plan = {}, { touchField = false } = {}) {
        const before = await state();
        const sent = await page.evaluate(() => requests.length);
        await page.evaluate(plan => plans.push(plan), plan);
        await page.locator('#ask-voice').tap();
        await page.waitForFunction(count => recognizers.length === count + 1 && Voice.isListening() &&
          document.getElementById('ask-voice').classList.contains('listening'), before.recognizers, { timeout: 5000 });
        const open = await state();
        assert.equal(open.text, '', words + ': the field is clear when listening starts');
        if (ios) assert.equal(open.liveMicrophones, 1, words + ': one live microphone, the earlier ones released');
        await page.evaluate(words => recognizers.at(-1).hear(words), words);
        assert.equal(await page.locator('#ask-prompt').inputValue(), words, words + ': the field shows this request');
        if (touchField) {
          await page.locator('#ask-prompt').tap();
          assert.equal(await page.evaluate(() => Voice.isListening()), true, 'touching the transcript keeps listening');
        }
        await page.waitForFunction(count => requests.length > count && !Voice.isListening(), sent, { timeout: 8000 });
        assert.equal(await page.evaluate(() => requests.at(-1)), words, words + ': the request sent is this one');
        const done = await state();
        assert.equal(done.liveMicrophones, 0, words + ': the microphone is released');
        assert.equal(done.detached, true, words + ': no recognizer keeps handlers after its request');
      }
      // The song the request resolved to starts on its own, without a Play tap.
      async function playing(id) {
        await page.waitForFunction(id => Player.current() && Player.current().id === id &&
          Array.from(document.querySelectorAll('audio')).some(a => a.src && !a.paused && a.currentTime > 0), id, { timeout: 8000 });
        assert.equal(await page.evaluate(() => Player.needsPlaybackGesture()), false, id + ' plays without a Play tap');
      }
      async function note(text) {
        await page.waitForFunction(text => document.getElementById('ask-note').textContent === text, text, { timeout: 8000 });
      }

      // 1. First request, then a second.
      await ask('play First', { id: 'first' }, { touchField: true });
      await playing('first');
      await ask('play Second', { id: 'second' });
      await playing('second');
      console.log(platform + ' 1: first request, then a second');

      // 2. Four in a row.
      for (const name of ['One', 'Two', 'Three', 'Four']) {
        await ask('play ' + name, { id: name.toLowerCase() });
        await playing(name.toLowerCase());
      }
      console.log(platform + ' 2: four consecutive requests');

      // 3. A follow-up question, answered by voice.
      await ask('play something', { error: 'איזה שיר, אמן או פלייליסט לנגן?' });
      await note('איזה שיר, אמן או פלייליסט לנגן?');
      assert.equal(await page.locator('#ask-prompt').inputValue(), 'play something', 'the asked request stays until the next one');
      await ask('play Answer by Singer', { id: 'answer' });
      await playing('answer');
      console.log(platform + ' 3: follow-up question answered by voice');

      // 4. Misunderstood, then the same words again.
      await ask('play Misheard', { error: 'לא מצאתי ביצוע מקורי מספיק ברור. הוסיפו את שם הזמר לבקשה.' });
      await note('לא מצאתי ביצוע מקורי מספיק ברור. הוסיפו את שם הזמר לבקשה.');
      await ask('play Misheard', { id: 'misheard' });
      await playing('misheard');
      console.log(platform + ' 4: misunderstood request repeated by voice');

      // 5. Different requests one after another.
      for (const [words, id] of [['play Rock', 'rock'], ['תשים שיר של אייל גולן', 'eyal'], ['play Jazz', 'jazz']]) {
        await ask(words, { id });
        await playing(id);
      }
      console.log(platform + ' 5: several different requests in a row');

      // 6. Start, cancel, start again - with a device whose recognizers never deliver their
      // end, so the cancelled run is still aborting when the next request starts, and every
      // later run completes on the stop fallback.
      await page.evaluate(() => { hangEnds = true; });
      const count = (await state()).recognizers;
      await page.locator('#ask-voice').tap();
      await page.waitForFunction(count => recognizers.length === count + 1 && Voice.isListening(), count, { timeout: 5000 });
      await page.locator('#ask-voice').tap();
      await note('ההאזנה נעצרה');
      assert.equal(await page.evaluate(() => Voice.isListening()), false, 'cancelled');
      assert.equal(await page.evaluate(() => recognizers.at(-1).state), 'aborting', 'the cancelled run has not ended');
      await ask('play After Cancel', { id: 'after-cancel' });
      await playing('after-cancel');
      console.log(platform + ' 6: start, cancel, start again');

      // 7. Wait for a slow answer, then ask again.
      await ask('play Slow', { id: 'slow', delay: 1500 });
      await page.waitForFunction(() => document.getElementById('ask-note').textContent === 'מחפש…');
      await playing('slow');
      await ask('play Next One', { id: 'next-one' });
      await playing('next-one');
      console.log(platform + ' 7: waited for the answer, then asked again');

      const logs = await page.evaluate(() => Log.dump().split('\n'));
      assert.equal(logs.some(line => /waiting for a Play tap/.test(line)), false, 'no song waited for a Play tap');
      if (ios) {
        assert.equal(await page.evaluate(() => refusedPlays), 0, 'iOS never refused a play');
        assert.equal(await page.evaluate(() => primePlays), 1, 'only the first request primed the element');
      }
      assert.equal(logs.some(line => /Misheard|Answer|Cancel/.test(line)), false, 'spoken words stay out of the log');
      console.log(platform + ': every request listened, showed its own words and started its song');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
