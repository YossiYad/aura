const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {createStore}=require('./store-harness');
const {FakeEventTarget,flushMicrotasks}=require('./harness');
const {readModule}=require('./source');
const backup=id=>({format:'aura-backup',version:1,data:{library:[{id}],playlists:[],liked:[],recents:[]}});
const response=body=>({ok:true,status:200,json:async()=>body});
function client(fetch,clock,extra={}){
 const {Store}=createStore();if(!extra.bare)Store.importData(backup('initial'));const window=new FakeEventTarget(),document=new FakeEventTarget();document.hidden=false;
 const state=new Map([['aura.syncState',JSON.stringify(extra.state||{stamp:10,dirty:false})]]);const timers=[];
 const time=clock||{value:Date.now()};const clockDate={now:()=>time.value};
 let reloads=0;if(extra.player)window.Player=extra.player;if(extra.views)window.Views=extra.views;
 vm.runInNewContext(readModule('sync'),{window,document,Store,fetch,console,Views:extra.views,Date:clockDate,Map,Set,JSON,Promise,TextEncoder,location:{reload(){reloads++;}},
 localStorage:{getItem:k=>state.get(k)||null,setItem:(k,v)=>state.set(k,v)},setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;}});
 window.Sync.init();
 // Timers are collected rather than run, so a test decides when the clock's work happens.
 const runTimers=()=>{const due=timers.splice(0);due.forEach(t=>{if(!t.cancelled)t.fn();});};
 return {Sync:window.Sync,Store,document,window,storage:state,state:()=>JSON.parse(state.get('aura.syncState')),timers,time,runTimers,reloads:()=>reloads};
}
test('an edit during PUT stays dirty after the earlier snapshot is acknowledged',async()=>{
 let finish;const requests=[];const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return new Promise(r=>finish=r);return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'a'});const syncing=c.Sync.pushNow();await flushMicrotasks(40);
 c.Store.addTrack({id:'b'});finish(response({stamp:11}));await syncing;
 assert.equal(c.state().dirty,true);const put=requests.find(x=>x.method==='PUT');assert.equal(put.headers['If-Match'],'10');
 assert(!JSON.parse(put.body).data.library.some(t=>t.id==='b'));
});
test('returning to a visible tab pulls newer remote data',async()=>{
 let stamp=10;let gets=0;const c=client(async()=>{gets++;return response({stamp,data:backup(stamp===10?'initial':'remote')});});
 await flushMicrotasks(40);stamp=20;c.time.value+=61000;c.document.dispatch('visibilitychange');await flushMicrotasks(40);
 assert(gets>=2);assert(c.Store.findTrack('remote'));assert.equal(c.state().stamp,20);
});
// Every app switch asking for the whole copy again is a phone's battery spent on nothing.
test('a glance at the screen inside the throttle window does not ask again',async()=>{
 let gets=0;const c=client(async()=>{gets++;return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);const afterInit=gets;
 c.time.value+=5000;c.document.dispatch('visibilitychange');await flushMicrotasks(40);
 c.time.value+=5000;c.document.dispatch('visibilitychange');await flushMicrotasks(40);
 assert.equal(gets,afterInit);
 c.time.value+=61000;c.window.dispatch('online');await flushMicrotasks(40);
 assert(gets>afterInit);
});
// A regained connection is a real reason to look now, throttle or not.
test('the network coming back pulls even inside the throttle window',async()=>{
 let gets=0;const c=client(async()=>{gets++;return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);const afterInit=gets;
 c.time.value+=1000;c.window.dispatch('online');await flushMicrotasks(40);
 assert(gets>afterInit);
});
test('a rejected stale PUT saves the local conflict before adopting remote data',async()=>{
 const requests=[];let mainGets=0;
 const c=client(async(url,opts={})=>{requests.push({url,...opts});
 if(opts.method==='PUT'&&url.endsWith('/conflict'))return response({stamp:21});
 if(opts.method==='PUT')return {ok:false,status:409,json:async()=>({stamp:20,data:backup('other-device')})};
 mainGets++;return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'mine'});await c.Sync.pushNow();
 const saved=requests.find(x=>x.url.endsWith('/conflict')&&x.method==='PUT');assert(saved);assert(JSON.parse(saved.body).data.library.some(t=>t.id==='mine'));
 assert(c.Store.findTrack('other-device'));assert.equal(c.Sync.describe().hasConflict,true);
});
test('conflict recovery does not DELETE if its conditional save is rejected',async()=>{
 const requests=[];
 const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return {ok:false,status:409};
 return response({stamp:url.endsWith('/conflict')?30:10,data:backup(url.endsWith('/conflict')?'recovered':'initial')});});
 await flushMicrotasks(40);await assert.rejects(c.Sync.recoverConflict(),/server save failed/);
 assert(c.Store.findTrack('recovered'));assert.equal(c.state().dirty,true);assert(!requests.some(r=>r.method==='DELETE'));
});

