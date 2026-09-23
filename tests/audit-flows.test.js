const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {readModule,moduleScope}=require('./source');
function functions(file,names,context){
 const source=readModule(file);
 const code=names.map(name=>{const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(source);assert(match,name);return source.slice(match.index,source.indexOf('\n  }',match.index)+4);}).join('\n');
 vm.createContext(moduleScope(context));vm.runInContext(code,context);return context;
}
const ORB_STATES=['working','searching','solving','listening','connecting','weaving','composing','breathing','shaping'];
function askSteps(views){return vm.runInNewContext('('+/const ASK_STEPS = (\{[\s\S]*?\n  \});/.exec(views)[1]+')');}
// The voice button used to be a bare CSS ball, then an orb on a disc that opened a dialog.
// It is now the orb alone - nothing drawn around it, no icon inside it, no dialog behind
// it - and the orb, hidden from screen readers because the button already has a name, is
// what reports listening and looking things up. One short line sits under it.
test('the Ask orb floats free, holds nothing but itself, and reports what a request is doing',()=>{
 const views=readModule('views');
 const css=fs.readFileSync(require.resolve('../src/app.css'),'utf8');
 const steps=askSteps(views);
 const html=(state,voice)=>functions('src/views.js',['askHtml','askNote','voiceOrbState'],{tr:s=>s,askState:{prompt:'',tracks:[],error:'',...state},voice:voice||null,ASK_STEPS:steps,esc:s=>s}).askHtml();
 assert.match(html({status:'idle'}),/<button type="button" class="voice-orb" id="ask-voice" aria-pressed="false" aria-label="[^"]+"><thinking-orb id="ask-orb" state="breathing" px="160" aria-hidden="true"><\/thinking-orb><\/button><p id="ask-note" role="status" dir="auto">[^<]{1,24}<\/p><\/div>/);
 const busy=html({status:'loading',step:'matching'});
 assert.match(busy,/id="ask-voice" aria-pressed="false" aria-label="[^"]+" disabled><thinking-orb id="ask-orb" state="searching" px="160" aria-hidden="true"><\/thinking-orb><\/button>/);
 assert.match(busy,/<button class="btn primary" id="ask-go" disabled><thinking-orb id="ask-go-orb" state="searching" size="20" theme="light" aria-hidden="true"><\/thinking-orb> Thinking…<\/button>/);
 assert.match(busy,/<p id="ask-note" role="status" dir="auto">Finding the songs…<\/p>/);
 const hearing=html({status:'idle'},{recording:true,hearing:true,status:'מקשיב…'});
 assert.match(hearing,/class="voice-orb listening" id="ask-voice" aria-pressed="true"/);
 assert.match(hearing,/<thinking-orb id="ask-orb" state="listening"/);
 assert.match(hearing,/<p id="ask-note" role="status" dir="auto">מקשיב…<\/p>/);
 const states=voice=>functions('src/views.js',['voiceOrbState'],{voice}).voiceOrbState();
 assert.deepEqual([null,{recording:true},{recording:true,hearing:true},{recording:true,finishing:true},{busy:true}].map(states),['breathing','connecting','listening','working','searching']);
 // Nothing is drawn around the orb, and a live microphone is a glow with no edge.
 assert.match(css,/\.voice-orb \{[^}]*border: 0;[^}]*background: none;/);
 assert.match(css,/\.voice-orb\.listening::before \{ opacity: 1;/);
 assert.doesNotMatch(css,/\.voice-orb[^{]*\{[^}]*border(-color)?: (1|2)px/);
 // An orb asked for a state it does not know quietly draws "working" instead.
 for(const [name,step] of Object.entries(steps))assert.ok(ORB_STATES.includes(step[0]),name+' names the orb state '+step[0]);
});
test('a spoken request has no dialog: it runs on the Ask screen, and driving mode draws it on its own layer',()=>{
 const views=readModule('views');
 const css=fs.readFileSync(require.resolve('../src/app.css'),'utf8');
 const main=readModule('main');
 const page=fs.readFileSync(require.resolve('../index.html'),'utf8');
 assert.doesNotMatch(views,/openVoiceRequest|voice-request|voice-text|voice-go|voice-cancel|voice-listen/);
 assert.doesNotMatch(css,/voice-request|voice-open|voice-listen/);
 // The views module is split into files that reach each other through V (window.Aura.views).
 assert.match(views,/if \(mic\) mic\.onclick = \(\) => (?:V\.)?voiceStart\("ask"\);/);
 assert.match(views,/if \(mic\) mic\.onclick = \(\) => \{ Views\.showTab\("ai"\); voiceStart\("ask"\); \};/,'the search microphone goes to the Ask screen');
 assert.match(views,/if \((?:V\.)?voice && (?:V\.)?voice\.surface === "ask" && \((?:V\.)?currentTab !== "ai" \|\| (?:V\.)?subView\)\) (?:V\.)?voiceEnd\(\);/,'leaving the Ask screen ends its request');
 assert.match(main,/\$\("drive-voice"\)\.onclick = \(\) => Views\.startVoice\("drive"\);/);
 assert.match(main,/\$\("drive-voice-layer"\)\.onclick = \(\) => Views\.stopVoice\(\);/);
 assert.match(page,/<div class="drive-voice-layer" id="drive-voice-layer" dir="rtl" hidden>\s*<thinking-orb id="drive-voice-orb"[^>]*aria-hidden="true"><\/thinking-orb>\s*<p class="drive-voice-status" id="drive-voice-status" role="status"><\/p>/);
 // What the dialog used to ask each time now lives in Settings.
 assert.match(views,/segControl\("set-voice-lang", \[\["he-IL", "עברית"\], \["en-US", "English"\]\]/);
 assert.match(views,/toggleRow\("set-voice-reply", "Spoken replies"/);
});
test('typed words are an order to play only when they say so themselves',()=>{
 const c=functions('src/voice.js',['isCommand','playbackRequest','clean','requestStart'],{});
 for(const text of ['play Yellow by Coldplay','please play something calm','תשים לי ואיך בשמיים של אייל גולן','שים את הפלייליסט נסיעה','תנגן שירים של עידן רייכל','Yellow by Coldplay next','תוסיף את ואיך בשמיים לסוף התור','queue Bohemian Rhapsody'])assert.equal(c.isCommand(text),true,text);
 for(const text of ['Something calm for studying','2000s pop-rock for a road trip','playlist for a long drive','music from the 80s','songs by Coldplay and bands like them','משהו רגוע ללימודים','פלייליסט לריצה','Next to Me','playful indie'])assert.equal(c.isCommand(text),false,text);
});
test('one field serves both kinds of asking',()=>{
 const run=(state,voice,text,command)=>{
  const calls=[];
  const c=functions('src/views.js',['submitAsk'],{askState:{status:'idle',spoken:false,prompt:'',...state},voice,Voice:{isCommand:()=>!!command},
   Player:{primeForPlayback:()=>calls.push('prime')},
   voiceFinish:()=>calls.push('finish'),voiceRun:()=>calls.push('play'),voiceEnd:()=>calls.push('end'),runAsk:(ask,retry)=>calls.push('build:'+ask+':'+retry),String});
  c.submitAsk(text);return {calls,prompt:c.askState.prompt};
 };
 assert.deepEqual(run({},null,'  something calm for studying ').calls,['end','build:something calm for studying:false'],'a description builds a playlist');
 // A typed order primes the element for playback inside this tap, then plays; the build
 // path and an open microphone never prime (the mic must stay clear on iOS).
 assert.deepEqual(run({},null,'play Yellow',true).calls,['prime','play'],'an order primes then plays');
 assert.deepEqual(run({spoken:true},null,'Yellow by Coldplay').calls,['prime','play'],'words from the microphone stay a request to play, corrected or not');
 assert.deepEqual(run({},{recording:true},'half a sentence').calls,['finish'],'an open microphone is given its last words first');
 assert.deepEqual(run({status:'loading'},null,'again').calls,[],'one request at a time');
 assert.deepEqual(run({},{busy:true},'again').calls,[]);
 assert.deepEqual(run({},null,'   ').calls,[]);
 assert.equal(run({},null,' play Yellow ',true).prompt,'play Yellow');
});
test('an AI request reports each step through the orb without repainting the text field',async()=>{
 const views=readModule('views');
 const nodes={'ask-orb':{setAttribute(k,v){this[k]=v;}},'ask-go-orb':{setAttribute(k,v){this[k]=v;}},'ask-note':{}};
 const seen=[];let paints=0;
 const c=functions('src/views.js',['runAsk','fetchAndMatch','askStep','paintAskOrb','askNote','voiceOrbState'],{tr:s=>s,askState:{prompt:'',status:'idle',step:'',error:'',name:'',tracks:[],notFound:0},ASK_STEPS:askSteps(views),voice:null,
  document:{getElementById:id=>nodes[id]||null},window:{Ai:true},paintAsk:()=>{paints++;},askHistoryContext:()=>'',blockedAvoidLabels:()=>[],inTasteWorld:()=>true,
  getTasteAnchor:async()=>{seen.push(c.askState.step+':'+c.askState.status);return null;},
  Ai:{hasAnyKey:()=>true,generatePlaylist:async()=>{seen.push(nodes['ask-orb'].state+'/'+nodes['ask-go-orb'].state+' '+nodes['ask-note'].textContent);return {name:'Mix',tracks:[1,2,3,4,5].map(i=>({title:'Song '+i,artist:'Artist'}))};}},
  Api:{matchTrack:async title=>{seen.push(nodes['ask-orb'].state+' '+nodes['ask-note'].textContent);return {id:title,title,artist:'Artist',duration:200};},looksLikeMusic:()=>true},
  Store:{isBlocked:()=>false},Set,Promise,Array,Math,String});
 await c.runAsk('five songs',false);
 assert.deepEqual(Array.from(new Set(seen)),['taste:loading','composing/composing Writing the playlist…','searching Finding the songs…']);
 assert.equal(c.askState.status,'done');
 assert.equal(paints,2,'painted when the request starts and when it ends, never for a step');
});
test('voice song matching defaults to official releases and rejects marked covers',()=>{
 const c=functions('src/api.js',['normMatch','matchTokens','coverage','hasWord','scoreMatch','voiceMatchCandidates'],{
  OTHER_VERSION:['live','cover','remix','karaoke'],MATCH_STOPWORDS:['official','video','audio','music','the','a']
 });
 const original={id:'original',title:'Song (Official Audio)',artist:'Original Artist - Topic'};
 const cover={id:'cover',title:'Song cover',artist:'Cover Singer - Topic',views:100000000};
 const karaoke={id:'karaoke',title:'Song karaoke',artist:'Original Artist - Topic'};
 assert.deepEqual(Array.from(c.voiceMatchCandidates([cover,karaoke,original],'Song',''),t=>t.id),['original']);
 assert.equal(c.voiceMatchCandidates([cover,karaoke],'Song','').length,0);
});
test('an explicit singer can request their cover but never another singers version',()=>{
 const c=functions('src/api.js',['normMatch','matchTokens','coverage','hasWord','scoreMatch','voiceMatchCandidates'],{
  OTHER_VERSION:['live','cover','remix','karaoke'],MATCH_STOPWORDS:['official','video','audio','music','the','a']
 });
 const original={id:'original',title:'Song (Official Audio)',artist:'Original Artist - Topic'};
 const cover={id:'cover',title:'Song cover',artist:'Cover Singer - Topic'};
 assert.deepEqual(Array.from(c.voiceMatchCandidates([original,cover],'Song','Cover Singer'),t=>t.id),['cover']);
 assert.deepEqual(Array.from(c.voiceMatchCandidates([original,cover],'Song','Original Artist'),t=>t.id),['original']);
});
test('multiple plausible performers need interpretation instead of ranking by popularity',()=>{
 const c=functions('src/api.js',['normMatch','matchTokens','coverage','hasWord','scoreMatch','voiceMatchCandidates'],{
  OTHER_VERSION:['cover'],MATCH_STOPWORDS:['official','audio']
 });
 const tracks=[{title:'Song',artist:'Singer A - Topic'},{title:'Song',artist:'Singer B - Topic'}];
 assert.equal(c.voiceMatchCandidates(tracks,'Song','').length,0);
});
test('collection sorting uses saved dates without changing the store order',()=>{
 const {Store}=require('./store-harness').createStore();
 const c=functions('src/views.js',['sortCollections','collectionAddedAt'],{Store});
 const entries=[{name:'A',createdAt:10},{name:'Z',tracks:[{addedAt:30},{addedAt:5}]},{name:'M',followedAt:20}];
 assert.deepEqual(Array.from(c.sortCollections(entries),x=>x.name),['Z','M','A']);
 assert.deepEqual(entries.map(x=>x.name),['A','Z','M']);
 Store.patchSettings({librarySort:'name'});
 assert.deepEqual(Array.from(c.sortCollections(entries),x=>x.name),['A','M','Z']);
 Store.patchSettings({librarySort:'unexpected'});
 assert.equal(c.sortCollections(entries)[0],entries[1]);
});
test('library includes followed artists once and keeps podcasts in their own filter',()=>{
 const {Store}=require('./store-harness').createStore({
  'aura.library':[{id:'song',artist:'The Artist',title:'Song'}],
  'aura.follows':[{id:'UCartist',name:'The Artist',kind:'artist'},{id:'UCshow',name:'The Show',kind:'podcast'}]
 });
 const c=functions('src/views.js',['libraryArtistsHtml','libraryPodcastsHtml','sortCollections','collectionAddedAt'],{
  Store,libraryQuery:'',followCard:a=>'FOLLOW:'+a.id,gridCard:()=> 'LOCAL',emptyState:()=> 'EMPTY'
 });
 assert.equal(c.libraryArtistsHtml(),'<div class="grid artists">FOLLOW:UCartist</div>');
 assert.equal(c.libraryPodcastsHtml(),'<div class="grid podcasts">FOLLOW:UCshow</div>');
 c.libraryQuery='missing';assert.match(c.libraryPodcastsHtml(),/No podcasts found/);
});
test('library bulk playback and downloads use the same visible unblocked tracks',()=>{
 const {Store}=require('./store-harness').createStore({'aura.library':[{id:'a',title:'Song A'},{id:'b',title:'Song B'},{id:'c',title:'Different'}]});
 Store.blockTrack(Store.findTrack('a'));
 const nodes={'play-all':{},'shuffle-all':{},'download-all':{}};
 let played,downloaded;const c=functions('src/views.js',['wireSongsHandlers'],{
  Store,libraryQuery:'Song',document:{getElementById:id=>nodes[id]},
  Player:{playQueue:tracks=>played=tracks,setShuffle(){}},downloadAll:tracks=>downloaded=tracks
 });
 c.wireSongsHandlers();nodes['play-all'].onclick();assert.deepEqual(Array.from(played,t=>t.id),['b']);
 nodes['shuffle-all'].onclick();assert.deepEqual(Array.from(played,t=>t.id),['b']);
 nodes['download-all'].onclick();assert.deepEqual(Array.from(downloaded,t=>t.id),['b']);
});
test('home long press uses the visible filtered song',()=>{
 const a={id:'a'},b={id:'b'};const c=functions('src/views.js',['trackForElement'],{homeFeeds:{x:{sections:[{tracks:[a,b]}]}},homeFeedRenderedKey:'x',unblocked:xs=>xs.filter(t=>t.id!=='a')});
 const el={dataset:{homeFeedSection:'0',homeFeedTrack:'0'},closest:()=>el};assert.equal(c.trackForElement(el),b);
});
test('a pending home row retains its original filter',async()=>{
 let resolve;const c=functions('src/views.js',['searchedRow'],{homeFilter:'music',categorySearch:()=>new Promise(r=>resolve=r),Store:{isBlocked:()=>false},Api:{looksLikeMusic:t=>t.kind==='music',looksLikePodcast:t=>t.kind==='podcast'}});
 const pending=c.searchedRow({query:'mix'});c.homeFilter='podcasts';resolve({items:[{id:'music',kind:'music',duration:100},{id:'podcast',kind:'podcast',duration:100}]});
 assert.deepEqual(Array.from(await pending,t=>t.id),['music']);
});
test('podcast pool retains known channel IDs',()=>{
 const c=functions('src/views.js',['podcastShowPool'],{Store:{foldText:s=>s,followsList:()=>[{kind:'podcast',name:'Followed',id:'UC1'}],topListeningPodcasts:()=>[],podcastShowsList:()=>[{name:'Saved',channelId:'UC2'}]},PODCAST_SEEDS:{en:[]},listenerLanguage:()=> 'en'});
 assert.deepEqual(Array.from(c.podcastShowPool(),s=>s.channelId),['UC1','UC2']);
});
test('podcasts already heard are promoted ahead of generic suggestions',()=>{
 const c=functions('src/views.js',['podcastShowPool','podcastShowsForRows'],{Store:{foldText:s=>s,followsList:()=>[],topListeningPodcasts:()=>[{name:'Heard',channel:'Publisher',channelId:'UC1'}],podcastShowsList:()=>[{name:'Suggested'}]},PODCAST_SEEDS:{en:[]},listenerLanguage:()=> 'en',Date:{now:()=>0}});
 assert.equal(c.podcastShowsForRows(1)[0].name,'Heard');
});
test('a dominant channel of songs is not accepted as a podcast show',()=>{
 let notes=0;const c=functions('src/views.js',['byNewest','showEpisodes'],{Map,Store:{matchesQuery:(q,title)=>title.includes(q),notePodcastChannel:()=>notes++},Api:{looksLikePodcast:()=>false}});
 const items=Array.from({length:6},(_,i)=>({id:String(i),title:'Song '+i,artist:'Same Name',duration:200}));
 assert.equal(c.showEpisodes({title:'Same Name'},items).length,0);assert.equal(notes,0);
});
test('a network podcast row keeps only episodes carrying the show name',()=>{
 const c=functions('src/views.js',['byNewest','showEpisodes'],{Map,Store:{matchesQuery:(q,title)=>title.includes(q),notePodcastChannel(){}},Api:{looksLikePodcast:()=>false}});
 const items=[0,1,2].map(i=>({id:'ep'+i,title:'The Show '+i,artist:'Network',duration:1200})).concat([0,1,2].map(i=>({id:'other'+i,title:'Other programme '+i,artist:'Network',duration:1200})));
 assert.deepEqual(Array.from(c.showEpisodes({title:'The Show'},items),t=>t.id),['ep0','ep1','ep2']);
});
test('stats tracks can be resolved without a library or recent entry',()=>{
 const track={id:'old'};const c=functions('src/views.js',['trackById'],{Store:{findTrack:()=>null,recents:()=>[],topListeningTracks:()=>[track]},currentResultList:()=>[],Player:{queue:()=>[]},homeDownloads:{items:[]}});assert.equal(c.trackById('old'),track);
});
test('an AI request in progress cannot be submitted again',async()=>{
 const c=functions('src/views.js',['runAsk'],{askState:{status:'loading'}});await c.runAsk('Second request',false);
});
test('a keyless device does not revoke the account key',async()=>{
 let deletes=0;const c=functions('src/views.js',['syncServerMixKey'],{serverMixSyncing:false,serverMixWanted:()=>true,Ai:{hasAnyKey:()=>false},serverMixForgetKey:async()=>deletes++,window:{}});
 await c.syncServerMixKey({ownKey:true});assert.equal(deletes,0);
});
test('push registration errors preserve an existing local subscription',async()=>{
 let removed=0;const c=functions('src/push.js',['enable','sameServerKey'],{supported:()=>true,Notification:{requestPermission:async()=> 'granted'},checkBackend:async()=>true,
 navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>({toJSON:()=>({}),unsubscribe:async()=>removed++})}})}},SUB_ENDPOINT:'/subscribe',fetch:async()=>({ok:false,status:500}),log(){}});
 await assert.rejects(c.enable(),/register notifications/);assert.equal(removed,0);
});
test('a Groq response body remains inside the request deadline',async()=>{
 let timer,cleared=false,signal;const c=functions('src/ai.js',['callGroq'],{AbortController,setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>cleared=true,log(){},extractError:()=>new Error('timed out'),
 fetch:async(url,opts)=>{signal=opts.signal;return {ok:true,status:200,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))};}});
 const request=c.callGroq('dummy','dummy','dummy');for(let i=0;i<20;i++)await Promise.resolve();assert.equal(cleared,false);timer();await assert.rejects(request,/timed out/);assert.equal(cleared,true);
});
test('SponsorBlock transport failure is retried instead of cached as empty',async()=>{
 let calls=0;const c=functions('src/api.js',['getSkipSegments'],{segmentCache:new Map(),SKIP_CATEGORIES:['sponsor'],Store:{},fetchJson:async()=>{if(++calls===1)throw Object.assign(new Error('offline'),{status:503});return [{segment:[1,4],category:'sponsor'}];}});
 assert.equal((await c.getSkipSegments('song')).length,0);assert.equal((await c.getSkipSegments('song')).length,1);assert.equal(calls,2);
});
test('playlist import loads all Piped pages and deduplicates overlapping tracks',async()=>{
 const urls=[];const c=functions('src/api.js',['playlistFromSource'],{normPiped:x=>x,normInvidious:x=>x,fetchJson:async url=>{urls.push(url);return urls.length===1?{name:'List',relatedStreams:[{id:'a'}],nextpage:'cursor x'}:{relatedStreams:[{id:'a'},{id:'b'}],nextpage:null};}});
 const out=await c.playlistFromSource('https://test','piped','PL1');assert.deepEqual(Array.from(out.tracks,t=>t.id),['a','b']);assert(urls[1].includes('nextpage=cursor%20x'));
});
test('playlist import follows Invidious page numbers',async()=>{
 const urls=[];const c=functions('src/api.js',['playlistFromSource'],{normPiped:x=>x,normInvidious:x=>x,fetchJson:async url=>{urls.push(url);return {title:'List',videoCount:2,videos:[{id:urls.length===1?'a':'b'}]};}});
 assert.equal((await c.playlistFromSource('https://test','invidious','PL1')).tracks.length,2);assert(urls[1].endsWith('?page=2'));
});
test('a later playlist page failure is not returned as a complete import',async()=>{
 let calls=0;const c=functions('src/api.js',['playlistFromSource'],{normPiped:x=>x,normInvidious:x=>x,fetchJson:async()=>{if(++calls>1)throw Error('offline');return {relatedStreams:[{id:'a'}],nextpage:'next'};}});
 await assert.rejects(c.playlistFromSource('https://test','piped','PL1'),/offline/);
});
test('artist continuation uses the channel endpoint, not global search',async()=>{
 let url;const c=functions('src/api.js',['artistMore'],{normPiped:x=>x,normInvidious:x=>x,fetchJson:async u=>{url=u;return {videos:[{id:'older'}],continuation:'next'};}});
 const out=await c.artistMore({kind:'invidious',base:'https://test',channelId:'UC1',nextpage:'cursor'});assert(url.endsWith('/channels/UC1/videos?continuation=cursor'));assert.equal(out.items[0].id,'older');assert.equal(out.nextpage,'next');
});
test('closing an import modal cancels the pending import without saving a new playlist',async()=>{
 let resolve,saves=0;const nodes={};for(const id of ['import-url','import-status','import-go','import-cancel','import-target'])nodes[id]={value:'',focus(){},addEventListener(){}};
 nodes['import-url'].value='https://test/list';const c=functions('src/views.js',['openImportModal','closeModal'],{openModal(){},modalCleanup:null,modalEl:{},scrimEl:{},document:{getElementById:id=>nodes[id]},
 Store:{playlists:()=>[],createPlaylist:()=>{saves++;return {id:'new'};},isBlocked:()=>false},Api:{importPlaylist:()=>new Promise(r=>resolve=r)},esc:x=>x,dismissViaHistory:fn=>fn(),toast(){},render(){}});
 c.openImportModal();const importing=nodes['import-go'].onclick();c.closeModal();delete nodes['import-target'];resolve({name:'Imported',tracks:[{match:{id:'a'}}]});await importing;assert.equal(saves,0);
});
test('failed load-more sets a retry state without discarding the continuation',async()=>{
 const state={items:[],nextpage:'page2'};const c=functions('src/views.js',['loadMore'],{discoverState:state,currentTab:'search',subView:null,render(){},Api:{searchMore:async()=>{throw Error('offline');}},toast(){}});
 await c.loadMore();assert.equal(state.moreError,true);assert.equal(state.loadingMore,false);assert.equal(state.nextpage,'page2');
});
test('cold notification launch includes the artist ID',async()=>{
 const handlers={};let url,done;vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{self:{addEventListener:(name,fn)=>handlers[name]=fn},clients:{matchAll:async()=>[],openWindow:async u=>url=u}});
 handlers.notificationclick({notification:{close(){},data:{artistId:'UC/one'}},waitUntil:p=>done=p});await done;assert.equal(url,'./index.html?artist=UC%2Fone');
});
test('the push server excludes accounts that disabled release alerts',()=>{
 const src=fs.readFileSync(require.resolve('../selfhost/private-app/push/server.js'),'utf8');const at=src.indexOf('function listFollowers()');const code=src.slice(at,src.indexOf('\n}',at)+2);
 const ctx={fs:{readdirSync:()=>['enabled.json','disabled.json']},SYNC_DIR:'/data',path:require('node:path'),readJson:file=>({data:{data:{follows:[{id:'UC1'}],settings:{notifyNewReleases:!file.includes('disabled')}}}})};
 vm.createContext(ctx);vm.runInContext(code,ctx);assert.deepEqual(Array.from(ctx.listFollowers().keys()),['enabled']);
});
function nginxAllows(){
 const source=fs.readFileSync(require.resolve('../selfhost/private-app/nginx.conf'),'utf8');
 const patterns=Array.from(source.matchAll(/location ~\*? (.+?) \{\n([\s\S]*?)\n    \}/g),m=>({pattern:new RegExp(m[1],m[0].startsWith('location ~*')?'i':''),allowed:m[2].includes('try_files')}));
 const allowed=path=>{const rule=patterns.find(r=>r.pattern.test(path));return rule?rule.allowed:false;};
 return {source,allowed};
}
test('nginx allows only published client assets and denies server files',()=>{
 const {source,allowed}=nginxAllows();
 for(const path of ['/selfhost/private-app/oauth.env','/selfhost/private-app/ai.env','/selfhost/private-app/authenticated-emails.txt','/.git/config','/deploy/cobalt-hf/cookies-converter.html','/README.md'])assert.equal(allowed(path),false,path);
 for(const path of ['/index.html','/config.json','/app-revision.txt','/src/main.js','/src/views.js','/sw.js','/icon-180.png'])assert.equal(allowed(path),true,path);
 // A module split into smaller files is served without another edit to the rule...
 for(const path of ['/src/views/home.js','/src/player/downloads.js','/src/app.css'])assert.equal(allowed(path),true,path);
 // ...but only scripts and stylesheets, and no deeper than one folder.
 for(const path of ['/src/globals.d.ts','/jsconfig.json','/src/views/home.js.map','/src/a/b/c.js','/src/../selfhost/private-app/ai.env','/src/.env','/src/views/.hidden.js'])assert.equal(allowed(path),false,path);
 assert(source.includes('location / { return 404; }'));
});
// src/progress.js and src/progress.css joined the pages and the shell without joining the
// allowlist. They answered 404 on the self-hosted server, so no new service worker could
// install, and main.js stopped at its first SongProgress call: no view, no accent, no player.
test('nginx serves every file the shell, the phone page, the TV page and the manifest load',()=>{
 const {source,allowed}=nginxAllows();
 const read=file=>fs.readFileSync(require.resolve('../'+file),'utf8');
 const local=(page,html)=>Array.from(html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/g),m=>m[1])
  .filter(ref=>!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)).map(ref=>new URL(ref,'https://app.test/'+page).pathname);
 const shell=Array.from(read('sw.js').match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g),m=>new URL(m[1],'https://app.test/').pathname);
 const manifest=JSON.parse(read('manifest.json'));
 const icons=manifest.icons.concat(...(manifest.shortcuts||[]).map(s=>s.icons||[])).map(icon=>new URL(icon.src,'https://app.test/manifest.json').pathname);
 const wanted=new Set([...shell,...local('index.html',read('index.html')),...local('tv/index.html',read('tv/index.html')),...icons]);
 assert(wanted.has('/src/progress.js')&&wanted.has('/src/progress.css')&&wanted.has('/tv/receiver.js')&&wanted.has('/icons/shortcut-ai.png'),'the pages were not read');
 for(const path of wanted){
  if(path==='/')assert.match(source,/location = \/ \{\n\s*try_files \/index\.html =404;/,'the root document');
  else assert.equal(allowed(path),true,path+' is loaded by the app but missing from the nginx allowlist');
 }
});

