(() => {
  'use strict';

  const STYLE_ID='nbGoodNotesUiStyles';
  const DOCK_ID='nbWritingDock';
  const ADVANCED_KEY='info1-notebook-advanced-toolbar-v1';
  const GESTURE_KEY='info1-notebook-page-gestures-v1';

  let observer=null;
  let viewportBound=false;
  let editorToken='';
  let gesturePointers=new Map();
  let gestureStart=null;
  let gestureTriggered=false;
  let activePoll=null;

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

  function buildDock(){
    const panel=document.getElementById('nbEditorPanel');
    const top=panel&&panel.querySelector('.nb-editor-top');
    if(!panel||!top) return null;
    let dock=document.getElementById(DOCK_ID);
    if(dock) return dock;

    dock=document.createElement('div');
    dock.id=DOCK_ID;
    dock.className='nb-writing-dock';
    dock.innerHTML=
      '<div class="nb-writing-dock-main">'+
        '<button class="nb-qaction nb-q-library" data-qaction="library" type="button" title="Volver a la biblioteca"><span class="ico">📚</span><span class="txt">Biblioteca</span></button>'+
      '</div>'+
      '<div class="nb-q-title"><strong>'+esc(editorTitle())+'</strong><span>'+esc(pageText()+(folderText()?' · '+folderText():''))+'</span></div>'+
      '<div class="nb-writing-dock-tools">'+
        '<button class="nb-qtool" data-qtool="pen" type="button" title="Lápiz"><span class="ico">✏️</span><span class="txt">Lápiz</span></button>'+
        '<button class="nb-qtool" data-qtool="highlighter" type="button" title="Resaltador"><span class="ico">🖍️</span><span class="txt">Resaltar</span></button>'+
        '<button class="nb-qtool" data-qtool="eraser" type="button" title="Borrador"><span class="ico">🧽</span><span class="txt">Borrar</span></button>'+
        '<button class="nb-qtool" data-qtool="lasso" type="button" title="Lazo"><span class="ico">✂️</span><span class="txt">Lazo</span></button>'+
        '<input class="nb-qcolor" id="nbQuickColor" type="color" aria-label="Color del lápiz">'+
        '<input class="nb-qwidth" id="nbQuickWidth" type="range" min="1" max="18" value="4" aria-label="Grosor">'+
        '<button class="nb-qaction" data-qaction="undo" type="button" title="Deshacer">↶</button>'+
        '<button class="nb-qaction" data-qaction="redo" type="button" title="Rehacer">↷</button>'+
        '<button class="nb-qaction" data-qaction="more" type="button" title="Más herramientas">•••</button>'+
      '</div>'+
      '<div class="nb-writing-dock-more"></div>';
    top.insertAdjacentElement('afterend',dock);

    dock.querySelector('[data-qaction="library"]').onclick=()=>proxyClick('nbBack');
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
    const saved=localStorage.getItem(ADVANCED_KEY);
    if(saved==='1')return true;
    if(saved==='0')return false;
    return !isCoarse()&&window.innerWidth>1024;
  }

  function setupAdvancedToolbar(){
    const bar=document.querySelector('#nbEditorPanel .nb-toolbar');
    if(!bar)return;
    bar.classList.add('nb-advanced-toolbar');
    bar.classList.toggle('nb-advanced-hidden',!defaultAdvancedOpen());
  }

  function toggleAdvanced(){
    const bar=document.querySelector('#nbEditorPanel .nb-toolbar');
    if(!bar)return;
    const hidden=bar.classList.toggle('nb-advanced-hidden');
    localStorage.setItem(ADVANCED_KEY,hidden?'0':'1');
    syncDockState();
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
    const enabled=()=>localStorage.getItem(GESTURE_KEY)!=='0';
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
    if(!isEditorVisible())return;
    installStyles();
    const sig=editorSignature();
    if(sig!==editorToken){
      editorToken=sig;
      buildDock();
      setupAdvancedToolbar();
      ensurePageZones();
      adjustPagerForKeyboard();
    }else{
      buildDock();setupAdvancedToolbar();ensurePageZones();
    }
    syncDockState();
  }

  function boot(){
    installStyles();
    bindViewport();
    bindKeyboardNavigation();
    observer=new MutationObserver(mutations=>{
      const relevant=mutations.some(m=>{
        const t=m.target&&m.target.nodeType===1?m.target:null;
        return !t||!t.closest||!t.closest('#'+DOCK_ID);
      });
      if(relevant)setTimeout(enhance,0);
    });
    const editorPanel=document.getElementById('nbEditorPanel');
    observer.observe(editorPanel||document.body,{childList:true,subtree:true});
    document.addEventListener('click',()=>setTimeout(syncDockState,0),true);
    document.addEventListener('change',()=>setTimeout(syncDockState,0),true);
    activePoll=setInterval(()=>{if(isEditorVisible())enhance();},700);
    enhance();

    window.INFO1_NOTEBOOK_INTERFACE={
      refresh:enhance,
      previousPage:()=>changePage(-1),
      nextPage:()=>changePage(1),
      toggleAdvanced,
      setGestures:enabled=>localStorage.setItem(GESTURE_KEY,enabled?'1':'0')
    };
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();