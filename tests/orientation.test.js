const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createStore } = require('./store-harness');
const { readModule } = require('./source');
const source = readModule('orientation');

function harness(settings = {}, lock = () => Promise.resolve()) {
  const store = createStore({ 'aura.settings': settings });
  const calls = [], events = {}, label = {};
  const document = { hidden: false, getElementById: () => label,
    addEventListener: (name, fn) => { events[name] = fn; } };
  const window = { screen: { orientation: lock ? { lock(value) { calls.push(value); return lock(value); } } : {} },
    addEventListener: (name, fn) => { events[name] = fn; } };
  vm.runInNewContext(source, { window, document, Store: store.Store });
  return { ...store, window, document, calls, events, label,
    flush: async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); } };
}

test('new and existing installations default to portrait, and opt-out survives reload', async () => {
  for (const settings of [{}, { animations: false }]) {
    const h = harness(settings);
    await h.flush();
    assert.equal(h.Store.settings().portraitLock, true);
    assert.deepEqual(h.calls, ['portrait']);
    h.Store.patchSettings({ portraitLock: false });
    await h.flush();
    assert.deepEqual(h.calls, ['portrait', 'any']);
    const reloaded = harness(h.read('aura.settings'));
    await reloaded.flush();
    assert.deepEqual(reloaded.calls, ['any']);
    assert.match(reloaded.label.textContent, /Rotation is allowed/);
    reloaded.Store.patchSettings({ portraitLock: true });
    await reloaded.flush();
    assert.deepEqual(reloaded.calls, ['any', 'portrait']);
  }
});

test('resume and fullscreen transitions restore the saved preference without reacting to unrelated changes', async () => {
  const h = harness({ portraitLock: false });
  await h.flush();
  h.Store.patchSettings({ animations: false });
  assert.deepEqual(h.calls, ['any']);
  h.document.hidden = true;
  h.events.visibilitychange();
  h.Store.patchSettings({ portraitLock: true });
  assert.deepEqual(h.calls, ['any']);
  h.document.hidden = false;
  h.events.visibilitychange();
  h.events.fullscreenchange();
  h.events.pageshow();
  await h.flush();
  assert.deepEqual(h.calls, ['any', 'portrait', 'portrait', 'portrait']);
});

test('missing and rejecting APIs give accurate guidance without losing the preference', async () => {
  for (const lock of [null, () => Promise.reject(new Error('NotSupportedError')), () => { throw new Error('SecurityError'); }]) {
    const h = harness({}, lock);
    await h.flush();
    assert.match(h.label.textContent, /device's rotation/);
    h.Store.patchSettings({ portraitLock: false });
    await h.flush();
    assert.equal(h.read('aura.settings').portraitLock, false);
    assert.doesNotMatch(h.label.textContent, /is locked|is allowed/);
  }
});

test('first interaction retries a lock that the browser initially refused', async () => {
  let allowed = false;
  const h = harness({}, () => allowed ? Promise.resolve() : Promise.reject(new Error('SecurityError')));
  await h.flush();
  allowed = true;
  h.events.pointerup();
  await h.flush();
  assert.deepEqual(h.calls, ['portrait', 'portrait']);
  assert.equal(h.label.textContent, 'Portrait orientation is locked.');
});

test('a stale failure cannot replace the result of a newer preference', async () => {
  let reject;
  const h = harness({}, value => value === 'portrait' ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve());
  h.Store.patchSettings({ portraitLock: false });
  await h.flush();
  reject(new Error('AbortError'));
  await h.flush();
  assert.match(h.label.textContent, /Rotation is allowed/);
});
