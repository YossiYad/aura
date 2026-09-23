const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readModule, moduleScope } = require('./source');

function harness({ playing = false, controlled = true, views = undefined } = {}) {
  const classes = new Set(), timers = new Map(), events = {}, navigations = [];
  let id = 0;
  const document = {
    documentElement: { classList: {
      add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x)
    } },
    addEventListener: (name, fn) => { events[name] = fn; }
  };
  const serviceWorker = {
    controller: controlled,
    addEventListener: (name, fn) => { events[name] = fn; },
    register: () => new Promise(() => {})
  };
  const location = { href: 'https://app.test/index.html?artist=abc', protocol: 'https:',
    replace: url => navigations.push(url) };
  const window = { location, addEventListener() {}, Views: views };
  class MessageChannel {
    constructor() { this.port1 = { close() {} }; this.port2 = { reply: data => this.port1.onmessage({ data }) }; }
  }
  const navigator = { serviceWorker };
  const clock = { now: 1e12 };
  const context = vm.createContext(moduleScope({ document, window, location, navigator, URL, Date: { now: () => clock.now }, Views: views, MessageChannel,
    Player: { current: () => playing, playbackRequested: () => playing, isPaused: () => !playing },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  }));
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const main = readModule('main');
  // The update code runs to the next section or the end of its file, whichever comes first.
  const start = main.indexOf('  function reloadWithFreshAppVersion()');
  const end = Math.min(...[main.indexOf('  // A long press on the home screen icon'), main.indexOf('\n})();', start)].filter(at => at > start));
  vm.runInContext(main.slice(start, end), context);
  return {
    events, navigations, navigator, clock, launch: window.AppLaunch,
    covered: () => classes.has('app-starting'),
    ready: () => events.DOMContentLoaded(),
    timeout: () => { for (const [id, t] of timers) { timers.delete(id); t.fn(); } },
    watch: options => context.watchForAppUpdates({ update: async () => {}, addEventListener() {}, ...options }, controlled),
    flush: async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  };
}

test('first paint stays covered until both the document and update check are ready', () => {
  const h = harness();
  h.launch.finish();
  assert.equal(h.covered(), true);
  h.ready();
  assert.equal(h.covered(), false);
});

test('a stalled update check releases the loaded app at the deadline', () => {
  const h = harness();
  h.ready();
  assert.equal(h.covered(), true);
  h.timeout();
  assert.equal(h.covered(), false);
});

test('an unchanged installation opens as soon as the check completes', async () => {
  const h = harness();
  h.ready(); h.watch(); await h.flush();
  assert.equal(h.covered(), false);
  assert.equal(h.navigations.length, 0);
});

test('an update during startup reloads under cover and preserves the route', () => {
  const h = harness();
  h.ready(); h.watch({ installing: {} }); h.events.controllerchange(); h.timeout();
  assert.equal(h.covered(), true);
  assert.equal(h.navigations.length, 1);
  assert.equal(new URL(h.navigations[0]).searchParams.get('artist'), 'abc');
  h.events.controllerchange();
  assert.equal(h.navigations.length, 1);
});

test('an update after the launch deadline does not replace the visible interface', () => {
  const h = harness();
  h.ready(); h.watch({ installing: {} }); h.timeout(); h.events.controllerchange();
  assert.equal(h.covered(), false);
  assert.equal(h.navigations.length, 0);
});

test('updates do not interrupt playback or reload on first installation', () => {
  for (const options of [{ playing: true }, { controlled: false }]) {
    const h = harness(options);
    h.ready(); h.watch({ installing: {} }); h.events.controllerchange();
    assert.equal(h.covered(), false);
    assert.equal(h.navigations.length, 0);
  }
});

test('an update waiting on playback is announced once, not on every return to the app', () => {
  const toasts = [];
  const h = harness({ playing: true, views: { toast: message => toasts.push(message) } });
  h.watch();
  h.events.controllerchange();
  assert.equal(toasts.length, 1);
  h.events.visibilitychange();
  h.events.visibilitychange();
  assert.equal(toasts.length, 1, 'switching back to the app is not a new update');
  assert.equal(h.navigations.length, 0);
});

test('a worker with no update is asked to compare its installed shell with the server', async () => {
  const asked = [];
  const controlled = { postMessage: (message, ports) => asked.push({ type: message.type, port: ports[0] }) };
  const h = harness({ controlled });
  h.ready(); h.watch(); await h.flush();
  assert.equal(h.covered(), false, 'the comparison must not hold the launch cover');
  assert.deepEqual(asked.map(a => a.type), ['SYNC_SHELL']);
  h.events.visibilitychange(); await h.flush();
  assert.equal(asked.length, 1, 'one comparison at a time');
  asked[0].port.reply({ changed: true });
  h.events.visibilitychange(); await h.flush();
  assert.equal(asked.length, 1, 'a finished comparison is not repeated on every return to the app');
  h.clock.now += 5 * 60 * 1000 + 1;
  h.events.visibilitychange(); await h.flush();
  assert.equal(asked.length, 2, 'and is made again once some time has passed');
  assert.equal(h.navigations.length, 0, 'the new files are for the next launch');
});

test('a failed comparison is tried again, and none is started offline or during an update', async () => {
  const asked = [];
  const controlled = { postMessage: (message, ports) => asked.push(ports[0]) };
  let h = harness({ controlled });
  h.watch(); await h.flush();
  asked[0].reply({ changed: false, failed: true });
  h.events.visibilitychange(); await h.flush();
  assert.equal(asked.length, 1, 'not again on the very next return');
  h.clock.now += 61000;
  h.events.visibilitychange(); await h.flush();
  assert.equal(asked.length, 2);
  for (const blocked of [{ offline: true }, { installing: {} }, { waiting: { postMessage() {} } }]) {
    asked.length = 0;
    h = harness({ controlled });
    if (blocked.offline) h.navigator.onLine = false;
    h.watch(blocked.offline ? {} : blocked); await h.flush();
    assert.equal(asked.length, 0);
  }
});
