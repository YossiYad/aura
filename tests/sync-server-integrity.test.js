const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
function server(options = {}){
 let handler;const files=new Map();
 const fakeFs={mkdirSync(){},readFileSync:p=>{if(!files.has(p))throw Error('ENOENT');return files.get(p);},writeFileSync:(p,s)=>{if(options.failWrite)throw Error('disk full');files.set(p,s);},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlinkSync:p=>{if(options.failDelete)throw Error('permission denied');files.delete(p);},existsSync:p=>files.has(p)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../selfhost/private-app/sync/server.js'),'utf8'),{require:n=>n==='http'?{createServer:cb=>{handler=cb;return {listen(){}};}}:n==='fs'?fakeFs:require(n),process:{env:{SYNC_DATA_DIR:'/dummy'}},console:{log(){}},URL,Buffer,Date,Map,Promise,setTimeout});
 return (method,url,body,headers={})=>new Promise(resolve=>{const req=new EventEmitter();Object.assign(req,{method,url,headers:{'x-forwarded-email':'audit@example.test',...headers}});let code;handler(req,{writeHead:c=>code=c,end:s=>resolve({code,...JSON.parse(s)})});if(body)req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});
}
const backup=id=>({format:'aura-backup',version:1,data:{library:[{id}]}});
test('stale and legacy writes cannot replace another device data',async()=>{
 const req=server();const first=await req('PUT','/api/sync/',backup('a'),{'if-match':'0'});assert.equal(first.code,200);
 const second=await req('PUT','/api/sync/',backup('b'),{'if-match':String(first.stamp)});assert.equal(second.code,200);assert(second.stamp>first.stamp);
 assert.equal((await req('PUT','/api/sync/',backup('stale'),{'if-match':String(first.stamp)})).code,409);
 assert.equal((await req('PUT','/api/sync/',backup('legacy'))).code,428);
 assert.equal((await req('GET','/api/sync/')).data.data.library[0].id,'b');
});
test('deleting a conflict leaves the primary backup intact',async()=>{
 const req=server();await req('PUT','/api/sync/',backup('main'),{'if-match':'0'});const conflict=await req('PUT','/api/sync/conflict',backup('other'));
 assert.equal((await req('DELETE','/api/sync/conflict',null,{'if-match':String(conflict.stamp)})).code,200);
 assert.equal((await req('GET','/api/sync/')).data.data.library[0].id,'main');
 assert.equal((await req('GET','/api/sync/conflict')).code,404);
});
test('a stale recovery does not delete a newer conflict',async()=>{
 const req=server();const a=await req('PUT','/api/sync/conflict',backup('a'));
 assert.equal((await req('PUT','/api/sync/conflict',backup('b'),{'if-match':String(a.stamp)})).code,200);
 assert.equal((await req('DELETE','/api/sync/conflict',null,{'if-match':String(a.stamp)})).code,409);
});
test('a waiting conflict copy is not overwritten by another device',async()=>{
 const req=server();const a=await req('PUT','/api/sync/conflict',backup('a'));
 assert.equal((await req('PUT','/api/sync/conflict',backup('b'))).code,409);
 assert.equal((await req('GET','/api/sync/conflict')).data.data.library[0].id,'a');
 assert.equal((await req('PUT','/api/sync/conflict',backup('b'),{'if-match':String(a.stamp)})).code,200);
 assert.equal((await req('GET','/api/sync/conflict')).data.data.library[0].id,'b');
});
test('republish merges with contributions under the lock; targeted removal preserves others',async()=>{
 const req=server();const list=await req('POST','/api/sync/shared',{name:'List',tracks:[{id:'a'}]});const url='/api/sync/shared/'+list.id;
 await req('POST',url+'/tracks',{tracks:[{id:'b'}]});
 const merged=await req('PUT',url,{name:'Updated',tracks:[{id:'a'},{id:'c'}],merge:true});
 assert.deepEqual(merged.tracks.map(t=>t.id),['a','c','b']);
 const removed=await req('PUT',url,{removeIds:['a']});assert.deepEqual(removed.tracks.map(t=>t.id),['c','b']);
 assert.equal((await req('PUT',url,{name:'Legacy',tracks:[]})).code,428);
 assert.deepEqual((await req('GET',url)).tracks.map(t=>t.id),['c','b']);
});

test('shared playlists preserve podcast classification and artist verification', async () => {
 const req = server();
 const saved = await req('POST', '/api/sync/shared', { tracks: [
  { id: 'episode', kind: 'podcast', podcast: 'The Show', artistVerified: true }
 ] });
 assert.equal(saved.tracks[0].kind, 'podcast');
 assert.equal(saved.tracks[0].podcast, 'The Show');
 assert.equal(saved.tracks[0].artistVerified, true);
 assert.equal(saved.mine, true);
});

test('an overfull shared playlist append is rejected without partial additions', async () => {
 const req = server();
 const tracks = Array.from({ length: 599 }, (_, i) => ({ id: String(i) }));
 const list = await req('POST', '/api/sync/shared', { tracks });
 const url = '/api/sync/shared/' + list.id;
 assert.equal((await req('POST', url + '/tracks', { tracks: [{ id: 'new1' }, { id: 'new2' }] })).code, 413);
 assert.equal((await req('GET', url)).tracks.length, 599);
});

test('oversized shared playlist creation is rejected without silently cutting tracks', async () => {
 const req = server();
 const result = await req('POST', '/api/sync/shared', { tracks: Array.from({ length: 601 }, (_, i) => ({ id: String(i) })) });
 assert.equal(result.code, 413);
});

test('unknown sync routes cannot read or modify the personal backup', async () => {
 const req = server();
 await req('PUT', '/api/sync/', backup('main'), { 'if-match': '0' });
 assert.equal((await req('GET', '/api/sync/typo')).code, 404);
 assert.equal((await req('DELETE', '/api/sync/typo')).code, 404);
 assert.equal((await req('GET', '/api/sync/')).data.data.library[0].id, 'main');
});

test('failed shared writes return an error instead of leaving the request hanging', async () => {
 const req = server({ failWrite: true });
 const result = await Promise.race([
  req('POST', '/api/sync/shared', { tracks: [{ id: 'a' }] }),
  new Promise(resolve => setTimeout(() => resolve({ code: 'timeout' }), 100))
 ]);
 assert.equal(result.code, 500);
});

test('failed personal deletion is reported and keeps the stored copy', async () => {
 const options = {}, req = server(options);
 await req('PUT', '/api/sync/', backup('main'), { 'if-match': '0' });
 options.failDelete = true;
 assert.equal((await req('DELETE', '/api/sync/')).code, 500);
 assert.equal((await req('GET', '/api/sync/')).data.data.library[0].id, 'main');
});

test('a failed personal save reports failure and preserves the previous revision', async () => {
 const options = {}, req = server(options);
 const first = await req('PUT', '/api/sync/', backup('main'), { 'if-match': '0' });
 options.failWrite = true;
 assert.equal((await req('PUT', '/api/sync/', backup('new'), { 'if-match': String(first.stamp) })).code, 500);
 const saved = await req('GET', '/api/sync/');
 assert.equal(saved.stamp, first.stamp);
 assert.equal(saved.data.data.library[0].id, 'main');
});