test('a download lookup for a closed track menu cannot modify the next menu', async () => {
 const pending = new Map();
 let button;
 const sheetEl = { hidden: false, querySelector: () => button };
 const c = functions('src/views.js', ['openTrackMenu'], {
  Store: { isLiked: () => false, findTrack: () => null },
  openSheet() { button = { dataset: { act: 'dl' } }; },
  sheetEl, sheetItem: () => '', artHtml: () => '', esc: x => x, IC: {},
  syncRemoteMenu() {},
  Player: { current: () => null, getDownload: id => new Promise(resolve => pending.set(id, resolve)) }
 });
 c.openTrackMenu({ id: 'saved', title: 'Saved' });
 c.openTrackMenu({ id: 'unsaved', title: 'Unsaved' });
 pending.get('saved')({ size: 1000 });
 await Promise.resolve();
 assert.equal(button.dataset.act, 'dl');
 pending.get('unsaved')(null);
 await Promise.resolve();
});

test('downloads enforce the byte limit when streaming readers are unavailable', async () => {
 const c = functions('src/api.js', ['fetchStreamBlob'], {
  AbortController, Blob, Date, Promise, Set, setInterval: () => 1, clearInterval() {},
  STALL_MS: 30000, CORS_PROXIES: [], log() {}, host: x => x, invalidate() {},
  resolve: async () => ({ url: 'https://test/audio', mime: 'audio/mp4' }),
  fetch: async () => ({ ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array(200000)]) })
 });
 await assert.rejects(c.fetchStreamBlob('a', 150000), /too large/);
});

