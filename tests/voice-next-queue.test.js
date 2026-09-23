const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, flushMicrotasks } = require('./harness');
const { readModule, moduleScope } = require('./source');

const requested = { id: 'requested', title: 'Requested', artist: 'Singer' };
function setup({ playing = true, action = 'next', empty = false, tracks = [requested], surface = 'ask', prompt = '', spoken = false } = {}) {
  const h = createHarness({ withStorage: true, withAudioSession: false,
    settings: { autoplay: false }, tracks: [
      { id: 'current', title: 'Current' }, { id: 'later', title: 'Later' }
    ] });
  h.Api.resolve = async id => ({ url: 'https://test/' + id });
  h.Api.getSkipSegments = async () => [];
  if (empty) h.window.Player.dismiss();
  else if (playing) h.play();
  // The request runs on the Ask screen itself. These are the few nodes it touches there.
  const classes = { add() {}, remove() {}, toggle() {} };
  const nodes = {};
  const node = id => nodes[id] ||= { value: '', style: {}, scrollHeight: 0, classList: classes, listeners: {},
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    dispatch(type) { for (const listener of this.listeners[type] || []) listener({ type }); },
    removeEventListener() {}, setAttribute() {}, focus() {}, blur() {} };
  let capture;
  const replies = [], notices = [], painted = [];
  const Voice = { supported: () => true, stopReply() {}, isCommand: () => false,
    listen: options => { capture = options; return { cancel() {}, finish() {} }; },
    resolve: async () => ({ tracks, label: requested.title, action }),
    reply: async message => { replies.push(message); }
  };
  const timers = [];
  const context = { tr: value => value, Player: h.window.Player, Store: h.Store, Voice, Promise, setTimeout: (fn, ms) => timers.push({ fn, ms }),
    askState: { prompt, spoken, status: 'idle', step: '' }, ASK_STEPS: {},
    document: { getElementById: node },
    window: { dispatchEvent: event => painted.push(event.detail) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    toast: text => notices.push(text) };
  const source = readModule('views');
  const start = source.indexOf('  let voice = null;');
  const end = source.indexOf('  // The browser closes the microphone on its own');
  const helpers = ['askNote', 'paintAskOrb', 'wireAsk'].map(name => {
    const at = source.indexOf('  function ' + name + '(');
    return source.slice(at, source.indexOf('\n  }', at) + 4);
  }).join('\n');
  vm.createContext(moduleScope(context));
  vm.runInContext(helpers + '\n' + source.slice(start, end) + '\nthis.voiceOpen = () => voice;', context);
  context.voiceStart(surface);
  context.wireAsk();
  return { ...h, context, Voice, replies, notices, nodes, painted, timers,
    capture: () => capture,
    cancel() { context.voiceEnd(); },
    submit() { capture.onfinish('put Requested next'); } };
}

test('voice next inserts after the current track and resumes it at the same position', async () => {
  const h = setup();
  const position = h.audio.currentTime;
  assert.equal(h.audio.paused, true, 'microphone pauses the current song');
  h.submit();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'requested', 'later']);
  assert.equal(h.window.Player.current().id, 'current');
  assert.equal(h.audio.currentTime, position);
  assert.equal(h.audio.paused, false);
  assert.match(h.notices[0], /השיר הבא בתור/);
  assert.match(h.replies[0].he, /לשיר הבא/);
});

test('voice next preserves a queue that was paused before the microphone opened', async () => {
  const h = setup({ playing: false });
  h.submit();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'requested', 'later']);
  assert.equal(h.audio.paused, true);
  assert.equal(h.audio.playCalls, 0);
});

test('voice next starts the requested song when the queue is empty', async () => {
  const h = setup({ empty: true });
  h.submit();
  await flushMicrotasks(80);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['requested']);
  assert.equal(h.audio.paused, false);
  assert.match(h.notices[0], /הבקשה נשלחה לנגן/);
});

test('cancelling during voice lookup keeps the original queue', async () => {
  const h = setup();
  let release;
  h.Voice.resolve = () => new Promise(resolve => { release = resolve; });
  h.submit();
  h.cancel();
  release({ tracks: [requested], label: requested.title, action: 'next' });
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later']);
  assert.equal(h.audio.paused, false);
  assert.equal(h.notices.length, 0);
});

test('a regular voice play request still replaces the queue', async () => {
  const h = setup({ action: 'play' });
  h.submit();
  await flushMicrotasks(80);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['requested']);
  assert.equal(h.audio.paused, false);
});

test('voice append puts songs at the end in order and resumes the current track', async () => {
  const h = setup({ action: 'append', tracks: [requested, { id: 'second', title: 'Second' }] });
  const position = h.audio.currentTime;
  h.submit();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later', 'requested', 'second']);
  assert.equal(h.window.Player.current().id, 'current');
  assert.equal(h.audio.currentTime, position);
  assert.equal(h.audio.paused, false);
  assert.match(h.notices[0], /נוסף לסוף התור/);
});

