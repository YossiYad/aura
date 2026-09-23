const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readModule, readModuleExposing } = require('./source');

function formats(canPlayType) {
  const context = { window: {}, document: { getElementById: () => ({ canPlayType }) },
    navigator: {}, localStorage: { getItem: () => null }, console };
  vm.runInNewContext(readModuleExposing('api', ['playableAudio', 'playableMuxed'], 'formats'), context);
  return context.window.formats;
}

test('audio selection checks the codec instead of just the container', () => {
  const f = formats(mime => mime === 'audio/mp4; codecs="mp4a.40.2"' ? 'probably' : mime === 'audio/mp4' ? 'maybe' : '');
  const result = f.playableAudio([
    { url: 'unsupported', mimeType: 'audio/mp4; codecs="opus"', bitrate: 256000 },
    { url: 'supported', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
  ], 'best');
  assert.equal(result.url, 'supported');
});

test('unsupported audio yields no source so the resolver can try a muxed stream', () => {
  const f = formats(() => '');
  assert.equal(f.playableAudio([{ url: 'bad', type: 'audio/webm; codecs="opus"' }], 'best'), null);
});

test('muxed selection checks both video and audio codecs', () => {
  const f = formats(mime => mime.includes('avc1') ? 'probably' : '');
  const result = f.playableMuxed([
    { url: 'bad', type: 'video/mp4; codecs="av01, opus"', height: 144 },
    { url: 'good', type: 'video/mp4; codecs="avc1, mp4a.40.2"', height: 360 }
  ]);
  assert.equal(result.url, 'good');
});

test('TV playback selects AAC even when the phone prefers higher-bitrate Opus', () => {
  const f = formats(() => 'probably');
  const sources = [
    { url: 'opus', mimeType: 'audio/webm; codecs="opus"', bitrate: 256000 },
    { url: 'aac', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
  ];
  assert.equal(f.playableAudio(sources, 'best').url, 'opus');
  assert.equal(f.playableAudio(sources, 'best', true).url, 'aac');
});

test('TV playback rejects Opus inside MP4 and unsupported muxed codecs', () => {
  const f = formats(() => 'probably');
  assert.equal(f.playableAudio([{ url: 'opus', type: 'audio/mp4; codecs="opus"' }], 'best', true), null);
  assert.equal(f.playableMuxed([
    { url: 'av1', type: 'video/mp4; codecs="av01, mp4a.40.2"', height: 144 },
    { url: 'h264', type: 'video/mp4; codecs="avc1, mp4a.40.2"', height: 360 }
  ], true).url, 'h264');
});

function resolver(fetch, options = {}) {
  const source = readModule('api');
  const context = { window: { location: options.location }, document: { getElementById: () => ({ canPlayType: () => 'probably' }) },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} }, fetch,
    Date: options.Date || Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Blob, URL, console };
  vm.runInNewContext(source, context);
  return context.window.Api;
}

test('local and TV stream requests never reuse each others cached codec selection', async () => {
  const api = resolver(async url => ({ ok: true, json: async () => url === 'config.json'
    ? { invidiousInstances: ['https://test'] }
    : { adaptiveFormats: [
      { url: 'https://test/opus', type: 'audio/webm; codecs="opus"', bitrate: 256000 },
      { url: 'https://test/aac', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
    ] } }));
  const [local, tv] = await Promise.all([api.resolve('one', { quality: 'best' }), api.resolve('one', { quality: 'best', remote: true })]);
  assert.equal(local.url, 'https://test/opus');
  assert.equal(tv.url, 'https://test/aac');
  assert.equal((await api.resolve('one', { quality: 'best' })).url, 'https://test/opus');
  assert.equal((await api.resolve('one', { quality: 'best', remote: true })).url, 'https://test/aac');
});

test('Cobalt is asked for MP3 when resolving a stream for a TV', async () => {
  const requests = [];
  const api = resolver(async (url, options) => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://empty'], cobaltInstances: ['https://cobalt'] }) };
    if (url === 'https://cobalt/') {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ url: 'https://test/audio.mp3' }) };
    }
    return { ok: true, json: async () => ({ adaptiveFormats: [] }) };
  });
  await api.resolve('one', { remote: true });
  assert.equal(requests[0].audioFormat, 'mp3');
});

