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

test('interface language uses a saved choice before the browser preference', () => {
  assert.equal(language({}, 'he-IL').I18n.language(), 'he');
  assert.equal(language({}, 'fr-FR').I18n.language(), 'en');
  assert.equal(language({ interfaceLanguage: 'en' }, 'he-IL').I18n.language(), 'en');
  assert.equal(language({ interfaceLanguage: 'he' }).I18n.language(), 'he');
  assert.equal(language({ interfaceLanguage: '<script>' }).I18n.language(), 'en');
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
