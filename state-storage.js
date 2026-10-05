/* Load before the application. Large data is stored atomically in IndexedDB. */
(() => {
  'use strict';
  const KEY='info1-study-center-v4-priority', JOURNAL='info1-ink-recovery-v2';
  const managed=new Set([KEY,'info1-notebook-offline-queue-v2','info1-notebook-image-pending-v1']);
  const isManaged=key=>managed.has(key)||key.startsWith('info1-cloud-base:');
  const memory=new Map(); let db, pending=0, failure=null, chain=Promise.resolve();
  let notebookKeys=new Set(),assetKeys=new Set(), committedRaw='', generation=0;
  const notify=()=>window.dispatchEvent(new Event('info1:storage-status'));
  const txDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||Error('No se pudo guardar'));tx.onabort=()=>reject(tx.error||Error('Guardado cancelado'));});
  const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  function queue(operation, silent=false){
    pending++;
    if(!silent)notify();
    const next=chain.catch(()=>{}).then(operation);
    chain=next;
    next.then(()=>{failure=null;},e=>{failure=e;console.error('INFO1 almacenamiento:',e);})
      .finally(()=>{pending--;window.INFO1_LOCAL_SAVE_OK=!failure;if(!silent)notify();});
    return next;
  }
  async function writeState(raw){
    const value=JSON.parse(raw), store=value.__notebooksV1||{}, notebooks=store.notebooks||{},assets=store.mediaAssets||{};
    const base={...value,__notebooksV1:{...store,notebooks:{},mediaAssets:{}}};
    const tx=db.transaction(['state','notebooks','assets','journal'],'readwrite'), done=txDone(tx);
    try {
    tx.objectStore('state').put(base,'current');
    const old=committedRaw?JSON.parse(committedRaw).__notebooksV1||{}:{};
    for(const [id,n] of Object.entries(notebooks))if(JSON.stringify(old.notebooks?.[id])!==JSON.stringify(n))tx.objectStore('notebooks').put(n,id);
    for(const id of notebookKeys)if(!notebooks[id])tx.objectStore('notebooks').delete(id);
    for(const [id,a] of Object.entries(assets))if(JSON.stringify(old.mediaAssets?.[id])!==JSON.stringify(a))tx.objectStore('assets').put(a,id);
    for(const id of assetKeys)if(!assets[id])tx.objectStore('assets').delete(id);
    // Todo lo que está en journal ya quedó incorporado a este estado completo.
    tx.objectStore('journal').clear();
    } catch(error){tx.abort();await done.catch(()=>{});throw error;}
    await done;notebookKeys=new Set(Object.keys(notebooks));assetKeys=new Set(Object.keys(assets));committedRaw=raw;
  }
  function getItem(key){return isManaged(key)?(memory.get(key)??null):localStorage.getItem(key);}
  function setItem(key,value){
    value=String(value);
    if(!isManaged(key)){localStorage.setItem(key,value);return;}
    if(!db)throw Error('El almacenamiento todavía no está listo');
    if(key===KEY)JSON.parse(value);
    memory.set(key,value);const ticket=++generation;
    queue(async()=>{
      if(key===KEY){await writeState(value);if(ticket===generation)try{localStorage.removeItem(JOURNAL);}catch(_){} }
      else {const tx=db.transaction('kv','readwrite'),done=txDone(tx);tx.objectStore('kv').put(value,key);await done;}
      try{localStorage.removeItem(key);}catch(_){}
    });
  }
  function removeItem(key){if(!isManaged(key)){localStorage.removeItem(key);return;}memory.delete(key);queue(async()=>{const tx=db.transaction('kv','readwrite'),done=txDone(tx);tx.objectStore('kv').delete(key);await done;});}
  // Recuperación de tinta sin bloquear el hilo principal.
  // Antes cada trazo hacía JSON.parse + JSON.stringify de TODO el journal en
  // localStorage. En iPad eso pausaba el event loop y Safari perdía contactos
  // rápidos del Apple Pencil. IndexedDB hace el guardado de forma asíncrona.
  function journal(notebook,page,stroke){
    if(!db||!notebook?.id||!page?.id||!stroke?.id)return;
    generation++;
    const record={
      notebook:{...notebook,pages:[]},
      page:{...page,strokes:[],images:[],redoStack:[]},
      stroke
    };
    queue(async()=>{
      const tx=db.transaction('journal','readwrite'),done=txDone(tx);
      tx.objectStore('journal').put(record,stroke.id);
      await done;
    },true);
  }
  const ready=(async()=>{
    db=await new Promise((resolve,reject)=>{const r=indexedDB.open('info1-study-storage-v2',2);r.onupgradeneeded=()=>{for(const name of ['state','notebooks','assets','kv','journal'])if(!r.result.objectStoreNames.contains(name))r.result.createObjectStore(name);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Cerrá las otras pestañas de INFO 1 y reintentá.'));});
    const tx=db.transaction(['state','notebooks','assets','kv','journal'],'readonly');
    const [base,notebooks,assets,keys,values,idbRecords]=await Promise.all([
      request(tx.objectStore('state').get('current')),
      request(tx.objectStore('notebooks').getAll()),
      request(tx.objectStore('assets').getAll()),
      request(tx.objectStore('kv').getAllKeys()),
      request(tx.objectStore('kv').getAll()),
      request(tx.objectStore('journal').getAll())
    ]);
    let value=base;
    if(base){base.__notebooksV1??={};base.__notebooksV1.notebooks=Object.fromEntries(notebooks.map(n=>[n.id,n]));base.__notebooksV1.mediaAssets=Object.fromEntries(assets.map(a=>[a.id,a]));notebookKeys=new Set(notebooks.map(n=>n.id));assetKeys=new Set(assets.map(a=>a.id));committedRaw=JSON.stringify(base);}
    const legacy=localStorage.getItem(KEY);
    if(legacy){const old=JSON.parse(legacy);value=base?window.INFO1_NOTEBOOK_MERGE.withNotebooks(base,old):old;}
    for(let i=0;i<keys.length;i++)memory.set(keys[i],values[i]);
    for(const key of managed)if(key!==KEY&&localStorage.getItem(key)!=null)memory.set(key,localStorage.getItem(key));
    const legacyRecords=JSON.parse(localStorage.getItem(JOURNAL)||'[]');
    const records=[...(Array.isArray(idbRecords)?idbRecords:[]),...(Array.isArray(legacyRecords)?legacyRecords:[])];
    if(records.length){value??={};value.__notebooksV1??={notebooks:{},order:[],mediaAssets:{}};const store=value.__notebooksV1;
      for(const r of records){if(!r?.stroke?.id||!r?.notebook?.id||!r?.page?.id)continue;
        // A newer deletion wins over a recovery record already included in a save.
        if(store._deletedNotebooks?.[r.notebook.id])continue;
        const nb=store.notebooks[r.notebook.id]??=(r.notebook);if(!store.order.includes(nb.id))store.order.push(nb.id);
        if(nb._deletedPages?.[r.page.id])continue;
        const page=nb.pages.find(p=>p.id===r.page.id)||r.page;if(!nb.pages.includes(page))nb.pages.push(page);
        if(!page._deletedStrokes?.[r.stroke.id]&&!page.strokes.some(s=>s.id===r.stroke.id))page.strokes.push(r.stroke);
      }
    }
    if(value){const raw=JSON.stringify(value);await writeState(raw);memory.set(KEY,raw);localStorage.removeItem(KEY);localStorage.removeItem(JOURNAL);}
    for(const key of managed)if(key!==KEY&&memory.has(key)){const t=db.transaction('kv','readwrite'),done=txDone(t);t.objectStore('kv').put(memory.get(key),key);await done;localStorage.removeItem(key);}
    window.INFO1_LOCAL_SAVE_OK=true;
  })();
  window.INFO1_LOCAL={getItem,setItem,removeItem};
  window.INFO1_STATE_STORAGE={ready,journal,flush:()=>chain,status:()=>({pending,error:failure?.message||null}),get raw(){return getItem(KEY);}};
})();
