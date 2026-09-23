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
 let reloads=0;if(extra.player)window.Player=extra.player;
 vm.runInNewContext(readModule('sync'),{window,document,Store,fetch,console,Date:clockDate,Map,Set,JSON,Promise,TextEncoder,location:{reload(){reloads++;}},
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
