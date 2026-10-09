const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../notebooks-realtime.js'),'utf8');
const condition=source.match(/if \(e && e.type === 'pointerup'[^\n]+/)[0].replace(/^if \(/,'').replace(/\) \{$/,'');
for(const type of ['pointercancel','lostpointercapture','pointerleave'])assert.equal(vm.runInNewContext(condition,{e:{type,clientX:0,clientY:0}}),false);
assert.equal(vm.runInNewContext(condition,{e:{type:'pointerup',clientX:20,clientY:30}}),true);
console.log('PASS cancellation and lost capture cannot append spurious endpoints');
const a=source.indexOf("    if (m.kind === 'stroke-final' && m.stroke && m.stroke.id) {");
const b=source.indexOf("    if (m.kind === 'stroke-restored'",a);
for(const partial of [true,false]){
const c={window:{INFO1_STATE_STORAGE:{journal(){}}},m:{kind:'stroke-final',stroke:{id:'s',points:[{x:0,y:0},{x:1,y:1},{x:2,y:2}]}},nb:{id:'n'},page:{id:'p',strokes:[]},remoteDrafts:new Map(partial?[['n:p:s',{points:[{x:0,y:0}]}]]:[]),currentNotebookId:'n',currentPageId:'p',inkRefreshTimer:null,clearTimeout(){},setTimeout(){},redraws:0,requestRedraw(){c.redraws++}};
vm.runInNewContext('(function(){'+source.slice(a,b)+'})()',c);
assert.equal(c.page.strokes[0].points.length,3);assert.equal(c.remoteDrafts.size,0);assert.equal(c.redraws,1);
}
console.log('PASS complete remote stroke replaces incomplete preview and repaints');
