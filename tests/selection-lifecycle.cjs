// Exercise the actual selection handlers with a minimal event surface.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../notebooks-selection.js'), 'utf8');
class Surface {
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  dispatchEvent(e){for(const fn of [...(this.listeners.get(e.type)||[])])fn(e);}
}
function harness() {
  const saved = new Map();
  const canvas = new Surface();
  const window = new Surface();
  const document = {getElementById(id) {
    if (id === 'info1NotebookCanvas') return canvas;
    if (id === 'nbCanvasStage') return {getBoundingClientRect: () => ({width:1000,left:0,top:0})};
    return null;
  }};
  const context = {window,document,INFO1_LOCAL:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},Set,Map,console};
  // Expose handlers without booting unrelated browser UI. Rendering is a no-op;
  // selection state, persistence and event registration run unchanged.
  const end = source.indexOf("  if (document.readyState==='loading')");
  vm.runInNewContext(source.slice(0,end) + `
    renderOverlay=highlightImages=updateTools=syncSelectionPresence=()=>{};
    window.test={bind:bindCanvas,exit:deactivateLassoForBaseTool,clear:clearSelection,
      start(){selectionMode=true;INFO1_LOCAL.setItem(LASSO_KEY,'1');},
      get active(){return selectionMode;},get pending(){return !!cancelLassoGesture;}};
  })();`, context);
  window.test.bind();
  const pointer=(target,type,id=1)=>{
    const e=new Event(type,{cancelable:true});
    Object.assign(e,{pointerId:id,pointerType:'pen',clientX:100,clientY:100});
    target.dispatchEvent(e);return e;
  };
  return {window,canvas,saved,pointer,t:window.test};
}
{
 const {t,saved}=harness();t.start();
 t.exit({target:{closest:()=>({id:'nbPen'})}});
 assert.equal(t.active,false);assert.equal(saved.get('info1-notebook-lasso-active-v1'),'0');
 console.log('PASS empty lasso exits and cannot return from persisted state');
}
for(const action of ['tool','clear','cancel']){
 const {t,canvas,window,pointer}=harness();t.start();pointer(canvas,'pointerdown');assert(t.pending);
 if(action==='tool')t.exit({target:{closest:()=>({id:'nbPen'})}});
 if(action==='clear')t.clear();
 if(action==='cancel')pointer(window,'pointercancel');
 assert.equal(t.pending,false);
 assert.equal(pointer(window,'pointermove').defaultPrevented,false);
 assert.equal(pointer(window,'pointerup').defaultPrevented,false);
 console.log('PASS interrupted lasso releases move/up handlers:',action);
}
{
 const {t,canvas,window,pointer}=harness();t.start();pointer(canvas,'pointerdown',1);pointer(canvas,'pointerdown',2);
 assert.equal(pointer(window,'pointermove',1).defaultPrevented,false);
 assert.equal(pointer(window,'pointermove',2).defaultPrevented,true);
 pointer(window,'pointercancel',2);assert.equal(t.pending,false);
 console.log('PASS replacement gesture releases abandoned pointer');
}
