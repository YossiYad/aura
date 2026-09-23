const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule, moduleScope } = require('./source');

function harness(stalled, options = {}) {
  const source = readModule('views');
  const start = source.indexOf('  async function refreshAppVersion(');
  let now = 0, id = 0, release;
  const timers = new Map(), logs = [], calls = [], navigations = [], deleted = [];
  const run = (name, value) => {
    calls.push(name);
    if (options.reject === true || options.reject === name) return Promise.reject(new Error('Unavailable'));
    return name === stalled ? new Promise(resolve => { release = () => resolve(value); }) : Promise.resolve(value);
  };
  const reg = { update: () => run('update'), waiting: { postMessage: () => calls.push('activate') } };
  const caches = {
    keys: () => run('keys', ['aura-v113', 'aura-v116', 'aura-downloads', 'another-app']),
    delete: key => { deleted.push(key); return run('delete', true); }
  };
  const Log = { add: (tag, message) => logs.push(tag + ': ' + message) };
  const button = { disabled: false, innerHTML: '<span>Refresh app version</span>', querySelector: () => null };
  const context = {
    APP_VERSION: 'v116', URL, Date, Log, caches, toast() {},
    navigator: { serviceWorker: { getRegistration: () => run('registration', reg) } },
    window: { Log, caches, location: { href: 'https://app.test/music/index.html?artist=abc#section', replace: url => {
      if (options.navigationError) throw Error('Navigation blocked');
      navigations.push(url);
    } } },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout: key => timers.delete(key)
  };
  vm.createContext(moduleScope(context));
  vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), context);
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return {
    button, logs, calls, navigations, deleted, start: () => context.refreshAppVersion(button),
    release: () => release(),
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}

for (const stage of ['registration', 'update', 'keys', 'delete']) {
  test('refresh reloads and restores the button when ' + stage + ' never settles', async () => {
    const h = harness(stage);
    const done = h.start();
    assert.equal(h.button.disabled, true);
    await h.advance(10000);
    await done;
    assert.equal(h.navigations.length, 1);
    assert.equal(h.button.disabled, false);
    assert.match(h.button.innerHTML, /Refresh app version/);
    assert(h.logs.some(line => line.includes('timed out')));
    assert(h.logs.some(line => line.includes('reloading from network')));
    const calls = h.calls.slice();
    h.release();
    await h.advance(10000);
    assert.equal(h.navigations.length, 1, 'late completion must not reload twice');
    assert.deepEqual(h.calls, calls, 'late completion must not start more update work');
  });
}

test('successful refresh preserves downloads and the current route', async () => {
  const h = harness();
  h.start();
  await h.advance(350);
  assert.deepEqual(h.deleted, ['aura-v113', 'aura-v116']);
  const target = new URL(h.navigations[0]);
  assert.equal(target.pathname, '/music/index.html');
  assert.equal(target.searchParams.get('artist'), 'abc');
  assert.equal(target.hash, '#section');
  assert(target.searchParams.has('refresh'));
  assert(h.calls.includes('activate'));
  assert(h.logs[0].includes('requested from v116'));
});

test('a refresh that cannot reach the server keeps the installed app to reload into', async () => {
  for (const options of [{ reject: 'update' }, { stalled: 'update' }]) {
    const h = harness(options.stalled, options);
    h.start();
    await h.advance(10000);
    assert.deepEqual(h.deleted, []);
    assert(h.logs.some(line => line.includes('keeping the installed app')));
    assert.equal(h.navigations.length, 1);
  }
});

test('rejected browser APIs still allow navigation', async () => {
  const h = harness(null, { reject: true });
  h.start();
  await h.advance(10000);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.button.disabled, false);
  assert(h.logs.some(line => line.includes('Unavailable')));
});

test('a refused navigation is logged and releases the button', async () => {
  const h = harness(null, { navigationError: true });
  h.start();
  await h.advance(350);
  assert.equal(h.button.disabled, false);
  assert(h.logs.some(line => line.includes('reload failed: Navigation blocked')));
});

test('repeated clicks do not start overlapping refreshes', async () => {
  const h = harness('registration');
  h.start(); h.start();
  await h.advance(10000);
  assert.equal(h.calls.filter(name => name === 'registration').length, 1);
  assert.equal(h.navigations.length, 1);
});