test('preselecting a receiver format ignores a cached local codec and shares the later remote lookup', async () => {
  let requests = 0;
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://test'] }) };
    requests++;
    return { ok: true, status: 200, json: async () => ({ adaptiveFormats: [
      { url: 'https://test/opus.webm', type: 'audio/webm; codecs="opus"', bitrate: 256000 },
      { url: 'https://test/aac.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
    ] }) };
  });
  assert.equal((await api.resolve('one')).url, 'https://test/opus.webm');
  const [safari, remote] = await Promise.all([
    api.resolve('one', { remote: false, receiverCompatible: true }),
    api.resolve('one', { remote: true })
  ]);
  assert.equal(safari.url, 'https://test/aac.m4a');
  assert.equal(remote.url, safari.url);
  assert.equal(requests, 2, 'one local lookup and one shared compatible lookup');
});

test('saving a Safari stream reuses its compatible lookup instead of fetching a different codec', async () => {
  let lookups = 0;
  const mediaRequests = [];
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://test'] }) };
    if (url.includes('/api/v1/videos/')) {
      lookups++;
      return { ok: true, json: async () => ({ adaptiveFormats: [
        { url: 'https://test/opus', type: 'audio/webm; codecs="opus"', bitrate: 256000 },
        { url: 'https://test/aac', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
      ] }) };
    }
    mediaRequests.push(url);
    return { ok: true, headers: { get: () => null },
      blob: async () => new Blob([new Uint8Array(110 * 1024)]) };
  });
  await api.resolve('one', { receiverCompatible: true });
  const saved = await api.fetchStreamBlob('one', 0, null, { receiverCompatible: true });
  assert.equal(saved.type, 'audio/mp4');
  assert.equal(lookups, 1, 'saving the already selected source adds no resolution request');
  assert.deepEqual(mediaRequests, ['https://test/aac']);
});

test('Invidious retains the upload duration alongside the playable stream', async () => {
  const api = resolver(async url => ({ ok: true, json: async () => url === 'config.json'
    ? { invidiousInstances: ['https://test'] }
    : { lengthSeconds: '210', adaptiveFormats: [
      { url: 'https://test/audio', type: 'audio/mp4', bitrate: 128000 }
    ] } }));
  assert.equal((await api.resolve('one')).duration, 210);
});

test('Piped retains the upload duration alongside the playable stream', async () => {
  const api = resolver(async url => ({ ok: true, json: async () => url === 'config.json'
    ? { invidiousInstances: [], pipedInstances: ['https://test'] }
    : { duration: 210, audioStreams: [
      { url: 'https://test/audio', mimeType: 'audio/mp4', bitrate: 128000 }
    ] } }));
  assert.equal((await api.resolve('one')).duration, 210);
});

for (const remote of [false, true]) {
  test('self-hosted streams receive a TV ticket before playback, remote=' + remote, async () => {
    const requests = [];
    const origin = 'https://test';
    const api = resolver(async (url, options) => {
      if (url === 'config.json') return { ok: true, json: async () => ({
        invidiousInstances: [origin], mediaTickets: '/api/media/ticket' }) };
      if (url === origin + '/api/media/ticket') {
        requests.push(options);
        return { ok: true, json: async () => ({ url: origin + '/media/play?ticket=scoped', expiresAt: Date.now() + 3600000 }) };
      }
      return { ok: true, json: async () => ({ lengthSeconds: 210, adaptiveFormats: [
        { url: '/videoplayback?id=one&sig=source', type: 'audio/mp4', bitrate: 128000 }
      ] }) };
    }, { location: { origin } });
    const result = await api.resolve('one', { remote });
    assert.equal(result.url, origin + '/media/play?ticket=scoped');
    assert.equal(result.duration, 210);
    assert.equal(result.mime, 'audio/mp4');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].credentials, 'same-origin');
    assert.deepEqual(JSON.parse(requests[0].body), { url: origin + '/videoplayback?id=one&sig=source' });
    assert.equal((await api.resolve('one', { remote })).url, result.url);
    assert.equal(requests.length, 1);
  });
}

