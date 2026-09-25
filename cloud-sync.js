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
  const HYDRATED_PREFIX = 'info1-cloud-hydrated:';

  const sb = window.supabase.createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.INFO1_SUPABASE_CLIENT = sb;

  let session = null;
  let workspace = null;
  let remoteRevision = 0;
  let lastRaw = '';
  let dirty = false;
  let busy = false;
  let applyingRemote = false;
  let monitor = null;
  let poller = null;
  let pushTimer = null;

  const parse = (raw, fallback = {}) => {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };
  const localState = () => parse(localStorage.getItem(KEY), {});
  const normalState = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const stateTime = value => {
    const t = new Date(value?.__settings?.lastSavedAt || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  function addStyles() {
    if (document.getElementById('info1CloudStyles')) return;
    const style = document.createElement('style');
    style.id = 'info1CloudStyles';
    style.textContent = `
      #info1CloudBadge{position:fixed;right:16px;bottom:16px;z-index:9997;border:1px solid #475569;background:rgba(9,16,31,.96);color:#eef2ff;border-radius:15px;padding:10px 12px;box-shadow:0 14px 40px #0007;font:700 12px/1.25 system-ui;max-width:min(520px,calc(100vw - 32px));backdrop-filter:blur(12px)}
      #info1CloudBadge.ok{border-color:#22c55e88}#info1CloudBadge.warn{border-color:#f59e0b99}#info1CloudBadge.bad{border-color:#ef444499}
      #info1CloudBadge button{margin-left:8px;margin-top:4px;border:0;border-radius:9px;padding:6px 9px;background:#334155;color:#fff;font-weight:800;cursor:pointer}
      #info1CloudOverlay{position:fixed;inset:0;z-index:10000;background:#020617dd;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(10px)}
      #info1CloudCard{width:min(520px,100%);background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:22px;padding:22px;box-shadow:0 24px 80px #0009;font-family:system-ui}
      #info1CloudCard h2{margin:0 0 8px}#info1CloudCard p{color:#cbd5e1;line-height:1.45}
      #info1CloudCard label{display:block;margin:12px 0 5px;font-weight:800;font-size:13px}
      #info1CloudCard input{width:100%;box-sizing:border-box;border:1px solid #475569;background:#020617;color:#fff;border-radius:11px;padding:11px 12px}
      #info1CloudCard .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}#info1CloudCard button{border:0;border-radius:11px;padding:10px 13px;background:#2563eb;color:#fff;font-weight:800;cursor:pointer}
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

  function bindBadgeActions() {
    const pull = document.getElementById('info1PullCloud');
    if (pull) pull.onclick = pullCloud;
    const imp = document.getElementById('info1ImportBackup');
    if (imp) imp.onclick = importBackup;
    const out = document.getElementById('info1Logout');
    if (out) out.onclick = async () => {
      await sb.auth.signOut();
      location.reload();
    };
  }

  function showSyncedBadge(message) {
    const name = workspace?.name || 'INFO 1';
    badge(message || `☁️ Sincronizado · ${name} · rev ${remoteRevision}`, 'ok',
      '<button id="info1PullCloud">Cargar nube</button><button id="info1ImportBackup">Importar backup</button><button id="info1Logout">Salir</button>');
    bindBadgeActions();
  }

  function showAuth() {
    addStyles();
    if (document.getElementById('info1CloudOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'info1CloudOverlay';
    overlay.innerHTML = `<div id="info1CloudCard"><h2>☁️ INFO 1 · iniciar sesión</h2><p>Entrá para recuperar tu progreso guardado y mantenerlo sincronizado.</p><label>Email</label><input id="info1AuthEmail" type="email" autocomplete="email"><label>Contraseña</label><input id="info1AuthPassword" type="password" autocomplete="current-password"><div class="row"><button id="info1Login">Entrar</button><button id="info1Signup" class="secondary">Crear cuenta</button><button id="info1Offline" class="ghost">Seguir solo local</button></div><div id="info1CloudMsg"></div></div>`;
    document.body.appendChild(overlay);

    const msg = overlay.querySelector('#info1CloudMsg');
    const email = overlay.querySelector('#info1AuthEmail');
    const pass = overlay.querySelector('#info1AuthPassword');

    async function go(signup) {
      msg.textContent = 'Procesando…';
      const credentials = { email: email.value.trim(), password: pass.value };
      if (!credentials.email || !credentials.password) {
        msg.textContent = 'Completá email y contraseña.';
        return;
      }
      const result = signup ? await sb.auth.signUp(credentials) : await sb.auth.signInWithPassword(credentials);
      if (result.error) {
        msg.textContent = result.error.message;
        return;
      }
      if (!result.data.session) {
        msg.textContent = 'Cuenta creada. Revisá tu correo si pide confirmación.';
        return;
      }
      localStorage.removeItem(OFFLINE_KEY);
      overlay.remove();
      await initCloud(result.data.session);
    }

    overlay.querySelector('#info1Login').onclick = () => go(false);
    overlay.querySelector('#info1Signup').onclick = () => go(true);
    overlay.querySelector('#info1Offline').onclick = () => {
      localStorage.setItem(OFFLINE_KEY, '1');
      overlay.remove();
      badge('💾 Solo local · nube desactivada', 'warn', '<button id="info1EnableCloud">Activar nube</button>');
      document.getElementById('info1EnableCloud').onclick = () => {
        localStorage.removeItem(OFFLINE_KEY);
        showAuth();
      };
    };
  }

  async function memberships() {
    const { data, error } = await sb.from('info1_members')
      .select('workspace_id,display_name,role,info1_workspaces(id,name,created_by,updated_at)')
      .eq('user_id', session.user.id);
    if (error) throw error;
    return data || [];
  }

  async function createWorkspace() {
    const { data: w, error: e1 } = await sb.from('info1_workspaces')
      .insert({ name: 'INFO 1', created_by: session.user.id })
      .select('id,name,created_by,updated_at')
      .single();
    if (e1) throw e1;
    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Estudiante';
    const { error: e2 } = await sb.from('info1_members').insert({
      workspace_id: w.id,
      user_id: session.user.id,
      display_name: display,
      role: 'owner'
    });
    if (e2) throw e2;
    return { workspace_id: w.id, role: 'owner', info1_workspaces: w };
  }

  async function joinWorkspace(id) {
    id = String(id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Código de espacio inválido.');
    const display = session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Estudiante';
    const { error } = await sb.from('info1_members').insert({
      workspace_id: id,
      user_id: session.user.id,
      display_name: display,
      role: 'editor'
    });
    if (error) throw error;
  }

  async function chooseWorkspace() {
    let list = await memberships();
    if (list.length) return list[0];

    return await new Promise(resolve => {
      addStyles();
      document.getElementById('info1CloudOverlay')?.remove();
      const overlay = document.createElement('div');
      overlay.id = 'info1CloudOverlay';
      overlay.innerHTML = `<div id="info1CloudCard"><h2>📚 Espacio INFO 1</h2><p>Creá un espacio o pegá el código para unirte.</p><label>Código</label><input id="info1JoinCode"><div class="row"><button id="info1CreateWs">Crear espacio</button><button id="info1JoinWs" class="secondary">Unirme</button></div><div id="info1CloudMsg"></div></div>`;
      document.body.appendChild(overlay);
      const msg = overlay.querySelector('#info1CloudMsg');

      overlay.querySelector('#info1CreateWs').onclick = async () => {
        try {
          const membership = await createWorkspace();
          overlay.remove();
          resolve(membership);
        } catch (e) { msg.textContent = e.message; }
      };

      overlay.querySelector('#info1JoinWs').onclick = async () => {
        try {
          await joinWorkspace(overlay.querySelector('#info1JoinCode').value);
          list = await memberships();
          overlay.remove();
          resolve(list[0]);
        } catch (e) { msg.textContent = e.message; }
      };
    });
  }

  async function applyRemote(remote, revision, reason) {
    const next = normalState(remote);
    const nextRaw = JSON.stringify(next);
    const oldRaw = localStorage.getItem(KEY) || '';

    applyingRemote = true;
    try {
      if (oldRaw && oldRaw !== nextRaw) localStorage.setItem(RECOVERY_KEY, oldRaw);
      localStorage.setItem(KEY, nextRaw);
      localStorage.removeItem(UNSYNCED_KEY);
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(revision));
      sessionStorage.setItem('info1-cloud-last-install', JSON.stringify({ at: Date.now(), reason, revision }));
      remoteRevision = Number(revision || remoteRevision || 1);
      dirty = false;

      if (typeof window.applyLoadedState === 'function') {
        window.applyLoadedState(JSON.parse(nextRaw));
        lastRaw = localStorage.getItem(KEY) || nextRaw;
        showSyncedBadge(`☁️ Nube aplicada · rev ${remoteRevision}`);
        return;
      }

      lastRaw = nextRaw;
      badge('☁️ Datos recuperados · tocá Aplicar una vez', 'warn', '<button id="info1ApplyCloud">Aplicar</button>');
      document.getElementById('info1ApplyCloud').onclick = () => location.reload();
    } catch (e) {
      console.error('INFO1 apply remote', e);
      lastRaw = localStorage.getItem(KEY) || nextRaw;
      badge('☁️ Los datos se guardaron, pero la vista no pudo actualizarse.', 'bad', '<button id="info1ApplyCloud">Aplicar</button>');
      const button = document.getElementById('info1ApplyCloud');
      if (button) button.onclick = () => location.reload();
    } finally {
      applyingRemote = false;
    }
  }

  async function hydrateFirst() {
    const { data, error } = await sb.from('info1_state')
      .select('state,revision,updated_at')
      .eq('workspace_id', workspace.id)
      .maybeSingle();
    if (error) throw error;

    const local = localState();
    if (!data) {
      const { data: created, error: createError } = await sb.from('info1_state')
        .insert({ workspace_id: workspace.id, state: local, revision: 1, updated_by: session.user.id })
        .select('revision')
        .single();
      if (createError) throw createError;
      remoteRevision = Number(created.revision || 1);
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      lastRaw = localStorage.getItem(KEY) || '';
      return;
    }

    remoteRevision = Number(data.revision || 1);
    const remote = normalState(data.state);
    const remoteRaw = JSON.stringify(remote);
    const localRaw = JSON.stringify(local);
    const knownRevision = Number(localStorage.getItem(`${HYDRATED_PREFIX}${workspace.id}`) || 0);
    const explicitLocalChanges = localStorage.getItem(UNSYNCED_KEY) === '1';

    if (remoteRaw === localRaw) {
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      lastRaw = localStorage.getItem(KEY) || '';
      return;
    }

    if (explicitLocalChanges && knownRevision === remoteRevision && stateTime(local) > stateTime(remote)) {
      dirty = true;
      lastRaw = localStorage.getItem(KEY) || '';
      return;
    }

    await applyRemote(remote, remoteRevision, 'initial-hydration');
  }

  async function pullCloud() {
    if (!workspace) return;
    try {
      badge('☁️ Cargando la copia de Supabase…', 'warn');
      const { data, error } = await sb.from('info1_state')
        .select('state,revision')
        .eq('workspace_id', workspace.id)
        .single();
      if (error) throw error;
      await applyRemote(data.state, Number(data.revision || 1), 'manual-pull');
    } catch (e) {
      badge(`☁️ Error al cargar: ${e.message}`, 'bad');
    }
  }

  async function push(force = false) {
    if (!dirty || busy || !session || !workspace || applyingRemote) return;
    busy = true;
    try {
      const local = localState();
      const localRaw = JSON.stringify(local);
      const { data: current, error } = await sb.from('info1_state')
        .select('state,revision')
        .eq('workspace_id', workspace.id)
        .maybeSingle();
      if (error) throw error;

      const rev = Number(current?.revision || 0);
      const cloud = normalState(current?.state);
      if (current && JSON.stringify(cloud) === localRaw) {
        remoteRevision = rev;
        dirty = false;
        localStorage.removeItem(UNSYNCED_KEY);
        localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(rev));
        lastRaw = localStorage.getItem(KEY) || '';
        showSyncedBadge();
        return;
      }

      if (!force && current && rev > remoteRevision) {
        dirty = false;
        await applyRemote(cloud, rev, 'remote-newer-before-push');
        return;
      }

      const result = current
        ? await sb.from('info1_state')
            .update({ state: local, revision: rev + 1, updated_by: session.user.id, updated_at: new Date().toISOString() })
            .eq('workspace_id', workspace.id)
            .eq('revision', rev)
            .select('revision')
            .maybeSingle()
        : await sb.from('info1_state')
            .insert({ workspace_id: workspace.id, state: local, revision: 1, updated_by: session.user.id })
            .select('revision')
            .single();

      if (result.error) throw result.error;
      if (!result.data) {
        dirty = true;
        return;
      }

      remoteRevision = Number(result.data.revision || rev + 1);
      dirty = false;
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      lastRaw = localStorage.getItem(KEY) || '';
      showSyncedBadge();
    } catch (e) {
      dirty = true;
      badge(`☁️ Sin sincronizar · ${e.message}`, 'bad');
    } finally {
      busy = false;
    }
  }

  async function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        let imported = parsed;

        if (parsed?.state && typeof parsed.state === 'object') imported = parsed.state;
        if (parsed?.localStorage) {
          const raw = parsed.localStorage[KEY] ?? parsed.localStorage[RECOVERY_KEY];
          if (raw == null) throw new Error('El archivo no contiene el estado de INFO 1.');
          imported = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }

        imported = normalState(imported);
        if (!Object.keys(imported).length) throw new Error('El backup está vacío.');

        const current = localStorage.getItem(KEY);
        if (current) localStorage.setItem(RECOVERY_KEY, current);
        applyingRemote = true;
        localStorage.setItem(KEY, JSON.stringify(imported));
        localStorage.setItem(UNSYNCED_KEY, '1');
        localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
        if (typeof window.applyLoadedState === 'function') window.applyLoadedState(imported);
        lastRaw = localStorage.getItem(KEY) || JSON.stringify(imported);
        applyingRemote = false;
        dirty = true;

        badge('📦 Backup leído · guardando en Supabase…', 'warn');
        await push(true);
        if (!dirty) showSyncedBadge('✅ Backup restaurado en Supabase');
      } catch (e) {
        applyingRemote = false;
        badge(`📦 No se pudo importar · ${e.message}`, 'bad');
      }
    };
    input.click();
  }

  function startMonitoring() {
    lastRaw = localStorage.getItem(KEY) || '';
    if (monitor) clearInterval(monitor);
    monitor = setInterval(() => {
      if (applyingRemote || busy) return;
      const raw = localStorage.getItem(KEY) || '';
      if (raw === lastRaw) return;
      lastRaw = raw;
      dirty = true;
      localStorage.setItem(UNSYNCED_KEY, '1');
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => push(false), 1200);
    }, 600);

    if (poller) clearInterval(poller);
    poller = setInterval(async () => {
      if (!session || !workspace || dirty || busy || applyingRemote || !navigator.onLine) return;
      try {
        const { data, error } = await sb.from('info1_state')
          .select('state,revision')
          .eq('workspace_id', workspace.id)
          .maybeSingle();
        if (error || !data) return;
        const rev = Number(data.revision || 0);
        if (rev > remoteRevision) await applyRemote(data.state, rev, 'poll-newer-cloud');
      } catch (e) {
        console.warn('INFO1 cloud poll', e);
      }
    }, 8000);
  }

  async function initCloud(s) {
    session = s;
    try {
      const membership = await chooseWorkspace();
      workspace = membership.info1_workspaces || { id: membership.workspace_id, name: 'INFO 1' };
      if (!workspace.id) workspace.id = membership.workspace_id;

      await hydrateFirst();
      startMonitoring();
      showSyncedBadge();
      if (dirty) setTimeout(() => push(false), 900);
    } catch (e) {
      console.error(e);
      badge(`☁️ Error de sincronización · ${e.message}`, 'bad', '<button id="info1RetryCloud">Reintentar</button>');
      const retry = document.getElementById('info1RetryCloud');
      if (retry) retry.onclick = () => initCloud(session);
    }
  }

  async function boot() {
    const { data, error } = await sb.auth.getSession();
    if (error) console.warn(error);
    if (data?.session) {
      localStorage.removeItem(OFFLINE_KEY);
      await initCloud(data.session);
      return;
    }
    if (localStorage.getItem(OFFLINE_KEY) === '1') {
      badge('💾 Solo local · nube desactivada', 'warn', '<button id="info1EnableCloud">Activar nube</button>');
      document.getElementById('info1EnableCloud').onclick = () => {
        localStorage.removeItem(OFFLINE_KEY);
        showAuth();
      };
      return;
    }
    showAuth();
  }

  sb.auth.onAuthStateChange((event, currentSession) => {
    if (event === 'SIGNED_IN' && currentSession && !session) initCloud(currentSession);
    if (event === 'SIGNED_OUT') {
      session = null;
      workspace = null;
      if (monitor) clearInterval(monitor);
      if (poller) clearInterval(poller);
    }
  });

  window.addEventListener('online', () => {
    if (session && workspace && dirty) push(false);
  });

  boot();
})();
