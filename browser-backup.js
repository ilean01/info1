(() => {
'use strict';
const textEncoder = new TextEncoder();
const toB64 = bytes => {let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out);};
async function encode(value) {
  if(value===undefined)return {__info1type:'undefined'};
  if(value===null||typeof value!=='object')return value;
  if(value instanceof Blob)return {__info1type:'Blob',mime:value.type,bytes:toB64(new Uint8Array(await value.arrayBuffer()))};
  if(value instanceof ArrayBuffer)return {__info1type:'ArrayBuffer',bytes:toB64(new Uint8Array(value))};
  if(ArrayBuffer.isView(value))return {__info1type:'TypedArray',constructor:value.constructor.name,bytes:toB64(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};
  if(value instanceof Date)return {__info1type:'Date',iso:value.toISOString()};
  if(value instanceof Map)return {__info1type:'Map',entries:await Promise.all([...value].map(async([k,v])=>[await encode(k),await encode(v)]))};
  if(value instanceof Set)return {__info1type:'Set',values:await Promise.all([...value].map(encode))};
  if(Array.isArray(value))return Promise.all(value.map(encode));
  const out={};for(const [key,v] of Object.entries(value))out[key]=await encode(v);return out;
}
const reqResult = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||Error('IndexedDB error'));});
async function exportDb(name) {
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Base bloqueada: '+name));});
  try {
    const result={name,version:db.version,stores:[]};
    for(const storeName of [...db.objectStoreNames]){
      const tx=db.transaction(storeName,'readonly'),store=tx.objectStore(storeName);
      const [keys,values]=await Promise.all([reqResult(store.getAllKeys()),reqResult(store.getAll())]);
      result.stores.push({name:storeName,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:[...store.indexNames].map(n=>{const i=store.index(n);return {name:n,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};}),keys:await Promise.all(keys.map(encode)),values:await Promise.all(values.map(encode))});
    }
    return result;
  }finally{db.close();}
}
async function runBackup(status,button){
  button.disabled=true;
  try{
    status.textContent='Esperando que terminen los guardados…';
    if(window.INFO1_STATE_STORAGE?.ready)await window.INFO1_STATE_STORAGE.ready;
    if(window.INFO1_STATE_STORAGE?.flush)await window.INFO1_STATE_STORAGE.flush();
    const local={};for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);local[key]=localStorage.getItem(key);}
    const session={};for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);session[key]=sessionStorage.getItem(key);}
    let dbNames;
    if(typeof indexedDB.databases==='function')dbNames=(await indexedDB.databases()).map(d=>d.name).filter(Boolean);
    else dbNames=['info1-study-storage-v2','info1-cloud-recovery-v1'];
    const databases=[];
    for(const name of dbNames){status.textContent='Exportando IndexedDB: '+name;databases.push(await exportDb(name));}
    const backup={format:'info1-browser-complete-v1',exportedAt:new Date().toISOString(),origin:location.origin,scope:'browser-origin-localstorage-sessionstorage-indexeddb',warning:'No incluye datos exclusivos de Supabase ni de otros dispositivos. Guardar un archivo por dispositivo y origen.',localStorage:local,sessionStorage:session,databases};
    const blob=new Blob([JSON.stringify(backup)],{type:'application/json'});
    const filename='INFO1-BACKUP-NAVEGADOR-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    status.textContent='Exportación generada ('+(blob.size/1048576).toFixed(1)+' MB). Verificá que el archivo se descargó y guardalo en tu Mac. Hacé lo mismo desde la tablet.';
  }catch(e){status.textContent='No se pudo completar el backup: '+e.message+' — No borres ningún dato.';console.error('INFO1 backup',e);}
  finally{button.disabled=false;}
}
function init(){
 if(document.getElementById('info1BackupLauncher'))return;
 const button=document.createElement('button');button.id='info1BackupLauncher';button.type='button';button.textContent='⬇ Backup completo';button.style.cssText='position:fixed;bottom:18px;right:18px;z-index:2147483000;background:#147d72;color:white;border:2px solid #d5fff3;border-radius:14px;padding:13px 17px;font:600 14px system-ui;box-shadow:0 6px 25px #0009';
 const panel=document.createElement('section');panel.hidden=true;panel.style.cssText='position:fixed;bottom:75px;right:18px;z-index:2147483000;background:#15213a;color:white;border:1px solid #8ea3c5;border-radius:14px;padding:18px;width:min(420px,calc(100vw - 36px));font:14px/1.5 system-ui;box-shadow:0 12px 30px #000b';
 panel.innerHTML='<strong>Backup de INFO 1 en este dispositivo</strong><p>Exporta datos del navegador: fichas, progreso, cuadernos, trazos, imágenes y otras bases IndexedDB que estén guardadas aquí. No puede descargar datos exclusivos de Supabase ni de la tablet desde tu Mac.</p><button type="button" id="info1BackupNow">Crear archivo de backup</button><p id="info1BackupStatus" role="status"></p>';
 button.onclick=()=>{panel.hidden=!panel.hidden;};
 document.body.append(panel,button);
 panel.querySelector('#info1BackupNow').onclick=()=>runBackup(panel.querySelector('#info1BackupStatus'),panel.querySelector('#info1BackupNow'));
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
