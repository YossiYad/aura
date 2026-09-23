const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createStore } = require('./store-harness');
const { readModule } = require('./source');

function harness(items) {
  const { Store } = createStore();
  const queries = [], logs = [];
  const Ai = { hasAnyKey: () => true, interpretPlayback: assert.fail };
  const Log = { add: (tag, text) => logs.push({ tag, text }) };
  const context = vm.createContext({
    window: { Store, Ai, Log }, Store, Ai, Log, navigator: { onLine: true },
    Player: { queue: () => [] }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      if (url === 'config.json') return { ok: true, json: async () => ({ invidiousInstances: ['https://music.test'] }) };
      const query = new URL(url);
      if (query.pathname === '/api/v1/search') queries.push(query.searchParams.get('q'));
      else assert.equal(typeof items, 'function', 'unexpected channel request');
      return { ok: true, json: async () => typeof items === 'function' ? items(query) : items };
    }
  });
  for (const name of ['api', 'voice']) {
    vm.runInContext(readModule(name), context);
    if (name === 'api') context.Api = context.window.Api;
  }
  return { Voice: context.window.Voice, Api: context.Api, Store, Ai, queries, logs, navigator: context.navigator };
}

// The upload ID also appears in the user's successful manual playback log.
const requested = { type: 'video', videoId: 'GQxx-fssrmM', title: 'אייל גולן-ואיך בשמיים', author: 'Music uploader', lengthSeconds: 240, viewCount: 1000 };
const cover = { ...requested, videoId: 'cover111111', title: 'אייל גולן ואיך בשמיים קאבר', author: 'Other Singer', viewCount: 100000000 };
const other = { ...requested, videoId: 'other111111', title: 'אייל גולן - איך', author: 'אייל גולן - Topic' };

test('spoken Hebrew spelling variants select the same manually playable upload with zero AI calls', async () => {
  const { Voice, queries, logs } = harness([cover, other, requested]);
  for (const title of ['ואיך בשמים', 'ואיך בשמיים', 'וְאֵיךְ בַּשָּׁמַיִם']) {
    const result = await Voice.resolve('תשים לי את השיר ' + title + ' של אייל גולן');
    assert.equal(result.tracks[0].id, requested.videoId);
  }
  assert.equal(queries.length, 3, 'only a direct music search per request');
  assert(logs.some(entry => entry.tag === 'match' && entry.text.includes('selected GQxx-fssrmM')));
});

test('a similar short title or another singers cover does not replace the requested song', async () => {
  const { Api } = harness([cover, other]);
  assert.equal(await Api.matchTrack('ואיך בשמים', 'אייל גולן', { original: true }), null);
});

test('Hebrew spelling normalization retains the requested performer', async () => {
  const wrong = { ...requested, title: 'ואיך בשמיים', author: 'משה פרץ - Topic' };
  const { Api } = harness([wrong]);
  assert.equal(await Api.matchTrack('ואיך בשמים', 'אייל גולן', { original: true }), null);
});

test('English repeated letters still distinguish titles', async () => {
  const { Api } = harness([{ ...requested, title: 'Good Mood', author: 'Queen' }]);
  assert.equal(await Api.matchTrack('God Mod', 'Queen', { original: true }), null);
});

test('typed artist request validates uploads after real API channel normalization', async () => {
  const wrong = { ...requested, videoId: 'unrelated11', title: 'Песня', author: 'Snoop Dogg', authorId: 'snoop' };
  const right = { ...requested, author: 'אייל גולן Eyal Golan Official', authorId: 'eyal' };
  const { Voice, logs } = harness(url => {
    if (url.pathname === '/api/v1/search') return url.searchParams.get('type') === 'channel'
      ? [{ type: 'channel', authorId: 'eyal', author: right.author }] : [wrong];
    if (url.pathname === '/api/v1/channels/eyal') return { author: right.author };
    if (url.pathname === '/api/v1/channels/eyal/videos') return { videos: [wrong, right,
      { ...right, videoId: 'staleauthor', authorId: 'someone-else' }] };
    if (/\/(releases|playlists)$/.test(url.pathname)) return { playlists: [] };
    assert.fail('Unexpected API path: ' + url.pathname);
  });
  const result = await Voice.resolve('תשים לי שיר של אייל גולן');
  assert.deepEqual(Array.from(result.tracks, t => t.id), [right.videoId]);
  assert(logs.some(entry => entry.tag === 'voice' && entry.text.includes('accepted 1 of 3')));
});

test('the reported Cyrillic clip and other unverified uploads cannot win from search or local history', async () => {
  const game = { ...requested, videoId: 'nqC9OCicziY', title: 'Дота 2 #1',
    author: 'הערוץ הרשמי אייל גולן', authorId: 'renamed', authorVerified: false, lengthSeconds: 92 };
  const unrelated = { ...game, videoId: 'unrelated11', title: 'Песня' };
  const right = { ...requested, title: 'ואיך בשמיים', author: 'אייל גולן', authorId: 'eyal', authorVerified: true };
  const { Voice, Store, queries } = harness([game, unrelated, right]);
  for (const track of [game, unrelated]) Store.addTrack({ id: track.videoId, title: track.title,
    artist: track.author, artistId: track.authorId, duration: track.lengthSeconds });
  const result = await Voice.resolve('תשים תשים לי שיר של אייל גולן');
  assert.deepEqual(Array.from(result.tracks, t => t.id), [right.videoId]);
  assert.deepEqual(queries, ['אייל גולן'], 'no mistaken song lookup or AI retry');
});