test('voice append preserves an already paused track and skips queued duplicates', async () => {
  const h = setup({ action: 'append', playing: false, tracks: [{ id: 'later', title: 'Later' }, requested] });
  h.submit();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later', 'requested']);
  assert.equal(h.audio.paused, true);
});

test('appending songs with an empty queue starts the first and retains the rest', async () => {
  const h = setup({ action: 'append', empty: true, tracks: [requested, { id: 'second', title: 'Second' }] });
  h.submit();
  await flushMicrotasks(80);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['requested', 'second']);
  assert.equal(h.window.Player.current().id, 'requested');
  assert.equal(h.audio.paused, false);
});

test('cancelling during the spoken queue confirmation prevents any insertion', async () => {
  const h = setup({ action: 'append' });
  let release;
  h.Voice.reply = () => new Promise(resolve => { release = resolve; });
  h.submit();
  await flushMicrotasks(20);
  h.cancel();
  release();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later']);
  assert.equal(h.audio.paused, false);
});

test('an existing song is reported as already queued without duplicating it', async () => {
  const h = setup({ action: 'append', tracks: [{ id: 'later', title: 'Later' }] });
  h.submit();
  await flushMicrotasks(80);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later']);
  assert.match(h.notices[0], /כבר נמצא בתור/);
});

// ---- The request on the Ask screen itself: no dialog to close, so these are the moments
// the paused song comes back, and the places the words go.

test('a microphone error keeps the words, reads the note out and then hands the song back', async () => {
  const h = setup();
  assert.equal(h.audio.paused, true, 'paused for the microphone');
  let release;
  h.Voice.reply = message => { h.replies.push(message); return new Promise(resolve => { release = resolve; }); };
  h.capture().ontext('put Requested', false);
  h.capture().onerror('no-speech', 'put Requested');
  await flushMicrotasks(10);
  assert.equal(h.context.askState.prompt, 'put Requested');
  assert.equal(h.context.askState.spoken, true);
  assert.match(h.context.voiceOpen().status, /לא שמעתי המשך/);
  assert.equal(h.audio.paused, true, 'not while the note is being read out');
  release();
  await flushMicrotasks(10);
  assert.equal(h.audio.paused, false);
  assert.equal(h.timers.length, 0, 'on the Ask screen the note stays until something else happens');
});

test('a second tap while listening closes the microphone and hands the song back', async () => {
  const h = setup();
  h.context.voiceStart('ask');
  await flushMicrotasks(10);
  assert.equal(h.context.voiceOpen().recording, false);
  assert.equal(h.audio.paused, false);
});

test('a tap while the request is being looked up calls it off', async () => {
  const h = setup();
  let release;
  h.Voice.resolve = () => new Promise(resolve => { release = resolve; });
  h.submit();
  await flushMicrotasks(10);
  assert.equal(h.context.voiceOpen().busy, true);
  h.context.voiceStart('ask');
  assert.equal(h.context.voiceOpen(), null);
  release({ tracks: [requested], label: requested.title, action: 'play' });
  await flushMicrotasks(40);
  assert.deepEqual(Array.from(h.window.Player.queue(), t => t.id), ['current', 'later']);
  assert.equal(h.audio.paused, false);
});

test('a new recording clears previous speech and never appends to a typed idea', () => {
  const spoken = setup({ prompt: 'put Requested', spoken: true });
  assert.equal(spoken.context.askState.prompt, '');
  assert.equal(spoken.nodes['ask-prompt'].value, '');
  spoken.capture().ontext('play Later', false);
  assert.equal(spoken.context.askState.prompt, 'play Later');
  const typed = setup({ prompt: 'something calm for studying', spoken: false });
  assert.equal(typed.context.askState.prompt, 'something calm for studying');
  typed.capture().ontext('play Requested', false);
  assert.equal(typed.context.askState.prompt, 'play Requested');
  assert.equal(typed.context.askState.spoken, true);
});

test('successive spoken retries submit only the new words after a failed lookup or clarification', async () => {
  const h = setup();
  const requests = [];
  h.Voice.resolve = async text => {
    requests.push(text);
    throw new Error('נא לציין את שם השיר והאמן');
  };
  for (const text of ['play Requested', 'play Later by Singer', 'play Another by Someone']) {
    h.capture().ontext(text, true);
    h.capture().onfinish(text);
    await flushMicrotasks(40);
    assert.equal(h.context.askState.prompt, text);
    h.context.voiceStart('ask');
    assert.equal(h.context.askState.prompt, '');
    assert.equal(h.context.voiceOpen().recording, true);
    assert.equal(h.audio.paused, true);
  }
  assert.deepEqual(requests, ['play Requested', 'play Later by Singer', 'play Another by Someone']);
});

