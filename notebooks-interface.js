(() => {
  'use strict';

  const STYLE_ID='nbGoodNotesUiStyles';
  const DOCK_ID='nbWritingDock';
  const ADVANCED_KEY='info1-notebook-advanced-toolbar-v1';
  const GESTURE_KEY='info1-notebook-page-gestures-v1';
  const FULLSCREEN_CLASS='nb-pizarra-fullscreen';
  const FULLSCREEN_BODY_CLASS='nb-pizarra-fullscreen-lock';
  const FULLSCREEN_KEY='info1-notebook-canvas-fullscreen-v2';
  const FOCUS_ID='nbFocusSurface';
  const FLOATING_PALETTE_ID='nbFloatingPalette';
  const FLOATING_PALETTE_KEY='info1-notebook-floating-palette-open-v1';
  const FLOATING_MORE_KEY='info1-notebook-floating-palette-more-v1';

  let observer=null;
  let viewportBound=false;
  let editorToken='';
  let gesturePointers=new Map();
  let gestureStart=null;
  let gestureTriggered=false;
  let activePoll=null;
  let fullscreenRequested=false;
  let editorWasVisible=false;
  let enhancePending=false;

  function isEditorVisible(){
    const panel=document.getElementById('nbEditorPanel');
    return !!panel&&!panel.classList.contains('hidden')&&!!document.getElementById('nbCanvasScroller');
  }

  function isCoarse(){
    return !!(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches);
  }

  function installStyles(){
    if(document.getElementById(STYLE_ID)) return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=
      '#nbEditorPanel{--nb-ui-top:calc(env(safe-area-inset-top,0px) + 8px)}' +
      '#nbEditorPanel .nb-editor-top{position:sticky;top:var(--nb-ui-top);z-index:18000;padding:9px 11px;border:1px solid #3d5786;border-radius:15px;background:rgba(8,18,37,.94);backdrop-filter:blur(18px);box-shadow:0 10px 30px #0005}' +
      '#nbEditorPanel .nb-title-wrap h2{font-size:clamp(24px,3.2vw,38px);line-height:1.05;letter-spacing:-.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#nbEditorPanel .nb-title-wrap{min-width:0}' +
      '.nb-writing-dock{position:sticky;top:calc(var(--nb-ui-top) + 72px);z-index:17990;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:8px 9px;border:1px solid #49699d;border-radius:16px;background:rgba(11,24,48,.95);backdrop-filter:blur(20px);box-shadow:0 12px 34px #0006;margin-top:-4px}' +
      '.nb-writing-dock-main{display:flex;gap:6px;align-items:center;min-width:0;overflow:visible}.nb-writing-dock-tools{display:flex;gap:6px;align-items:center;justify-content:center;min-width:0;flex-wrap:nowrap}.nb-writing-dock-more{display:flex;gap:6px;justify-content:flex-end}' +
      '.nb-qtool,.nb-qaction{appearance:none;min-width:46px;min-height:46px;border:1px solid #3b5786;border-radius:12px;background:#101d38;color:#e9f1ff;font:900 13px/1 system-ui;display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;touch-action:manipulation;white-space:nowrap}' +
      '.nb-qtool .ico{font-size:21px}.nb-qtool .txt{font-size:11px}.nb-qtool.active{background:#2d5ca5;border-color:#86b0ff;box-shadow:inset 0 0 0 1px #ffffff22,0 0 0 2px #5791f422}.nb-qtool:disabled,.nb-qaction:disabled{opacity:.35}' +
      '.nb-q-library{padding:0 11px}.nb-q-library .txt{display:inline}.nb-q-title{min-width:0;display:flex;flex-direction:column;gap:2px}.nb-q-title strong{font:900 15px/1.15 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nb-q-title span{font:750 11px/1.2 system-ui;color:#aebfdb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.nb-qcolor{width:44px;height:44px;border:1px solid #3b5786;border-radius:12px;background:#101d38;padding:5px;cursor:pointer}.nb-qwidth{width:92px;accent-color:#77a7ff}' +
      '.nb-toolbar.nb-advanced-toolbar{margin-top:-4px;transition:max-height .2s ease,opacity .2s ease,padding .2s ease,border-width .2s ease}.nb-toolbar.nb-advanced-toolbar.nb-advanced-hidden{max-height:0!important;opacity:0;overflow:hidden;padding-top:0!important;padding-bottom:0!important;margin-top:-12px;border-width:0!important;pointer-events:none}' +
      '.nb-toolbar.nb-advanced-toolbar button,.nb-toolbar.nb-advanced-toolbar select,.nb-toolbar.nb-advanced-toolbar input{min-height:44px}.nb-toolbar.nb-advanced-toolbar select{font-size:16px}.nb-toolbar.nb-advanced-toolbar input[type=range]{min-width:130px}' +
      '.nb-canvas-wrap{position:relative}.nb-edge-page-zone{position:sticky;top:50%;z-index:35;width:34px;height:94px;margin-top:-47px;display:flex;align-items:center;justify-content:center;border:1px solid #ffffff20;background:#0711268a;color:#fff;border-radius:999px;font-size:28px;font-weight:500;backdrop-filter:blur(8px);opacity:.36;touch-action:none;user-select:none;-webkit-user-select:none}.nb-edge-page-zone:active{opacity:.95;background:#214b8d}.nb-edge-page-zone.left{left:7px;float:left}.nb-edge-page-zone.right{right:7px;float:right}.nb-canvas-wrap:hover .nb-edge-page-zone{opacity:.58}' +
      '.nb-bottom-pager{transition:bottom .18s ease,left .18s ease}.nb-bottom-pager.nb-keyboard-raised{box-shadow:0 8px 32px #0008}' +
      '@media(pointer:coarse){.nb-qtool,.nb-qaction{min-width:50px;min-height:50px;border-radius:14px}.nb-edge-page-zone{width:40px;height:106px;font-size:31px}.nb-toolbar.nb-advanced-toolbar button,.nb-toolbar.nb-advanced-toolbar select,.nb-toolbar.nb-advanced-toolbar input{min-height:48px}.nb-page-thumb-actions button,.nb-page-manager-head button{min-height:44px}.nb-page-tab{min-height:42px;padding:9px 13px}.nb-collab-bar select,.nb-collab-bar button{min-height:44px}}' +
      '@media(max-width:900px){#nbEditorPanel .nb-editor-top{top:calc(env(safe-area-inset-top,0px) + 4px);padding:7px 9px}.nb-editor-top #nbBack{display:none}.nb-editor-top .nb-actions{display:none}.nb-writing-dock{top:calc(env(safe-area-inset-top,0px) + 64px);grid-template-columns:auto 1fr auto;gap:6px;padding:7px}.nb-q-library .txt{display:none}.nb-q-library{padding:0;min-width:48px}.nb-q-title strong{font-size:14px}.nb-writing-dock-tools{justify-content:flex-start;overflow:visible}.nb-qtool .txt{display:none}.nb-qwidth{display:none}.nb-qtool,.nb-qaction{min-width:46px}.nb-writing-dock-more .nb-qaction[data-qaction="undo"],.nb-writing-dock-more .nb-qaction[data-qaction="redo"]{display:none}}' +
      '@media(max-width:640px){.nb-writing-dock{grid-template-columns:auto minmax(0,1fr);grid-template-areas:"lib title" "tools tools";top:calc(env(safe-area-inset-top,0px) + 58px)}.nb-writing-dock-main{grid-area:lib}.nb-q-title{grid-area:title}.nb-writing-dock-tools{grid-area:tools;justify-content:space-between}.nb-writing-dock-more{display:none}.nb-writing-dock-tools .nb-qcolor{width:42px;height:42px}.nb-qtool{min-width:43px;min-height:43px}.nb-edge-page-zone{width:34px;opacity:.28}}' +
      '@media(max-height:620px){.nb-writing-dock{position:relative;top:auto}#nbEditorPanel .nb-editor-top{position:relative;top:auto}}';
    style.textContent +=
      '.nb-fp-width-control{display:flex;align-items:center;gap:7px;color:#475569;font:800 11px system-ui}.nb-fp-width-control input{width:110px;min-width:0;height:36px;margin:0;accent-color:#2458a6;touch-action:none}.nb-fp-width-control output{min-width:24px;text-align:center;font-variant-numeric:tabular-nums}' +
      '@media(max-width:850px),(orientation:portrait) and (max-width:1100px){.nb-fp-width-control{flex-direction:column;gap:5px}.nb-fp-width-control input{writing-mode:vertical-lr;direction:rtl;width:36px;height:105px}}' +
      'body.'+FULLSCREEN_BODY_CLASS+'{overflow:hidden!important}' +
      '.nb-focus-surface{position:relative;min-width:0;isolation:isolate}' +
      '.nb-focus-surface.'+FULLSCREEN_CLASS+',.nb-focus-surface:fullscreen,.nb-focus-surface:-webkit-full-screen{position:fixed!important;inset:0!important;z-index:2147483000!important;width:100vw!important;height:100dvh!important;max-width:none!important;margin:0!important;padding:0!important;overflow:hidden!important;background:#e8edf5!important;overscroll-behavior:none}' +
      '.nb-focus-surface.'+FULLSCREEN_CLASS+' #nbCanvasScroller,.nb-focus-surface:fullscreen #nbCanvasScroller,.nb-focus-surface:-webkit-full-screen #nbCanvasScroller{height:100dvh!important;min-height:0!important;width:100vw!important;border:0!important;border-radius:0!important;margin:0!important;background:#dfe5ee!important;box-shadow:none!important;scrollbar-gutter:auto}' +
      '.nb-focus-surface.'+FULLSCREEN_CLASS+' .nb-canvas-stage,.nb-focus-surface:fullscreen .nb-canvas-stage,.nb-focus-surface:-webkit-full-screen .nb-canvas-stage{margin-top:18px!important;margin-bottom:110px!important}' +
      '.nb-focus-surface.'+FULLSCREEN_CLASS+' .nb-canvas-hint,.nb-focus-surface:fullscreen .nb-canvas-hint,.nb-focus-surface:-webkit-full-screen .nb-canvas-hint{opacity:.55}' +
      '.nb-q-fullscreen.active{background:#2458a6!important;border-color:#8bb7ff!important;box-shadow:0 0 0 2px #5791f433!important}' +
      '.nb-floating-palette{position:absolute;right:18px;top:18px;z-index:26000;display:flex;align-items:flex-start;gap:8px;pointer-events:auto;user-select:none;-webkit-user-select:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}' +
      '.nb-focus-surface.'+FULLSCREEN_CLASS+' .nb-floating-palette,.nb-focus-surface:fullscreen .nb-floating-palette,.nb-focus-surface:-webkit-full-screen .nb-floating-palette{position:fixed;right:max(16px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top))}' +
      '.nb-fp-show,.nb-fp-hide{appearance:none;border:1px solid #d8dee8;background:#fff;color:#172033;border-radius:18px;box-shadow:0 10px 30px #0002;min-width:48px;height:48px;font-size:22px;font-weight:900;cursor:pointer;touch-action:manipulation}' +
      '.nb-fp-show{display:none;border-radius:999px}.nb-floating-palette.collapsed .nb-fp-show{display:inline-flex;align-items:center;justify-content:center}.nb-floating-palette.collapsed .nb-fp-body{display:none}' +
      '.nb-fp-body{display:flex;align-items:center;gap:7px;padding:7px;background:#ffffffee;border:1px solid #d9dee8;border-radius:20px;box-shadow:0 14px 42px #0003;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}' +
      '.nb-fp-group{display:flex;align-items:center;gap:5px;padding-right:7px;margin-right:1px;border-right:1px solid #e5e7eb}.nb-fp-group:last-of-type{border-right:0;padding-right:0}' +
      '.nb-fp-tool,.nb-fp-action,.nb-fp-width,.nb-fp-shape{appearance:none;border:0;background:transparent;color:#202633;border-radius:12px;min-width:42px;height:42px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;font-size:20px;font-weight:850;cursor:pointer;touch-action:manipulation;transition:.14s ease}' +
      '.nb-fp-tool:hover,.nb-fp-action:hover,.nb-fp-width:hover,.nb-fp-shape:hover{background:#edf2f8}.nb-fp-tool.active,.nb-fp-shape.active{background:#dbeafe;color:#164e9a;box-shadow:inset 0 0 0 2px #73a7ef55}.nb-fp-tool[data-fptool="laser"].active{background:#fee2e2;color:#b91c1c;box-shadow:inset 0 0 0 2px #ef444455}' +
      '.nb-fp-color{appearance:none;width:31px;height:31px;border-radius:999px;border:2px solid #fff;box-shadow:0 0 0 1px #cbd5e1;cursor:pointer;padding:0}.nb-fp-color.active{box-shadow:0 0 0 3px #4f82e7}' +
      '.nb-fp-color.custom{overflow:hidden;background:conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}.nb-fp-color.custom input{opacity:0;width:100%;height:100%;cursor:pointer}' +
      '.nb-fp-width{min-width:34px;width:34px;padding:0;position:relative}.nb-fp-width:before{content:"";display:block;width:23px;height:var(--fpw,3px);max-height:12px;background:#111827;border-radius:999px}.nb-fp-width.active{background:#e0e7ff}' +
      '.nb-fp-mini-label{font-size:10px;font-weight:900;color:#64748b;padding:0 2px}.nb-fp-hide{min-width:38px;width:38px;height:38px;border-radius:12px;box-shadow:none;font-size:16px;background:#f8fafc}' +
      '.nb-fp-exit{display:none!important}.nb-focus-surface.'+FULLSCREEN_CLASS+' .nb-fp-exit,.nb-focus-surface:fullscreen .nb-fp-exit,.nb-focus-surface:-webkit-full-screen .nb-fp-exit{display:inline-flex!important}' +
      '@media(max-width:850px),(orientation:portrait) and (max-width:1100px){.nb-floating-palette{right:10px;top:14px}.nb-fp-body{flex-direction:column;border-radius:19px;padding:7px;max-height:calc(100dvh - 28px);overflow:auto}.nb-fp-group{flex-direction:column;border-right:0;border-bottom:1px solid #e5e7eb;padding-right:0;padding-bottom:6px;margin-right:0;margin-bottom:1px}.nb-fp-group:last-of-type{border-bottom:0;padding-bottom:0}.nb-fp-tool,.nb-fp-action,.nb-fp-shape{min-width:44px;width:44px;height:44px;padding:0}.nb-fp-mini-label{display:none}.nb-fp-color{width:30px;height:30px}}' +
      '@media(max-width:520px){.nb-floating-palette{right:7px;top:8px}.nb-fp-body{gap:4px;padding:5px}.nb-fp-group{gap:3px}.nb-fp-tool,.nb-fp-action,.nb-fp-shape{min-width:40px;width:40px;height:40px;font-size:18px}.nb-fp-color{width:27px;height:27px}.nb-fp-width{height:36px}}' +
      '#nbEditorPanel .nb-toolbar,#nbWritingDock,#nbSelectionExtTools,#nbImageTools{display:none!important}' +
      'body.'+FULLSCREEN_BODY_CLASS+' #nbEditorPanel{position:relative!important;z-index:2147482000!important}' +
      'body.'+FULLSCREEN_BODY_CLASS+' #nbCanvasScroller{position:fixed!important;inset:0!important;z-index:2147482500!important;width:100vw!important;height:100dvh!important;min-height:0!important;border:0!important;border-radius:0!important;margin:0!important;background:#dfe5ee!important;box-shadow:none!important}' +
      'body.'+FULLSCREEN_BODY_CLASS+' #'+FLOATING_PALETTE_ID+'{position:fixed!important;right:max(16px,env(safe-area-inset-right))!important;top:max(16px,env(safe-area-inset-top))!important;z-index:2147483000!important}' +
      '.nb-floating-palette{max-width:calc(100% - 36px)}' +
      '.nb-fp-shell{display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:100%}' +
      '.nb-fp-body{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}.nb-fp-body::-webkit-scrollbar{display:none}' +
      '.nb-fp-more.active{background:#e0e7ff!important;color:#334ea0!important}' +
      '.nb-fp-drawer{display:none;max-width:min(980px,calc(100vw - 36px));padding:10px;background:#ffffffee;border:1px solid #d9dee8;border-radius:18px;box-shadow:0 14px 42px #0003;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);color:#172033}' +
      '.nb-floating-palette.more-open .nb-fp-drawer{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px}' +
      '.nb-fp-panel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;padding:8px;border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc}' +
      '.nb-fp-panel strong{width:100%;font:900 11px/1.2 system-ui;color:#64748b;text-transform:uppercase;letter-spacing:.04em}' +
      '.nb-fp-panel button,.nb-fp-panel select,.nb-fp-panel input[type=range]{min-height:40px;border:1px solid #d6dde8;background:#fff;color:#1f2937;border-radius:10px;padding:7px 9px;font:800 12px/1 system-ui}' +
      '.nb-fp-panel button{cursor:pointer}.nb-fp-panel button.active{background:#dbeafe;border-color:#73a7ef;color:#164e9a}' +
      '.nb-fp-panel select{max-width:180px}.nb-fp-panel input[type=range]{padding:0;width:110px}.nb-fp-panel input[type=color]{width:40px;height:40px;padding:3px;border:1px solid #d6dde8;border-radius:10px;background:#fff}' +
      '.nb-fp-status{display:inline-flex;align-items:center;min-height:34px;padding:0 9px;border:1px solid #d6dde8;border-radius:999px;background:#fff;color:#475569;font:800 11px/1 system-ui;white-space:nowrap}' +
      '.nb-fp-danger{color:#b42318!important;border-color:#fecaca!important;background:#fff7f7!important}' +
      '.nb-fp-selection-actions,.nb-fp-image-actions{display:none}.nb-floating-palette.has-selection .nb-fp-selection-actions,.nb-floating-palette.has-image .nb-fp-image-actions{display:flex}' +
      '@media(max-width:900px){.nb-floating-palette.more-open .nb-fp-drawer{grid-template-columns:repeat(2,minmax(145px,1fr));max-height:62dvh;overflow:auto}.nb-fp-panel{align-content:flex-start}}' +
      '@media(max-width:560px){.nb-floating-palette.more-open .nb-fp-drawer{grid-template-columns:1fr;max-width:calc(100vw - 20px);max-height:68dvh}.nb-fp-panel select{max-width:100%;flex:1}.nb-fp-panel input[type=range]{flex:1}}';
    style.textContent +=
      '.nb-fp-width-control{display:flex;align-items:center;gap:7px;color:#475569;font:800 11px system-ui}.nb-fp-width-control input{width:110px;min-width:0;height:36px;margin:0;accent-color:#2458a6;touch-action:none}.nb-fp-width-control output{min-width:24px;text-align:center;font-variant-numeric:tabular-nums}' +
      '@media(max-width:850px),(orientation:portrait) and (max-width:1100px){.nb-fp-width-control{flex-direction:column;gap:5px}.nb-fp-width-control input{writing-mode:vertical-lr;direction:rtl;width:36px;height:105px}}' +
      'body.'+FULLSCREEN_BODY_CLASS+' .nb-fp-exit{display:inline-flex!important}' +
      '.nb-fp-shell{max-height:calc(100dvh - 32px)}.nb-fp-body{min-height:0;flex-shrink:1}' +
      '.nb-floating-palette.more-open .nb-fp-drawer{position:fixed;right:max(90px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top));bottom:max(16px,env(safe-area-inset-bottom));max-height:none;width:min(680px,calc(100vw - 110px));max-width:calc(100vw - 110px);overflow:auto;align-content:start}' +
      '#nbAlwaysExit{display:none;position:fixed;left:max(12px,env(safe-area-inset-left));top:max(12px,env(safe-area-inset-top));z-index:2147483002;border:1px solid #bdc9db;border-radius:12px;background:#fff;color:#172033;padding:12px 16px;font:800 14px system-ui;box-shadow:0 4px 15px #0002}' +
      'body.'+FULLSCREEN_BODY_CLASS+' #nbAlwaysExit{display:block}' +
      '@media(max-width:560px){.nb-floating-palette.more-open .nb-fp-drawer{right:65px;width:calc(100vw - 80px);max-width:calc(100vw - 80px);grid-template-columns:minmax(0,1fr)}.nb-fp-panel{overflow-wrap:anywhere}}';
    document.head.appendChild(style);
  }

  function esc(v){
    return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function editorTitle(){
    const h=document.querySelector('#nbEditorPanel .nb-title-wrap h2');
    return h?h.textContent.trim():'Cuaderno';
  }

  function folderText(){
    const lives=[...document.querySelectorAll('#nbEditorPanel .nb-title-wrap .nb-live')];
    const folder=lives.find(el=>/📁|🗒️/.test(el.textContent||''));
    return folder?folder.textContent.trim():'';
  }

  function pageText(){
    const count=document.getElementById('nbBottomCount');
    return count?count.textContent.trim():'';
  }

  function proxyClick(id){
    const el=document.getElementById(id);
    if(el&&!el.disabled) el.click();
    setTimeout(syncDockState,0);
  }

  function nativeFullscreenElement(){
    return document.fullscreenElement||document.webkitFullscreenElement||null;
  }

  function ensureFocusSurface(){
    const panel=document.getElementById('nbEditorPanel');
    const scroller=document.getElementById('nbCanvasScroller');
    if(!panel||!scroller)return null;

    // Compatibilidad: versiones anteriores envolvían físicamente el canvas.
    // En iPad eso podía provocar recálculos/ResizeObserver continuos al abrir.
    const legacy=document.getElementById(FOCUS_ID);
    if(legacy&&legacy!==scroller&&legacy.contains(scroller)){
      const parent=legacy.parentNode;
      if(parent){
        parent.insertBefore(scroller,legacy);
        const pager=legacy.querySelector('#nbBottomPager');
        if(pager)parent.insertBefore(pager,legacy.nextSibling);
      }
      legacy.remove();
    }

    // La paleta vive en el editor, pero el canvas nunca cambia de padre.
    ensureFloatingPalette(panel);
    return scroller;
  }

  function fullscreenSurface(){
    return document.getElementById('nbCanvasScroller')||ensureFocusSurface();
  }

  function fullscreenWanted(){
    return fullscreenRequested;
  }

  function fullscreenActive(){
    return fullscreenWanted();
  }

  function repairFullscreenState(){
    if(!fullscreenWanted())return;
    const panel=document.getElementById('nbEditorPanel');
    const scroller=document.getElementById('nbCanvasScroller');
    if(!panel||panel.classList.contains('hidden')||!scroller)return;
    document.body.classList.add(FULLSCREEN_BODY_CLASS);
    const surface=ensureFocusSurface();
    if(surface&&!surface.classList.contains(FULLSCREEN_CLASS)){
      surface.classList.add(FULLSCREEN_CLASS);
    }
    syncFullscreenButton();
    syncFloatingPalette();
  }

  function setPseudoFullscreen(on){
    const surface=fullscreenSurface();
    if(!surface)return;
    fullscreenRequested=!!on;
    surface.classList.toggle(FULLSCREEN_CLASS,!!on);
    document.body.classList.toggle(FULLSCREEN_BODY_CLASS,!!on);
    syncFullscreenButton();
    syncFloatingPalette();
    if(on)requestAnimationFrame(repairFullscreenState);
    setTimeout(()=>{adjustPagerForKeyboard();window.dispatchEvent(new Event('resize'));},60);
  }

  async function exitFullscreenMode(){
    // Si quedó activo un fullscreen nativo de una versión anterior, salimos una vez.
    try{
      if(nativeFullscreenElement()){
        const exit=document.exitFullscreen||document.webkitExitFullscreen;
        if(exit)await Promise.resolve(exit.call(document));
      }
    }catch(_){}
    fullscreenRequested=false;
    const surface=fullscreenSurface();
    if(surface)surface.classList.remove(FULLSCREEN_CLASS);
    document.body.classList.remove(FULLSCREEN_BODY_CLASS);
    syncFullscreenButton();
    syncFloatingPalette();
    setTimeout(()=>{adjustPagerForKeyboard();window.dispatchEvent(new Event('resize'));},60);
  }

  async function toggleFullscreen(){
    // Usamos pantalla completa dentro de la app (CSS) en lugar del Fullscreen API.
    // Así pegar, abrir la fototeca/cámara o reconstruir el editor no expulsa
    // al usuario de la pizarra.
    setPseudoFullscreen(!fullscreenActive());
  }

  function syncFullscreenButton(){
    const btn=document.querySelector('#'+DOCK_ID+' [data-qaction="fullscreen"]');
    if(!btn)return;
    const on=fullscreenActive();
    btn.classList.toggle('active',on);
    btn.title=on?'Salir de pantalla completa':'Mostrar solamente las hojas en pantalla completa';
    btn.innerHTML=on
      ? '<span class="ico">🗗</span><span class="txt">Salir</span>'
      : '<span class="ico">⛶</span><span class="txt">Hojas</span>';
  }

  function setActualColor(value){
    const actual=document.getElementById('nbColor');
    const quick=document.getElementById('nbQuickColor');
    if(actual){
      actual.value=value;
      actual.dispatchEvent(new Event('input',{bubbles:true}));
      actual.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(quick)quick.value=value;
    syncFloatingPalette();
  }

  function setActualWidth(value){
    const actual=document.getElementById('nbWidth');
    const quick=document.getElementById('nbQuickWidth');
    if(actual){
      actual.value=String(value);
      actual.dispatchEvent(new Event('input',{bubbles:true}));
      actual.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(quick)quick.value=String(value);
    syncFloatingPalette();
  }

  function chooseShape(value){
    const select=document.getElementById('nbShape');
    if(!select)return;
    select.value=value;
    select.dispatchEvent(new Event('change',{bubbles:true}));
    setTimeout(syncFloatingPalette,0);
  }

  function paletteOpen(){
    return INFO1_LOCAL.getItem(FLOATING_PALETTE_KEY)!=='0';
  }

  function paletteMoreOpen(){
    return INFO1_LOCAL.getItem(FLOATING_MORE_KEY)==='1';
  }

  function setPaletteMoreOpen(open){
    INFO1_LOCAL.setItem(FLOATING_MORE_KEY,open?'1':'0');
    const palette=document.getElementById(FLOATING_PALETTE_ID);
    if(palette)palette.classList.toggle('more-open',!!open);
    syncFloatingPalette();
  }

  function setPaletteOpen(open){
    INFO1_LOCAL.setItem(FLOATING_PALETTE_KEY,open?'1':'0');
    const palette=document.getElementById(FLOATING_PALETTE_ID);
    if(palette)palette.classList.toggle('collapsed',!open);
    if(!open)setPaletteMoreOpen(false);
  }

  function setSelectValue(id,value){
    const el=document.getElementById(id);
    if(!el)return;
    el.value=value;
    el.dispatchEvent(new Event('change',{bubbles:true}));
    setTimeout(syncFloatingPalette,0);
  }

  function clickSelectionAction(action){
    const btn=document.querySelector('#nbSelectionExtTools [data-sel="'+action+'"]');
    if(btn&&!btn.disabled)btn.click();
  }

  function clickImageAction(id){
    const btn=document.getElementById(id);
    if(btn&&!btn.disabled)btn.click();
  }

  function ensureFloatingPalette(surface){
    if(!surface)return null;
    let palette=document.getElementById(FLOATING_PALETTE_ID);
    if(palette&&palette.parentNode!==surface)palette.remove();
    if(palette)return palette;

    palette=document.createElement('div');
    palette.id=FLOATING_PALETTE_ID;
    palette.className='nb-floating-palette'+(paletteOpen()?'':' collapsed')+(paletteMoreOpen()?' more-open':'');
    palette.innerHTML=
      '<button class="nb-fp-show" type="button" title="Mostrar herramientas">✎</button>'+
      '<div class="nb-fp-shell">'+
        '<div class="nb-fp-body">'+
          '<div class="nb-fp-group">'+
            '<button class="nb-fp-tool" data-fptool="pen" type="button" title="Lápiz">✒️</button>'+
            '<button class="nb-fp-tool" data-fptool="highlighter" type="button" title="Resaltador">🖍️</button>'+
            '<button class="nb-fp-tool" data-fptool="eraser" type="button" title="Borrador">⌫</button>'+
            '<button class="nb-fp-tool" data-fptool="lasso" type="button" title="Lazo">✂️</button>'+
            '<button class="nb-fp-tool" data-fptool="line" type="button" title="Línea recta">╱</button>'+
            '<button class="nb-fp-shape" data-fpshape="rectangle" type="button" title="Cuadrado / rectángulo">▢</button>'+
            '<button class="nb-fp-shape" data-fpshape="circle" type="button" title="Círculo">○</button>'+
            '<button class="nb-fp-shape" data-fpshape="triangle" type="button" title="Triángulo">△</button>'+
            '<button class="nb-fp-tool" data-fptool="laser" type="button" title="Láser persistente">🔴</button>'+
          '</div>'+
          '<div class="nb-fp-group">'+
            '<span class="nb-fp-color" data-fpcolor="#111827" style="background:#111827" title="Negro"></span>'+
            '<span class="nb-fp-color" data-fpcolor="#2563eb" style="background:#2563eb" title="Azul"></span>'+
            '<span class="nb-fp-color" data-fpcolor="#ef4444" style="background:#ef4444" title="Rojo"></span>'+
            '<span class="nb-fp-color" data-fpcolor="#10b981" style="background:#10b981" title="Verde"></span>'+
            '<span class="nb-fp-color custom" title="Otro color"><input data-fpcolor-custom type="color" value="#7c3aed" aria-label="Otro color"></span>'+
          '</div>'+
          '<div class="nb-fp-group">'+
            '<label class="nb-fp-width-control" for="nbFloatingWidth"><span>Grosor</span><input id="nbFloatingWidth" type="range" min="1" max="18" step="0.5" value="4" aria-label="Grosor del lápiz"><output for="nbFloatingWidth" id="nbFloatingWidthValue">4</output></label>'+
          '</div>'+
          '<div class="nb-fp-group">'+
            '<button class="nb-fp-action" data-fpaction="undo" type="button" title="Deshacer">↶</button>'+
            '<button class="nb-fp-action" data-fpaction="redo" type="button" title="Rehacer">↷</button>'+
            '<button class="nb-fp-action nb-fp-more" data-fpaction="more" type="button" title="Todas las herramientas">•••</button>'+
            '<button class="nb-fp-action nb-fp-exit" data-fpaction="fullscreen" type="button" title="Salir de pantalla completa">⛶</button>'+
            '<button class="nb-fp-hide" type="button" title="Ocultar herramientas">✕</button>'+
          '</div>'+
        '</div>'+
        '<div class="nb-fp-drawer">'+
          '<div class="nb-fp-panel">'+
            '<strong>✍️ Escritura</strong>'+
            '<select data-fpselect="brush" aria-label="Tipo de lápiz">'+
              '<option value="ballpoint">Bolígrafo</option><option value="fountain">Pluma</option><option value="pencil">Lápiz grafito</option>'+
            '</select>'+
            '<select data-fpselect="eraser" aria-label="Modo de borrador">'+
              '<option value="pixel">Borrar parte</option><option value="stroke">Borrar trazo completo</option>'+
            '</select>'+
            '<button data-fpaction="finger" type="button">☝️ Dedo</button>'+
            '<span class="nb-fp-status" data-fpstatus="input">Touch / mouse</span>'+
          '</div>'+
          '<div class="nb-fp-panel">'+
            '<strong>🔍 Vista y hojas</strong>'+
            '<button data-fpaction="zoomout" type="button">−</button>'+
            '<button data-fpaction="zoomreset" type="button" data-fpstatus="zoom">100%</button>'+
            '<button data-fpaction="zoomin" type="button">＋</button>'+
            '<button data-fpaction="fullscreen" type="button">⛶ Pantalla</button>'+
            '<button data-fpaction="library" type="button">📚 Biblioteca</button>'+
            '<button data-fpaction="addpage" type="button">＋ Hoja</button>'+
            '<button data-fpaction="deletepage" class="nb-fp-danger" type="button">🗑 Hoja</button>'+
            '<button data-fpaction="mode" type="button">✍️ Editar</button>'+
          '</div>'+
          '<div class="nb-fp-panel">'+
            '<strong>🖼️ Imágenes y página</strong>'+
            '<button data-fpaction="paste" type="button">📋 Pegar</button>'+
            '<button data-fpaction="photos" type="button">🖼️ Archivo</button>'+
            '<button data-fpaction="camera" type="button">📷 Cámara</button>'+
            '<button data-fpaction="clear" class="nb-fp-danger" type="button">Limpiar página</button>'+
            '<div class="nb-fp-image-actions">'+
              '<button data-fpimage="nbImageCrop" type="button">✂️ Recortar</button>'+
              '<button data-fpimage="nbImageDuplicate" type="button">⧉ Duplicar</button>'+
              '<button data-fpimage="nbImageLock" type="button">🔒 Bloquear</button>'+
              '<button data-fpimage="nbImageFront" type="button">⬆ Frente</button>'+
              '<button data-fpimage="nbImageBack" type="button">⬇ Atrás</button>'+
              '<button data-fpimage="nbImageBackground" type="button">🖼 Fondo</button>'+
              '<button data-fpimage="nbImageDelete" class="nb-fp-danger" type="button">🗑 Imagen</button>'+
            '</div>'+
          '</div>'+
          '<div class="nb-fp-panel">'+
            '<strong>🔴 Láser</strong>'+
            '<select data-fplaser="mode" aria-label="Modo del láser"><option value="point">● Punto</option><option value="trail">〰 Trazo</option></select>'+
            '<input data-fplaser="color" type="color" aria-label="Color del láser">'+
            '<span class="nb-fp-mini-label">Trazo</span><input data-fplaser="width" type="range" min="2" max="24" step="1">'+
            '<span class="nb-fp-mini-label">Punto</span><input data-fplaser="point" type="range" min="8" max="72" step="1">'+
            '<span class="nb-fp-status" data-fpstatus="laser">Láser</span>'+
          '</div>'+
          '<div class="nb-fp-panel nb-fp-selection-actions">'+
            '<strong>✂️ Selección</strong>'+
            '<button data-fpsel="duplicate" type="button">⧉ Duplicar</button>'+
            '<button data-fpsel="copy" type="button">Copiar</button>'+
            '<button data-fpsel="cut" type="button">Cortar</button>'+
            '<button data-fpsel="paste" type="button">Pegar</button>'+
            '<button data-fpsel="group" type="button">Agrupar</button>'+
            '<button data-fpsel="ungroup" type="button">Desagrupar</button>'+
            '<button data-fpsel="move-page" type="button">Mover a hoja…</button>'+
            '<button data-fpsel="copy-notebook" type="button">Copiar a cuaderno…</button>'+
            '<button data-fpsel="delete" class="nb-fp-danger" type="button">Eliminar</button>'+
          '</div>'+
        '</div>'+
      '</div>';

    surface.appendChild(palette);

    palette.querySelector('.nb-fp-show').onclick=()=>setPaletteOpen(true);
    palette.querySelector('.nb-fp-hide').onclick=()=>setPaletteOpen(false);

    palette.querySelectorAll('[data-fptool]').forEach(btn=>{
      btn.onclick=()=>{
        const tool=btn.dataset.fptool;
        if(tool==='pen')proxyClick('nbPen');
        else if(tool==='highlighter')proxyClick('nbHighlighter');
        else if(tool==='eraser')proxyClick('nbEraser');
        else if(tool==='line')proxyClick('nbLine');
        else if(tool==='lasso'){
          const lasso=document.getElementById('nbLassoExt')||document.getElementById('nbLasso');
          if(lasso)lasso.click();
        }else if(tool==='laser'){
          const laser=window.INFO1_NOTEBOOK_LASER;
          if(laser&&typeof laser.toggle==='function')laser.toggle();
          else{
            const q=document.getElementById('nbLaserQuick')||document.getElementById('nbLaserTool');
            if(q)q.click();
          }
        }
        setTimeout(syncFloatingPalette,10);
      };
    });

    palette.querySelectorAll('[data-fpshape]').forEach(btn=>btn.onclick=()=>chooseShape(btn.dataset.fpshape));
    palette.querySelectorAll('[data-fpcolor]').forEach(el=>el.onclick=()=>setActualColor(el.dataset.fpcolor));
    const custom=palette.querySelector('[data-fpcolor-custom]');
    if(custom)custom.oninput=()=>setActualColor(custom.value);
    palette.querySelector('#nbFloatingWidth').oninput=e=>setActualWidth(Number(e.target.value));

    const actions={
      undo:'nbUndo',redo:'nbRedo',zoomout:'nbZoomOut',zoomreset:'nbZoomLabel',zoomin:'nbZoomIn',
      finger:'nbFingerMode',paste:'nbPasteImage',photos:'nbPhotoLibrary',camera:'nbCameraImage',
      clear:'nbClear',addpage:'nbAddPage',deletepage:'nbDeletePage',mode:'nbMode'
    };
    Object.keys(actions).forEach(action=>{
      const el=palette.querySelector('[data-fpaction="'+action+'"]');
      if(el)el.onclick=()=>proxyClick(actions[action]);
    });
    palette.querySelectorAll('[data-fpaction="fullscreen"]').forEach(el=>el.onclick=()=>toggleFullscreen());
    const library=palette.querySelector('[data-fpaction="library"]');
    if(library)library.onclick=async()=>{if(fullscreenActive())await exitFullscreenMode();proxyClick('nbBack');};
    const more=palette.querySelector('[data-fpaction="more"]');
    if(more)more.onclick=()=>setPaletteMoreOpen(!paletteMoreOpen());

    palette.querySelector('[data-fpselect="brush"]').onchange=e=>setSelectValue('nbBrush',e.target.value);
    palette.querySelector('[data-fpselect="eraser"]').onchange=e=>setSelectValue('nbEraserMode',e.target.value);
    palette.querySelectorAll('[data-fpsel]').forEach(btn=>btn.onclick=()=>clickSelectionAction(btn.dataset.fpsel));
    palette.querySelectorAll('[data-fpimage]').forEach(btn=>btn.onclick=()=>clickImageAction(btn.dataset.fpimage));

    const laserMode=palette.querySelector('[data-fplaser="mode"]');
    const laserColor=palette.querySelector('[data-fplaser="color"]');
    const laserWidth=palette.querySelector('[data-fplaser="width"]');
    const laserPoint=palette.querySelector('[data-fplaser="point"]');
    laserMode.onchange=()=>setSelectValue('nbLaserMode',laserMode.value);
    laserColor.oninput=()=>{
      const el=document.getElementById('nbLaserColor');
      if(el){el.value=laserColor.value;el.dispatchEvent(new Event('input',{bubbles:true}));}
    };
    laserWidth.oninput=()=>{
      const el=document.getElementById('nbLaserWidth');
      if(el){el.value=laserWidth.value;el.dispatchEvent(new Event('input',{bubbles:true}));}
    };
    laserPoint.oninput=()=>{
      const el=document.getElementById('nbLaserPoint');
      if(el){el.value=laserPoint.value;el.dispatchEvent(new Event('input',{bubbles:true}));}
    };

    syncFloatingPalette();
    return palette;
  }

  function syncFloatingPalette(){
    const palette=document.getElementById(FLOATING_PALETTE_ID);
    if(!palette)return;
    palette.classList.toggle('collapsed',!paletteOpen());
    palette.classList.toggle('more-open',paletteMoreOpen());

    const map={
      pen:document.getElementById('nbPen'),
      highlighter:document.getElementById('nbHighlighter'),
      eraser:document.getElementById('nbEraser'),
      line:document.getElementById('nbLine'),
      lasso:document.getElementById('nbLassoExt')||document.getElementById('nbLasso')
    };
    palette.querySelectorAll('[data-fptool]').forEach(btn=>{
      const t=btn.dataset.fptool;
      const on=t==='laser'
        ? !!(window.INFO1_NOTEBOOK_LASER&&window.INFO1_NOTEBOOK_LASER.active)
        : !!(map[t]&&map[t].classList.contains('active'));
      btn.classList.toggle('active',on);
    });

    const shape=document.getElementById('nbShape');
    palette.querySelectorAll('[data-fpshape]').forEach(btn=>{
      btn.classList.toggle('active',!!shape&&shape.classList.contains('active')&&shape.value===btn.dataset.fpshape);
    });

    const color=(document.getElementById('nbColor')||{}).value||'';
    palette.querySelectorAll('[data-fpcolor]').forEach(el=>el.classList.toggle('active',String(el.dataset.fpcolor).toLowerCase()===String(color).toLowerCase()));
    const custom=palette.querySelector('[data-fpcolor-custom]');
    if(custom&&color)custom.value=color;

    const width=Number((document.getElementById('nbWidth')||{}).value||4);
    const widthSlider=palette.querySelector('#nbFloatingWidth');
    const widthValue=palette.querySelector('#nbFloatingWidthValue');
    if(widthSlider && Number(widthSlider.value)!==width)widthSlider.value=String(width);
    const widthLabel=String(width).replace('.',',');
    if(widthValue && widthValue.textContent!==widthLabel)widthValue.textContent=widthLabel;

    const brush=document.getElementById('nbBrush');
    const pBrush=palette.querySelector('[data-fpselect="brush"]');
    if(brush&&pBrush&&pBrush.value!==brush.value)pBrush.value=brush.value;

    const eraserMode=document.getElementById('nbEraserMode');
    const pEraser=palette.querySelector('[data-fpselect="eraser"]');
    if(eraserMode&&pEraser&&pEraser.value!==eraserMode.value)pEraser.value=eraserMode.value;

    const input=document.getElementById('nbInputStatus');
    const pInput=palette.querySelector('[data-fpstatus="input"]');
    if(input&&pInput)pInput.textContent=input.textContent||'Touch / mouse';

    const zoom=document.getElementById('nbZoomLabel');
    const pZoom=palette.querySelector('[data-fpstatus="zoom"]');
    if(zoom&&pZoom)pZoom.textContent=zoom.textContent||'100%';

    const finger=document.getElementById('nbFingerMode');
    const pFinger=palette.querySelector('[data-fpaction="finger"]');
    if(finger&&pFinger){
      pFinger.textContent=finger.textContent||'☝️ Dedo';
      pFinger.classList.toggle('active',finger.classList.contains('active'));
    }

    const mode=document.getElementById('nbMode');
    const pMode=palette.querySelector('[data-fpaction="mode"]');
    if(mode&&pMode){
      pMode.textContent=mode.textContent||'✍️ Editar';
      pMode.classList.toggle('active',/editar/i.test(mode.textContent||''));
    }

    const laserMode=document.getElementById('nbLaserMode');
    const laserColor=document.getElementById('nbLaserColor');
    const laserWidth=document.getElementById('nbLaserWidth');
    const laserPoint=document.getElementById('nbLaserPoint');
    const pLaserMode=palette.querySelector('[data-fplaser="mode"]');
    const pLaserColor=palette.querySelector('[data-fplaser="color"]');
    const pLaserWidth=palette.querySelector('[data-fplaser="width"]');
    const pLaserPoint=palette.querySelector('[data-fplaser="point"]');
    if(laserMode&&pLaserMode)pLaserMode.value=laserMode.value;
    if(laserColor&&pLaserColor)pLaserColor.value=laserColor.value;
    if(laserWidth&&pLaserWidth)pLaserWidth.value=laserWidth.value;
    if(laserPoint&&pLaserPoint)pLaserPoint.value=laserPoint.value;
    const laserStatus=document.getElementById('nbLaserStatus');
    const pLaserStatus=palette.querySelector('[data-fpstatus="laser"]');
    if(pLaserStatus)pLaserStatus.textContent=laserStatus?laserStatus.textContent:'Láser';

    const selectionTools=document.getElementById('nbSelectionExtTools');
    palette.classList.toggle('has-selection',!!(selectionTools&&!selectionTools.classList.contains('hidden')));

    const imageTools=document.getElementById('nbImageTools');
    palette.classList.toggle('has-image',!!(imageTools&&imageTools.classList.contains('active')));

    const more=palette.querySelector('[data-fpaction="more"]');
    if(more)more.classList.toggle('active',paletteMoreOpen());
  }

  function buildDock(){
    const panel=document.getElementById('nbEditorPanel');
    const top=panel&&panel.querySelector('.nb-editor-top');
    if(!panel||!top) return null;
    let dock=document.getElementById(DOCK_ID);
    if(dock) return dock;

    dock=document.createElement('div');
    dock.id=DOCK_ID;
    dock.className='nb-writing-dock nb-legacy-hidden';
    dock.innerHTML=
      '<div class="nb-writing-dock-main">'+
        '<button class="nb-qaction nb-q-library" data-qaction="library" type="button" title="Volver a la biblioteca"><span class="ico">📚</span><span class="txt">Biblioteca</span></button>'+
        '<button class="nb-qaction nb-q-fullscreen" data-qaction="fullscreen" type="button" title="Pizarra en pantalla completa"><span class="ico">⛶</span><span class="txt">Pantalla</span></button>'+
      '</div>'+
      '<div class="nb-q-title"><strong>'+esc(editorTitle())+'</strong><span>'+esc(pageText()+(folderText()?' · '+folderText():''))+'</span></div>'+
      '<div class="nb-writing-dock-tools">'+
        '<button class="nb-qtool" data-qtool="pen" type="button" title="Lápiz"><span class="ico">✏️</span><span class="txt">Lápiz</span></button>'+
        '<button class="nb-qtool" data-qtool="highlighter" type="button" title="Resaltador"><span class="ico">🖍️</span><span class="txt">Resaltar</span></button>'+
        '<button class="nb-qtool" data-qtool="eraser" type="button" title="Borrador"><span class="ico">🧽</span><span class="txt">Borrar</span></button>'+
        '<button class="nb-qtool" data-qtool="lasso" type="button" title="Lazo"><span class="ico">✂️</span><span class="txt">Lazo</span></button>'+
        '<input class="nb-qcolor" id="nbQuickColor" type="color" aria-label="Color del lápiz">'+
        '<input class="nb-qwidth" id="nbQuickWidth" type="range" min="1" max="18" step="0.5" value="4" aria-label="Grosor">'+
        '<button class="nb-qaction" data-qaction="undo" type="button" title="Deshacer">↶</button>'+
        '<button class="nb-qaction" data-qaction="redo" type="button" title="Rehacer">↷</button>'+
        '<button class="nb-qaction" data-qaction="more" type="button" title="Más herramientas">•••</button>'+
      '</div>'+
      '<div class="nb-writing-dock-more"></div>';
    top.insertAdjacentElement('afterend',dock);

    dock.querySelector('[data-qaction="library"]').onclick=async()=>{
      if(fullscreenActive())await exitFullscreenMode();
      proxyClick('nbBack');
    };
    dock.querySelector('[data-qaction="fullscreen"]').onclick=()=>toggleFullscreen();
    dock.querySelector('[data-qtool="pen"]').onclick=()=>proxyClick('nbPen');
    dock.querySelector('[data-qtool="highlighter"]').onclick=()=>proxyClick('nbHighlighter');
    dock.querySelector('[data-qtool="eraser"]').onclick=()=>proxyClick('nbEraser');
    dock.querySelector('[data-qtool="lasso"]').onclick=()=>{
      const lasso=document.getElementById('nbLassoExt')||document.getElementById('nbLasso');
      if(lasso)lasso.click();
      setTimeout(syncDockState,0);
    };
    dock.querySelector('[data-qaction="undo"]').onclick=()=>proxyClick('nbUndo');
    dock.querySelector('[data-qaction="redo"]').onclick=()=>proxyClick('nbRedo');
    dock.querySelector('[data-qaction="more"]').onclick=toggleAdvanced;

    const color=dock.querySelector('#nbQuickColor');
    const width=dock.querySelector('#nbQuickWidth');
    color.oninput=()=>{
      const actual=document.getElementById('nbColor');
      if(actual){actual.value=color.value;actual.dispatchEvent(new Event('input',{bubbles:true}));actual.dispatchEvent(new Event('change',{bubbles:true}));}
    };
    width.oninput=()=>{
      const actual=document.getElementById('nbWidth');
      if(actual){actual.value=width.value;actual.dispatchEvent(new Event('input',{bubbles:true}));actual.dispatchEvent(new Event('change',{bubbles:true}));}
    };
    return dock;
  }

  function defaultAdvancedOpen(){
    const saved=INFO1_LOCAL.getItem(ADVANCED_KEY);
    if(saved==='1')return true;
    if(saved==='0')return false;
    return !isCoarse()&&window.innerWidth>1024;
  }

  function setupAdvancedToolbar(){
    const bar=document.querySelector('#nbEditorPanel .nb-toolbar');
    if(!bar)return;
    bar.classList.add('nb-advanced-toolbar','nb-advanced-hidden');
  }

  function toggleAdvanced(){
    setPaletteOpen(true);
    setPaletteMoreOpen(!paletteMoreOpen());
  }

  function syncDockState(){
    if(!isEditorVisible())return;
    const dock=document.getElementById(DOCK_ID);
    if(!dock)return;
    const map={
      pen:document.getElementById('nbPen'),
      highlighter:document.getElementById('nbHighlighter'),
      eraser:document.getElementById('nbEraser'),
      lasso:document.getElementById('nbLassoExt')||document.getElementById('nbLasso')
    };
    Object.keys(map).forEach(key=>{
      const q=dock.querySelector('[data-qtool="'+key+'"]');
      if(q)q.classList.toggle('active',!!(map[key]&&map[key].classList.contains('active')));
    });
    const color=document.getElementById('nbColor');
    const quickColor=document.getElementById('nbQuickColor');
    if(color&&quickColor&&quickColor.value!==color.value)quickColor.value=color.value;
    const width=document.getElementById('nbWidth');
    const quickWidth=document.getElementById('nbQuickWidth');
    if(width&&quickWidth&&String(quickWidth.value)!==String(width.value))quickWidth.value=width.value;
    const title=dock.querySelector('.nb-q-title strong');
    const meta=dock.querySelector('.nb-q-title span');
    if(title)title.textContent=editorTitle();
    if(meta)meta.textContent=pageText()+(folderText()?' · '+folderText():'');
    const more=dock.querySelector('[data-qaction="more"]');
    const bar=document.querySelector('#nbEditorPanel .nb-toolbar');
    if(more&&bar)more.classList.toggle('active',!bar.classList.contains('nb-advanced-hidden'));
    syncFullscreenButton();
    syncFloatingPalette();
  }

  function ensurePageZones(){
    const scroller=document.getElementById('nbCanvasScroller');
    if(!scroller)return;
    if(!scroller.querySelector('.nb-edge-page-zone.left')){
      const left=document.createElement('div');
      left.className='nb-edge-page-zone left';left.textContent='‹';left.setAttribute('aria-label','Hoja anterior');
      const right=document.createElement('div');
      right.className='nb-edge-page-zone right';right.textContent='›';right.setAttribute('aria-label','Hoja siguiente');
      scroller.prepend(right);scroller.prepend(left);
      bindEdgeZone(left,-1);
      bindEdgeZone(right,1);
    }
    bindThreeFingerGesture(scroller);
  }

  function changePage(direction){
    const btn=document.getElementById(direction<0?'nbPrevPage':'nbNextPage');
    if(btn&&!btn.disabled){btn.click();if(navigator.vibrate)navigator.vibrate(12);}
  }

  function bindEdgeZone(zone,direction){
    let start=null;
    zone.addEventListener('pointerdown',e=>{
      if(e.pointerType==='pen')return;
      start={id:e.pointerId,x:e.clientX,y:e.clientY,at:Date.now()};
      zone.setPointerCapture&&zone.setPointerCapture(e.pointerId);
      e.preventDefault();e.stopPropagation();
    },{passive:false});
    zone.addEventListener('pointermove',e=>{
      if(!start||e.pointerId!==start.id)return;
      e.preventDefault();e.stopPropagation();
    },{passive:false});
    const end=e=>{
      if(!start||e.pointerId!==start.id)return;
      const dx=e.clientX-start.x,dy=e.clientY-start.y;
      const horizontal=Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)*1.25;
      const tap=Math.hypot(dx,dy)<14&&Date.now()-start.at<450;
      if(tap||horizontal)changePage(horizontal?(dx<0?1:-1):direction);
      start=null;e.preventDefault();e.stopPropagation();
    };
    zone.addEventListener('pointerup',end,{passive:false});
    zone.addEventListener('pointercancel',()=>{start=null;});
  }

  function bindThreeFingerGesture(scroller){
    if(scroller.dataset.nbGestureBound==='1')return;
    scroller.dataset.nbGestureBound='1';
    const enabled=()=>INFO1_LOCAL.getItem(GESTURE_KEY)!=='0';
    scroller.addEventListener('pointerdown',e=>{
      if(!enabled()||e.pointerType!=='touch')return;
      gesturePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(gesturePointers.size===3){
        const pts=[...gesturePointers.values()];
        gestureStart={x:pts.reduce((s,p)=>s+p.x,0)/3,y:pts.reduce((s,p)=>s+p.y,0)/3};
        gestureTriggered=false;
      }
    },true);
    scroller.addEventListener('pointermove',e=>{
      if(!gesturePointers.has(e.pointerId))return;
      gesturePointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(!gestureStart||gesturePointers.size<3||gestureTriggered)return;
      const pts=[...gesturePointers.values()].slice(0,3);
      const now={x:pts.reduce((s,p)=>s+p.x,0)/3,y:pts.reduce((s,p)=>s+p.y,0)/3};
      const dx=now.x-gestureStart.x,dy=now.y-gestureStart.y;
      if(Math.abs(dx)>78&&Math.abs(dx)>Math.abs(dy)*1.4){
        gestureTriggered=true;
        changePage(dx<0?1:-1);
        e.preventDefault();e.stopPropagation();
      }
    },{capture:true,passive:false});
    const clear=e=>{
      gesturePointers.delete(e.pointerId);
      if(gesturePointers.size<3){gestureStart=null;gestureTriggered=false;}
    };
    scroller.addEventListener('pointerup',clear,true);
    scroller.addEventListener('pointercancel',clear,true);
  }

  function bindKeyboardNavigation(){
    if(document.body.dataset.nbKeyboardNavBound==='1')return;
    document.body.dataset.nbKeyboardNavBound='1';
    document.addEventListener('keydown',e=>{
      if(!isEditorVisible()||e.metaKey||e.ctrlKey||e.altKey)return;
      const tag=(e.target&&e.target.tagName||'').toLowerCase();
      if(['input','textarea','select'].includes(tag)||(e.target&&e.target.isContentEditable))return;
      if(e.key==='PageUp'){e.preventDefault();changePage(-1);}
      if(e.key==='PageDown'){e.preventDefault();changePage(1);}
    });
  }

  function adjustPagerForKeyboard(){
    const pager=document.getElementById('nbBottomPager');
    if(!pager)return;
    const vv=window.visualViewport;
    if(!vv){
      pager.style.bottom='max(10px, env(safe-area-inset-bottom))';
      pager.classList.remove('nb-keyboard-raised');
      return;
    }
    const occluded=Math.max(0,window.innerHeight-(vv.height+vv.offsetTop));
    const keyboard=occluded>90;
    pager.classList.toggle('nb-keyboard-raised',keyboard);
    pager.style.bottom=(keyboard?Math.max(10,occluded+10):10)+'px';
    pager.style.left=(vv.offsetLeft+vv.width/2)+'px';
  }

  function bindViewport(){
    if(viewportBound)return;
    viewportBound=true;
    const vv=window.visualViewport;
    if(vv){vv.addEventListener('resize',adjustPagerForKeyboard,{passive:true});vv.addEventListener('scroll',adjustPagerForKeyboard,{passive:true});}
    window.addEventListener('resize',adjustPagerForKeyboard,{passive:true});
    window.addEventListener('orientationchange',()=>setTimeout(adjustPagerForKeyboard,120),{passive:true});
  }

  function editorSignature(){
    return [editorTitle(),pageText(),!!document.getElementById('nbCanvasScroller')].join('|');
  }

  function enhance(){
    if(!isEditorVisible()){
      editorWasVisible=false;
      return;
    }
    const justOpened=!editorWasVisible;
    editorWasVisible=true;
    installStyles();
    const sig=editorSignature();
    if(sig!==editorToken){
      editorToken=sig;
      buildDock();
      setupAdvancedToolbar();
      ensureFocusSurface();
      ensurePageZones();
      adjustPagerForKeyboard();
    }else{
      buildDock();setupAdvancedToolbar();ensureFocusSurface();ensurePageZones();
    }
    // Cada vez que se abre una pizarra/cuaderno, entrar directamente
    // en la vista de hojas a pantalla completa. Si el usuario sale
    // manualmente, no se fuerza de nuevo hasta que cierre y vuelva a abrir.
    if(justOpened&&!fullscreenActive())setPseudoFullscreen(true);
    syncDockState();
  }

  function boot(){
    installStyles();
    const exit=document.createElement('button');exit.id='nbAlwaysExit';exit.type='button';exit.textContent='⤡ Salir';exit.setAttribute('aria-label','Salir de pantalla completa');exit.onclick=exitFullscreenMode;document.body.appendChild(exit);
    bindViewport();
    bindKeyboardNavigation();
    const onFsChange=()=>{if(fullscreenWanted())repairFullscreenState();syncFullscreenButton();syncFloatingPalette();setTimeout(()=>{adjustPagerForKeyboard();window.dispatchEvent(new Event('resize'));},40);};
    document.addEventListener('fullscreenchange',onFsChange);
    document.addEventListener('webkitfullscreenchange',onFsChange);
    observer=new MutationObserver(()=>{
      if(enhancePending)return;
      enhancePending=true;
      requestAnimationFrame(()=>{
        enhancePending=false;
        if(isEditorVisible()){
          enhance();
          repairFullscreenState();
        }else{
          editorWasVisible=false;
          if(fullscreenActive())exitFullscreenMode();
        }
      });
    });
    const editorPanel=document.getElementById('nbEditorPanel');
    // Solo cambios estructurales directos del editor; no observar todo el subtree.
    observer.observe(editorPanel,{childList:true});
    document.addEventListener('click',()=>setTimeout(syncDockState,0),true);
    document.addEventListener('change',()=>setTimeout(syncDockState,0),true);
    window.addEventListener('focus',()=>{if(fullscreenWanted())setTimeout(repairFullscreenState,0);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&fullscreenWanted())setTimeout(repairFullscreenState,0);});
    // Fallback liviano: no rehacer la interfaz 4 veces por segundo en iPad.
    activePoll=setInterval(()=>{if(isEditorVisible())syncDockState();},1500);
    enhance();

    window.INFO1_NOTEBOOK_INTERFACE={
      refresh:enhance,
      previousPage:()=>changePage(-1),
      nextPage:()=>changePage(1),
      toggleAdvanced,
      toggleFullscreen,
      exitFullscreen:exitFullscreenMode,
      get fullscreen(){return fullscreenActive();},
      repairFullscreen:repairFullscreenState,
      showTools:()=>setPaletteOpen(true),
      hideTools:()=>setPaletteOpen(false),
      setGestures:enabled=>INFO1_LOCAL.setItem(GESTURE_KEY,enabled?'1':'0')
    };
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();