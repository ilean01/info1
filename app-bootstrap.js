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
    for(const src of ['./app-core.js?v=20261005-width2', './app-study.js?v=20261005-width2', './vendor/supabase-2.117.2.js', './supabase-config.js?v=20261005-width2', './cloud-sync.js?v=20261005-width2', './cloud-settings-ui.js?v=20261005-width2', './device-sync.js?v=20261005-width2', './notebooks-realtime.js?v=20261005-fastink5', './notebooks-selection.js?v=20261005-oneshot4', './notebooks-resilience.js?v=20261005-width2', './notebooks-collaboration.js?v=20261005-width2', './notebooks-interface.js?v=20261005-width2', './notebooks-laser.js?v=20261005-toolrestore3', './supabase-media-bridge.js?v=20261005-width2'])await script(src);
    panel.remove();window.dispatchEvent(new Event('info1:app-ready'));
  }
  boot().catch(error=>{panel.textContent='No se pudo abrir INFO 1. Tus datos conservados no se borraron. '+error.message+' ';
    const retry=document.createElement('button');retry.textContent='Reintentar';retry.onclick=()=>location.reload();panel.appendChild(retry);});
})();
