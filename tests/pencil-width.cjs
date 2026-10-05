const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),{chromium}=require('playwright');
(async()=>{const server=spawn('python3',['-m','http.server','8774'],{cwd:path.resolve(__dirname,'..'),stdio:'ignore'});await new Promise(r=>setTimeout(r,250));const browser=await chromium.launch({executablePath:process.env.INFO1_TEST_CHROME,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});try{
 for(const viewport of [{width:1280,height:900},{width:820,height:1100}]){
  const context=await browser.newContext({viewport,serviceWorkers:'block'}),p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>localStorage.setItem('info1-cloud-offline','1'));await p.goto('http://127.0.0.1:8774/');await p.waitForFunction(()=>!!window.INFO1_NOTEBOOK_INTERFACE);await p.evaluate(()=>INFO1_NOTEBOOKS.createForTopic('width-test','Grosor estable'));
  const slider=p.locator('#nbFloatingWidth');await slider.scrollIntoViewIfNeeded();await slider.focus();await p.keyboard.press('Home');for(let i=0;i<13;i++)await p.keyboard.press('ArrowUp');
  assert.equal(await slider.inputValue(),'7.5');assert.equal(await p.locator('#nbWidth').inputValue(),'7.5');assert.equal(await p.locator('#nbFloatingWidthValue').textContent(),'7,5');
  // Changing pages and receiving/reopening a notebook rebuilds the editor.
  await p.evaluate(()=>document.getElementById('nbAddPage').click());assert.equal(await p.locator('#nbWidth').inputValue(),'7.5');
  await p.evaluate(()=>INFO1_NOTEBOOKS.open(INFO1_NOTEBOOKS.current));assert.equal(await p.locator('#nbWidth').inputValue(),'7.5');
  await p.locator('[data-fptool="eraser"]').click();await p.locator('[data-fptool="pen"]').click();assert.equal(await slider.inputValue(),'7.5');
  await p.waitForTimeout(1700);assert.equal(await slider.inputValue(),'7.5');
  const canvas=p.locator('#info1NotebookCanvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();await p.mouse.move(box.x+100,box.y+150);await p.mouse.down();await p.mouse.move(box.x+240,box.y+200,{steps:8});await p.mouse.up();
  assert.equal(await p.evaluate(()=>INFO1_NOTEBOOKS._bridge.currentPage().strokes.at(-1).width),7.5);
  const id=await p.evaluate(()=>INFO1_NOTEBOOKS.current);await p.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));return INFO1_STATE_STORAGE.flush();});
  await p.reload();await p.waitForFunction(()=>!!window.INFO1_NOTEBOOK_INTERFACE);await p.evaluate(id=>INFO1_NOTEBOOKS.open(id),id);
  assert.equal(await p.locator('#nbWidth').inputValue(),'7.5');assert.equal(await slider.inputValue(),'7.5');assert.deepEqual(errors,[]);
  await p.screenshot({path:'/workspace/scratch/718a2ef97e2c/review-artifacts/pencil-slider-'+viewport.width+'.png'});
  console.log('PASS slider, stroke width, page/editor rebuild, tool switch and reload:',viewport.width);await context.close();
 }
 }finally{await browser.close();server.kill();}})().catch(e=>{console.error(e);process.exit(1)});
