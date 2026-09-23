// Capture the actual interface with fictional content, without external network access.
// Requires Playwright: NODE_PATH=/path/to/node_modules node scripts/capture-screenshots.cjs
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/images');
const titles = ['Harbour Lights', 'Slow Morning', 'After the Rain', 'Night Drive', 'Open Windows', 'Paper Planes', 'Blue Hour'];
const artists = ['The Daylight Project', 'June & The Pines', 'North Avenue', 'The Daylight Project', 'Milo Rivers', 'June & The Pines', 'North Avenue'];
const palette = [['#ce7659','#532f55'],['#5c929a','#23394f'],['#748158','#c3a274'],['#656da9','#262745'],['#d5af62','#775548'],['#b77386','#594b78'],['#386275','#172c41']];
const tracks = titles.map((title, i) => ({ id: 'demo' + String(i).padStart(7, '0'), title, artist: artists[i], duration: 185 + i * 13, kind: 'music', thumb: 'https://i.ytimg.com/vi/demo' + i + '/hqdefault.jpg' }));
function cover(i) {
  const [a,b] = palette[i % palette.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><path fill="url(#g)" d="M0 0h400v400H0z"/><circle cx="280" cy="110" r="96" fill="#fff" opacity=".23"/><path d="M-20 340 140 160 300 350 420 210V420H-20Z" fill="#111" opacity=".23"/><path d="M0 330h400M0 340h400M0 350h400" stroke="#fff" opacity=".12"/></svg>`;
}
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname === '/guest/' ? 'guest/index.html' : pathname);
  if (!file.startsWith(root + '/')) return res.writeHead(403).end();
  fs.readFile(file, (error,body) => {
    if(error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true, ...(process.env.AURA_CHROMIUM ? {executablePath:process.env.AURA_CHROMIUM} : {})});
  try {
    const context = await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:2,locale:'en-US',reducedMotion:'reduce',serviceWorkers:'block'});
    const room = {title:'Friday evening',expiresAt:new Date('2030-01-01T23:00:00Z').getTime(),name:'Alex',joined:true,joinStatus:'approved',permission:'approval',requests:[
      {id:'first',track:tracks[0],name:'Sam',fromHost:false,status:'approved',votes:3},
      {id:'second',track:tracks[3],name:'Alex',fromHost:false,status:'approved',votes:2,mine:true},
      {id:'third',track:tracks[2],name:'Jordan',fromHost:false,status:'pending',votes:4,voted:false},
      {id:'fourth',track:tracks[4],name:'Alex',fromHost:false,status:'pending',votes:2,mine:true,voted:true}
    ]};
    await context.route('**/*', route => {
      const url = route.request().url();
      const art = /https:\/\/i.ytimg.com\/vi\/demo(\d+)/.exec(url);
      if(art) return route.fulfill({contentType:'image/svg+xml',body:cover(Number(art[1]))});
      if(url.startsWith(origin + '/guest/api/')) return route.fulfill({json:{room}});
      if(url.startsWith(origin + '/api/queue/')) return route.fulfill({json:{room:null}});
      if(url.startsWith(origin + '/api/')) return route.fulfill({status:404,json:{}});
      return url.startsWith(origin) ? route.continue() : route.abort();
    });
    await context.addInitScript(tracks => {
      localStorage.setItem('aura.settings',JSON.stringify({interfaceLanguage:'en',autoplay:false,nightlyPrebuild:false,aiHomeSection:false,animations:false}));
      localStorage.setItem('aura.library',JSON.stringify(tracks));
      localStorage.setItem('aura.liked',JSON.stringify(tracks.slice(0,4).map(t=>t.id)));
      localStorage.setItem('aura.playlists',JSON.stringify([{id:'demo-list',name:'Evening unwind',ids:tracks.map(t=>t.id),createdAt:Date.now()}]));
      localStorage.setItem('aura.queue',JSON.stringify({extra:tracks,pos:0,shuffle:false,repeat:'off'}));
    },tracks);
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto(origin);
    await page.waitForFunction(()=>window.Views && window.Store);
    await page.evaluate(()=>Views.showTab('library'));
    await page.locator('[data-chip="songs"]').click();
    await page.locator('.song').first().waitFor();
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(350);
    fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'library.png')});
    // ask-ai.png is a supplied phone screenshot. Preserve it when refreshing demos.
    await page.goto(origin+'/guest/?lang=en#'+'a'.repeat(32));
    await page.locator('#welcome').waitFor();
    await page.locator('#menu-toggle').click();
    await page.locator('#nav-home').click();
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(output,'shared-queue.png')});
    if(errors.length) throw Error(errors.join('\n'));
    console.log('Captured library and shared queue screenshots with demo content.');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
