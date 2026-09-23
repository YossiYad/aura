const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readModule } = require('./source');

// src/progress.js run against just enough of a page to draw on: a 306x20 timeline whose
// left edge sits 40px into the screen, so a touch has to be measured and not assumed.
function timeline(options, size = { width: 306, height: 20, left: 40 }, page) {
  const el = () => {
    const attrs = new Map(), children = [], listeners = {}, classes = new Set();
    return {
      attrs, children, listeners, classes,
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      appendChild(child) { children.push(child); },
      prepend(child) { children.unshift(child); },
      addEventListener(type, fn) { listeners[type] = fn; },
      setPointerCapture() {},
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }
      },
      getBoundingClientRect: () => ({ left: size.left, top: 0, width: size.width, height: size.height })
    };
  };
  const clock = page ? page.clock : { now: 1e6 };
  const window = page ? page.window : { addEventListener() {} };
  if (!page) {
    const context = vm.createContext({ window, document: { createElementNS: () => el() }, Date: { now: () => clock.now }, Math, Number, String });
    vm.runInContext(readModule('progress'), context);
  }
  const root = el(), seeks = [], previews = [];
  const progress = window.SongProgress.create(root, options === null ? undefined : {
    onSeek: pct => seeks.push(pct), onPreview: pct => previews.push(pct), ...options
  });
  const [track, wave, , thumb] = root.children[0].children;
  const pointer = (type, x, pointerType = 'touch') => root.listeners[type]({ clientX: x, pointerId: 1, pointerType, button: 0 });
  const key = (name, extra = {}) => {
    const event = { key: name, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    root.listeners.keydown(event);
    return event;
  };
  // Where the released wave ends, as the share of the track it covers.
  const drawn = () => (Number(track.attrs.get('x1')) - 3) / 300 * 100;
  return { window, root, progress, seeks, previews, track, wave, thumb, pointer, key, drawn, clock };
}
// A second timeline on the same page, sharing the one loaded module.
timeline.again = h => timeline(undefined, undefined, h);

test('the played wave ends exactly at the position and keeps whole half waves before it', () => {
  const { window } = timeline();
  const { wave } = window.SongProgress;
  assert.deepEqual({ ...wave(3, 3, 10, 20, 4) }, { d: '', x: 3, y: 10 }, 'nothing played draws nothing');
  const whole = wave(3, 43, 10, 20, 4);
  assert.equal(whole.d, 'M3 10 Q13 2 23 10 Q33 18 43 10', 'one crest up, one trough down, 4px each side');
  const cut = wave(3, 33, 10, 20, 4);
  assert.equal(cut.x, 33);
  assert.equal(cut.y, 14, 'half way along the second half wave is its deepest point');
  assert.equal(cut.d, 'M3 10 Q13 2 23 10 Q28 14 33 14', 'the last curve is split, not clipped');
});

test('a position is drawn in pixels of the measured timeline', () => {
  const h = timeline();
  h.progress.set(50);
  assert.equal(h.track.attrs.get('x1'), '153', 'half of the 300px between the 3px insets');
  assert.equal(h.track.attrs.get('x2'), '303');
  assert.equal(h.thumb.attrs.get('cx'), '153');
  assert.equal(h.root.attrs.get('aria-valuenow'), '50');
  assert.match(h.wave.attrs.get('d'), /^M3 10 Q13 2 23 10 /);
});

test('a drag previews under the finger and seeks once, where it is released', () => {
  const h = timeline();
  h.progress.set(10);
  h.pointer('pointerdown', 40 + 3 + 60);
  h.pointer('pointermove', 40 + 3 + 150);
  assert.equal(h.progress.scrubbing(), true);
  assert.equal(h.root.classes.has('scrubbing'), true);
  assert.deepEqual(h.previews, [20, 50]);
  assert.deepEqual(h.seeks, [], 'nothing is sought while the finger is still down');
  h.progress.set(11);
  assert.equal(h.drawn(), 50, 'the running clock does not pull the wave from under the finger');
  h.pointer('pointerup', 40 + 3 + 225);
  assert.deepEqual(h.seeks, [75]);
  assert.equal(h.progress.scrubbing(), false);
  assert.equal(h.root.classes.has('scrubbing'), false);
});

test('a drag past either end stays on the track', () => {
  const h = timeline();
  h.pointer('pointerdown', 0);
  h.pointer('pointerup', 0);
  h.pointer('pointerdown', 5000);
  h.pointer('pointerup', 5000);
  assert.deepEqual(h.seeks, [0, 100]);
});