// Adopting another device's copy reloads the app, which mid-song would cut the music off.
test('adopting a remote copy waits for the music to stop before reloading',async()=>{
 let stamp=10;
 const player={playing:true,listeners:[],playbackRequested:()=>player.playing,isPaused:()=>!player.playing,
  onChange:fn=>player.listeners.push(fn)};
 const c=client(async()=>response({stamp,data:backup(stamp===10?'initial':'remote')}),null,{player});
 await flushMicrotasks(40);stamp=20;c.time.value+=61000;c.document.dispatch('visibilitychange');await flushMicrotasks(40);
 c.runTimers();
 assert(c.Store.findTrack('remote'));
 assert.equal(c.reloads(),0);
 player.playing=false;player.listeners.forEach(fn=>fn({type:'state'}));
 c.runTimers();
 assert.equal(c.reloads(),1);
});
// With nothing playing there is nothing to protect, so it reloads straight away.
test('adopting a remote copy reloads at once when nothing is playing',async()=>{
 let stamp=10;
 const player={playbackRequested:()=>false,isPaused:()=>true,onChange(){}};
 const c=client(async()=>response({stamp,data:backup(stamp===10?'initial':'remote')}),null,{player});
 await flushMicrotasks(40);stamp=20;c.time.value+=61000;c.document.dispatch('visibilitychange');await flushMicrotasks(40);
 c.runTimers();
 assert.equal(c.reloads(),1);
});

test('playback starting during the sync reload delay postpones the reload', async () => {
 let stamp = 10;
 const player = { playing: false, listeners: [], playbackRequested: () => player.playing,
  isPaused: () => !player.playing, onChange: fn => player.listeners.push(fn) };
 const c = client(async () => response({ stamp, data: backup(stamp === 10 ? 'initial' : 'remote') }), null, { player });
 await flushMicrotasks(40);
 stamp = 20;
 await c.Sync.pushNow();
 player.playing = true;
 c.runTimers();
 assert.equal(c.reloads(), 0);
 player.playing = false;
 player.listeners.forEach(fn => fn({ type: 'state' }));
 c.runTimers();
 assert.equal(c.reloads(), 1);
});

test('sync keepalive limits count UTF-8 bytes for Hebrew library data', async () => {
 const requests = [];
 const c = client(async (url, opts = {}) => {
  requests.push({ url, ...opts });
  return response(opts.method === 'PUT' ? { stamp: 11 } : { stamp: 10, data: backup('initial') });
 });
 await flushMicrotasks(40);
 c.Store.addTrack({ id: 'large', title: 'ש'.repeat(35000) });
 await c.Sync.pushNow();
 const put = requests.find(r => r.method === 'PUT');
 assert(put.body.length < 55000);
 assert(Buffer.byteLength(put.body) > 65536);
 assert.equal(put.keepalive, false);
 c.Store.addTrack({ id: 'another' });
 const beforeHide = requests.length;
 c.window.dispatch('pagehide');
 assert.equal(requests.length, beforeHide);
});

test('adopting remote data preserves metadata for downloads on this device', async () => {
 let stamp = 10;
 const remote = backup('remote');
 remote.data.downloads = { other: { id: 'other', title: 'Other device download' } };
 const c = client(async (url, opts = {}) => response(opts.method === 'PUT' ? { stamp: 21 } :
  { stamp, data: stamp === 10 ? backup('initial') : remote }));
 await flushMicrotasks(40);
 c.Store.rememberDownload({ id: 'local', title: 'Local episode', kind: 'podcast' });
 stamp = 20;
 await c.Sync.pushNow();
 assert(c.Store.findTrack('remote'));
 assert.deepEqual(Array.from(c.Store.downloadedTracks(), t => t.id), ['local']);
});