test('unverified music uploads with the artist in their title remain playable', async () => {
  const track = { ...requested, author: 'אייל גולן', authorVerified: false };
  const { Voice } = harness([track]);
  assert.equal((await Voice.resolve('תשים לי שיר של אייל גולן')).tracks[0].id, track.videoId);
});

test('artist evidence applies to arbitrary performers and names claiming Official, Topic or VEVO', async () => {
  for (const artist of ['Queen', 'עידן רייכל', '坂本龍一']) {
    const right = { ...requested, title: 'A real release', author: artist, authorId: 'real', authorVerified: true };
    const fakes = ['Official', '- Topic', 'VEVO'].map((suffix, i) => ({ ...right,
      videoId: 'fake' + i, title: 'Unrelated clip official audio', author: artist + ' ' + suffix,
      authorId: 'fake-channel', authorVerified: false }));
    const { Voice, Store } = harness([...fakes, right]);
    for (const fake of fakes) Store.pushRecent({ id: fake.videoId, title: fake.title,
      artist: fake.author, artistId: fake.authorId, duration: 180 });
    assert.deepEqual(Array.from((await Voice.resolve('play songs by ' + artist)).tracks, t => t.id), [right.videoId]);
  }
});

test('verified recordings take precedence over unverified same-name uploads even with plausible titles', async () => {
  const right = { ...requested, author: 'Queen', authorVerified: true, title: 'Bohemian Rhapsody' };
  const uncertain = { ...right, videoId: 'uncertain11', author: 'Queen Official', authorVerified: false, title: 'Queen - Bohemian Rhapsody' };
  const { Voice } = harness([uncertain, right]);
  assert.deepEqual(Array.from((await Voice.resolve('play songs by Queen')).tracks, t => t.id), [right.videoId]);
});

test('fresh metadata revokes a stale local artist match for the same upload', async () => {
  const wrong = { ...requested, videoId: 'stale111111', title: 'Some clip', author: 'Other uploader' };
  const right = { ...requested, title: 'A real release', author: 'Queen', authorVerified: true };
  const { Voice, Store } = harness([wrong, right]);
  Store.addTrack({ id: wrong.videoId, title: 'A real release', artist: 'Queen', artistVerified: true, duration: 180 });
  assert.deepEqual(Array.from((await Voice.resolve('play songs by Queen')).tracks, t => t.id), [right.videoId]);
});

test('verification survives recent-play storage for offline artist requests', async () => {
  const right = { ...requested, title: 'A real release', author: 'Queen', authorVerified: true };
  const { Voice, Store, navigator } = harness([right]);
  const result = await Voice.resolve('play songs by Queen');
  Store.pushRecent(result.tracks[0]);
  navigator.onLine = false;
  assert.equal((await Voice.resolve('play songs by Queen')).tracks[0].id, right.videoId);
});

test('channel lookup prefers provider verification over a self-declared Official name', async () => {
  const fetched = [];
  const { Voice, Store, navigator } = harness(url => {
    if (url.pathname === '/api/v1/search') return url.searchParams.get('type') === 'channel'
      ? [{ type: 'channel', authorId: 'fake', author: 'Queen Official', authorVerified: false, subCount: 5 },
        { type: 'channel', authorId: 'real', author: 'Queen', authorVerified: true, subCount: 500000 }]
      : [{ ...requested, title: 'Some clip', author: 'Queen Official', authorVerified: false }];
    fetched.push(url.pathname);
    if (url.pathname === '/api/v1/channels/real') return { author: 'Queen' };
    if (url.pathname === '/api/v1/channels/real/videos') return { videos: [
      { ...requested, title: 'A real release', author: 'Queen', authorId: 'real' },
      { ...requested, videoId: 'wrong111111', title: 'Other upload', author: 'Queen', authorId: 'fake' }] };
    if (/\/(releases|playlists)$/.test(url.pathname)) return { playlists: [] };
    assert.fail('Unexpected API path: ' + url.pathname);
  });
  const result = await Voice.resolve('play songs by Queen');
  assert.deepEqual(Array.from(result.tracks, t => t.id), [requested.videoId]);
  assert(fetched.every(path => path.startsWith('/api/v1/channels/real')));
  Store.pushRecent(result.tracks[0]);
  navigator.onLine = false;
  assert.equal((await Voice.resolve('play songs by Queen')).tracks[0].id, requested.videoId);
});

test('no identifiable artist recording yields no queue instead of a similarly named uploader', async () => {
  const wrong = { ...requested, title: 'Random clip', author: 'Queen Official', authorVerified: 'true' };
  const { Voice, Store, Ai, navigator } = harness(url => url.searchParams.get('type') === 'channel' ? [] : [wrong]);
  Ai.hasAnyKey = () => false;
  Store.pushRecent({ id: wrong.videoId, title: wrong.title, artist: wrong.author, duration: 180 });
  await assert.rejects(Voice.resolve('play songs by Queen'), /לא נמצאו/);
  navigator.onLine = false;
  await assert.rejects(Voice.resolve('play songs by Queen'), /לא נמצאו/);
});

test('a channel name cannot override evidence that an upload is not music', () => {
  const { Api } = harness([]);
  for (const artist of ['Queen Official', 'Queen - Topic', 'QueenVEVO', 'הערוץ הרשמי אייל גולן']) {
    assert.equal(Api.looksLikeMusic({ title: 'Interview with friends', artist, duration: 180 }), false);
    assert.equal(Api.looksLikeMusic({ title: 'A clip', artist, duration: 15 }), false);
  }
});
