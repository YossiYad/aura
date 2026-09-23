const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('./store-harness');
const seed = () => ({
  'aura.library': ['a', 'b', 'c'].map(id => ({ id, title: id })),
  'aura.playlists': [{ id: 'p', name: 'Mix', ids: ['a', 'b', 'c'] }, { id: 'other', name: 'Other', ids: ['a', 'b'] }]
});

test('playlist moves persist, notify sync, and determine playback order after reload', () => {
  const { Store, read } = createStore(seed());
  const notices = [];
  Store.onChange(kind => notices.push(kind));
  assert.equal(Store.movePlaylistTrack('p', 'a', 'c'), true);
  assert.deepEqual(read('aura.playlists')[0].ids, ['b', 'c', 'a']);
  assert.equal(Store.movePlaylistTrack('p', 'a', 'b'), true);
  assert.deepEqual(read('aura.playlists')[0].ids, ['a', 'b', 'c']);
  Store.movePlaylistTrack('p', 'b', 'a');
  const reloaded = createStore({ ...seed(), 'aura.playlists': read('aura.playlists') }).Store;
  assert.deepEqual(Array.from(reloaded.playlistTracks('p'), t => t.id), ['b', 'a', 'c']);
  assert.deepEqual(Array.from(reloaded.getPlaylist('other').ids), ['a', 'b']);
  assert.deepEqual(notices, ['playlists', 'playlists', 'playlists']);
});

test('stale or identical move targets leave membership and storage untouched', () => {
  const { Store, read } = createStore(seed());
  Store.onChange(() => assert.fail('no notification for an invalid move'));
  for (const args of [['missing', 'a', 'b'], ['p', 'missing', 'b'], ['p', 'a', 'missing'], ['p', 'a', 'a']]) {
    assert.equal(Store.movePlaylistTrack(...args), false);
  }
  assert.deepEqual(read('aura.playlists'), seed()['aura.playlists']);
});

test('failed persistence rolls back a playlist move', () => {
  const { Store, localApi, read } = createStore(seed());
  localApi.setItem = () => { throw new Error('disk full'); };
  Store.onChange(() => assert.fail('no success notice'));
  assert.throws(() => Store.movePlaylistTrack('p', 'a', 'c'));
  assert.deepEqual(Array.from(Store.getPlaylist('p').ids), ['a', 'b', 'c']);
  assert.deepEqual(read('aura.playlists')[0].ids, ['a', 'b', 'c']);
});
