const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule } = require('./source');

function aiStorage(seed = {}, failWrite = false) {
  const data = new Map(Object.entries(seed));
  const window = {};
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (failWrite) throw Error('storage full'); data.set(key, value); },
    removeItem: key => data.delete(key)
  };
  vm.runInNewContext(readModule('ai'), { window, localStorage: storage });
  return { Ai: window.Ai, data };
}

test('a key migration preserves the legacy copy when new storage fails', () => {
  const h = aiStorage({ 'aura.geminiKey': 'example-key' }, true);
  assert.equal(h.data.get('aura.geminiKey'), 'example-key');
});

test('adding a key reports a storage failure instead of claiming success', () => {
  const h = aiStorage({}, true);
  assert.throws(() => h.Ai.addKey('gemini', 'example-key'), /storage full/);
  assert.equal(h.Ai.getKeys('gemini').length, 0);
});

test('removing a key reports a storage failure and keeps the existing key', () => {
  const h = aiStorage({ 'aura.aiKeys.gemini': '["example-key"]' }, true);
  assert.throws(() => h.Ai.removeKey('gemini', 'example-key'), /storage full/);
  assert.equal(h.Ai.getKeys('gemini').length, 1);
});

function aiNetwork(fetch) {
  const data = new Map([['aura.aiKeys.gemini', '["gemini-key"]'], ['aura.aiKeys.groq', '["groq-key"]']]);
  const window = {};
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  vm.runInNewContext(readModule('ai'), { window, localStorage: storage, fetch, AbortController, URL,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), clearTimeout, console, navigator: { onLine: true } });
  return window.Ai;
}

// A key set aside after a quota answer was never asked again for ten minutes, even when
// every other key failed for reasons of its own.
test('a cooling key is still asked once every live key has failed', async () => {
  const reply = { choices: [{ message: { content: JSON.stringify({ name: 'Mix', tracks: [{ title: 'Song', artist: 'Singer' }] }) } }] };
  let groq = 0, groqLimited = true;
  const Ai = aiNetwork(async url => {
    if (String(url).includes('groq')) { groq++; return groqLimited ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => reply }; }
    return { ok: false, status: 503, json: async () => ({}) };
  });
  await assert.rejects(Ai.generatePlaylist('calm evening'));
  assert.equal(groq, 1);
  groqLimited = false;
  const mix = await Ai.generatePlaylist('calm evening');
  assert.equal(mix.tracks[0].title, 'Song');
  assert.equal(groq, 2);
});

test('hyphenated and unspaced English durations count as a stated length', async () => {
  const reply = { choices: [{ message: { content: JSON.stringify({ name: 'Mix', targetMinutes: 45, tracks: [{ title: 'Song', artist: 'Singer' }] }) } }] };
  const Ai = aiNetwork(async url => String(url).includes('groq') ? { ok: true, status: 200, json: async () => reply } : { ok: false, status: 503, json: async () => ({}) });
  for (const ask of ['a 45-minute workout', '30min run', 'two-hour drive']) assert.equal((await Ai.generatePlaylist(ask)).targetSeconds, 2700, ask);
  assert.equal((await Ai.generatePlaylist('songs like After Hours')).targetSeconds, null);
});

test('Gemini key diagnostics find a supported model beyond the first page', async () => {
  const pages = [];
  const Ai = aiNetwork(async (url, options) => {
    if (options.mode === 'no-cors') return {};
    const parsed = new URL(url);
    if (parsed.pathname === '/v1beta/models') {
      pages.push(parsed);
      return { ok: true, status: 200, json: async () => parsed.searchParams.has('pageToken')
        ? { models: [{ name: 'models/gemini-test-later', supportedGenerationMethods: ['generateContent'] }] }
        : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page+/two' } };
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"tracks":[]}' }] } }] }) };
  });
  Ai.setModel('gemini', 'gemini-test-later');
  const result = await Ai.testKey('gemini', 'key+/with-specials');
  assert.equal(result.ok, true, result.verdict);
  assert.equal(pages.length, 2);
  for (const url of pages) {
    assert.equal(url.searchParams.get('key'), 'key+/with-specials');
    assert.equal(url.searchParams.get('pageSize'), '1000');
  }
  assert.equal(pages[1].searchParams.get('pageToken'), 'page+/two');
});
