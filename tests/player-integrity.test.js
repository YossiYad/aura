const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness,flushMicrotasks}=require('./harness');
function memoryDb(){
 const stores={tracks:new Map(),art:new Map(),cache:new Map()};
 function request(result){const req={result};Promise.resolve().then(()=>{if(req.onsuccess)req.onsuccess();});return req;}
 return {objectStoreNames:{contains:()=>true},transaction(name){
  const map=stores[name]||(stores[name]=new Map());const tx={objectStore:()=>({get:key=>request(map.get(key)||null),put:(value,key)=>{map.set(key,value);return request();},delete:key=>{map.delete(key);return request();},getAllKeys:()=>request([...map.keys()])})};
  Promise.resolve().then(()=>{if(tx.oncomplete)tx.oncomplete();});return tx;
 }};
}
test('repeat one keeps restarting beyond the first loop',async()=>{
 const h=createHarness({settings:{autoplay:false}});h.window.Player.cycleRepeat();h.window.Player.cycleRepeat();h.play();
 for(let i=0;i<3;i++){h.audio.currentTime=180;h.audio.ended=true;h.audio.paused=true;h.audio.dispatch('ended');await flushMicrotasks();assert.equal(h.audio.paused,false);h.audio.ended=false;}
 assert.equal(h.audio.playCalls,4);
});
test('repeat all returns to the sole track even without autoplay',async()=>{
 const h=createHarness({settings:{autoplay:false},withStorage:true});h.Api.resolve=async()=>({url:'https://test/audio'});h.Api.getSkipSegments=async()=>[];
 const P=h.window.Player;P.cycleRepeat();h.play();h.audio.ended=true;h.audio.paused=true;h.audio.dispatch('ended');await flushMicrotasks(60);h.runImmediateTimers();await flushMicrotasks(60);
 assert(h.audio.playCalls>=2);
});
test('sleep deadline stops playback with animation frames suspended',()=>{
 const h=createHarness();h.play();h.window.Player.setSleepTimer(1);h.runTimers(48000);
 assert.equal(h.audio.paused,false);h.runTimers(60000);assert.equal(h.audio.paused,true);assert.equal(h.window.Player.sleepTimerState(),'off');
});
test('changing tracks during the sleep fade does not remove the stop deadline',async()=>{
 const h=createHarness({withStorage:true});h.Api.resolve=async()=>({url:'https://test/audio'});h.Api.getSkipSegments=async()=>[];
 h.play();h.window.Player.setSleepTimer(1);h.runTimers(48000);h.window.Player.playQueue([{id:'new',title:'New'}],0);
 await flushMicrotasks(60);h.runImmediateTimers();await flushMicrotasks(30);h.runTimers(60000);
 assert.equal(h.audio.paused,true);assert.equal(h.window.Player.sleepTimerState(),'off');
});
test('a completed download can be deleted and queued again',async()=>{
 const h=createHarness({withStorage:true,storageDb:memoryDb()});let fetches=0;h.Api.fetchStreamBlob=async()=>{fetches++;return {size:1024};};
 const P=h.window.Player;P.queueDownloads([{id:'saved',title:'Saved'}]);await flushMicrotasks(100);assert.equal(P.downloadStatus('saved'),'done');
 await P.deleteDownload('saved');assert.equal(P.queueDownloads([{id:'saved',title:'Saved'}]),1);await flushMicrotasks(100);assert.equal(fetches,2);
});
test('offline downloads remain persisted and resume when the network returns',async()=>{
 const h=createHarness({withStorage:true,storageDb:memoryDb()});let fetches=0;h.Api.fetchStreamBlob=async()=>{fetches++;return {size:1024};};
 h.navigator.onLine=false;const P=h.window.Player;P.queueDownloads([{id:'pending'}]);await flushMicrotasks(50);
 assert.equal(fetches,0);assert.equal(P.downloadStatus('pending'),'pending');assert(h.savedLocal.get('aura.downloadQueue').includes('pending'));
 h.navigator.onLine=true;h.window.dispatch('online');await flushMicrotasks(100);assert.equal(fetches,1);assert.equal(P.downloadStatus('pending'),'done');
});
test('a counted podcast play is stored with its media kind',()=>{
 const h=createHarness({tracks:[{id:'episode',title:'A subject',artist:'A Show',duration:180,kind:'podcast'}],exposeInternals:true});let saved=null;
 h.Store.pushRecent=(track,kind)=>{saved={track,kind};};h.play();const internals=h.window.__playerInternals;internals.resetListenTracking(h.window.Player.current());
 for(let i=0;i<60;i++){h.audio.currentTime++;h.audio.dispatch('timeupdate');}
 assert.equal(saved.kind,'podcast');assert.equal(saved.track.id,'episode');
});
test('a cellular connection holds queued downloads until wifi is permitted',async()=>{
 const h=createHarness({withStorage:true,storageDb:memoryDb(),settings:{wifiOnlyDownloads:true}});let fetches=0;h.Api.fetchStreamBlob=async()=>{fetches++;return {size:1024};};
 h.navigator.connection={type:'cellular'};h.window.Player.queueDownloads([{id:'wifi'}]);await flushMicrotasks(50);assert.equal(fetches,0);
 h.navigator.connection.type='wifi';h.window.dispatch('online');await flushMicrotasks(100);assert.equal(fetches,1);
});
test('stream error recovery restores the previous playback position',async()=>{
 const h=createHarness();h.Api.invalidate=()=>{};h.Api.resolve=async()=>({url:'https://test/replacement'});
 let src=h.audio.src;Object.defineProperty(h.audio,'src',{get:()=>src,set:value=>{src=value;h.audio.currentTime=0;}});
 h.play();h.audio.currentTime=90;h.audio.dispatch('error');await flushMicrotasks(40);h.runImmediateTimers();await flushMicrotasks(40);
 assert.equal(src,'https://test/replacement');assert.equal(h.audio.currentTime,90);
});
// The guards around deleteDownload rest on it actually reporting a failed delete rather
// than swallowing it, so the recovery paths and the menu know there is nothing to say.
test('a failed download delete is surfaced, not reported as removed',async()=>{
 const db=memoryDb();const real=db.transaction.bind(db);
 db.transaction=name=>{
  if(name!=='tracks')return real(name);
  const tx={objectStore:()=>({delete:()=>({})})};
  // Two hops, so the caller has attached its handlers before the transaction fails.
  Promise.resolve().then(()=>Promise.resolve().then(()=>{
   tx.error=new Error('delete refused');if(tx.onerror)tx.onerror();
  }));
  return tx;
 };
 const h=createHarness({withStorage:true,storageDb:db});
 await assert.rejects(h.window.Player.deleteDownload('gone'),/delete refused/);
});

