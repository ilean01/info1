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

  function hasLocalWorkInProgress() {
    const cloud = window.INFO1_CLOUD?.status;
    const pending = cloud?.dirty || localStorage.getItem(UNSYNCED_KEY) === '1';
    return hasActiveChrono() || (userTouched && !!pending);
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

  function reloadFor(reason) {
    if (reloadQueued) return;
    reloadQueued = true;
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

  async function pullLatest(reason = 'nube', force = false) {
    if (manualPullBusy || reloadQueued) return false;
    const cloud = window.INFO1_CLOUD;
    if (!cloud?.pull || !cloud?.status?.connected) return false;
    if (!force && hasLocalWorkInProgress()) return false;

    manualPullBusy = true;
    setPullButtonBusy(true);

    const targetRevision = Number(cloud.status?.revision || 0);
    const beforeHydrated = cloudContext().hydratedRevision;
    const falseStartupConflict = targetRevision > 0 && beforeHydrated === targetRevision && !userTouched && !hasActiveChrono();

    // Si el único "cambio" nació durante el arranque automático de la app,
    // no lo tratamos como edición de la persona. Así evitamos el cartel eterno.
    if (falseStartupConflict) {
      localStorage.removeItem(UNSYNCED_KEY);
    }

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
        reloadFor(reason);
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

  // Registrar interacción real. Cambios automáticos del arranque no cuentan.
  const markTouched = event => {
    if (event?.isTrusted === false) return;
    userTouched = true;
  };
  document.addEventListener('pointerdown', markTouched, true);
  document.addEventListener('keydown', markTouched, true);
  document.addEventListener('input', markTouched, true);
  document.addEventListener('change', markTouched, true);

  // "Cargar nube" sigue disponible manualmente, pero normalmente no hará falta.
  document.addEventListener('click', event => {
    const btn = event.target?.closest?.('#info1PullCloud');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    pullLatest('carga manual de nube', true);
  }, true);

  async function syncLatestData() {
    if (dataBusy || document.hidden || reloadQueued) return;

    const cloud = window.INFO1_CLOUD;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!ctx.connected || !ctx.workspaceId || !sb || !cloud?.pull) return;

    const remoteKnown = Number(cloud.status?.revision || 0);
    const hydrated = Number(ctx.hydratedRevision || 0);

    // 1) Mismo rev + sin interacción humana: no es conflicto real; suele ser
    // normalización de la app al arrancar. Se limpia solo y sin cartel manual.
    if (cloud.status?.conflict && remoteKnown > 0 && remoteKnown === hydrated && !userTouched && !hasActiveChrono()) {
      localStorage.removeItem(UNSYNCED_KEY);
      await pullLatest('resolver normalización de arranque', true);
      return;
    }

    // 2) Si otro dispositivo avanzó la nube y acá no hay trabajo real, se trae
    // automáticamente. Esto mantiene notebook y celular en la última revisión.
    if (cloud.status?.conflict && !hasLocalWorkInProgress()) {
      await pullLatest('resolver cambios de otro dispositivo', true);
      return;
    }

    if (hasLocalWorkInProgress()) return;

    dataBusy = true;
    try {
      const result = await sb
        .from('info1_state')
        .select('revision')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (result.error || !result.data) return;

      const remoteRev = Number(result.data.revision || 0);
      const localRev = Number(cloudContext().hydratedRevision || 0);
      if (remoteRev > localRev && !hasLocalWorkInProgress()) {
        await pullLatest(`datos rev ${remoteRev}`, true);
      }
    } catch (e) {
      console.warn('INFO1 cross-device data sync:', e);
    } finally {
      dataBusy = false;
    }
  }

  async function checkLatestApp() {
    if (versionBusy || document.hidden || hasLocalWorkInProgress() || reloadQueued) return;
    versionBusy = true;
    try {
      const r = await fetch(`${RELEASE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const info = await r.json();
      const release = String(info?.release || info?.sha || '').trim();
      if (!release) return;

      const seen = localStorage.getItem(RELEASE_KEY);
      if (!seen) {
        localStorage.setItem(RELEASE_KEY, release);
        return;
      }

      if (seen !== release && !hasLocalWorkInProgress()) {
        localStorage.setItem(RELEASE_KEY, release);
        try {
          const reg = await navigator.serviceWorker?.getRegistration?.();
          await reg?.update?.();
        } catch {}
        reloadFor(`app ${release}`);
      }
    } catch (e) {
      console.warn('INFO1 app version check:', e);
    } finally {
      versionBusy = false;
    }
  }

  async function syncEverything() {
    await syncLatestData();
    if (!reloadQueued) await checkLatestApp();
  }

  window.addEventListener('online', () => setTimeout(syncEverything, 500));
  window.addEventListener('focus', () => setTimeout(syncEverything, 250));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(syncEverything, 250);
  });

  setInterval(syncLatestData, 7000);
  setInterval(checkLatestApp, 45000);
  setTimeout(syncEverything, 1200);
})();
