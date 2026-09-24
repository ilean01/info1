(() => {
  'use strict';

  const cfg = window.INFO1_SUPABASE;
  if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
    console.warn('INFO1 Cloud Sync: configuración de Supabase no disponible.');
    return;
  }

  const STORAGE_KEY = 'info1-study-center-v4-priority';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const CLOUD_RELOAD_KEY = 'info1-cloud-reloaded-v1';
  const sb = window.supabase.createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.INFO1_SUPABASE_CLIENT = sb;

  let session = null;
  let workspace = null;
  let membership = null;
  let remoteRevision = 0;
  let cloudTimer = null;
  let cloudBusy = false;
  let localDirty = false;
  let remoteChannel = null;

  function el(tag, attrs = {}, html = '') {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'type') node.type = v;
      else node.setAttribute(k, v);
    });
    if (html) node.innerHTML = html;
    return node;
  }

  function injectStyles() {
    if (document.getElementById('info1CloudStyles')) return;
    const style = el('style', { id: 'info1CloudStyles' });
    style.textContent = `
      #info1CloudBadge{position:fixed;right:16px;bottom:16px;z-index:9997;border:1px solid rgba(148,163,184,.35);background:rgba(9,16,31,.94);color:#eef2ff;border-radius:16px;padding:10px 12px;box-shadow:0 14px 40px rgba(0,0,0,.35);font:600 12px/1.25 system-ui,-apple-system,sans-serif;max-width:min(360px,calc(100vw - 32px));backdrop-filter:blur(12px)}
      #info1CloudBadge button{margin-left:8px;border:0;border-radius:10px;padding:6px 9px;cursor:pointer;background:#334155;color:white;font-weight:700}
      #info1CloudBadge.ok{border-color:rgba(34,197,94,.5)} #info1CloudBadge.warn{border-color:rgba(245,158,11,.55)} #info1CloudBadge.bad{border-color:rgba(239,68,68,.55)}
      #info1CloudOverlay{position:fixed;inset:0;z-index:10000;background:rgba(2,6,23,.84);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(10px)}
      #info1CloudCard{width:min(520px,100%);background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:24px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif}
      #info1CloudCard h2{margin:0 0 8px;font-size:24px} #info1CloudCard p{color:#cbd5e1;line-height:1.45}
      #info1CloudCard label{display:block;margin:12px 0 5px;font-size:13px;font-weight:800;color:#e2e8f0}
      #info1CloudCard input{width:100%;box-sizing:border-box;border:1px solid #475569;background:#020617;color:white;border-radius:12px;padding:11px 12px;font-size:15px}
      #info1CloudCard .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px} #info1CloudCard button{border:0;border-radius:12px;padding:10px 13px;cursor:pointer;font-weight:800;background:#7c3aed;color:white}
      #info1CloudCard button.secondary{background:#334155} #info1CloudCard button.ghost{background:transparent;border:1px solid #475569}
      #info1CloudMsg{min-height:20px;margin-top:10px;color:#fbbf24;font-size:13px;white-space:pre-wrap}
      #info1WorkspacePanel code{font-size:11px;word-break:break-all;color:#bfdbfe}
    `;
    document.head.appendChild(style);
  }

  function badge(text, kind='ok', actions='') {
    injectStyles();
    let b = document.getElementById('info1CloudBadge');
    if (!b) { b = el('div', { id:'info1CloudBadge' }); document.body.appendChild(b); }
    b.className = kind;
    b.innerHTML = `<span>${text}</span>${actions}`;
    return b;
  }

  function localState() {
    try {
      if (window.state && typeof window.state === 'object') return window.state;
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function localTimestamp(s) {
    const t = new Date(s?.__settings?.lastSavedAt || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function normalizeRemoteState(s) {
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }

  function writeLocalAndReload(remoteState, reason='nube') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteState));
      sessionStorage.setItem(CLOUD_RELOAD_KEY, JSON.stringify({ at:Date.now(), reason }));
      location.reload();
    } catch (e) {
      alert('No pude copiar el progreso de la nube al navegador. Exportá un backup local antes de continuar.');
    }
  }

  function showAuth() {
    injectStyles();
    let o = document.getElementById('info1CloudOverlay');
    if (o) return;
    o = el('div', { id:'info1CloudOverlay' });
    o.innerHTML = `<div id="info1CloudCard">
      <h2>☁️ INFO 1 · iniciar sesión</h2>
      <p>Usamos el mismo Supabase de SCAR, pero INFO1 tiene tablas separadas. El progreso sigue guardándose localmente y además se sincroniza en la nube.</p>
      <label>Email</label><input id="info1AuthEmail" type="email" autocomplete="email" placeholder="tu@email.com">
      <label>Contraseña</label><input id="info1AuthPassword" type="password" autocomplete="current-password" placeholder="••••••••">
      <div class="row"><button id="info1Login">Entrar</button><button id="info1Signup" class="secondary">Crear cuenta</button><button id="info1Offline" class="ghost">Seguir solo en este dispositivo</button></div>
      <div id="info1CloudMsg"></div>
    </div>`;
    document.body.appendChild(o);
    const msg = o.querySelector('#info1CloudMsg');
    const email = o.querySelector('#info1AuthEmail');
    const pass = o.querySelector('#info1AuthPassword');
    async function run(mode) {
      msg.textContent = 'Procesando…';
      const credentials = { email:email.value.trim(), password:pass.value };
      if (!credentials.email || !credentials.password) { msg.textContent='Completá email y contraseña.'; return; }
      const result = mode === 'signup' ? await sb.auth.signUp(credentials) : await sb.auth.signInWithPassword(credentials);
      if (result.error) { msg.textContent = result.error.message; return; }
      msg.textContent = mode === 'signup' && !result.data.session ? 'Cuenta creada. Revisá tu email si Supabase pide confirmación.' : 'Sesión iniciada.';
      if (result.data.session) { o.remove(); await initializeCloud(result.data.session); }
    }
    o.querySelector('#info1Login').onclick = () => run('login');
    o.querySelector('#info1Signup').onclick = () => run('signup');
    o.querySelector('#info1Offline').onclick = () => { localStorage.setItem('info1-cloud-offline','1'); o.remove(); badge('💾 Solo local · sin sincronización', 'warn', '<button id="info1EnableCloud">Activar nube</button>'); document.getElementById('info1EnableCloud').onclick=()=>{localStorage.removeItem('info1-cloud-offline');showAuth();}; };
  }

  async function getMemberships() {
    const { data, error } = await sb.from('info1_members')
      .select('workspace_id,display_name,role,info1_workspaces(id,name,created_by,updated_at)')
      .eq('user_id', session.user.id);
    if (error) throw error;
    return data || [];
  }

  async function createWorkspace() {
    const { data:w, error:e1 } = await sb.from('info1_workspaces')
      .insert({ name:'INFO 1', created_by:session.user.id }).select('id,name,created_by,updated_at').single();
    if (e1) throw e1;
    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Ile';
    const { error:e2 } = await sb.from('info1_members').insert({ workspace_id:w.id, user_id:session.user.id, display_name:display, role:'owner' });
    if (e2) throw e2;
    return { workspace_id:w.id, display_name:display, role:'owner', info1_workspaces:w };
  }

  async function joinWorkspaceById(code) {
    const id = String(code||'').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('El código del espacio no tiene formato válido.');
    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Estudiante';
    const { error } = await sb.from('info1_members').insert({ workspace_id:id, user_id:session.user.id, display_name:display, role:'editor' });
    if (error) throw error;
    return id;
  }

  async function chooseWorkspace() {
    let list = await getMemberships();
    if (list.length === 1) return list[0];
    if (!list.length) {
      return await new Promise(resolve => {
        injectStyles();
        const o = el('div', { id:'info1CloudOverlay' });
        o.innerHTML = `<div id="info1CloudCard"><h2>📚 Espacio INFO 1</h2><p>Si sos la primera persona, creá el espacio. Si Ile ya te pasó un código, pegalo para unirte.</p><label>Código del espacio</label><input id="info1JoinCode" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"><div class="row"><button id="info1CreateWs">Crear espacio</button><button id="info1JoinWs" class="secondary">Unirme</button><button id="info1Logout" class="ghost">Cerrar sesión</button></div><div id="info1CloudMsg"></div></div>`;
        document.body.appendChild(o);
        const msg=o.querySelector('#info1CloudMsg');
        o.querySelector('#info1CreateWs').onclick=async()=>{try{msg.textContent='Creando…';const m=await createWorkspace();o.remove();resolve(m);}catch(e){msg.textContent=e.message;}};
        o.querySelector('#info1JoinWs').onclick=async()=>{try{msg.textContent='Uniendo…';await joinWorkspaceById(o.querySelector('#info1JoinCode').value);list=await getMemberships();o.remove();resolve(list[0]);}catch(e){msg.textContent=e.message;}};
        o.querySelector('#info1Logout').onclick=async()=>{await sb.auth.signOut();location.reload();};
      });
    }
    return list[0];
  }

  async function pullState({ initial=false }={}) {
    const { data, error } = await sb.from('info1_state').select('state,revision,updated_at,updated_by').eq('workspace_id', workspace.id).maybeSingle();
    if (error) throw error;
    if (!data) {
      const s=localState();
      const { data:created, error:e }=await sb.from('info1_state').insert({workspace_id:workspace.id,state:s,revision:1,updated_by:session.user.id}).select('revision').single();
      if(e) throw e; remoteRevision=created.revision||1; return;
    }
    remoteRevision = Number(data.revision)||1;
    const remote = normalizeRemoteState(data.state);
    const local = localState();
    const rt = new Date(data.updated_at||0).getTime();
    const lt = localTimestamp(local);
    const reloaded = (()=>{try{return JSON.parse(sessionStorage.getItem(CLOUD_RELOAD_KEY)||'null');}catch{return null;}})();
    if (reloaded && Date.now()-Number(reloaded.at||0)<15000) { sessionStorage.removeItem(CLOUD_RELOAD_KEY); return; }
    if (initial && Object.keys(remote).length && rt > lt + 1500 && JSON.stringify(remote)!==JSON.stringify(local)) {
      if (!Object.keys(local).length || confirm('Hay una copia más nueva de INFO1 en la nube. ¿Querés cargarla en este dispositivo?\n\nTu copia local seguirá disponible en el backup del navegador hasta la recarga.')) writeLocalAndReload(remote,'remote-newer');
    }
  }

  async function pushState() {
    if (!session || !workspace || cloudBusy || !localDirty) return;
    cloudBusy=true;
    localDirty=false;
    try {
      const s=localState();
      const { data:cur, error:e0 }=await sb.from('info1_state').select('revision,updated_at').eq('workspace_id',workspace.id).maybeSingle();
      if(e0) throw e0;
      const currentRev=Number(cur?.revision||0);
      if (remoteRevision && currentRev > remoteRevision) {
        localDirty=true;
        badge('⚠️ Nube cambió en otro dispositivo', 'warn', '<button id="info1PullNow">Ver cambio</button>');
        const btn=document.getElementById('info1PullNow'); if(btn) btn.onclick=async()=>{await pullState({initial:true});};
        return;
      }
      let result;
      if (!cur) result = await sb.from('info1_state').insert({workspace_id:workspace.id,state:s,revision:1,updated_by:session.user.id}).select('revision').single();
      else result = await sb.from('info1_state').update({state:s,revision:currentRev+1,updated_by:session.user.id,updated_at:new Date().toISOString()}).eq('workspace_id',workspace.id).eq('revision',currentRev).select('revision').maybeSingle();
      if(result.error) throw result.error;
      if(!result.data){localDirty=true;badge('⚠️ Conflicto de sincronización', 'warn');return;}
      remoteRevision=Number(result.data.revision)||currentRev+1;
      localStorage.removeItem(STORAGE_KEY+'-v15-unsynced');
      badge(`☁️ Sincronizado · ${membership?.display_name||session.user.email}`, 'ok', '<button id="info1CloudMenu">Nube</button>');
      const m=document.getElementById('info1CloudMenu');if(m)m.onclick=showWorkspacePanel;
    } catch(e) {
      console.error('INFO1 cloud push',e); localDirty=true; badge('☁️ Sin conexión · guardado local', 'warn', '<button id="info1RetryCloud">Reintentar</button>');
      const r=document.getElementById('info1RetryCloud');if(r)r.onclick=()=>{localDirty=true;pushState();};
    } finally { cloudBusy=false; if(localDirty){clearTimeout(cloudTimer);cloudTimer=setTimeout(pushState,3000);} }
  }

  function wrapSave() {
    if (window.__INFO1_CLOUD_SAVE_WRAPPED__) return;
    window.__INFO1_CLOUD_SAVE_WRAPPED__=true;
    const old=window.save;
    if(typeof old!=='function')return;
    window.save=function(...args){const out=old.apply(this,args);localDirty=true;clearTimeout(cloudTimer);cloudTimer=setTimeout(pushState,700);return out;};
  }

  function subscribeRealtime() {
    if(remoteChannel) sb.removeChannel(remoteChannel);
    remoteChannel=sb.channel('info1-state-'+workspace.id)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'info1_state',filter:`workspace_id=eq.${workspace.id}`},payload=>{
        const rev=Number(payload.new?.revision||0);
        if(rev>remoteRevision){remoteRevision=rev;if(!localDirty)badge('🔄 Hay cambios nuevos de otro dispositivo', 'warn', '<button id="info1ReloadCloud">Cargar</button>');const b=document.getElementById('info1ReloadCloud');if(b)b.onclick=()=>writeLocalAndReload(normalizeRemoteState(payload.new.state),'realtime');}
      }).subscribe();
  }

  function showWorkspacePanel() {
    if(document.getElementById('info1CloudOverlay'))return;
    const o=el('div',{id:'info1CloudOverlay'});
    o.innerHTML=`<div id="info1CloudCard"><h2>☁️ Sincronización INFO 1</h2><div id="info1WorkspacePanel"><p><b>Usuario:</b> ${membership?.display_name||session.user.email}</p><p><b>Espacio:</b> ${workspace.name}</p><p><b>Rol:</b> ${membership?.role||'miembro'}</p><p><b>Código para que Elías se una:</b><br><code>${workspace.id}</code></p><p>Elías debe crear/iniciar sesión y pegar este código una sola vez. Después ambos verán el mismo progreso.</p></div><div class="row"><button id="info1CopyCode">Copiar código</button><button id="info1ForcePush" class="secondary">Guardar ahora</button><button id="info1ForcePull" class="secondary">Cargar nube</button><button id="info1CloseCloud" class="ghost">Cerrar</button><button id="info1LogoutCloud" class="ghost">Salir de la cuenta</button></div><div id="info1CloudMsg"></div></div>`;
    document.body.appendChild(o);
    const msg=o.querySelector('#info1CloudMsg');
    o.querySelector('#info1CopyCode').onclick=async()=>{try{await navigator.clipboard.writeText(workspace.id);msg.textContent='Código copiado.';}catch{msg.textContent='Copiá manualmente el código.';}};
    o.querySelector('#info1ForcePush').onclick=async()=>{localDirty=true;await pushState();msg.textContent='Guardado solicitado.';};
    o.querySelector('#info1ForcePull').onclick=async()=>{const {data,error}=await sb.from('info1_state').select('state').eq('workspace_id',workspace.id).single();if(error){msg.textContent=error.message;return;}if(confirm('¿Reemplazar el estado local por la copia de la nube?'))writeLocalAndReload(data.state,'manual-pull');};
    o.querySelector('#info1CloseCloud').onclick=()=>o.remove();
    o.querySelector('#info1LogoutCloud').onclick=async()=>{await sb.auth.signOut();location.reload();};
  }

  async function initializeCloud(s) {
    session=s;
    badge('☁️ Conectando con Supabase…','warn');
    try {
      membership=await chooseWorkspace();
      workspace={id:membership.workspace_id,name:membership.info1_workspaces?.name||'INFO 1',created_by:membership.info1_workspaces?.created_by};
      localStorage.setItem(CLOUD_CTX_KEY,JSON.stringify({workspaceId:workspace.id,userId:session.user.id}));
      await pullState({initial:true});
      wrapSave(); subscribeRealtime();
      badge(`☁️ Sincronizado · ${membership.display_name||session.user.email}`,'ok','<button id="info1CloudMenu">Nube</button>');
      const m=document.getElementById('info1CloudMenu');if(m)m.onclick=showWorkspacePanel;
      localDirty=true; setTimeout(pushState,1000);
    } catch(e) {
      console.error(e); badge('☁️ Error de Supabase · datos locales intactos','bad','<button id="info1RetryInit">Reintentar</button>');
      const r=document.getElementById('info1RetryInit');if(r)r.onclick=()=>initializeCloud(session);
    }
  }

  async function start() {
    injectStyles();
    if(localStorage.getItem('info1-cloud-offline')==='1'){badge('💾 Solo local · sin sincronización','warn','<button id="info1EnableCloud">Activar nube</button>');document.getElementById('info1EnableCloud').onclick=()=>{localStorage.removeItem('info1-cloud-offline');showAuth();};return;}
    const { data:{session:s} }=await sb.auth.getSession();
    if(!s){showAuth();return;}
    await initializeCloud(s);
    sb.auth.onAuthStateChange((_event,newSession)=>{if(!newSession&&!document.getElementById('info1CloudOverlay'))showAuth();});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
