const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');

// On iPhone the page opts out of AirPlay's video mode, where the TV downloads the
// stream itself, shows the container's doubled length and ignores the volume buttons.
// The system route then streams the phone's own playback, like a music app.
function setup(iphone) {
  const h = createHarness({ withAirPlay: true, exposeInternals: true,
    navigator: iphone ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } : {},
    tracks: ['one', 'two'].map(id => ({ id, title: id, duration: 180 })),
    settings: { autoplay: false } });
  const requests = [];
  h.Api.resolve = async (id, opts) => {
    requests.push({ id, remote: !!(opts && opts.remote) });
    return { url: 'https://test/' + id + '.m4a' };
  };
  h.Api.invalidate = () => {};
  const events = [];
  h.window.Player.onChange(event => events.push(event.type));
  return { ...h, P: h.window.Player, requests, events, standby: h.audioElements[1] };
}

test('iPhone keeps both elements out of AirPlay video mode', () => {
  const h = setup(true);
  assert.equal(h.audio.getAttribute('x-webkit-airplay'), 'deny');
  assert.equal(h.standby.getAttribute('x-webkit-airplay'), 'deny');
  h.P.dismiss();
});

test('Safari on a Mac still hands the playing element to the receiver', () => {
  const h = setup(false);
  assert.equal(h.audio.getAttribute('x-webkit-airplay'), 'allow');
  assert.equal(h.standby.getAttribute('x-webkit-airplay'), 'deny');
  h.P.dismiss();
});

test('iPhone opens the system chooser in the same tap and leaves a saved song alone', async () => {
  const h = setup(true);
  h.audio.src = 'blob:download-one';
  h.audio.currentTime = 47;
  h.requests.length = 0;
  h.events.length = 0;
  h.P.requestRemotePlayback();
  // No awaited work may sit between the tap and the chooser: Safari would block it.
  assert.equal(h.audio.pickerCalls, 1);
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'blob:download-one');
  assert.equal(h.audio.currentTime, 47);
  assert.deepEqual(h.requests.filter(r => r.remote), []);
  assert.equal(h.events.includes('remote-ready'), false);
  assert.equal(h.P.remotePlaybackStatus().state, 'disconnected');
  h.P.dismiss();
});

test('Mac Safari still prepares a receiver stream for a saved song before the chooser', async () => {
  const h = setup(false);
  h.audio.src = 'blob:download-one';
  h.P.requestRemotePlayback();
  assert.equal(h.audio.pickerCalls, 0);
  await flushMicrotasks(40);
  assert.equal(h.requests.some(r => r.remote), true);
  h.P.dismiss();
});
