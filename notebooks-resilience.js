(() => {
  'use strict';

  const DEVICE_KEY = 'info1-notebook-device-v1';
  const OPEN_KEY = 'info1-notebook-open-v1';
  const QUEUE_KEY = 'info1-notebook-offline-queue-v2';
  const IMAGE_PENDING_KEY = 'info1-notebook-image-pending-v1';
  const SYNC_CHANNEL_VERSION = 'v1';
  const CHUNK_SIZE = 28000;
  const LOGICAL_WIDTH = 1000;

  let syncChannel = null;
  let syncClient = null;
  let queueError = false;
  let baseSender = null;
  let syncChannelName = null;
  let baseSenderName = null;
  let ready = false;
  let baseReady = false;
  let flushing = false;
  let persistDepth = 0;
  let saveError = false;
  let settleTimer = null;
  let lastChangeAt = 0;
  let lastSavedAt = 0;
  let lastSentAt = 0;
  let reconnectCount = 0;
  let disconnectCount = 0;
  let pageSwitchCount = 0;
  let lastContext = '';
  let selectionSendTimer = null;
  let selectionTransformTimer = null;
  let objectLiveTimer = null;
  let pendingSelectionPayload = null;
  let pendingSelectionTransformPayload = null;
  let pendingObjectPayload = null;
  let assetTransfers = new Map();
  let sentAssets = new Set();
  let remoteSelections = new Map();
  let remoteTransformSessions = new Map();
  let statusObserver = null;

  function deep(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'nb-'+Date.now()+'-'+Math.random().toString(36).slice(2);
      localStorage.setItem(DEVICE_KEY,id);
    }
    return id;
  }

  function api() {
    return window.INFO1_NOTEBOOKS || null;
  }

  function bridge() {
    const a=api();
    return a && a._bridge ? a._bridge : null;
  }

  function cloud() {
    const status=window.INFO1_CLOUD && window.INFO1_CLOUD.status;
    return {
      connected:!!(status && status.connected && window.INFO1_SUPABASE_CLIENT),
      workspaceId:status && status.workspaceId ? status.workspaceId : null,
      client:window.INFO1_SUPABASE_CLIENT || null
    };
  }

  function currentIds() {
    const a=api();
    let open={};
    try { open=JSON.parse(localStorage.getItem(OPEN_KEY)||'{}')||{}; } catch (_) {}
    return {notebookId:a && a.current ? a.current : null,pageId:open.pageId||null};
  }

  function currentNotebook() {
    const a=api();
    if (!a || !a.current || typeof a.list!=='function') return null;
    return a.list().find(n=>n && n.id===a.current)||null;
  }

  function findNotebook(id) {
    const a=api();
    return a && typeof a.list==='function' ? a.list().find(n=>n && n.id===id)||null : null;
  }

  function findPage(notebookId,pageId) {
    const nb=findNotebook(notebookId);
    return nb && (nb.pages||[]).find(p=>p.id===pageId)||null;
  }

  function mediaStore() {
    const b=bridge();
    return b && b.mediaAssets ? b.mediaAssets() : {};
  }

  function loadQueue() {
    try {
      const value=JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');
      return Array.isArray(value)?value:[];
    } catch (_) { return []; }
  }

  function saveQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY,JSON.stringify(queue)); queueError=false; } catch (_) { queueError=true; }
  }

  function loadPendingImagePages() {
    try {
      const value=JSON.parse(localStorage.getItem(IMAGE_PENDING_KEY)||'[]');
      return new Set(Array.isArray(value)?value:[]);
    } catch (_) { return new Set(); }
  }

  let pendingImagePages=loadPendingImagePages();

  function savePendingImagePages() {
    try { localStorage.setItem(IMAGE_PENDING_KEY,JSON.stringify(Array.from(pendingImagePages))); } catch (_) {}
  }

  function durableBaseKind(kind) {
    return ['notebook-created','notebook-deleted','notebook-renamed','notebook-favorite','notebook-folder','folder-created','folder-updated','folder-deleted','folder-order','page-added','page-deleted','page-layout','stroke-final','stroke-delete','stroke-restored','undo','page-cleared'].includes(kind);
  }

  function enqueueBaseEvent(kind,payload) {
    if (kind==='stroke-start' || kind==='stroke-points') {
      markChanged();
      return;
    }
    const queue=loadQueue();
    if (kind==='pages-replaced') {
      const notebookId=payload && payload.notebookId;
      if (!notebookId) return;
      const filtered=queue.filter(item=>!(item.kind==='pages-snapshot' && item.notebookId===notebookId));
      filtered.push({id:'q-'+Date.now()+'-'+Math.random(),kind:'pages-snapshot',notebookId,at:Date.now()});
      saveQueue(filtered);
    } else if (durableBaseKind(kind)) {
      queue.push({id:'q-'+Date.now()+'-'+Math.random(),kind,payload:deep(payload||{}),at:Date.now()});
      saveQueue(queue);
    }
    markChanged();
    updateStatus();
  }

  function markChanged() {
    lastChangeAt=Date.now();
    clearTimeout(settleTimer);
    settleTimer=setTimeout(()=>{ lastSavedAt=Date.now(); updateStatus(); },850);
    updateStatus();
  }

  function onPersistStart() {
    persistDepth++;
    markChanged();
  }

  function onPersistEnd(success=true) {
    persistDepth=Math.max(0,persistDepth-1);
    saveError=!success;
    if (success) lastSavedAt=Date.now();
    updateStatus();
  }

  function onBaseBroadcast() {
    lastSentAt=Date.now();
    markChanged();
  }

  function statusState() {
    const c=cloud();
    const queueLength=loadQueue().length;
    const imagePending=pendingImagePages.size;
    if (saveError || queueError || window.INFO1_LOCAL_SAVE_OK===false) return {key:'error',text:'● No se pudo guardar · exportá un backup antes de cerrar',queueLength,imagePending};
    if (window.INFO1_CLOUD?.status?.conflict) return {key:'error',text:'● Conflicto en nube · copia local conservada',queueLength,imagePending};
    if (!navigator.onLine || !c.connected) return {key:'offline',text:'● Sin conexión · guardado localmente',queueLength,imagePending};
    if (!ready || !baseReady || flushing || persistDepth>0 || window.INFO1_CLOUD?.status?.dirty || queueLength || imagePending || Date.now()-lastChangeAt<850) {
      return {key:'syncing',text:'● Sincronizando…',queueLength,imagePending};
    }
    return {key:'saved',text:'● Guardado local · conexión activa',queueLength,imagePending};
  }

  function ensureStatusUi() {
    const panel=document.getElementById('nbEditorPanel');
    if (!panel) return;
    let badge=document.getElementById('nbSaveState');
    if (!badge) {
      badge=document.createElement('button');
      badge.id='nbSaveState';
      badge.type='button';
      badge.className='nb-btn';
      badge.style.cssText='font-weight:900;white-space:nowrap';
      badge.title='Estado de guardado y sincronización. Tocá para ver diagnóstico.';
      badge.onclick=showDiagnostics;
      const live=panel.querySelector('.nb-live');
      if (live && live.parentNode) live.parentNode.insertBefore(badge,live.nextSibling);
      else {
        const top=panel.querySelector('.nb-editor-top');
        if (top) top.appendChild(badge);
      }
    }
  }

  function updateStatus() {
    ensureStatusUi();
    const badge=document.getElementById('nbSaveState');
    if (!badge) return;
    const s=statusState();
    badge.textContent=s.text+(s.queueLength?(' · '+s.queueLength+' pendiente'+(s.queueLength===1?'':'s')):'');
    badge.dataset.state=s.key;
    badge.style.borderColor=s.key==='saved'?'#2f8f67':s.key==='syncing'?'#b48a35':'#a44b55';
    badge.style.color=s.key==='saved'?'#8ef0c8':s.key==='syncing'?'#ffe09a':'#ffb2b9';
  }

  function showDiagnostics() {
    const d=diagnostics();
    alert(
      'Diagnóstico de cuadernos\n\n'+
      'Internet: '+(d.online?'sí':'no')+'\n'+
      'Nube INFO1: '+(d.cloudConnected?'conectada':'desconectada')+'\n'+
      'Canal realtime: '+(d.realtimeReady?'conectado':'no conectado')+'\n'+
      'Cola offline: '+d.queueLength+'\n'+
      'Imágenes pendientes: '+d.imagePending+'\n'+
      'Reconexiones detectadas: '+d.reconnectCount+'\n'+
      'Cambios de hoja detectados: '+d.pageSwitchCount+'\n'+
      'Último guardado: '+(d.lastSavedAt?new Date(d.lastSavedAt).toLocaleTimeString():'—')
    );
  }

  function diagnostics() {
    const c=cloud();
    return {
      online:navigator.onLine,
      cloudConnected:c.connected,
      realtimeReady:ready && baseReady,
      queueLength:loadQueue().length,
      imagePending:pendingImagePages.size,
      flushing,
      reconnectCount,
      disconnectCount,
      pageSwitchCount,
      lastChangeAt,
      lastSavedAt,
      lastSentAt
    };
  }

  async function channelSend(channel,event,payload) {
    if (!channel) throw new Error('canal no disponible');
    const result=await channel.send({type:'broadcast',event,payload});
    if (result !== 'ok') throw new Error('No se confirmó el envío: '+result);
  }

  function syncTopic(workspaceId) {
    return 'info1-notebook-resilience-'+SYNC_CHANNEL_VERSION+'-'+workspaceId;
  }

  function baseTopic(workspaceId) {
    return 'info1-notebooks-v1-'+workspaceId;
  }

  function disconnectChannels() {
    const c=cloud();
    const sb=syncClient;
    if (sb) {
      try { if (syncChannel) sb.removeChannel(syncChannel); } catch (_) {}
      // The ink channel belongs to notebooks-realtime; never remove it here.
    }
    syncChannel=null;syncClient=null;baseSender=null;ready=false;baseReady=false;
  }

  function connect() {
    const c=cloud();
    if (!c.connected || !c.workspaceId || !c.client || !navigator.onLine) {
      if (ready || baseReady) disconnectCount++;
      disconnectChannels();
      updateStatus();
      return;
    }

    const inkBridge=bridge();
    baseSender=inkBridge && inkBridge.getChannel ? inkBridge.getChannel() : null;
    const wasBaseReady=baseReady;
    baseReady=!!(baseSender && inkBridge.isChannelReady());
    if (baseReady && !wasBaseReady) setTimeout(flushAll,0);
    const wantedSync=syncTopic(c.workspaceId);
    const wantedBase=baseTopic(c.workspaceId);
    if (syncChannel && syncClient===c.client && syncChannelName===wantedSync && baseSender && baseSenderName===wantedBase) {
      updateStatus();
      return;
    }

    const inkChannel=baseSender, inkReady=baseReady;
    disconnectChannels();
    baseSender=inkChannel; baseReady=inkReady;
    syncChannelName=wantedSync;
    baseSenderName=wantedBase;
    sentAssets.clear();

    syncClient=c.client;
    syncChannel=c.client.channel(wantedSync,{config:{broadcast:{self:false,ack:false}}})
      .on('broadcast',{event:'sync'},msg=>handleSync(msg && msg.payload ? msg.payload : {}))
      .subscribe(status=>{
        const was=ready;
        ready=status==='SUBSCRIBED';
        if (ready && !was) {
          reconnectCount++;
          sendSync('hello',Object.assign({},currentIds())).catch(()=>{});
          setTimeout(flushAll,50);
        }
        updateStatus();
      });

    // Reuse the subscribed core channel; a second subscribe throws in supabase-js.
    if (baseReady) setTimeout(flushAll,60);
  }

  function envelope(kind,payload) {
    return Object.assign({kind,deviceId:deviceId(),at:Date.now()},payload||{});
  }

  async function sendSync(kind,payload) {
    if (!ready || !syncChannel || !navigator.onLine) throw new Error('offline');
    await channelSend(syncChannel,'sync',envelope(kind,payload));
    lastSentAt=Date.now();
  }

  async function sendBase(kind,payload) {
    if (!baseReady || !baseSender || !navigator.onLine) throw new Error('offline');
    await channelSend(baseSender,'nb',Object.assign({kind,deviceId:deviceId(),at:Date.now()},payload||{}));
    lastSentAt=Date.now();
  }

  async function flushBaseQueue() {
    if (!baseReady || flushing || !navigator.onLine) return;
    const queue=loadQueue();
    if (!queue.length) return;
    flushing=true;updateStatus();
    try {
      for (const item of queue) {
        if (item.kind==='pages-snapshot') {
          const nb=findNotebook(item.notebookId);
          if (nb) await sendBase('pages-replaced',{notebookId:nb.id,pages:nb.pages||[],currentPageId:nb.id===(api()&&api().current)?currentIds().pageId:null});
        } else await sendBase(item.kind,item.payload||{});
        saveQueue(loadQueue().filter(pending=>pending.id!==item.id));
      }
    } catch (error) {
      console.warn('INFO1 cuadernos: envío pendiente', error);
    } finally {
      flushing=false;updateStatus();
    }
  }

  async function flushPendingImages() {
    if (!ready || !navigator.onLine || !pendingImagePages.size) return;
    const keys=Array.from(pendingImagePages);
    for (const key of keys) {
      const parts=key.split(':');
      const nb=findNotebook(parts[0]);
      const page=nb && (nb.pages||[]).find(p=>p.id===parts.slice(1).join(':'));
      if (!nb || !page) {
        pendingImagePages.delete(key);
        continue;
      }
      try {
        await sendImagesNow(nb.id,page.id,page.images||[],mediaStore(),true);
        pendingImagePages.delete(key);
      } catch (_) {
        break;
      }
    }
    savePendingImagePages();
    updateStatus();
  }

  async function flushAll() {
    await flushBaseQueue();
    await flushPendingImages();
  }

  async function sendAsset(assetId,asset,force) {
    if (!assetId || !asset || !asset.dataUrl) return;
    if (sentAssets.has(assetId) && !force) return;
    const data=String(asset.dataUrl);
    const total=Math.max(1,Math.ceil(data.length/CHUNK_SIZE));
    const transferId=deviceId()+':'+assetId+':'+Date.now();
    await sendSync('asset-meta',{transferId,assetId,total,meta:{
      id:assetId,width:asset.width,height:asset.height,name:asset.name,type:asset.type,createdAt:asset.createdAt
    }});
    for (let i=0;i<total;i++) {
      await sendSync('asset-chunk',{transferId,assetId,index:i,total,data:data.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE)});
    }
    await sendSync('asset-done',{transferId,assetId,total});
    sentAssets.add(assetId);
  }

  async function sendImagesNow(notebookId,pageId,images,assets,forceAssets) {
    const refs=Array.from(new Set((images||[]).map(i=>i && i.assetId).filter(Boolean)));
    for (const assetId of refs) {
      const asset=assets && assets[assetId];
      if (asset) await sendAsset(assetId,asset,!!forceAssets);
    }
    await sendSync('images-state',{notebookId,pageId,images:deep(images||[])});
  }

  function syncImages(notebookId,pageId,images,assets) {
    markChanged();
    const key=notebookId+':'+pageId;
    if (!ready || !navigator.onLine) {
      pendingImagePages.add(key);savePendingImagePages();updateStatus();return;
    }
    sendImagesNow(notebookId,pageId,images,assets,false)
      .then(()=>{pendingImagePages.delete(key);savePendingImagePages();lastSavedAt=Date.now();updateStatus();})
      .catch(()=>{pendingImagePages.add(key);savePendingImagePages();updateStatus();});
  }

  function syncObjectLive(notebookId,pageId,payload) {
    pendingObjectPayload={notebookId,pageId,payload};
    if (objectLiveTimer) return;
    objectLiveTimer=setTimeout(()=>{
      objectLiveTimer=null;
      const value=pendingObjectPayload;pendingObjectPayload=null;
      if (!value || !ready) return;
      sendSync('object-live',value).catch(()=>{});
    },45);
  }

  function syncSelection(notebookId,pageId,payload) {
    pendingSelectionPayload={notebookId,pageId,payload:deep(payload||{})};
    if (selectionSendTimer) return;
    selectionSendTimer=setTimeout(()=>{
      selectionSendTimer=null;
      const value=pendingSelectionPayload;pendingSelectionPayload=null;
      if (!value || !ready) return;
      if (value.payload.lasso && value.payload.lasso.length>220) {
        value.payload.lasso=value.payload.lasso.filter((_,i)=>i%Math.ceil(value.payload.lasso.length/220)===0);
      }
      sendSync('selection-live',value).catch(()=>{});
    },55);
  }

  function syncSelectionTransform(notebookId,pageId,payload) {
    pendingSelectionTransformPayload={notebookId,pageId,payload:deep(payload||{})};
    const immediate=payload && (payload.phase==='start' || payload.phase==='end');
    if (immediate) {
      const value=pendingSelectionTransformPayload;pendingSelectionTransformPayload=null;
      if (selectionTransformTimer) {clearTimeout(selectionTransformTimer);selectionTransformTimer=null;}
      if (ready) sendSync('selection-transform',value).catch(()=>{});
      return;
    }
    if (selectionTransformTimer) return;
    selectionTransformTimer=setTimeout(()=>{
      selectionTransformTimer=null;
      const value=pendingSelectionTransformPayload;pendingSelectionTransformPayload=null;
      if (value && ready) sendSync('selection-transform',value).catch(()=>{});
    },45);
  }

  function refresh() {
    const b=bridge();
    if (b && b.refresh) b.refresh();
    renderRemoteSelections();
  }

  function persistRemote() {
    const b=bridge();
    if (b && b.persist) b.persist();
  }

  function handleAssetMeta(m) {
    assetTransfers.set(m.transferId,{assetId:m.assetId,total:Number(m.total)||1,chunks:[],meta:m.meta||{}});
  }

  function handleAssetChunk(m) {
    let t=assetTransfers.get(m.transferId);
    if (!t) {
      t={assetId:m.assetId,total:Number(m.total)||1,chunks:[],meta:{}};
      assetTransfers.set(m.transferId,t);
    }
    t.chunks[Number(m.index)||0]=m.data||'';
  }

  function handleAssetDone(m) {
    const t=assetTransfers.get(m.transferId);
    if (!t) return;
    if (t.chunks.filter(v=>typeof v==='string').length<t.total) return;
    const dataUrl=t.chunks.join('');
    const store=mediaStore();
    store[t.assetId]=Object.assign({},t.meta,{id:t.assetId,dataUrl});
    assetTransfers.delete(m.transferId);
    persistRemote();refresh();
  }

  function handleImagesState(m) {
    const page=findPage(m.notebookId,m.pageId);
    if (!page || !Array.isArray(m.images)) return;
    page.images=deep(m.images);
    const missing=Array.from(new Set(page.images.map(i=>i && i.assetId).filter(id=>id && !mediaStore()[id])));
    persistRemote();refresh();
    if (missing.length && ready) sendSync('asset-need',{assetIds:missing,notebookId:m.notebookId,pageId:m.pageId}).catch(()=>{});
  }

  async function handleAssetNeed(m) {
    const assets=mediaStore();
    for (const id of (m.assetIds||[])) {
      if (assets[id]) {
        try { await sendAsset(id,assets[id],true); } catch (_) { break; }
      }
    }
  }

  function handleObjectLive(m) {
    const page=findPage(m.notebookId,m.pageId);
    if (!page || !m.payload) return;
    if (m.payload.type==='image' && m.payload.image) {
      const incoming=m.payload.image;
      const idx=(page.images||[]).findIndex(i=>i.id===incoming.id);
      if (idx>=0) page.images[idx]=deep(incoming);
      else (page.images||(page.images=[])).push(deep(incoming));
      refresh();
    }
  }

  function strokeBounds(stroke) {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    const add=(x,y)=>{x=Number(x);y=Number(y);if(!Number.isFinite(x)||!Number.isFinite(y))return;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);};
    if (stroke && stroke.shapeData) {
      add(stroke.shapeData.x1*LOGICAL_WIDTH,stroke.shapeData.y1);add(stroke.shapeData.x2*LOGICAL_WIDTH,stroke.shapeData.y2);
    }
    (stroke&&stroke.points||[]).forEach(p=>add((Number(p.x)||0)*LOGICAL_WIDTH,Number(p.y)||0));
    return Number.isFinite(minX)?{minX,minY,maxX,maxY}:null;
  }

  function rotatePoint(x,y,cx,cy,a) {
    const dx=x-cx,dy=y-cy;
    return {x:cx+dx*Math.cos(a)-dy*Math.sin(a),y:cy+dx*Math.sin(a)+dy*Math.cos(a)};
  }

  function materializeShape(stroke) {
    if (!stroke || !stroke.shapeData || !stroke.shapeType) return;
    const d=stroke.shapeData;
    const x1=d.x1*LOGICAL_WIDTH,x2=d.x2*LOGICAL_WIDTH,y1=d.y1,y2=d.y2;
    let pts=[];
    if(stroke.shapeType==='line') pts=[{x:x1,y:y1},{x:x2,y:y2}];
    else if(stroke.shapeType==='circle'){const cx=(x1+x2)/2,cy=(y1+y2)/2,rx=Math.abs(x2-x1)/2,ry=Math.abs(y2-y1)/2;for(let i=0;i<=36;i++){const a=Math.PI*2*i/36;pts.push({x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry});}}
    else if(stroke.shapeType==='rectangle') pts=[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2},{x:x1,y:y1}];
    else if(stroke.shapeType==='triangle') pts=[{x:(x1+x2)/2,y:y1},{x:x1,y:y2},{x:x2,y:y2},{x:(x1+x2)/2,y:y1}];
    stroke.points=pts.map(p=>({x:clamp(p.x/LOGICAL_WIDTH,0,1),y:Math.max(0,p.y),p:.5}));
    delete stroke.shapeData;delete stroke.shapeType;
  }

  function translateStroke(stroke,dx,dy) {
    (stroke.points||[]).forEach(p=>{p.x=clamp((Number(p.x)||0)+dx/LOGICAL_WIDTH,0,1);p.y=Math.max(0,(Number(p.y)||0)+dy);});
    if(stroke.shapeData){stroke.shapeData.x1=clamp(stroke.shapeData.x1+dx/LOGICAL_WIDTH,0,1);stroke.shapeData.x2=clamp(stroke.shapeData.x2+dx/LOGICAL_WIDTH,0,1);stroke.shapeData.y1=Math.max(0,stroke.shapeData.y1+dy);stroke.shapeData.y2=Math.max(0,stroke.shapeData.y2+dy);}
    delete stroke._bounds;stroke._boundsVersion=0;
  }

  function scaleStroke(stroke,bounds,factor) {
    (stroke.points||[]).forEach(p=>{const x=p.x*LOGICAL_WIDTH,y=p.y;p.x=clamp((bounds.minX+(x-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);p.y=Math.max(0,bounds.minY+(y-bounds.minY)*factor);});
    if(stroke.shapeData){const d=stroke.shapeData,x1=d.x1*LOGICAL_WIDTH,x2=d.x2*LOGICAL_WIDTH;d.x1=clamp((bounds.minX+(x1-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);d.x2=clamp((bounds.minX+(x2-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);d.y1=Math.max(0,bounds.minY+(d.y1-bounds.minY)*factor);d.y2=Math.max(0,bounds.minY+(d.y2-bounds.minY)*factor);}
    stroke.width=Math.max(.5,(Number(stroke.width)||4)*factor);delete stroke._bounds;stroke._boundsVersion=0;
  }

  function rotateStroke(stroke,bounds,angle) {
    materializeShape(stroke);
    const a=angle*Math.PI/180;
    (stroke.points||[]).forEach(p=>{const q=rotatePoint(p.x*LOGICAL_WIDTH,p.y,bounds.cx,bounds.cy,a);p.x=clamp(q.x/LOGICAL_WIDTH,0,1);p.y=Math.max(0,q.y);});
    delete stroke._bounds;stroke._boundsVersion=0;
  }

  function captureRemoteSession(page,payload) {
    return {
      bounds:deep(payload.bounds||{}),
      strokes:new Map((page.strokes||[]).filter(s=>(payload.strokeIds||[]).includes(s.id)).map(s=>[s.id,deep(s)])),
      images:new Map((page.images||[]).filter(i=>(payload.imageIds||[]).includes(i.id)).map(i=>[i.id,deep(i)]))
    };
  }

  function applyRemoteTransform(page,session,payload) {
    const t=payload.transform||{},type=payload.type;
    session.strokes.forEach((src,id)=>{
      const stroke=(page.strokes||[]).find(s=>s.id===id);if(!stroke)return;
      Object.keys(stroke).forEach(k=>delete stroke[k]);Object.assign(stroke,deep(src));
      if(type==='move') translateStroke(stroke,t.dx||0,t.dy||0);
      else if(type==='resize') scaleStroke(stroke,session.bounds,t.factor||1);
      else if(type==='rotate') rotateStroke(stroke,session.bounds,t.angle||0);
    });
    session.images.forEach((src,id)=>{
      const image=(page.images||[]).find(i=>i.id===id);if(!image)return;
      Object.keys(image).forEach(k=>delete image[k]);Object.assign(image,deep(src));
      if(type==='move'){image.x=clamp(src.x+(t.dx||0),0,Math.max(0,LOGICAL_WIDTH-src.w));image.y=Math.max(0,src.y+(t.dy||0));}
      else if(type==='resize'){const f=t.factor||1;image.x=session.bounds.minX+(src.x-session.bounds.minX)*f;image.y=Math.max(0,session.bounds.minY+(src.y-session.bounds.minY)*f);image.w=Math.max(40,src.w*f);image.h=Math.max(40,src.h*f);}
      else if(type==='rotate'){const q=rotatePoint(src.x+src.w/2,src.y+src.h/2,session.bounds.cx,session.bounds.cy,(t.angle||0)*Math.PI/180);image.x=q.x-src.w/2;image.y=Math.max(0,q.y-src.h/2);image.rotation=(Number(src.rotation)||0)+(t.angle||0);}
    });
  }

  function handleSelectionTransform(m) {
    const p=m.payload||{},page=findPage(m.notebookId,m.pageId);
    if (!page || !p.sessionId) return;
    const key=m.deviceId+':'+p.sessionId;
    if (p.phase==='start') {
      remoteTransformSessions.set(key,captureRemoteSession(page,p));
      return;
    }
    const session=remoteTransformSessions.get(key);
    if (p.phase==='move' && session) {
      applyRemoteTransform(page,session,p);refresh();
    }
    if (p.phase==='end') remoteTransformSessions.delete(key);
  }

  function renderRemoteSelections() {
    const stage=document.getElementById('nbCanvasStage');
    if (!stage) return;
    let layer=document.getElementById('nbRemoteSelectionLayer');
    if (!layer) {
      layer=document.createElement('div');
      layer.id='nbRemoteSelectionLayer';
      layer.style.cssText='position:absolute;inset:0;z-index:7;pointer-events:none';
      stage.appendChild(layer);
    }
    layer.innerHTML='';
    const ids=currentIds();
    const k=Math.max(.001,stage.getBoundingClientRect().width/LOGICAL_WIDTH);
    remoteSelections.forEach((entry,remoteId)=>{
      if (!entry || entry.notebookId!==ids.notebookId || entry.pageId!==ids.pageId) return;
      const p=entry.payload||{};
      if (Array.isArray(p.lasso) && p.lasso.length>1) {
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 '+stage.clientWidth+' '+stage.clientHeight);
        svg.style.cssText='position:absolute;inset:0;width:100%;height:100%;overflow:visible';
        const poly=document.createElementNS('http://www.w3.org/2000/svg','polyline');
        poly.setAttribute('points',p.lasso.map(pt=>(pt.x*k)+','+(pt.y*k)).join(' '));
        poly.setAttribute('fill','none');poly.setAttribute('stroke','#b05cff');poly.setAttribute('stroke-width','2');poly.setAttribute('stroke-dasharray','7 5');
        svg.appendChild(poly);layer.appendChild(svg);
      }
      if (p.bounds && !p.cleared) {
        const b=p.bounds,box=document.createElement('div');
        box.style.cssText='position:absolute;border:2px dashed #b05cff;background:#b05cff10;border-radius:4px;left:'+(b.minX*k)+'px;top:'+(b.minY*k)+'px;width:'+((b.maxX-b.minX)*k)+'px;height:'+((b.maxY-b.minY)*k)+'px';
        const label=document.createElement('span');
        label.textContent='otra pantalla';
        label.style.cssText='position:absolute;left:0;top:-22px;background:#6c2ca1;color:#fff;border-radius:6px;padding:2px 6px;font:800 10px system-ui;white-space:nowrap';
        box.appendChild(label);layer.appendChild(box);
      }
    });
  }

  function handleSelectionLive(m) {
    const p=m.payload||{};
    if (p.cleared || (!p.active && !(p.strokeIds||[]).length && !(p.imageIds||[]).length && !(p.lasso||[]).length)) remoteSelections.delete(m.deviceId);
    else remoteSelections.set(m.deviceId,{notebookId:m.notebookId,pageId:m.pageId,payload:deep(p),at:Date.now()});
    renderRemoteSelections();
  }

  async function sendNotebookImages(notebookId) {
    const nb=findNotebook(notebookId);
    if (!nb) return;
    for (const page of (nb.pages||[])) {
      if ((page.images||[]).length) {
        try { await sendImagesNow(nb.id,page.id,page.images||[],mediaStore(),true); } catch (_) { break; }
      }
    }
  }

  function handleSync(m) {
    if (!m || m.deviceId===deviceId()) return;
    if (m.kind==='hello') {
      if (m.notebookId) sendNotebookImages(m.notebookId);
      return;
    }
    if (m.kind==='asset-meta') return handleAssetMeta(m);
    if (m.kind==='asset-chunk') return handleAssetChunk(m);
    if (m.kind==='asset-done') return handleAssetDone(m);
    if (m.kind==='asset-need') return handleAssetNeed(m);
    if (m.kind==='images-state') return handleImagesState(m);
    if (m.kind==='object-live') return handleObjectLive(m);
    if (m.kind==='selection-live') return handleSelectionLive(m);
    if (m.kind==='selection-transform') return handleSelectionTransform(m);
  }

  function trackContext() {
    const ids=currentIds();
    const key=(ids.notebookId||'')+':'+(ids.pageId||'');
    if (lastContext && key!==lastContext) pageSwitchCount++;
    lastContext=key;
    renderRemoteSelections();
    updateStatus();
  }

  function installStyles() {
    if (document.getElementById('nbResilienceStyles')) return;
    const style=document.createElement('style');
    style.id='nbResilienceStyles';
    style.textContent='#nbSaveState[data-state="saved"]{background:#0d2b24}#nbSaveState[data-state="syncing"]{background:#332a13}#nbSaveState[data-state="offline"]{background:#35171d}';
    document.head.appendChild(style);
  }

  function boot() {
    if (!api() || !bridge()) { setTimeout(boot,250); return; }
    installStyles();
    connect();
    ensureStatusUi();
    updateStatus();

    window.addEventListener('online',()=>{connect();setTimeout(flushAll,100);updateStatus();});
    window.addEventListener('offline',()=>{disconnectCount++;disconnectChannels();updateStatus();});
    setInterval(connect,1200);
    setInterval(trackContext,500);
    setInterval(()=>{remoteSelections.forEach((v,k)=>{if(Date.now()-(v.at||0)>15000)remoteSelections.delete(k);});renderRemoteSelections();},5000);

    statusObserver=new MutationObserver(()=>ensureStatusUi());
    statusObserver.observe(document.getElementById('nbEditorPanel'),{childList:true});

    window.INFO1_NOTEBOOK_RESILIENCE={
      enqueueBaseEvent,
      onBaseBroadcast,
      onPersistStart,
      onPersistEnd,
      syncImages,
      syncObjectLive,
      syncSelection,
      syncSelectionTransform,
      diagnostics,
      flush:flushAll
    };
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