test('expiring TV tickets are renewed even inside the normal stream cache lifetime', async () => {
  let clock = Date.now(), issued = 0;
  const origin = 'https://test';
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({
      invidiousInstances: [origin], mediaTickets: '/api/media/ticket' }) };
    if (url === origin + '/api/media/ticket') return { ok: true, json: async () => ({
      url: origin + '/media/play?ticket=' + (++issued), expiresAt: clock + 60000 }) };
    return { ok: true, json: async () => ({ adaptiveFormats: [{ url: '/videoplayback?id=one', type: 'audio/mp4' }] }) };
  }, { location: { origin }, Date: class extends Date { static now() { return clock; } } });
  assert.match((await api.resolve('one')).url, /ticket=1$/);
  clock += 31000;
  assert.match((await api.resolve('one')).url, /ticket=2$/);
});

test('a public external source is not sent to the private ticket issuer', async () => {
  const requests = [];
  const api = resolver(async url => {
    requests.push(url);
    if (url === 'config.json') return { ok: true, json: async () => ({
      invidiousInstances: ['https://external'], mediaTickets: '/api/media/ticket' }) };
    return { ok: true, json: async () => ({ adaptiveFormats: [{
      url: 'https://external/videoplayback?id=one', type: 'audio/mp4' }] }) };
  }, { location: { origin: 'https://test' } });
  assert.equal((await api.resolve('one')).url, 'https://external/videoplayback?id=one');
  assert.equal(requests.some(url => url.includes('/api/media/ticket')), false);
});

for (const failure of ['unauthorized', 'external-endpoint', 'external-ticket', 'expired']) {
  test('ticket failure ' + failure + ' never falls back to the cookie-protected stream', async () => {
    const origin = 'https://test';
    const api = resolver(async url => {
      assert.equal(url.startsWith('https://evil'), false);
      if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: [origin],
        mediaTickets: failure === 'external-endpoint' ? 'https://evil/api/media/ticket' : '/api/media/ticket' }) };
      if (url === origin + '/api/media/ticket') return { ok: failure !== 'unauthorized', status: 403, json: async () => ({
        url: (failure === 'external-ticket' ? 'https://evil' : origin) + '/media/play?ticket=scoped',
        expiresAt: Date.now() + (failure === 'expired' ? -1 : 3600000) }) };
      return { ok: true, json: async () => ({ adaptiveFormats: [{ url: '/videoplayback?id=one', type: 'audio/mp4' }] }) };
    }, { location: { origin } });
    await assert.rejects(api.resolve('one', { remote: true }));
  });
}

test('failed private audio downloads never send bearer tickets through public CORS relays', async () => {
  const origin = 'https://test', requests = [];
  const api = resolver(async url => {
    requests.push(url);
    if (url === 'config.json') return { ok: true, json: async () => ({
      invidiousInstances: [origin], mediaTickets: '/api/media/ticket' }) };
    if (url === origin + '/api/media/ticket') return { ok: true, json: async () => ({
      url: origin + '/media/play?ticket=private', expiresAt: Date.now() + 3600000 }) };
    if (url.startsWith(origin + '/media/play')) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ adaptiveFormats: [{ url: '/videoplayback?id=one', type: 'audio/mp4' }] }) };
  }, { location: { origin } });
  await assert.rejects(api.fetchStreamBlob('one', 0, null, { receiverCompatible: true }));
  assert.equal(requests.every(url => url === 'config.json' || url.startsWith(origin + '/')), true);
});

test('a resolve asks every server again once all of them are cooling off', async () => {
  let lookups = 0;
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://one', 'https://two'] }) };
    lookups++;
    // The network dropped while the first resolve was in flight: every server "failed to
    // fetch" at once and went into cooldown, though none of them was broken.
    if (lookups <= 2) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ adaptiveFormats: [
      { url: url.replace(/\/api\/v1.*$/, '') + '/audio.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }
    ] }) };
  });
  await assert.rejects(api.resolve('one'));
  const out = await api.resolve('one');
  assert.match(out.url, /^https:\/\/(one|two)\/audio\.m4a$/, 'the servers are asked rather than refused for ten minutes');
  assert.equal(lookups, 4);
});

// The import matcher's search results are stubbed; the classification helpers are
// exercised through the public API so their word matching is what the app sees.
function apiWith(items) {
  return resolver(async url => ({ ok: true, json: async () => url === 'config.json'
    ? { invidiousInstances: ['https://test'] } : items.map(t => ({ videoId: t.id, title: t.title, author: t.artist, lengthSeconds: t.duration || 200, viewCount: t.views || 0 })) }));
}

