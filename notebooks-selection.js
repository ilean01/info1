(() => {
  'use strict';

  const OPEN_KEY = 'info1-notebook-open-v1';
  const LOGICAL_WIDTH = 1000;
  const TOOL_ID = 'nbLassoExt';
  const STYLE_ID = 'nbSelectionExtStyle';
  const LASSO_KEY = 'info1-notebook-lasso-active-v1';

  let selectionMode = INFO1_LOCAL.getItem(LASSO_KEY) === '1';
  let selectedStrokes = new Set();
  let selectedImages = new Set();
  let clipboard = null;
  let lassoPoints = null;
  let cancelLassoGesture = null;
  let boundCanvas = null;
  let stageResizeObserver = null;
  let lastContextKey = '';
  let refreshTimer = null;

  function api() {
    return window.INFO1_NOTEBOOKS || null;
  }

  function resilience() {
    return window.INFO1_NOTEBOOK_RESILIENCE || null;
  }

  function syncSelectionPresence(extra) {
    const r=resilience(), nb=currentNotebook(), page=currentPage();
    if (!r || !r.syncSelection || !nb || !page) return;
    r.syncSelection(nb.id,page.id,Object.assign({
      active:selectionMode,
      strokeIds:Array.from(selectedStrokes),
      imageIds:Array.from(selectedImages),
      bounds:selectionBounds()
    },extra||{}));
  }

  function readOpen() {
    try { return JSON.parse(INFO1_LOCAL.getItem(OPEN_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function currentNotebook() {
    const a = api();
    if (!a || !a.current || typeof a.list !== 'function') return null;
    return a.list().find(nb => nb && nb.id === a.current) || null;
  }

  function currentPage() {
    const nb = currentNotebook();
    if (!nb) return null;
    const pageId = readOpen().pageId;
    return (nb.pages || []).find(p => p.id === pageId) || (nb.pages || [])[0] || null;
  }

  function isEditorVisible() {
    const panel = document.getElementById('nbEditorPanel');
    return !!panel && !panel.classList.contains('hidden');
  }

  function isReadOnly() {
    const btn = document.getElementById('nbMode');
    return !!btn && /solo lectura/i.test(btn.textContent || '');
  }

  function uuid() {
    return crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'sel-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function deep(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function stage() {
    return document.getElementById('nbCanvasStage');
  }

  function canvas() {
    return document.getElementById('info1NotebookCanvas');
  }

  function scale() {
    const s = stage();
    return s ? Math.max(0.001, s.getBoundingClientRect().width / LOGICAL_WIDTH) : 1;
  }

  function logicalPoint(clientX, clientY) {
    const s = stage();
    if (!s) return {x:0,y:0};
    const r = s.getBoundingClientRect();
    const k = Math.max(0.001, r.width / LOGICAL_WIDTH);
    return {
      x: clamp((clientX - r.left) / k, 0, LOGICAL_WIDTH),
      y: Math.max(0, (clientY - r.top) / k)
    };
  }

  function selectionCount() {
    return selectedStrokes.size + selectedImages.size;
  }

  function hasSelection() {
    return selectionCount() > 0;
  }

  function selectedItems(page = currentPage()) {
    if (!page) return {strokes:[], images:[]};
    return {
      strokes: (page.strokes || []).filter(s => selectedStrokes.has(s.id)),
      images: (page.images || []).filter(i => selectedImages.has(i.id))
    };
  }

  function clearSelection(render = true) {
    if (cancelLassoGesture) cancelLassoGesture();
    selectedStrokes.clear();
    selectedImages.clear();
    lassoPoints = null;
    if (render) {
      renderOverlay();
      highlightImages();
      updateTools();
      syncSelectionPresence({cleared:true,lasso:null});
    }
  }

  function pointInPolygon(point, polygon) {
    if (!point || !polygon || polygon.length < 3) return false;
    let inside = false;
    for (let i=0, j=polygon.length-1; i<polygon.length; j=i++) {
      const xi=polygon[i].x, yi=polygon[i].y;
      const xj=polygon[j].x, yj=polygon[j].y;
      const crosses = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj-xi) * (point.y-yi) / ((yj-yi) || 1e-9) + xi);
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function rotatePoint(x, y, cx, cy, radians) {
    const dx=x-cx, dy=y-cy;
    return {
      x: cx + dx*Math.cos(radians) - dy*Math.sin(radians),
      y: cy + dx*Math.sin(radians) + dy*Math.cos(radians)
    };
  }

  function strokeBounds(stroke) {
    if (!stroke) return null;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    const add = (x,y) => {
      x = Number(x); y = Number(y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX=Math.min(minX,x); maxX=Math.max(maxX,x);
      minY=Math.min(minY,y); maxY=Math.max(maxY,y);
    };
    if (stroke.shapeData) {
      const d=stroke.shapeData;
      add(d.x1*LOGICAL_WIDTH,d.y1);
      add(d.x2*LOGICAL_WIDTH,d.y2);
    }
    (stroke.points || []).forEach(p => add((Number(p.x)||0)*LOGICAL_WIDTH, Number(p.y)||0));
    if (!Number.isFinite(minX)) return null;
    const pad=Math.max(5,(Number(stroke.width)||4)*1.5);
    return {minX:minX-pad,minY:minY-pad,maxX:maxX+pad,maxY:maxY+pad};
  }

  function imageBounds(image) {
    if (!image) return null;
    const cx=image.x+image.w/2, cy=image.y+image.h/2;
    const a=(Number(image.rotation)||0)*Math.PI/180;
    const corners=[
      {x:image.x,y:image.y},
      {x:image.x+image.w,y:image.y},
      {x:image.x+image.w,y:image.y+image.h},
      {x:image.x,y:image.y+image.h}
    ].map(p => rotatePoint(p.x,p.y,cx,cy,a));
    return {
      minX:Math.min(...corners.map(p=>p.x)),
      minY:Math.min(...corners.map(p=>p.y)),
      maxX:Math.max(...corners.map(p=>p.x)),
      maxY:Math.max(...corners.map(p=>p.y))
    };
  }

  function selectionBounds() {
    const items=selectedItems();
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    [...items.strokes.map(strokeBounds), ...items.images.map(imageBounds)].filter(Boolean).forEach(b => {
      minX=Math.min(minX,b.minX); minY=Math.min(minY,b.minY);
      maxX=Math.max(maxX,b.maxX); maxY=Math.max(maxY,b.maxY);
    });
    if (!Number.isFinite(minX)) return null;
    return {
      minX,minY,maxX,maxY,
      width:Math.max(1,maxX-minX),
      height:Math.max(1,maxY-minY),
      cx:(minX+maxX)/2,
      cy:(minY+maxY)/2
    };
  }

  function expandGroups(page) {
    if (!page) return;
    const groups=new Set();
    (page.strokes||[]).forEach(s => { if (selectedStrokes.has(s.id) && s.groupId) groups.add(s.groupId); });
    (page.images||[]).forEach(i => { if (selectedImages.has(i.id) && i.groupId) groups.add(i.groupId); });
    if (!groups.size) return;
    (page.strokes||[]).forEach(s => { if (s.groupId && groups.has(s.groupId)) selectedStrokes.add(s.id); });
    (page.images||[]).forEach(i => { if (i.groupId && groups.has(i.groupId)) selectedImages.add(i.id); });
  }

  function selectWithPolygon(polygon) {
    const page=currentPage();
    clearSelection(false);
    if (!page || !polygon || polygon.length<3) {
      renderOverlay(); highlightImages(); updateTools(); return;
    }

    (page.strokes||[]).forEach(stroke => {
      if (!stroke || stroke.tool === 'eraser') return;
      let hit=(stroke.points||[]).some(p => pointInPolygon({x:(Number(p.x)||0)*LOGICAL_WIDTH,y:Number(p.y)||0},polygon));
      if (!hit) {
        const b=strokeBounds(stroke);
        if (b) hit=pointInPolygon({x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2},polygon);
      }
      if (hit) selectedStrokes.add(stroke.id);
    });

    (page.images||[]).forEach(image => {
      if (!image || image.background || image.locked) return;
      const b=imageBounds(image);
      if (!b) return;
      const points=[
        {x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2},
        {x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},
        {x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}
      ];
      if (points.some(p => pointInPolygon(p,polygon))) selectedImages.add(image.id);
    });

    expandGroups(page);
    renderOverlay();
    highlightImages();
    updateTools();
    syncSelectionPresence({lasso:null});
  }

  function selectSingleImage(imageId) {
    const page=currentPage();
    const image=page && (page.images||[]).find(i=>i.id===imageId);
    if (!image || image.background) return;
    clearSelection(false);
    selectedImages.add(imageId);
    expandGroups(page);
    renderOverlay();
    highlightImages();
    updateTools();
    syncSelectionPresence({lasso:null});
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=
      '#'+TOOL_ID+'.active{background:#284d8e!important;border-color:#78a7ff!important}' +
      '.nb-selection-ext-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid #42659b;background:#0b1730;border-radius:12px;margin:7px 0}' +
      '.nb-selection-ext-tools.hidden{display:none}.nb-selection-ext-tools .label{font-weight:900;color:#d7e6ff;margin-right:auto}' +
      '.nb-selection-ext-layer{position:absolute;inset:0;z-index:8;pointer-events:none}.nb-selection-ext-box{position:absolute;border:2px dashed #3478f6;background:#3478f612;box-sizing:border-box;pointer-events:none;touch-action:none}' +
      '.nb-selection-ext-box:before{content:"";position:absolute;inset:-7px;border:1px solid #8eb6ff66;pointer-events:none}' +
      '.nb-selection-ext-handle{position:absolute;width:24px;height:24px;border-radius:999px;background:#fff;border:2px solid #3478f6;box-shadow:0 2px 10px #0007;pointer-events:auto}' +
      '.nb-selection-ext-resize{right:-13px;bottom:-13px;cursor:nwse-resize}.nb-selection-ext-rotate{left:50%;top:-40px;transform:translateX(-50%);cursor:grab}' +
      '.nb-selection-ext-rotate:after{content:"";position:absolute;left:10px;top:20px;width:2px;height:20px;background:#3478f6}' +
      '.nb-selection-ext-lasso{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.nb-lasso-selected{outline:3px solid #3478f6!important;outline-offset:3px!important}';
    document.head.appendChild(style);
  }

  function ensureOverlayLayer() {
    const s=stage();
    if (!s) return null;
    let layer=document.getElementById('nbSelectionExtLayer');
    if (!layer) {
      layer=document.createElement('div');
      layer.id='nbSelectionExtLayer';
      layer.className='nb-selection-ext-layer';
      s.appendChild(layer);
    }
    return layer;
  }

  function drawLassoSvg(layer) {
    if (!layer || !lassoPoints || lassoPoints.length<2) return;
    const k=scale();
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','nb-selection-ext-lasso');
    const poly=document.createElementNS('http://www.w3.org/2000/svg','polyline');
    poly.setAttribute('points',lassoPoints.map(p=>(p.x*k)+','+(p.y*k)).join(' '));
    poly.setAttribute('fill','rgba(52,120,246,.06)');
    poly.setAttribute('stroke','#3478f6');
    poly.setAttribute('stroke-width','2');
    poly.setAttribute('stroke-dasharray','8 5');
    svg.appendChild(poly);
    layer.appendChild(svg);
  }

  function renderOverlay() {
    const layer=ensureOverlayLayer();
    if (!layer) return;
    layer.innerHTML='';
    drawLassoSvg(layer);
    if (!hasSelection()) return;
    const b=selectionBounds();
    if (!b) return;
    const k=scale();
    const box=document.createElement('div');
    box.className='nb-selection-ext-box';
    box.style.pointerEvents=selectionMode?'auto':'none';
    box.style.left=(b.minX*k)+'px';
    box.style.top=(b.minY*k)+'px';
    box.style.width=(b.width*k)+'px';
    box.style.height=(b.height*k)+'px';
    box.title='Arrastrá para mover la selección';
    box.addEventListener('pointerdown',e => {
      if (e.target!==box || isReadOnly()) return;
      startTransform(e,'move');
    });
    if (selectionMode && !isReadOnly()) {
      const resize=document.createElement('span');
      resize.className='nb-selection-ext-handle nb-selection-ext-resize';
      resize.title='Redimensionar';
      resize.addEventListener('pointerdown',e=>startTransform(e,'resize'));
      box.appendChild(resize);
      const rotate=document.createElement('span');
      rotate.className='nb-selection-ext-handle nb-selection-ext-rotate';
      rotate.title='Rotar';
      rotate.addEventListener('pointerdown',e=>startTransform(e,'rotate'));
      box.appendChild(rotate);
    }
    layer.appendChild(box);
  }

  function highlightImages() {
    document.querySelectorAll('.nb-image-object[data-image-id]').forEach(el => {
      el.classList.toggle('nb-lasso-selected',selectedImages.has(el.dataset.imageId));
    });
  }

  function leaveSelectionForDrawing() {
    const hadSelection = selectionMode || hasSelection() || !!cancelLassoGesture;
    selectionMode=false;
    INFO1_LOCAL.setItem(LASSO_KEY,'0');
    if (!hadSelection) return;
    clearSelection(false);
    const lasso=document.getElementById(TOOL_ID);
    if (lasso) lasso.classList.remove('active');
    renderOverlay();
    highlightImages();
    updateTools();
    syncSelectionPresence({cleared:true,lasso:null});
  }

  function bindDrawingToolExit() {
    ['nbPen','nbHighlighter','nbLine','nbEraser'].forEach(id => {
      const el=document.getElementById(id);
      if (!el || el.dataset.selectionExitBound==='1') return;
      el.dataset.selectionExitBound='1';
      el.addEventListener('click',leaveSelectionForDrawing,true);
    });
    const shape=document.getElementById('nbShape');
    if (shape && shape.dataset.selectionExitBound!=='1') {
      shape.dataset.selectionExitBound='1';
      shape.addEventListener('change',leaveSelectionForDrawing,true);
    }
  }

  function ensureUi() {
    if (!isEditorVisible()) return;
    ensureStyles();
    const toolbar=document.querySelector('#nbEditorPanel .nb-toolbar');
    bindDrawingToolExit();
    if (toolbar && !document.getElementById(TOOL_ID)) {
      const btn=document.createElement('button');
      btn.id=TOOL_ID;
      btn.type='button';
      btn.textContent='✂️ Lazo';
      btn.title='Seleccionar trazos, dibujos e imágenes con Apple Pencil o mouse';
      const eraser=document.getElementById('nbEraser');
      if (eraser) toolbar.insertBefore(btn,eraser);
      else toolbar.appendChild(btn);
      btn.addEventListener('click',() => {
        selectionMode=!selectionMode;
        INFO1_LOCAL.setItem(LASSO_KEY,selectionMode?'1':'0');
        btn.classList.toggle('active',selectionMode);
        if (!selectionMode) {
          clearSelection(false);
          syncSelectionPresence({cleared:true,lasso:null});
        } else {
          syncSelectionPresence({lasso:[]});
        }
        renderOverlay();
        updateTools();
      });
    }

    let tools=document.getElementById('nbSelectionExtTools');
    if (!tools) {
      tools=document.createElement('div');
      tools.id='nbSelectionExtTools';
      tools.className='nb-selection-ext-tools hidden';
      tools.innerHTML=
        '<span id="nbSelectionExtLabel" class="label">✂️ Lazo</span>' +
        '<button data-sel="duplicate" class="nb-btn" type="button">⧉ Duplicar</button>' +
        '<button data-sel="copy" class="nb-btn" type="button">Copiar</button>' +
        '<button data-sel="cut" class="nb-btn" type="button">Cortar</button>' +
        '<button data-sel="paste" class="nb-btn" type="button">Pegar</button>' +
        '<button data-sel="group" class="nb-btn" type="button">Agrupar</button>' +
        '<button data-sel="ungroup" class="nb-btn" type="button">Desagrupar</button>' +
        '<button data-sel="move-page" class="nb-btn" type="button">Mover a hoja…</button>' +
        '<button data-sel="copy-notebook" class="nb-btn" type="button">Copiar a cuaderno…</button>' +
        '<button data-sel="delete" class="nb-btn danger" type="button">Eliminar</button>';
      const imageTools=document.getElementById('nbImageTools');
      if (imageTools && imageTools.parentNode) imageTools.parentNode.insertBefore(tools,imageTools);
      else if (toolbar && toolbar.parentNode) toolbar.parentNode.insertBefore(tools,toolbar.nextSibling);
      tools.addEventListener('click',e => {
        const action=e.target && e.target.dataset && e.target.dataset.sel;
        if (!action) return;
        if (action==='duplicate') duplicateSelection();
        else if (action==='copy') copySelection();
        else if (action==='cut') cutSelection();
        else if (action==='paste') pasteSelection();
        else if (action==='delete') deleteSelection();
        else if (action==='group') groupSelection();
        else if (action==='ungroup') ungroupSelection();
        else if (action==='move-page') moveSelectionToPage();
        else if (action==='copy-notebook') copySelectionToNotebook();
      });
    }
    const btn=document.getElementById(TOOL_ID);
    if (btn) btn.classList.toggle('active',selectionMode);
    ensureOverlayLayer();
    bindCanvas();
    bindStageResize();
    updateTools();
    highlightImages();
    renderOverlay();
  }

  function updateTools() {
    const tools=document.getElementById('nbSelectionExtTools');
    if (!tools) return;
    tools.classList.toggle('hidden',!(selectionMode || hasSelection() || clipboard));
    const label=document.getElementById('nbSelectionExtLabel');
    if (label) label.textContent=hasSelection() ? '✂️ '+selectionCount()+' seleccionado(s)' : '✂️ Lazo';
    tools.querySelectorAll('[data-sel]').forEach(btn => {
      const action=btn.dataset.sel;
      if (action==='paste') btn.disabled=isReadOnly() || !clipboard;
      else btn.disabled=isReadOnly() || !hasSelection();
    });
  }

  function bindStageResize() {
    const s=stage();
    if (!s || s.dataset.selectionResizeBound==='1') return;
    s.dataset.selectionResizeBound='1';
    if (stageResizeObserver) stageResizeObserver.disconnect();
    stageResizeObserver=new ResizeObserver(()=>renderOverlay());
    stageResizeObserver.observe(s);
  }

  function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function bindCanvas() {
    const cv=canvas();
    if (!cv || cv===boundCanvas) return;
    if (boundCanvas) {
      // Si el canvas se reconstruye, mantenemos el lazo activo hasta que
      // la persona lo desactive o elija otra herramienta.
      clearSelection(false);
    }
    boundCanvas=cv;

    cv.addEventListener('pointerdown',e => {
      if (!selectionMode || isReadOnly()) return;
      // Two-finger touch remains reserved for the base pan/zoom implementation.
      if (e.pointerType==='touch') return;
      if (cancelLassoGesture) cancelLassoGesture();
      stopEvent(e);
      lassoPoints=[logicalPoint(e.clientX,e.clientY)];
      renderOverlay();
      syncSelectionPresence({lasso:lassoPoints.slice()});
      const pointerId=e.pointerId;

      const move=ev => {
        if (ev.pointerId!==pointerId || !lassoPoints) return;
        stopEvent(ev);
        const p=logicalPoint(ev.clientX,ev.clientY);
        const last=lassoPoints[lassoPoints.length-1];
        if (!last || Math.hypot(p.x-last.x,p.y-last.y)>2) {
          lassoPoints.push(p);
          syncSelectionPresence({lasso:lassoPoints.slice()});
        }
        renderOverlay();
      };
      const end=ev => {
        if (ev.pointerId!==pointerId) return;
        stopEvent(ev);
        const polygon=(lassoPoints||[]).slice();
        cancelLassoGesture();
        if (ev.type !== 'pointercancel') selectWithPolygon(polygon);
        // El lazo queda activo para seguir seleccionando. No volvemos a Lápiz
        // automáticamente: solo cambia cuando la persona desactiva el lazo o
        // elige otra herramienta.
        renderOverlay();
        updateTools();
        syncSelectionPresence({active:true,lasso:null});
      };
      cancelLassoGesture = () => {
        window.removeEventListener('pointermove',move,true);
        window.removeEventListener('pointerup',end,true);
        window.removeEventListener('pointercancel',end,true);
        lassoPoints=null;
        cancelLassoGesture=null;
      };
      window.addEventListener('pointermove',move,{capture:true,passive:false});
      window.addEventListener('pointerup',end,true);
      window.addEventListener('pointercancel',end,true);
    },true);
  }

  function saveChanges(notebooks, message) {
    const list=(notebooks||[]).filter(Boolean);
    list.forEach(nb => nb.updatedAt=new Date().toISOString());
    try {
      const a=api();
      if (a && a._bridge && a._bridge.persist) a._bridge.persist();
      else if (typeof window.save==='function') window.save();
      else if (typeof save==='function') save();
      if (a && a._bridge && a._bridge.broadcast) {
        list.forEach(nb => a._bridge.broadcast('pages-replaced',{
          notebookId:nb.id,pages:nb.pages||[],
          currentPageId:nb.id===a.current?(readOpen().pageId||null):null
        }));
      }
    } catch (e) { console.warn('INFO1 selección: no se pudo guardar',e); }
    syncSelectionPresence({lasso:null});
    if (message) toast(message);
  }

  function refreshEditor() {
    const a=api(), nb=currentNotebook(), page=currentPage();
    if (!a || !nb || !page || typeof a.open!=='function') return;
    const pageId=page.id;
    clearTimeout(refreshTimer);
    refreshTimer=setTimeout(() => {
      a.open(nb.id,pageId,false,false);
      setTimeout(ensureUi,80);
    },0);
  }

  function refreshCanvasInPlace() {
    const a=api();
    try {
      if (a && a._bridge && typeof a._bridge.refreshCanvas==='function') {
        a._bridge.refreshCanvas();
        return;
      }
      if (a && a._bridge && typeof a._bridge.refresh==='function') a._bridge.refresh();
    } catch (e) {
      console.warn('INFO1 selección: no se pudo refrescar el canvas',e);
    }
  }

  function commitCurrent(message) {
    const nb=currentNotebook();
    const scroller=document.getElementById('nbCanvasScroller');
    const viewport=scroller?{left:scroller.scrollLeft,top:scroller.scrollTop}:null;
    saveChanges([nb],message);

    // No reconstruimos el editor al pegar/duplicar/agrupar/eliminar.
    // Reconstruir #nbEditorPanel desmontaba la superficie de pantalla completa.
    const a=api();
    try {
      if (a && a._bridge && typeof a._bridge.refresh==='function') a._bridge.refresh();
      else refreshCanvasInPlace();
    } catch (_) {
      refreshCanvasInPlace();
    }

    renderOverlay();
    highlightImages();
    updateTools();

    if(scroller&&viewport){
      scroller.scrollLeft=viewport.left;
      scroller.scrollTop=viewport.top;
      const page=currentPage();
      const k=scale();
      if(page){
        page.scrollX=scroller.scrollLeft/Math.max(.001,k);
        page.scrollY=scroller.scrollTop/Math.max(.001,k);
      }
    }
    syncSelectionPresence({lasso:null});
  }

  function commitTransformInPlace(message, viewport) {
    const nb=currentNotebook();
    saveChanges([nb],message);
    refreshCanvasInPlace();
    renderOverlay();
    highlightImages();
    updateTools();
    const scroller=document.getElementById('nbCanvasScroller');
    if (scroller && viewport) {
      // Nunca saltar al inicio al soltar el lazo.
      scroller.scrollLeft=viewport.left;
      scroller.scrollTop=viewport.top;
      const page=currentPage();
      const k=scale();
      if (page) {
        page.scrollX=scroller.scrollLeft/Math.max(.001,k);
        page.scrollY=scroller.scrollTop/Math.max(.001,k);
      }
    }
    syncSelectionPresence({lasso:null});
  }

  function copyPayload() {
    const page=currentPage();
    if (!page || !hasSelection()) return null;
    return {
      strokes:selectedItems(page).strokes.map(deep),
      images:selectedItems(page).images.map(deep),
      copiedAt:Date.now()
    };
  }

  function copySelection() {
    clipboard=copyPayload();
    if (!clipboard) return toast('No hay elementos seleccionados');
    updateTools();
    toast('Selección copiada');
  }

  function clonePayloadToPage(payload,page,offsetX=30,offsetY=30) {
    if (!payload || !page) return {strokes:[],images:[]};
    if (!Array.isArray(page.strokes)) page.strokes=[];
    if (!Array.isArray(page.images)) page.images=[];
    const groupMap=new Map();
    const remapGroup=old => {
      if (!old) return null;
      if (!groupMap.has(old)) groupMap.set(old,'grp-'+uuid());
      return groupMap.get(old);
    };
    const made={strokes:[],images:[]};

    (payload.strokes||[]).forEach(source => {
      const s=deep(source);
      s.id=uuid();
      if (s.groupId) s.groupId=remapGroup(s.groupId);
      (s.points||[]).forEach(p => {
        p.x=clamp((Number(p.x)||0)+offsetX/LOGICAL_WIDTH,0,1);
        p.y=Math.max(0,(Number(p.y)||0)+offsetY);
      });
      if (s.shapeData) {
        s.shapeData.x1=clamp((Number(s.shapeData.x1)||0)+offsetX/LOGICAL_WIDTH,0,1);
        s.shapeData.x2=clamp((Number(s.shapeData.x2)||0)+offsetX/LOGICAL_WIDTH,0,1);
        s.shapeData.y1=Math.max(0,(Number(s.shapeData.y1)||0)+offsetY);
        s.shapeData.y2=Math.max(0,(Number(s.shapeData.y2)||0)+offsetY);
      }
      delete s._bounds;
      s._boundsVersion=0;
      page.strokes.push(s);
      made.strokes.push(s.id);
    });

    (payload.images||[]).forEach(source => {
      const image=deep(source);
      image.id=uuid();
      if (image.groupId) image.groupId=remapGroup(image.groupId);
      image.background=false;
      image.locked=false;
      image.x=clamp((Number(image.x)||0)+offsetX,0,Math.max(0,LOGICAL_WIDTH-(Number(image.w)||0)));
      image.y=Math.max(0,(Number(image.y)||0)+offsetY);
      page.images.push(image);
      made.images.push(image.id);
    });
    return made;
  }

  function pasteSelection() {
    const page=currentPage();
    if (!clipboard || !page || isReadOnly()) return toast('No hay una selección copiada');
    const made=clonePayloadToPage(clipboard,page,30,30);
    selectedStrokes=new Set(made.strokes);
    selectedImages=new Set(made.images);
    commitCurrent('Selección pegada');
  }

  function duplicateSelection() {
    const payload=copyPayload(), page=currentPage();
    if (!payload || !page || isReadOnly()) return;
    const made=clonePayloadToPage(payload,page,30,30);
    selectedStrokes=new Set(made.strokes);
    selectedImages=new Set(made.images);
    commitCurrent('Selección duplicada');
  }

  function removeSelectionFromPage(page) {
    if (!page) return;
    page.strokes=(page.strokes||[]).filter(s=>!selectedStrokes.has(s.id));
    page.images=(page.images||[]).filter(i=>!selectedImages.has(i.id));
  }

  function selectionCollabKeys() {
    return [
      ...Array.from(selectedStrokes).map(id=>'stroke:'+id),
      ...Array.from(selectedImages).map(id=>'image:'+id)
    ];
  }

  function withSelectionLocks(fn) {
    const collab=window.INFO1_NOTEBOOK_COLLABORATION;
    const keys=selectionCollabKeys();
    if (collab && collab.claimObjects && !collab.claimObjects(keys)) return false;
    try { fn(); }
    finally { if (collab && collab.releaseObjects) setTimeout(()=>collab.releaseObjects(keys),50); }
    return true;
  }

  function deleteSelection(silent=false) {
    const page=currentPage();
    if (!page || !hasSelection() || isReadOnly()) return;
    withSelectionLocks(()=>{
      removeSelectionFromPage(page);
      clearSelection(false);
      commitCurrent(silent?'':'Selección eliminada');
    });
  }

  function cutSelection() {
    if (!hasSelection() || isReadOnly()) return;
    clipboard=copyPayload();
    deleteSelection(true);
    toast('Selección cortada');
  }

  function groupSelection() {
    const page=currentPage();
    if (!page || selectionCount()<2 || isReadOnly()) return toast('Seleccioná al menos dos elementos');
    withSelectionLocks(()=>{
      const groupId='grp-'+uuid();
      selectedItems(page).strokes.forEach(s=>s.groupId=groupId);
      selectedItems(page).images.forEach(i=>i.groupId=groupId);
      commitCurrent('Elementos agrupados');
    });
  }

  function ungroupSelection() {
    const page=currentPage();
    if (!page || !hasSelection() || isReadOnly()) return;
    withSelectionLocks(()=>{
      selectedItems(page).strokes.forEach(s=>delete s.groupId);
      selectedItems(page).images.forEach(i=>delete i.groupId);
      commitCurrent('Elementos desagrupados');
    });
  }

  function translateStroke(stroke,dx,dy) {
    (stroke.points||[]).forEach(p => {
      p.x=clamp((Number(p.x)||0)+dx/LOGICAL_WIDTH,0,1);
      p.y=Math.max(0,(Number(p.y)||0)+dy);
    });
    if (stroke.shapeData) {
      stroke.shapeData.x1=clamp((Number(stroke.shapeData.x1)||0)+dx/LOGICAL_WIDTH,0,1);
      stroke.shapeData.x2=clamp((Number(stroke.shapeData.x2)||0)+dx/LOGICAL_WIDTH,0,1);
      stroke.shapeData.y1=Math.max(0,(Number(stroke.shapeData.y1)||0)+dy);
      stroke.shapeData.y2=Math.max(0,(Number(stroke.shapeData.y2)||0)+dy);
    }
    delete stroke._bounds; stroke._boundsVersion=0;
  }

  function scaleStroke(stroke,bounds,factor) {
    (stroke.points||[]).forEach(p => {
      const x=(Number(p.x)||0)*LOGICAL_WIDTH, y=Number(p.y)||0;
      p.x=clamp((bounds.minX+(x-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);
      p.y=Math.max(0,bounds.minY+(y-bounds.minY)*factor);
    });
    if (stroke.shapeData) {
      const d=stroke.shapeData;
      const x1=(Number(d.x1)||0)*LOGICAL_WIDTH, x2=(Number(d.x2)||0)*LOGICAL_WIDTH;
      d.x1=clamp((bounds.minX+(x1-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);
      d.x2=clamp((bounds.minX+(x2-bounds.minX)*factor)/LOGICAL_WIDTH,0,1);
      d.y1=Math.max(0,bounds.minY+((Number(d.y1)||0)-bounds.minY)*factor);
      d.y2=Math.max(0,bounds.minY+((Number(d.y2)||0)-bounds.minY)*factor);
    }
    stroke.width=Math.max(.5,(Number(stroke.width)||4)*factor);
    delete stroke._bounds; stroke._boundsVersion=0;
  }

  function materializeShape(stroke) {
    if (!stroke || !stroke.shapeData || !stroke.shapeType) return;
    const d=stroke.shapeData;
    let pts=[];
    const x1=(Number(d.x1)||0)*LOGICAL_WIDTH, x2=(Number(d.x2)||0)*LOGICAL_WIDTH;
    const y1=Number(d.y1)||0, y2=Number(d.y2)||0;
    if (stroke.shapeType==='line') {
      pts=[{x:x1,y:y1},{x:x2,y:y2}];
    } else if (stroke.shapeType==='circle') {
      const cx=(x1+x2)/2,cy=(y1+y2)/2,rx=Math.abs(x2-x1)/2,ry=Math.abs(y2-y1)/2;
      for(let i=0;i<=48;i++){const a=Math.PI*2*i/48;pts.push({x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry});}
    } else if (stroke.shapeType==='rectangle') {
      pts=[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2},{x:x1,y:y1}];
    } else if (stroke.shapeType==='triangle') {
      pts=[{x:(x1+x2)/2,y:y1},{x:x1,y:y2},{x:x2,y:y2},{x:(x1+x2)/2,y:y1}];
    }
    const existingRotation=(Number(stroke.rotation)||0)*Math.PI/180;
    if (existingRotation && pts.length) {
      const cx=(x1+x2)/2,cy=(y1+y2)/2;
      pts=pts.map(p=>rotatePoint(p.x,p.y,cx,cy,existingRotation));
    }
    stroke.points=pts.map(p=>({x:clamp(p.x/LOGICAL_WIDTH,0,1),y:Math.max(0,p.y),p:.5}));
    delete stroke.shapeData; delete stroke.shapeType; delete stroke.rotation;
  }

  function rotateStroke(stroke,cx,cy,angleDeg) {
    materializeShape(stroke);
    const a=angleDeg*Math.PI/180;
    (stroke.points||[]).forEach(p => {
      const q=rotatePoint((Number(p.x)||0)*LOGICAL_WIDTH,Number(p.y)||0,cx,cy,a);
      p.x=clamp(q.x/LOGICAL_WIDTH,0,1);
      p.y=Math.max(0,q.y);
    });
    delete stroke._bounds; stroke._boundsVersion=0;
  }

  function applyTransformSnapshot(snapshot,type,amount) {
    const page=currentPage();
    if (!page) return;
    const items=selectedItems(page);
    items.strokes.forEach(stroke => {
      const src=snapshot.strokes.get(stroke.id);
      if (!src) return;
      Object.keys(stroke).forEach(k=>delete stroke[k]);
      Object.assign(stroke,deep(src));
      if (type==='move') translateStroke(stroke,amount.dx,amount.dy);
      else if (type==='resize') scaleStroke(stroke,snapshot.bounds,amount.factor);
      else if (type==='rotate') rotateStroke(stroke,snapshot.bounds.cx,snapshot.bounds.cy,amount.angle);
    });
    items.images.forEach(image => {
      const src=snapshot.images.get(image.id);
      if (!src || src.locked) return;
      Object.keys(image).forEach(k=>delete image[k]);
      Object.assign(image,deep(src));
      if (type==='move') {
        image.x=clamp(src.x+amount.dx,0,Math.max(0,LOGICAL_WIDTH-src.w));
        image.y=Math.max(0,src.y+amount.dy);
      } else if (type==='resize') {
        const f=amount.factor;
        image.x=snapshot.bounds.minX+(src.x-snapshot.bounds.minX)*f;
        image.y=Math.max(0,snapshot.bounds.minY+(src.y-snapshot.bounds.minY)*f);
        image.w=Math.max(40,src.w*f); image.h=Math.max(40,src.h*f);
      } else if (type==='rotate') {
        const icx=src.x+src.w/2, icy=src.y+src.h/2;
        const q=rotatePoint(icx,icy,snapshot.bounds.cx,snapshot.bounds.cy,amount.angle*Math.PI/180);
        image.x=q.x-src.w/2; image.y=Math.max(0,q.y-src.h/2);
        image.rotation=(Number(src.rotation)||0)+amount.angle;
      }
    });
  }

  function captureSnapshot() {
    const page=currentPage(), items=selectedItems(page), bounds=selectionBounds();
    if (!page || !bounds) return null;
    return {
      bounds,
      strokes:new Map(items.strokes.map(s=>[s.id,deep(s)])),
      images:new Map(items.images.map(i=>[i.id,deep(i)]))
    };
  }

  function startTransform(e,type) {
    if (!hasSelection() || isReadOnly()) return;
    const collab=window.INFO1_NOTEBOOK_COLLABORATION;
    const collabKeys=[
      ...Array.from(selectedStrokes).map(id=>'stroke:'+id),
      ...Array.from(selectedImages).map(id=>'image:'+id)
    ];
    if (collab && collab.claimObjects && !collab.claimObjects(collabKeys)) return;
    stopEvent(e);

    const snapshot=captureSnapshot();
    if (!snapshot) {
      if (collab && collab.releaseObjects) collab.releaseObjects(collabKeys);
      return;
    }

    const sessionId='tr-'+uuid();
    const r=resilience(), nb=currentNotebook(), page=currentPage();
    const scroller=document.getElementById('nbCanvasScroller');
    const viewport={
      left:scroller?scroller.scrollLeft:0,
      top:scroller?scroller.scrollTop:0
    };

    if (r && r.syncSelectionTransform && nb && page) {
      r.syncSelectionTransform(nb.id,page.id,{
        sessionId:sessionId,phase:'start',type:type,
        strokeIds:Array.from(selectedStrokes),imageIds:Array.from(selectedImages),
        bounds:snapshot.bounds
      });
    }

    const start={x:e.clientX,y:e.clientY};
    const k=scale();
    const s=stage().getBoundingClientRect();
    const center={x:s.left+snapshot.bounds.cx*k,y:s.top+snapshot.bounds.cy*k};
    const startAngle=Math.atan2(start.y-center.y,start.x-center.x)*180/Math.PI;
    const box=e.currentTarget.closest('.nb-selection-ext-box') || e.currentTarget;
    let latestTransform=null;
    let previewFrame=0;

    const computeTransform=ev => {
      if (type==='move') {
        return {dx:(ev.clientX-start.x)/k,dy:(ev.clientY-start.y)/k};
      }
      if (type==='resize') {
        const dx=(ev.clientX-start.x)/k,dy=(ev.clientY-start.y)/k;
        return {factor:clamp(Math.max(
          (snapshot.bounds.width+dx)/snapshot.bounds.width,
          (snapshot.bounds.height+dy)/snapshot.bounds.height
        ),.2,5)};
      }
      return {angle:Math.atan2(ev.clientY-center.y,ev.clientX-center.x)*180/Math.PI-startAngle};
    };

    const applyPreview=transform => {
      if (!transform) return;
      applyTransformSnapshot(snapshot,type,transform);
      refreshCanvasInPlace();
      // El rectángulo de selección acompaña el contenido sin reconstruir el DOM
      // mientras el Pencil/dedo está arrastrando.
      if (type==='move') {
        box.style.transform='translate('+(transform.dx*k)+'px,'+(transform.dy*k)+'px)';
      } else if (type==='resize') {
        box.style.width=(snapshot.bounds.width*k*transform.factor)+'px';
        box.style.height=(snapshot.bounds.height*k*transform.factor)+'px';
      } else {
        box.style.transform='rotate('+transform.angle+'deg)';
      }
    };

    const schedulePreview=transform => {
      latestTransform=transform;
      if (previewFrame) return;
      previewFrame=requestAnimationFrame(()=>{
        previewFrame=0;
        applyPreview(latestTransform);
      });
    };

    const move=ev => {
      if (ev.pointerId!==e.pointerId) return;
      if (collab && collab.ownsObjects && !collab.ownsObjects(collabKeys)) return;
      stopEvent(ev);

      const transform=computeTransform(ev);
      schedulePreview(transform);

      if (r && r.syncSelectionTransform && nb && page) {
        r.syncSelectionTransform(nb.id,page.id,{
          sessionId:sessionId,phase:'move',type:type,transform:transform,
          strokeIds:Array.from(selectedStrokes),imageIds:Array.from(selectedImages),
          bounds:snapshot.bounds
        });
      }
    };

    const end=ev => {
      if (ev.pointerId!==e.pointerId) return;
      stopEvent(ev);
      window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',end,true);
      window.removeEventListener('pointercancel',end,true);

      if (previewFrame) {
        cancelAnimationFrame(previewFrame);
        previewFrame=0;
      }

      const stillOwns=!collab || !collab.ownsObjects || collab.ownsObjects(collabKeys);
      if (stillOwns) {
        const finalTransform=computeTransform(ev);
        applyTransformSnapshot(snapshot,type,finalTransform);
        refreshCanvasInPlace();

        // Guardamos sin reabrir el editor: reabrirlo era lo que mandaba
        // el scroll al comienzo de la hoja al soltar la selección.
        commitTransformInPlace(
          type==='move'?'Selección movida':type==='resize'?'Selección redimensionada':'Selección rotada',
          viewport
        );

        if (r && r.syncSelectionTransform && nb && page) {
          r.syncSelectionTransform(nb.id,page.id,{
            sessionId:sessionId,phase:'end',type:type,transform:finalTransform,
            strokeIds:Array.from(selectedStrokes),imageIds:Array.from(selectedImages),
            bounds:selectionBounds()
          });
        }
      } else {
        // Otro dispositivo ganó el lock: volvemos al snapshot sin saltar de página.
        applyTransformSnapshot(snapshot,type,type==='move'?{dx:0,dy:0}:type==='resize'?{factor:1}:{angle:0});
        refreshCanvasInPlace();
        renderOverlay();
        if (scroller) {
          scroller.scrollLeft=viewport.left;
          scroller.scrollTop=viewport.top;
        }
      }

      if (collab && collab.releaseObjects) collab.releaseObjects(collabKeys);
    };

    window.addEventListener('pointermove',move,{capture:true,passive:false});
    window.addEventListener('pointerup',end,true);
    window.addEventListener('pointercancel',end,true);
  }

  function moveSelectionToPage() {
    const nb=currentNotebook(), source=currentPage();
    if (!nb || !source || !hasSelection() || isReadOnly()) return;
    const pages=(nb.pages||[]).filter(p=>p.id!==source.id);
    if (!pages.length) return toast('Este cuaderno no tiene otra hoja');
    const menu=pages.map((p,i)=>(i+1)+'. '+p.title).join('\n');
    const raw=prompt('Mover selección a qué hoja?\n'+menu,'1');
    if (raw===null) return;
    const target=pages[Number(raw)-1];
    if (!target) return toast('Hoja inválida');
    withSelectionLocks(()=>{
      const items=selectedItems(source);
      removeSelectionFromPage(source);
      if (!Array.isArray(target.strokes)) target.strokes=[];
      if (!Array.isArray(target.images)) target.images=[];
      target.strokes.push(...items.strokes);
      target.images.push(...items.images);
      clearSelection(false);
      saveChanges([nb],'Selección movida a '+target.title);
      refreshEditor();
    });
  }

  function copySelectionToNotebook() {
    const source=currentNotebook(), page=currentPage();
    if (!source || !page || !hasSelection() || isReadOnly()) return;
    const notebooks=api().list().filter(n=>n && n.id!==source.id);
    if (!notebooks.length) return toast('No hay otro cuaderno');
    const menu=notebooks.map((n,i)=>(i+1)+'. '+n.title).join('\n');
    const raw=prompt('Copiar selección a qué cuaderno?\n'+menu,'1');
    if (raw===null) return;
    const targetNb=notebooks[Number(raw)-1];
    if (!targetNb) return toast('Cuaderno inválido');
    let targetPage=(targetNb.pages||[])[0];
    if ((targetNb.pages||[]).length>1) {
      const pm=(targetNb.pages||[]).map((p,i)=>(i+1)+'. '+p.title).join('\n');
      const pr=prompt('A qué hoja de “'+targetNb.title+'”?\n'+pm,'1');
      if (pr===null) return;
      targetPage=targetNb.pages[Number(pr)-1];
    }
    if (!targetPage) return toast('No encontré una hoja destino');
    const payload=copyPayload();
    clonePayloadToPage(payload,targetPage,30,30);
    saveChanges([source,targetNb],'Selección copiada a '+targetNb.title);
  }

  function toast(text) {
    const old=document.querySelector('.nb-selection-ext-toast');
    if (old) old.remove();
    const el=document.createElement('div');
    el.className='nb-status-toast nb-selection-ext-toast';
    el.textContent=text;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),1800);
  }

  function handleImagePointer(e) {
    if (!selectionMode || isReadOnly()) return;
    const el=e.target && e.target.closest && e.target.closest('.nb-image-object[data-image-id]');
    if (!el) return;
    stopEvent(e);
    selectSingleImage(el.dataset.imageId);
  }

  function deactivateLassoForBaseTool(e) {
    const target = e.target && e.target.closest ? e.target.closest('#nbPen,#nbHighlighter,#nbLine,#nbEraser,#nbBrush,#nbShape') : null;
    if (target) leaveSelectionForDrawing();
  }

  function handleKeys(e) {
    if (!isEditorVisible()) return;
    const tag=(e.target && e.target.tagName || '').toLowerCase();
    if (['input','textarea','select'].includes(tag) || (e.target && e.target.isContentEditable)) return;
    const mod=e.ctrlKey||e.metaKey;
    if (mod && e.key.toLowerCase()==='c' && hasSelection()) { e.preventDefault(); copySelection(); }
    else if (mod && e.key.toLowerCase()==='x' && hasSelection()) { e.preventDefault(); cutSelection(); }
    else if (mod && e.key.toLowerCase()==='v' && clipboard) { e.preventDefault(); pasteSelection(); }
    else if ((e.key==='Delete'||e.key==='Backspace') && hasSelection()) { e.preventDefault(); deleteSelection(); }
    else if (e.key==='Escape' && hasSelection()) { e.preventDefault(); clearSelection(); }
  }

  function contextWatcher() {
    if (!isEditorVisible()) return;
    const nb=currentNotebook(), page=currentPage();
    const key=(nb?nb.id:'')+':'+(page?page.id:'');
    if (lastContextKey && key!==lastContextKey) {
      clearSelection(false);
      const lasso=document.getElementById(TOOL_ID);
      if(lasso) lasso.classList.toggle('active',selectionMode);
      syncSelectionPresence({active:selectionMode,cleared:true,lasso:null});
    }
    lastContextKey=key;
    ensureUi();
  }

  function boot() {
    if (!api()) {
      setTimeout(boot,250);
      return;
    }
    ensureStyles();
    document.addEventListener('pointerdown',handleImagePointer,true);
    document.addEventListener('click',deactivateLassoForBaseTool,true);
    document.addEventListener('change',deactivateLassoForBaseTool,true);
    document.addEventListener('keydown',handleKeys,true);
    window.addEventListener('blur', () => { if (cancelLassoGesture) clearSelection(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && cancelLassoGesture) clearSelection();
    });
    const observer=new MutationObserver(mutations => {
      const onlyOwn = mutations.length > 0 && mutations.every(m => {
        const target = m.target && m.target.nodeType === 1 ? m.target : null;
        return !!(target && target.closest && target.closest('#nbSelectionExtLayer,#nbSelectionExtTools'));
      });
      if (!onlyOwn) contextWatcher();
    });
    observer.observe(document.getElementById('nbEditorPanel'),{childList:true});
    setInterval(contextWatcher,500);
    contextWatcher();

    window.INFO1_NOTEBOOK_SELECTION = {
      clear:clearSelection,
      copy:copySelection,
      cut:cutSelection,
      paste:pasteSelection,
      duplicate:duplicateSelection,
      group:groupSelection,
      ungroup:ungroupSelection,
      delete:deleteSelection,
      get ids(){return {strokeIds:Array.from(selectedStrokes),imageIds:Array.from(selectedImages)};},
      get count(){return selectionCount();},
      get active(){return selectionMode;}
    };
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();
