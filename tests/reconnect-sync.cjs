const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../cloud-sync.js'),'utf8');
const code=source.slice(source.indexOf('  let reconciling = false;'),source.indexOf('  function startMonitoring()'));
async function run(change={}){
 const c={session:{},workspace:{id:'w'},busy:false,applyingRemote:false,conflict:false,navigator:{onLine:true},dirty:false,lastSeenRaw:'same',raw:'same',remoteRevision:4,pulls:0,pushes:0,reads:0,console,
 localRaw(){return c.raw},notifyLocalSave(){c.pushes++},async loadCloudIntoLocal(manual){assert.equal(manual,false);c.pulls++},sb:{from(){return {select(){return this},eq(){return this},async maybeSingle(){c.reads++;c.during?.();return {data:{revision:c.revision??5}}}}}}};Object.assign(c,change);vm.createContext(c);vm.runInContext(code,c);await c.reconcileConnection();return c;
}
(async()=>{
 let c=await run();assert.equal(c.pulls,1);console.log('PASS clean returning device downloads missed remote revision');
 c=await run({dirty:true});assert.equal(c.pushes,1);assert.equal(c.reads,0);console.log('PASS pending edits upload instead of being replaced');
 c=await run({raw:'new'});assert.equal(c.pushes,1);console.log('PASS unobserved local edits are detected before download');
 c=await run({revision:4});assert.equal(c.pulls,0);console.log('PASS unchanged revision avoids whole-state download');
 for(const change of [{busy:true},{conflict:true},{navigator:{onLine:false}}]){c=await run(change);assert.equal(c.reads,0)}
 console.log('PASS offline, conflict and active upload are respected');
 c=await run({during(){this.raw='edited during read'}});assert.equal(c.pulls,0);assert.equal(c.pushes,1);console.log('PASS edit during revision check remains pending');
})().catch(e=>{console.error(e);process.exitCode=1});