test('an import does not settle for another performer or a karaoke when that is all the search returns', async () => {
  const lionel = apiWith([{ id: 'lr', title: 'Lionel Richie - Hello (Official Music Video)', artist: 'Lionel Richie', views: 900000000 }]);
  assert.equal(await lionel.matchTrack('Hello', 'Adele'), null);
  const karaoke = apiWith([{ id: 'kk', title: 'Hello - Adele (Karaoke Version)', artist: 'Sing King Karaoke' }]);
  assert.equal(await karaoke.matchTrack('Hello', 'Adele'), null);
  const real = apiWith([{ id: 'ad', title: 'Adele - Hello (Official Music Video)', artist: 'Adele', views: 3000000000 },
    { id: 'lr', title: 'Lionel Richie - Hello (Official Music Video)', artist: 'Lionel Richie', views: 900000000 }]);
  assert.equal((await real.matchTrack('Hello', 'Adele')).id, 'ad');
});

test('format markers match whole words, and long classical or ambient pieces stay music', () => {
  const api = apiWith([]);
  assert.equal(api.looksLikePodcast({ title: 'האלטלנה - באש ובמים [עושים היסטוריה]', artist: 'עושים היסטוריה', duration: 3100 }), true);
  assert.equal(api.looksLikeMusic({ title: 'Sketchbook', artist: 'Some Band', duration: 250 }), true, '"sketch" is not in "Sketchbook"');
  assert.equal(api.looksLikePodcast({ title: 'Beethoven: Symphony No. 9', artist: 'Berliner Philharmoniker', duration: 4100 }), false);
  assert.equal(api.looksLikePodcast({ title: 'Obsession - the story of a collector', artist: 'Radio', duration: 2700 }), true);
});

test('a playlist served without a count ends at the page that adds nothing', async () => {
  let pages = 0;
  const api = resolver(async url => ({ ok: true, json: async () => {
    if (url === 'config.json') return { invidiousInstances: ['https://test'] };
    pages++;
    return { title: 'Mix', videos: [{ videoId: 'only', title: 'Only', author: 'A', lengthSeconds: 200 }] };
  } }));
  const out = await api.getPlaylistInfo('RDabc');
  assert.deepEqual(Array.from(out.tracks, t => t.id), ['only']);
  assert.equal(pages, 2, 'one page of content and one page that repeats it');
});

// The same race is won by the same server, so a download whose stream that server
// refuses used to give up with a healthy second server never asked for the file.
test('a download moves on to another server when the fastest one refuses the stream', async () => {
  const media = [];
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://one', 'https://two'] }) };
    if (/\/api\/v1\//.test(url)) {
      const base = url.replace(/\/api\/v1.*$/, '');
      if (base === 'https://two') await new Promise(done => setTimeout(done, 5));
      return { ok: true, status: 200, json: async () => ({ adaptiveFormats: [
        { url: base + '/audio.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }] }) };
    }
    media.push(url);
    if (url === 'https://two/audio.m4a') return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array(110 * 1024)]) };
    return { ok: false, status: 403, headers: { get: () => null } };
  });
  const blob = await api.fetchStreamBlob('one', 0, null);
  assert.equal(blob.size, 110 * 1024);
  assert.equal(media[0], 'https://one/audio.m4a');
  assert.equal(media[media.length - 1], 'https://two/audio.m4a');
});

// Too long is a fact about the track: asking the proxies pulled it up to the limit twice more.
test('a track over the size limit is not fetched again through the proxies', async () => {
  const media = [];
  const api = resolver(async url => {
    if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://one'] }) };
    if (/\/api\/v1\//.test(url)) return { ok: true, status: 200, json: async () => ({ adaptiveFormats: [
      { url: 'https://one/audio.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }] }) };
    media.push(url);
    return { ok: true, headers: { get: name => name === 'content-length' ? String(100 * 1048576) : null }, blob: async () => new Blob([]) };
  });
  await assert.rejects(api.fetchStreamBlob('one', 60 * 1048576, null), /too large/);
  assert.deepEqual(media, ['https://one/audio.m4a']);
});
