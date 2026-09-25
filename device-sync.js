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

  function parse(raw, fallback = null) {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }

  function localState() {
    return parse(localStorage.getItem(STATE_KEY), {}) || {};
  }

  function hasLocalWorkInProgress() {
    const cloud = window.INFO1_CLOUD?.status;
    if (cloud?.dirty) return true;
    if (localStorage.getItem(UNSYNCED_KEY) === '1') return true;
    const st = localState();
    return !!(st?.__crono?.id && st?.__crono?.inicio);
  }

  function cloudContext() {
    const ctx = parse(localStorage.getItem(CLOUD_CTX_KEY), {});
    const status = window.INFO1_CLOUD?.status;
    return {
      workspaceId: ctx?.workspaceId || status?.workspaceId || null,
      connected: !!status?.connected,
      hydratedRevision: Number(localStorage.getItem(`info1-cloud-hydrated:${ctx?.workspaceId || status?.workspaceId || ''}`) || 0)
    };
  }

  function reloadFor(reason) {
    if (reloadQueued) return;
    reloadQueued = true;
    const url = new URL(location.href);
    url.searchParams.set('_info1sync', Date.now().toString());
    console.info('INFO1 sync reload:', reason);
    setTimeout(() => location.replace(url.toString()), 120);
  }

  async function syncLatestData() {
    if (dataBusy || document.hidden || hasLocalWorkInProgress()) return;
    const cloud = window.INFO1_CLOUD;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!ctx.connected || !ctx.workspaceId || !sb || !cloud?.pull) return;

    dataBusy = true;
    try {
      const result = await sb
        .from('info1_state')
        .select('revision')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (result.error || !result.data) return;

      const remoteRev = Number(result.data.revision || 0);
      const currentCtx = cloudContext();
      const localRev = Number(currentCtx.hydratedRevision || 0);
      if (remoteRev > localRev && !hasLocalWorkInProgress()) {
        await cloud.pull();
        const after = cloudContext();
        if (Number(after.hydratedRevision || 0) >= remoteRev) reloadFor(`datos rev ${remoteRev}`);
      }
    } catch (e) {
      console.warn('INFO1 cross-device data sync:', e);
    } finally {
      dataBusy = false;
    }
  }

  async function checkLatestApp() {
    if (versionBusy || document.hidden || hasLocalWorkInProgress()) return;
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

  setInterval(syncLatestData, 15000);
  setInterval(checkLatestApp, 60000);
  setTimeout(syncEverything, 2500);
})();
