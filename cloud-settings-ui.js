(() => {
  'use strict';

  const STYLE_ID = 'info1CloudSettingsUiStyles';
  const BTN_ID = 'info1CloudSettingsBtn';
  const BACKDROP_ID = 'info1CloudSettingsBackdrop';
  const COMPARE_BTN_ID = 'info1CompareVersions';
  const COMPARE_OVERLAY_ID = 'info1CompareOverlay';
  const STATE_KEY = 'info1-study-center-v4-priority';
  const UNSYNCED_KEY = STATE_KEY + '-v15-unsynced';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  let syncTimer = null;

  function parse(raw, fallback = null) {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #info1CloudBadge{display:none!important}
      #info1CloudBadge.info1-settings-open{display:block!important;position:fixed!important;top:86px!important;right:22px!important;bottom:auto!important;z-index:10002!important;width:min(620px,calc(100vw - 32px))!important;max-width:min(620px,calc(100vw - 32px))!important;padding:18px!important;border-radius:18px!important;box-shadow:0 24px 80px #000a!important}
      #info1CloudBadge.info1-settings-open>span{display:block;margin:0 0 10px;font-size:14px;line-height:1.45}
      #info1CloudBadge.info1-settings-open button{margin:6px 6px 0 0!important}
      #info1CloudSettingsBackdrop{position:fixed;inset:0;z-index:10001;background:#02061788;backdrop-filter:blur(4px);display:none}
      #info1CloudSettingsBackdrop.open{display:block}
      #info1CloudSettingsBtn{border:1px solid #334a70;background:#101b34;color:#eef4ff;border-radius:12px;padding:9px 12px;font-weight:850;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:7px}
      #info1CloudSettingsBtn:hover{border-color:#79a6ff;background:#16284b}
      #info1CloudSettingsBtn .cloud-dot{width:8px;height:8px;border-radius:999px;background:#94a3b8;box-shadow:0 0 0 3px #94a3b822}
      #info1CloudSettingsBtn.cloud-ok .cloud-dot{background:#22c55e;box-shadow:0 0 0 3px #22c55e22}
      #info1CloudSettingsBtn.cloud-warn .cloud-dot{background:#f59e0b;box-shadow:0 0 0 3px #f59e0b22}
      #info1CloudSettingsBtn.cloud-bad .cloud-dot{background:#ef4444;box-shadow:0 0 0 3px #ef444422}
      #${COMPARE_BTN_ID}{background:#475569!important}
      #${COMPARE_OVERLAY_ID}{position:fixed;inset:0;z-index:20050;background:#020617e8;backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:22px;font-family:system-ui;color:#f8fafc}
      #${COMPARE_OVERLAY_ID} .cmp-card{width:min(1180px,100%);max-height:92vh;overflow:auto;background:#071126;border:1px solid #334a70;border-radius:24px;box-shadow:0 28px 100px #000c;padding:22px}
      #${COMPARE_OVERLAY_ID} .cmp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      #${COMPARE_OVERLAY_ID} h2{margin:0 0 4px;font-size:24px} #${COMPARE_OVERLAY_ID} .muted{color:#a9b8d2;font-size:13px;line-height:1.45}
      #${COMPARE_OVERLAY_ID} .safe{padding:10px 12px;border:1px solid #22c55e55;background:#052e1a66;border-radius:12px;color:#bbf7d0;font-weight:750;margin:12px 0}
      #${COMPARE_OVERLAY_ID} .cmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
      #${COMPARE_OVERLAY_ID} .version{border:1px solid #31476d;border-radius:18px;background:#0b1730;padding:16px;min-width:0}
      #${COMPARE_OVERLAY_ID} .version.local{border-color:#60a5fa77} #${COMPARE_OVERLAY_ID} .version.cloud{border-color:#22c55e77}
      #${COMPARE_OVERLAY_ID} .version h3{margin:0 0 12px;font-size:18px}
      #${COMPARE_OVERLAY_ID} .stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      #${COMPARE_OVERLAY_ID} .stat{border:1px solid #263a5c;background:#081329;border-radius:11px;padding:9px}
      #${COMPARE_OVERLAY_ID} .stat b{display:block;font-size:16px;margin-top:3px;word-break:break-word} #${COMPARE_OVERLAY_ID} .stat small{color:#93a7c8}
      #${COMPARE_OVERLAY_ID} .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.cmp-chip{font-size:12px;border:1px solid #334a70;border-radius:999px;padding:5px 8px;background:#101c36}
      #${COMPARE_OVERLAY_ID} details{margin-top:16px;border:1px solid #30466d;border-radius:14px;padding:12px;background:#081329}
      #${COMPARE_OVERLAY_ID} summary{cursor:pointer;font-weight:850}
      #${COMPARE_OVERLAY_ID} .diffs{margin-top:10px;display:grid;gap:7px}
      #${COMPARE_OVERLAY_ID} .diff{border-top:1px solid #243857;padding-top:7px;font-size:12px;line-height:1.4;word-break:break-word}.diff-path{color:#bfdbfe;font-weight:800}.diff-local{color:#fbbf24}.diff-cloud{color:#86efac}
      #${COMPARE_OVERLAY_ID} .cmp-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px;position:sticky;bottom:-22px;background:#071126;padding:14px 0 2px}
      #${COMPARE_OVERLAY_ID} button{border:0;border-radius:11px;padding:10px 13px;color:#fff;font-weight:850;cursor:pointer;background:#334155}
      #${COMPARE_OVERLAY_ID} .use-local{background:#2563eb} #${COMPARE_OVERLAY_ID} .use-cloud{background:#15803d} #${COMPARE_OVERLAY_ID} .close{background:#475569}
      #${COMPARE_OVERLAY_ID} .loading{padding:28px;text-align:center;color:#cbd5e1}
      @media(max-width:760px){#info1CloudSettingsBtn{padding:8px 10px}#info1CloudBadge.info1-settings-open{top:74px!important;right:12px!important;width:calc(100vw - 24px)!important;max-width:none!important}#${COMPARE_OVERLAY_ID}{padding:10px}#${COMPARE_OVERLAY_ID} .cmp-card{padding:15px;border-radius:18px;max-height:96vh}#${COMPARE_OVERLAY_ID} .cmp-grid{grid-template-columns:1fr}#${COMPARE_OVERLAY_ID} .stats{grid-template-columns:1fr 1fr}#${COMPARE_OVERLAY_ID} h2{font-size:20px}}
    `;
    document.head.appendChild(style);
  }

  function closePanel() {
    const badge = document.getElementById('info1CloudBadge');
    const backdrop = document.getElementById(BACKDROP_ID);
    const btn = document.getElementById(BTN_ID);
    badge?.classList.remove('info1-settings-open');
    backdrop?.classList.remove('open');
    btn?.setAttribute('aria-expanded','false');
  }

  function closeCompare() { document.getElementById(COMPARE_OVERLAY_ID)?.remove(); }

  function ensureBackdrop() {
    let el = document.getElementById(BACKDROP_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BACKDROP_ID;
      el.addEventListener('click', closePanel);
      document.body.appendChild(el);
    }
    return el;
  }

  function desiredStatusClass(badge) {
    if (badge?.classList.contains('bad')) return 'cloud-bad';
    if (badge?.classList.contains('warn')) return 'cloud-warn';
    if (badge?.classList.contains('ok')) return 'cloud-ok';
    return '';
  }

  function updateButtonState() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const badge = document.getElementById('info1CloudBadge');
    const wanted = desiredStatusClass(badge);
    const current = ['cloud-ok','cloud-warn','cloud-bad'].find(c => btn.classList.contains(c)) || '';
    if (current !== wanted) {
      btn.classList.remove('cloud-ok','cloud-warn','cloud-bad');
      if (wanted) btn.classList.add(wanted);
    }
    btn.title = badge?.querySelector('span')?.textContent?.trim() || 'Ajustes de sincronización y nube';
  }

  function togglePanel(event) {
    event?.preventDefault(); event?.stopPropagation();
    const badge = document.getElementById('info1CloudBadge');
    if (!badge) return;
    if (badge.classList.contains('info1-settings-open')) return closePanel();
    ensureBackdrop().classList.add('open');
    badge.classList.add('info1-settings-open');
    document.getElementById(BTN_ID)?.setAttribute('aria-expanded','true');
  }

  function ensureButton() {
    injectStyles();
    let btn = document.getElementById(BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID; btn.type = 'button';
      btn.setAttribute('aria-expanded','false'); btn.setAttribute('aria-controls','info1CloudBadge');
      btn.innerHTML = '<span class="cloud-dot" aria-hidden="true"></span><span>⚙️ Ajustes</span>';
      btn.addEventListener('click', togglePanel);
      const host = document.querySelector('.partial-switcher-tabs') || document.querySelector('.toolbar') || document.body;
      host.appendChild(btn);
    }
    updateButtonState();
  }

  function formatValue(v) {
    if (v === undefined) return '—';
    if (v === null) return 'null';
    if (typeof v === 'string') return v.length > 110 ? v.slice(0,107) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.length} elementos]`;
    return `{${Object.keys(v || {}).length} campos}`;
  }

  function statusCounts(root) {
    const out = { known:0, some:0, unknown:0, review:0, practice:0 };
    const stack = [root]; let seen = 0;
    while (stack.length && seen < 50000) {
      const v = stack.pop(); seen++;
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) { for (const x of v) stack.push(x); }
        else { for (const x of Object.values(v)) stack.push(x); }
      } else if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['known','sé','se','dominado','dominada'].includes(s)) out.known++;
        else if (['some','más o menos','mas o menos','medio'].includes(s)) out.some++;
        else if (['unknown','no sé','no se'].includes(s)) out.unknown++;
        else if (['review','repasar','para repasar'].includes(s)) out.review++;
        else if (['practice','practicar','para practicar'].includes(s)) out.practice++;
      }
    }
    return out;
  }

  function findInteresting(root) {
    const hits = []; const stack = [{v:root,p:''}]; let seen = 0;
    const re = /(exam|parcial|recuper|fecha|date|profile|perfil|active|activo|crono)/i;
    while (stack.length && hits.length < 10 && seen < 15000) {
      const {v,p} = stack.pop(); seen++;
      if (!v || typeof v !== 'object') continue;
      for (const [k,x] of Object.entries(v)) {
        const path = p ? `${p}.${k}` : k;
        if (re.test(k) && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) hits.push([path, formatValue(x)]);
        if (x && typeof x === 'object' && path.split('.').length < 6) stack.push({v:x,p:path});
        if (hits.length >= 10) break;
      }
    }
    return hits;
  }

  function summarize(state, meta = {}) {
    const counts = statusCounts(state);
    const json = JSON.stringify(state || {});
    return {
      revision: meta.revision ?? '—', updatedAt: meta.updatedAt || '—',
      size: `${Math.max(1, Math.round(new Blob([json]).size / 1024))} KB`,
      topKeys: Object.keys(state || {}).length,
      counts, interesting: findInteresting(state || {})
    };
  }

  function diffStates(a, b, max = 80) {
    const diffs = []; const stack = [{a,b,p:'raíz'}]; let truncated = false;
    while (stack.length) {
      if (diffs.length >= max) { truncated = true; break; }
      const cur = stack.pop();
      if (Object.is(cur.a, cur.b)) continue;
      const ao = cur.a && typeof cur.a === 'object'; const bo = cur.b && typeof cur.b === 'object';
      if (!ao || !bo || Array.isArray(cur.a) !== Array.isArray(cur.b)) {
        diffs.push({path:cur.p,a:cur.a,b:cur.b}); continue;
      }
      if (Array.isArray(cur.a)) {
        const n = Math.max(cur.a.length, cur.b.length);
        for (let i=n-1;i>=0;i--) stack.push({a:cur.a[i],b:cur.b[i],p:`${cur.p}[${i}]`});
      } else {
        const keys = [...new Set([...Object.keys(cur.a),...Object.keys(cur.b)])].sort().reverse();
        for (const k of keys) stack.push({a:cur.a[k],b:cur.b[k],p:`${cur.p}.${k}`});
      }
    }
    return {diffs,truncated};
  }

  function versionHtml(title, cls, summary, pendingText) {
    const c = summary.counts;
    const chips = summary.interesting.length ? summary.interesting.map(([k,v]) => `<span class="cmp-chip" title="${esc(k)}">${esc(k.split('.').slice(-2).join('.'))}: <b>${esc(v)}</b></span>`).join('') : '<span class="cmp-chip">Sin datos clave detectados</span>';
    return `<section class="version ${cls}"><h3>${title}</h3><div class="muted">${esc(pendingText || '')}</div><div class="stats"><div class="stat"><small>Revisión</small><b>${esc(summary.revision)}</b></div><div class="stat"><small>Última actualización</small><b style="font-size:12px">${esc(summary.updatedAt)}</b></div><div class="stat"><small>Tamaño del estado</small><b>${esc(summary.size)}</b></div><div class="stat"><small>Campos principales</small><b>${esc(summary.topKeys)}</b></div></div><div class="chips"><span class="cmp-chip">✅ ${c.known} sé</span><span class="cmp-chip">🟡 ${c.some} más o menos</span><span class="cmp-chip">🔴 ${c.unknown} no sé</span><span class="cmp-chip">🔁 ${c.review} repasar</span><span class="cmp-chip">✏️ ${c.practice} practicar</span></div><div class="chips">${chips}</div></section>`;
  }

  async function showCompare() {
    closeCompare();
    const overlay = document.createElement('div'); overlay.id = COMPARE_OVERLAY_ID;
    overlay.innerHTML = '<div class="cmp-card"><div class="loading">Comparando este dispositivo con Supabase…</div></div>';
    document.body.appendChild(overlay);

    try {
      const sb = window.INFO1_SUPABASE_CLIENT; const status = window.INFO1_CLOUD?.status || {};
      const ctx = parse(localStorage.getItem(CLOUD_CTX_KEY), {}) || {};
      const workspaceId = status.workspaceId || ctx.workspaceId;
      if (!sb || !workspaceId) throw new Error('La nube todavía no está lista.');
      const local = parse(localStorage.getItem(STATE_KEY), {}) || {};
      const hydrated = Number(localStorage.getItem(`info1-cloud-hydrated:${workspaceId}`) || 0);
      const result = await sb.from('info1_state').select('state,revision,updated_at').eq('workspace_id', workspaceId).maybeSingle();
      if (result.error) throw result.error; if (!result.data) throw new Error('No encontré una copia remota.');
      const remote = result.data.state || {};
      const localSummary = summarize(local,{revision:hydrated || 'local',updatedAt:'guardado en este dispositivo'});
      const cloudSummary = summarize(remote,{revision:Number(result.data.revision || 0),updatedAt:result.data.updated_at || '—'});
      const {diffs,truncated} = diffStates(local,remote);
      const diffHtml = diffs.length ? diffs.map(d => `<div class="diff"><div class="diff-path">${esc(d.path)}</div><div><span class="diff-local">Este dispositivo:</span> ${esc(formatValue(d.a))}</div><div><span class="diff-cloud">Supabase:</span> ${esc(formatValue(d.b))}</div></div>`).join('') : '<div class="muted">No encontré diferencias de contenido.</div>';
      const pending = localStorage.getItem(UNSYNCED_KEY) === '1' || status.dirty;
      overlay.querySelector('.cmp-card').innerHTML = `<div class="cmp-head"><div><h2>👀 Comparar versiones</h2><div class="muted">Mirá ambas copias antes de decidir cuál conservar.</div></div><button class="close" id="info1CmpX">✕</button></div><div class="safe">🔒 No se cambia ni se borra nada mientras estás mirando. Recién se modifica algo cuando elegís uno de los dos botones de abajo.</div><div class="cmp-grid">${versionHtml('💻 Este dispositivo','local',localSummary,pending?'Tiene cambios locales pendientes o detectados.':'Sin cambios locales pendientes detectados.')}${versionHtml('☁️ Supabase','cloud',cloudSummary,`Copia remota actual · revisión ${cloudSummary.revision}`)}</div><details ${diffs.length < 18 ? 'open' : ''}><summary>Ver diferencias concretas (${diffs.length}${truncated?'+':''})</summary><div class="diffs">${diffHtml}${truncated?'<div class="muted">Se muestran las primeras 80 diferencias para que la vista siga siendo rápida.</div>':''}</div></details><div class="cmp-actions"><button class="use-local" id="info1CmpUseLocal">💻 Usar este dispositivo</button><button class="use-cloud" id="info1CmpUseCloud">☁️ Usar Supabase</button><button class="close" id="info1CmpClose">Cerrar sin decidir</button></div>`;
      overlay.querySelector('#info1CmpX').onclick = closeCompare;
      overlay.querySelector('#info1CmpClose').onclick = closeCompare;
      overlay.querySelector('#info1CmpUseLocal').onclick = () => {
        if (!confirm('Esto reemplazará la copia de Supabase por lo que ves en ESTE DISPOSITIVO. ¿Querés continuar?')) return;
        closeCompare(); closePanel(); document.getElementById('info1KeepLocal')?.click();
      };
      overlay.querySelector('#info1CmpUseCloud').onclick = () => {
        if (!confirm('Esto reemplazará la copia de ESTE DISPOSITIVO por la versión de SUPABASE. ¿Querés continuar?')) return;
        closeCompare(); closePanel(); document.getElementById('info1PullCloud')?.click();
      };
    } catch (e) {
      overlay.querySelector('.cmp-card').innerHTML = `<div class="cmp-head"><div><h2>👀 Comparar versiones</h2><div class="muted">No pude leer ambas copias todavía.</div></div></div><div class="safe" style="border-color:#ef444477;background:#450a0a66;color:#fecaca">${esc(e?.message || 'Error desconocido')}</div><div class="cmp-actions"><button class="close" id="info1CmpClose">Cerrar</button></div>`;
      overlay.querySelector('#info1CmpClose').onclick = closeCompare;
    }
  }

  function ensureCompareButton() {
    const badge = document.getElementById('info1CloudBadge');
    if (!badge) return;
    const hasConflict = !!badge.querySelector('#info1KeepLocal');
    let btn = badge.querySelector(`#${COMPARE_BTN_ID}`);
    if (!hasConflict) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement('button'); btn.id = COMPARE_BTN_ID; btn.type = 'button';
      btn.textContent = '👀 Comparar versiones'; btn.className = 'primary';
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); showCompare(); });
      const first = badge.querySelector('button');
      if (first) first.before(btn); else badge.appendChild(btn);
    }
  }

  function boot() {
    injectStyles(); ensureButton(); closePanel();
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => { ensureButton(); updateButtonState(); ensureCompareButton(); }, 900);
    setTimeout(ensureCompareButton, 450);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (document.getElementById(COMPARE_OVERLAY_ID)) closeCompare(); else closePanel(); } });
})();