test('a successful HTTP login page is not saved as an audio download', async () => {
 const c = functions('src/api.js', ['fetchStreamBlob'], {
  AbortController, Blob, Date, Promise, Set, setInterval: () => 1, clearInterval() {},
  STALL_MS: 30000, CORS_PROXIES: [], log() {}, host: x => x, invalidate() {},
  resolve: async () => ({ url: 'https://test/audio', mime: 'audio/mp4' }),
  fetch: async () => ({ ok: true, headers: { get: key => key === 'content-type' ? 'text/html; charset=utf-8' : null },
   blob: async () => new Blob(['<html>' + 'x'.repeat(200000) + '</html>']) })
 });
 await assert.rejects(c.fetchStreamBlob('a', 0), /stream fetch blocked/);
});

test('repeated lyric timestamps produce separate lines in playback order', () => {
 const c = functions('src/main.js', ['parseLyrics'], {});
 const out = c.parseLyrics({ syncedLyrics: '[00:30.00][00:10.00]Chorus\n[00:20.00]Verse' });
 assert.deepEqual(Array.from(out, line => ({ ...line })), [
  { at: 10, text: 'Chorus' }, { at: 20, text: 'Verse' }, { at: 30, text: 'Chorus' }
 ]);
});

test('empty synced lyrics fall back to available plain text', () => {
 const c = functions('src/main.js', ['parseLyrics'], {});
 assert.equal(c.parseLyrics({ syncedLyrics: '[ar:Artist]\n', plainLyrics: 'Available words' })[0].text, 'Available words');
});

