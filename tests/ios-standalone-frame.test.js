const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readModule } = require('./source');

// measuredViewport() lifted out of src/main.js and run against a described phone. The
// numbers were read on an installed iPhone page with a 393x852 screen on iOS 27.
function phone({ inner, screenHeight, safeTop, width = 393, ios = true, standalone = true }) {
  const source = readModule('main');
  const at = source.indexOf('  function measuredViewport()');
  assert(at > 0, 'measuredViewport');
  const classes = new Set(), props = new Map(), state = { safeTop, touched: 0 };
  const context = {
    window: { innerHeight: inner, innerWidth: width, visualViewport: { height: inner } },
    screen: { height: screenHeight, availHeight: screenHeight },
    document: { documentElement: {
      classList: { toggle(name, on) { state.touched++; if (on) classes.add(name); else classes.delete(name); } },
      style: { setProperty(key, value) { state.touched++; props.set(key, value); }, removeProperty(key) { state.touched++; props.delete(key); } }
    } },
    isStandalone: () => standalone,
    isIOS: () => ios,
    insetPx: name => { assert.equal(name, '--safe-top'); return state.safeTop; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(at, source.indexOf('\n  }', at) + 4), context);
  return { measure: () => context.measuredViewport(), classes, props, state };
}

test('the installed iPhone app asks for an opaque status bar and still covers the screen', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black" \/>/,
    'black-translucent strands a dead strip at the bottom on iOS 26 and 27');
  assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/);
});

test('under an opaque status bar the frame stays at the height iOS reports', () => {
  const h = phone({ inner: 793, screenHeight: 852, safeTop: 0 });
  assert.equal(h.measure(), 793, 'stretching to 852 would push the navigation off the screen');
  assert.equal(h.classes.has('ios-system-gap'), false);
  assert.equal(h.props.has('--ios-system-gap-size'), false);
});

test('a view stranded under the status bar still gets the full-height frame', () => {
  const h = phone({ inner: 793, screenHeight: 852, safeTop: 59 });
  assert.equal(h.measure(), 852);
  assert.equal(h.classes.has('ios-system-gap'), true);
  assert.equal(h.props.get('--ios-system-gap-size'), '59px');
});

test('the stranded-view correction waits for the insets that arrive after launch', () => {
  const h = phone({ inner: 793, screenHeight: 852, safeTop: 0 });
  assert.equal(h.measure(), 793);
  h.state.safeTop = 59;
  assert.equal(h.measure(), 852);
  assert.equal(h.classes.has('ios-system-gap'), true);
  h.state.safeTop = 0;
  assert.equal(h.measure(), 793);
  assert.equal(h.classes.has('ios-system-gap'), false);
  assert.equal(h.props.has('--ios-system-gap-size'), false);
});

test('a healthy full-height view under the status bar is left alone', () => {
  const h = phone({ inner: 852, screenHeight: 852, safeTop: 59 });
  assert.equal(h.measure(), 852);
  assert.equal(h.classes.has('ios-system-gap'), false);
});

test('a home-button iPhone keeps its small correction only under the status bar', () => {
  assert.equal(phone({ inner: 647, width: 375, screenHeight: 667, safeTop: 20 }).measure(), 667);
  assert.equal(phone({ inner: 647, width: 375, screenHeight: 667, safeTop: 0 }).measure(), 647);
});

test('Android and a browser tab never reach the iPhone corrections', () => {
  for (const device of [{ ios: false }, { standalone: false }]) {
    const h = phone({ inner: 793, screenHeight: 852, safeTop: 59, ...device });
    assert.equal(h.measure(), 793);
    assert.equal(h.state.touched, 0, 'no class or property may change off the installed iPhone app');
  }
});

test('the installed iPhone layout rules stay off the stranded-view state and off Android', () => {
  const css = fs.readFileSync(require.resolve('../src/app.css'), 'utf8');
  assert.match(css, /html\.ios-standalone \.app:not\(\.category-mode\):not\(\.hero-mode\) > \.topbar \{\s*height: calc\(74px \+ var\(--safe-top\)\);/);
  assert.match(css, /html\.ios-standalone:not\(\.ios-system-gap\) \.bottom-nav \{\s*padding-top: 14px;\s*padding-bottom: calc\(6px \+ var\(--nav-bottom-gap\)\);/);
  assert.match(css, /html\.ios-standalone:not\(\.ios-system-gap\) \.player \{\s*translate: 0 14px;/);
  // Lowering the labels while the view is stranded under the status bar would clip them.
  assert.doesNotMatch(css, /html\.ios-standalone \.(bottom-nav|player) \{/);
  assert.match(css, /html\.android \.bottom-nav \{\s*padding-top: 20px;\s*padding-bottom: var\(--nav-bottom-gap\);/);
  assert.match(css, /html\.android \.player \{\s*transform: translateY\(20px\);/);
});