test('a download waits for the storage transaction and rejects a late abort', async () => {
 const db = memoryDb();
 const real = db.transaction.bind(db);
 let write, remembered = 0;
 db.transaction = (name, mode) => {
  if (name !== 'tracks' || mode !== 'readwrite') return real(name, mode);
  const request = {};
  write = { objectStore: () => ({ put: () => request }) };
  Promise.resolve().then(() => { if (request.onsuccess) request.onsuccess(); });
  return write;
 };
 const h = createHarness({ withStorage: true, storageDb: db });
 h.Api.fetchStreamBlob = async () => ({ size: 1024 });
 h.Store.rememberDownload = () => remembered++;
 let settled = false;
 const downloading = h.window.Player.download({ id: 'saved' });
 downloading.then(() => { settled = true; }, () => { settled = true; });
 await flushMicrotasks(60);
 assert.equal(settled, false);
 assert.equal(remembered, 0);
 const rejected = assert.rejects(downloading, /storage aborted/);
 write.error = new Error('storage aborted');
 write.onabort();
 await rejected;
 assert.equal(remembered, 0);
});

test('unfinished downloads preserve podcast and artist verification metadata', async () => {
 const h = createHarness({ withStorage: true, storageDb: memoryDb() });
 h.navigator.onLine = false;
 h.window.Player.queueDownloads([{ id: 'episode', kind: 'podcast', podcast: 'A Show', artistVerified: true }]);
 await flushMicrotasks();
 const [saved] = JSON.parse(h.savedLocal.get('aura.downloadQueue'));
 assert.equal(saved.kind, 'podcast');
 assert.equal(saved.podcast, 'A Show');
 assert.equal(saved.artistVerified, true);
});

test('a prepared song blocked before transition is never played', async () => {
 const h = createHarness({ tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], withStorage: true,
  settings: { autoplay: false, noYtFallback: true } });
 h.Api.resolve = async id => ({ url: 'https://test/' + id });
 h.Api.getSkipSegments = async () => [];
 h.play();
 await flushMicrotasks(60);
 assert.equal(h.audioElements[1].src, 'https://test/b');
 h.Store.isBlocked = track => track && track.id === 'b';
 h.audio.currentTime = 180; h.audio.ended = true; h.audio.paused = true;
 h.audio.dispatch('ended');
 await flushMicrotasks(60);
 assert.equal(h.window.Player.current().id, 'c');
 assert.equal(h.audioElements[1].playCalls, 0);
 h.window.Player.dismiss();
});