test('callbacks from a stopped recording cannot overwrite or close the next recording', async () => {
  const h = setup();
  const first = h.capture();
  first.ontext('play Requested', false);
  h.context.voiceStart('ask');
  h.context.voiceStart('ask');
  h.capture().onlistening(true);
  h.capture().ontext('play Later', false);
  const current = h.context.voiceOpen();
  const requests = [];
  h.Voice.resolve = async text => { requests.push(text); throw new Error('No match'); };
  first.ontext('old correction', true);
  first.onfinishing();
  first.onlistening(false);
  first.onfinish('old request');
  first.onerror('network', 'old request');
  await flushMicrotasks(40);
  assert.equal(h.context.voiceOpen(), current);
  assert.equal(h.context.askState.prompt, 'play Later');
  assert.equal(current.recording, true);
  assert.equal(current.hearing, true);
  assert.equal(current.finishing, false);
  assert.equal(h.audio.paused, true);
  assert.deepEqual(requests, []);
});

test('a delayed driving note cannot dismiss a later failed request', async () => {
  const h = setup({ surface: 'drive' });
  h.Voice.resolve = async () => { throw new Error('No match'); };
  h.submit();
  await flushMicrotasks(40);
  const oldDismiss = h.timers[0];
  h.context.voiceStart('drive');
  h.capture().onfinish('play Later');
  await flushMicrotasks(40);
  oldDismiss.fn();
  assert.equal(h.context.askState.prompt, 'play Later');
  assert.equal(h.context.voiceOpen().status, 'No match');
});

test('a request that was called off leaves no words behind for the next one', () => {
  const h = setup();
  h.capture().ontext('put Requested', false);
  h.cancel();
  assert.equal(h.context.askState.prompt, '');
  h.context.voiceStart('ask');
  h.capture().ontext('play Later', false);
  assert.equal(h.context.askState.prompt, 'play Later');
  const typed = setup({ prompt: 'something calm for studying' });
  typed.cancel();
  assert.equal(typed.context.askState.prompt, 'something calm for studying', 'typed words are not the request\'s to throw away');
});

test('only editing the field takes over from the microphone', async () => {
  const h = setup();
  h.capture().ontext('put Requestd', false);
  h.nodes['ask-prompt'].dispatch('beforeinput');
  await flushMicrotasks(10);
  assert.equal(h.context.voiceOpen().recording, false);
  assert.equal(h.context.askState.prompt, 'put Requestd', 'the words stay to be corrected');
  assert.equal(h.context.askState.spoken, true, 'and still count as a request to play');
  assert.equal(h.audio.paused, false);
});

test('focusing or touching the transcript does not stop successive recordings or require submission', async () => {
  const h = setup();
  const requests = [];
  h.Voice.resolve = async text => { requests.push(text); throw new Error('Please try again'); };
  for (const text of ['play First', 'play Second', 'play Third']) {
    h.capture().ontext(text, false);
    h.nodes['ask-prompt'].dispatch('pointerdown');
    h.nodes['ask-prompt'].dispatch('focus');
    assert.equal(h.context.voiceOpen().recording, true);
    h.capture().onfinishing();
    h.capture().onfinish(text);
    await flushMicrotasks(40);
    h.context.voiceStart('ask');
  }
  assert.deepEqual(requests, ['play First', 'play Second', 'play Third']);
});

test('a successful request clears the field and closes the request', async () => {
  const h = setup({ action: 'play' });
  h.submit();
  await flushMicrotasks(80);
  assert.equal(h.context.askState.prompt, '');
  assert.equal(h.context.askState.spoken, false);
  assert.equal(h.context.voiceOpen(), null);
  assert.equal(h.painted.at(-1), null, 'and anything drawing it elsewhere is told it is over');
});

test('driving mode is told what to draw, and a failed request there clears itself', async () => {
  const h = setup({ surface: 'drive' });
  assert.equal(h.painted.at(-1).surface, 'drive');
  assert.equal(h.painted.at(-1).state, 'connecting');
  h.capture().onlistening(true);
  assert.equal(h.painted.at(-1).state, 'listening');
  h.Voice.resolve = async () => { throw new Error('לא נמצאו שירים'); };
  h.submit();
  await flushMicrotasks(40);
  assert.equal(h.painted.at(-1).status, 'לא נמצאו שירים');
  assert.equal(h.painted.at(-1).text, 'put Requested next');
  assert.equal(h.timers.length, 1, 'no hand is free to dismiss it');
  h.timers[0].fn();
  assert.equal(h.context.voiceOpen(), null);
  assert.equal(h.painted.at(-1), null);
  assert.equal(h.audio.paused, false);
});

test('a browser with no speech recognition says so under the orb and opens nothing', () => {
  const h = setup({ playing: false });
  h.context.voiceEnd();
  h.Voice.supported = () => false;
  h.context.voiceStart('ask');
  assert.match(h.context.voiceOpen().status, /אין כאן זיהוי דיבור/);
  assert.equal(h.context.voiceOpen().recording, false);
});
