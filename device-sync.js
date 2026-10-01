(() => {
  'use strict';

  const STATE_KEY = 'info1-study-center-v4-priority';
  const UNSYNCED_KEY = STATE_KEY + '-v15-unsynced';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const RELEASE_KEY = 'info1-release-seen-v1';
  const RELEASE_URL = './release.json';

  let dataBusy = false;
  let versionBusy = false;
  let reloadQueued = false;
  let manualPullBusy = false;
  let userTouched = false;
  let touchStartY = null;
  let pullDistance = 0;
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
    return parse(localStorage.getItem(STATE_KEY), {}) || {};
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

  // Durante una recarga causada por aplicar la nube, el viejo pagehide del
  // index no debe volver a guardar el estado anterior encima del recién bajado.
  if (!window.__INFO1_STORAGE_GUARD_INSTALLED__) {
    window.__INFO1_STORAGE_GUARD_INSTALLED__ = true;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (window.__INFO1_SUPPRESS_STATE_WRITES__ && this === localStorage && key === STATE_KEY) {
        console.info('INFO1: escritura vieja ignorada durante recarga de nube');
        return;
      }
      return originalSetItem.call(this, key, value);
    };
  }

  function reloadFor(reason, preservePulledState = false) {
    if (reloadQueued) return;
    reloadQueued = true;
    if (preservePulledState) window.__INFO1_SUPPRESS_STATE_WRITES__ = true;
    const url = new URL(location.href);
    url.searchParams.set('_info1sync', Date.now().toString());
    console.info('INFO1 sync reload:', reason);
    setTimeout(() => location.replace(url.toString()), 180);
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

  function hideRefreshIndicator(delay = 500) {
    const el = document.getElementById('info1PullRefreshIndicator');
    if (!el) return;
    setTimeout(() => {
      el.classList.remove('show', 'ready');
    }, delay);
  }

  async function pullLatest(reason = 'nube', force = false) {
    if (manualPullBusy || reloadQueued) return false;
    const cloud = window.INFO1_CLOUD;
    if (!cloud?.pull || !cloud?.status?.connected) return false;
    if (!force && hasUnsyncedHumanChanges()) return false;

    manualPullBusy = true;
    setPullButtonBusy(true);

    const targetRevision = Number(cloud.status?.revision || 0);
    const beforeHydrated = cloudContext().hydratedRevision;
    const falseStartupConflict = targetRevision > 0 && beforeHydrated === targetRevision && !userTouched && !hasPendingFlag();

    if (falseStartupConflict) localStorage.removeItem(UNSYNCED_KEY);

    try {
      await cloud.pull();
      await wait(140);

      const status = window.INFO1_CLOUD?.status;
      const afterHydrated = cloudContext().hydratedRevision;
      if (status?.conflict) return false;

      if (falseStartupConflict && afterHydrated === targetRevision) {
        console.info('INFO1: conflicto de arranque resuelto sin recarga', targetRevision);
        return true;
      }

      if (afterHydrated > 0) {
        // Necesitamos recrear el JS para que la variable interna state lea lo
        // recién bajado. La protección de arriba evita que pagehide lo pise.
        reloadFor(reason, true);
        return true;
      }
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
    if (dataBusy || document.hidden || reloadQueued) return false;

    const cloud = window.INFO1_CLOUD;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!ctx.connected || !ctx.workspaceId || !sb || !cloud?.pull) return false;

    const remoteKnown = Number(cloud.status?.revision || 0);
    const hydrated = Number(ctx.hydratedRevision || 0);

    // El cronómetro activo YA NO bloquea la sincronización. Si ese cronómetro
    // está sincronizado y otro dispositivo lo detiene, esta copia debe aceptar
    // inmediatamente el nuevo estado de la nube.
    if (cloud.status?.conflict && remoteKnown > 0 && remoteKnown === hydrated && !userTouched && !hasPendingFlag()) {
      localStorage.removeItem(UNSYNCED_KEY);
      await pullLatest('resolver normalización de arranque', true);
      return true;
    }

    if (cloud.status?.conflict && !hasUnsyncedHumanChanges()) {
      await pullLatest('cambio recibido desde otro dispositivo', true);
      return true;
    }

    // Sólo frenamos la descarga si realmente hay una edición humana pendiente
    // de subir. Un cronómetro activo pero ya guardado en nube no cuenta.
    if (hasUnsyncedHumanChanges()) return false;

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
        await pullLatest(`datos rev ${remoteRev}`, true);
        return true;
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
    // Para actualizar el código sí esperamos a que termine el cronómetro: una
    // recarga de versión no debe cortar una sesión de estudio en curso.
    if (versionBusy || document.hidden || hasUnsyncedHumanChanges() || hasActiveChrono() || reloadQueued) return false;
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
        localStorage.setItem(RELEASE_KEY, release);
        try {
          const reg = await navigator.serviceWorker?.getRegistration?.();
          await reg?.update?.();
        } catch {}
        reloadFor(`app ${release}`, false);
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

  async function refreshNow() {
    showRefreshIndicator('↻ Actualizando…', true);

    // Damos un momento al autoguardado para terminar antes de buscar una copia
    // remota nueva. Nunca forzamos una descarga encima de una edición pendiente.
    const deadline = Date.now() + 4500;
    while (hasUnsyncedHumanChanges() && Date.now() < deadline) await wait(250);

    if (hasUnsyncedHumanChanges()) {
      showRefreshIndicator('⏳ Guardando tus cambios…', false);
      hideRefreshIndicator(900);
      return false;
    }

    const changed = await syncLatestData();
    if (reloadQueued) return true;

    const appChanged = await checkLatestApp();
    if (reloadQueued || appChanged) return true;

    showRefreshIndicator(changed ? '✓ Datos actualizados' : '✓ Ya está actualizado', true);
    hideRefreshIndicator(700);
    return changed;
  }

  function installPullToRefresh() {
    ensureRefreshIndicator();

    // Celular/tablet: arrastrar físicamente hacia abajo estando arriba del todo.
    document.addEventListener('touchstart', e => {
      if (e.touches?.length !== 1) return;
      if (window.scrollY > 2) return;
      touchStartY = e.touches[0].clientY;
      pullDistance = 0;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (touchStartY == null || e.touches?.length !== 1 || window.scrollY > 2) return;
      pullDistance = Math.max(0, e.touches[0].clientY - touchStartY);
      if (pullDistance < 18) return;
      if (pullDistance >= 72) showRefreshIndicator('↻ Soltá para actualizar', true);
      else showRefreshIndicator('↓ Bajá para actualizar', false);
    }, { passive: true });

    document.addEventListener('touchend', () => {
      const shouldRefresh = touchStartY != null && pullDistance >= 72;
      touchStartY = null;
      pullDistance = 0;
      if (shouldRefresh) refreshNow();
      else hideRefreshIndicator(120);
    }, { passive: true });

    // Notebook/trackpad: estando arriba del todo, seguir deslizando hacia abajo
    // (el gesto genera wheel negativo). Al soltar el trackpad se actualiza igual
    // que en el celular; no hace falta Command+R.
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
        refreshNow().finally(() => {
          setTimeout(() => { desktopPullCooldown = false; }, 1000);
        });
      }, 150);
    }, { passive: true });
  }

  async function syncEverything() {
    await syncLatestData();
    if (!reloadQueued) await checkLatestApp();
  }

  window.INFO1_DEVICE_SYNC = {
    refreshNow,
    syncLatestData,
    get status() {
      return {
        activeChrono: hasActiveChrono(),
        pending: hasPendingFlag(),
        unsyncedHumanChanges: hasUnsyncedHumanChanges(),
        reloadQueued
      };
    }
  };

  window.addEventListener('online', () => setTimeout(syncEverything, 500));
  window.addEventListener('focus', () => setTimeout(syncEverything, 250));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(syncEverything, 250);
  });

  // Realtime pone cloud.status.conflict casi enseguida. Este watcher local no
  // hace consultas de red: sólo reacciona a esa señal y trae la nueva rev.
  setInterval(() => {
    if (window.INFO1_CLOUD?.status?.conflict && !hasUnsyncedHumanChanges()) syncLatestData();
  }, 900);

  // Respaldo por polling por si Realtime se corta.
  setInterval(syncLatestData, 8000);
  setInterval(checkLatestApp, 45000);

  installPullToRefresh();
  setTimeout(syncEverything, 1200);
})();
