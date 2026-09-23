const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, flushMicrotasks } = require('./harness');
const { castSdk } = require('./cast-sdk-harness');

async function setup(playing = true) {
  const receiver = castSdk();
  const h = createHarness({ castSdk: receiver.sdk, exposeInternals: true,
    tracks: ['one', 'two', 'three'].map(id => ({ id, title: 'Song ' + id, artist: 'Artist ' + id,
      album: 'Album', thumb: 'https://test/' + id + '.jpg', duration: 180 })),
    settings: { autoplay: false, crossfade: 4 } });
  const P = h.window.Player;
  h.Api.resolve = async id => ({ url: 'https://test/' + id + '.m4a', mime: 'audio/mp4' });
  h.Api.invalidate = () => {};
  h.audio.currentTime = 42;
  if (playing) h.play();
  await P.requestRemotePlayback();
  await P.requestRemotePlayback();
  await flushMicrotasks(80);
  return { ...h, P, receiver, castAudio: h.window.CastPlayback.audio };
}

test('Cast hands off audio with receiver artwork, title, artist, album and listening position', async () => {
  const h = await setup();
  const request = h.receiver.loads[0];
  assert.equal(request.media.contentType, 'audio/mp4');
  assert.equal(request.media.metadata.title, 'Song one');
  assert.equal(request.media.metadata.artist, 'Artist one');
  assert.equal(request.media.metadata.albumName, 'Album');
  assert.equal(request.media.metadata.images[0].url, 'https://test/one.jpg');
  assert.equal(request.currentTime, 42);
  assert.equal(h.P.getTime().cur, 42);
  assert.equal(h.audio.paused, true, 'no duplicate audio on the phone');
  assert.equal(h.P.isPaused(), false);
  assert.equal(h.P.remotePlaybackStatus().deviceName, 'Living room');
  h.P.dismiss();
});

test('Cast prepares the next song and artwork on the receiver before the current song ends', async () => {
  const h = await setup();
  assert.equal(h.receiver.media().items.length, 3);
  assert.equal(h.receiver.media().items[1].media.metadata.title, 'Song two');
  h.document.hidden = true;
  h.receiver.advance();
  await flushMicrotasks(80);
  assert.equal(h.P.current().id, 'two');
  assert.equal(h.P.getTime().cur, 0);
  assert.equal(h.navigator.mediaSession.metadata.title, 'Song two');
  assert.equal(h.receiver.loads.length, 1, 'receiver advances without a new sender load');
  assert.equal(h.receiver.media().items.at(-1).media.metadata.title, 'Song three');
  h.P.dismiss();
});

test('manual next sends the new song metadata and controls reflect receiver state', async () => {
  const h = await setup();
  h.P.next();
  await flushMicrotasks(80);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.equal(h.P.current().id, 'two');
  assert.equal(h.receiver.loads.at(-1).media.metadata.title, 'Song two');
  assert.equal(h.receiver.loads.at(-1).media.metadata.images[0].url, 'https://test/two.jpg');
  h.P.pause();
  assert.equal(h.receiver.media().playerState, 'PAUSED');
  h.P.toggle();
  await flushMicrotasks(40);
  assert.equal(h.receiver.media().playerState, 'PLAYING');
  h.P.seekTo(68);
  assert.equal(h.receiver.media().currentTime, 68);
  h.P.setVolume(0.4);
  assert.equal(h.receiver.media().volume.level, 0.4);
  h.P.dismiss();
});

test('Cast connection preserves an explicit pause', async () => {
  const h = await setup(false);
  assert.equal(h.receiver.loads[0].autoplay, false);
  assert.equal(h.P.isPaused(), true);
  assert.equal(h.receiver.loads[0].currentTime, 42);
  h.P.dismiss();
});

test('disconnecting Cast keeps the queue and resumes locally only on request', async () => {
  const h = await setup();
  h.receiver.media().currentTime = 81;
  await h.P.requestRemotePlayback();
  assert.equal(h.P.isPaused(), true);
  assert.equal(h.P.current().id, 'one');
  assert.equal(h.audio.src, '');
  h.P.toggle();
  await flushMicrotasks(60);
  h.audio.dispatch('playing');
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.equal(h.audio.src, 'https://test/one.m4a');
  assert.equal(h.audio.currentTime, 81);
  h.P.dismiss();
});

test('removing an upcoming song removes it from the receiver queue', async () => {
  const h = await setup();
  h.P.removeAt(1);
  await flushMicrotasks(80);
  assert.deepEqual(h.receiver.media().items.map(item => item.media.customData.auraTrackId), ['one', 'three']);
  h.P.setSleepTimer('track');
  await flushMicrotasks(40);
  assert.equal(h.receiver.media().items.length, 1);
  h.P.dismiss();
});

test('sender network loss does not pause media that the TV is already receiving', async () => {
  const h = await setup();
  h.navigator.onLine = false;
  h.window.dispatch('offline');
  assert.equal(h.receiver.media().playerState, 'PLAYING');
  h.P.dismiss();
});

for (const replacement of ['off', '30']) {
  test('replacing end-of-track sleep with ' + replacement + ' restores the receiver queue', async () => {
    const h = await setup();
    h.P.setSleepTimer('track');
    await flushMicrotasks(60);
    assert.equal(h.receiver.media().items.length, 1);
    h.P.setSleepTimer(replacement);
    await flushMicrotasks(80);
    assert.deepEqual(h.receiver.media().items.map(item => item.media.customData.auraTrackId), ['one', 'two', 'three']);
    assert.equal(h.receiver.loads.length, 1);
    assert.equal(h.P.getTime().cur, 42);
    h.P.dismiss();
  });
}

