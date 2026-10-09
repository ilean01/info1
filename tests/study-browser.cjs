/* Full-page local study, photos and backup round trip. No real account. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const server=spawn('python3',['-m','http.server','8775'],{cwd:path.resolve(__dirname,'..'),stdio:'ignore'});await new Promise(r=>setTimeout(r,400));
 let browser;try{
 browser=await chromium.launch({executablePath:process.env.INFO1_TEST_CHROME,args:['--no-sandbox']});
 const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 await p.addInitScript(()=>localStorage.setItem('info1-cloud-offline','1'));
 await p.goto('http://127.0.0.1:8775/');await p.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);
 await p.evaluate(()=>{switchPartial('p1');openModal(0,0)});
 await p.locator('#modalNotes').fill('Auditoría: nota guardada sin cerrar.');await p.locator('#modalPriority').selectOption('urgent');
 await p.evaluate(()=>INFO1_STATE_STORAGE.flush());
 assert.equal(await p.evaluate(()=>JSON.parse(INFO1_STATE_STORAGE.raw)['0:0'].notes),'Auditoría: nota guardada sin cerrar.');
 await p.locator('#manualSessionToggle').click();await p.locator('#manualSessionDate').fill('2026-10-09');await p.locator('#manualSessionTime').fill('10:00');await p.locator('#manualSessionMinutes').fill('25');await p.locator('#manualSessionAdd').click();
 assert(await p.evaluate(()=>state['0:0'].sesiones.some(s=>s.ms===1500000)));
 const png=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const x=c.getContext('2d');x.fillStyle='blue';x.fillRect(0,0,64,64);return c.toDataURL().split(',')[1]});
 await p.locator('#photoInput').setInputFiles({name:'audit.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await p.waitForFunction(()=>document.querySelectorAll('#modalPhotoGallery img').length===1);
 await p.locator('#saveModal').click();await p.evaluate(()=>INFO1_STATE_STORAGE.flush());
 await p.reload();await p.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);await p.evaluate(()=>openModal(0,0));assert.equal(await p.locator('#modalNotes').inputValue(),'Auditoría: nota guardada sin cerrar.');assert.equal(await p.locator('#modalPriority').inputValue(),'urgent');await p.waitForFunction(()=>document.querySelectorAll('#modalPhotoGallery img').length===1);await p.locator('#saveModal').click();
 console.log('PASS notes, priority, manual hours and photo survive reload');
 const downloadPromise=p.waitForEvent('download');await p.locator('#exportBtn').click();const download=await downloadPromise;const backup=fs.readFileSync(await download.path());const data=JSON.parse(backup);assert.equal(data.photos.length,1);assert.equal(data.state['0:0'].notes,'Auditoría: nota guardada sin cerrar.');
 const fresh=await browser.newContext({serviceWorkers:'block'}),q=await fresh.newPage();q.on('pageerror',e=>errors.push(e.message));q.on('dialog',d=>d.accept());await q.addInitScript(()=>localStorage.setItem('info1-cloud-offline','1'));await q.goto('http://127.0.0.1:8775/');await q.waitForFunction(()=>!!window.INFO1_NOTEBOOKS);await q.locator('#importFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:backup});await q.waitForFunction(()=>state['0:0']?.notes==='Auditoría: nota guardada sin cerrar.');await q.evaluate(()=>openModal(0,0));await q.waitForFunction(()=>document.querySelectorAll('#modalPhotoGallery img').length===1);await q.locator('#saveModal').click();console.log('PASS exported backup restores study and photo in independent browser');
 for(const width of [390,820,1280]){await q.setViewportSize({width,height:900});await q.evaluate(()=>openView('settingsView'));assert(await q.locator('#settingsView').isVisible());assert.equal(await q.locator('#showVersions').evaluate(e=>e.closest('.view').id),'settingsView');await q.evaluate(()=>openView('boardView'));assert(!await q.locator('#showVersions').isVisible());}
 console.log('PASS settings navigation at phone, tablet and desktop widths');assert.deepEqual(errors,[]);console.log('PASS no uncaught errors in study/photo/backup flow');
 }finally{await browser?.close();server.kill();}
})().catch(e=>{console.error(e);process.exit(1)});
