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

// The three desktop files run against a page that records what was done to it. device
// says what the browser reports: its system, and the layout kept for it in Settings.
function load(matchMedia, device = {}) {
  const created = [];
  const classes = new Set();
  const listeners = {};
  const kept = new Map(device.layout ? [['aura.layout', device.layout]] : []);
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
  const context = { window, document, matchMedia, navigator: device.navigator,
    localStorage: { getItem: key => kept.has(key) ? kept.get(key) : null, setItem: (key, value) => kept.set(key, value), removeItem: key => kept.delete(key) } };
  for (const file of ['src/views/desktop.js', 'src/views/desktop-library.js', 'src/views/desktop-player.js']) {
    vm.runInNewContext(read(file), context);
  }
  return { views, classes, created, listeners, kept };
}

// A window that answers every media query the same way.
const all = matches => () => ({ matches, addEventListener() {} });
const LINUX = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', maxTouchPoints: 0 };
const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 };
const MAC = { userAgent: IPAD.userAgent, maxTouchPoints: 0 };
const GALAXY_TAB = { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', maxTouchPoints: 10 };
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };

test('a phone builds nothing of the desktop layout and is never marked as one', () => {
  const asked = [];
  const phone = load(query => { asked.push(query); return { matches: false, addEventListener() {} }; }, { navigator: IPHONE });
  // What a computer is asked for by itself: a mouse for a pointer, and the width.
  assert.match(asked[0], /min-width: 800px/);
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

test('a computer is marked before the first paint', () => {
  for (const navigator of [LINUX, MAC, undefined]) {
    const wide = load(all(true), { navigator });
    assert.deepEqual([...wide.classes], ['desktop']);
    // The parts are built later, once every file has loaded; nothing yet.
    assert.deepEqual(wide.created, []);
  }
});

// Size and pointer cannot tell a tablet from a laptop: an iPad or an Android tablet with a
// keyboard case is wide and has a trackpad. The system it runs is what tells them apart.
test('a tablet or a phone is not taken for a computer, however wide and whatever its pointer', () => {
  for (const navigator of [IPAD, GALAXY_TAB, IPHONE, Object.assign({ userAgentData: { mobile: true } }, LINUX)]) {
    const tablet = load(all(true), { navigator });
    tablet.listeners.DOMContentLoaded();
    assert.equal(tablet.views.desktop, false, navigator.userAgent);
    assert.deepEqual([...tablet.classes], []);
    assert.deepEqual(tablet.created, []);
  }
});

// The desktop app's window can report no mouse at all (a remote session, some Wayland
// setups), and it is a computer all the same.
test('the desktop app gets the computer layout wherever its window has room for it', () => {
  const APP = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Aura/0.1.0 Chrome/152.0.0.0 Electron/44.5.1 Safari/537.36 AuraDesktop/0.1.0', maxTouchPoints: 0 };
  const roomOnly = query => ({ matches: /^\(min-width: 700px\)$/.test(query), addEventListener() {} });
  assert.deepEqual([...load(roomOnly, { navigator: APP }).classes], ['desktop']);
  assert.deepEqual([...load(all(false), { navigator: APP }).classes], []);
  assert.deepEqual([...load(roomOnly, { navigator: APP, layout: 'phone' }).classes], []);
  // A browser with the same answers and no such name stays as it was, and so does some
  // other program built the same way.
  assert.deepEqual([...load(roomOnly, { navigator: LINUX }).classes], []);
  assert.deepEqual([...load(roomOnly, { navigator: { userAgent: APP.userAgent.replace(' AuraDesktop/0.1.0', ''), maxTouchPoints: 0 } }).classes], []);
  // The app's own main process is what gives it the name.
  assert.match(read('desktop/main.js'), /app\.userAgentFallback = app\.userAgentFallback \+ " AuraDesktop\/"/);
});

test('a computer is offered the installer for its own system, and nothing else is offered one', () => {
  const APP = { userAgent: LINUX.userAgent + ' Electron/44.5.1 AuraDesktop/0.1.0', maxTouchPoints: 0 };
  const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', maxTouchPoints: 0 };
  const EDGE = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', maxTouchPoints: 10 };
  const offered = navigator => load(all(true), { navigator }).views.desktopDownload();
  assert.equal(offered(LINUX).file, 'desktop/download/Aura.AppImage');
  assert.equal(offered(WINDOWS).file, 'desktop/download/Aura-Setup.exe');
  // A Windows laptop with a touch screen is a computer all the same.
  assert.equal(offered(EDGE).file, 'desktop/download/Aura-Setup.exe');
  assert.match(offered(WINDOWS).steps, /More info, then Run anyway/);
  for (const navigator of [APP, GALAXY_TAB, IPHONE, IPAD, MAC, undefined]) assert.equal(offered(navigator), null);
});

test('the layout chosen in Settings is kept for the device and decides over the detection', () => {
  // A tablet whose owner asked for the computer layout gets it wherever there is room.
  const tablet = load(query => ({ matches: /^\(min-width: 700px\)$/.test(query), addEventListener() {} }), { navigator: IPAD, layout: 'desktop' });
  assert.equal(tablet.views.desktopMode, 'desktop');
  assert.deepEqual([...tablet.classes], ['desktop']);
  // Without the room, as on a phone held upright, it stays the phone's.
  assert.deepEqual([...load(all(false), { navigator: IPHONE, layout: 'desktop' }).classes], []);
  // A computer whose owner asked for the phone layout keeps it.
  const computer = load(all(true), { navigator: LINUX, layout: 'phone' });
  assert.deepEqual([...computer.classes], []);
  computer.listeners.DOMContentLoaded();
  assert.equal(computer.views.desktop, false);
  assert.deepEqual(computer.created, []);

  // The choice is kept under a key of its own, outside the settings a backup carries.
  const phone = load(all(false), { navigator: IPHONE });
  assert.equal(phone.views.desktopMode, 'auto');
  phone.views.setDesktopMode('desktop');
  assert.equal(phone.kept.get('aura.layout'), 'desktop');
  assert.equal(phone.views.desktop, false);
  phone.views.setDesktopMode('auto');
  assert.equal(phone.kept.has('aura.layout'), false);
  assert.doesNotMatch(read('src/store.js') + read('src/store/backup.js'), /aura\.layout/);
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
