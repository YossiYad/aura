const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { readModule } = require('./source');

const source = readModule('orbs');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// thinking-orbs publishes spec/orbs-golden.json: every dot and line its engine draws for
// each state and size at four instants, 70,115 numbers rounded to six places. These are
// digests of that file at 0.3.1 (commit de85557), taken from upstream's numbers and not
// from this build, so a slip in the vendored copy cannot certify itself. A frame entry is
// "dots lines digest"; the counts are there so a failure says what kind of wrong it is.
const GOLDEN_PRESETS = {
  'working-64': '976c1137cbe2b5b9',
  'working-20': '33b290b2f9a4db0b',
  'searching-64': '4cd05543681445f6',
  'searching-20': '7df4dcc018d3cb80',
  'solving-64': 'e8653ac7636fca78',
  'solving-20': '5c02aab0c5f13574',
  'listening-64': '1fab665d7b180430',
  'listening-20': 'c85cc27918d3b989',
  'connecting-64': '460ec2257dafe475',
  'connecting-20': 'ac5974899ed86107',
  'weaving-64': '60f8d0907d1f4059',
  'weaving-20': '6fa679a4a683452b',
  'composing-64': 'f8107eeb62f243c4',
  'composing-20': 'fd4435e8e6cd97ad',
  'breathing-64': '693d98649a0cfc57',
  'breathing-20': '41bf33abe1b5ac0a',
  'shaping-64': '30092f48b6df4e21',
  'shaping-20': '305519f0260e80fb'
};
const GOLDEN_FRAMES = {
  'working-64-0.6': '516 0 3edbc2ad02aea729',
  'working-64-1.7': '516 0 ae68d5f1ead0c232',
  'working-64-3.3': '516 0 5d624238989a0202',
  'working-64-5.1': '516 0 5439b08ed87eff52',
  'working-20-0.6': '39 0 92e830c6393d0580',
  'working-20-1.7': '39 0 5fb38dbbff0ebcaf',
  'working-20-3.3': '39 0 e8f5e2591127389d',
  'working-20-5.1': '39 0 0fa8d98bd2a5bc49',
  'searching-64-0.6': '204 0 84fecb87e572efdf',
  'searching-64-1.7': '204 0 e3f35462e6bf8e51',
  'searching-64-3.3': '204 0 ce1c38b9ad2dd078',
  'searching-64-5.1': '204 0 bcdf6340c550426a',
  'searching-20-0.6': '54 0 99c913325d1e1ff9',
  'searching-20-1.7': '54 0 00520bd594d94513',
  'searching-20-3.3': '54 0 7045a0f7cdf358ca',
  'searching-20-5.1': '54 0 77367ad153ef3f27',
  'solving-64-0.6': '138 0 a44354ab2f2ee768',
  'solving-64-1.7': '138 0 2ce7c46117731956',
  'solving-64-3.3': '138 0 90c3e700102464ad',
  'solving-64-5.1': '138 0 dd93a94d021b6842',
  'solving-20-0.6': '30 0 ebdc5b2deb9697f4',
  'solving-20-1.7': '30 0 8c4fda310fe8fb53',
  'solving-20-3.3': '30 0 0ac562b139c82f46',
  'solving-20-5.1': '30 0 70bc1255b794c44a',
  'listening-64-0.6': '134 0 c19f4653507e8e92',
  'listening-64-1.7': '134 0 dcf3e076aed62587',
  'listening-64-3.3': '134 0 25946fbb53d778cb',
  'listening-64-5.1': '134 0 12436e3442147693',
  'listening-20-0.6': '42 0 c0aba457861abf09',
  'listening-20-1.7': '42 0 3cf65e93e157bc76',
  'listening-20-3.3': '42 0 7f75568889efcc16',
  'listening-20-5.1': '42 0 d2f5912c7260d1bb',
  'connecting-64-0.6': '48 81 b45cc929c508cb93',
  'connecting-64-1.7': '48 86 2697002c8b269334',
  'connecting-64-3.3': '48 86 ebc0b06552e6c879',
  'connecting-64-5.1': '48 88 4e41a7a9e8a31bc9',
  'connecting-20-0.6': '9 0 3c2ee3cb13825cbe',
  'connecting-20-1.7': '9 0 683e5a60e3175ba5',
  'connecting-20-3.3': '9 0 c542f58f0c99ea5a',
  'connecting-20-5.1': '9 0 3518347f91801367',
  'weaving-64-0.6': '153 0 4f2161eb8fdb0601',
  'weaving-64-1.7': '153 0 f02c29555d7119fe',
  'weaving-64-3.3': '153 0 40e095b1fa6f43bb',
  'weaving-64-5.1': '153 0 88ba67a30d7fd77d',
  'weaving-20-0.6': '35 0 69e5df71a916b74a',
  'weaving-20-1.7': '35 0 a929c5241852ee73',
  'weaving-20-3.3': '35 0 b671c30ab1b48f8d',
  'weaving-20-5.1': '35 0 3d615658b6832713',
  'composing-64-0.6': '566 0 f1f938aada9d1117',
  'composing-64-1.7': '566 0 3c8fed8f88ac08d2',
  'composing-64-3.3': '566 0 0b596884e7854512',
  'composing-64-5.1': '566 0 c7b2398e8f2336f2',
  'composing-20-0.6': '208 0 64dcc56d47221538',
  'composing-20-1.7': '208 0 9e2bbbe42740ed96',
  'composing-20-3.3': '208 0 af62c4f3dd5e6ced',
  'composing-20-5.1': '208 0 f6a37d10bd6729df',
  'breathing-64-0.6': '484 0 1212d1bc8a481adf',
  'breathing-64-1.7': '484 0 fc96a73b4e0ba283',
  'breathing-64-3.3': '484 0 1f91e93239a710f3',
  'breathing-64-5.1': '484 0 0e6b53280d2ab9c1',
  'breathing-20-0.6': '120 0 5f10c177613268f4',
  'breathing-20-1.7': '120 0 0464b93c6b3f5ac9',
  'breathing-20-3.3': '120 0 8e1f9dcf76bd2482',
  'breathing-20-5.1': '120 0 32e97828e430e59f',
  'shaping-64-0.6': '24 0 9c1ff681c6207e3e',
  'shaping-64-1.7': '24 0 6e95fd7fd2419721',
  'shaping-64-3.3': '24 0 62ebd3fa97abfde1',
  'shaping-64-5.1': '24 0 0c011f559ea6c76a',
  'shaping-20-0.6': '18 0 00e47d02f3dec1b5',
  'shaping-20-1.7': '18 0 895af12d0b9429c4',
  'shaping-20-3.3': '18 0 3538c53083daf08a',
  'shaping-20-5.1': '18 0 31941cfff0a8ef31'
};

