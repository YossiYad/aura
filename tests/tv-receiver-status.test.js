const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The receiver page with a stand-in Cast player, so its status line can be read as events land.
function receiver() {
  const els = {}, listeners = {}, timers = [];
  const el = id => els[id] || (els[id] = { id, hidden: false, disabled: false, textContent: '', value: 0, dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, focus() {}, replaceChildren() {},
    appendChild() {}, append() {}, prepend() {}, getClientRects: () => [1], getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  const state = { st: 'PLAYING', media: { metadata: { title: 'Song', images: [] } }, failSeek: true };
  const player = {
    addEventListener: (event, fn) => (listeners[event] = listeners[event] || []).push(fn),
    getMediaInformation: () => state.media, getPlayerState: () => state.st,
    getDurationSec: () => 200, getCurrentTimeSec: () => 10, getQueueManager: () => null,
    seek() { if (state.failSeek) throw new Error('seek failed'); }, play() {}, pause() {}
  };
  const context = {
    document: { getElementById: el, addEventListener() {}, body: el('body'), createElement: () => el('x' + Math.random()),
      createElementNS: () => el('svg' + Math.random()), activeElement: el('body') },
    cast: { framework: { CastReceiverContext: { getInstance: () => ({ getPlayerManager: () => player, start() {} }) },
      events: { EventType: { MEDIA_STATUS: 'status', TIME_UPDATE: 'time', LOADED_METADATA: 'meta', ERROR: 'error' } },
      messages: { Command: {} } } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    Number, Math, String, JSON, Array, Infinity, Date
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../tv/receiver.js'), 'utf8'), context);
  return { el, state, emit: event => (listeners[event] || []).forEach(fn => fn()),
    runTimers: ms => timers.filter(t => t.ms === ms).forEach(t => t.fn()) };
}

test('a failed command on the TV is said for a moment, not for the rest of the song', () => {
  const r = receiver();
  r.el('seek').value = 500;
  r.el('seek').onchange();
  assert.match(r.el('status').textContent, /Could not complete that command/);
  r.emit('time');
  r.runTimers(6000);
  assert.equal(r.el('status').textContent, '');
  r.el('seek').onchange();
  assert.match(r.el('status').textContent, /Could not complete that command/);
  r.state.failSeek = false;
  r.el('seek').onchange();
  assert.equal(r.el('status').textContent, '');
});

test('a song that could not play is still reported once the receiver goes idle', () => {
  const r = receiver();
  r.emit('error');
  r.state.st = 'IDLE';
  r.state.media = null;
  r.emit('status');
  assert.match(r.el('status').textContent, /could not play/);
  r.state.st = 'PLAYING';
  r.state.media = { metadata: { title: 'Next', images: [] } };
  r.emit('meta');
  assert.equal(r.el('status').textContent, '');
});