test('an app update waits while the requested song is still loading', () => {
 const handlers = {}, timers = [];
 let reloads = 0;
 const c = functions('src/main.js', ['watchForAppUpdates'], {
  Player: { current: () => ({ id: 'loading' }), isPaused: () => true, playbackRequested: () => true },
  window: { addEventListener() {} }, document: { addEventListener() {} },
  navigator: { serviceWorker: { addEventListener: (name, fn) => { handlers[name] = fn; } } },
  setTimeout: fn => timers.push(fn), reloadWithFreshAppVersion: () => reloads++
 });
 c.watchForAppUpdates({ update: async () => {}, addEventListener() {} }, true);
 handlers.controllerchange(); timers.forEach(fn => fn());
 assert.equal(reloads, 0);
});

test('site configuration can be fetched again after an offline launch', async () => {
 let calls = 0;
 const c = functions('src/api.js', ['siteConfig'], {
  siteConfigPromise: null, log() {}, fetchJson: async () => {
   if (++calls === 1) throw Error('offline');
   return { invidiousInstances: ['https://private.test'] };
  }
 });
 await c.siteConfig();
 assert.equal((await c.siteConfig()).invidiousInstances[0], 'https://private.test');
 assert.equal(calls, 2);
});

test('remembering a working instance cannot break streaming on a full disk', () => {
 const h = require('./store-harness').createStore();
 let toasts = 0;
 h.window.Views = { toast: () => toasts++ };
 h.localApi.setItem = () => { throw Error('quota'); };
 const c = functions('src/api.js', ['markGood'], { window: h.window, Store: h.Store });
 assert.doesNotThrow(() => c.markGood('https://working.test'));
 assert.equal(toasts, 0);
});

