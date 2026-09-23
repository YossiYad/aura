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
