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