test('remembering an instance never announces a settings change', () => {
 const h = require('./store-harness').createStore();
 let notices = 0;
 h.Store.onChange(() => notices++);
 const c = functions('src/api.js', ['markGood'], { window: h.window, Store: h.Store });
 c.markGood('https://working.test'); c.markGood('https://working.test');
 assert.equal(h.Store.settings().lastGoodInstance, 'https://working.test');
 // A device-local hint: announcing it marked a fresh install dirty before its first sync.
 assert.equal(notices, 0);
});

test('automatic backup setup waits for its transaction and reports a late abort', async () => {
 let closed = 0, settled = false;
 const request = { result: 'handle' }, tx = { objectStore: () => ({ put: () => request }) };
 const c = functions('src/views.js', ['backupHandle'], {
  openBackupDb: async () => ({ transaction: () => tx, close: () => closed++ })
 });
 const storing = c.backupHandle('set', 'handle');
 storing.then(() => { settled = true; }, () => { settled = true; });
 await Promise.resolve();
 request.onsuccess?.();
 await Promise.resolve(); await Promise.resolve();
 assert.equal(settled, false);
 const rejected = assert.rejects(storing, /aborted/);
 tx.error = Error('storage aborted'); tx.onabort();
 await rejected;
 assert.equal(closed, 1);
});