function engine() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.Orbs.engine;
}

test('the vendored engine resolves every preset exactly as upstream does', () => {
  const { resolvePreset } = engine();
  for (const [key, want] of Object.entries(GOLDEN_PRESETS)) {
    const [state, size] = key.split('-');
    const { mode, speed, opts } = resolvePreset(state, Number(size));
    assert.equal(digest({ mode, speed, opts }), want, key);
  }
});

test('every state at both sizes draws upstream\'s golden frames', () => {
  const { resolvePreset, MODE_FRAMES } = engine();
  const r6 = n => Number(n.toFixed(6));
  for (const [key, want] of Object.entries(GOLDEN_FRAMES)) {
    const [state, size, t] = key.split('-');
    const { mode, opts } = resolvePreset(state, Number(size));
    const frame = MODE_FRAMES[mode](Number(size), Number(t), opts);
    const dots = frame.dots.flatMap(d => [d.x, d.y, d.z, d.r, d.white, d.a ?? 1].map(r6));
    const lines = frame.lines.flatMap(l => [l.x1, l.y1, l.x2, l.y2, l.white, l.a ?? 1, l.w].map(r6));
    assert.equal(frame.dots.length + ' ' + frame.lines.length + ' ' + digest([dots, lines]), want, key);
  }
});

