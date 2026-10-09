(() => {
  'use strict';

  const cfg = window.INFO1_SUPABASE;
  if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
    console.warn('INFO1 Cloud Sync: Supabase no disponible. La app seguirá en modo local.');
    return;
  }

  const KEY = 'info1-study-center-v4-priority';
  const RECOVERY_KEY = KEY + '-v15-recovery';
  const UNSYNCED_KEY = KEY + '-v15-unsynced';
  const OFFLINE_KEY = 'info1-cloud-offline';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const ACTIVE_WORKSPACE_KEY = 'info1-active-workspace-v1';
  const HYDRATED_PREFIX = 'info1-cloud-hydrated:';

  const sb = window.supabase.createClient(cfg.url, cfg.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  // IMPORTANTE: no exponemos el cliente a las fotos hasta que exista
  // sesión + workspace. index.html usa esta variable como señal de que
  // la nube está realmente lista.
  window.INFO1_SUPABASE_CLIENT = null;

  let session = null;
  let workspace = null;
  let workspaceMembership = null;
  let remoteRevision = 0;
  let lastSeenRaw = '';
  let dirty = false;
  let busy = false;
  let conflict = false;
  let applyingRemote = false;
  let monitor = null;
  let pushTimer = null;
  let channel = null;
  let booting = false;

  // A local save schedules its upload immediately. Timer messages must not
  // acknowledge unrelated pending edits in the same state snapshot.
  function notifyLocalSave() {
    if (applyingRemote) return;
    const now=localRaw();
    if(now===lastSeenRaw && !dirty)return;
    lastSeenRaw=now;
    dirty=true;
    INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');
    clearTimeout(pushTimer);
    pushTimer=setTimeout(pushLocal,0);
  }
  window.addEventListener('info1:local-save',notifyLocalSave);
  window.addEventListener('info1:shared-timer',notifyLocalSave);

  function parse(raw, fallback = {}) {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }

  function cloudBase(){return parse(INFO1_LOCAL.getItem('info1-cloud-base:'+workspace?.id),{});}
  function rememberBase(value){INFO1_LOCAL.setItem('info1-cloud-base:'+workspace.id,JSON.stringify(value));}
  function applyMerged(value){
    writePrimaryState(JSON.stringify(value));
    window.INFO1_APPLY_REMOTE_STATE?.(value,{source:'merged-cloud-state'});
  }

  function localRaw() {
    return INFO1_LOCAL.getItem(KEY) || '';
  }

  function localState() {
    const value = parse(localRaw(), {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalState(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function isQuotaError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(message);
  }

  function saveRecoveryIndexedDb(raw) {
    if (!raw || !window.indexedDB || !workspace?.id) return Promise.resolve(false);
    return new Promise(resolve => {
      try {
        const request = indexedDB.open('info1-cloud-recovery-v1', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
        };
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          try {
            const tx = db.transaction('snapshots', 'readwrite');
            tx.objectStore('snapshots').put({
              raw,
              savedAt: Date.now(),
              workspaceId: workspace.id
            }, workspace.id);
            tx.oncomplete = () => { try { db.close(); } catch {} resolve(true); };
            tx.onerror = () => { try { db.close(); } catch {} resolve(false); };
            tx.onabort = () => { try { db.close(); } catch {} resolve(false); };
          } catch (_) {
            try { db.close(); } catch {}
            resolve(false);
          }
        };
      } catch (_) {
        resolve(false);
      }
    });
  }

  function writePrimaryState(raw) {
    try {
      INFO1_LOCAL.setItem(KEY, raw);
      window.INFO1_LOCAL_SAVE_OK = true;
      return true;
    } catch (error) {
      if (!isQuotaError(error)) throw error;

      // Las versiones anteriores guardaban una copia completa adicional en
      // localStorage. En iPad eso puede ocupar casi el doble y agotar la cuota.
      try { INFO1_LOCAL.removeItem(RECOVERY_KEY); } catch {}
      try {
        INFO1_LOCAL.setItem(KEY, raw);
        window.INFO1_LOCAL_SAVE_OK = true;
        return true;
      } catch (retryError) {
        window.INFO1_LOCAL_SAVE_OK = false;
        throw retryError;
      }
    }
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function withTimeout(promise, ms = 10000, label = 'La nube tardó demasiado en responder') {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function preferredWorkspaceId() {
    let serverPreferred = null;
    try {
      const fresh = await withTimeout(sb.auth.getUser(), 5000, 'No se pudo refrescar el espacio activo');
      if (!fresh?.error && fresh?.data?.user) {
        const freshUser = fresh.data.user;
        serverPreferred = freshUser.user_metadata?.info1_workspace_id || null;
        if (session) session = Object.assign({}, session, { user: freshUser });
      }
    } catch (_) {}

    let localPreferred = null;
    try {
      localPreferred = INFO1_LOCAL.getItem(ACTIVE_WORKSPACE_KEY) ||
        parse(INFO1_LOCAL.getItem(CLOUD_CTX_KEY), {})?.workspaceId || null;
    } catch (_) {}

    return serverPreferred || localPreferred || null;
  }

  function persistWorkspacePreference(workspaceId) {
    if (!workspaceId || !session?.user) return;
    try { INFO1_LOCAL.setItem(ACTIVE_WORKSPACE_KEY, workspaceId); } catch {}
    if (session.user.user_metadata?.info1_workspace_id === workspaceId) return;

    Promise.resolve(
      sb.auth.updateUser({ data: { info1_workspace_id: workspaceId } })
    ).then(result => {
      if (result?.data?.user && session) {
        session = Object.assign({}, session, { user: result.data.user });
      }
    }).catch(() => {});
  }

  function addStyles() {
    if (document.getElementById('info1CloudStyles')) return;
    const style = document.createElement('style');
    style.id = 'info1CloudStyles';
    style.textContent = `
      #info1CloudBadge{position:fixed;right:16px;bottom:16px;z-index:9997;border:1px solid #475569;background:rgba(9,16,31,.96);color:#eef2ff;border-radius:15px;padding:10px 12px;box-shadow:0 14px 40px #0007;font:700 12px/1.3 system-ui;max-width:min(560px,calc(100vw - 32px));backdrop-filter:blur(12px)}
      #info1CloudBadge.ok{border-color:#22c55e88}#info1CloudBadge.warn{border-color:#f59e0b99}#info1CloudBadge.bad{border-color:#ef444499}
      #info1CloudBadge button{margin-left:8px;margin-top:5px;border:0;border-radius:9px;padding:6px 9px;background:#334155;color:#fff;font-weight:800;cursor:pointer}
      #info1CloudBadge button.primary{background:#2563eb}
      #info1CloudOverlay{position:fixed;inset:0;z-index:10000;background:#020617dd;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(10px)}
      #info1CloudCard{width:min(540px,100%);background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:22px;padding:22px;box-shadow:0 24px 80px #0009;font-family:system-ui}
      #info1CloudCard h2{margin:0 0 8px}#info1CloudCard p{color:#cbd5e1;line-height:1.45}
      #info1CloudCard label{display:block;margin:12px 0 5px;font-weight:800;font-size:13px}
      #info1CloudCard input{width:100%;box-sizing:border-box;border:1px solid #475569;background:#020617;color:#fff;border-radius:11px;padding:11px 12px}
      #info1CloudCard .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
      #info1CloudCard button{border:0;border-radius:11px;padding:10px 13px;background:#2563eb;color:#fff;font-weight:800;cursor:pointer}
      #info1CloudCard button.secondary{background:#334155}#info1CloudCard button.ghost{background:transparent;border:1px solid #475569}
      #info1CloudMsg{min-height:20px;margin-top:10px;color:#fbbf24;font-size:13px;white-space:pre-wrap}
    `;
    document.head.appendChild(style);
  }

  function badge(text, kind = 'ok', actions = '') {
    addStyles();
    let el = document.getElementById('info1CloudBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'info1CloudBadge';
      document.body.appendChild(el);
    }
    el.className = kind;
    el.innerHTML = `<span>${text}</span>${actions}`;
    return el;
  }

  function setContext() {
    if (!session?.user?.id || !workspace?.id) return;
    try {
      INFO1_LOCAL.setItem(CLOUD_CTX_KEY, JSON.stringify({
        workspaceId: workspace.id,
        userId: session.user.id,
        updatedAt: new Date().toISOString()
      }));
      INFO1_LOCAL.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    } catch {}
    window.INFO1_SUPABASE_CLIENT = sb;
    window.INFO1_CLOUD_READY = true;
    try {
      window.dispatchEvent(new CustomEvent('info1:workspace-changed', {
        detail: { workspaceId: workspace.id }
      }));
    } catch {}
  }

  function clearContext() {
    window.INFO1_SUPABASE_CLIENT = null;
    window.INFO1_CLOUD_READY = false;
    try { INFO1_LOCAL.removeItem(CLOUD_CTX_KEY); } catch {}
    try {
      window.dispatchEvent(new CustomEvent('info1:workspace-changed', {
        detail: { workspaceId: null }
      }));
    } catch {}
  }

  function bindStandardActions() {
    const pull = document.getElementById('info1PullCloud');
    if (pull) pull.onclick = () => loadCloudIntoLocal(true);

    const local = document.getElementById('info1KeepLocal');
    if (local) local.onclick = keepLocalAsCloud;

    const login = document.getElementById('info1ConnectCloud');
    if (login) login.onclick = showAuth;

    const setup = document.getElementById('info1SetupWorkspace');
    if (setup) setup.onclick = showWorkspaceSetup;

    const manage = document.getElementById('info1ManageWorkspace');
    if (manage) manage.onclick = showWorkspaceSetup;

    const imp = document.getElementById('info1ImportBackup');
    if (imp) imp.onclick = () => {
      const input = document.getElementById('importFile');
      if (input) input.click();
    };

    const out = document.getElementById('info1Logout');
    if (out) out.onclick = logout;

    const reload = document.getElementById('info1ReloadCloud');
    if (reload) reload.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('_info1', String(Date.now()));
      location.replace(url.toString());
    };
  }

  function showLocalBadge(message = '💾 INFO 1 funciona en modo local') {
    badge(message, 'warn', '<button class="primary" id="info1ConnectCloud">Conectar nube</button>');
    bindStandardActions();
  }

  function showSyncedBadge(message) {
    const name = workspace?.name || 'INFO 1';
    if(dirty || conflict){badge(conflict?'☁️ Conflicto pendiente · copia local conservada':'☁️ Guardado local · pendiente de confirmar en nube','warn');return;}
    badge(
      message || `☁️ Sincronizado · ${name} · rev ${remoteRevision}`,
      'ok',
      '<button id="info1ManageWorkspace">👥 Espacio compartido</button><button id="info1PullCloud">Cargar nube</button><button id="info1ImportBackup">Importar backup</button><button id="info1Logout">Salir</button>'
    );
    bindStandardActions();
  }

  function showConflictBadge(message = '☁️ Hay una copia distinta en la nube. No voy a sobrescribir nada automáticamente.') {
    conflict = true;
    clearTimeout(pushTimer);
    badge(
      message,
      'warn',
      '<button id="info1ManageWorkspace">👥 Espacio compartido</button><button class="primary" id="info1PullCloud">Cargar nube</button><button id="info1KeepLocal">Mantener este dispositivo</button><button id="info1ImportBackup">Importar backup</button>'
    );
    bindStandardActions();
  }

  function showAuth() {
    addStyles();
    document.getElementById('info1CloudOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'info1CloudOverlay';
    overlay.innerHTML = `
      <div id="info1CloudCard">
        <h2>☁️ INFO 1 · conectar nube</h2>
        <p>La aplicación seguirá funcionando aunque Supabase falle. Iniciá sesión solo para sincronizar entre dispositivos.</p>
        <label>Email</label><input id="info1AuthEmail" type="email" autocomplete="email">
        <label>Contraseña</label><input id="info1AuthPassword" type="password" autocomplete="current-password">
        <div class="row">
          <button id="info1Login">Entrar</button>
          <button id="info1Signup" class="secondary">Crear cuenta</button>
          <button id="info1CancelAuth" class="ghost">Cancelar</button>
        </div>
        <div id="info1CloudMsg"></div>
      </div>`;
    document.body.appendChild(overlay);

    const msg = overlay.querySelector('#info1CloudMsg');
    const email = overlay.querySelector('#info1AuthEmail');
    const pass = overlay.querySelector('#info1AuthPassword');

    async function go(signup) {
      if (!email.value.trim() || !pass.value) {
        msg.textContent = 'Completá email y contraseña.';
        return;
      }
      msg.textContent = 'Conectando…';
      try {
        const request = signup
          ? sb.auth.signUp({ email: email.value.trim(), password: pass.value })
          : sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        const result = await withTimeout(request, 12000, 'Supabase no respondió a tiempo');
        if (result.error) throw result.error;
        if (!result.data?.session) {
          msg.textContent = 'Cuenta creada. Revisá tu correo si Supabase pide confirmación.';
          return;
        }
        INFO1_LOCAL.removeItem(OFFLINE_KEY);
        overlay.remove();
        await initCloud(result.data.session);
      } catch (e) {
        msg.textContent = e?.message || 'No se pudo iniciar sesión.';
      }
    }

    overlay.querySelector('#info1Login').onclick = () => go(false);
    overlay.querySelector('#info1Signup').onclick = () => go(true);
    overlay.querySelector('#info1CancelAuth').onclick = () => overlay.remove();
  }

  async function memberships() {
    const result = await withTimeout(
      sb.from('info1_members')
        .select('workspace_id,display_name,role,info1_workspaces(id,name,created_by,updated_at)')
        .eq('user_id', session.user.id),
      10000
    );
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function createWorkspace() {
    const first = await withTimeout(
      sb.from('info1_workspaces')
        .insert({ name: 'INFO 1', created_by: session.user.id })
        .select('id,name,created_by,updated_at')
        .single(),
      10000
    );
    if (first.error) throw first.error;

    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Estudiante';
    const second = await withTimeout(
      sb.from('info1_members').insert({
        workspace_id: first.data.id,
        user_id: session.user.id,
        display_name: display,
        role: 'owner'
      }),
      10000
    );
    if (second.error) throw second.error;

    return { workspace_id: first.data.id, role: 'owner', info1_workspaces: first.data };
  }

  async function joinWorkspace(id) {
    const clean = String(id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(clean)) throw new Error('Código de espacio inválido.');

    const before = await memberships();
    const already = before.find(item => item?.workspace_id === clean);
    if (already) return already;

    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Estudiante';
    const result = await withTimeout(
      sb.from('info1_members').insert({
        workspace_id: clean,
        user_id: session.user.id,
        display_name: display,
        role: 'editor'
      }),
      10000
    );
    if (result.error) throw result.error;

    const after = await memberships();
    const joined = after.find(item => item?.workspace_id === clean);
    if (!joined) throw new Error('La membresía se creó, pero no pude abrir ese espacio.');
    return joined;
  }

  async function showWorkspaceSetup() {
    if (!session) {
      showAuth();
      return;
    }

    addStyles();
    document.getElementById('info1CloudOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'info1CloudOverlay';
    overlay.innerHTML = `
      <div id="info1CloudCard">
        <h2>👥 Espacio compartido INFO 1</h2>
        <p>Vos y Elías tienen que estar dentro del <b>mismo código de espacio</b>. Desde acá podés ver tus espacios, cambiar al correcto o unirte con un código.</p>
        <div id="info1WorkspaceChoices" style="display:grid;gap:8px;margin:12px 0"></div>
        <label>Código del espacio compartido</label><input id="info1JoinCode" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
        <div class="row">
          <button id="info1JoinWs">Unirme a este espacio</button>
          <button id="info1CreateWs" class="secondary">Crear otro espacio</button>
          <button id="info1CancelWs" class="ghost">Cancelar</button>
        </div>
        <div id="info1CloudMsg"></div>
      </div>`;
    document.body.appendChild(overlay);
    const msg = overlay.querySelector('#info1CloudMsg');
    const choices = overlay.querySelector('#info1WorkspaceChoices');

    async function refreshChoices() {
      try {
        const list = await memberships();
        if (!list.length) {
          choices.innerHTML = '<div style="color:#cbd5e1">Todavía no pertenecés a ningún espacio.</div>';
          return list;
        }
        choices.innerHTML = list.map(item => {
          const ws = item?.info1_workspaces || {};
          const id = item?.workspace_id || ws.id || '';
          const current = workspace?.id === id;
          const role = item?.role === 'owner' ? 'propietaria/o' : 'miembro';
          return '<button type="button" data-use-workspace="'+id+'" class="'+(current?'primary':'secondary')+'" style="text-align:left">'+
            (current?'✅ ':'')+(ws.name || 'INFO 1')+' · '+role+
            '<br><small style="opacity:.8">'+id+'</small></button>';
        }).join('');
        choices.querySelectorAll('[data-use-workspace]').forEach(btn => {
          btn.onclick = async () => {
            const id = btn.dataset.useWorkspace;
            const listNow = await memberships();
            const chosen = listNow.find(item => item?.workspace_id === id);
            if (!chosen) return;
            msg.textContent = 'Cambiando al espacio compartido…';
            overlay.remove();
            await finishWorkspace(chosen);
          };
        });
        return list;
      } catch (e) {
        choices.innerHTML = '<div style="color:#fecaca">No pude leer tus espacios: '+String(e?.message || e)+'</div>';
        return [];
      }
    }

    await refreshChoices();

    overlay.querySelector('#info1CreateWs').onclick = async () => {
      msg.textContent = 'Creando…';
      try {
        const membership = await createWorkspace();
        overlay.remove();
        await finishWorkspace(membership);
      } catch (e) { msg.textContent = e?.message || 'No se pudo crear.'; }
    };

    overlay.querySelector('#info1JoinWs').onclick = async () => {
      msg.textContent = 'Uniendo…';
      try {
        const joined = await joinWorkspace(overlay.querySelector('#info1JoinCode').value);
        overlay.remove();
        await finishWorkspace(joined);
      } catch (e) { msg.textContent = e?.message || 'No se pudo unir.'; }
    };

    overlay.querySelector('#info1CancelWs').onclick = () => overlay.remove();
  }

  async function readRemote() {
    const result = await withTimeout(
      sb.from('info1_state')
        .select('state,revision,updated_at')
        .eq('workspace_id', workspace.id)
        .maybeSingle(),
      10000
    );
    if (result.error) throw result.error;
    return result.data;
  }

  async function createRemoteFromLocal() {
    const initial=localState(),initialRaw=JSON.stringify(initial);
    const result = await withTimeout(
      sb.from('info1_state')
        .insert({
          workspace_id: workspace.id,
          state: initial,
          revision: 1,
          updated_by: session.user.id
        })
        .select('revision')
        .single(),
      10000
    );
    if (result.error) throw result.error;
    rememberBase(initial);
    remoteRevision = Number(result.data?.revision || 1);
    INFO1_LOCAL.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
    INFO1_LOCAL.removeItem(UNSYNCED_KEY);
    dirty = localRaw()!==initialRaw;
    if(dirty){INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');setTimeout(pushLocal,100);}
    conflict = false;
    lastSeenRaw = localRaw();
    showSyncedBadge();
  }

  async function inspectInitialState() {
    const remote = await readRemote();
    if (!remote) {
      await createRemoteFromLocal();
      return;
    }

    remoteRevision = Number(remote.revision || 1);
    const remoteRaw = JSON.stringify(normalState(remote.state));
    const here = localRaw();
    if(!window.INFO1_WAS_LOCAL_STATE){await loadCloudIntoLocal(false);return;}

    if (remoteRaw === here || (!here && remoteRaw === '{}')) {
      INFO1_LOCAL.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      INFO1_LOCAL.removeItem(UNSYNCED_KEY);
      dirty = false;
      conflict = false;
      lastSeenRaw = here;
      rememberBase(normalState(remote.state));
      showSyncedBadge();
      return;
    }

    const base=cloudBase();
    if(Object.keys(base).length){const merged=window.INFO1_NOTEBOOK_MERGE.state(base,localState(),normalState(remote.state));if(!merged.conflicts.length){applyMerged(merged.value);rememberBase(normalState(remote.state));dirty=true;conflict=false;setTimeout(pushLocal,100);return;}}

    // Antes se aplicaba la nube automáticamente durante el arranque. Ese era
    // el punto más peligroso: podía disparar renders, save(), recargas y más
    // consultas al mismo tiempo. Ahora NUNCA se aplica sin una acción del usuario.
    showConflictBadge(`☁️ Encontré una copia distinta en Supabase (rev ${remoteRevision}). Elegí qué copia querés usar; mientras tanto no se sobrescribe ninguna.`);
  }

  async function loadCloudIntoLocal(userInitiated = false) {
    if (!session || !workspace) return;
    try {
      const atStart=localState();
      if (userInitiated) badge('☁️ Leyendo la copia de Supabase…', 'warn');
      const remote = await readRemote();
      if (!remote) throw new Error('Todavía no hay una copia en Supabase.');
      if(!userInitiated && Number(remote.revision||0)<remoteRevision)return false;

      let next = window.INFO1_NOTEBOOK_MERGE.withNotebooks(localState(),normalState(remote.state));
      if(!userInitiated && Object.keys(cloudBase()).length){
        const merged=window.INFO1_NOTEBOOK_MERGE.state(cloudBase(),localState(),normalState(remote.state));
        if(merged.conflicts.length){dirty=true;INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');showConflictBadge();return false;}
        next=merged.value;
      }
      let nextRaw = JSON.stringify(next);
      const oldRaw = localRaw();

      applyingRemote = true;
      if (oldRaw && oldRaw !== nextRaw) {
        // El backup completo va a IndexedDB, que tiene mucha más capacidad que
        // localStorage en Safari/iPadOS. No duplicamos el estado gigante.
        await saveRecoveryIndexedDb(oldRaw);
      }
      try { INFO1_LOCAL.removeItem(RECOVERY_KEY); } catch {}
      // Preserve edits made while the network read or recovery backup awaited.
      const duringRead=window.INFO1_NOTEBOOK_MERGE.state(atStart,localState(),next);
      next=duringRead.value;nextRaw=JSON.stringify(next);
      writePrimaryState(nextRaw);
      rememberBase(normalState(remote.state));
      remoteRevision = Number(remote.revision || 1);
      INFO1_LOCAL.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      INFO1_LOCAL.removeItem(UNSYNCED_KEY);
      dirty = false;
      conflict = false;
      lastSeenRaw = nextRaw;
      applyingRemote = false;

      // Aplicar en memoria y redibujar sin recargar la página. Así cambios de
      // Sé / Más o menos / No sé aparecen en el otro dispositivo en vivo.
      let appliedLive = false;
      try {
        if (typeof window.INFO1_APPLY_REMOTE_STATE === 'function') {
          appliedLive = !!window.INFO1_APPLY_REMOTE_STATE(next, {
            source: userInitiated ? 'manual-cloud-pull' : 'cloud-realtime',
            revision: remoteRevision
          });
        }
      } catch (e) {
        console.warn('INFO1 live state apply:', e);
      }

      if(nextRaw!==JSON.stringify(normalState(remote.state))){dirty=true;INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');setTimeout(pushLocal,100);}
      if (!userInitiated) {
        showSyncedBadge(`☁️ Actualizado automáticamente · rev ${remoteRevision}`);
        return appliedLive;
      }

      badge(
        `☁️ Copia de Supabase aplicada · rev ${remoteRevision}.`,
        'ok',
        '<button id="info1ImportBackup">Importar backup</button>'
      );
      bindStandardActions();
      if(nextRaw!==JSON.stringify(normalState(remote.state))){dirty=true;INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');setTimeout(pushLocal,100);}
      return true;
    } catch (e) {
      applyingRemote = false;
      if (!userInitiated) {
        console.warn('INFO1 auto cloud pull:', e);
        return false;
      }
      const storageMessage = isQuotaError(e)
        ? 'El almacenamiento local de este iPad está lleno. No es la cuota de Supabase. Liberé la copia duplicada; cerrá y abrí INFO 1 y reintentá.'
        : (e?.message || 'error desconocido');
      badge(`☁️ No pude cargar la nube: ${storageMessage}`, 'bad', '<button id="info1PullCloud">Reintentar</button>');
      bindStandardActions();
      return false;
    }
  }

  async function keepLocalAsCloud() {
    if (!session || !workspace || busy) return;
    busy = true;
    try {
      badge('☁️ Guardando esta copia en Supabase…', 'warn');
      const current = await readRemote();
      const rev = Number(current?.revision || 0);
      const nextRevision = rev + 1;
      const manualCandidate=window.INFO1_NOTEBOOK_MERGE.withNotebooks(normalState(current?.state),localState());
      const manualBefore=localRaw();

      let result;
      if (current) {
        result = await withTimeout(
          sb.from('info1_state')
            .update({
              state: manualCandidate,
              revision: nextRevision,
              updated_by: session.user.id,
              updated_at: new Date().toISOString()
            })
            .eq('workspace_id', workspace.id)
            .eq('revision', rev)
            .select('revision')
            .maybeSingle(),
          10000
        );
      } else {
        result = await withTimeout(
          sb.from('info1_state')
            .insert({
              workspace_id: workspace.id,
              state: manualCandidate,
              revision: 1,
              updated_by: session.user.id
            })
            .select('revision')
            .single(),
          10000
        );
      }

      if (result.error) throw result.error;
      if (!result.data) throw new Error('La nube cambió al mismo tiempo. Volvé a elegir qué copia usar.');

      remoteRevision = Number(result.data.revision || nextRevision || 1);
      INFO1_LOCAL.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      INFO1_LOCAL.removeItem(UNSYNCED_KEY);
      conflict = false;
      rememberBase(manualCandidate);
      dirty = localRaw()!==manualBefore;
      if(!dirty)applyMerged(manualCandidate);
      else {INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');setTimeout(pushLocal,100);}
      lastSeenRaw = localRaw();
      showSyncedBadge('☁️ Este dispositivo quedó como copia activa · rev ' + remoteRevision);
    } catch (e) {
      conflict = true;
      showConflictBadge(`☁️ No pude reemplazar la nube: ${e?.message || 'error desconocido'}`);
    } finally {
      busy = false;
    }
  }

  async function pushLocal() {
    if (!dirty || busy || conflict || applyingRemote || !session || !workspace) return;
    busy=true;
    try {
      for(let attempt=0;attempt<3;attempt++) {
        const current=await readRemote(), rev=Number(current?.revision||0);
        const here=localState(), beforeRaw=JSON.stringify(here);
        let candidate=here;
        if(current&&remoteRevision&&rev!==remoteRevision) {
          const result=window.INFO1_NOTEBOOK_MERGE.state(cloudBase(),here,normalState(current.state));
          if(result.conflicts.length){conflict=true;showConflictBadge('☁️ Hay cambios distintos en la misma ficha. Los cuadernos y la copia local se conservan.');return;}
          candidate=result.value;
        }
        const sentRaw=JSON.stringify(candidate);
        let result;
        if(current)result=await withTimeout(sb.from('info1_state').update({state:candidate,revision:rev+1,updated_by:session.user.id,updated_at:new Date().toISOString()}).eq('workspace_id',workspace.id).eq('revision',rev).select('revision').maybeSingle(),10000);
        else result=await withTimeout(sb.from('info1_state').insert({workspace_id:workspace.id,state:candidate,revision:1,updated_by:session.user.id}).select('revision').single(),10000);
        if(result.error)throw result.error;
        if(!result.data)continue;
        remoteRevision=Number(result.data.revision||rev+1);
        rememberBase(candidate);
        // An edit made while the request was in flight must remain dirty.
        if(localRaw()===beforeRaw){if(sentRaw!==beforeRaw)applyMerged(candidate);dirty=false;INFO1_LOCAL.removeItem(UNSYNCED_KEY);}
        else {const later=window.INFO1_NOTEBOOK_MERGE.state(here,localState(),candidate);applyMerged(later.value);dirty=true;INFO1_LOCAL.setItem(UNSYNCED_KEY,'1');}
        lastSeenRaw=localRaw();INFO1_LOCAL.setItem(`${HYDRATED_PREFIX}${workspace.id}`,String(remoteRevision));showSyncedBadge();return;
      }
      dirty=true;badge('☁️ Reintentando guardar los cambios…','warn');
    }catch(e){dirty=true;badge('☁️ Pendiente de sincronizar · '+(e?.message||'sin conexión'),'warn');}
    finally {busy=false;if(dirty&&!conflict) {clearTimeout(pushTimer);pushTimer=setTimeout(pushLocal,1500);}}
  }

  let reconciling = false;
  async function reconcileConnection() {
    if (!session || !workspace || busy || applyingRemote || conflict || reconciling || navigator.onLine === false) return;
    if (dirty || localRaw() !== lastSeenRaw) { notifyLocalSave(); return; }
    reconciling = true;
    const workspaceId = workspace.id;
    try {
      const {data, error} = await sb.from('info1_state').select('revision').eq('workspace_id', workspaceId).maybeSingle();
      if (error) throw error;
      if (workspace?.id !== workspaceId || busy || applyingRemote || conflict) return;
      if (dirty || localRaw() !== lastSeenRaw) { notifyLocalSave(); return; }
      if (Number(data?.revision || 0) > remoteRevision) await loadCloudIntoLocal(false);
    } catch (e) { console.warn('INFO1: no se pudo comprobar la revisión remota', e); }
    finally { reconciling = false; }
  }

  function startMonitoring() {
    lastSeenRaw = localRaw();
    if (monitor) clearInterval(monitor);

    monitor = setInterval(() => {
      if (applyingRemote) return;
      const now = localRaw();
      if (now === lastSeenRaw) return;
      lastSeenRaw = now;
      dirty = true;
      INFO1_LOCAL.setItem(UNSYNCED_KEY, '1');

      if (conflict) return;
      clearTimeout(pushTimer);
      // Estado y habilidades deben viajar casi en tiempo real entre dispositivos.
      // El debounce sigue protegiendo notas/escritura continua de demasiados POST.
      pushTimer = setTimeout(pushLocal, 350);
    }, 200);

    if (channel) {
      try { sb.removeChannel(channel); } catch {}
      channel = null;
    }

    channel = sb.channel(`info1-state-stable-${workspace.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'info1_state',
        filter: `workspace_id=eq.${workspace.id}`
      }, payload => {
        const rev = Number(payload.new?.revision || 0);
        if (!rev || rev <= remoteRevision || busy) return;

        // Comprobamos también el localStorage directamente: puede haber una
        // edición recién hecha que todavía no alcanzó a detectar el monitor.
        const changedHere = localRaw() !== lastSeenRaw;
        if (dirty || changedHere) {
          if (changedHere) {
            dirty = true;
            INFO1_LOCAL.setItem(UNSYNCED_KEY, '1');
          }
          dirty=true;
          clearTimeout(pushTimer);
          pushTimer=setTimeout(pushLocal,100);
          return;
        }

        // Si este dispositivo está limpio, el cambio remoto se aplica solo.
        // No se recarga la página y el cronómetro compartido sigue siendo canónico.
        clearTimeout(pushTimer);
        loadCloudIntoLocal(false);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') reconcileConnection();
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('INFO1 realtime:', status);
        }
      });
  }

  async function finishWorkspace(membership) {
    const nextWorkspace = membership?.info1_workspaces || {
      id: membership?.workspace_id,
      name: 'INFO 1'
    };
    if (!nextWorkspace?.id) throw new Error('No se encontró el espacio INFO 1.');

    if (monitor) clearInterval(monitor);
    monitor = null;
    if (channel) {
      try { await sb.removeChannel(channel); } catch {}
      channel = null;
    }
    clearTimeout(pushTimer);

    workspaceMembership = membership || null;
    workspace = nextWorkspace;
    remoteRevision = 0;
    dirty = false;
    conflict = false;
    setContext();
    persistWorkspacePreference(workspace.id);
    await inspectInitialState();
    startMonitoring();
  }

  async function initCloud(currentSession) {
    if (!currentSession?.user?.id || booting) return;
    booting = true;
    session = currentSession;
    try {
      const list = await memberships();
      if (!list.length) {
        clearContext();
        badge('☁️ Sesión iniciada, pero todavía no hay un espacio INFO 1.', 'warn', '<button class="primary" id="info1SetupWorkspace">Configurar espacio</button><button id="info1Logout">Salir</button>');
        bindStandardActions();
        return;
      }
      const preferred = await preferredWorkspaceId();
      const chosen = (preferred && list.find(item => item?.workspace_id === preferred)) || list[0];
      await finishWorkspace(chosen);
    } catch (e) {
      clearContext();
      console.error('INFO1 cloud init', e);
      badge(`☁️ La nube no pudo iniciar · ${e?.message || 'error desconocido'}. La app sigue local.`, 'bad', '<button class="primary" id="info1ConnectCloud">Reintentar</button>');
      bindStandardActions();
    } finally {
      booting = false;
    }
  }

  async function logout() {
    try { await withTimeout(sb.auth.signOut(), 8000); } catch {}
    session = null;
    workspace = null;
    workspaceMembership = null;
    remoteRevision = 0;
    dirty = false;
    conflict = false;
    clearTimeout(pushTimer);
    if (monitor) clearInterval(monitor);
    monitor = null;
    if (channel) {
      try { await sb.removeChannel(channel); } catch {}
      channel = null;
    }
    clearContext();
    showLocalBadge('💾 Sesión cerrada · INFO 1 sigue funcionando localmente');
  }

  async function boot() {
    // El arranque de la nube nunca debe bloquear el render de la app.
    await wait(350);

    if (INFO1_LOCAL.getItem(OFFLINE_KEY) === '1') {
      showLocalBadge('💾 Solo local · nube desactivada');
      return;
    }

    try {
      const result = await withTimeout(sb.auth.getSession(), 8000, 'No se pudo comprobar la sesión de Supabase');
      if (result.error) throw result.error;
      if (result.data?.session) {
        await initCloud(result.data.session);
      } else {
        showLocalBadge('💾 INFO 1 listo · conectá la nube cuando quieras');
      }
    } catch (e) {
      console.warn('INFO1 cloud boot', e);
      showLocalBadge('💾 INFO 1 listo en modo local · Supabase no respondió');
    }
  }

  sb.auth.onAuthStateChange((event, currentSession) => {
    if (event === 'SIGNED_IN' && currentSession && !session) {
      setTimeout(() => initCloud(currentSession), 0);
    }
    if (event === 'SIGNED_OUT') {
      session = null;
      workspace = null;
      clearContext();
    }
  });

  window.addEventListener('online', reconcileConnection);
  window.addEventListener('focus', reconcileConnection);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileConnection();
  });
  // Check only the small revision number to recover missed realtime events.
  setInterval(() => {
    if (document.visibilityState !== 'hidden') reconcileConnection();
  }, 30000);

  // Exponemos solo acciones seguras para diagnóstico/manual recovery.
  window.INFO1_CLOUD = {
    get status() {
      return {
        connected: !!(session && workspace),
        workspaceId: workspace?.id || null,
        workspaceName: workspace?.name || null,
        role: workspaceMembership?.role || null,
        displayName: workspaceMembership?.display_name || session?.user?.user_metadata?.name || session?.user?.email?.split('@')[0] || null,
        revision: remoteRevision,
        dirty,
        conflict
      };
    },
    cacheRealtimeState: next => {
      const raw = JSON.stringify(next);
      try {
        writePrimaryState(raw);
        // Broadcast delivery is not a database commit. Keep changes pending
        // until pushLocal confirms the durable revision, including local edits
        // that the polling monitor has not observed yet.
        if (raw !== lastSeenRaw) {
          dirty = true;
          INFO1_LOCAL.setItem(UNSYNCED_KEY, '1');
          clearTimeout(pushTimer);
          pushTimer = setTimeout(pushLocal, 350);
        }
        return true;
      } catch (e) {
        console.warn('INFO1 realtime cache: almacenamiento local lleno', e);
        return false;
      }
    },
    pull: () => loadCloudIntoLocal(true),
    pushLocal: keepLocalAsCloud,
    connect: showAuth,
    manageWorkspace: showWorkspaceSetup,
    memberships
  };

  setTimeout(() => boot().catch(err => {
    console.error('INFO1 cloud fatal', err);
    showLocalBadge('💾 INFO 1 quedó en modo local por un error de nube');
  }), 0);
})();
