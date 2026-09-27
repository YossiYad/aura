const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createStore } = require('./store-harness');
const source = fs.readFileSync(require.resolve('../guest/i18n.js'), 'utf8');

function language(settings = {}, browser = 'en-US') {
  const store = createStore({ 'aura.settings': settings });
  const events = [];
  const window = { Store: store.Store, dispatchEvent: event => events.push(event.type) };
  vm.runInNewContext(source, { window, navigator: { language: browser },
    CustomEvent: class { constructor(type) { this.type = type; } } });
  return { ...store, I18n: window.I18n, events };
}

test('interface language is English until the listener saves a choice', () => {
  assert.equal(language({}, 'he-IL').I18n.language(), 'en');
  assert.equal(language({}, 'fr-FR').I18n.language(), 'en');
  assert.equal(language({ interfaceLanguage: 'en' }, 'he-IL').I18n.language(), 'en');
  assert.equal(language({ interfaceLanguage: 'he' }).I18n.language(), 'he');
  assert.equal(language({ interfaceLanguage: '<script>' }).I18n.language(), 'en');
});

test('the first-launch question knows whether a choice exists and which one to offer first', () => {
  const unset = language({}, 'he-IL').I18n;
  assert.equal(unset.chosen(), false);
  assert.equal(unset.suggested(), 'he');
  assert.equal(language({}, 'en-GB').I18n.suggested(), 'en');
  assert.equal(language({ interfaceLanguage: '<script>' }).I18n.chosen(), false);
  assert.equal(language({ interfaceLanguage: 'en' }, 'he-IL').I18n.chosen(), true);
});

test('AI replies are asked for in the interface language', () => {
  assert.equal(language({}, 'he-IL').I18n.aiLanguage(), 'English');
  assert.equal(language({ interfaceLanguage: 'he' }).I18n.aiLanguage(), 'Hebrew');
  const h = language({ interfaceLanguage: 'he' });
  h.I18n.setLanguage('en');
  assert.equal(h.I18n.aiLanguage(), 'English');
});

test('English translates interface fragments without changing markup or unknown content', () => {
  const { I18n } = language();
  assert.equal(I18n.t('לחצו ודברו'), 'Tap to speak');
  assert.equal(I18n.t('מצאתי: '), 'Found: ');
  assert.equal(I18n.t('<button aria-label="חיפוש">חיפוש</button>'), '<button aria-label="Search">Search</button>');
  assert.equal(I18n.t('שם שיר שלא מופיע במילון'), 'שם שיר שלא מופיע במילון');
  assert.equal(I18n.t(undefined), undefined);
});

test('Hebrew preserves the existing mixed interface exactly', () => {
  const { I18n } = language({ interfaceLanguage: 'he' });
  const fragment = '<button>QR להזמנה</button> · Ask AI';
  assert.equal(I18n.t(fragment), fragment);
  assert.equal(I18n.direction(), 'rtl');
});

test('changing interface language persists through Store and preserves explicit speech settings', () => {
  const h = language({ voiceLanguage: 'he-IL', crossfade: 4 });
  assert.equal(h.I18n.setLanguage('en'), true);
  assert.equal(h.read('aura.settings').interfaceLanguage, 'en');
  assert.equal(h.Store.settings().crossfade, 4);
  assert.equal(h.I18n.speechLanguage(), 'he-IL');
  assert.equal(language(h.read('aura.settings'), 'he-IL').I18n.language(), 'en');
  assert.deepEqual(h.events, ['aura-language']);
  assert.equal(h.I18n.setLanguage('invalid'), false);
  assert.equal(h.Store.settings().interfaceLanguage, 'en');
});

test('speech follows interface language until explicitly selected', () => {
  const h = language();
  assert.equal(h.I18n.speechLanguage(), 'en-US');
  h.I18n.setLanguage('he');
  assert.equal(h.I18n.speechLanguage(), 'he-IL');
});

// Messages that reach the listener as Hebrew literals - the voice errors, the shared
// queue server's refusals and the voice request errors - each need an English line, or
// an English interface shows them in Hebrew.
const hebrew = /[֐-׿]/;
const read = file => fs.readFileSync(require.resolve('../' + file), 'utf8');

test('every voice error and shared queue refusal has an English translation', () => {
  const { I18n } = language();
  const search = read('src/views/search.js');
  const start = search.indexOf('const VOICE_ERRORS');
  const voiceErrors = [...search.slice(start, search.indexOf('};', start)).matchAll(/"([^"]*)"/g)].map(m => m[1]);
  const refusals = [...read('selfhost/private-app/queue/server.js').matchAll(/fail\(\d+,\s*([^;]*?)\);/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']*)'/g)].map(s => s[1]));
  const messages = voiceErrors.concat(refusals).filter(text => hebrew.test(text));
  assert(messages.length > 20, 'the messages were found');
  assert.deepEqual(messages.filter(text => hebrew.test(I18n.t(text))), []);
});

test('Hebrew voice request errors go through the translation', () => {
  const { I18n } = language();
  for (const file of ['src/views/search.js', 'src/voice/requests.js']) {
    const source = read(file);
    assert.deepEqual([...source.matchAll(/new Error\("([^"]*)"\)/g)].map(m => m[1]).filter(text => hebrew.test(text)), [], file);
    const wrapped = [...source.matchAll(/tr\("([^"]*)"\)/g)].map(m => m[1]).filter(text => hebrew.test(text));
    assert.deepEqual(wrapped.filter(text => hebrew.test(I18n.t(text))), [], file);
  }
});
