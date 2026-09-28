const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule, moduleScope } = require('./source');

// The functions that keep every tap landing on the control painted under it, lifted out of
// src/main/ and run against a described page: a fixed frame that iOS may have scrolled, and
// the header and navigation controls a finger is judged against.
function functions(names, context) {
  const source = readModule('main');
  const code = names.map(name => {
    const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
    assert(match, name);
    return source.slice(match.index, source.indexOf('\n  }', match.index) + 4);
  }).join('\n');
  vm.createContext(moduleScope(context));
  vm.runInContext(code + '\nObject.assign(this, { ' + names.join(', ') + ' });', context);
  return context;
}

function page({ scrollY = 0, offsetTop = 0, pageTop = 0, scale = 1, frameTop = 0, editing = false } = {}) {
  const log = [], scrolls = [];
  const frame = { scrollTop: frameTop, scrollLeft: 0 };
  const doc = { scrollTop: 0, scrollLeft: 0 };
  const body = { scrollTop: 0, scrollLeft: 0 };
  const context = {
    window: { scrollX: 0, scrollY, visualViewport: { offsetLeft: 0, offsetTop, pageTop, scale }, scrollTo: (x, y) => scrolls.push([x, y]) },
    document: { activeElement: editing ? { matches: sel => sel.includes('input') } : { matches: () => false },
      querySelector: sel => sel === '.app' ? frame : null, scrollingElement: doc, documentElement: doc, body },
    Log: { add: (tag, msg) => log.push(tag + ' ' + msg) }, Math
  };
  context.window.Log = context.Log;
  return Object.assign(functions(['note', 'resetViewportDrift'], context), { log, scrolls, frame });
}

test('a frame iOS left scrolled is put back at zero and the log says what moved', () => {
  const p = page({ scrollY: 40, offsetTop: 12, pageTop: 52, frameTop: 9 });
  assert.equal(p.resetViewportDrift('keyboard gone'), true);
  assert.deepEqual(p.scrolls, [[0, 0]]);
  assert.equal(p.frame.scrollTop, 0);
  assert.equal(p.log.length, 1);
  assert.match(p.log[0], /^layout viewport drifted \(keyboard gone\): window 0,40; visual 0,12 page 52; frame 0,9 - reset/);
});

test('a page that has not moved is left alone, quietly', () => {
  const p = page();
  assert.equal(p.resetViewportDrift('touch'), false);
  assert.deepEqual(p.scrolls, []);
  assert.deepEqual(p.log, []);
});

test('while a field is being edited the keyboard owns the viewport', () => {
  const p = page({ scrollY: 300, offsetTop: 300, editing: true });
  assert.equal(p.resetViewportDrift('visual viewport scrolled'), false);
  assert.deepEqual(p.scrolls, []);
});

test('a pinch-zoomed page is reported rather than scrolled from under the finger', () => {
  const p = page({ offsetTop: 30, scale: 1.4 });
  assert.equal(p.resetViewportDrift('touch'), false);
  assert.deepEqual(p.scrolls, []);
  assert.match(p.log[0], /pinch-zoomed x1\.40 \(touch\), left alone/);
});

// A page with the five navigation tabs laid out at the bottom of a 393x793 installed
// iPhone screen - 70px boxes from y=705, the icon and label painted in the middle of each -
// and the three home filters at the top.
function controls() {
  const make = (name, left, top, width, height, key) => {
    const el = {
      dataset: { [key]: name }, tagName: 'BUTTON', id: '', classList: [], children: [],
      getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
      contains: other => other === el || el.children.includes(other),
      closest: sel => sel.includes('button') ? el : null
    };
    el.label = { tagName: 'SPAN', classList: [], closest: sel => sel.includes('button') ? el : null };
    el.children.push(el.label);
    return el;
  };
  const tabs = ['create', 'home', 'ai', 'library', 'search'].map((name, i) => make(name, i * 78.6, 705, 78.6, 70, 'tab'));
  const filters = ['all', 'music', 'podcasts'].map((name, i) => make(name, 300 - i * 70, 24, 60, 34, 'homeFilter'));
  return tabs.concat(filters);
}

