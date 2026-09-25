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

function aiNetwork(fetch, globals = {}) {
  const data = new Map([['aura.aiKeys.gemini', '["gemini-key"]'], ['aura.aiKeys.groq', '["groq-key"]']]);
  const window = { ...globals };
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  vm.runInNewContext(readModule('ai'), { Store: { playlists: () => [] }, ...globals, window, localStorage: storage, fetch, AbortController, URL,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), clearTimeout, console, navigator: { onLine: true } });
  return window.Ai;
}

// The other spellings a performer goes by ride along with an artist or latest reading and
// nowhere else; blank and non-string entries are dropped and at most three are kept.
test('a playback reading keeps up to three other performer names for artist and latest requests', async () => {
  let content;
  const Ai = aiNetwork(async url => String(url).includes('groq')
    ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) }
    : { ok: false, status: 503, json: async () => ({}) });
  content = { kind: 'artist', query: 'עומר אדם', artist: '', names: ['Omer Adam', ' ', 7, 'Omer', 'Adam O', 'extra'], tracks: [] };
  assert.deepEqual(Array.from((await Ai.interpretPlayback('שיר של עומר אדם')).names), ['Omer Adam', 'Omer', 'Adam O']);
  content = { kind: 'latest', query: 'עומר אדם', artist: '', names: ['Omer Adam'], tracks: [] };
  assert.deepEqual(Array.from((await Ai.interpretPlayback('השיר החדש של עומר אדם')).names), ['Omer Adam']);
  content = { kind: 'song', query: 'Song', artist: 'Omer Adam', names: ['Ignored'], tracks: [] };
  assert.deepEqual(Array.from((await Ai.interpretPlayback('Song by Omer Adam')).names), []);
  content = { kind: 'artist', query: 'Queen', artist: '' };
  assert.deepEqual(Array.from((await Ai.interpretPlayback('songs by Queen')).names), []);
});

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

test('AI writes what the listener reads in the interface language they picked', async () => {
  const prompts = [];
  let language = 'English';
  const intent = { kind: 'clarify', query: 'Which one?', artist: '', tracks: [] };
  const fetch = async (url, options) => {
    if (!String(url).includes('groq')) return { ok: false, status: 503, json: async () => ({}) };
    const prompt = JSON.parse(options.body).messages[0].content;
    prompts.push(prompt);
    const content = prompt.startsWith('Interpret') ? intent : { name: 'Mix', tracks: [{ title: 'Song', artist: 'Singer' }] };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  const Ai = aiNetwork(fetch, { I18n: { aiLanguage: () => language }, Store: { playlists: () => [] } });
  await Ai.generatePlaylist('שירים שקטים לערב');
  assert.match(prompts.at(-1), /Write the playlist name in English/);
  await Ai.interpretPlayback('תשים את השיר ההוא');
  assert.match(prompts.at(-1), /short question in query in English/);
  assert.match(prompts.at(-1), /short mix name in English/);
  language = 'Hebrew';
  await Ai.generatePlaylist('calm evening');
  assert.match(prompts.at(-1), /Write the playlist name in Hebrew/);
  assert.match(prompts.at(-1), /keep every song title and artist name exactly/);
  await Ai.interpretPlayback('play that song');
  assert.match(prompts.at(-1), /short question in query in Hebrew/);
});

test('AI prompts fall back to English when no interface language is loaded', async () => {
  let prompt = '';
  const Ai = aiNetwork(async (url, options) => {
    if (!String(url).includes('groq')) return { ok: false, status: 503, json: async () => ({}) };
    prompt = JSON.parse(options.body).messages[0].content;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ name: 'Mix', tracks: [{ title: 'Song', artist: 'Singer' }] }) } }] }) };
  });
  await Ai.generatePlaylist('calm evening');
  assert.match(prompt, /Write the playlist name in English/);
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

// An iPhone records voice requests after its first one and has them transcribed.
function aiTranscribe(fetch, stored) {
  const data = new Map(Object.entries(stored));
  const window = {};
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  vm.runInNewContext(readModule('ai'), { window, localStorage: storage, fetch, AbortController, URL, FormData, Blob, btoa,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), clearTimeout, console, navigator: { onLine: true } });
  return window.Ai;
}
const bothKeys = { 'aura.aiKeys.gemini': '["gemini-key"]', 'aura.aiKeys.groq': '["groq-key"]' };
const recording = () => new Blob([Uint8Array.from([1, 2, 3, 250])], { type: 'audio/mp4' });

test('a recorded request goes to Whisper on Groq first, in the language it was spoken in', async () => {
  const calls = [];
  const Ai = aiTranscribe(async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ text: ' תשים שיר של אייל גולן ' }) };
  }, bothKeys);
  assert.equal(await Ai.transcribe(recording(), 'he-IL'), 'תשים שיר של אייל גולן');
  assert.equal(calls.length, 1, 'Gemini is not asked once Groq answered');
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer groq-key');
  const form = calls[0].options.body;
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('language'), 'he');
  assert.equal(form.get('file').name, 'request.m4a');
  assert.equal(form.get('file').size, 4);
});

test('Gemini transcribes the recording itself when Groq cannot', async () => {
  const calls = [];
  const Ai = aiTranscribe(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('groq')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'play Song' }] } }] }) };
  }, bothKeys);
  assert.equal(await Ai.transcribe(recording(), 'he-IL'), 'play Song');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent\?key=gemini-key$/);
  assert.equal(calls[1].options.headers['Content-Type'], 'text/plain', 'no CORS preflight, as with every Gemini call');
  const audio = JSON.parse(calls[1].options.body).contents[0].parts[1].inlineData;
  assert.equal(audio.mimeType, 'audio/mp4');
  assert.equal(audio.data, Buffer.from([1, 2, 3, 250]).toString('base64'));
});

test('the provider chosen in Settings limits transcription too, and no key says so', async () => {
  let groq = 0;
  const Ai = aiTranscribe(async url => {
    if (String(url).includes('groq')) groq++;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'play Song' }] } }] }) };
  }, { ...bothKeys, 'aura.aiMode': 'gemini' });
  assert.equal(await Ai.transcribe(recording(), 'he-IL'), 'play Song');
  assert.equal(groq, 0, 'Gemini only means Groq is never sent the recording');
  const none = aiTranscribe(async () => assert.fail('nothing is sent without a key'), {});
  await assert.rejects(none.transcribe(recording(), 'he-IL'), error => error.noKey === true);
});
