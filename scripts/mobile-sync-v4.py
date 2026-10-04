from pathlib import Path
import re

p = Path('device-sync.js')
s = p.read_text(encoding='utf-8')

if 'let timerStateFallbackBusy = false;' not in s:
    s = s.replace(
        '  let timerPublishQueued = false;\n  let timerPendingPublish = false;\n',
        '  let timerPublishQueued = false;\n  let timerPendingPublish = false;\n  let timerStateFallbackBusy = false;\n  let timerLastStateRevision = 0;\n',
        1,
    )

if 'updated_at: row.updated_at || null' not in s:
    s = s.replace(
        "      version: incomingVersion,\n      source_id: row.source_id || null\n    };",
        "      version: incomingVersion,\n      source_id: row.source_id || null,\n      updated_at: row.updated_at || null\n    };",
        1,
    )

bridge = r'''
  function stateConfirmsClosedLiveSession(remoteState) {
    const live = timerCanonicalRow;
    if (!live?.active || !live.topic_id || !live.started_at) return false;
    const sessions = remoteState?.[live.topic_id]?.sesiones;
    if (!Array.isArray(sessions)) return false;
    const liveStart = Date.parse(live.started_at);
    if (!Number.isFinite(liveStart)) return false;
    return sessions.some(session => {
      const start = Date.parse(session?.inicio || '');
      if (!Number.isFinite(start)) return false;
      return Math.abs(start - liveStart) <= 2000 && Number(session?.ms || 0) >= 15000;
    });
  }

  async function reconcileTimerFromFullState() {
    if (timerStateFallbackBusy || document.hidden) return false;
    const sb = window.INFO1_SUPABASE_CLIENT;
    const ctx = cloudContext();
    if (!sb || !ctx.connected || !ctx.workspaceId) return false;

    timerStateFallbackBusy = true;
    try {
      const result = await sb
        .from('info1_state')
        .select('state,revision,updated_at')
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle();
      if (result.error || !result.data) return false;

      const revision = Number(result.data.revision || 0);
      const remoteState = result.data.state && typeof result.data.state === 'object'
        ? result.data.state
        : {};
      const remoteCrono = remoteState.__crono?.id && remoteState.__crono?.inicio
        ? remoteState.__crono
        : null;
      const remoteSnap = timerSnapshot(remoteCrono);
      const localSnap = timerSnapshot(currentCrono());
      const stateUpdatedMs = Date.parse(result.data.updated_at || '') || 0;
      const liveUpdatedMs = Date.parse(timerCanonicalRow?.updated_at || '') || 0;

      if (revision <= timerLastStateRevision && stateUpdatedMs <= liveUpdatedMs) return false;
      timerLastStateRevision = Math.max(timerLastStateRevision, revision);
      if (remoteSnap === localSnap) return false;

      let accept = false;
      if (!remoteCrono && currentCrono()) {
        accept = stateConfirmsClosedLiveSession(remoteState);
      } else if (remoteCrono) {
        accept = !liveUpdatedMs || stateUpdatedMs > liveUpdatedMs;
      }
      if (!accept) return false;

      const synthetic = {
        active: !!remoteCrono,
        topic_id: remoteCrono?.id || null,
        started_at: remoteCrono?.inicio || null,
        version: timerLastVersion,
        updated_at: result.data.updated_at || new Date().toISOString(),
        source_id: 'full-state-fallback'
      };
      applySharedTimerRow(synthetic, true);
      timerPendingPublish = true;
      await publishSharedTimer();
      return true;
    } catch (e) {
      console.warn('INFO1 timer full-state fallback:', e);
      return false;
    } finally {
      timerStateFallbackBusy = false;
    }
  }

'''
marker = '  /* ===== ACTUALIZACIÓN DE APP ===== */\n'
if 'async function reconcileTimerFromFullState()' not in s:
    if marker not in s:
        raise SystemExit('app update marker not found')
    s = s.replace(marker, bridge + marker, 1)

old = '''      if (seen !== release) {
        appUpdateAvailable = true;
        pendingRelease = release;
        return true;
      }
'''
new = '''      if (seen !== release) {
        appUpdateAvailable = true;
        pendingRelease = release;
        if (!hasUnsyncedHumanChanges()) {
          setTimeout(() => reloadForNewAppVersion(true), 650);
        }
        return true;
      }
'''
if old in s:
    s = s.replace(old, new, 1)

old = '''  function reloadForNewAppVersion() {
    if (!appUpdateAvailable || hasUnsyncedHumanChanges() || hasActiveChrono()) return false;
    if (pendingRelease) localStorage.setItem(RELEASE_KEY, pendingRelease);
    const url = new URL(location.href);
    url.searchParams.set('_info1version', Date.now().toString());
    location.replace(url.toString());
    return true;
  }
'''
new = '''  function reloadForNewAppVersion(force = false) {
    if (!appUpdateAvailable || hasUnsyncedHumanChanges()) return false;
    if (hasActiveChrono() && !force) return false;
    window.__INFO1_UPDATING_APP__ = true;
    if (pendingRelease) localStorage.setItem(RELEASE_KEY, pendingRelease);
    const url = new URL(location.href);
    url.searchParams.set('_info1version', Date.now().toString());
    location.replace(url.toString());
    return true;
  }
'''
if old in s:
    s = s.replace(old, new, 1)

if '    reconcileTimerFromFullState,\n' not in s:
    s = s.replace(
        '    pollSharedTimer,\n    publishSharedTimer,\n',
        '    pollSharedTimer,\n    reconcileTimerFromFullState,\n    publishSharedTimer,\n',
        1,
    )

old = '''  setInterval(() => {
    setupSharedTimer();
    pollSharedTimer();
  }, 1500);

  setInterval(checkLatestApp, 45000);
'''
new = '''  setInterval(() => {
    setupSharedTimer();
    pollSharedTimer();
  }, 1500);

  setInterval(reconcileTimerFromFullState, 1200);
  setInterval(checkLatestApp, 10000);
'''
if old in s:
    s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')

p = Path('index.html')
s = p.read_text(encoding='utf-8')
s = re.sub(
    r'(<script src="\./device-sync\.js\?v=)[^"]+("[^>]*></script>)',
    r'\g<1>20261004-review1\g<2>',
    s,
    count=1,
)

old = '''window.addEventListener("pagehide",()=>{
  const id=currentEdit?.id;
  if(id&&activeCrono()?.id===id)stopFichaTimer(id);
});'''
new = '''window.addEventListener("pagehide",()=>{
  if(window.__INFO1_UPDATING_APP__)return;
  const id=currentEdit?.id;
  if(id&&activeCrono()?.id===id)stopFichaTimer(id);
});'''
if old in s:
    s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