test('receiver artwork never contains a device-local blob URL', async () => {
  const h = await setup();
  const info = h.window.CastPlayback.mediaInfo({ id: 'one', title: 'Test', thumb: 'blob:local' }, 'https://test/audio.mp3', 'audio/mpeg');
  assert.equal(info.metadata.images.length, 1);
  assert.match(info.metadata.images[0].url, /^https:/);
  h.P.dismiss();
});

test('the TV remote can pause and resume without the phone fighting its state', async () => {
  const h = await setup();
  h.receiver.media().playerState = 'PAUSED';
  h.receiver.notify();
  assert.equal(h.P.isPaused(), true);
  assert.equal(h.P.playbackRequested(), false);
  h.document.dispatch('visibilitychange');
  assert.equal(h.receiver.media().playerState, 'PAUSED');
  h.receiver.media().playerState = 'PLAYING';
  h.receiver.notify();
  assert.equal(h.P.isPaused(), false);
  assert.equal(h.P.playbackRequested(), true);
  h.P.dismiss();
});

test('phone audio-focus interruptions cannot silence the next Cast track', async () => {
  const h = await setup();
  h.audioSession.state = 'interrupted';
  h.audioSession.dispatch('statechange');
  h.P.jumpTo(2);
  await flushMicrotasks(60);
  h.runImmediateTimers();
  await flushMicrotasks(40);
  assert.equal(h.receiver.loads.at(-1).media.metadata.title, 'Song three');
  assert.equal(h.receiver.media().playerState, 'PLAYING');
  h.P.dismiss();
});

test('dismissing during a receiver load stops the late result', async () => {
  const h = await setup();
  const release = h.receiver.blockLoad();
  h.P.jumpTo(2);
  await flushMicrotasks(60);
  h.P.dismiss();
  release();
  await flushMicrotasks(80);
  assert.equal(h.P.current(), null);
  assert.equal(h.receiver.media().playerState, 'IDLE');
  assert.equal(h.P.playbackRequested(), false);
});

test('AirPlay metadata keeps a public cover when the previous metadata used a blob', async () => {
  const h = createHarness({ withAirPlay: true,
    tracks: [{ id: 'one', title: 'One', artist: 'Artist', thumb: 'https://test/mqdefault.jpg' }],
    settings: { autoplay: false } });
  h.Api.resolve = async () => ({ url: 'https://test/one.mp3', mime: 'audio/mpeg' });
  h.navigator.mediaSession.metadata.artwork = [{ src: 'blob:cropped-cover' }];
  h.audio.webkitCurrentPlaybackTargetIsWireless = true;
  h.audio.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  await flushMicrotasks(60);
  assert.equal(h.navigator.mediaSession.metadata.artwork[0].src, 'https://test/hqdefault.jpg');
  assert.equal(h.navigator.mediaSession.metadata.title, 'One');
  h.window.Player.dismiss();
});

test('Cast loads the registered custom receiver and retains the default without configuration', async () => {
  for (const [configured, expected] of [['ab12cd34', 'AB12CD34'], ['', 'default'], ['invalid', 'default']]) {
    const receiver = castSdk();
    const h = createHarness({ castSdk: receiver.sdk });
    h.Api.siteConfig = async () => ({ castReceiverAppId: configured });
    await h.window.CastPlayback.initialize();
    assert.equal(receiver.context.options.receiverApplicationId, expected);
  }
});

test('ordinary playback never initializes Cast or requests TV streams', async () => {
  const receiver = castSdk();
  const h = createHarness({ castSdk: receiver.sdk, tracks: [{ id: 'one', title: 'One', duration: 180 }] });
  let configReads = 0;
  const streams = [];
  h.Api.resolve = async (id, options) => { streams.push(options); return { url: 'https://test/one.mp3', mime: 'audio/mpeg' }; };
  h.Api.siteConfig = async () => { configReads++; return { castReceiverAppId: 'ABC12345' }; };
  h.play();
  h.audio.dispatch('playing');
  h.document.dispatch('visibilitychange');
  h.window.dispatch('pageshow');
  await flushMicrotasks(40);
  assert.equal(configReads, 0);
  assert.equal(receiver.context.options, undefined);
  assert.equal(receiver.loads.length, 0);
  assert.ok(streams.every(options => !options.remote));
  assert.equal(h.window.Player.remotePlaybackStatus().preparing, false);
  assert.equal(h.audio.paused, false);
  await h.window.Player.requestRemotePlayback();
  assert.equal(configReads, 1, 'Cast is initialized only after an explicit request');
  assert.equal(receiver.context.options.receiverApplicationId, 'ABC12345');
  h.window.Player.dismiss();
});

test('repeat one on the TV reloads a finished song from the start instead of finishing it again', async () => {
  const h = await setup();
  h.P.cycleRepeat(); h.P.cycleRepeat();
  assert.equal(h.P.repeat(), 'one');
  const before = h.receiver.loads.length;
  const media = h.receiver.media();
  media.currentTime = 180; media.playerState = 'IDLE'; media.idleReason = 'FINISHED';
  h.receiver.notify();
  await flushMicrotasks(80);
  assert.equal(h.receiver.loads.length, before + 1, 'one reload, not an endless chain');
  assert.equal(h.receiver.loads[before].currentTime, 0);
  assert.equal(h.castAudio.ended, false);
  assert.equal(h.P.current().id, 'one');
  h.P.dismiss();
});
