const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// The top-level rules of a stylesheet as { prelude, body }, with comments gone.
function rules(css) {
  const out = [];
  let depth = 0, start = 0, prelude = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) { prelude = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) { out.push({ prelude, body: css.slice(start, i) }); start = i + 1; }
    }
  }
  return out;
}

// The desktop layout must not reach a phone. Its stylesheet is loaded by every device, so
// what keeps it away is that each rule in it needs the class only a desktop is given.
test('every rule of the desktop stylesheet is under html.desktop', () => {
  const css = read('src/desktop.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const check = list => {
    for (const rule of list) {
      if (/^@media\b/.test(rule.prelude)) { check(rules(rule.body)); continue; }
      if (/^@keyframes\b/.test(rule.prelude)) {
        // Names of its own, so it cannot replace an animation the phone uses.
        assert.match(rule.prelude, /^@keyframes dk-/, rule.prelude);
        continue;
      }
      assert.doesNotMatch(rule.prelude, /^@/, 'unexpected at-rule: ' + rule.prelude);
      for (const selector of rule.prelude.split(',')) {
        assert.match(selector.trim(), /^html\.desktop(?![\w-])/, 'reaches a phone: ' + selector.trim());
      }
    }
  };
  const top = rules(css);
  assert.ok(top.length > 50, 'the stylesheet was not read');
  check(top);
});

function load(matchMedia) {
  const created = [];
  const classes = new Set();
  const listeners = {};
  const document = {
    readyState: 'loading',
    documentElement: { classList: {
      add: name => classes.add(name),
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }
    } },
    createElement: tag => { created.push(tag); return {}; },
    querySelector: () => { throw new Error('the page was touched'); },
    getElementById: () => { throw new Error('the page was touched'); },
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  const views = {};
  const window = { Aura: { views }, addEventListener() {} };
  const context = { window, document, matchMedia, localStorage: { getItem: () => null, setItem() {} } };
  for (const file of ['src/views/desktop.js', 'src/views/desktop-library.js', 'src/views/desktop-player.js']) {
    vm.runInNewContext(read(file), context);
  }
  return { views, classes, created, listeners };
}

test('a phone builds nothing of the desktop layout and is never marked as one', () => {
  const asked = [];
  const phone = load(query => { asked.push(query); return { matches: false, addEventListener() {} }; });
  // Width and pointer together: a phone turned sideways is wide enough for neither.
  assert.equal(asked.length, 1);
  assert.match(asked[0], /min-width: 1024px/);
  assert.match(asked[0], /hover: hover/);
  assert.match(asked[0], /pointer: fine/);
  // The switch is thrown once the document is ready; on a phone it finds nothing to do.
  phone.listeners.DOMContentLoaded();
  phone.views.syncDesktop();
  assert.equal(phone.views.desktop, false);
  assert.deepEqual([...phone.classes], []);
  assert.deepEqual(phone.created, []);

  // A browser without media queries is treated the same way.
  const old = load(undefined);
  old.views.syncDesktop();
  assert.equal(old.views.desktop, false);
  assert.deepEqual([...old.classes], []);
  assert.deepEqual(old.created, []);
});

test('a wide window with a mouse is marked before the first paint', () => {
  const wide = load(() => ({ matches: true, addEventListener() {} }));
  assert.deepEqual([...wide.classes], ['desktop']);
  // The parts are built later, once every file has loaded; nothing yet.
  assert.deepEqual(wide.created, []);
});

test('the desktop files are loaded by the page and kept by the service worker', () => {
  const html = read('index.html');
  const sw = read('sw.js');
  for (const file of ['src/desktop.css', 'src/views/desktop.js', 'src/views/desktop-library.js', 'src/views/desktop-player.js']) {
    assert.ok(html.includes('"' + file + '"'), file + ' is not in index.html');
    assert.ok(sw.includes('"./' + file + '"'), file + ' is not in SHELL');
  }
  // The library column and the player bar register themselves with desktop.js as they load.
  assert.ok(html.indexOf('src/views/desktop.js') < html.indexOf('src/views/desktop-library.js'));
  assert.ok(html.indexOf('src/views/desktop.js') < html.indexOf('src/views/desktop-player.js'));
});
