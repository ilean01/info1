/* Browser regression suite. Uses a deterministic transport with the SDK's
   one-channel/one-subscription rule; never signs in or writes user cloud data. */
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path');
const {chromium}=require('playwright');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=spawn('python3',['-m','http.server','8769'],{cwd:path.resolve(__dirname,'..'),stdio:'ignore'});await sleep(300);
 const browser=await chromium.launch({headless:true,executablePath:process.env.INFO1_TEST_CHROME||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const pages=[],errors=[];
 try{
  for(const viewport of [{width:1280,height:900},{width:820,height:1100}]){
   const context=await browser.newContext({viewport,serviceWorkers:'block'});const p=await context.newPage();pages.push(p);
   p.on('pageerror',e=>errors.push(e.message));
   await p.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({body:'',contentType:'application/javascript'}));
   await p.addInitScript(()=>{localStorage.setItem('info1-cloud-offline','1');window.__observerCalls=0;const Native=MutationObserver;window.MutationObserver=class extends Native{constructor(fn){super((ms,observer)=>{window.__observerCalls++;if(window.__observerCalls>3000){window.__observerLoop=true;observer.disconnect();return;}fn(ms,observer);});}};});
   await p.exposeBinding('__relay',async(source,message)=>{for(const other of pages)if(other!==source.page&&!other.isClosed())await other.evaluate(m=>window.__deliver?.(m),message);return 'ok';});
   await p.goto('http://127.0.0.1:8769/',{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);
  }
  const [a,b]=pages;
  for(const p of pages)await p.evaluate(()=>{
   window.__channels=new Map();window.__subscribeCount={};window.__sendDelay=0;window.__sendResult='ok';
   const client={channel(name){if(__channels.has(name))return __channels.get(name);const ch={name,handlers:[],on(type,filter,fn){this.handlers.push({type,filter,fn});return this;},subscribe(fn){if(this.subscribed)throw Error('Duplicate subscribe: '+name);this.subscribed=true;this.callback=fn;__subscribeCount[name]=(__subscribeCount[name]||0)+1;setTimeout(()=>fn?.('SUBSCRIBED'),5);return this;},async send(message){await new Promise(r=>setTimeout(r,window.__sendDelay));if(!navigator.onLine||window.__sendResult!=='ok')return window.__sendResult==='ok'?'error':window.__sendResult;return await window.__relay({channel:name,...message});},presenceState(){return{};},track(){return Promise.resolve('ok');},unsubscribe(){this.subscribed=false;return Promise.resolve('ok');}};__channels.set(name,ch);return ch;},removeChannel(ch){ch.subscribed=false;__channels.delete(ch.name);return Promise.resolve('ok');},from(table){const q={select(){return q},eq(){return q},maybeSingle(){return Promise.resolve({data:table==='info1_live_timer'?{workspace_id:'test-workspace',active:false,version:1}:null,error:null})},upsert(){return Promise.resolve({data:null,error:null})}};return q;}};
   window.__deliver=m=>{const ch=__channels.get(m.channel);if(ch?.subscribed)for(const h of ch.handlers)if(h.type==='broadcast'&&h.filter.event===m.event)h.fn({payload:m.payload});};
   window.INFO1_SUPABASE_CLIENT=client;window.INFO1_CLOUD={status:{connected:true,workspaceId:'test-workspace',dirty:false,conflict:false},pull:async()=>{},cacheRealtimeState(next){INFO1_LOCAL.setItem('info1-study-center-v4-priority',JSON.stringify(next));}};
  });
  await a.waitForFunction(()=>INFO1_NOTEBOOK_RESILIENCE.diagnostics().realtimeReady);await b.waitForFunction(()=>INFO1_NOTEBOOK_RESILIENCE.diagnostics().realtimeReady);
  assert(!errors.some(x=>x.includes('subscribe')));console.log('PASS one shared ink subscription, no duplicate subscription exception');
  const views=await a.evaluate(()=>{const seen=[];for(const partial of ['p1','p2']){switchPartial(partial);for(const el of document.querySelectorAll('.view')){openView(el.id);seen.push(partial+':'+el.id);}}switchPartial('p1');return seen.length;});console.log('PASS navigation through',views,'view/partial combinations');
  await a.evaluate(()=>openModal(0,0));await a.waitForSelector('#nbModalOpen');await a.locator('#nbModalOpen').click();await a.waitForTimeout(300);
  const id=await a.evaluate(()=>INFO1_NOTEBOOKS.current);assert(id);await b.waitForFunction(id=>INFO1_NOTEBOOKS.list().some(n=>n.id===id),id);await b.evaluate(id=>INFO1_NOTEBOOKS.open(id),id);console.log('PASS ficha notebook appears on second device');
  const count=p=>p.evaluate(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.length);
  const draw=async(p,offset=0)=>{const c=p.locator('#info1NotebookCanvas');await c.scrollIntoViewIfNeeded();const r=await c.boundingBox();await p.mouse.move(r.x+r.width*.2,r.y+130+offset);await p.mouse.down();await p.mouse.move(r.x+r.width*.65,r.y+210+offset,{steps:14});};
  const ink=p=>p.evaluate(()=>{const c=document.getElementById('info1NotebookCanvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>0&&d[i]<90&&d[i+1]<100&&d[i+2]<130)n++;return n;});
  const before=await ink(b);await draw(a);await sleep(150);assert(await ink(b)>before,'ink must appear before pointerup');await a.mouse.up();await b.waitForFunction(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.length===1);console.log('PASS in-progress pen and completed stroke arrive on second device');
  await Promise.all([draw(a,40),draw(b,90)]);await Promise.all([a.mouse.up(),b.mouse.up()]);await a.waitForFunction(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.length===3);await b.waitForFunction(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.length===3);console.log('PASS simultaneous drawing keeps all strokes');
  await b.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await b.evaluate(()=>INFO1_STATE_STORAGE.flush());
  const cached=await b.evaluate(id=>JSON.parse(INFO1_LOCAL.getItem('info1-study-center-v4-priority')).__notebooksV1.notebooks[id].pages[0].strokes.length,id);assert.equal(cached,3);console.log('PASS received strokes are durably cached');
  // A delayed whole-notebook snapshot must not erase newer ink.
  await b.evaluate(()=>{const nb=JSON.parse(JSON.stringify(INFO1_NOTEBOOKS._bridge.currentNotebook()));nb.pages[0].strokes=[];for(const ch of __channels.values())for(const h of ch.handlers)if(h.filter.event==='nb')h.fn({payload:{kind:'snapshot',notebook:nb,deviceId:'old-device',at:1}});});
  assert.equal(await count(b),3);console.log('PASS stale snapshot preserves current ink');
  // pagehide must persist the stroke before the 450 ms drawing debounce.
  await draw(a,150);await a.mouse.up();
  await a.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  assert.equal(await a.evaluate(()=>JSON.parse(INFO1_LOCAL.getItem('info1-study-center-v4-priority')).__notebooksV1.notebooks[INFO1_NOTEBOOKS.current].pages[0].strokes.length),4);
  await b.waitForFunction(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.length===4);
  console.log('PASS immediate pagehide flushes final ink');
  await b.locator('[data-fptool="laser"]').click();
  const laserBefore=await count(b);await draw(b,180);await b.mouse.up();await draw(b,210);await b.mouse.up();
  assert.equal(await count(b),laserBefore);assert(await b.locator('[data-fptool="laser"]').evaluate(e=>e.classList.contains('active')));
  await b.locator('[data-fptool="pen"]').click();console.log('PASS laser stays selected across gestures until pencil is selected');
  await b.setViewportSize({width:820,height:1000});
  await b.locator('#nbAlwaysExit').click();assert.equal(await b.evaluate(()=>INFO1_NOTEBOOK_INTERFACE.fullscreen),false);
  await b.evaluate(()=>INFO1_NOTEBOOK_INTERFACE.toggleFullscreen());await b.waitForTimeout(100);
  assert(await b.locator('#nbAlwaysExit').isVisible());
  const exit=await b.locator('#nbAlwaysExit').boundingBox();assert(exit.y>=0&&exit.y+exit.height<=1000);
  console.log('PASS iPad-size fullscreen exit is visible and works');
  await a.evaluate(()=>document.getElementById('nbAddPage').click());await b.waitForFunction(()=>INFO1_NOTEBOOKS._bridge.currentNotebook().pages.length===2);console.log('PASS page creation synchronization');
  // A failed ack must remain queued, and an event added during a slow flush must survive.
  await a.evaluate(()=>{window.__sendResult='timed out';INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent('notebook-renamed',{notebookId:INFO1_NOTEBOOKS.current,title:'Prueba'});});
  await a.evaluate(()=>INFO1_NOTEBOOK_RESILIENCE.flush());await sleep(80);
  assert(await a.evaluate(()=>JSON.parse(INFO1_LOCAL.getItem('info1-notebook-offline-queue-v2')).length)>0);
  await a.evaluate(()=>{window.__sendResult='ok';window.__sendDelay=150;const pending=INFO1_NOTEBOOK_RESILIENCE.flush();setTimeout(()=>INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent('notebook-favorite',{notebookId:INFO1_NOTEBOOKS.current,favorite:true}),40);return pending;});
  const queue=await a.evaluate(()=>JSON.parse(INFO1_LOCAL.getItem('info1-notebook-offline-queue-v2')));assert(queue.some(x=>x.kind==='notebook-favorite'));await a.evaluate(()=>{window.__sendDelay=0;return INFO1_NOTEBOOK_RESILIENCE.flush();});console.log('PASS failed sends and changes added during replay are retained');
  for(const p of pages)assert.equal(await p.evaluate(()=>!!window.__observerLoop),false);
  await b.evaluate(()=>INFO1_STATE_STORAGE.flush());
  await b.reload({waitUntil:'domcontentloaded'});await b.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);await b.evaluate(id=>INFO1_NOTEBOOKS.open(id),id);assert.equal(await count(b),4);console.log('PASS reload preserves received notebook and ink');
  console.log('observer callbacks',await Promise.all(pages.map(p=>p.evaluate(()=>window.__observerCalls))));
  assert.deepEqual(errors,[]);console.log('PASS no uncaught browser exceptions');
  const offlineContext=await browser.newContext();const offlinePage=await offlineContext.newPage();
  await offlinePage.addInitScript(()=>localStorage.setItem('info1-cloud-offline','1'));
  await offlinePage.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({body:'',contentType:'application/javascript'}));
  await offlinePage.goto('http://127.0.0.1:8769/',{waitUntil:'domcontentloaded'});
  await offlinePage.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await offlineContext.setOffline(true);await offlinePage.reload({waitUntil:'domcontentloaded'});
  await offlinePage.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);
  await offlinePage.evaluate(()=>INFO1_NOTEBOOKS.createForTopic('test-offline','Cuaderno sin conexión'));
  assert(await offlinePage.locator('#info1NotebookCanvas').isVisible());
  console.log('PASS PWA reload and notebook creation without network');
  await offlineContext.setOffline(false);
  assert.equal(await offlinePage.evaluate(async()=>{const r=await fetch('./materiales/05_PDA.pdf');return r.status;}),200);
  await offlineContext.setOffline(true);
  assert.equal(await offlinePage.evaluate(async()=>{const r=await fetch('./materiales/05_PDA.pdf');return r.status;}),200);
  console.log('PASS previously opened course PDF is available offline');
  await offlineContext.close();
 }finally{await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exit(1)});
