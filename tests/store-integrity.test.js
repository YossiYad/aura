const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createStore } = require('./store-harness');
const { readModule } = require('./source');
const ids = xs => Array.from(xs, x => x.id);

test('undo restores the removed song without losing later songs, likes or playlists', () => {
  const { Store } = createStore({ 'aura.library': [{id:'a'}, {id:'c'}], 'aura.liked':['a'],
    'aura.playlists':[{id:'p',name:'List',ids:['a','c']}] });
  const undo = Store.removeTrack('a');
  Store.addTrack({id:'b'}); Store.toggleLike('b'); Store.addToPlaylist('p','b');
  Store.renamePlaylist('p','New name'); undo();
  assert.deepEqual(new Set(ids(Store.library())),new Set(['a','b','c']));
  assert.equal(Store.getPlaylist('p').name,'New name');
  assert.deepEqual(Array.from(Store.getPlaylist('p').ids),['a','c','b']);
  assert(Store.isLiked('a')); assert(Store.isLiked('b'));
});
test('undo playlist deletion preserves a later playlist and does not resurrect deleted tracks', () => {
  const { Store } = createStore({'aura.library':[{id:'a'}], 'aura.playlists':[{id:'old',name:'Old',ids:['a']}]});
  const undo=Store.deletePlaylist('old');const added=Store.createPlaylist('New'); Store.removeTrack('a');undo();
  assert(Store.getPlaylist(added.id));assert.deepEqual(Array.from(Store.getPlaylist('old').ids),[]);
});
test('a malformed backup is rejected before any data or notices change',()=>{
  const {Store,read}=createStore({'aura.library':[{id:'a'}]}); let notices=0;Store.onChange(()=>notices++);
  const b=Store.exportData();b.data.library=[null];
  assert.throws(()=>Store.importData(b),/invalid records/);assert.equal(notices,0);
  assert.deepEqual(ids(Store.library()),['a']);assert.deepEqual(read('aura.library'),[{id:'a'}]);
});
test('a current full backup including listening stats round trips',()=>{
  const {Store}=createStore();Store.addTrack({id:'a',title:'A',artist:'Artist'});Store.pushRecent(Store.findTrack('a'));
  Store.follow({id:'UC1',name:'Artist'});Store.rememberDownload(Store.findTrack('a'));Store.blockTrack({id:'b',title:'B'});
  const backup=Store.exportData();const next=createStore().Store;next.importData(backup);
  assert.equal(next.topListeningTracks()[0].id,'a');assert.equal(next.topListeningTracks()[0].plays,1);
  assert.equal(next.followsList()[0].id,'UC1');assert.equal(next.downloadedTracks()[0].id,'a');
});
test('a storage failure rolls back earlier keys and memory and sends no success notice',()=>{
  const local=new Map([['aura.library',JSON.stringify([{id:'a'}])],['aura.liked','["a"]'],['aura.playlists','[]']]);
  let fail=true,notices=0,toasts=0;const window={Views:{toast(){toasts++;}}};
  vm.runInNewContext(readModule('store'),{window,console,Date,Math,Map,Set,JSON,
    localStorage:{getItem:k=>local.get(k)||null,removeItem:k=>local.delete(k),setItem(k,v){if(k==='aura.liked'&&fail){fail=false;throw new Error('quota');}local.set(k,v);}},
    sessionStorage:{getItem:()=>null,setItem(){}}});
  window.Store.onChange(()=>notices++);assert.throws(()=>window.Store.removeTrack('a'),/quota/);
  assert.equal(window.Store.findTrack('a').id,'a');assert.equal(window.Store.isLiked('a'),true);
  assert.equal(JSON.parse(local.get('aura.library'))[0].id,'a');assert.equal(notices,0);assert.equal(toasts,1);
});
test('clearAll commits deletions and preserves follows',()=>{
 const {Store,read}=createStore({'aura.library':[{id:'a'}],'aura.follows':[{id:'UC1'}]});
 Store.clearAll();assert.equal(read('aura.library'),null);assert.equal(Store.followsList().length,1);
});

