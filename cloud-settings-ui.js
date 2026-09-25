(() => {
  'use strict';
  const STYLE_ID = 'info1CloudSettingsUiStyles';
  const BTN_ID = 'info1CloudSettingsBtn';
  const BACKDROP_ID = 'info1CloudSettingsBackdrop';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #info1CloudBadge{display:none!important}
      #info1CloudBadge.info1-settings-open{display:block!important;position:fixed!important;top:86px!important;right:22px!important;bottom:auto!important;z-index:10002!important;width:min(560px,calc(100vw - 32px))!important;max-width:min(560px,calc(100vw - 32px))!important;padding:18px!important;border-radius:18px!important;box-shadow:0 24px 80px #000a!important}
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
      @media(max-width:700px){#info1CloudSettingsBtn{padding:8px 10px}#info1CloudBadge.info1-settings-open{top:74px!important;right:12px!important;width:calc(100vw - 24px)!important;max-width:none!important}}
    `;
    document.head.appendChild(style);
  }

  function closePanel() {
    document.getElementById('info1CloudBadge')?.classList.remove('info1-settings-open');
    document.getElementById(BACKDROP_ID)?.classList.remove('open');
    document.getElementById(BTN_ID)?.setAttribute('aria-expanded','false');
  }

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

  function updateButtonState() {
    const btn = document.getElementById(BTN_ID);
    const badge = document.getElementById('info1CloudBadge');
    if (!btn) return;
    btn.classList.remove('cloud-ok','cloud-warn','cloud-bad');
    if (badge?.classList.contains('ok')) btn.classList.add('cloud-ok');
    else if (badge?.classList.contains('bad')) btn.classList.add('cloud-bad');
    else if (badge?.classList.contains('warn')) btn.classList.add('cloud-warn');
    btn.title = badge?.querySelector('span')?.textContent?.trim() || 'Ajustes de sincronización y nube';
  }

  function togglePanel() {
    const badge = document.getElementById('info1CloudBadge');
    if (!badge) return;
    if (badge.classList.contains('info1-settings-open')) return closePanel();
    ensureBackdrop().classList.add('open');
    badge.classList.add('info1-settings-open');
    document.getElementById(BTN_ID)?.setAttribute('aria-expanded','true');
  }

  function ensureButton() {
    injectStyles();
    if (document.getElementById(BTN_ID)) return updateButtonState();
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-expanded','false');
    btn.setAttribute('aria-controls','info1CloudBadge');
    btn.innerHTML = '<span class="cloud-dot" aria-hidden="true"></span><span>⚙️ Ajustes</span>';
    btn.addEventListener('click', togglePanel);
    const topTabs = document.querySelector('.partial-switcher-tabs');
    const toolbar = document.querySelector('.toolbar');
    if (topTabs) topTabs.appendChild(btn);
    else if (toolbar) toolbar.appendChild(btn);
    else document.body.prepend(btn);
    updateButtonState();
  }

  function boot() {
    injectStyles();
    ensureBackdrop();
    ensureButton();
    const observer = new MutationObserver(() => { ensureButton(); updateButtonState(); });
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closePanel();});
})();