function judge() {
  const log = [], all = controls();
  const plain = (tag, id) => ({ tagName: tag, id, classList: [], closest: () => null });
  const context = {
    tapControls: () => all,
    describeElement: el => el ? (el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '') : 'nothing',
    viewportSnapshot: () => 'inner 393x793',
    auditHitTargets: () => log.push('audit'),
    Log: { add: (tag, msg) => log.push(tag + ' ' + msg) }, Math,
    TAP_TARGETS: "button, a, [role='button'], #pb-now", CLICK_WAIT: 450
  };
  context.window = { Log: context.Log };
  const c = functions(['controlAt', 'nearestControl', 'judgeTap', 'rectOf'], context);
  vm.runInContext('const recentTaps = [];', context);
  return { c, log, all, plain, tap: (x, y, end) => ({ x, y, screenX: x, screenY: y + 59, at: 1000, end, under: end }) };
}

test('a tap on a control whose click reached it is not the report\'s business', () => {
  const j = judge();
  const library = j.all[3];
  assert.equal(j.c.judgeTap(j.tap(275, 740, library.label), library.label), false);
  assert.deepEqual(j.log, []);
});

test('a tap laid out on a control whose click never came is written down with the geometry', () => {
  const j = judge();
  const library = j.all[3];
  assert.equal(j.c.judgeTap(j.tap(275, 740, library.label), null), true);
  assert.equal(j.log.length, 2);
  assert.match(j.log[0], /^taps lost: touch 275,740 \(screen 275,799, dy 59\)/);
  assert.match(j.log[0], /laid out here: library 236,705 79x70; nearest library 236,705 79x70 \|/);
  assert.match(j.log[0], /click: none within 450ms \| inner 393x793/);
  assert.equal(j.log[1], 'audit');
});

test('a tap that landed under the painted control names the miss in pixels', () => {
  const j = judge();
  const nav = j.plain('NAV', 'tabs');
  // The label is painted 25px lower than it is laid out; the finger followed the paint.
  assert.equal(j.c.judgeTap(j.tap(275, 785, nav), nav), true);
  assert.match(j.log[0], /laid out here: no control; nearest library 236,705 79x70 off by 10px below \| click: nav#tabs/);
});

test('a tap that missed a filter upwards is measured against that filter', () => {
  const j = judge();
  const header = j.plain('HEADER', '');
  assert.equal(j.c.judgeTap(j.tap(250, 10, header), header), true);
  assert.match(j.log[0], /nearest music 230,24 60x34 off by 14px above/);
});

test('a tap on the mini player or on any button in the band is legitimate', () => {
  const j = judge();
  const now = { tagName: 'DIV', id: 'pb-now', classList: [], closest: sel => sel.includes('#pb-now') ? now : null };
  assert.equal(j.c.judgeTap(j.tap(120, 660, now), now), false);
  const play = { tagName: 'BUTTON', id: 'pb-play', classList: [], closest: sel => sel.includes('button') ? play : null };
  assert.equal(j.c.judgeTap(j.tap(340, 660, play), play), false);
  assert.deepEqual(j.log, []);
});

test('the drift check runs where iOS moves the page: each touch, the keyboard, and resuming', () => {
  const main = readModule('main');
  assert.match(main, /addEventListener\("touchstart"[\s\S]{0,400}V\.resetViewportDrift\("touch"\)/);
  assert.match(main, /addEventListener\("focusout"[\s\S]{0,120}resetViewportDrift\("field left"\), 60\)[\s\S]{0,80}resetViewportDrift\("keyboard gone"\), 450\)/);
  assert.match(main, /visualViewport\.addEventListener\("resize"[\s\S]{0,120}resetViewportDrift\("visual viewport resized"\)/);
  assert.match(main, /visualViewport\.addEventListener\("scroll"[\s\S]{0,120}resetViewportDrift\("visual viewport scrolled"\)/);
  assert.match(main, /addEventListener\("pageshow", \(\) => resume\("page shown"\)\)/);
  assert.match(main, /addEventListener\("visibilitychange", \(\) => resume\("app resumed"\)\)/);
  assert.match(main, /function resume\(reason\) \{\s*if \(document\.hidden\) return;\s*cachedInset = null;\s*resetViewportDrift\(reason\);\s*syncAppHeight\(\);/);
});