// The audio files outlive the wipe; without their record nothing lists or removes them.
test('clearAll keeps the record of what was taken offline',()=>{
 const {Store,read}=createStore({'aura.library':[{id:'a',title:'Saved'}]});
 Store.rememberDownload({id:'a',title:'Saved',artist:'Someone'});Store.clearAll();
 assert.deepEqual(Array.from(Store.downloadedTracks(),t=>t.id),['a']);assert.equal(read('aura.downloads').a.title,'Saved');
});

test('playlists created in the same millisecond keep independent IDs and contents', () => {
  const { Store } = createStore();
  const realNow = Date.now;
  Date.now = () => 123456789;
  let first, second;
  try {
    first = Store.createPlaylist('First');
    second = Store.createPlaylist('Second');
  } finally {
    Date.now = realNow;
  }
  assert.notEqual(first.id, second.id);
  Store.addToPlaylist(first.id, 'a');
  Store.addToPlaylist(second.id, 'b');
  assert.deepEqual(Array.from(Store.getPlaylist(first.id).ids), ['a']);
  assert.deepEqual(Array.from(Store.getPlaylist(second.id).ids), ['b']);
  Store.deletePlaylist(second.id);
  assert.equal(Store.getPlaylist(first.id).name, 'First');
});

test('a downloaded podcast retains its classification when played from downloads', () => {
 const { Store } = createStore();
 Store.rememberDownload({ id: 'episode', title: 'A subject', artist: 'A host', kind: 'podcast', podcast: 'A Show' });
 const [saved] = Store.downloadedTracks();
 assert.equal(saved.kind, 'podcast');
 assert.equal(saved.podcast, 'A Show');
 Store.pushRecent(saved);
 assert.equal(Store.topListeningTracks(10, 'music').length, 0);
 assert.equal(Store.topListeningTracks(10, 'podcast')[0].id, 'episode');
});

// A resume point, a lyric cache or the queue is written by playback, not by a tap. A full
// disk there is worth a log line, not an error toast every five seconds over the music.
test('storage failure on a background write stays quiet and does not throw', () => {
  const h = createStore();
  const toasts = [];
  h.window.Views = { toast: (msg, kind) => toasts.push({ msg, kind }) };
  h.Store.addTrack({ id: 'a', title: 'A' });
  h.localApi.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(h.Store.savePosition('a', 42), false);
  assert.equal(h.Store.cacheSegments('a', []), false);
  assert.equal(h.Store.pushRecent({ id: 'a', title: 'A' }), false);
  assert.equal(toasts.length, 0);
});

// What the listener actually asked for still has to say so when it cannot be saved.
test('storage failure on a tapped action still reports and rolls back', () => {
  const h = createStore();
  const toasts = [];
  h.window.Views = { toast: (msg, kind) => toasts.push({ msg, kind }) };
  h.localApi.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => h.Store.addTrack({ id: 'b', title: 'B' }), /QuotaExceeded/);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'err');
  assert(!h.Store.findTrack('b'));
});

// A malformed record the loader tolerates must stay tolerated after a failed write rolls
// the records back from storage, or every list render throws until the app is reloaded.
test('a rolled-back store repairs its records the way the loader does', () => {
  const h = createStore({ 'aura.podcastShows': { shows: 'nonsense' }, 'aura.playlists': [{ id: 'p', name: 'P' }], 'aura.library': { not: 'a list' } });
  h.window.Views = { toast() {} };
  h.Store.addTrack({ id: 'a', title: 'A' });
  const setItem = h.localApi.setItem;
  h.localApi.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => h.Store.addTrack({ id: 'b', title: 'B' }), /QuotaExceeded/);
  assert.doesNotThrow(() => h.Store.library());
  assert.doesNotThrow(() => h.Store.recents());
  assert.deepEqual(Array.from(h.Store.getPlaylist('p').ids), []);
  h.localApi.setItem = setItem;
  assert.doesNotThrow(() => h.Store.removeTrack('a'));
});

test('blocking an artist from a Topic upload covers the same artist on their other channels', () => {
  const { Store } = createStore();
  Store.blockArtist('Adele - Topic');
  assert.equal(Store.isBlocked({ id: 'x', title: 'Hello', artist: 'Adele' }), true);
  assert.equal(Store.isBlocked({ id: 'y', title: 'Hello', artist: 'AdeleVEVO' }), true);
  assert.equal(Store.isBlocked({ id: 'z', title: 'Hello', artist: 'Adele Smith' }), false);
});
