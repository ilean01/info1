(() => {
  'use strict';

  const STATE_KEY = 'info1-study-center-v4-priority';
  const UNSYNCED_KEY = STATE_KEY + '-v15-unsynced';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const RELEASE_KEY = 'info1-release-seen-v1';
  const RELEASE_URL = './release.json';
  const DEVICE_ID_KEY = 'info1-device-id-v1';

  let dataBusy = false;
  let versionBusy = false;
  let manualPullBusy = false;
  let userTouched = false;
  let appUpdateAvailable = false;
  let pendingRelease = '';

  let touchStartY = null;
  let touchPullDistance = 0;
  let desktopPullDistance = 0;
  let desktopPullTimer = null;
  let desktopPullCooldown = false;

  let timerChannel = null;
  let timerWorkspaceId = null;
  let timerLastVersion = 0;
  let timerLastSnapshot = null;
  let timerApplyingRemote = false;
  let timerPublishBusy = false;
  let timerPublishQueued = false;

  function parse(raw, fallback = null) {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }

  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function localState() {
    const value = parse(localStorage.getItem(STATE_KEY), {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function appState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch {}
    return localState();
  }

  function currentCrono() {
    try {
      if (typeof activeCrono === 'function') return activeCrono();
    } catch {}
    return appState()?.__crono || null;
  }

  function hasActiveChrono() {
    const c = currentCrono();
    return !!(c?.id && c?.inicio);
  }

  function hasPendingFlag() {
    const cloud = window.INFO1_CLOUD?.status;
    return !!cloud?.dirty || localStorage.getItem(UNSYNCED_KEY) === '1';
  }

  function hasUnsyncedHumanChanges() {
    return userTouched && hasPendingFlag();
  }

  function cloudContext() {
    const ctx = parse(localStorage.getItem(CLOUD_CTX_KEY), {});
    const status = window.INFO1_CLOUD?.status;
    const workspaceId = ctx?.workspaceId || status?.workspaceId || null;
    return {
      workspaceId,
      userId: ctx?.userId || null,
      connected: !!status?.connected,
      hydratedRevision: Number(localStorage.getItem(`info1-cloud-hydrated:${workspaceId || ''}`) || 0)
    };
  }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function setPullButtonBusy(busy) {
    const btn = document.getElementById('info1PullCloud');
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent || 'Cargar nube';
      btn.disabled = true;
      btn.textContent = 'Actualizando…';
    } else {
      btn.disabled = false;
      if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    }
  }

  function ensureRefreshIndicator() {
    let el = document.getElementById('info1PullRefreshIndicator');
    if (el) return el;
    const style = document.createElement('style');
    style.textContent = `
      #info1PullRefreshIndicator{position:fixed;left:50%;top:12px;transform:translate(-50%,-80px);z-index:30000;background:#0f1d38;color:#eef4ff;border:1px solid #3b82f655;border-radius:999px;padding:9px 14px;font:800 12px/1.2 system-ui;box-shadow:0 12px 35px #0008;transition:transform .18s ease,opacity .18s ease;opacity:0;pointer-events:none}
      #info1PullRefreshIndicator.show{transform:translate(-50%,0);opacity:1}
      #info1PullRefreshIndicator.ready{border-color:#22c55e88}
    `;
    document.head.appendChild(style);
    el = document.createElement('div');
    el.id = 'info1PullRefreshIndicator';
    el.textContent = '↓ Bajá para actualizar';
    document.body.appendChild(el);
    return el;
  }

  function showRefreshIndicator(text, ready = false) {
    const el = ensureRefreshIndicator();
    el.textContent = text;
    el.classList.add('show');
    el.classList.toggle('ready', ready);
  }

  function hideRefreshIndicator(delay = 450) {
    const el = document.getElementById('info1PullRefreshIndicator');
    if (!el) return;
    setTimeout(() => el.classList.remove('show', 'ready'), delay);
  }

  function refreshTimerUi() {
    try { if (typeof updateLiveTimers === 'function') updateLiveTimers(); } catch {}
    try { if (typeof renderActiveStudyBar === 'function') renderActiveStudyBar(); } catch {}
    try { if (typeof updateModalTimerControl === 'function') updateModalTimerControl(); } catch {}
    try { if (typeof renderAll === 'function') renderAll(); } catch {}
  }

  function applyStateLive(next, meta = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    try {
      if (typeof state === 'undefined' || !state || typeof state !== 'object') return false;
      const clone = JSON.parse(JSON.stringify(next));
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, clone);

      if (state.__settings && typeof activeP2Profile !== 'undefined') {
        activeP2Profile = state.__settings.p2Profile === 'elias' ? 'elias' : 'ile';
      }

      if (typeof renderAll === 'function') renderAll();
      if (typeof updateLiveTimers === 'function') updateLiveTimers();
      if (typeof renderActiveStudyBar === 'function') renderActiveStudyBar();
      if (typeof updateModalTimerControl === 'function') updateModalTimerControl();
      if (typeof renderPersistStatus === 'function') renderPersistStatus();

      timerLastSnapshot = timerSnapshot(currentCrono());
      window.dispatchEvent(new CustomEvent('info1:remote-state-applied', { detail: meta }));
      return true;
    } catch (e) {
      console.warn('INFO1 live apply:', e);
      return false;
    }
  }

  window.INFO1_APPLY_REMOTE_STATE = applyStateLive;

  async function pullLatest(reason = 'nube', force = false) {
    if (manualPullBusy) return false;
    const cloud = window.INFO1_CLOUD;
    if (!cloud?.pull || !cloud?.status?.connected) return false;
    if (!force && hasUnsyncedHumanChanges()) return false;

    manualPullBusy = true;
    setPullButtonBusy(true);
    try {
      await cloud.pull();
      await wait(80);
      if (window.INFO1_CLOUD?.status?.conflict) return false;

      const applied = applyStateLive(localState(), {
        source: reason,
        revision: Number(window.INFO1_CLOUD?.status?.revision || 0)
      });
      if (applied) userTouched = false;
      return applied;
    } catch (e) {
      console.warn('INFO1 pull latest:', e);
      return false;
    } finally {
      manualPullBusy = false;
      setPullButtonBusy(false);
    }
  }

  async function syncLatestData() {
    if (dataBusy || document.hidden) return false;
    const cloud = window.INFO1_CLOUD;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!ctx.connected || !ctx.workspaceId || !sb || !cloud?.pull) return false;
    if (hasUnsyncedHumanChanges()) return false;

    if (cloud.status?.conflict) return await pullLatest('cambio de otro dispositivo', true);

    dataBusy = true;
    try {
      const result = await sb
        .from('info1_state')
        .select('revision')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (result.error || !result.data) return false;
      const remoteRev = Number(result.data.revision || 0);
      const localRev = Number(cloudContext().hydratedRevision || 0);
      if (remoteRev > localRev && !hasUnsyncedHumanChanges()) {
        return await pullLatest(`datos rev ${remoteRev}`, true);
      }
      return false;
    } catch (e) {
      console.warn('INFO1 cross-device data sync:', e);
      return false;
    } finally {
      dataBusy = false;
    }
  }

  /* ===== CRONÓMETRO COMPARTIDO EN TIEMPO REAL ===== */

  function timerSnapshot(c) {
    return c?.id && c?.inicio ? `${c.id}|${c.inicio}` : 'STOPPED';
  }

  function timerRowVersion() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  function applySharedTimerRow(row) {
    if (!row) return false;
    const incomingVersion = Number(row.version || 0);
    if (incomingVersion && incomingVersion < timerLastVersion) return false;
    timerLastVersion = Math.max(timerLastVersion, incomingVersion);

    try {
      if (typeof state === 'undefined' || !state || typeof state !== 'object') return false;
      timerApplyingRemote = true;

      if (row.active && row.topic_id && row.started_at) {
        state.__crono = {
          id: row.topic_id,
          inicio: row.started_at,
          source: 'shared-live'
        };
      } else {
        delete state.__crono;
      }

      timerLastSnapshot = timerSnapshot(state.__crono || null);
      refreshTimerUi();
      window.dispatchEvent(new CustomEvent('info1:shared-timer', {
        detail: {
          active: !!row.active,
          topicId: row.topic_id || null,
          startedAt: row.started_at || null,
          version: incomingVersion
        }
      }));
      return true;
    } catch (e) {
      console.warn('INFO1 shared timer apply:', e);
      return false;
    } finally {
      timerApplyingRemote = false;
    }
  }

  async function publishSharedTimer() {
    if (timerPublishBusy) {
      timerPublishQueued = true;
      return;
    }

    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!sb || !ctx.connected || !ctx.workspaceId) return;

    timerPublishBusy = true;
    try {
      const c = currentCrono();
      const version = timerRowVersion();
      const payload = {
        workspace_id: ctx.workspaceId,
        active: !!(c?.id && c?.inicio),
        topic_id: c?.id || null,
        started_at: c?.inicio || null,
        version,
        updated_at: new Date().toISOString(),
        updated_by: ctx.userId || null,
        source_id: deviceId()
      };

      const result = await sb
        .from('info1_live_timer')
        .upsert(payload, { onConflict: 'workspace_id' });
      if (result.error) throw result.error;
      timerLastVersion = version;
      timerLastSnapshot = timerSnapshot(c);
    } catch (e) {
      console.warn('INFO1 shared timer publish:', e);
    } finally {
      timerPublishBusy = false;
      if (timerPublishQueued) {
        timerPublishQueued = false;
        setTimeout(publishSharedTimer, 20);
      }
    }
  }

  function patchSaveForSharedTimer() {
    if (window.__INFO1_SHARED_TIMER_SAVE_PATCHED__) return;
    try {
      if (typeof save !== 'function') return;
      window.__INFO1_SHARED_TIMER_SAVE_PATCHED__ = true;
      const originalSave = save;
      timerLastSnapshot = timerSnapshot(currentCrono());

      save = function(...args) {
        const result = originalSave.apply(this, args);
        if (!timerApplyingRemote) {
          const snap = timerSnapshot(currentCrono());
          if (snap !== timerLastSnapshot) {
            timerLastSnapshot = snap;
            setTimeout(publishSharedTimer, 0);
          }
        }
        return result;
      };
    } catch (e) {
      console.warn('INFO1 shared timer save patch:', e);
    }
  }

  async function setupSharedTimer() {
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!sb || !ctx.connected || !ctx.workspaceId) return false;

    patchSaveForSharedTimer();

    if (timerWorkspaceId === ctx.workspaceId && timerChannel) return true;

    if (timerChannel) {
      try { await sb.removeChannel(timerChannel); } catch {}
      timerChannel = null;
    }
    timerWorkspaceId = ctx.workspaceId;

    try {
      const current = await sb
        .from('info1_live_timer')
        .select('workspace_id,active,topic_id,started_at,version,updated_at,source_id')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (current.error) throw current.error;

      if (current.data) {
        applySharedTimerRow(current.data);
      } else {
        // Primera vez: sembramos la tabla con el cronómetro que ya está en el
        // estado principal para no perder una sesión que esté corriendo.
        await publishSharedTimer();
      }

      timerChannel = sb
        .channel(`info1-live-timer-${ctx.workspaceId}-${deviceId()}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'info1_live_timer',
          filter: `workspace_id=eq.${ctx.workspaceId}`
        }, payload => {
          const row = payload.new || null;
          if (!row) return;
          const version = Number(row.version || 0);
          if (row.source_id === deviceId() && version <= timerLastVersion) return;
          applySharedTimerRow(row);
        })
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('INFO1 shared timer realtime:', status);
          }
        });
      return true;
    } catch (e) {
      console.warn('INFO1 shared timer setup:', e);
      return false;
    }
  }

  async function pollSharedTimer() {
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!sb || !ctx.connected || !ctx.workspaceId) return;
    try {
      const result = await sb
        .from('info1_live_timer')
        .select('active,topic_id,started_at,version,updated_at,source_id')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (!result.error && result.data && Number(result.data.version || 0) > timerLastVersion) {
        applySharedTimerRow(result.data);
      }
    } catch {}
  }

  /* ===== ACTUALIZACIÓN DE LA APP ===== */

  async function checkLatestApp() {
    if (versionBusy || document.hidden) return false;
    versionBusy = true;
    try {
      const r = await fetch(`${RELEASE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return false;
      const info = await r.json();
      const release = String(info?.release || info?.sha || '').trim();
      if (!release) return false;
      const seen = localStorage.getItem(RELEASE_KEY);
      if (!seen) {
        localStorage.setItem(RELEASE_KEY, release);
        return false;
      }
      if (seen !== release) {
        appUpdateAvailable = true;
        pendingRelease = release;
        return true;
      }
      return false;
    } catch (e) {
      console.warn('INFO1 app version check:', e);
      return false;
    } finally {
      versionBusy = false;
    }
  }

  function reloadForNewAppVersion() {
    if (!appUpdateAvailable || hasUnsyncedHumanChanges() || hasActiveChrono()) return false;
    if (pendingRelease) localStorage.setItem(RELEASE_KEY, pendingRelease);
    const url = new URL(location.href);
    url.searchParams.set('_info1version', Date.now().toString());
    location.replace(url.toString());
    return true;
  }

  async function refreshNow() {
    showRefreshIndicator('↻ Actualizando…', true);
    const deadline = Date.now() + 4500;
    while (hasUnsyncedHumanChanges() && Date.now() < deadline) await wait(250);

    if (hasUnsyncedHumanChanges()) {
      showRefreshIndicator('⏳ Guardando tus cambios…', false);
      hideRefreshIndicator(900);
      return false;
    }

    await setupSharedTimer();
    await pollSharedTimer();
    const changed = await syncLatestData();
    await checkLatestApp();

    if (appUpdateAvailable && !hasActiveChrono()) {
      showRefreshIndicator('✓ Nueva versión · actualizando…', true);
      setTimeout(reloadForNewAppVersion, 180);
      return true;
    }

    showRefreshIndicator(changed ? '✓ Datos actualizados' : '✓ Ya está actualizado', true);
    hideRefreshIndicator(700);
    return changed;
  }

  function installPullToRefresh() {
    ensureRefreshIndicator();

    document.addEventListener('touchstart', e => {
      if (e.touches?.length !== 1 || window.scrollY > 2) return;
      touchStartY = e.touches[0].clientY;
      touchPullDistance = 0;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (touchStartY == null || e.touches?.length !== 1 || window.scrollY > 2) return;
      touchPullDistance = Math.max(0, e.touches[0].clientY - touchStartY);
      if (touchPullDistance < 18) return;
      if (touchPullDistance >= 72) showRefreshIndicator('↻ Soltá para actualizar', true);
      else showRefreshIndicator('↓ Bajá para actualizar', false);
    }, { passive: true });

    document.addEventListener('touchend', () => {
      const shouldRefresh = touchStartY != null && touchPullDistance >= 72;
      touchStartY = null;
      touchPullDistance = 0;
      if (shouldRefresh) refreshNow();
      else hideRefreshIndicator(120);
    }, { passive: true });

    window.addEventListener('wheel', e => {
      if (e.ctrlKey || desktopPullCooldown) return;
      if (window.scrollY > 2 || e.deltaY >= 0) {
        desktopPullDistance = 0;
        clearTimeout(desktopPullTimer);
        hideRefreshIndicator(100);
        return;
      }

      desktopPullDistance = Math.min(220, desktopPullDistance + Math.abs(e.deltaY));
      if (desktopPullDistance >= 120) showRefreshIndicator('↻ Soltá para actualizar', true);
      else if (desktopPullDistance >= 18) showRefreshIndicator('↓ Deslizá para actualizar', false);

      clearTimeout(desktopPullTimer);
      desktopPullTimer = setTimeout(() => {
        const shouldRefresh = desktopPullDistance >= 120;
        desktopPullDistance = 0;
        if (!shouldRefresh) {
          hideRefreshIndicator(120);
          return;
        }
        desktopPullCooldown = true;
        refreshNow().finally(() => setTimeout(() => { desktopPullCooldown = false; }, 900));
      }, 160);
    }, { passive: true });
  }

  const markTouched = event => {
    if (event?.isTrusted === false) return;
    userTouched = true;
  };
  document.addEventListener('pointerdown', markTouched, true);
  document.addEventListener('keydown', markTouched, true);
  document.addEventListener('input', markTouched, true);
  document.addEventListener('change', markTouched, true);

  document.addEventListener('click', event => {
    const btn = event.target?.closest?.('#info1PullCloud');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    pullLatest('carga manual de nube', true);
  }, true);

  async function syncEverything() {
    await setupSharedTimer();
    await syncLatestData();
    await checkLatestApp();
  }

  window.INFO1_DEVICE_SYNC = {
    refreshNow,
    syncLatestData,
    applyStateLive,
    setupSharedTimer,
    pollSharedTimer,
    get status() {
      return {
        activeChrono: hasActiveChrono(),
        pending: hasPendingFlag(),
        unsyncedHumanChanges: hasUnsyncedHumanChanges(),
        appUpdateAvailable,
        sharedTimerReady: !!timerChannel,
        sharedTimerVersion: timerLastVersion
      };
    }
  };

  window.addEventListener('online', () => setTimeout(syncEverything, 250));
  window.addEventListener('focus', () => setTimeout(syncEverything, 120));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(syncEverything, 120);
  });

  // Full-state sync: sólo cuando hace falta. El cronómetro ya usa su propio
  // canal realtime y no depende de estas recargas/revisiones.
  setInterval(() => {
    if (window.INFO1_CLOUD?.status?.conflict && !hasUnsyncedHumanChanges()) syncLatestData();
  }, 900);
  setInterval(syncLatestData, 8000);

  // Respaldo del cronómetro en caso de que Realtime tenga una interrupción.
  setInterval(() => {
    setupSharedTimer();
    pollSharedTimer();
  }, 3000);

  setInterval(checkLatestApp, 45000);

  installPullToRefresh();
  patchSaveForSharedTimer();
  setTimeout(syncEverything, 600);
})();