test('a touch the system takes back seeks nowhere and puts the wave back', () => {
  const h = timeline();
  h.progress.set(30);
  h.pointer('pointerdown', 40 + 3 + 240);
  assert.equal(h.drawn(), 80);
  h.root.listeners.pointercancel({});
  assert.deepEqual(h.seeks, []);
  assert.equal(h.drawn(), 30);
  assert.equal(h.previews[h.previews.length - 1], null, 'the owner is told the preview is over');
  assert.equal(h.progress.scrubbing(), false);
});

test('the mini bar ignores a finger and still answers a mouse', () => {
  const h = timeline({ touch: false });
  assert.equal(h.root.classes.has('touch'), false);
  h.pointer('pointerdown', 40 + 3 + 150);
  h.pointer('pointerup', 40 + 3 + 150);
  assert.deepEqual(h.seeks, []);
  h.pointer('pointerdown', 40 + 3 + 150, 'mouse');
  h.pointer('pointerup', 40 + 3 + 150, 'mouse');
  assert.deepEqual(h.seeks, [50]);
});

test('a released seek holds until the clock catches up with it', () => {
  const h = timeline();
  h.progress.set(10);
  h.pointer('pointerdown', 40 + 3 + 240);
  h.pointer('pointerup', 40 + 3 + 240);
  h.progress.set(10.1);
  assert.equal(h.drawn(), 80, 'a backend still reporting the old position does not snap the wave back');
  h.progress.set(80.4);
  assert.equal(Math.round(h.drawn() * 10) / 10, 80.4, 'the clock agrees, so it leads again');
  h.pointer('pointerdown', 40 + 3 + 30);
  h.pointer('pointerup', 40 + 3 + 30);
  h.clock.now += 801;
  h.progress.set(80.5);
  assert.equal(Math.round(h.drawn() * 10) / 10, 80.5, 'a seek that never took is not shown for ever');
});

test('arrow keys step, Home and End jump, and Shift is left to next and previous', () => {
  const h = timeline({ keyStep: () => 2.5 });
  h.progress.set(40);
  assert.equal(h.key('ArrowRight').prevented, true);
  h.key('ArrowRight');
  assert.deepEqual(h.seeks, [42.5, 45], 'a second press builds on the first, not on a clock that has not moved yet');
  h.key('ArrowLeft');
  h.key('Home');
  h.key('End');
  assert.deepEqual(h.seeks, [42.5, 45, 42.5, 0, 100]);
  assert.equal(h.key('ArrowRight', { shiftKey: true }).prevented, false);
  assert.equal(h.key('a').prevented, false);
  assert.equal(h.seeks.length, 5);
});

test('the straight style is the same timeline with its waves pressed flat', () => {
  const h = timeline();
  const second = timeline.again(h);
  h.progress.set(50);
  h.window.SongProgress.setStyle('line');
  assert.equal(h.wave.attrs.get('d'), 'M3 10 L153 10');
  assert.equal(h.thumb.attrs.get('cy'), '10');
  assert.equal(h.root.classes.has('line'), true);
  assert.equal(second.root.classes.has('line'), true, 'every timeline on the page follows the one choice');
  assert.equal(timeline.again(h).root.classes.has('line'), true, 'and so does one made afterwards');
  h.pointer('pointerdown', 40 + 3 + 75);
  h.pointer('pointerup', 40 + 3 + 75);
  assert.deepEqual(h.seeks, [25], 'it is touched the same way');
  h.window.SongProgress.setStyle('anything else');
  assert.match(h.wave.attrs.get('d'), /^M3 10 Q13 2 23 10 /, 'an unknown style is the wave');
  assert.equal(h.root.classes.has('line'), false);
});

test('a timeline without a seek handler only draws', () => {
  const h = timeline(null);
  assert.equal(h.root.classes.has('seekable'), false);
  assert.equal(h.root.listeners.pointerdown, undefined);
  h.progress.set(25);
  assert.equal(h.drawn(), 25);
  assert.equal(h.root.attrs.has('aria-valuenow'), false, 'the TV keeps its own range input for that');
});

test('the app shell carries the timeline, so an installed app never starts without it', () => {
  const sw = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  for (const file of ['src/progress.js', 'src/progress.css']) {
    assert.ok(html.includes('"' + file + '"'), file + ' is loaded by index.html');
    assert.ok(sw.includes('"./' + file + '"'), file + ' is in the service worker shell');
  }
  assert.ok(html.indexOf('src/progress.js') < html.indexOf('src/main.js'), 'main.js creates the timelines as it loads');
});
