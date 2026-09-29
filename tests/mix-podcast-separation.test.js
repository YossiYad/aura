const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function mix() {
  const context = {
    require: name => name === 'http' ? { createServer: () => ({ listen() {} }) } :
      name === 'fs' ? { mkdirSync() {} } : require(name),
    process: { env: {} }, console, URL, Buffer, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../selfhost/private-app/mix/server.js'), 'utf8'), context);
  return context;
}

test('server music taste excludes podcast plays and stale artist aggregates', () => {
  const m = mix();
  const song = { id: 'song', title: 'Music', artist: 'Singer', kind: 'music' };
  const episode = { id: 'episode', title: 'A subject', artist: 'Host', kind: 'podcast', podcast: 'Show' };
  const account = {
    library: [song, episode], recents: [episode], downloads: { episode },
    listeningProfile: { tracks: {
      song: { track: song, plays: 2 }, episode: { track: episode, plays: 100 }
    }, artists: { Host: { plays: 100 }, Singer: { plays: 2 } } }
  };
  assert.deepEqual(Array.from(m.topListeningTracks(account), t => t.id), ['song']);
  assert.deepEqual(Array.from(m.topListeningArtists(account), a => a.name), ['Singer']);
  assert.deepEqual(Array.from(m.knownArtists(account)), ['singer']);
});

// Withdrawing a key takes the mix it built with it. A build still running at that moment
// used to write its mix afterwards anyway, leaving a mix made with a withdrawn key that
// nothing would ever remove.
test('a mix whose key was withdrawn while it was being built is not kept', async () => {
  const os = require('node:os'), path = require('node:path');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mix-')), sync = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sync-'));
  let answer;
  const context = {
    require: name => name === 'http' ? { createServer: () => ({ listen() {} }) } : require(name),
    process: { env: { MIX_DATA_DIR: data, SYNC_DATA_DIR: sync } }, console: { log() {}, error() {} },
    URL, Buffer, setTimeout, clearTimeout, AbortController, Response,
    fetch: async url => {
      if (String(url).includes('generativelanguage')) {
        await new Promise(resolve => { answer = resolve; });
        const text = JSON.stringify({ name: 'Mix', tracks: [{ title: 'Hello', artist: 'Adele' }] });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
      }
      return new Response(JSON.stringify([{ videoId: 'abcdefghijk', title: 'Adele - Hello (Official Video)', author: 'Adele', lengthSeconds: 300, viewCount: 1000 }]));
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../selfhost/private-app/mix/server.js'), 'utf8'), context);
  const key = 'listener@example.test';
  const song = { id: 'song', title: 'Hello', artist: 'Adele', kind: 'music' };
  fs.writeFileSync(path.join(sync, key + '.json'), JSON.stringify({ data: { data: {
    library: [song], recents: [song], listeningProfile: { tracks: { song: { track: song, plays: 3 } }, artists: { Adele: { plays: 3 } } }
  } } }));
  context.writeJson(context.keysFile(key), { gemini: ['own-key'], at: Date.now() });
  const build = context.buildMix(key);
  await new Promise(resolve => setTimeout(resolve, 20));
  context.forgetOwnKeys(key);
  answer();
  await assert.rejects(build, /withdrawn/);
  assert.equal(context.readMix(key), null);
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(sync, { recursive: true, force: true });
});

test('a listener whose mode names a provider they hold no key for still builds with their own keys', () => {
  const m = mix();
  m.readOwnKeys = () => ({ gemini: [], groq: ['groq-key'], mode: 'gemini', geminiModel: '', groqModel: '' });
  const chosen = m.providersFor('listener');
  assert.equal(chosen.mine, true);
  assert.deepEqual(Array.from(chosen.providers, p => p.name), ['groq']);
  m.readOwnKeys = () => ({ gemini: ['g'], groq: ['q'], mode: 'groq', geminiModel: '', groqModel: '' });
  assert.deepEqual(Array.from(m.providersFor('listener').providers, p => p.name), ['groq']);
});

test('the nightly run builds only for listeners who show the Home row', () => {
  const m = mix();
  m.readAccount = key => key === 'on' ? { settings: { aiHomeSection: true } } : key === 'off' ? { settings: {} } : null;
  assert.equal(m.wantsHomeMix('on'), true);
  assert.equal(m.wantsHomeMix('off'), false);
  assert.equal(m.wantsHomeMix('missing'), false);
});

// With no key at all the profile still says enough: the artists played most, searched for
// their other songs. Nothing already in the profile, at most two per artist, dealt out.
test('a mix is built from the listening profile alone when there is no key', async () => {
  const m = mix();
  const heard = (id, artist, plays) => ({ track: { id, title: 'Heard ' + id, artist, kind: 'music' }, plays, lastPlayed: 1 });
  const account = { listeningProfile: { tracks: { h1: heard('h1', 'Alpha', 9), h2: heard('h2', 'Beta', 5), h3: heard('h3', 'Gamma', 2) }, artists: {} } };
  const searched = [];
  m.searchTracks = async query => {
    searched.push(query);
    const artist = query.split(' ')[0];
    return ['h1', 'a', 'b', 'c'].map((suffix, i) => ({ id: suffix === 'h1' ? 'h1' : artist + suffix, title: artist + ' song ' + i, artist, duration: 200 }));
  };
  m.readAccount = () => account;
  const picked = await m.profileSuggestions(account, m.blockedOf(account));
  assert(searched.some(q => q.startsWith('Alpha')) && searched.some(q => q.startsWith('Beta')), 'the top artists are searched');
  assert(!picked.some(t => t.id === 'h1'), 'a song already in the profile is not suggested again');
  for (const artist of ['Alpha', 'Beta', 'Gamma']) assert(picked.filter(t => t.artist === artist).length <= 2, artist + ' at most twice');
  assert.deepEqual(Array.from(picked.slice(0, 3), t => t.artist), ['Alpha', 'Beta', 'Gamma'], 'dealt out in turn');
  assert.equal(m.canBuildFor('anyone'), true, 'a profile with music is enough to build for');
  m.readAccount = () => null;
  assert.equal(m.canBuildFor('nobody'), false);
});
