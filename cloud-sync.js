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
  let pushTimer = null;
  let monitor = null;
  let channel = null;
  let initPromise = null;

  const parse = (raw, fallback = {}) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
  const localState = () => parse(localStorage.getItem(KEY), {});
  const normalState = s => s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const stateTime = s => {
    const t = new Date(s?.__settings?.lastSavedAt || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  function progressScore(s) {
    if (!s || typeof s !== 'object') return 0;
    let score = 0;
    for (const [k, v] of Object.entries(s)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (!/^(?:\d+:\d+|p2:(?:ile|elias):\d+:\d+)$/.test(k)) continue;
      if (v.status === 'known') score += 8;
      else if (v.status === 'some') score += 4;
      if ((v.notes || '').trim()) score += 3;
      if (v.review) score += 1;
      if (v.practice) score += 1;
      score += Math.min(5, (v.sesiones || []).length * 2);
      score += Math.min(5, (v.errores || []).length * 2);
      score += Math.min(5, (v.historialEstados || []).length);
      for (const x of Object.values(v.skills || {})) score += x === 'known' ? 2 : x === 'some' ? 1 : 0;
    }
    score += Object.keys(s.__flashcards || {}).length;
    score += Object.keys(s.__flashcardsP2?.ile || {}).length;
    score += Object.keys(s.__flashcardsP2?.elias || {}).length;
    return score;
  }

  function addStyles() {
    if (document.getElementById('info1CloudStyles')) return;
    const s = document.createElement('style');
    s.id = 'info1CloudStyles';
    s.textContent = `
      #info1CloudBadge{position:fixed;right:16px;bottom:16px;z-index:9997;border:1px solid #475569;background:rgba(9,16,31,.96);color:#eef2ff;border-radius:15px;padding:10px 12px;box-shadow:0 14px 40px #0007;font:700 12px/1.25 system-ui;max-width:min(460px,calc(100vw - 32px));backdrop-filter:blur(12px)}
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

  function badge(text, kind = 'ok', actions = '') {
    addStyles();
    let b = document.getElementById('info1CloudBadge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'info1CloudBadge';
      document.body.appendChild(b);
    }
    b.className = kind;
    b.innerHTML = `<span>${text}</span>${actions}`;
    return b;
  }

  function showAuth() {
    addStyles();
    if (document.getElementById('info1CloudOverlay')) return;
    const o = document.createElement('div');
    o.id = 'info1CloudOverlay';
    o.innerHTML = `<div id="info1CloudCard"><h2>☁️ INFO 1 · iniciar sesión</h2><p>Entrá para recuperar tu progreso guardado y mantenerlo sincronizado.</p><label>Email</label><input id="info1AuthEmail" type="email" autocomplete="email"><label>Contraseña</label><input id="info1AuthPassword" type="password" autocomplete="current-password"><div class="row"><button id="info1Login">Entrar</button><button id="info1Signup" class="secondary">Crear cuenta</button><button id="info1Offline" class="ghost">Seguir solo local</button></div><div id="info1CloudMsg"></div></div>`;
    document.body.appendChild(o);
    const msg = o.querySelector('#info1CloudMsg');
    const email = o.querySelector('#info1AuthEmail');
    const pass = o.querySelector('#info1AuthPassword');

    async function go(signup = false) {
      msg.textContent = 'Procesando…';
      const credentials = { email: email.value.trim(), password: pass.value };
      if (!credentials.email || !credentials.password) {
        msg.textContent = 'Completá email y contraseña.';
        return;
      }
      const res = signup ? await sb.auth.signUp(credentials) : await sb.auth.signInWithPassword(credentials);
      if (res.error) {
        msg.textContent = res.error.message;
        return;
      }
      if (!res.data.session) {
        msg.textContent = 'Cuenta creada. Revisá tu correo si pide confirmación.';
        return;
      }
      localStorage.removeItem(OFFLINE_KEY);
      o.remove();
      await initCloud(res.data.session);
    }

    o.querySelector('#info1Login').onclick = () => go(false);
    o.querySelector('#info1Signup').onclick = () => go(true);
    o.querySelector('#info1Offline').onclick = () => {
      localStorage.setItem(OFFLINE_KEY, '1');
      o.remove();
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
      const old = document.getElementById('info1CloudOverlay');
      if (old) old.remove();
      const o = document.createElement('div');
      o.id = 'info1CloudOverlay';
      o.innerHTML = `<div id="info1CloudCard"><h2>📚 Espacio INFO 1</h2><p>Creá un espacio o pegá el código para unirte.</p><label>Código</label><input id="info1JoinCode"><div class="row"><button id="info1CreateWs">Crear espacio</button><button id="info1JoinWs" class="secondary">Unirme</button></div><div id="info1CloudMsg"></div></div>`;
      document.body.appendChild(o);
      const msg = o.querySelector('#info1CloudMsg');
      o.querySelector('#info1CreateWs').onclick = async () => {
        try {
          const m = await createWorkspace();
          o.remove();
          resolve(m);
        } catch (e) { msg.textContent = e.message; }
      };
      o.querySelector('#info1JoinWs').onclick = async () => {
        try {
          await joinWorkspace(o.querySelector('#info1JoinCode').value);
          list = await memberships();
          o.remove();
          resolve(list[0]);
        } catch (e) { msg.textContent = e.message; }
      };
    });
  }

  function showApplyFallback(message = '☁️ Progreso recuperado') {
    badge(message, 'warn', '<button id="info1ApplyCloud">Aplicar</button>');
    const btn = document.getElementById('info1ApplyCloud');
    if (btn) btn.onclick = () => location.reload();
  }

  async function installRemote(remote, revision, reason) {
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

      // La aplicación ya está ejecutándose cuando llega cloud-sync.js.
      // En vez de recargar la página (lo que provocaba bucles/pantalla blanca),
      // aplicamos el estado usando la propia función de INFO 1.
      if (typeof window.applyLoadedState === 'function') {
        window.applyLoadedState(JSON.parse(nextRaw));
        lastRaw = localStorage.getItem(KEY) || nextRaw;
        badge(`☁️ Nube aplicada · rev ${remoteRevision}`, 'ok');
        return true;
      }

      lastRaw = nextRaw;
      showApplyFallback('☁️ Progreso recuperado · tocá Aplicar una vez');
      return false;
    } catch (e) {
      console.error('INFO1 apply remote', e);
      lastRaw = localStorage.getItem(KEY) || nextRaw;
      showApplyFallback('☁️ Progreso guardado · no se pudo refrescar la vista');
      return false;
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
      const { data: created, error: e } = await sb.from('info1_state')
        .insert({ workspace_id: workspace.id, state: local, revision: 1, updated_by: session.user.id })
        .select('revision')
        .single();
      if (e) throw e;
      remoteRevision = Number(created.revision || 1);
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      return;
    }

    remoteRevision = Number(data.revision || 1);
    const remote = normalState(data.state);
    const remoteRaw = JSON.stringify(remote);
    const localRaw = JSON.stringify(local);
    const hydratedRevision = Number(localStorage.getItem(`${HYDRATED_PREFIX}${workspace.id}`) || 0);

    if (remoteRaw === localRaw) {
      localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(remoteRevision));
      localStorage.removeItem(UNSYNCED_KEY);
      lastRaw = localRaw;
      return;
    }

    const remoteScore = progressScore(remote);
    const localScore = progressScore(local);
    const firstHydrationOnThisOrigin = hydratedRevision === 0;

    // En un navegador nuevo, la copia restaurada en Supabase es autoritativa.
    if (firstHydrationOnThisOrigin && remoteScore > 0) {
      await installRemote(remote, remoteRevision, 'first-cloud-hydration');
      return;
    }

    // Si la nube avanzó y no hay una marca explícita de cambios locales, bajar nube.
    if (remoteRevision > hydratedRevision && !localStorage.getItem(UNSYNCED_KEY)) {
      await installRemote(remote, remoteRevision, 'newer-cloud-revision');
      return;
    }

    // Si la nube conserva más progreso y no es más antigua, también tiene prioridad.
    if (remoteScore > localScore && stateTime(remote) >= stateTime(local)) {
      await installRemote(remote, remoteRevision, 'cloud-has-more-progress');
      return;
    }

    dirty = true;
  }

  function showSyncedBadge() {
    const name = workspace?.name || 'INFO 1';
    badge(`☁️ Sincronizado · ${name} · rev ${remoteRevision}`, 'ok', '<button id="info1PullCloud">Cargar nube</button><button id="info1Logout">Salir</button>');
    const pull = document.getElementById('info1PullCloud');
    if (pull) pull.onclick = async () => {
      try {
        badge('☁️ Bajando progreso…', 'ok');
        const { data, error } = await sb.from('info1_state')
          .select('state,revision')
          .eq('workspace_id', workspace.id)
          .single();
        if (error) throw error;
        await installRemote(data.state, Number(data.revision || 1), 'manual-pull');
        showSyncedBadge();
      } catch (e) {
        badge(`☁️ Error al cargar: ${e.message}`, 'bad');
      }
    };
    const logout = document.getElementById('info1Logout');
    if (logout) logout.onclick = async () => {
      await sb.auth.signOut();
      session = null;
      workspace = null;
      location.reload();
    };
  }

  async function push(force = false) {
    if ((!dirty && !force) || busy || applyingRemote || !session || !workspace || !navigator.onLine) return;
    busy = true;
    try {
      const local = localState();
      const localRaw = JSON.stringify(local);
      const { data: cur, error } = await sb.from('info1_state')
        .select('state,revision')
        .eq('workspace_id', workspace.id)
        .maybeSingle();
      if (error) throw error;

      const rev = Number(cur?.revision || 0);
      const cloud = normalState(cur?.state);
      const cloudRaw = JSON.stringify(cloud);

      if (localRaw === cloudRaw) {
        remoteRevision = rev;
        dirty = false;
        localStorage.removeItem(UNSYNCED_KEY);
        localStorage.setItem(`${HYDRATED_PREFIX}${workspace.id}`, String(rev));
        lastRaw = localStorage.getItem(KEY) || '';
        showSyncedBadge();
        return;
      }

      const hydratedRevision = Number(localStorage.getItem(`${HYDRATED_PREFIX}${workspace.id}`) || 0);
      const explicitlyUnsynced = localStorage.getItem(UNSYNCED_KEY) === '1';

      // Nunca sobrescribir una revisión remota que apareció después de nuestra base.
      if (cur && rev > hydratedRevision && rev > remoteRevision && !explicitlyUnsynced) {
        await installRemote(cloud, rev, 'remote-changed-before-push');
        showSyncedBadge();
        return;
      }

      // Protección ante el estado inicial de 0 %.
      if (cur && progressScore(cloud) > progressScore(local) && hydratedRevision === 0) {
        await installRemote(cloud, rev, 'empty-local-guard');
        showSyncedBadge();
        return;
      }

      const result = cur
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
        badge('☁️ Conflicto de sincronización · no se perdió ningún cambio', 'warn');
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
      console.error('INFO1 push', e);
      badge(`☁️ Sin sincronizar · ${e.message}`, 'bad');
    } finally {
      busy = false;
    }
  }

  function startMonitoring() {
    lastRaw = localStorage.getItem(KEY) || '';
    if (monitor) clearInterval(monitor);
    monitor = setInterval(() => {
      if (applyingRemote) return;
      const raw = localStorage.getItem(KEY) || '';
      if (raw !== lastRaw) {
        lastRaw = raw;
        dirty = true;
        localStorage.setItem(UNSYNCED_KEY, '1');
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => push(false), 1200);
      }
    }, 700);

    if (channel) sb.removeChannel(channel);
    channel = sb.channel(`info1-state-${workspace.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'info1_state',
        filter: `workspace_id=eq.${workspace.id}`
      }, async payload => {
        const rev = Number(payload.new?.revision || 0);
        if (rev <= remoteRevision || busy || dirty || applyingRemote) return;
        try {
          const { data, error } = await sb.from('info1_state')
            .select('state,revision')
            .eq('workspace_id', workspace.id)
            .single();
          if (error) throw error;
          await installRemote(data.state, Number(data.revision || rev), 'realtime-cloud-change');
          showSyncedBadge();
        } catch (e) {
          console.warn('INFO1 realtime pull', e);
        }
      })
      .subscribe();
  }

  async function initCloud(s) {
    if (!s?.user) return;
    if (session?.user?.id === s.user.id && workspace && monitor) return;
    if (initPromise) return initPromise;

    // Se asigna antes de cualquier await para que onAuthStateChange y boot()
    // no puedan iniciar dos hidrataciones en paralelo.
    session = s;

    initPromise = (async () => {
      try {
        badge('☁️ Conectando…', 'ok');
        const membership = await chooseWorkspace();
        workspace = membership.info1_workspaces || { id: membership.workspace_id, name: 'INFO 1' };
        if (!workspace.id) workspace.id = membership.workspace_id;
        await hydrateFirst();
        startMonitoring();
        showSyncedBadge();
        if (dirty) setTimeout(() => push(false), 1500);
      } catch (e) {
        console.error(e);
        badge(`☁️ Error de sincronización · ${e.message}`, 'bad', '<button id="info1RetryCloud">Reintentar</button>');
        const btn = document.getElementById('info1RetryCloud');
        if (btn) btn.onclick = () => {
          initPromise = null;
          initCloud(session);
        };
      }
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
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

  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_IN' && s) {
      // No esperamos dentro del callback de Auth: evitamos deadlocks y dobles arranques.
      setTimeout(() => initCloud(s), 0);
    }
    if (event === 'SIGNED_OUT') {
      session = null;
      workspace = null;
      remoteRevision = 0;
      if (monitor) { clearInterval(monitor); monitor = null; }
      if (channel) { sb.removeChannel(channel); channel = null; }
    }
  });

  window.addEventListener('online', () => {
    if (session && workspace) {
      badge('☁️ Conexión recuperada · comprobando cambios…', 'ok');
      if (dirty) push(false);
      else hydrateFirst().then(showSyncedBadge).catch(e => badge(`☁️ Error · ${e.message}`, 'bad'));
    }
  });
  window.addEventListener('offline', () => badge('💾 Sin conexión · trabajando localmente', 'warn'));

  window.INFO1_CLOUD = {
    pull: async () => {
      if (!workspace) return;
      const { data, error } = await sb.from('info1_state').select('state,revision').eq('workspace_id', workspace.id).single();
      if (error) throw error;
      await installRemote(data.state, Number(data.revision || 1), 'api-pull');
      showSyncedBadge();
    },
    push: () => push(true),
    get revision() { return remoteRevision; },
    get workspaceId() { return workspace?.id || null; }
  };

  boot().catch(e => {
    console.error('INFO1 boot', e);
    badge(`☁️ Error al iniciar nube · ${e.message}`, 'bad');
  });
})();