test('replaying an ended song re-arms repeat handling', async () => {
 const h = createHarness({ settings: { autoplay: false } });
 const play = h.audio.play.bind(h.audio);
 h.audio.play = () => { if (h.audio.ended) { h.audio.currentTime = 0; h.audio.ended = false; } return play(); };
 h.play();
 const end = async () => {
  h.audio.currentTime = 180; h.audio.ended = true; h.audio.paused = true; h.audio.dispatch('ended');
  await flushMicrotasks(60);
 };
 await end();
 h.window.Player.cycleRepeat(); h.window.Player.cycleRepeat();
 h.play();
 await end();
 assert.equal(h.audio.paused, false);
 assert.equal(h.audio.playCalls, 3);
 h.window.Player.dismiss();
});

test('a source lookup counts as pending playback until explicitly paused', async () => {
 const h = createHarness({ withStorage: true });
 let resolve;
 h.Api.resolve = () => new Promise(r => { resolve = r; });
 h.window.Player.playQueue([{ id: 'waiting' }]);
 await flushMicrotasks(40);
 assert.equal(h.window.Player.playbackRequested(), true);
 h.window.Player.pause();
 assert.equal(h.window.Player.playbackRequested(), false);
 resolve({ url: 'https://test/waiting' });
 await flushMicrotasks(40);
 h.window.Player.dismiss();
});

test('manual retry gives a failed download its full retry allowance again', async () => {
 const h = createHarness({ withStorage: true, storageDb: memoryDb() });
 let calls = 0;
 h.Api.fetchStreamBlob = async () => { if (++calls <= 3) throw Error('temporary failure'); return { size: 1024 }; };
 h.window.Player.queueDownloads([{ id: 'retry' }]);
 await flushMicrotasks(100);
 assert.equal(h.window.Player.downloadStatus('retry'), 'failed');
 h.window.Player.queueDownloads([{ id: 'retry' }]);
 await flushMicrotasks(100);
 assert.equal(h.window.Player.downloadStatus('retry'), 'done');
 assert.equal(calls, 4);
});

test('losing the network does not pause a local audio file', async () => {
 const h = createHarness({ settings: { autoplay: false } });
 h.audio.src = 'blob:https://test/local-download';
 h.audio.buffered = { length: 0 };
 h.play();
 await flushMicrotasks(30);
 h.navigator.onLine = false;
 h.window.dispatch('offline');
 assert.equal(h.audio.paused, false);
 assert.equal(h.window.Player.playbackRequested(), true);
 h.window.Player.dismiss();
});

test('a Play action during a new lookup does not restart the previous song', async () => {
 const h = createHarness({ withStorage: true, settings: { autoplay: false, noYtFallback: true } });
 let resolve;
 h.Api.resolve = () => new Promise(r => { resolve = r; });
 h.Api.getSkipSegments = async () => [];
 h.window.Player.playQueue([{ id: 'new-song' }]);
 await flushMicrotasks(40);
 h.play();
 assert.equal(h.audio.playCalls, 0);
 resolve({ url: 'https://test/new-song' });
 await flushMicrotasks(60);
 assert.equal(h.audio.src, 'https://test/new-song');
 assert.equal(h.audio.paused, false);
 h.window.Player.dismiss();
});

test('clearing the audio cache waits for commit and reports storage failure', async () => {
 let write, settled = false;
 const db = memoryDb();
 const transaction = db.transaction.bind(db);
 db.transaction = (name, mode) => {
  if (name !== 'cache' || mode !== 'readwrite') return transaction(name, mode);
  const request = {};
  write = { objectStore: () => ({ clear: () => request }) };
  Promise.resolve().then(() => request.onsuccess?.());
  return write;
 };
 const h = createHarness({ withStorage: true, storageDb: db });
 const clearing = h.window.Player.clearCache();
 clearing.then(() => { settled = true; }, () => { settled = true; });
 await flushMicrotasks(40);
 assert.equal(settled, false);
 const rejected = assert.rejects(clearing, /storage aborted/);
 write.error = Error('storage aborted');
 write.onabort();
 await rejected;
});
