(() => {
  'use strict';

  const cfg = window.INFO1_SUPABASE;
  if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
    console.warn('INFO1 Cloud Sync: Supabase no disponible.');
    return;
  }

  const KEY = 'info1-study-center-v4-priority';
  const RECOVERY_KEY = KEY + '-v15-recovery';
  const UNSYNCED_KEY = KEY + '-v15-unsynced';
  const OFFLINE_KEY = 'info1-cloud-offline';
  const RELOAD_KEY = 'info1-cloud-reloaded-v2';
  const sb = window.supabase.createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
  });
  window.INFO1_SUPABASE_CLIENT = sb;

  let session = null;
  let membership = null;
  let workspace = null;
  let remoteRevision = 0;
  let busy = false;
  let dirty = false;
  let timer = null;
  let monitor = null;
  let lastRaw = '';
  let channel = null;

  const parse = (raw, fallback={}) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
  const localState = () => parse(localStorage.getItem(KEY), {});
  const stateTime = s => {
    const t = new Date(s?.__settings?.lastSavedAt || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const normalState = s => s && typeof s === 'object' && !Array.isArray(s) ? s : {};

  function meaningful(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    const set = s.__settings || {};
    if (set.examDateTimeP1 || set.examDateTimeP2 || set.recoveryDateTimeP2) return true;
    if (s.__flashcards && Object.keys(s.__flashcards).length) return true;
    if (s.__flashcardsP2 && (Object.keys(s.__flashcardsP2.ile||{}).length || Object.keys(s.__flashcardsP2.elias||{}).length)) return true;
    for (const [k,v] of Object.entries(s)) {
      if (!/^(?:\d+:\d+|p2:(?:ile|elias):\d+:\d+)$/.test(k) || !v || typeof v !== 'object') continue;
      if ((v.notes||'').trim() || v.review || v.practice || (v.priority && v.priority !== 'normal')) return true;
      if ((v.sesiones||[]).length || (v.errores||[]).length || (v.historialEstados||[]).length) return true;
      if (Object.values(v.skills||{}).some(x => x === 'known' || x === 'some')) return true;
      if (!k.startsWith('p2:') && (v.status === 'known' || v.status === 'some')) return true;
    }
    return false;
  }

  function addStyles() {
    if (document.getElementById('info1CloudStyles')) return;
    const s = document.createElement('style');
    s.id = 'info1CloudStyles';
    s.textContent = `
      #info1CloudBadge{position:fixed;right:16px;bottom:16px;z-index:9997;border:1px solid #475569;background:rgba(9,16,31,.96);color:#eef2ff;border-radius:15px;padding:10px 12px;box-shadow:0 14px 40px #0007;font:700 12px/1.25 system-ui;max-width:min(390px,calc(100vw - 32px));backdrop-filter:blur(12px)}
      #info1CloudBadge.ok{border-color:#22c55e88}#info1CloudBadge.warn{border-color:#f59e0b99}#info1CloudBadge.bad{border-color:#ef444499}
      #info1CloudBadge button{margin-left:8px;border:0;border-radius:9px;padding:6px 9px;background:#334155;color:#fff;font-weight:800;cursor:pointer}
      #info1CloudOverlay{position:fixed;inset:0;z-index:10000;background:#020617dd;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(10px)}
      #info1CloudCard{width:min(520px,100%);background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:22px;padding:22px;box-shadow:0 24px 80px #0009;font-family:system-ui}
      #info1CloudCard h2{margin:0 0 8px}#info1CloudCard p{color:#cbd5e1;line-height:1.45}
      #info1CloudCard label{display:block;margin:12px 0 5px;font-weight:800;font-size:13px}
      #info1CloudCard input{width:100%;box-sizing:border-box;border:1px solid #475569;background:#020617;color:#fff;border-radius:11px;padding:11px 12px}
      #info1CloudCard .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}#info1CloudCard button{border:0;border-radius:11px;padding:10px 13px;background:#2563eb;color:#fff;font-weight:800;cursor:pointer}
      #info1CloudCard button.secondary{background:#334155}#info1CloudCard button.ghost{background:transparent;border:1px solid #475569}
      #info1CloudMsg{min-height:20px;margin-top:10px;color:#fbbf24;font-size:13px;white-space:pre-wrap}#info1CloudCard code{word-break:break-all;color:#bfdbfe}
    `;
    document.head.appendChild(s);
  }

  function badge(text, kind='ok', actions='') {
    addStyles();
    let b = document.getElementById('info1CloudBadge');
    if (!b) { b = document.createElement('div'); b.id='info1CloudBadge'; document.body.appendChild(b); }
    b.className = kind;
    b.innerHTML = `<span>${text}</span>${actions}`;
    return b;
  }

  async function persistToLocalServer(state) {
    if (location.protocol === 'file:' || !window.INFO1_BOOT) return false;
    try {
      let cur = await fetch('/api/state',{cache:'no-store'}).then(r => r.ok ? r.json() : null);
      if (!cur) return false;
      if (JSON.stringify(cur.state||{}) === JSON.stringify(state)) return true;
      let r = await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,expectedRevision:Number(cur.revision||0)})});
      if (r.status === 409) {
        cur = await fetch('/api/state',{cache:'no-store'}).then(x => x.ok ? x.json() : null);
        if (!cur) return false;
        r = await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,expectedRevision:Number(cur.revision||0)})});
      }
      return r.ok;
    } catch(e) {
      console.warn('INFO1: no se pudo actualizar state.json local', e);
      return false;
    }
  }

  async function installState(state, reason='cloud') {
    const next = normalState(state);
    try {
      const oldRaw = localStorage.getItem(KEY);
      const old = localState();
      if (oldRaw && JSON.stringify(old) !== JSON.stringify(next) && meaningful(old)) localStorage.setItem(RECOVERY_KEY, oldRaw);
      localStorage.setItem(KEY, JSON.stringify(next));
      localStorage.removeItem(UNSYNCED_KEY);
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify({at:Date.now(),reason}));
      await persistToLocalServer(next);
      location.reload();
    } catch(e) {
      console.error(e);
      badge('☁️ No pude restaurar en este navegador · la nube sigue intacta','bad');
    }
  }

  function showAuth() {
    addStyles();
    if (document.getElementById('info1CloudOverlay')) return;
    const o = document.createElement('div');
    o.id='info1CloudOverlay';
    o.innerHTML=`<div id="info1CloudCard"><h2>☁️ INFO 1 · iniciar sesión</h2><p>Tu progreso se guarda en este dispositivo y también en Supabase.</p><label>Email</label><input id="info1AuthEmail" type="email" autocomplete="email"><label>Contraseña</label><input id="info1AuthPassword" type="password" autocomplete="current-password"><div class="row"><button id="info1Login">Entrar</button><button id="info1Signup" class="secondary">Crear cuenta</button><button id="info1Offline" class="ghost">Seguir solo local</button></div><div id="info1CloudMsg"></div></div>`;
    document.body.appendChild(o);
    const msg=o.querySelector('#info1CloudMsg'), email=o.querySelector('#info1AuthEmail'), pass=o.querySelector('#info1AuthPassword');
    async function go(signup=false){
      msg.textContent='Procesando…';
      const credentials={email:email.value.trim(),password:pass.value};
      if(!credentials.email||!credentials.password){msg.textContent='Completá email y contraseña.';return;}
      const res=signup?await sb.auth.signUp(credentials):await sb.auth.signInWithPassword(credentials);
      if(res.error){msg.textContent=res.error.message;return;}
      if(!res.data.session){msg.textContent='Cuenta creada. Revisá tu correo si pide confirmación.';return;}
      o.remove();await initCloud(res.data.session);
    }
    o.querySelector('#info1Login').onclick=()=>go(false);
    o.querySelector('#info1Signup').onclick=()=>go(true);
    o.querySelector('#info1Offline').onclick=()=>{localStorage.setItem(OFFLINE_KEY,'1');o.remove();showOfflineBadge();};
  }

  function showOfflineBadge(){
    badge('💾 Solo local · sin sincronización','warn','<button id="info1EnableCloud">Activar nube</button>');
    document.getElementById('info1EnableCloud').onclick=()=>{localStorage.removeItem(OFFLINE_KEY);showAuth();};
  }

  async function memberships(){
    const {data,error}=await sb.from('info1_members').select('workspace_id,display_name,role,info1_workspaces(id,name,created_by,updated_at)').eq('user_id',session.user.id);
    if(error)throw error;return data||[];
  }

  async function createWorkspace(){
    const {data:w,error:e1}=await sb.from('info1_workspaces').insert({name:'INFO 1',created_by:session.user.id}).select('id,name,created_by,updated_at').single();
    if(e1)throw e1;
    const display=session.user.user_metadata?.name||session.user.email?.split('@')[0]||'Estudiante';
    const {error:e2}=await sb.from('info1_members').insert({workspace_id:w.id,user_id:session.user.id,display_name:display,role:'owner'});if(e2)throw e2;
    return {workspace_id:w.id,display_name:display,role:'owner',info1_workspaces:w};
  }

  async function joinWorkspace(id){
    id=String(id||'').trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('Código de espacio inválido.');
    const display=session.user.user_metadata?.name||session.user.email?.split('@')[0]||'Estudiante';
    const {error}=await sb.from('info1_members').insert({workspace_id:id,user_id:session.user.id,display_name:display,role:'editor'});if(error)throw error;
  }

  async function chooseWorkspace(){
    let list=await memberships();if(list.length)return list[0];
    return await new Promise(resolve=>{
      addStyles();const o=document.createElement('div');o.id='info1CloudOverlay';
      o.innerHTML=`<div id="info1CloudCard"><h2>📚 Espacio INFO 1</h2><p>Creá el espacio si sos la primera persona, o pegá el código para unirte.</p><label>Código</label><input id="info1JoinCode"><div class="row"><button id="info1CreateWs">Crear espacio</button><button id="info1JoinWs" class="secondary">Unirme</button></div><div id="info1CloudMsg"></div></div>`;document.body.appendChild(o);
      const msg=o.querySelector('#info1CloudMsg');
      o.querySelector('#info1CreateWs').onclick=async()=>{try{const m=await createWorkspace();o.remove();resolve(m);}catch(e){msg.textContent=e.message;}};
      o.querySelector('#info1JoinWs').onclick=async()=>{try{await joinWorkspace(o.querySelector('#info1JoinCode').value);list=await memberships();o.remove();resolve(list[0]);}catch(e){msg.textContent=e.message;}};
    });
  }

  async function initialPull(){
    const {data,error}=await sb.from('info1_state').select('state,revision,updated_at,updated_by').eq('workspace_id',workspace.id).maybeSingle();
    if(error)throw error;
    const local=localState();
    if(!data){
      const {data:created,error:e}=await sb.from('info1_state').insert({workspace_id:workspace.id,state:local,revision:1,updated_by:session.user.id}).select('revision').single();if(e)throw e;
      remoteRevision=Number(created.revision||1);return 'equal';
    }
    remoteRevision=Number(data.revision||1);
    const remote=normalState(data.state);
    if(JSON.stringify(remote)===JSON.stringify(local))return 'equal';

    const rm=meaningful(remote), lm=meaningful(local);
    if(rm&&!lm){badge('☁️ Recuperando tu progreso guardado…','warn');await installState(remote,'cloud-real-progress');return 'reload';}
    if(!rm&&lm){dirty=true;return 'local-newer';}

    if(rm&&lm){
      const rt=stateTime(remote)||new Date(data.updated_at||0).getTime()||0, lt=stateTime(local);
      if(rt>lt+1500){if(confirm('Hay una copia más nueva en la nube. ¿Cargarla?\n\nLa copia local se conservará como recuperación.')){await installState(remote,'cloud-newer');return 'reload';}return 'keep-local';}
      if(lt>rt+1500){dirty=true;return 'local-newer';}
      badge('⚠️ Hay dos copias distintas','warn','<button id="info1UseCloud">Usar nube</button>');
      document.getElementById('info1UseCloud').onclick=()=>installState(remote,'cloud-conflict');
      return 'conflict';
    }

    await installState(remote,'cloud-default');return 'reload';
  }

  async function push(){
    if(!dirty||busy||!session||!workspace)return;
    busy=true;dirty=false;
    try{
      const local=localState();
      const {data:cur,error}=await sb.from('info1_state').select('state,revision').eq('workspace_id',workspace.id).maybeSingle();if(error)throw error;
      const cloud=normalState(cur?.state), rev=Number(cur?.revision||0);
      if(meaningful(cloud)&&!meaningful(local)){await installState(cloud,'empty-guard');return;}
      if(remoteRevision&&rev>remoteRevision){dirty=true;badge('🔄 Hay cambios nuevos en la nube','warn','<button id="info1PullNow">Cargar</button>');document.getElementById('info1PullNow').onclick=()=>installState(cloud,'remote-changed');return;}
      const res=cur
        ? await sb.from('info1_state').update({state:local,revision:rev+1,updated_by:session.user.id,updated_at:new Date().toISOString()}).eq('workspace_id',workspace.id).eq('revision',rev).select('revision').maybeSingle()
        : await sb.from('info1_state').insert({workspace_id:workspace.id,state:local,revision:1,updated_by:session.user.id}).select('revision').single();
      if(res.error)throw res.error;if(!res.data){dirty=true;return;}
      remoteRevision=Number(res.data.revision||rev+1);localStorage.removeItem(UNSYNCED_KEY);lastRaw=localStorage.getItem(KEY)||'';
      showSyncedBadge();
    }catch(e){console.error(e);dirty=true;badge('☁️ Sin conexión · guardado local','warn','<button id="info1RetryCloud">Reintentar</button>');document.getElementById('info1RetryCloud').onclick=()=>push();}
    finally{busy=false;if(dirty){clearTimeout(timer);timer=setTimeout(push,3000);}}
  }

  function startMonitor(){
    if(monitor)return;lastRaw=localStorage.getItem(KEY)||'';
    monitor=setInterval(()=>{const raw=localStorage.getItem(KEY)||'';if(raw===lastRaw)return;lastRaw=raw;dirty=true;clearTimeout(timer);timer=setTimeout(push,900);},1200);
  }

  function subscribe(){
    if(channel)sb.removeChannel(channel);
    channel=sb.channel('info1-state-'+workspace.id).on('postgres_changes',{event:'UPDATE',schema:'public',table:'info1_state',filter:`workspace_id=eq.${workspace.id}`},payload=>{
      const rev=Number(payload.new?.revision||0);if(rev<=remoteRevision)return;remoteRevision=rev;
      badge('🔄 Hay progreso nuevo de otro dispositivo','warn','<button id="info1ReloadCloud">Cargar</button>');
      document.getElementById('info1ReloadCloud').onclick=()=>installState(normalState(payload.new.state),'realtime');
    }).subscribe();
  }

  function showSyncedBadge(){
    badge(`☁️ Sincronizado · ${membership?.display_name||session?.user?.email||'INFO 1'}`,'ok','<button id="info1CloudMenu">Nube</button>');
    const b=document.getElementById('info1CloudMenu');if(b)b.onclick=showPanel;
  }

  function showPanel(){
    if(document.getElementById('info1CloudOverlay'))return;
    const o=document.createElement('div');o.id='info1CloudOverlay';
    o.innerHTML=`<div id="info1CloudCard"><h2>☁️ Sincronización INFO 1</h2><p><b>Usuario:</b> ${membership?.display_name||session.user.email}</p><p><b>Espacio:</b> ${workspace.name}</p><p><b>Código para compartir:</b><br><code>${workspace.id}</code></p><div class="row"><button id="info1ForcePull">Cargar nube</button><button id="info1ForcePush" class="secondary">Guardar ahora</button><button id="info1CloseCloud" class="ghost">Cerrar</button><button id="info1LogoutCloud" class="ghost">Salir</button></div><div id="info1CloudMsg"></div></div>`;document.body.appendChild(o);const msg=o.querySelector('#info1CloudMsg');
    o.querySelector('#info1ForcePull').onclick=async()=>{const {data,error}=await sb.from('info1_state').select('state').eq('workspace_id',workspace.id).single();if(error){msg.textContent=error.message;return;}if(confirm('¿Reemplazar este dispositivo por la copia de la nube?'))await installState(data.state,'manual-pull');};
    o.querySelector('#info1ForcePush').onclick=async()=>{dirty=true;await push();msg.textContent='Guardado solicitado.';};
    o.querySelector('#info1CloseCloud').onclick=()=>o.remove();
    o.querySelector('#info1LogoutCloud').onclick=async()=>{await sb.auth.signOut();location.reload();};
  }

  async function initCloud(s){
    session=s;badge('☁️ Conectando…','warn');
    try{
      membership=await chooseWorkspace();workspace={id:membership.workspace_id,name:membership.info1_workspaces?.name||'INFO 1'};
      const result=await initialPull();if(result==='reload')return;
      subscribe();startMonitor();showSyncedBadge();
      if(result==='local-newer'){clearTimeout(timer);timer=setTimeout(push,900);}
    }catch(e){console.error(e);badge('☁️ Error de Supabase · datos locales intactos','bad','<button id="info1RetryInit">Reintentar</button>');document.getElementById('info1RetryInit').onclick=()=>initCloud(session);}
  }

  async function start(){
    addStyles();
    if(localStorage.getItem(OFFLINE_KEY)==='1'){showOfflineBadge();return;}
    const {data:{session:s}}=await sb.auth.getSession();
    if(!s){showAuth();return;}
    await initCloud(s);
    sb.auth.onAuthStateChange((_event,newSession)=>{if(!newSession&&!document.getElementById('info1CloudOverlay'))showAuth();});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();