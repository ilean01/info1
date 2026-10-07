const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../notebooks-realtime.js'),'utf8');
let reads=0;
const page={id:'p',height:3000};
Object.defineProperty(page,'strokes',{get(){throw Error('Sampling must not traverse existing ink');}});
let state={books:{notebooks:{n:{pages:[page]}}}};
Object.defineProperty(state.books.notebooks,'other',{enumerable:true,get(){throw Error('Sampling must not inspect other notebooks');}});
const context={appState:()=>state,STORE_KEY:'books',currentNotebookId:'n',currentPageId:'p',LOGICAL_WIDTH:1000,INITIAL_PAGE_HEIGHT:1400,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),canvas:{getBoundingClientRect(){reads++;return {left:10,top:20,width:500};}}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function currentInkPage()'),source.indexOf('  function strokeBounds(')),context);
const rect=context.canvas.getBoundingClientRect(),start=performance.now();
for(let i=0;i<10000;i++){
 const p=context.pointFromEvent({clientX:260,clientY:520,pressure:.7},rect,page);
 assert.equal(p.x,.5);assert.equal(p.y,1000);assert.equal(p.p,.7);
}
assert.equal(reads,1);
console.log('PASS 10,000 samples without reading old ink/other notebooks; one shared layout read ('+(performance.now()-start).toFixed(1)+' ms)');
state={books:{notebooks:{n:{pages:[{id:'p',height:600}]}}}};
assert.equal(context.pointFromEvent({clientX:260,clientY:520,pressure:0}).y,600);
assert.equal(context.pointFromEvent({clientX:260,clientY:520,pressure:0}).p,.5);
console.log('PASS sampling follows replaced page state and keeps coordinate/pressure bounds');
