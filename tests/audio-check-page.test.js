const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { moduleFiles, pageScripts, readModule } = require('./source');

// audio-check.html resolves its test song through Api. The network layer is split across
// src/api/, and Api is published by the last of those files, so a page that loads only
// part of it has no Api at all: its Load button fails before any server is asked.

test('the audio check page loads the whole network layer, in index.html\'s order', () => {
  assert.deepEqual(pageScripts('audio-check.html'), moduleFiles('api'));
});

test('the network layer publishes Api.resolve without the rest of the app', () => {
  const window = {};
  vm.runInNewContext(readModule('api'), { window, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { onLine: true, userAgent: 'test' }, location: new URL('http://127.0.0.1/audio-check.html'),
    fetch: async () => { throw new Error('offline'); } });
  assert.equal(typeof window.Api.resolve, 'function');
});