// The element, on a page made of just what it touches. Time and frames only move when a
// test moves them.
function page({ reducedMotion = false, noAnim = false } = {}) {
  let clock = 1000, frames = [], timers = [], top = null, classChanged = null;
  const classes = new Set(noAnim ? ['no-anim'] : []);
  const orbs = [];
  let Orb;
  class HTMLElement {
    constructor() { this.attrs = new Map(); this.children = []; this.style = {}; this.isConnected = false; this.id = ''; }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) {
      const was = this.getAttribute(name);
      this.attrs.set(name, String(value));
      if (Orb.observedAttributes.includes(name)) this.attributeChangedCallback(name, was, String(value));
    }
    appendChild(child) { this.children.push(child); return child; }
    contains(other) { return other === this || this.children.includes(other); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 64, height: 64 }; }
  }
  function canvas() {
    const draws = [];
    const ctx = {
      globalAlpha: 1,
      setTransform(a) { ctx.scale = a; },
      clearRect() { draws.push({ alphas: [], arcs: [] }); },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      arc(x, y, r) { draws[draws.length - 1].arcs.push([x, y, r]); },
      fill() { draws[draws.length - 1].alphas.push(ctx.globalAlpha); }
    };
    // A new canvas is 300 by 150, as in a browser.
    return { width: 300, height: 150, style: {}, draws, ctx, getContext: () => ctx };
  }
  const context = {
    HTMLElement,
    performance: { now: () => clock },
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame() { frames = []; },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout() { timers = []; },
    MutationObserver: class { constructor(fn) { classChanged = fn; } observe() {} },
    customElements: { get: () => undefined, define(name, klass) { assert.equal(name, 'thinking-orb'); Orb = klass; } },
    document: {
      hidden: false,
      documentElement: { classList: { contains: name => classes.has(name) } },
      createElement: () => canvas(),
      elementFromPoint: () => top,
      querySelectorAll: () => orbs.filter(orb => orb.isConnected),
      addEventListener() {}
    }
  };
  context.window = { devicePixelRatio: 3, customElements: context.customElements,
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }) };
  vm.runInNewContext(source, context);
  return {
    engine: context.window.Orbs.engine,
    // What upstream draws for reduced motion: the state at 0.6 seconds. Array.from, because
    // the engine's own arrays belong to the other realm and would never compare equal.
    still(state) {
      const { resolvePreset, MODE_FRAMES } = context.window.Orbs.engine;
      const { mode, opts } = resolvePreset(state, 64);
      return Array.from(MODE_FRAMES[mode](64, 0.6, opts).dots, d => [d.x, d.y, d.r]);
    },
    // The way the parser does it: attributes first, then the element joins the page.
    orb(attrs = {}) {
      const orb = new Orb();
      for (const [name, value] of Object.entries(attrs)) if (name === 'id') orb.id = value; else orb.setAttribute(name, value);
      orb.isConnected = true;
      orbs.push(orb);
      orb.connectedCallback();
      return orb;
    },
    remove(orb) { orb.isConnected = false; orb.disconnectedCallback(); },
    // What assigning innerHTML really does: the old element is already off the page when
    // its successor connects, and only hears about it afterwards.
    repaint(old, attrs) {
      old.isConnected = false;
      const next = this.orb(attrs);
      old.disconnectedCallback();
      return next;
    },
    draws: orb => orb._canvas.draws,
    advance(ms) { clock += ms; },
    // One animation frame: whatever was asked for so far runs once.
    frame() { const due = frames; frames = []; due.forEach(fn => fn(clock)); return due.length; },
    pending: () => frames.length,
    timers: () => timers,
    runTimers() { const due = timers; timers = []; due.forEach(timer => timer.fn()); },
    cover(element) { top = element; },
    setClass(name, on) { if (on) classes.add(name); else classes.delete(name); classChanged(); }
  };
}

test('an orb draws the moment it joins the page, sized for the screen, and names its state', () => {
  const p = page();
  const orb = p.orb({ state: 'searching' });
  assert.equal(p.draws(orb).length, 1, 'never blank while waiting for the first frame');
  assert.equal(orb._canvas.width, 128, 'device pixels are capped at two per CSS pixel');
  assert.equal(orb.style.width, '64px');
  assert.equal(orb.getAttribute('role'), 'img');
  assert.equal(orb.getAttribute('aria-label'), 'Searching…');
  orb.setAttribute('state', 'composing');
  assert.equal(orb.getAttribute('aria-label'), 'Composing…', 'its own label follows the state');
  assert.equal(p.pending(), 1, 'one shared loop is running');
});

test('an orb inside a labelled control stays out of the accessibility tree', () => {
  const p = page();
  const orb = p.orb({ state: 'listening', 'aria-hidden': 'true' });
  assert.equal(orb.getAttribute('role'), null);
  assert.equal(orb.getAttribute('aria-label'), null);
});

test('an unknown state or size falls back to the working orb at 64', () => {
  const p = page();
  const orb = p.orb({ state: 'constructor', size: '48' });
  const want = p.engine.resolvePreset('working', 64);
  assert.equal(orb._look.state, 'working');
  assert.equal(orb._look.opts, want.opts);
  assert.equal(orb._look.px, 64);
});

test('the small preset and a custom drawn size are separate choices', () => {
  const p = page();
  const small = p.orb({ state: 'working', size: '20' });
  assert.equal(small._look.px, 20);
  assert.equal(small._look.opts, p.engine.resolvePreset('working', 20).opts);
  const large = p.orb({ state: 'breathing', px: '96' });
  assert.equal(large._look.px, 96);
  assert.equal(large._canvas.width, 192);
  assert.equal(large._look.opts, p.engine.resolvePreset('breathing', 64).opts, 'still the tuned 64 design');
});

