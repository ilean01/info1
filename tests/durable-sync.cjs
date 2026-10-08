const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
(async()=>{
 const storage=fs.readFileSync(path.join(root,'state-storage.js'),'utf8');
 const record={notebook:{id:'n'},page:{id:'p'},stroke:{id:'new',_v:'002',points:[1,2]}};
 for(const mode of ['stale','included','deleted']){
  const journal=new Map([['new',record]]);let tx;
  const objectStore=name=>({put(){},delete(id){if(name==='journal')journal.delete(id);},openCursor(){
   const request={};queueMicrotask(()=>{let ended=false;request.result={value:record,delete(){journal.delete('new');},continue(){if(!ended){ended=true;queueMicrotask(()=>{request.result=null;request.onsuccess();tx.oncomplete();});}}};request.onsuccess();});return request;
  }});
  const c={db:{transaction(){tx={objectStore,abort(){}};return tx;}},txDone:t=>new Promise(resolve=>t.oncomplete=resolve),committedRaw:'',notebookKeys:new Set(),assetKeys:new Set(),JSON,Set,Object};
  vm.createContext(c);vm.runInContext(storage.slice(storage.indexOf('  async function writeState('),storage.indexOf('  function getItem(')),c);
  const page={id:'p',strokes:mode==='included'?[record.stroke]:[],_deletedStrokes:mode==='deleted'?{new:'003'}:{}};
  await c.writeState(JSON.stringify({__notebooksV1:{notebooks:{n:{id:'n',pages:[page]}}}}));
  assert.equal(journal.has('new'),mode==='stale');console.log('PASS recovery record:',mode);
 }
 const cloud=fs.readFileSync(path.join(root,'cloud-sync.js'),'utf8');
 const body=cloud.slice(cloud.indexOf('    cacheRealtimeState: next => {'),cloud.indexOf('    pull: () =>')).trim().replace(/,$/,'');
 const writes=new Map(),timers=[];
 const c={JSON,dirty:false,conflict:false,lastSeenRaw:'old',pushTimer:null,UNSYNCED_KEY:'pending',writePrimaryState:raw=>writes.set('state',raw),INFO1_LOCAL:{setItem:(k,v)=>writes.set(k,v)},clearTimeout(){},setTimeout:fn=>{timers.push(fn);return 1;},pushLocal(){},console};
 vm.createContext(c);vm.runInContext('var api={'+body+'};',c);
 assert.equal(c.api.cacheRealtimeState({localInk:'unsent',remoteInk:'received'}),true);
 assert.equal(c.dirty,true);assert.equal(c.lastSeenRaw,'old');assert.equal(writes.get('pending'),'1');assert.equal(timers.length,1);
 console.log('PASS received ink cannot acknowledge unsent edits; database upload scheduled');
})().catch(e=>{console.error(e);process.exit(1)});
