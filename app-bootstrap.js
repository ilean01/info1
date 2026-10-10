(() => {
  'use strict';
  const panel=document.createElement('div');
  panel.id='info1BootStatus';panel.setAttribute('role','status');
  panel.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#09101f;color:#edf4ff;display:grid;place-content:center;text-align:center;padding:24px;font:18px system-ui';
  panel.textContent='Abriendo tus cuadernos…';document.body.appendChild(panel);
  function script(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('No se pudo cargar '+src));document.body.appendChild(s);});}
  async function boot(){
    await window.INFO1_STATE_STORAGE.ready;
    window.INFO1_WAS_LOCAL_STATE=!!window.INFO1_STATE_STORAGE.raw;
    const forceLocal = new URLSearchParams(location.search).get('info1_local') === '1';
    if (forceLocal) localStorage.setItem('info1-cloud-offline','1');
    for(const src of ['./app-core.js?v=20261008-heatquick2', './app-study.js?v=20261010-integration', './vendor/supabase-2.117.2.js', './supabase-config.js?v=20261005-width2', './cloud-sync.js?v=20261009-reconnect', './cloud-settings-ui.js?v=20261009-settings-page', './device-sync.js?v=20261005-width2', './notebooks-realtime.js?v=20261010-integration', './notebooks-selection.js?v=20261007-selection-lifecycle', './notebooks-resilience.js?v=20261009-audit', './notebooks-collaboration.js?v=20261005-width2', './notebooks-interface.js?v=20261005-width2', './notebooks-laser.js?v=20261005-toolrestore3', './supabase-media-bridge.js?v=20261005-width2']) {
      if (forceLocal && /(?:vendor\/supabase-|supabase-config|cloud-sync|cloud-settings-ui|device-sync|supabase-media-bridge)/.test(src)) continue;
      await script(src);
    }
    panel.remove();window.dispatchEvent(new Event('info1:app-ready'));
  }
  boot().catch(error=>{panel.textContent='No se pudo abrir INFO 1. Tus datos conservados no se borraron. '+error.message+' ';
    const retry=document.createElement('button');retry.textContent='Reintentar';retry.onclick=()=>location.reload();panel.appendChild(retry);
    const local=document.createElement('button');local.textContent='Abrir en modo local';local.style.cssText='margin:12px;padding:12px';local.onclick=()=>{const u=new URL(location.href);u.searchParams.set('info1_local','1');location.replace(u.toString());};panel.appendChild(local);});
})();
