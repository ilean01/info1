(() => {
  'use strict';

  const STATE_KEY = 'info1-study-center-v4-priority';
  const UNSYNCED_KEY = STATE_KEY + '-v15-unsynced';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const RELEASE_KEY = 'info1-release-seen-v1';
  const RELEASE_URL = './release.json';

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

  function parse(raw, fallback = null) {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function localState() {
    const value = parse(localStorage.getItem(STATE_KEY), {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function hasActiveChrono() {
    const st = localState();
    return !!(st?.__crono?.id && st?.__crono?.inicio);
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
      connected: !!status?.connected,
      hydratedRevision: Number(localStorage.getItem(`info1-cloud-hydrated:${workspaceId || ''}`) || 0)
    };
  }

  function applyStateLive(next, meta = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    try {
      // `state` pertenece al script principal de INFO1. Los scripts clásicos
      // comparten el entorno global léxico, por lo que podemos reemplazar su
      // contenido sin recargar toda la página.
      if (typeof state === 'undefined' || !state || typeof state !== 'object') return false;
      const clone = JSON.parse(JSON.stringify(next));
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, clone);

      if (typeof renderAll === 'function') renderAll();
      if (typeof updateLiveTimers === 'function') updateLiveTimers();
      if (typeof renderActiveStudyBar === 'function') renderActiveStudyBar();
      if (typeof updateModalTimerControl === 'function') updateModalTimerControl();

      window.dispatchEvent(new CustomEvent('info1:remote-state-applied', { detail: meta }));
      return true;
    } catch (e) {
      console.warn('INFO1 live apply:', e);
      return false;
    }
  }

  window.INFO1_APPLY_REMOTE_STATE = applyStateLive;

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

  async function pullLatest(reason = 'nube', force = false) {
    if (manualPullBusy) return false;
    const cloud = window.INFO1_CLOUD;
    if (!cloud?.pull || !cloud?.status?.connected) return false;
    if (!force && hasUnsyncedHumanChanges()) return false;

    manualPullBusy = true;
    setPullButtonBusy(true);
    try {
      await cloud.pull();
      await wait(100);
      if (window.INFO1_CLOUD?.status?.conflict) return false;

      const next = localState();
      const applied = applyStateLive(next, {
        source: reason,
        revision: Number(window.INFO1_CLOUD?.status?.revision || 0)
      });

      if (applied) {
        userTouched = false;
        console.info('INFO1: nube aplicada en vivo sin recargar');
        return true;
      }

      // Nunca recargamos automáticamente por datos. Si un navegador viejo no
      // permite aplicar en vivo, el gesto manual de actualizar seguirá siendo
      // la salida segura sin provocar un bucle de parpadeos.
      console.warn('INFO1: la nube se guardó localmente pero no pudo aplicarse en vivo');
      return false;
    } catch (e) {
      console.warn('INFO1 pull latest:', e);
      return false;
    } finally {
      manualPullBusy = false;
      setPullButtonBusy(false);
    }
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

  async function syncLatestData() {
    if (dataBusy || document.hidden) return false;

    const cloud = window.INFO1_CLOUD;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!ctx.connected || !ctx.workspaceId || !sb || !cloud?.pull) return false;
    if (hasUnsyncedHumanChanges()) return false;

    // Realtime ya sabe que otro dispositivo avanzó. Se aplica sin reload.
    if (cloud.status?.conflict) {
      return await pullLatest('cambio de otro dispositivo', true);
    }

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

    const changed = await syncLatestData();
    await checkLatestApp();

    // La versión de código sólo se recarga cuando VOS pedís actualizar; nunca
    // automáticamente cada pocos segundos. Así no vuelve a parpadear la app.
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

  async function syncEverything() {
    await syncLatestData();
    await checkLatestApp();
  }

  window.INFO1_DEVICE_SYNC = {
    refreshNow,
    syncLatestData,
    applyStateLive,
    get status() {
      return {
        activeChrono: hasActiveChrono(),
        pending: hasPendingFlag(),
        unsyncedHumanChanges: hasUnsyncedHumanChanges(),
        appUpdateAvailable
      };
    }
  };

  window.addEventListener('online', () => setTimeout(syncEverything, 500));
  window.addEventListener('focus', () => setTimeout(syncEverything, 250));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(syncEverything, 250);
  });

  // Realtime: respuesta rápida sin recargar la página.
  setInterval(() => {
    if (window.INFO1_CLOUD?.status?.conflict && !hasUnsyncedHumanChanges()) syncLatestData();
  }, 900);

  // Respaldo si Realtime se interrumpe.
  setInterval(syncLatestData, 8000);
  setInterval(checkLatestApp, 45000);

  installPullToRefresh();
  setTimeout(syncEverything, 1200);
})();