test('conflict recovery refuses to overwrite edits made while fetching its copy', { timeout: 1000 }, async () => {
 let release;
 const requests = [];
 const c = client(async (url, opts = {}) => {
  requests.push({ url, ...opts });
  if (url.endsWith('/conflict') && !opts.method) return new Promise(resolve => { release = resolve; });
  return response({ stamp: 10, data: backup('initial') });
 });
 await flushMicrotasks(40);
 const recovering = c.Sync.recoverConflict();
 await flushMicrotasks(20);
 c.Store.addTrack({ id: 'edited-while-waiting' });
 release(response({ stamp: 11, data: backup('recovered') }));
 await assert.rejects(recovering, /changed|changes/i);
 assert(c.Store.findTrack('edited-while-waiting'));
 assert(!requests.some(r => r.method === 'PUT' || r.method === 'DELETE'));
});

test('a null sync response is reported without attempting to replace server data', async () => {
 let malformed = false;
 const requests = [];
 const c = client(async (url, opts = {}) => {
  requests.push({ url, ...opts });
  return response(malformed ? null : { stamp: 10, data: backup('initial') });
 });
 await flushMicrotasks(40);
 malformed = true;
 await c.Sync.pushNow();
 assert.match(c.Sync.describe().error, /response/i);
 assert(c.Store.findTrack('initial'));
 assert(!requests.some(r => r.method === 'PUT'));
});

test('a rejected remote backup is exposed in sync status', async () => {
 let stamp = 10;
 const c = client(async () => response({ stamp, data: stamp === 10 ? backup('initial') : { format: 'broken' } }));
 await flushMicrotasks(40);
 let notices = 0;
 c.Sync.onChange(() => notices++);
 stamp = 20;
 await c.Sync.pushNow();
 assert.match(c.Sync.describe().error, /rejected|invalid/i);
 assert(notices > 0);
 assert.equal(c.state().stamp, 10);
 assert(c.Store.findTrack('initial'));
});

test('a clean device offers its copy when the server stamp went backwards',async()=>{
 const requests=[];const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return response({stamp:6});return response({stamp:5,data:backup('old-snapshot')});});
 await flushMicrotasks(40);
 const put=requests.find(x=>x.method==='PUT'&&!x.url.endsWith('/conflict'));
 assert(put,'the newer local copy is pushed rather than replaced');assert.equal(put.headers['If-Match'],'5');
 assert(c.Store.findTrack('initial'));assert(!c.Store.findTrack('old-snapshot'));
});