test('an orb that needs 300 device pixels across gets them down as well', () => {
  const p = page();
  const orb = p.orb({ state: 'breathing', px: '150' });
  assert.equal(orb._canvas.width, 300);
  assert.equal(orb._canvas.height, 300, 'a new canvas is already 300 wide, and only 150 tall');
});

for (const [name, options] of [['the Animations setting turned off', { noAnim: true }], ['reduced motion', { reducedMotion: true }]]) {
  test(name + ' holds upstream\'s still frame and never asks for an animation frame', () => {
    const p = page(options);
    const orb = p.orb({ state: 'solving' });
    assert.equal(p.pending(), 0);
    assert.deepEqual(p.draws(orb)[0].arcs, p.still('solving'));
    orb.setAttribute('state', 'searching');
    assert.equal(p.pending(), 0);
    assert.deepEqual(new Set(p.draws(orb).at(-1).alphas), new Set([1]), 'no fade either, just the other still frame');
  });
}

test('turning animations off while an orb is running stops it on the still frame', () => {
  const p = page();
  const orb = p.orb({ state: 'weaving' });
  assert.equal(p.pending(), 1);
  p.setClass('no-anim', true);
  p.frame();
  assert.equal(p.pending(), 0, 'the loop ends once nothing is moving');
  assert.deepEqual(p.draws(orb).at(-1).arcs, p.still('weaving'));
  p.setClass('no-anim', false);
  assert.equal(p.pending(), 1, 'and it picks up again when they come back');
});

test('a change of state fades from the old look into the new one', () => {
  const p = page();
  const orb = p.orb({ state: 'weaving' });
  orb.setAttribute('state', 'composing');
  assert.deepEqual(new Set(p.draws(orb).at(-1).alphas), new Set([1, 0]), 'starts as the old look entirely');
  p.advance(120);
  p.frame();
  assert.deepEqual(new Set(p.draws(orb).at(-1).alphas), new Set([0.5]), 'both looks, half each');
  p.advance(200);
  p.frame();
  assert.deepEqual(new Set(p.draws(orb).at(-1).alphas), new Set([1]), 'then only the new one');
  assert.equal(orb._from, null);
});

test('an orb repainted under the same id fades from the one it replaced', () => {
  const p = page();
  const first = p.orb({ id: 'ask-orb', state: 'breathing' });
  const repainted = p.repaint(first, { id: 'ask-orb', state: 'weaving' });
  assert.equal(repainted._from.state, 'breathing', 'innerHTML order: connected before the old one is told');
  const again = p.repaint(repainted, { id: 'ask-orb', state: 'weaving' });
  assert.equal(again._from, undefined, 'the same state again is not a change');
  p.remove(again);
  const second = p.orb({ id: 'ask-orb', state: 'composing' });
  assert.equal(second._from.state, 'weaving', 'removed first, then added: the other order');
  const bystander = p.orb({ id: 'other', state: 'weaving' });
  assert.equal(bystander._from, undefined, 'a different orb starts clean');
  p.remove(second);
  p.advance(500);
  const late = p.orb({ id: 'ask-orb', state: 'searching' });
  assert.equal(late._from, undefined, 'and so does one that arrives long after');
});

test('an orb lying under another layer stops drawing and looks again later', () => {
  const p = page();
  const orb = p.orb({ state: 'breathing' });
  p.advance(600);
  p.frame();
  const seen = p.draws(orb).length;
  p.cover({ contains: () => false });
  p.advance(600);
  p.frame();
  assert.equal(p.draws(orb).length, seen, 'covered: nothing drawn');
  assert.equal(p.pending(), 0, 'and no frame asked for');
  assert.equal(p.timers().length, 1, 'only a later look');
  p.cover(null);
  p.advance(600);
  p.runTimers();
  p.frame();
  assert.equal(p.draws(orb).length, seen + 1, 'uncovered: drawing again');
});

test('a button holding the orb does not count as covering it', () => {
  const p = page();
  const orb = p.orb({ state: 'breathing' });
  p.cover({ contains: other => other === orb });
  p.advance(600);
  p.frame();
  assert.equal(orb._covered, false);
  assert.equal(p.pending(), 1);
});

test('a paused orb shows a frame and stays off the loop', () => {
  const p = page();
  const orb = p.orb({ state: 'working', paused: '' });
  assert.equal(p.draws(orb).length, 1);
  assert.equal(p.pending(), 0);
});

test('the file carries the licence its engine came under', () => {
  assert.match(source, /Copyright \(c\) 2026 Jakub Antalik/);
  assert.match(source, /Permission is hereby granted, free of charge/);
  assert.match(source, /The above copyright notice and this permission notice shall be included/);
});
