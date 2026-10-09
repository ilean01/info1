(() => {
  'use strict';

  const DEVICE_KEY='info1-notebook-device-v1';
  const OPEN_KEY='info1-notebook-open-v1';
  const STATE_KEY='info1-study-center-v4-priority';
  const NAME_KEY='info1-notebook-collab-name-v1';
  const MODE_KEY='info1-notebook-collab-mode-v1';
  const AUTHORS_KEY='info1-notebook-show-authors-v1';
  const LIVE_ACTIVITY_HIDDEN_KEY='info1-notebook-live-activity-hidden-v1';
  const CHANNEL_VERSION='v1';
  const LOGICAL_WIDTH=1000;
  const LOCK_TTL=6500;

  let channel=null;
  let channelClient=null;
  let channelName=null;
  let ready=false;
  let connecting=false;
  let lastPresenceKey='';
  let lastCursorAt=0;
  let remoteCursors=new Map();
  let remoteLocks=new Map();
  let localLocks=new Map();
  let cleanupTimer=null;
  let observer=null;

  function api(){ return window.INFO1_NOTEBOOKS||null; }
  function bridge(){ const a=api(); return a&&a._bridge?a._bridge:null; }
  function resilience(){ return window.INFO1_NOTEBOOK_RESILIENCE||null; }

  function deviceId(){
    const b=bridge();
    if(b&&b.deviceId) return b.deviceId();
    let id=INFO1_LOCAL.getItem(DEVICE_KEY);
    if(!id){ id=(crypto&&crypto.randomUUID)?crypto.randomUUID():'nb-'+Date.now()+'-'+Math.random().toString(36).slice(2); INFO1_LOCAL.setItem(DEVICE_KEY,id); }
    return id;
  }

  function cloud(){
    const status=window.INFO1_CLOUD&&window.INFO1_CLOUD.status;
    return {
      connected:!!(status&&status.connected&&window.INFO1_SUPABASE_CLIENT),
      workspaceId:status&&status.workspaceId?status.workspaceId:null,
      client:window.INFO1_SUPABASE_CLIENT||null
    };
  }

  function openInfo(){
    try{return JSON.parse(INFO1_LOCAL.getItem(OPEN_KEY)||'{}')||{};}catch(_){return{};}
  }

  function currentIds(){
    const a=api(),open=openInfo();
    return {notebookId:a&&a.current?a.current:null,pageId:open.pageId||null};
  }

  function inferName(){
    const saved=INFO1_LOCAL.getItem(NAME_KEY);
    if(saved) return saved;
    const cloudName=window.INFO1_CLOUD?.status?.displayName;
    if(cloudName){
      if(/^el[ií]as$/i.test(cloudName)) return 'Elías';
      if(/^ile(ana)?$/i.test(cloudName)) return 'Ile';
      return String(cloudName);
    }
    try{
      const s=JSON.parse(INFO1_LOCAL.getItem(STATE_KEY)||'{}')||{};
      const p=s.__settings&&s.__settings.p2Profile;
      if(p==='elias') return 'Elías';
      if(p==='ile') return 'Ile';
    }catch(_){}
    return 'Ile';
  }

  function displayName(){ return INFO1_LOCAL.getItem(NAME_KEY)||inferName(); }

  function deviceLabel(){
    const ua=navigator.userAgent||'';
    const touch=navigator.maxTouchPoints||0;
    if(/iPad/i.test(ua)||(/Macintosh/i.test(ua)&&touch>1)) return 'iPad';
    if(/iPhone/i.test(ua)) return 'iPhone';
    if(/Android/i.test(ua)&&!/Mobile/i.test(ua)) return 'Tablet Android';
    if(/Android/i.test(ua)) return 'Android';
    if(/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
    if(/Windows/i.test(ua)) return 'Windows';
    if(/Linux/i.test(ua)) return 'Linux';
    return touch>1?'Tablet':'Navegador';
  }

  function colorFor(seed){
    let h=0;String(seed||'').split('').forEach(ch=>{h=(h*31+ch.charCodeAt(0))%360;});
    return 'hsl('+h+' 76% 58%)';
  }

  function identity(){
    const name=displayName();
    return {id:deviceId(),name,device:deviceLabel(),color:colorFor(name+'-'+deviceId())};
  }

  function isBaseReadOnly(){
    const btn=document.getElementById('nbMode');
    return !!btn&&/solo lectura/i.test(btn.textContent||'');
  }

  function currentMode(){
    if(isBaseReadOnly()) return 'observe';
    return INFO1_LOCAL.getItem(MODE_KEY)==='observe'?'observe':'edit';
  }

  function presencePayload(){
    const ids=currentIds(),me=identity();
    return {
      deviceId:me.id,name:me.name,device:me.device,color:me.color,
      notebookId:ids.notebookId,pageId:ids.pageId,
      mode:currentMode(),at:Date.now()
    };
  }

  function topic(workspaceId){ return 'info1-notebook-collab-'+CHANNEL_VERSION+'-'+workspaceId; }

  function disconnect(){
    if(channel&&channelClient){try{channelClient.removeChannel(channel);}catch(_){}}
    channel=null;channelName=null;channelClient=null;ready=false;connecting=false;
    remoteCursors.clear();remoteLocks.clear();localLocks.clear();
    renderPeople();renderGlobalActivity();renderCursors();renderLocks();
  }

  function connect(){
    const c=cloud();
    if(!c.connected||!c.workspaceId||!c.client||!navigator.onLine){ if(channel) disconnect(); return; }
    const wanted=topic(c.workspaceId);
    if(channel&&channelClient===c.client&&channelName===wanted&&(ready||connecting)) return;
    disconnect();
    channelName=wanted;
    channelClient=c.client;
    connecting=true;
    const thisChannel=c.client.channel(wanted,{
      config:{
        private:true,
        presence:{key:deviceId()},
        broadcast:{self:false,ack:false}
      }
    })
      .on('presence',{event:'sync'},()=>{renderPeople();renderGlobalActivity();})
      .on('presence',{event:'join'},()=>{renderPeople();renderGlobalActivity();})
      .on('presence',{event:'leave'},()=>{renderPeople();renderGlobalActivity();})
      .on('broadcast',{event:'collab'},msg=>handleMessage(msg&&msg.payload?msg.payload:{}));
    channel=thisChannel;
    thisChannel.subscribe(async status=>{
      if(channel!==thisChannel)return;
      ready=status==='SUBSCRIBED';
      if(ready){
        connecting=false;
        try{await thisChannel.track(presencePayload());}catch(_){}
        lastPresenceKey='';
        renderPeople();renderGlobalActivity();
        return;
      }
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
        ready=false;connecting=false;
        try{c.client.removeChannel(thisChannel);}catch(_){}
        if(channel===thisChannel){channel=null;channelName=null;channelClient=null;}
        renderPeople();renderGlobalActivity();
        setTimeout(connect,650);
      }
    });
  }

  function send(kind,payload){
    if(!ready||!channel||!navigator.onLine) return false;
    const body=Object.assign({kind,deviceId:deviceId(),at:Date.now()},payload||{});
    try{channel.send({type:'broadcast',event:'collab',payload:body});return true;}catch(_){return false;}
  }

  function refreshPresence(force){
    if(!ready||!channel) return;
    const p=presencePayload();
    const key=[p.name,p.device,p.notebookId,p.pageId,p.mode].join('|');
    if(!force&&key===lastPresenceKey) return;
    lastPresenceKey=key;
    try{channel.track(p);}catch(_){}
    renderPeople();
  }

  function flattenedPresence(){
    if(!channel||!ready) return [];
    const state=channel.presenceState?channel.presenceState():{};
    const out=[];
    Object.keys(state||{}).forEach(key=>{
      (state[key]||[]).forEach(p=>{if(p&&p.deviceId)out.push(p);});
    });
    const me=presencePayload();
    if(!out.some(p=>p.deviceId===me.deviceId)) out.push(me);
    return out;
  }

  function ensureStyles(){
    if(document.getElementById('nbCollabStyles')) return;
    const s=document.createElement('style');s.id='nbCollabStyles';
    s.textContent=
      '.nb-collab-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;margin:7px 0;border:1px solid #355181;border-radius:13px;background:#0a1730}' +
      '.nb-collab-people{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:100px}.nb-person-chip{display:inline-flex;gap:6px;align-items:center;padding:5px 8px;border-radius:999px;border:1px solid #3b5a8d;background:#10203c;font:800 11px system-ui}.nb-person-dot{width:9px;height:9px;border-radius:999px;box-shadow:0 0 0 2px #ffffff17}.nb-person-mode{opacity:.7}.nb-collab-bar select,.nb-collab-bar input{border:1px solid #38527d;background:#0b152a;color:#fff;border-radius:9px;padding:7px 8px;font-weight:800}' +
      '.nb-cursor-layer{position:absolute;inset:0;z-index:30;pointer-events:none}.nb-remote-cursor{position:absolute;transform:translate(-5px,-5px);transition:left .04s linear,top .04s linear;pointer-events:none}.nb-remote-cursor-dot{width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 7px #0009}.nb-remote-cursor-label{position:absolute;left:12px;top:10px;padding:3px 6px;border-radius:6px;color:#fff;font:800 10px system-ui;white-space:nowrap;box-shadow:0 2px 8px #0007}' +
      '.nb-author-layer{position:absolute;inset:0;z-index:6;pointer-events:none}.nb-author-mark{position:absolute;transform:translate(-50%,-50%);width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 5px #0008}.nb-author-mark span{display:none;position:absolute;left:12px;top:-3px;padding:2px 5px;border-radius:5px;background:#071126dd;color:#fff;font:800 9px system-ui;white-space:nowrap}.nb-author-mark:hover span{display:block}' +
      '.nb-remote-locked{outline:3px solid #f59e0b!important;outline-offset:3px!important}.nb-collab-toast{position:fixed;right:18px;bottom:82px;z-index:60000;padding:10px 13px;border-radius:11px;background:#1f2d47;color:#fff;border:1px solid #5572a3;box-shadow:0 12px 38px #0009;font-weight:850;max-width:min(360px,calc(100vw - 36px))}' +
      '.nb-live-activity{position:fixed;left:max(14px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483002;display:flex;align-items:center;gap:9px;max-width:min(520px,calc(100vw - 28px));padding:9px 10px;border:1px solid #315a89;border-radius:15px;background:#07172eee;color:#eef6ff;box-shadow:0 12px 40px #0007;backdrop-filter:blur(16px);font:800 12px/1.25 system-ui;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation}' +
      '.nb-live-activity *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}.nb-live-activity .who{min-width:0;display:flex;align-items:center;gap:7px}.nb-live-activity .dot{width:10px;height:10px;border-radius:999px;flex:0 0 auto;box-shadow:0 0 0 3px #ffffff16}.nb-live-activity .txt{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nb-live-activity button{border:0;border-radius:10px;padding:7px 9px;background:#2563eb;color:#fff;font-weight:900;cursor:pointer;white-space:nowrap;touch-action:manipulation}.nb-live-activity .close{background:#334155}' +
      '.nb-live-activity-toggle{position:fixed;left:max(14px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483002;border:1px solid #315a89;border-radius:999px;background:#07172eee;color:#eef6ff;box-shadow:0 10px 30px #0007;padding:9px 11px;font:900 12px system-ui;cursor:pointer;backdrop-filter:blur(14px);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation}' +
      '@media(max-width:640px){.nb-live-activity{right:10px;left:10px;bottom:max(10px,env(safe-area-inset-bottom));max-width:none}.nb-live-activity .txt{font-size:11px}.nb-live-activity-toggle{left:10px;bottom:max(10px,env(safe-area-inset-bottom))}}';
    document.head.appendChild(s);
  }

  function ensureUi(){
    const panel=document.getElementById('nbEditorPanel');
    if(!panel||panel.classList.contains('hidden')) return;
    ensureStyles();
    let bar=document.getElementById('nbCollabBar');
    if(!bar){
      bar=document.createElement('div');bar.id='nbCollabBar';bar.className='nb-collab-bar';
      bar.innerHTML=
        '<strong>👥 En este cuaderno</strong>'+
        '<div id="nbCollabPeople" class="nb-collab-people"></div>'+
        '<label>Yo <select id="nbCollabName"><option value="Ile">Ile</option><option value="Elías">Elías</option><option value="Otro">Otro…</option></select></label>'+
        '<label>Modo <select id="nbCollabMode"><option value="edit">✏️ Editar</option><option value="observe">👀 Observar</option></select></label>'+
        '<button id="nbShowAuthors" class="nb-btn" type="button">🎨 Autores</button>'+
        '<span id="nbCollabDevice" class="small"></span>';
      const top=panel.querySelector('.nb-editor-top');
      if(top&&top.parentNode) top.parentNode.insertBefore(bar,top.nextSibling);
      else panel.prepend(bar);

      const nameSel=document.getElementById('nbCollabName');
      nameSel.value=['Ile','Elías'].includes(displayName())?displayName():'Otro';
      nameSel.onchange=()=>{
        let next=nameSel.value;
        if(next==='Otro'){
          next=prompt('Nombre que querés mostrar en el cuaderno:',displayName())||displayName();
        }
        INFO1_LOCAL.setItem(NAME_KEY,next);
        nameSel.value=['Ile','Elías'].includes(next)?next:'Otro';
        refreshPresence(true);renderPeople();renderAuthors();
      };

      const modeSel=document.getElementById('nbCollabMode');
      modeSel.value=currentMode();
      modeSel.onchange=()=>setMode(modeSel.value);

      document.getElementById('nbShowAuthors').onclick=()=>{
        const next=INFO1_LOCAL.getItem(AUTHORS_KEY)!=='1';
        INFO1_LOCAL.setItem(AUTHORS_KEY,next?'1':'0');
        renderAuthors();updateAuthorsButton();
      };
    }
    const device=document.getElementById('nbCollabDevice');if(device)device.textContent='📱 '+deviceLabel();
    const modeSel=document.getElementById('nbCollabMode');if(modeSel)modeSel.value=isBaseReadOnly()?'observe':'edit';
    updateAuthorsButton();
    ensureLayers();
    bindCursorTracking();
    renderPeople();renderGlobalActivity();renderCursors();renderAuthors();renderLocks();
  }

  function updateAuthorsButton(){
    const b=document.getElementById('nbShowAuthors');if(!b)return;
    const on=INFO1_LOCAL.getItem(AUTHORS_KEY)==='1';
    b.classList.toggle('active',on);b.textContent=on?'🎨 Autores: sí':'🎨 Autores';
  }

  function setMode(mode){
    mode=mode==='observe'?'observe':'edit';
    INFO1_LOCAL.setItem(MODE_KEY,mode);
    const a=api(),ids=currentIds();
    if(a&&ids.notebookId&&a.open){
      a.open(ids.notebookId,ids.pageId,mode==='observe',false);
      setTimeout(()=>{ensureUi();refreshPresence(true);},80);
    }else refreshPresence(true);
  }

  function ensureLayers(){
    const stage=document.getElementById('nbCanvasStage');if(!stage)return;
    if(!document.getElementById('nbCursorLayer')){
      const l=document.createElement('div');l.id='nbCursorLayer';l.className='nb-cursor-layer';stage.appendChild(l);
    }
    if(!document.getElementById('nbAuthorLayer')){
      const l=document.createElement('div');l.id='nbAuthorLayer';l.className='nb-author-layer';stage.appendChild(l);
    }
  }

  function notebookTitle(id){
    const a=api();
    if(!a||typeof a.list!=='function'||!id)return '';
    const nb=a.list().find(x=>x&&x.id===id);
    return nb?.title||'';
  }

  function remoteParticipants(){
    const me=deviceId();
    const dedup=new Map();
    flattenedPresence().forEach(p=>{
      if(!p||!p.deviceId||p.deviceId===me)return;
      dedup.set(p.deviceId,p);
    });
    return Array.from(dedup.values()).sort((a,b)=>(Number(b.at)||0)-(Number(a.at)||0));
  }

  function openRemoteParticipant(p){
    if(!p?.notebookId)return;
    const a=api(),b=bridge();
    const tryOpen=()=>{
      if(a&&typeof a.list==='function'&&a.list().some(nb=>nb&&nb.id===p.notebookId)){
        if(typeof a.setFollow==='function')a.setFollow(true);
        if(typeof a.open==='function')a.open(p.notebookId,p.pageId||null,true,false);
        return true;
      }
      return false;
    };
    if(tryOpen())return;
    if(b&&typeof b.broadcast==='function')b.broadcast('snapshot-request',{notebookId:p.notebookId});
    toast('Cargando la pizarra compartida…');
    setTimeout(()=>{if(!tryOpen())toast('Todavía no llegó esa pizarra. Probá de nuevo en un segundo.');},550);
  }

  function liveActivityHidden(){
    return INFO1_LOCAL.getItem(LIVE_ACTIVITY_HIDDEN_KEY)==='1';
  }

  function setLiveActivityHidden(hidden){
    INFO1_LOCAL.setItem(LIVE_ACTIVITY_HIDDEN_KEY,hidden?'1':'0');
    renderGlobalActivity();
  }

  function renderGlobalActivity(){
    let el=document.getElementById('nbLiveActivity');
    let toggle=document.getElementById('nbLiveActivityToggle');
    const remotes=remoteParticipants().filter(p=>p.notebookId);
    if(!ready||!remotes.length){
      el?.remove();
      toggle?.remove();
      return;
    }
    const p=remotes[0];

    if(liveActivityHidden()){
      el?.remove();
      if(!toggle){
        toggle=document.createElement('button');
        toggle.type='button';
        toggle.id='nbLiveActivityToggle';
        toggle.className='nb-live-activity-toggle';
        toggle.title='Mostrar actividad compartida';
        document.body.appendChild(toggle);
      }
      toggle.textContent='👥 En vivo';
      toggle.onclick=()=>setLiveActivityHidden(false);
      return;
    }

    toggle?.remove();
    if(!el){
      el=document.createElement('div');
      el.id='nbLiveActivity';
      el.className='nb-live-activity';
      document.body.appendChild(el);
      el.addEventListener('selectstart',e=>e.preventDefault(),true);
      el.addEventListener('contextmenu',e=>e.preventDefault(),true);
    }
    const title=notebookTitle(p.notebookId)||'una pizarra compartida';
    const action=p.mode==='observe'?'observando':'trabajando';
    el.innerHTML=
      '<div class="who"><i class="dot" style="background:'+escapeHtml(p.color||colorFor(p.deviceId))+'"></i>'+
      '<div class="txt">🟢 <b>'+escapeHtml(p.name||'Otra persona')+'</b> · '+escapeHtml(action)+' en <b>'+escapeHtml(title)+'</b> · '+escapeHtml(p.device||'')+'</div></div>'+
      '<button type="button" data-live-open>Seguir en vivo</button>'+
      '<button type="button" class="close" data-live-close title="Ocultar">×</button>';
    el.querySelector('[data-live-open]').onclick=()=>openRemoteParticipant(p);
    el.querySelector('[data-live-close]').onclick=()=>setLiveActivityHidden(true);
  }

  function renderPeople(){
    const root=document.getElementById('nbCollabPeople');if(!root)return;
    const ids=currentIds();
    const people=flattenedPresence().filter(p=>p.notebookId&&p.notebookId===ids.notebookId);
    const dedup=new Map();
    people.forEach(p=>dedup.set(p.deviceId,p));
    const arr=Array.from(dedup.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name),'es'));
    if(!arr.length){root.innerHTML='<span class="small">Solo vos</span>';renderGlobalActivity();return;}
    root.innerHTML=arr.map(p=>
      '<span class="nb-person-chip" title="'+escapeHtml(p.device||'Dispositivo')+' · '+escapeHtml(p.mode==='observe'?'Observando':'Editando')+'">'+
      '<i class="nb-person-dot" style="background:'+escapeHtml(p.color||colorFor(p.deviceId))+'"></i>'+
      escapeHtml(p.name||'Persona')+' <span class="nb-person-mode">'+(p.mode==='observe'?'👀':'✏️')+' '+escapeHtml(p.device||'')+'</span></span>'
    ).join('');
    renderGlobalActivity();
  }

  function escapeHtml(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  function bindCursorTracking(){
    const stage=document.getElementById('nbCanvasStage');
    if(!stage||stage.dataset.collabCursorBound==='1') return;
    stage.dataset.collabCursorBound='1';
    stage.addEventListener('pointermove',e=>{
      const a=api();
      if(a&&a.isDrawing)return;
      if(Date.now()-lastCursorAt<48)return;
      lastCursorAt=Date.now();
      const r=stage.getBoundingClientRect(),k=Math.max(.001,r.width/LOGICAL_WIDTH),ids=currentIds();
      if(!ids.notebookId||!ids.pageId)return;
      send('cursor',{
        notebookId:ids.notebookId,pageId:ids.pageId,
        x:(e.clientX-r.left)/k,y:(e.clientY-r.top)/k,
        pointerType:e.pointerType||'mouse',name:displayName(),device:deviceLabel(),color:identity().color
      });
    },true);
    stage.addEventListener('pointerleave',()=>{
      const ids=currentIds();send('cursor-hide',{notebookId:ids.notebookId,pageId:ids.pageId});
    },true);
  }

  function renderCursors(){
    ensureLayers();
    const root=document.getElementById('nbCursorLayer'),stage=document.getElementById('nbCanvasStage');
    if(!root||!stage)return;
    const ids=currentIds(),k=Math.max(.001,stage.getBoundingClientRect().width/LOGICAL_WIDTH);
    root.innerHTML='';
    remoteCursors.forEach((c,id)=>{
      if(Date.now()-(c.at||0)>3000||c.notebookId!==ids.notebookId||c.pageId!==ids.pageId)return;
      const el=document.createElement('div');el.className='nb-remote-cursor';
      el.style.left=(c.x*k)+'px';el.style.top=(c.y*k)+'px';
      el.innerHTML='<div class="nb-remote-cursor-dot" style="background:'+escapeHtml(c.color||colorFor(id))+'"></div>'+
        '<div class="nb-remote-cursor-label" style="background:'+escapeHtml(c.color||colorFor(id))+'">'+escapeHtml(c.name||'Otra persona')+' · '+escapeHtml(c.device||'')+'</div>';
      root.appendChild(el);
    });
  }

  function renderAuthors(){
    ensureLayers();
    const root=document.getElementById('nbAuthorLayer'),stage=document.getElementById('nbCanvasStage'),b=bridge();
    if(!root||!stage||!b||!b.currentPage)return;
    root.innerHTML='';
    if(INFO1_LOCAL.getItem(AUTHORS_KEY)!=='1')return;
    const page=b.currentPage();if(!page)return;
    const k=Math.max(.001,stage.getBoundingClientRect().width/LOGICAL_WIDTH);
    let count=0;
    (page.strokes||[]).forEach(stroke=>{
      if(count>=220||!stroke||!stroke.author||!stroke.points||!stroke.points.length)return;
      const p=stroke.points[0],a=stroke.author;
      const el=document.createElement('div');el.className='nb-author-mark';
      el.style.left=((Number(p.x)||0)*LOGICAL_WIDTH*k)+'px';el.style.top=((Number(p.y)||0)*k)+'px';
      el.style.background=a.color||colorFor(a.id||a.name);
      el.title='Trazo de '+(a.name||'otra persona')+' · '+(a.device||'');
      el.innerHTML='<span>'+escapeHtml(a.name||'')+'</span>';
      root.appendChild(el);count++;
    });
  }

  function lockWinner(a,b){
    const ta=Number(a.startedAt)||0,tb=Number(b.startedAt)||0;
    if(Math.abs(ta-tb)>20)return ta<tb?a:b;
    return String(a.owner)<String(b.owner)?a:b;
  }

  function lockKey(type,id){return type+':'+id;}

  function lockedByOther(key){
    const l=remoteLocks.get(key);
    if(!l)return null;
    if((l.expiresAt||0)<Date.now()){remoteLocks.delete(key);return null;}
    return l.owner!==deviceId()?l:null;
  }

  function claimObject(key){
    if(!key)return true;
    const other=lockedByOther(key);
    if(other){toast((other.name||'Otra persona')+' está editando este elemento');return false;}
    const me=identity(),lock={key,owner:me.id,name:me.name,device:me.device,startedAt:Date.now(),expiresAt:Date.now()+LOCK_TTL};
    localLocks.set(key,lock);send('lock',lock);renderLocks();return true;
  }

  function claimObjects(keys){
    keys=Array.from(new Set((keys||[]).filter(Boolean)));
    const blocked=keys.map(lockedByOther).find(Boolean);
    if(blocked){toast((blocked.name||'Otra persona')+' está editando parte de esta selección');return false;}
    const me=identity(),startedAt=Date.now();
    keys.forEach(key=>{const lock={key,owner:me.id,name:me.name,device:me.device,startedAt,expiresAt:Date.now()+LOCK_TTL};localLocks.set(key,lock);send('lock',lock);});
    renderLocks();return true;
  }

  function ownsObject(key){const l=localLocks.get(key);return !!l&&l.owner===deviceId()&&(l.expiresAt||0)>Date.now();}
  function ownsObjects(keys){return (keys||[]).every(ownsObject);}

  function releaseObject(key){
    const l=localLocks.get(key);if(!l)return;
    localLocks.delete(key);send('unlock',{key,owner:deviceId()});renderLocks();
  }
  function releaseObjects(keys){(keys||[]).forEach(releaseObject);}

  function refreshLocalLocks(){
    if(!localLocks.size)return;
    const now=Date.now();
    localLocks.forEach((l,key)=>{
      if(l.expiresAt-now<2600){l.expiresAt=now+LOCK_TTL;send('lock',l);}
    });
  }

  function renderLocks(){
    document.querySelectorAll('.nb-image-object[data-image-id]').forEach(el=>{
      el.classList.toggle('nb-remote-locked',!!lockedByOther(lockKey('image',el.dataset.imageId)));
    });
  }

  function handleMessage(m){
    if(!m||m.deviceId===deviceId())return;
    if(m.kind==='cursor'){
      remoteCursors.set(m.deviceId,Object.assign({},m,{at:Date.now()}));renderCursors();return;
    }
    if(m.kind==='cursor-hide'){remoteCursors.delete(m.deviceId);renderCursors();return;}
    if(m.kind==='lock'&&m.key){
      const incoming={key:m.key,owner:m.owner||m.deviceId,name:m.name,device:m.device,startedAt:m.startedAt||m.at,expiresAt:m.expiresAt||Date.now()+LOCK_TTL};
      const local=localLocks.get(m.key);
      if(local){
        const winner=lockWinner(local,incoming);
        if(winner.owner!==local.owner){
          localLocks.delete(m.key);remoteLocks.set(m.key,incoming);
          toast((incoming.name||'Otra persona')+' tomó la edición de este elemento');
        }else{
          remoteLocks.delete(m.key);
        }
      }else remoteLocks.set(m.key,incoming);
      renderLocks();return;
    }
    if(m.kind==='unlock'&&m.key){
      const l=remoteLocks.get(m.key);if(l&&(!m.owner||l.owner===m.owner))remoteLocks.delete(m.key);
      renderLocks();return;
    }
  }

  function toast(text){
    const old=document.querySelector('.nb-collab-toast');if(old)old.remove();
    const el=document.createElement('div');el.className='nb-collab-toast';el.textContent=text;document.body.appendChild(el);
    setTimeout(()=>el.remove(),1900);
  }

  function authorStamp(){return identity();}

  function contextTick(){
    ensureUi();
    connect();
    refreshPresence(false);
    refreshLocalLocks();
    renderCursors();renderAuthors();renderLocks();
    const cutoff=Date.now()-3500;
    remoteCursors.forEach((v,k)=>{if((v.at||0)<cutoff)remoteCursors.delete(k);});
    remoteLocks.forEach((v,k)=>{if((v.expiresAt||0)<Date.now())remoteLocks.delete(k);});
  }

  function boot(){
    if(!api()||!bridge()){setTimeout(boot,250);return;}
    ensureStyles();connect();ensureUi();refreshPresence(true);
    window.addEventListener('online',()=>{connect();setTimeout(()=>refreshPresence(true),100);});
    window.addEventListener('offline',()=>{ready=false;renderPeople();renderGlobalActivity();});
    window.addEventListener('info1:workspace-changed',()=>{disconnect();setTimeout(()=>{connect();refreshPresence(true);renderGlobalActivity();},120);});
    observer=new MutationObserver(mutations=>{
      const onlyOwn=mutations.length&&mutations.every(m=>{
        const target=m.target&&m.target.nodeType===1?m.target:null;
        return !!(target&&target.closest&&target.closest('#nbCollabBar,#nbCursorLayer,#nbAuthorLayer'));
      });
      if(!onlyOwn) ensureUi();
    });
    observer.observe(document.getElementById('nbEditorPanel'),{childList:true});
    cleanupTimer=setInterval(contextTick,800);

    window.INFO1_NOTEBOOK_COLLABORATION={
      identity,
      authorStamp,
      claimObject,
      claimObjects,
      ownsObject,
      ownsObjects,
      releaseObject,
      releaseObjects,
      isLockedByOther:key=>!!lockedByOther(key),
      refresh:()=>{renderPeople();renderGlobalActivity();renderCursors();renderAuthors();renderLocks();},
      setMode,
      get participants(){return flattenedPresence();},
      get ready(){return ready;}
    };
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