// Taking the server's stamp without its library let the next edit upload an empty
// library over the account's real one.
test('a fresh device marked dirty still brings the server library in',async()=>{
 const requests=[];const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return response({stamp:21});return response({stamp:20,data:backup('server-song')});},null,{bare:true,state:{stamp:0,dirty:true}});
 await flushMicrotasks(40);
 assert(c.Store.findTrack('server-song'),'the server library is imported');
 assert.equal(c.state().stamp,20);assert.equal(c.state().dirty,false);
 assert(!requests.some(x=>x.method==='PUT'),'an empty device leaves no conflict copy and uploads nothing');
});
// A keepalive upload on the way out moves the server stamp without this page hearing of it.
test("this device's own keepalive upload is not filed as a conflict",async()=>{
 const requests=[];let remote=null;
 const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return response({stamp:31});return response(remote||{stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'mine'});
 remote={stamp:30,data:JSON.parse(JSON.stringify(c.Store.exportData()))};
 c.time.value+=61000;c.window.dispatch('online');await flushMicrotasks(40);
 assert(!requests.some(x=>x.url.endsWith('/conflict')&&x.method==='PUT'),'identical data needs no conflict copy');
 assert.equal(c.state().stamp,30);assert.equal(c.state().dirty,false);assert.equal(c.reloads(),0);
});
// The server refuses to replace a waiting copy that is not named, this device's own included.
test('a conflict copy left mid-edit is named when it is replaced',async()=>{
 const requests=[];let c;let edited=false;
 c=client(async(url,opts={})=>{requests.push({url,...opts});
 if(opts.method==='PUT'&&url.endsWith('/conflict')){if(!edited){edited=true;c.Store.addTrack({id:'later'});return response({stamp:41});}return response({stamp:42});}
 if(opts.method==='PUT')return {ok:false,status:409,json:async()=>({stamp:20,data:backup('other-device')})};
 return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'mine'});await c.Sync.pushNow();
 assert(!c.Store.findTrack('other-device'),'edits that arrived during the copy are not replaced');
 await c.Sync.pushNow();
 const copies=requests.filter(x=>x.url.endsWith('/conflict')&&x.method==='PUT');
 assert.equal(copies.length,2);assert.equal(copies[0].headers['If-Match'],undefined);assert.equal(copies[1].headers['If-Match'],'41');
 assert(JSON.parse(copies[1].body).data.library.some(t=>t.id==='later'));assert(c.Store.findTrack('other-device'));
});
test('a shared playlist keeps its cached songs while its summary has not moved',async()=>{
 const record={id:'sp_1',name:'House',owner:'a@b',updatedAt:5,tracks:[{id:'s1',title:'One'},{id:'s2',title:'Two'}]};
 const summary={id:'sp_1',name:'House',owner:'a@b',mine:true,count:2,updatedAt:5};
 const c=client(async(url)=>{if(url.endsWith('/shared'))return response({playlists:[summary]});if(url.endsWith('/shared/sp_1'))return response(record);return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);await c.Sync.sharedList();await c.Sync.sharedOpen('sp_1');await c.Sync.sharedList();
 assert.equal(c.Sync.sharedCached('sp_1').tracks.length,2);
 summary.count=3;summary.updatedAt=6;await c.Sync.sharedList();
 assert.equal(c.Sync.sharedCached('sp_1').tracks,undefined,'a list that moved on is fetched again');
});
// With another device's copy already in the one conflict slot, this device keeps its own
// changes locally. Recovering the waiting copy then imported over them and emptied the slot,
// and they existed nowhere at all. They take the recovered copy's place in the slot instead.
test('recovering the waiting copy keeps this device\'s unsynced changes in the slot',async()=>{
 const library=d=>Array.from(d.data.library,t=>t.id);
 let main={stamp:10,data:backup('initial')},conflict=null;
 const c=client(async(url,opts={})=>{const isC=url.endsWith('/conflict'),m=opts.method||'GET';
  if(m==='PUT'){
   if(isC){if(conflict&&opts.headers['If-Match']!==String(conflict.stamp))return {ok:false,status:409,json:async()=>({hasConflict:true})};
    conflict={stamp:500,data:JSON.parse(opts.body)};return response({stamp:500});}
   if(opts.headers['If-Match']!==String(main.stamp))return {ok:false,status:409,json:async()=>({stamp:main.stamp,data:main.data,hasConflict:!!conflict})};
   main={stamp:main.stamp+1,data:JSON.parse(opts.body)};return response({stamp:main.stamp});}
  if(m==='DELETE'){if(isC)conflict=null;return response({ok:true});}
  if(isC)return conflict?response(conflict):{ok:false,status:404,json:async()=>({})};
  return response({stamp:main.stamp,data:main.data,hasConflict:!!conflict});});
 await flushMicrotasks(40);
 conflict={stamp:300,data:backup('from-other')};main={stamp:20,data:backup('from-third')};
 c.Store.addTrack({id:'only-here'});
 await c.Sync.pushNow();await flushMicrotasks(40);
 assert.equal(c.state().dirty,true,'the local change is kept while the slot is taken');
 await c.Sync.recoverConflict();
 assert.deepEqual(Array.from(c.Store.library(),t=>t.id),['from-other']);
 assert.deepEqual(library(main.data),['from-other']);
 assert(conflict&&library(conflict.data).includes('only-here'),'this device\'s change waits in the slot');
});
// The copy this device just left is its own. When the adopt after it failed, the next
// attempt could not name it, the server refused to replace it, and the device stayed dirty
// behind a notice claiming another device's changes were waiting.
test('a conflict copy stays replaceable when adopting after it fails',async()=>{
 const requests=[];let main={stamp:20,data:backup('other-device')},conflict=null;
 const c=client(async(url,opts={})=>{requests.push({url,...opts});const isC=url.endsWith('/conflict');
  if(opts.method==='PUT'&&isC){if(conflict&&opts.headers['If-Match']!==String(conflict.stamp))return {ok:false,status:409,json:async()=>({hasConflict:true})};
   conflict={stamp:(conflict?conflict.stamp:0)+100};return response({stamp:conflict.stamp});}
  if(opts.method==='PUT')return {ok:false,status:409,json:async()=>({stamp:main.stamp,data:main.data})};
  return response({stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'mine'});
 const importData=c.Store.importData;let fail=true;
 c.Store.importData=(...args)=>{if(fail)throw new Error('QuotaExceededError');return importData.apply(c.Store,args);};
 await c.Sync.pushNow();
 assert.equal(c.state().dirty,true);assert.equal(c.state().ownConflict,100);
 fail=false;await c.Sync.pushNow();
 const copies=requests.filter(x=>x.url.endsWith('/conflict')&&x.method==='PUT');
 assert.equal(copies.length,2);assert.equal(copies[1].headers['If-Match'],'100');
 assert(c.Store.findTrack('other-device'));assert.equal(c.state().dirty,false);
});
// The recovered copy went in over this device's unsynced changes before the server had
// them, so a save that failed on the way left those changes nowhere.
test('a failed recovery puts this device\'s unsynced changes back',async()=>{
 const requests=[];let main={stamp:20,data:backup('from-third')},conflict={stamp:300,data:backup('from-other')};
 const c=client(async(url,opts={})=>{requests.push({url,...opts});const isC=url.endsWith('/conflict'),m=opts.method||'GET';
  if(m==='PUT')return isC?response({stamp:500}):{ok:false,status:500,json:async()=>({})};
  if(m==='DELETE'){conflict=null;return response({ok:true});}
  return response(isC?conflict:{stamp:main.stamp,data:main.data,hasConflict:true});});
 await flushMicrotasks(40);
 c.Store.addTrack({id:'only-here'});await c.Sync.pushNow();await flushMicrotasks(40);
 await assert.rejects(c.Sync.recoverConflict(),/changes were kept/);
 assert(c.Store.findTrack('only-here'),'the unsynced change is back in the library');
 assert(!c.Store.findTrack('from-other'));assert.equal(c.state().dirty,true);
 assert(conflict,'the recovered copy still waits on the server');
 assert(!requests.some(r=>r.method==='PUT'&&r.url.endsWith('/conflict')),'nothing was filed over the recovered copy');
});
// A clean device that restores over a server copy it never saw replaces another device's
// changes and then empties the slot, so those changes would exist nowhere.
test('a clean device refuses to restore over a server copy it has not seen',async()=>{
 const requests=[];let main={stamp:10,data:backup('initial')};
 const c=client(async(url,opts={})=>{requests.push({url,...opts});
  return response(url.endsWith('/conflict')?{stamp:300,data:backup('from-other')}:{...main,hasConflict:true});});
 await flushMicrotasks(40);
 // Another device pushed after this one last synced.
 main={stamp:30,data:backup('newer')};
 await assert.rejects(c.Sync.recoverConflict(),/sync first/);
 assert(c.Store.findTrack('initial'));assert(!c.Store.findTrack('from-other'));assert.equal(c.state().stamp,10);
 assert(!requests.some(r=>r.method==='PUT'||r.method==='DELETE'));
});
// The keepalive copy was recognised by comparing the server data with the local data, so
// any local write before the next pull (a queue position, a resume point) made the device
// file its own newer data as a conflict and adopt its own older copy.
test('a keepalive upload followed by a local edit is still this device\'s own copy',async()=>{
 const requests=[];let remote=null;
 const c=client(async(url,opts={})=>{requests.push({url,...opts});if(opts.method==='PUT')return response({stamp:31});return response(remote||{stamp:10,data:backup('initial')});});
 await flushMicrotasks(40);c.Store.addTrack({id:'mine'});
 c.window.dispatch('pagehide');
 const sent=requests.find(x=>x.method==='PUT');assert(sent&&sent.keepalive,'the way out uploads');
 remote={stamp:30,data:JSON.parse(sent.body)};
 c.Store.addTrack({id:'later'});
 c.time.value+=61000;c.window.dispatch('online');await flushMicrotasks(40);
 assert(!requests.some(x=>x.url.endsWith('/conflict')&&x.method==='PUT'),'its own copy needs no conflict copy');
 assert(c.Store.findTrack('later'),'the later edit is kept');assert.equal(c.state().stamp,30);assert.equal(c.state().dirty,true);
 c.runTimers();await flushMicrotasks(40);
 assert(requests.some(x=>x.method==='PUT'&&x.headers['If-Match']==='30'),'the later edit is pushed on top of it');
 assert.equal(c.state().dirty,false);assert.equal(c.reloads(),0);
});
// With the one slot taken, every edit (a song counted as played, a queue move) uploaded the
// whole library twice to hear the same refusal, and put the same notice on the screen again.
function takenSlotServer(requests){
 const server={main:{stamp:10,data:backup('initial')},conflict:null};
 server.fetch=async(url,opts={})=>{const isC=url.endsWith('/conflict'),m=opts.method||'GET';requests.push({url,...opts,method:m});
  if(m==='PUT'){
   if(isC){if(server.conflict&&(opts.headers||{})['If-Match']!==String(server.conflict.stamp))return {ok:false,status:409,json:async()=>({stamp:server.conflict.stamp,hasConflict:true})};
    server.conflict={stamp:500,data:JSON.parse(opts.body)};return response({stamp:500});}
   if(opts.headers['If-Match']!==String(server.main.stamp))return {ok:false,status:409,json:async()=>({...server.main,hasConflict:!!server.conflict})};
   server.main={stamp:server.main.stamp+1,data:JSON.parse(opts.body)};return response({stamp:server.main.stamp});}
  if(m==='DELETE'){if(isC&&server.conflict&&opts.headers['If-Match']!==String(server.conflict.stamp))return {ok:false,status:409,json:async()=>({})};if(isC)server.conflict=null;return response({ok:true});}
  if(isC)return server.conflict?response(server.conflict):{ok:false,status:404,json:async()=>({})};
  return response({...server.main,hasConflict:!!server.conflict});};
 return server;
}
test('a taken conflict slot is not asked again on every edit, and says so once',async()=>{
 const requests=[],toasts=[];const server=takenSlotServer(requests);
 const c=client(server.fetch,null,{views:{toast:(msg,kind)=>toasts.push(msg)}});
 await flushMicrotasks(40);
 server.conflict={stamp:300,data:backup('from-other')};server.main={stamp:20,data:backup('from-third')};
 c.Store.addTrack({id:'a'});await c.Sync.pushNow();await flushMicrotasks(40);
 assert.equal(c.state().dirty,true);assert.equal(toasts.length,1);
 const puts=()=>requests.filter(r=>r.method==='PUT').length;const before=puts();
 c.Store.addTrack({id:'b'});c.runTimers();await flushMicrotasks(40);
 c.window.dispatch('pagehide');
 assert.equal(puts(),before,'an edit uploads nothing while the slot is taken');
 await c.Sync.pushNow();await flushMicrotasks(40);
 assert.equal(puts(),before,'a pull that finds the slot still taken asks nothing');
 assert.equal(toasts.length,1,'the notice is shown once');
 assert.match(c.Sync.describe().error,/recover or discard/);
 assert(c.Store.findTrack('b'),'this device keeps its changes');
});
test('discarding the waiting copy lets this device sync, keeping its changes in the slot',async()=>{
 const requests=[];const server=takenSlotServer(requests);
 const c=client(server.fetch,null,{views:{toast(){}}});
 await flushMicrotasks(40);
 server.conflict={stamp:300,data:backup('from-other')};server.main={stamp:20,data:backup('from-third')};
 c.Store.addTrack({id:'only-here'});await c.Sync.pushNow();await flushMicrotasks(40);
 await c.Sync.discardConflict();await flushMicrotasks(40);
 const del=requests.find(r=>r.method==='DELETE');assert.equal(del.headers['If-Match'],'300');
 assert(server.conflict&&server.conflict.data.data.library.some(t=>t.id==='only-here'),'this device\'s changes wait in the slot');
 assert(c.Store.findTrack('from-third'));assert.equal(c.state().dirty,false);assert.equal(c.state().conflictBlocked,undefined);
});
test('a slot emptied elsewhere is noticed on the next pull',async()=>{
 const requests=[];const server=takenSlotServer(requests);
 const c=client(server.fetch,null,{views:{toast(){}}});
 await flushMicrotasks(40);
 server.conflict={stamp:300,data:backup('from-other')};server.main={stamp:20,data:backup('from-third')};
 c.Store.addTrack({id:'only-here'});await c.Sync.pushNow();await flushMicrotasks(40);
 server.conflict=null;
 c.time.value+=61000;c.window.dispatch('online');await flushMicrotasks(60);
 assert(server.conflict&&server.conflict.data.data.library.some(t=>t.id==='only-here'));
 assert(c.Store.findTrack('from-third'));assert.equal(c.state().dirty,false);
});
