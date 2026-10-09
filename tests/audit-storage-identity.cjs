const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
(async()=>{
const s=read('state-storage.js'),a=s.indexOf('  const failures='),b=s.indexOf('  async function writeState',a);
const c={KEY:'state',pending:0,failure:null,chain:Promise.resolve(),window:{},notify(){},console:{error(){}}};vm.createContext(c);vm.runInContext(s.slice(a,b),c);
await c.queue(async()=>{throw Error('disk full')},false,'state').catch(()=>{});await new Promise(setImmediate);
await c.queue(async()=>{},false,'cloud-base');await new Promise(setImmediate);assert.equal(c.failure.message,'disk full');
await c.queue(async()=>{},false,'state');await new Promise(setImmediate);assert.equal(c.failure,null);
console.log('PASS unrelated successful writes cannot hide failed study save; retry clears its own error');
const n=read('notebooks-realtime.js'),code=n.slice(n.indexOf('  const transportDeviceId'),n.indexOf('  function appState'));
let seq=0;const make=()=>{const x={uuid:()=>String(++seq)};vm.createContext(x);vm.runInContext(code,x);return x};const x=make(),y=make();assert.equal(x.deviceId(),x.deviceId());assert.notEqual(x.deviceId(),y.deviceId());console.log('PASS independent pages cannot share the same live ink sender ID');
})().catch(e=>{console.error(e);process.exitCode=1});
