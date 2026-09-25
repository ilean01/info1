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

  function parse(raw, fallback = {}) {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }

  function localRaw() {
    return localStorage.getItem(KEY) || '';
  }

  function localState() {
    const value = parse(localRaw(), {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function normalState(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
      localStorage.setItem(CLOUD_CTX_KEY, JSON.stringify({
        workspaceId: workspace.id,
        userId: session.user.id,
        updatedAt: new Date().toISOString()
      }));
    } catch {}
    window.INFO1_SUPABASE_CLIENT = sb;
    window.INFO1_CLOUD_READY = true;
  }

  function clearContext() {
    window.INFO1_SUPABASE_CLIENT = null;
    window.INFO1_CLOUD_READY = false;
    try { localStorage.removeItem(CLOUD_CTX_KEY); } catch {}
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
    badge(
      message || `☁️ Sincronizado · ${name} · rev ${remoteRevision}`,
      'ok',
      '<button id="info1PullCloud">Cargar nube</button><button id="info1ImportBackup">Importar backup</button><button id="info1Logout">Salir</button>'
    );
    bindStandardActions();
  }

  function showConflictBadge(message = '☁️ Hay una copia distinta en la nube. No voy a sobrescribir nada automáticamente.') {
    conflict = true;
    clearTimeout(pushTimer);
    badge(
      message,
      'warn',
      '<button class="primary" id="info1PullCloud">Cargar nube</button><button id="info1KeepLocal">Mantener este dispositivo</button><button id="info1ImportBackup">Importar backup</button>'
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
        localStorage.removeItem(OFFLINE_KEY);
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
  }

  function showWorkspaceSetup() {
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
        <h2>📚 Espacio INFO 1</h2>
        <p>Creá tu espacio o pegá el código de un espacio existente.</p>
        <label>Código del espacio</label><input id="info1JoinCode" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
        <div class="row">
          <button id="info1CreateWs">Crear espacio</button>
          <button id="info1JoinWs" class="secondary">Unirme</button>
          <button id="info1CancelWs" class="ghost">Cancelar</button>
        </div>
        <div id="info1CloudMsg"></div>
      </div>`;
    document.body.appendChild(overlay);
    const msg = overlay.querySelector('#info1CloudMsg');

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
        await joinWorkspace(overlay.querySelector('#info1JoinCode').value);
        const list = await memberships();
        if (!list.length) throw new Error('No se pudo confirmar la membresía.');
        overlay.remove();
        await finishWorkspace(list[0]);
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
    const result = await withTimeout(
      sb.from('info1_state')
        .insert({
          workspace_id: workspace.id,
          state: localState(),
          revision: 1,
          updated_by: session.user.id
        })
        .select('revision')
        .single(),
      10000
    );
    if (result.error) throw result.error;
    remoteRevision = Number(result.data?.revision || 1);
    localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
    localStorage.removeItem(UNSYNCED_KEY);
    dirty = false;
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

    if (remoteRaw === here || (!here && remoteRaw === '{}')) {
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      dirty = false;
      conflict = false;
      lastSeenRaw = here;
      showSyncedBadge();
      return;
    }

    // Antes se aplicaba la nube automáticamente durante el arranque. Ese era
    // el punto más peligroso: podía disparar renders, save(), recargas y más
    // consultas al mismo tiempo. Ahora NUNCA se aplica sin una acción del usuario.
    showConflictBadge(`☁️ Encontré una copia distinta en Supabase (rev ${remoteRevision}). Elegí qué copia querés usar; mientras tanto no se sobrescribe ninguna.`);
  }

  async function loadCloudIntoLocal(userInitiated = false) {
    if (!session || !workspace) return;
    try {
      badge('☁️ Leyendo la copia de Supabase…', 'warn');
      const remote = await readRemote();
      if (!remote) throw new Error('Todavía no hay una copia en Supabase.');

      const next = normalState(remote.state);
      const nextRaw = JSON.stringify(next);
      const oldRaw = localRaw();

      applyingRemote = true;
      if (oldRaw && oldRaw !== nextRaw) localStorage.setItem(RECOVERY_KEY, oldRaw);
      localStorage.setItem(KEY, nextRaw);
      remoteRevision = Number(remote.revision || 1);
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      dirty = false;
      conflict = false;
      lastSeenRaw = nextRaw;
      applyingRemote = false;

      badge(
        `☁️ Copia de Supabase guardada en este dispositivo · rev ${remoteRevision}. Actualizá la pantalla para mostrarla.`,
        'ok',
        '<button class="primary" id="info1ReloadCloud">Actualizar pantalla</button><button id="info1ImportBackup">Importar backup</button>'
      );
      bindStandardActions();
    } catch (e) {
      applyingRemote = false;
      badge(`☁️ No pude cargar la nube: ${e?.message || 'error desconocido'}`, 'bad', '<button id="info1PullCloud">Reintentar</button>');
      bindStandardActions();
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

      let result;
      if (current) {
        result = await withTimeout(
          sb.from('info1_state')
            .update({
              state: localState(),
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
              state: localState(),
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
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      conflict = false;
      dirty = false;
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
    busy = true;
    try {
      const hereRaw = localRaw();
      const current = await readRemote();
      const rev = Number(current?.revision || 0);
      const remoteRaw = current ? JSON.stringify(normalState(current.state)) : '';

      if (current && remoteRaw === hereRaw) {
        remoteRevision = rev;
        dirty = false;
        localStorage.removeItem(UNSYNCED_KEY);
        localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
        showSyncedBadge();
        return;
      }

      // Si la revisión remota avanzó desde nuestra última base conocida, no
      // hacemos merge automático ni sobrescribimos. Se frena y se pregunta.
      if (current && remoteRevision && rev !== remoteRevision) {
        conflict = true;
        showConflictBadge(`☁️ Hay cambios nuevos en Supabase (rev ${rev}). Tu copia local sigue intacta.`);
        return;
      }

      let result;
      if (current) {
        result = await withTimeout(
          sb.from('info1_state')
            .update({
              state: localState(),
              revision: rev + 1,
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
              state: localState(),
              revision: 1,
              updated_by: session.user.id
            })
            .select('revision')
            .single(),
          10000
        );
      }

      if (result.error) throw result.error;
      if (!result.data) {
        conflict = true;
        showConflictBadge('☁️ La nube cambió mientras guardaba. No se sobrescribió nada.');
        return;
      }

      remoteRevision = Number(result.data.revision || rev + 1 || 1);
      dirty = false;
      localStorage.removeItem(UNSYNCED_KEY);
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      lastSeenRaw = localRaw();
      showSyncedBadge();
    } catch (e) {
      // Un error de red nunca bloquea la aplicación ni borra el estado local.
      dirty = true;
      badge(`☁️ Sin sincronizar por ahora · ${e?.message || 'error de red'}`, 'bad', '<button id="info1PullCloud">Cargar nube</button>');
      bindStandardActions();
    } finally {
      busy = false;
    }
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
      localStorage.setItem(UNSYNCED_KEY, '1');

      if (conflict) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushLocal, 2500);
    }, 1000);

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
        conflict = true;
        clearTimeout(pushTimer);
        showConflictBadge(`☁️ Otro dispositivo guardó cambios (rev ${rev}). Elegí qué copia usar; no se aplicó nada automáticamente.`);
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('INFO1 realtime:', status);
        }
      });
  }

  async function finishWorkspace(membership) {
    workspace = membership?.info1_workspaces || {
      id: membership?.workspace_id,
      name: 'INFO 1'
    };
    if (!workspace?.id) workspace = { id: membership?.workspace_id, name: 'INFO 1' };
    if (!workspace?.id) throw new Error('No se encontró el espacio INFO 1.');

    setContext();
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
      await finishWorkspace(list[0]);
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

    if (localStorage.getItem(OFFLINE_KEY) === '1') {
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

  window.addEventListener('online', () => {
    if (session && workspace && dirty && !conflict) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushLocal, 1500);
    }
  });

  // Exponemos solo acciones seguras para diagnóstico/manual recovery.
  window.INFO1_CLOUD = {
    get status() {
      return {
        connected: !!(session && workspace),
        workspaceId: workspace?.id || null,
        revision: remoteRevision,
        dirty,
        conflict
      };
    },
    pull: () => loadCloudIntoLocal(true),
    pushLocal: keepLocalAsCloud,
    connect: showAuth
  };

  setTimeout(() => boot().catch(err => {
    console.error('INFO1 cloud fatal', err);
    showLocalBadge('💾 INFO 1 quedó en modo local por un error de nube');
  }), 0);
})();
