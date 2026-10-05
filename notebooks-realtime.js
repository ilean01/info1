(() => {
  'use strict';

  const STATE_KEY = 'info1-study-center-v4-priority';
  const STORE_KEY = '__notebooksV1';
  const DEVICE_KEY = 'info1-notebook-device-v1';
  const FOLLOW_KEY = 'info1-notebook-follow-v1';
  const OPEN_KEY = 'info1-notebook-open-v1';
  const ERASER_MODE_KEY = 'info1-notebook-eraser-mode-v1';
  const PENCIL_MODE_KEY = 'info1-notebook-finger-mode-v1';
  const BRUSH_KEY = 'info1-notebook-brush-v1';
  const LOGICAL_WIDTH = 1000;
  const INITIAL_PAGE_HEIGHT = 1600;
  const PAGE_GROW_BY = 1200;
  const MAX_CANVAS_PIXELS = 14000000;
  const MAX_CANVAS_DIMENSION = 15000;
  const MIN_ZOOM = 0.30;
  const MAX_ZOOM = 4.0;
  const VIEWPORT_OVERSCAN = 720;
  const CHANNEL_VERSION = 'v1';

  let currentNotebookId = null;
  let currentPageId = null;
  let readOnly = false;
  let followMode = INFO1_LOCAL.getItem(FOLLOW_KEY) === '1';
  let channel = null;
  let channelName = null;
  let channelClient = null;
  let channelReady = false;
  let channelConnecting = false;
  let currentDraft = null;
  let pointQueue = [];
  let pointFlushTimer = null;
  let remoteDrafts = new Map();
  let resizeObserver = null;
  let canvas = null;
  let ctx = null;
  let currentFolderId = null; // null = todos; "__root__" = sin carpeta
  let folderSearch = '';
  let libraryTopicFilter = 'all';
  let libraryDateFilter = '';
  let librarySort = 'recent';
  let libraryViewMode = INFO1_LOCAL.getItem('info1-notebook-library-view-v1') === 'list' ? 'list' : 'grid';
  let touchDrag = null;
  let pageSelection = new Set();
  let touchPageDrag = null;
  let eraserMode = INFO1_LOCAL.getItem(ERASER_MODE_KEY) === 'stroke' ? 'stroke' : 'pixel';
  let strokeEraseActive = false;
  let strokeEraseSeen = new Set();
  let fingerPanMode = INFO1_LOCAL.getItem(PENCIL_MODE_KEY) !== 'draw';
  let currentBrush = INFO1_LOCAL.getItem(BRUSH_KEY) || 'ballpoint';
  let activePointers = new Map();
  let gestureState = null;
  let drawPointerId = null;
  let shapeHoldTimer = null;
  let scrollPersistTimer = null;
  let focusBroadcastTimer = null;
  let inkPersistTimer = null;
  let inkPersistMaxTimer = null;
  let inkRefreshTimer = null;
  let pencilDetected = false;
  let redrawFrame = 0;
  let lastViewportPaintY = null;
  let lastRenderStats = { drawn: 0, skipped: 0, backingScale: 1 };
  let viewportResizeTimer = null;
  let viewportCleanup = null;
  let selectedImageId = null;
  let imageGesture = null;
  let imagePasteListenerInstalled = false;

  function uuid() {
    return crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'nb-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function deviceId() {
    let id = INFO1_LOCAL.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      INFO1_LOCAL.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function appState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch (_) {}
    try {
      const value = JSON.parse(INFO1_LOCAL.getItem(STATE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizePage(page) {
    if (!page || typeof page !== 'object') return page;
    if (!Array.isArray(page.strokes)) page.strokes = [];
    if (page.coordVersion !== 2) {
      page.strokes.forEach(function(stroke) {
        if (!stroke || !Array.isArray(stroke.points)) return;
        stroke.points.forEach(function(point) {
          if (!point || typeof point.y !== 'number') return;
          point.y = point.y * INITIAL_PAGE_HEIGHT;
        });
        stroke.coordVersion = 2;
      });
      page.coordVersion = 2;
      page.height = Number(page.height) > 0 ? Number(page.height) : INITIAL_PAGE_HEIGHT;
    }
    page.height = Math.max(INITIAL_PAGE_HEIGHT, Number(page.height) || INITIAL_PAGE_HEIGHT);
    page.zoom = clamp(Number(page.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
    page.scrollY = Math.max(0, Number(page.scrollY) || 0);
    page.scrollX = Math.max(0, Number(page.scrollX) || 0);
    if (!Array.isArray(page.redoStack)) page.redoStack = [];
    if (!Array.isArray(page.images)) page.images = [];
    page.images.forEach(function(image) {
      if (!image || typeof image !== 'object') return;
      if (!image.id) image.id = uuid();
      image.x = clamp(Number(image.x) || 0, 0, LOGICAL_WIDTH);
      image.y = Math.max(0, Number(image.y) || 0);
      image.w = clamp(Number(image.w) || 320, 40, LOGICAL_WIDTH * 2);
      image.h = clamp(Number(image.h) || 240, 40, Math.max(INITIAL_PAGE_HEIGHT, page.height) * 2);
      image.rotation = Number(image.rotation) || 0;
      image.z = Number.isFinite(Number(image.z)) ? Number(image.z) : 10;
      image.locked = !!image.locked;
      image.background = !!image.background;
      if (!image.crop || typeof image.crop !== 'object') image.crop = {top:0,right:0,bottom:0,left:0};
      ['top','right','bottom','left'].forEach(function(k) { image.crop[k] = clamp(Number(image.crop[k]) || 0, 0, 45); });
    });
    page.strokes.forEach(function(stroke) {
      if (stroke && !stroke.coordVersion) stroke.coordVersion = 2;
    });
    return page;
  }

  function normalizeNotebookPages(nb) {
    if (!nb || typeof nb !== 'object') return nb;
    if (!Array.isArray(nb.pages) || !nb.pages.length) {
      nb.pages = [{
        id: uuid(),
        title: 'Página 1',
        createdAt: new Date().toISOString(),
        strokes: [],
        coordVersion: 2,
        height: INITIAL_PAGE_HEIGHT,
        zoom: 1,
        scrollY: 0,
        scrollX: 0,
        redoStack: [],
        images: []
      }];
    }
    nb.pages.forEach(normalizePage);
    return nb;
  }

  function ensureStore() {
    const s = appState();
    if (!s[STORE_KEY] || typeof s[STORE_KEY] !== 'object') {
      s[STORE_KEY] = {
        version: 1,
        notebooks: {},
        order: [],
        updatedAt: new Date().toISOString()
      };
    }
    const store = s[STORE_KEY];
    if (!store.notebooks || typeof store.notebooks !== 'object') store.notebooks = {};
    if (!Array.isArray(store.order)) store.order = Object.keys(store.notebooks);
    if (!store.folders || typeof store.folders !== 'object') store.folders = {};
    if (!Array.isArray(store.folderOrder)) store.folderOrder = Object.keys(store.folders);
    if (!store.mediaAssets || typeof store.mediaAssets !== 'object') store.mediaAssets = {};
    Object.values(store.notebooks).forEach(function(nb) {
      if (!Object.prototype.hasOwnProperty.call(nb, 'folderId')) nb.folderId = null;
      if (nb.folderId && !store.folders[nb.folderId]) nb.folderId = null;
    });
    Object.values(store.folders).forEach(function(folder) {
      if (!Object.prototype.hasOwnProperty.call(folder, 'parentId')) folder.parentId = null;
      if (!folder.icon) folder.icon = '📁';
      if (!folder.color) folder.color = '#315a9b';
      if (folder.parentId && !store.folders[folder.parentId]) folder.parentId = null;
    });
    Object.values(store.notebooks).forEach(normalizeNotebookPages);
    return store;
  }

  function persist() {
    const s = appState();
    window.INFO1_NOTEBOOK_MERGE.stamp(s[STORE_KEY]);
    let saved = true;
    if (s[STORE_KEY]) s[STORE_KEY].updatedAt = new Date().toISOString();
    try {
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.onPersistStart) {
        window.INFO1_NOTEBOOK_RESILIENCE.onPersistStart();
      }
      if (typeof save === 'function') {
        save();
        saved = window.INFO1_LOCAL_SAVE_OK !== false;
      } else {
        INFO1_LOCAL.setItem(STATE_KEY, JSON.stringify(s));
      }
    } catch (e) {
      saved = false;
      console.warn('INFO1 cuadernos: no se pudo guardar', e);
    } finally {
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.onPersistEnd) {
        window.INFO1_NOTEBOOK_RESILIENCE.onPersistEnd(saved);
      }
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function nowTime() {
    return new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  }

  function dateLabel(value) {
    try {
      return new Date(value).toLocaleString('es-PY', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return '';
    }
  }

  function getNotebook(id) {
    return ensureStore().notebooks[id] || null;
  }

  function getPage(nb, pageId) {
    if (!nb || !Array.isArray(nb.pages)) return null;
    const page = nb.pages.find(p => p.id === pageId) || nb.pages[0] || null;
    return normalizePage(page);
  }

  function topicNotebookList(topicId) {
    const store = ensureStore();
    return store.order
      .map(id => store.notebooks[id])
      .filter(nb => nb && nb.topicId === topicId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }

  function folderById(id) {
    return id ? ensureStore().folders[id] || null : null;
  }

  function folderChildren(parentId) {
    const store = ensureStore();
    return store.folderOrder
      .map(function(id) { return store.folders[id]; })
      .filter(function(folder) { return folder && (folder.parentId || null) === (parentId || null); });
  }

  function folderNotebookCount(folderId) {
    return Object.values(ensureStore().notebooks).filter(function(nb) { return nb && nb.folderId === folderId; }).length;
  }

  function folderPath(folderId) {
    const store = ensureStore();
    const out = [];
    const seen = new Set();
    let id = folderId;
    while (id && store.folders[id] && !seen.has(id)) {
      seen.add(id);
      out.unshift(store.folders[id]);
      id = store.folders[id].parentId || null;
    }
    return out;
  }

  function normalizeFolderColor(value) {
    const v = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#315a9b';
  }

  function createFolder(parentId) {
    const store = ensureStore();
    const name = prompt(parentId ? 'Nombre de la subcarpeta:' : 'Nombre de la carpeta:', '');
    if (name === null || !name.trim()) return null;
    const icon = prompt('Icono de la carpeta (podés usar un emoji):', '📁');
    if (icon === null) return null;
    const color = prompt('Color de la carpeta en HEX (ej. #315a9b):', '#315a9b');
    if (color === null) return null;
    const createdAt = new Date().toISOString();
    const folder = {
      id: uuid(),
      name: name.trim(),
      icon: (icon.trim() || '📁').slice(0, 8),
      color: normalizeFolderColor(color),
      parentId: parentId || null,
      createdAt,
      updatedAt: createdAt
    };
    store.folders[folder.id] = folder;
    const siblings = store.folderOrder.filter(function(id) {
      const f = store.folders[id];
      return f && (f.parentId || null) === (folder.parentId || null);
    });
    const lastSibling = siblings[siblings.length - 1];
    if (lastSibling) {
      const idx = store.folderOrder.indexOf(lastSibling);
      store.folderOrder.splice(idx + 1, 0, folder.id);
    } else {
      store.folderOrder.push(folder.id);
    }
    persist();
    broadcast('folder-created', { folder: folder });
    renderNotebookList();
    return folder;
  }

  function renameFolder(folderId) {
    const folder = folderById(folderId);
    if (!folder) return;
    const next = prompt('Nombre de la carpeta:', folder.name);
    if (next === null || !next.trim()) return;
    folder.name = next.trim();
    folder.updatedAt = new Date().toISOString();
    persist();
    broadcast('folder-updated', { folder: folder });
    renderNotebookList();
  }

  function editFolderAppearance(folderId) {
    const folder = folderById(folderId);
    if (!folder) return;
    const icon = prompt('Icono/emoji de la carpeta:', folder.icon || '📁');
    if (icon === null) return;
    const color = prompt('Color HEX de la carpeta:', folder.color || '#315a9b');
    if (color === null) return;
    folder.icon = (icon.trim() || '📁').slice(0, 8);
    folder.color = normalizeFolderColor(color);
    folder.updatedAt = new Date().toISOString();
    persist();
    broadcast('folder-updated', { folder: folder });
    renderNotebookList();
  }

  function deleteFolder(folderId) {
    const store = ensureStore();
    const folder = store.folders[folderId];
    if (!folder) return;
    const parentId = folder.parentId || null;
    const notebookCount = folderNotebookCount(folderId);
    const children = folderChildren(folderId);
    const detail = notebookCount || children.length
      ? ' Sus ' + notebookCount + ' cuaderno(s) y ' + children.length + ' subcarpeta(s) se moverán ' + (parentId ? 'a la carpeta superior.' : 'al nivel principal.')
      : '';
    if (!confirm('¿Borrar la carpeta “' + folder.name + '”?' + detail)) return;
    Object.values(store.notebooks).forEach(function(nb) {
      if (nb && nb.folderId === folderId) nb.folderId = parentId;
    });
    children.forEach(function(child) { child.parentId = parentId; });
    delete store.folders[folderId];
    store.folderOrder = store.folderOrder.filter(function(id) { return id !== folderId; });
    if (currentFolderId === folderId) currentFolderId = parentId || null;
    persist();
    broadcast('folder-deleted', { folderId: folderId, parentId: parentId });
    renderNotebookList();
  }

  function moveFolder(folderId, direction) {
    const store = ensureStore();
    const folder = store.folders[folderId];
    if (!folder) return;
    const siblings = store.folderOrder.filter(function(id) {
      const f = store.folders[id];
      return f && (f.parentId || null) === (folder.parentId || null);
    });
    const pos = siblings.indexOf(folderId);
    const target = pos + direction;
    if (pos < 0 || target < 0 || target >= siblings.length) return;
    const otherId = siblings[target];
    const a = store.folderOrder.indexOf(folderId);
    const b = store.folderOrder.indexOf(otherId);
    const tmp = store.folderOrder[a];
    store.folderOrder[a] = store.folderOrder[b];
    store.folderOrder[b] = tmp;
    persist();
    broadcast('folder-order', { order: store.folderOrder.slice() });
    renderNotebookList();
  }

  function setNotebookFolder(notebookId, folderId) {
    const store = ensureStore();
    const nb = store.notebooks[notebookId];
    if (!nb) return;
    if (folderId && !store.folders[folderId]) folderId = null;
    nb.folderId = folderId || null;
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('notebook-folder', { notebookId: nb.id, folderId: nb.folderId });
    renderNotebookList();
    if (currentNotebookId === nb.id) renderEditor();
  }

  function createNotebookInFolder(folderId) {
    const folder = folderById(folderId);
    if (!folder) return;
    const title = prompt('Nombre del cuaderno para “' + folder.name + '”:', '');
    if (title === null) return;
    createNotebook({ title: title.trim() || 'Cuaderno libre', folderId: folder.id });
  }

  function createNotebook(opts) {
    opts = opts || {};
    const store = ensureStore();
    const id = uuid();
    const pageId = uuid();
    const createdAt = new Date().toISOString();
    const base = (opts.title || '').trim();
    const title = opts.topicId
      ? (base || 'Ficha') + ' · ' + nowTime()
      : (base || 'Cuaderno libre') + (base ? '' : ' · ' + nowTime());

    const nb = {
      id,
      title,
      topicId: opts.topicId || null,
      topicTitle: opts.topicTitle || base || null,
      folderId: opts.folderId || null,
      createdAt,
      updatedAt: createdAt,
      pages: [{
        id: pageId,
        title: 'Página 1',
        createdAt,
        strokes: [],
        coordVersion: 2,
        height: INITIAL_PAGE_HEIGHT,
        zoom: 1,
        scrollY: 0,
        scrollX: 0,
        redoStack: [],
        images: []
      }]
    };
    store.notebooks[id] = nb;
    store.order.unshift(id);
    persist();
    broadcast('notebook-created', { notebook: nb });
    renderNotebookList();
    openNotebook(id, pageId, false, true);
    return nb;
  }

  function createStandalone() {
    const title = prompt('Nombre del cuaderno libre:', '');
    if (title === null) return;
    const folderId = currentFolderId && currentFolderId !== '__root__' ? currentFolderId : null;
    createNotebook({ title: title.trim() || 'Cuaderno libre', folderId: folderId });
  }

  function createForTopic(topicId, topicTitle) {
    const existing = topicNotebookList(topicId);
    if (existing.length) {
      openNotebook(existing[0].id, existing[0].pages && existing[0].pages[0] ? existing[0].pages[0].id : null, false, true);
      return existing[0];
    }
    return createNotebook({ topicId, title: topicTitle, topicTitle });
  }

  function createAnotherForCurrentTopic() {
    const nb = getNotebook(currentNotebookId);
    if (!nb || !nb.topicId) return;
    createNotebook({
      topicId: nb.topicId,
      title: nb.topicTitle || nb.title.split(' · ')[0],
      topicTitle: nb.topicTitle || nb.title.split(' · ')[0],
      folderId: nb.folderId || null
    });
  }

  function toggleNotebookFavorite(id) {
    const nb = getNotebook(id);
    if (!nb) return;
    nb.favorite = !nb.favorite;
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('notebook-favorite', { notebookId: nb.id, favorite: !!nb.favorite });
    renderNotebookList();
  }

  function duplicateNotebook(id) {
    const source = getNotebook(id);
    if (!source) return null;
    const store = ensureStore();
    const copy = JSON.parse(JSON.stringify(source));
    const now = new Date().toISOString();
    copy.id = uuid();
    copy.title = source.title + ' · copia';
    copy.favorite = false;
    copy.createdAt = now;
    copy.updatedAt = now;
    copy.pages = (source.pages || []).map(function(page, index) {
      const next = JSON.parse(JSON.stringify(page));
      next.id = uuid();
      next.title = page.title || ('Página ' + (index + 1));
      next.createdAt = now;
      next.strokes = (page.strokes || []).map(function(stroke) {
        const s = JSON.parse(JSON.stringify(stroke));
        s.id = uuid();
        return s;
      });
      next.images = (page.images || []).map(function(image) {
        const im = JSON.parse(JSON.stringify(image));
        im.id = uuid();
        return im;
      });
      return next;
    });
    if (!copy.pages.length) {
      copy.pages = [{ id: uuid(), title: 'Página 1', createdAt: now, strokes: [] }];
    }
    store.notebooks[copy.id] = copy;
    const sourceIndex = store.order.indexOf(source.id);
    if (sourceIndex >= 0) store.order.splice(sourceIndex + 1, 0, copy.id);
    else store.order.unshift(copy.id);
    persist();
    broadcast('notebook-created', { notebook: copy });
    renderNotebookList();
    flashStatus('📓 Cuaderno duplicado');
    return copy;
  }

  function drawShapePath(ctx2, stroke, mapX, mapY) {
    const d = stroke && stroke.shapeData;
    if (!d || !stroke.shapeType) return false;
    ctx2.beginPath();
    if (stroke.shapeType === 'line') {
      ctx2.moveTo(mapX(d.x1), mapY(d.y1));
      ctx2.lineTo(mapX(d.x2), mapY(d.y2));
    } else if (stroke.shapeType === 'circle') {
      const left = mapX(Math.min(d.x1, d.x2));
      const right = mapX(Math.max(d.x1, d.x2));
      const top = mapY(Math.min(d.y1, d.y2));
      const bottom = mapY(Math.max(d.y1, d.y2));
      ctx2.ellipse((left + right) / 2, (top + bottom) / 2, Math.abs(right - left) / 2, Math.abs(bottom - top) / 2, 0, 0, Math.PI * 2);
    } else if (stroke.shapeType === 'rectangle') {
      const x = mapX(Math.min(d.x1, d.x2));
      const y = mapY(Math.min(d.y1, d.y2));
      const w = Math.abs(mapX(d.x2) - mapX(d.x1));
      const h = Math.abs(mapY(d.y2) - mapY(d.y1));
      ctx2.rect(x, y, w, h);
    } else if (stroke.shapeType === 'triangle') {
      const x1 = mapX((d.x1 + d.x2) / 2);
      const y1 = mapY(Math.min(d.y1, d.y2));
      const x2 = mapX(Math.min(d.x1, d.x2));
      const y2 = mapY(Math.max(d.y1, d.y2));
      const x3 = mapX(Math.max(d.x1, d.x2));
      const y3 = y2;
      ctx2.moveTo(x1, y1);
      ctx2.lineTo(x2, y2);
      ctx2.lineTo(x3, y3);
      ctx2.closePath();
    } else {
      return false;
    }
    return true;
  }

  function drawPreviewStroke(ctx2, stroke, width, height, pageHeight) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return;
    pageHeight = Math.max(INITIAL_PAGE_HEIGHT, Number(pageHeight) || INITIAL_PAGE_HEIGHT);
    const mapX = function(x) { return x * width; };
    const mapY = function(y) { return (y / pageHeight) * height; };
    const pts = stroke.points;
    ctx2.save();
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';
    ctx2.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx2.globalAlpha = stroke.tool === 'highlighter' ? 0.30 : (stroke.brush === 'pencil' ? 0.72 : 1);
    ctx2.strokeStyle = stroke.color || '#16264a';
    ctx2.lineWidth = Math.max(0.8, Number(stroke.width || 4) * (stroke.tool === 'highlighter' ? 1.8 : 0.72));
    if (drawShapePath(ctx2, stroke, mapX, mapY)) {
      ctx2.stroke();
      ctx2.restore();
      return;
    }
    ctx2.beginPath();
    ctx2.moveTo(mapX(pts[0].x), mapY(pts[0].y));
    if (pts.length === 1) {
      ctx2.lineTo(mapX(pts[0].x) + 0.01, mapY(pts[0].y) + 0.01);
    } else {
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const p = pts[i];
        const mx = mapX((prev.x + p.x) / 2);
        const my = mapY((prev.y + p.y) / 2);
        ctx2.quadraticCurveTo(mapX(prev.x), mapY(prev.y), mx, my);
      }
      const last = pts[pts.length - 1];
      ctx2.lineTo(mapX(last.x), mapY(last.y));
    }
    ctx2.stroke();
    ctx2.restore();
  }

  function renderNotebookPreview(canvasEl, nb) {
    if (!canvasEl || !nb) return;
    const width = 520;
    const height = 330;
    canvasEl.width = width;
    canvasEl.height = height;
    const out = canvasEl.getContext('2d');
    out.clearRect(0, 0, width, height);
    out.fillStyle = '#ffffff';
    out.fillRect(0, 0, width, height);

    out.save();
    out.strokeStyle = '#e7edf5';
    out.lineWidth = 1;
    for (let x = 0; x <= width; x += 28) {
      out.beginPath(); out.moveTo(x, 0); out.lineTo(x, height); out.stroke();
    }
    for (let y = 0; y <= height; y += 28) {
      out.beginPath(); out.moveTo(0, y); out.lineTo(width, y); out.stroke();
    }
    out.restore();

    const layer = document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    const lctx = layer.getContext('2d');
    const page = nb.pages && nb.pages[0];
    (page && page.strokes ? page.strokes : []).forEach(function(stroke) {
      drawPreviewStroke(lctx, stroke, width, height, page ? page.height : INITIAL_PAGE_HEIGHT);
    });
    out.drawImage(layer, 0, 0);
    drawPageImagesPreview(out, page, width, height);
  }

  function notebookCreatedDate(nb) {
    const d = new Date(nb && nb.createdAt ? nb.createdAt : 0);
    return Number.isFinite(d.getTime()) ? d : new Date(0);
  }

  function notebookUpdatedDate(nb) {
    const d = new Date(nb && (nb.updatedAt || nb.createdAt) ? (nb.updatedAt || nb.createdAt) : 0);
    return Number.isFinite(d.getTime()) ? d : new Date(0);
  }

  function clonePage(page, title) {
    const now = new Date().toISOString();
    const copy = JSON.parse(JSON.stringify(page || {}));
    copy.id = uuid();
    copy.title = title || ((page && page.title) ? page.title + ' · copia' : 'Página');
    copy.createdAt = now;
    copy.coordVersion = 2;
    copy.height = Math.max(INITIAL_PAGE_HEIGHT, Number(copy.height) || INITIAL_PAGE_HEIGHT);
    copy.zoom = clamp(Number(copy.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
    copy.scrollY = 0;
    copy.scrollX = 0;
    copy.redoStack = [];
    copy.strokes = (page && page.strokes ? page.strokes : []).map(function(stroke) {
      const s = JSON.parse(JSON.stringify(stroke));
      s.id = uuid();
      return s;
    });
    copy.images = (page && page.images ? page.images : []).map(function(image) {
      const next = JSON.parse(JSON.stringify(image));
      next.id = uuid();
      return next;
    });
    return copy;
  }

  function blankPage(title) {
    return {
      id: uuid(),
      title: title || 'Página 1',
      createdAt: new Date().toISOString(),
      strokes: [],
      coordVersion: 2,
      height: INITIAL_PAGE_HEIGHT,
      zoom: 1,
      scrollY: 0,
      scrollX: 0,
      redoStack: [],
      images: []
    };
  }

  function syncNotebookPages(nb, options) {
    if (!nb) return;
    options = options || {};
    if (!Array.isArray(nb.pages) || !nb.pages.length) nb.pages = [blankPage('Página 1')];
    nb.updatedAt = new Date().toISOString();
    if (!nb.pages.some(function(p) { return p.id === currentPageId; }) && currentNotebookId === nb.id) {
      currentPageId = options.currentPageId && nb.pages.some(function(p) { return p.id === options.currentPageId; })
        ? options.currentPageId
        : nb.pages[0].id;
    }
    persist();
    broadcast('pages-replaced', {
      notebookId: nb.id,
      pages: nb.pages,
      currentPageId: currentNotebookId === nb.id ? currentPageId : (options.currentPageId || null)
    });
    if (currentNotebookId === nb.id) {
      renderPages();
      redraw();
    }
    renderNotebookList();
  }

  function insertPageAfter(pageId) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly) return;
    if (!Array.isArray(nb.pages)) nb.pages = [];
    let index = pageId ? nb.pages.findIndex(function(p) { return p.id === pageId; }) : -1;
    if (index < -1) index = -1;
    const p = blankPage('Página ' + (nb.pages.length + 1));
    nb.pages.splice(index + 1, 0, p);
    currentPageId = p.id;
    pageSelection.clear();
    syncNotebookPages(nb, { currentPageId: p.id });
    sendFocus();
  }

  function renamePage(pageId) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly) return;
    const page = getPage(nb, pageId);
    if (!page) return;
    const next = prompt('Nombre de la hoja:', page.title || '');
    if (next === null || !next.trim()) return;
    page.title = next.trim();
    syncNotebookPages(nb);
  }

  function duplicatePage(pageId) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly || !Array.isArray(nb.pages)) return;
    const index = nb.pages.findIndex(function(p) { return p.id === pageId; });
    if (index < 0) return;
    const copy = clonePage(nb.pages[index]);
    nb.pages.splice(index + 1, 0, copy);
    currentPageId = copy.id;
    pageSelection.clear();
    syncNotebookPages(nb, { currentPageId: copy.id });
    sendFocus();
  }

  function reorderPage(sourceId, targetId) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly || sourceId === targetId || !Array.isArray(nb.pages)) return;
    const from = nb.pages.findIndex(function(p) { return p.id === sourceId; });
    const to = nb.pages.findIndex(function(p) { return p.id === targetId; });
    if (from < 0 || to < 0) return;
    const moved = nb.pages.splice(from, 1)[0];
    let insertAt = to;
    if (from < to) insertAt = to - 1;
    nb.pages.splice(Math.max(0, insertAt), 0, moved);
    syncNotebookPages(nb);
  }

  function selectedPageIds() {
    const nb = getNotebook(currentNotebookId);
    if (!nb) return [];
    const ids = Array.from(pageSelection).filter(function(id) {
      return nb.pages && nb.pages.some(function(p) { return p.id === id; });
    });
    return ids.length ? ids : (currentPageId ? [currentPageId] : []);
  }

  function deleteSelectedPages() {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly || !Array.isArray(nb.pages)) return;
    const ids = selectedPageIds();
    if (!ids.length) return;
    if (!confirm('¿Borrar ' + ids.length + ' hoja(s) seleccionada(s)?')) return;
    const set = new Set(ids);
    nb.pages = nb.pages.filter(function(p) { return !set.has(p.id); });
    if (!nb.pages.length) nb.pages = [blankPage('Página 1')];
    pageSelection.clear();
    if (!nb.pages.some(function(p) { return p.id === currentPageId; })) currentPageId = nb.pages[0].id;
    syncNotebookPages(nb);
    sendFocus();
  }

  function transferSelectedPages(targetNotebookId, mode) {
    const source = getNotebook(currentNotebookId);
    const target = getNotebook(targetNotebookId);
    if (!source || !target || source.id === target.id || readOnly) return;
    const ids = selectedPageIds();
    if (!ids.length) return;
    const selectedSet = new Set(ids);
    const ordered = (source.pages || []).filter(function(p) { return selectedSet.has(p.id); });
    if (!ordered.length) return;

    if (!Array.isArray(target.pages)) target.pages = [];
    if (mode === 'move') {
      target.pages.push.apply(target.pages, ordered);
      source.pages = (source.pages || []).filter(function(p) { return !selectedSet.has(p.id); });
      if (!source.pages.length) source.pages = [blankPage('Página 1')];
      if (!source.pages.some(function(p) { return p.id === currentPageId; })) currentPageId = source.pages[0].id;
    } else {
      const copies = ordered.map(function(page) { return clonePage(page, page.title); });
      target.pages.push.apply(target.pages, copies);
    }

    pageSelection.clear();
    source.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    persist();
    broadcast('pages-replaced', { notebookId: source.id, pages: source.pages, currentPageId: currentPageId });
    broadcast('pages-replaced', { notebookId: target.id, pages: target.pages, currentPageId: null });
    renderPages();
    redraw();
    renderNotebookList();
    flashStatus(mode === 'move' ? '📄 Hojas movidas' : '📄 Hojas copiadas');
    sendFocus();
  }

  function renderPagePreview(canvasEl, page) {
    if (!canvasEl) return;
    const width = 260;
    const height = 170;
    canvasEl.width = width;
    canvasEl.height = height;
    const out = canvasEl.getContext('2d');
    out.clearRect(0, 0, width, height);
    out.fillStyle = '#ffffff';
    out.fillRect(0, 0, width, height);
    out.save();
    out.strokeStyle = '#e7edf5';
    out.lineWidth = 1;
    for (let x = 0; x <= width; x += 22) {
      out.beginPath(); out.moveTo(x, 0); out.lineTo(x, height); out.stroke();
    }
    for (let y = 0; y <= height; y += 22) {
      out.beginPath(); out.moveTo(0, y); out.lineTo(width, y); out.stroke();
    }
    out.restore();
    (page && page.strokes ? page.strokes : []).forEach(function(stroke) {
      drawPreviewStroke(out, stroke, width, height, page ? page.height : INITIAL_PAGE_HEIGHT);
    });
    drawPageImagesPreview(out, page, width, height);
  }

  function refreshPageManagerPreviews() {
    const nb = getNotebook(currentNotebookId);
    if (!nb) return;
    document.querySelectorAll('[data-page-preview]').forEach(function(canvasEl) {
      const page = getPage(nb, canvasEl.dataset.pagePreview);
      if (page) renderPagePreview(canvasEl, page);
    });
  }

  function startTouchPageReorder(card, pageId, event) {
    if (touchPageDrag || readOnly) return;
    const pointerId = event.pointerId;
    const sx = event.clientX;
    const sy = event.clientY;
    let active = false;
    let ghost = null;
    const timer = setTimeout(function() {
      active = true;
      touchPageDrag = { pageId: pageId };
      card.classList.add('dragging');
      ghost = document.createElement('div');
      ghost.className = 'nb-drag-ghost';
      ghost.textContent = '📄 ' + ((getPage(getNotebook(currentNotebookId), pageId) || {}).title || 'Hoja');
      document.body.appendChild(ghost);
      ghost.style.left = sx + 'px';
      ghost.style.top = sy + 'px';
      if (navigator.vibrate) navigator.vibrate(20);
    }, 350);

    function targetAt(x, y) {
      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(x, y);
      if (ghost) ghost.style.display = '';
      return el && el.closest ? el.closest('[data-page-thumb]') : null;
    }

    function move(e) {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer);
        return;
      }
      e.preventDefault();
      if (ghost) {
        ghost.style.left = e.clientX + 'px';
        ghost.style.top = e.clientY + 'px';
      }
      document.querySelectorAll('.nb-page-thumb.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
      const target = targetAt(e.clientX, e.clientY);
      if (target && target.dataset.pageThumb !== pageId) target.classList.add('drop-target');
    }

    function end(e) {
      if (e.pointerId !== pointerId) return;
      clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (active) {
        e.preventDefault();
        const target = targetAt(e.clientX, e.clientY);
        if (target && target.dataset.pageThumb !== pageId) reorderPage(pageId, target.dataset.pageThumb);
      }
      document.querySelectorAll('.nb-page-thumb.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
      card.classList.remove('dragging');
      if (ghost) ghost.remove();
      touchPageDrag = null;
    }

    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  function deleteNotebook(id) {
    const store = ensureStore();
    const nb = store.notebooks[id];
    if (!nb) return;
    if (!confirm('¿Borrar el cuaderno “' + nb.title + '”?')) return;
    delete store.notebooks[id];
    store.order = store.order.filter(x => x !== id);
    persist();
    broadcast('notebook-deleted', { notebookId: id });
    if (currentNotebookId === id) {
      currentNotebookId = null;
      currentPageId = null;
      showList();
    }
    renderNotebookList();
  }

  function addPage() {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly) return;
    const last = Array.isArray(nb.pages) && nb.pages.length ? nb.pages[nb.pages.length - 1] : null;
    insertPageAfter(last ? last.id : null);
  }

  function renameNotebook() {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly) return;
    const next = prompt('Nombre del cuaderno:', nb.title);
    if (next === null || !next.trim()) return;
    nb.title = next.trim();
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('notebook-renamed', { notebookId: nb.id, title: nb.title });
    renderEditor();
    renderNotebookList();
  }

  function deleteCurrentPage() {
    const nb = getNotebook(currentNotebookId);
    if (!nb || readOnly || !Array.isArray(nb.pages) || nb.pages.length <= 1) return;
    const page = getPage(nb, currentPageId);
    if (!page || !confirm('¿Borrar ' + page.title + '?')) return;
    nb.pages = nb.pages.filter(p => p.id !== page.id);
    currentPageId = nb.pages[0].id;
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('page-deleted', { notebookId: nb.id, pageId: page.id });
    renderEditor();
    sendFocus();
  }

  function undo() {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!page || readOnly || !Array.isArray(page.strokes) || !page.strokes.length) return;
    normalizePage(page);
    const removed = page.strokes.pop();
    page.redoStack.push(JSON.parse(JSON.stringify(removed)));
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('undo', { notebookId: nb.id, pageId: page.id, strokeId: removed.id });
    redraw();
    refreshPageManagerPreviews();
    renderNotebookList();
  }

  function redo() {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!page || readOnly) return;
    normalizePage(page);
    const restored = page.redoStack.pop();
    if (!restored) return;
    page.strokes.push(restored);
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('stroke-restored', { notebookId: nb.id, pageId: page.id, stroke: restored });
    redraw();
    refreshPageManagerPreviews();
    renderNotebookList();
  }

  function clearPage() {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!page || readOnly || !page.strokes || !page.strokes.length) return;
    if (!confirm('¿Borrar todos los trazos de esta página?')) return;
    page.strokes = [];
    page.redoStack = [];
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('page-cleared', { notebookId: nb.id, pageId: page.id });
    redraw();
    refreshPageManagerPreviews();
    renderNotebookList();
  }

  function copyLink() {
    if (!currentNotebookId) return;
    const url = new URL(location.href);
    url.hash = 'cuaderno=' + encodeURIComponent(currentNotebookId) + '&pagina=' + encodeURIComponent(currentPageId || '');
    const text = url.toString();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashStatus('🔗 Link copiado')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
    flashStatus('🔗 Link copiado');
  }

  function injectStyles() {
    if (document.getElementById('info1NotebookStyles')) return;
    const style = document.createElement('style');
    style.id = 'info1NotebookStyles';
    style.textContent =
      '#notebooksView{min-height:620px}' +
      '.nb-shell{display:grid;gap:14px}' +
      '.nb-head{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}' +
      '.nb-head h2{margin:0 0 6px}.nb-head p{margin:0;color:var(--muted);max-width:780px}' +
      '.nb-actions{display:flex;gap:8px;flex-wrap:wrap}' +
      '.nb-btn{border:1px solid var(--line);background:#12203c;color:#fff;border-radius:11px;padding:9px 11px;font-weight:800;cursor:pointer}' +
      '.nb-btn:hover{border-color:var(--blue)}.nb-btn.primary{background:#244a91}.nb-btn.danger{background:#401923;border-color:#7c3440}' +
      '.nb-follow.active{background:#153e32;border-color:#3e9d79}' +
      '.nb-library-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.nb-library-tools input{min-width:220px;flex:1;border:1px solid #38527d;background:#0b152a;color:#fff;border-radius:11px;padding:10px 12px}' +
      '.nb-breadcrumbs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0 12px}.nb-crumb{border:1px solid #334d77;background:#0f1c36;color:#d7e4fb;border-radius:999px;padding:6px 9px;font-weight:800;cursor:pointer}.nb-crumb.active{background:#234a88;border-color:#6d9af0}' +
      '.nb-folder-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:10px 0 16px}.nb-folder{border:1px solid #334d77;border-left:7px solid var(--folder-color,#315a9b);background:#0d1730;border-radius:15px;padding:12px;display:grid;gap:8px}.nb-folder-head{display:flex;gap:9px;align-items:center}.nb-folder-icon{font-size:28px}.nb-folder-title{font-weight:900;overflow-wrap:anywhere}.nb-folder-meta{color:var(--muted);font-size:12px}.nb-folder-actions{display:flex;gap:6px;flex-wrap:wrap}.nb-folder-actions button{font-size:12px;padding:6px 8px}' +
      '.nb-section-title{margin:16px 0 8px;font-size:14px;color:#c7d7f5}.nb-move-select{max-width:190px;border:1px solid #3a527b;background:#101d35;color:#fff;border-radius:9px;padding:7px 8px}' +
      '.nb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:16px;align-items:start}.nb-grid.list{display:grid;grid-template-columns:1fr;gap:10px}' +
      '@media(min-width:760px) and (max-width:1180px){.nb-grid:not(.list){grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:759px){.nb-grid:not(.list){grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}}@media(max-width:480px){.nb-grid:not(.list){grid-template-columns:1fr}}' +
      '.nb-card{border:1px solid var(--line);background:#0d1730;border-radius:18px;padding:11px;display:grid;gap:9px;min-width:0;transition:transform .14s,border-color .14s,box-shadow .14s}.nb-card:hover{border-color:#587cb8;transform:translateY(-2px);box-shadow:0 12px 30px #0004}.nb-card.dragging{opacity:.45}.nb-card.drop-target,.nb-folder.drop-target,#nbRootNotebooks.drop-target{outline:3px solid #79a6ff;outline-offset:3px}' +
      '.nb-cover{position:relative;aspect-ratio:1.48/1;border:1px solid #3a4e70;border-radius:13px;overflow:hidden;background:#fff;cursor:pointer}.nb-cover canvas{display:block;width:100%;height:100%;pointer-events:none}.nb-cover-badge{position:absolute;left:8px;bottom:8px;background:#071126dc;color:#fff;border:1px solid #ffffff24;border-radius:999px;padding:5px 8px;font-size:11px;font-weight:850;backdrop-filter:blur(6px)}.nb-favorite{position:absolute;right:8px;top:8px;border:1px solid #ffffff44!important;background:#071126dd!important;color:#facc15!important;border-radius:999px!important;width:36px;height:36px;padding:0!important;font-size:18px;z-index:2}.nb-favorite.off{color:#d1d5db!important}' +
      '.nb-card-info{display:grid;gap:4px}.nb-card h3{margin:0;font-size:15px;line-height:1.25;overflow-wrap:anywhere}.nb-card .meta{font-size:11px;color:var(--muted);line-height:1.35}.nb-card .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.nb-card .row .nb-btn{padding:7px 8px;font-size:12px}' +
      '.nb-grid.list .nb-card{grid-template-columns:190px minmax(0,1fr);align-items:center}.nb-grid.list .nb-cover{grid-row:1/span 3}.nb-grid.list .nb-card-info{align-self:stretch}.nb-grid.list .row{grid-column:2}.nb-grid.list .nb-cover{aspect-ratio:1.48/1}@media(max-width:650px){.nb-grid.list .nb-card{grid-template-columns:118px minmax(0,1fr)}.nb-grid.list .row{grid-column:1/-1}}' +
      '.nb-library-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 12px}.nb-library-filters select,.nb-library-filters input[type=date]{border:1px solid #38527d;background:#0b152a;color:#fff;border-radius:10px;padding:9px 10px;min-height:38px}.nb-library-filters .spacer{flex:1}.nb-view-toggle.active{background:#284d8e;border-color:#78a7ff}.nb-drag-ghost{position:fixed;z-index:50000;pointer-events:none;background:#14264a;color:#fff;border:1px solid #79a6ff;border-radius:12px;padding:9px 12px;box-shadow:0 16px 50px #0009;font-weight:850;max-width:260px;transform:translate(14px,14px)}' +
      '.nb-topic-btn{margin-left:auto}' +
      '.nb-editor{display:grid;gap:12px}' +
      '.nb-editor-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '.nb-title-wrap{min-width:220px;flex:1}.nb-title-wrap h2{margin:0 0 4px;font-size:clamp(22px,3vw,34px)}' +
      '.nb-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid var(--line);background:#0c1529;border-radius:14px}' +
      '.nb-toolbar button,.nb-toolbar select,.nb-toolbar input{border:1px solid #3a4d71;background:#111d35;color:#fff;border-radius:9px;padding:8px 9px}' +
      '.nb-toolbar button.active{background:#285499;border-color:#76a7ff}' +
      '.nb-toolbar input[type=color]{width:42px;height:36px;padding:3px}.nb-toolbar input[type=range]{width:110px;padding:0}' +
      '.nb-input-status{display:inline-flex;align-items:center;min-height:34px;padding:0 9px;border:1px solid #38527d;border-radius:999px;background:#0b152a;color:#b9c9e5;font:800 11px system-ui}.nb-input-status.pen{border-color:#3e9d79;color:#8ef0c8;background:#0d2b24}' +
      '@media(max-width:820px){.nb-toolbar{position:sticky;top:4px;z-index:60;overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch}.nb-toolbar>*{flex:0 0 auto}.nb-toolbar label.small{display:flex;align-items:center}.nb-editor-top{gap:7px}.nb-page-manager{padding:8px}}' +
      '@media(max-width:520px){.nb-toolbar{margin-left:-4px;margin-right:-4px;border-radius:11px}.nb-title-wrap h2{font-size:21px}.nb-actions .nb-btn{padding:7px 8px;font-size:12px}}' +
      '.nb-pages{display:flex;gap:7px;overflow:auto;padding-bottom:3px}.nb-page-tab{white-space:nowrap;border:1px solid var(--line);background:#101a31;color:#cbd5e1;border-radius:999px;padding:7px 10px;font-weight:800}' +
      '.nb-page-tab.active{background:#1b3769;color:#fff;border-color:#5e8de6}' +
      '.nb-page-manager{border:1px solid #334d77;background:#091427;border-radius:15px;padding:10px;display:grid;gap:10px}.nb-page-manager-head{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.nb-page-manager-head strong{margin-right:auto}.nb-page-manager-head select{border:1px solid #38527d;background:#0f1d36;color:#fff;border-radius:9px;padding:8px;max-width:230px}.nb-page-thumbs{display:flex;gap:10px;overflow-x:auto;padding:3px 2px 8px;scroll-snap-type:x proximity}.nb-page-thumb{position:relative;flex:0 0 178px;border:1px solid #334d77;background:#0d1930;border-radius:13px;padding:8px;display:grid;gap:7px;scroll-snap-align:start}.nb-page-thumb.active{border-color:#79a6ff;box-shadow:0 0 0 2px #79a6ff33}.nb-page-thumb.selected{background:#142b50;border-color:#8bb2ff}.nb-page-thumb.dragging{opacity:.45}.nb-page-thumb.drop-target{outline:3px solid #79a6ff;outline-offset:2px}.nb-page-preview{position:relative;aspect-ratio:1.53/1;background:#fff;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;cursor:pointer}.nb-page-preview canvas{width:100%;height:100%;display:block;pointer-events:none}.nb-page-check{position:absolute;z-index:3;top:12px;left:12px;background:#071126df;border-radius:999px;padding:4px;line-height:1}.nb-page-check input{width:18px;height:18px}.nb-page-thumb-title{font-weight:850;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nb-page-thumb-actions{display:flex;gap:5px;flex-wrap:wrap}.nb-page-thumb-actions button{padding:5px 7px;font-size:11px}.nb-insert-after{width:100%;border:1px dashed #526c97!important;background:#0a1428!important;color:#bcd0f4!important}.nb-selected-count{font-size:12px;color:#a9bad7;font-weight:800}' +
      '.nb-editor{padding-bottom:96px}' +
      '.nb-bottom-pager{position:fixed;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:25000;display:flex;align-items:stretch;background:#f8fafc;color:#111827;border:1px solid #d9dee8;border-radius:20px;box-shadow:0 12px 42px #0005;overflow:hidden;min-height:58px;backdrop-filter:blur(16px)}' +
      '.nb-bottom-pager button{appearance:none;border:0;background:#f8fafc;color:#111827;min-width:58px;padding:0 16px;font-size:28px;line-height:1;font-weight:500;cursor:pointer}' +
      '.nb-bottom-pager button:hover{background:#eef2f7}.nb-bottom-pager button:disabled{opacity:.28;cursor:default}' +
      '.nb-bottom-count{display:flex;align-items:center;justify-content:center;min-width:82px;padding:0 12px;font:800 16px/1 system-ui;border-left:1px solid #e1e5ec;border-right:1px solid #e1e5ec;white-space:nowrap}' +
      '@media(max-width:600px){.nb-bottom-pager{bottom:max(10px,env(safe-area-inset-bottom));min-height:54px}.nb-bottom-pager button{min-width:54px;padding:0 13px}.nb-bottom-count{min-width:74px}}' +
      '.nb-canvas-wrap{position:relative;height:min(72vh,860px);min-height:520px;border:1px solid #50617b;border-radius:16px;overflow:auto;background:#101827;overscroll-behavior:contain;touch-action:none;box-shadow:0 18px 60px #0005;scrollbar-gutter:stable;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.nb-canvas-wrap *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.nb-canvas-stage{position:relative;margin:10px auto 80px;background-color:#fff;background-image:linear-gradient(#dbe4f055 1px,transparent 1px),linear-gradient(90deg,#dbe4f055 1px,transparent 1px);background-size:28px 28px;box-shadow:0 8px 32px #0005;transform-origin:0 0;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '#info1NotebookCanvas{position:absolute;inset:0;z-index:2;display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none}' +
      '.nb-image-bg-layer,.nb-image-layer{position:absolute;inset:0;pointer-events:none}.nb-image-bg-layer{z-index:1;overflow:hidden}.nb-image-layer{z-index:3}.nb-image-object{position:absolute;transform-origin:center center;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none}.nb-image-object img{display:block;width:100%;height:100%;object-fit:fill;pointer-events:none;user-select:none;-webkit-user-drag:none}.nb-image-object.selected{outline:2px solid #4f8cff;outline-offset:2px}.nb-image-object.locked{cursor:not-allowed}.nb-image-object:not(.locked){cursor:move}.nb-image-handle{position:absolute;width:22px;height:22px;border-radius:999px;background:#fff;border:2px solid #2f6fde;box-shadow:0 2px 8px #0006;pointer-events:auto}.nb-image-resize{right:-12px;bottom:-12px;cursor:nwse-resize}.nb-image-rotate{left:50%;top:-34px;transform:translateX(-50%);cursor:grab}.nb-image-rotate:after{content:"";position:absolute;left:9px;top:18px;width:2px;height:16px;background:#2f6fde}.nb-image-bg{pointer-events:none!important}.nb-image-bg img{object-fit:cover}.nb-image-tools{display:none;gap:7px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid #3d5d90;background:#0b1730;border-radius:12px}.nb-image-tools.active{display:flex}.nb-image-tools .label{font-weight:900;color:#cfe0ff;margin-right:auto}.nb-drop-active{outline:3px dashed #77a5ff;outline-offset:-7px}.nb-file-hidden{display:none!important}' +
      '.nb-canvas-hint{position:sticky;left:12px;top:10px;z-index:4;display:inline-flex;background:#071126dd;color:#dbeafe;border:1px solid #ffffff22;border-radius:999px;padding:6px 9px;font:800 11px system-ui;pointer-events:none;backdrop-filter:blur(6px)}' +
      '@media(max-width:700px){.nb-canvas-wrap{height:68vh;min-height:460px}.nb-canvas-stage{margin-top:6px}}' +
      '.nb-readonly-banner{position:absolute;top:10px;right:10px;z-index:2;background:#09101fdd;color:#fff;border:1px solid #6b7d9c;border-radius:999px;padding:7px 10px;font:800 12px system-ui;pointer-events:none}' +
      '.nb-live{font-size:12px;color:#9fb0cf}.nb-live.ok{color:#7fe3ba}.nb-live.warn{color:#ffe18a}' +
      '.nb-status-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:30000;background:#09101ff2;color:#fff;border:1px solid #4b628e;border-radius:999px;padding:9px 13px;font:800 12px system-ui;box-shadow:0 10px 35px #0008}' +
      '.nb-open-card{background:#12203c!important;border-color:#4c6ea9!important}';
    document.head.appendChild(style);
  }

  function ensureUi() {
    injectStyles();
    if (!document.getElementById('notebooksView')) {
      const main = document.querySelector('main');
      if (!main) return false;
      const section = document.createElement('section');
      section.id = 'notebooksView';
      section.className = 'view';
      section.innerHTML =
        '<div class="nb-shell">' +
          '<div id="nbListPanel">' +
            '<div class="nb-head">' +
              '<div><h2>📓 Cuadernos compartidos</h2><p>Escribí desde la tablet y miralo al instante en la notebook. Cada ficha puede tener su cuaderno y también podés crear cuadernos libres.</p></div>' +
              '<div class="nb-actions">' +
                '<button id="nbFollowBtn" class="nb-btn nb-follow" type="button">👀 Seguir otra pantalla</button>' +
                '<button id="nbNewFree" class="nb-btn primary" type="button">＋ Cuaderno libre</button>' +
              '</div>' +
            '</div>' +
            '<div id="nbCloudStatus" class="nb-live">Conectando…</div>' +
            '<div class="nb-library-tools">' +
              '<button id="nbAllFolders" class="nb-btn" type="button">🗂️ Todos</button>' +
              '<button id="nbRootNotebooks" class="nb-btn" data-drop-folder="" type="button">🗒️ Sin carpeta</button>' +
              '<button id="nbNewFolder" class="nb-btn primary" type="button">＋ Carpeta</button>' +
              '<input id="nbFolderSearch" type="search" placeholder="Buscar cuaderno dentro de esta vista…">' +
            '</div>' +
            '<div id="nbBreadcrumbs" class="nb-breadcrumbs"></div>' +
            '<div class="nb-library-filters">' +
              '<select id="nbFolderFilter" aria-label="Filtrar por carpeta"></select>' +
              '<select id="nbTopicFilter" aria-label="Filtrar por ficha"></select>' +
              '<input id="nbDateFilter" type="date" aria-label="Filtrar por fecha de creación">' +
              '<select id="nbSort" aria-label="Ordenar cuadernos">' +
                '<option value="recent">Más reciente</option>' +
                '<option value="old">Más antiguo</option>' +
                '<option value="az">A–Z</option>' +
              '</select>' +
              '<span class="spacer"></span>' +
              '<button id="nbGridView" class="nb-btn nb-view-toggle" type="button">▦ Cuadrícula</button>' +
              '<button id="nbListView" class="nb-btn nb-view-toggle" type="button">☷ Lista</button>' +
            '</div>' +
            '<div id="nbFolders" class="nb-folder-grid"></div>' +
            '<h3 id="nbNotebookSectionTitle" class="nb-section-title">Cuadernos</h3>' +
            '<div id="nbList" class="nb-grid"></div>' +
          '</div>' +
          '<div id="nbEditorPanel" class="nb-editor hidden"></div>' +
        '</div>';
      main.prepend(section);
    }

    if (!document.getElementById('nbNavTab')) {
      const nav = document.querySelector('.nav-hub');
      if (nav) {
        const btn = document.createElement('button');
        btn.id = 'nbNavTab';
        btn.className = 'tab';
        btn.dataset.view = 'notebooksView';
        btn.type = 'button';
        btn.textContent = '📓 Cuadernos';
        btn.onclick = function() {
          openNotebookView();
          showList();
        };
        nav.appendChild(btn);
      }
    }

    const followBtn = document.getElementById('nbFollowBtn');
    if (followBtn) {
      followBtn.classList.toggle('active', followMode);
      followBtn.textContent = followMode ? '👀 Siguiendo otra pantalla' : '👀 Seguir otra pantalla';
      followBtn.onclick = toggleFollow;
    }
    const newBtn = document.getElementById('nbNewFree');
    if (newBtn) newBtn.onclick = createStandalone;
    const newFolderBtn = document.getElementById('nbNewFolder');
    if (newFolderBtn) newFolderBtn.onclick = function() {
      const parentId = currentFolderId && currentFolderId !== '__root__' ? currentFolderId : null;
      createFolder(parentId);
    };
    const allFoldersBtn = document.getElementById('nbAllFolders');
    if (allFoldersBtn) allFoldersBtn.onclick = function() {
      currentFolderId = null;
      renderNotebookList();
    };
    const rootNotebooksBtn = document.getElementById('nbRootNotebooks');
    if (rootNotebooksBtn) rootNotebooksBtn.onclick = function() {
      currentFolderId = '__root__';
      renderNotebookList();
    };
    const searchBox = document.getElementById('nbFolderSearch');
    if (searchBox) {
      searchBox.value = folderSearch;
      searchBox.oninput = function() {
        folderSearch = searchBox.value || '';
        renderNotebookList();
      };
    }

    const topBtn = document.getElementById('nbTopButton');
    if (topBtn) {
      topBtn.onclick = function() {
        openNotebookView();
        showList();
      };
    }

    renderNotebookList();
    enhanceTopicCards();
    enhanceTopicModal();
    return true;
  }

  function openNotebookView() {
    document.querySelectorAll('.tab').forEach(function(b) {
      b.classList.toggle('active', b.dataset && b.dataset.view === 'notebooksView');
    });
    const topBtn = document.getElementById('nbTopButton');
    if (topBtn) topBtn.classList.add('active');
    document.querySelectorAll('.view').forEach(function(v) {
      v.classList.toggle('active', v.id === 'notebooksView');
    });
    document.querySelectorAll('.nav-menu[open]').forEach(function(d) { d.removeAttribute('open'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearTopNotebookActive() {
    const topBtn = document.getElementById('nbTopButton');
    if (topBtn) topBtn.classList.remove('active');
  }

  function showList() {
    openNotebookView();
    currentNotebookId = null;
    currentPageId = null;
    currentDraft = null;
    remoteDrafts.clear();
    const list = document.getElementById('nbListPanel');
    const editor = document.getElementById('nbEditorPanel');
    if (list) list.classList.remove('hidden');
    if (editor) {
      editor.classList.add('hidden');
      editor.innerHTML = '';
    }
    renderNotebookList();
  }

  function clearDragTargets() {
    document.querySelectorAll('.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
  }

  function bindFolderDropTargets() {
    document.querySelectorAll('[data-drop-folder]').forEach(function(target) {
      target.ondragover = function(e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        clearDragTargets();
        target.classList.add('drop-target');
      };
      target.ondragleave = function() { target.classList.remove('drop-target'); };
      target.ondrop = function(e) {
        e.preventDefault();
        const id = e.dataTransfer ? e.dataTransfer.getData('text/info1-notebook') : '';
        clearDragTargets();
        if (!id) return;
        setNotebookFolder(id, target.dataset.dropFolder || null);
      };
    });
  }

  function startTouchNotebookDrag(card, nb, event) {
    if (touchDrag) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    let ghost = null;
    const timer = setTimeout(function() {
      active = true;
      touchDrag = { notebookId: nb.id };
      card.classList.add('dragging');
      ghost = document.createElement('div');
      ghost.className = 'nb-drag-ghost';
      ghost.textContent = '📓 ' + nb.title;
      document.body.appendChild(ghost);
      ghost.style.left = startX + 'px';
      ghost.style.top = startY + 'px';
      if (navigator.vibrate) navigator.vibrate(25);
    }, 360);

    function targetAt(x, y) {
      if (ghost) ghost.style.display = 'none';
      const el = document.elementFromPoint(x, y);
      if (ghost) ghost.style.display = '';
      return el && el.closest ? el.closest('[data-drop-folder]') : null;
    }

    function move(e) {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) clearTimeout(timer);
        return;
      }
      e.preventDefault();
      if (ghost) {
        ghost.style.left = e.clientX + 'px';
        ghost.style.top = e.clientY + 'px';
      }
      clearDragTargets();
      const target = targetAt(e.clientX, e.clientY);
      if (target) target.classList.add('drop-target');
    }

    function end(e) {
      if (e.pointerId !== pointerId) return;
      clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      if (active) {
        e.preventDefault();
        const target = targetAt(e.clientX, e.clientY);
        if (target) setNotebookFolder(nb.id, target.dataset.dropFolder || null);
      }
      clearDragTargets();
      card.classList.remove('dragging');
      if (ghost) ghost.remove();
      touchDrag = null;
    }

    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  function renderNotebookList() {
    const root = document.getElementById('nbList');
    const foldersRoot = document.getElementById('nbFolders');
    const crumbsRoot = document.getElementById('nbBreadcrumbs');
    const titleRoot = document.getElementById('nbNotebookSectionTitle');
    if (!root) return;
    const store = ensureStore();
    const selectedFolder = currentFolderId && currentFolderId !== '__root__' ? folderById(currentFolderId) : null;
    if (currentFolderId && currentFolderId !== '__root__' && !selectedFolder) currentFolderId = null;

    // Folder filter/navigation.
    const folderFilter = document.getElementById('nbFolderFilter');
    if (folderFilter) {
      const options = ['<option value="all">Todas las carpetas</option>', '<option value="__root__">Sin carpeta</option>'];
      store.folderOrder.forEach(function(id) {
        const folder = store.folders[id];
        if (!folder) return;
        const depth = Math.max(0, folderPath(id).length - 1);
        options.push('<option value="' + escapeHtml(id) + '">' + escapeHtml('—'.repeat(depth) + (depth ? ' ' : '') + (folder.icon || '📁') + ' ' + folder.name) + '</option>');
      });
      folderFilter.innerHTML = options.join('');
      folderFilter.value = currentFolderId === null ? 'all' : currentFolderId;
      folderFilter.onchange = function() {
        currentFolderId = folderFilter.value === 'all' ? null : folderFilter.value;
        renderNotebookList();
      };
    }

    if (crumbsRoot) {
      let crumbs = '<button class="nb-crumb ' + (currentFolderId === null ? 'active' : '') + '" data-folder-nav="">🗂️ Todos</button>';
      if (currentFolderId === '__root__') {
        crumbs += '<span>›</span><button class="nb-crumb active" data-folder-nav="__root__" data-drop-folder="">🗒️ Sin carpeta</button>';
      } else if (selectedFolder) {
        folderPath(selectedFolder.id).forEach(function(folder, index, arr) {
          crumbs += '<span>›</span><button class="nb-crumb ' + (index === arr.length - 1 ? 'active' : '') + '" data-folder-nav="' + escapeHtml(folder.id) + '" data-drop-folder="' + escapeHtml(folder.id) + '">' + escapeHtml(folder.icon || '📁') + ' ' + escapeHtml(folder.name) + '</button>';
        });
      }
      crumbsRoot.innerHTML = crumbs;
      crumbsRoot.querySelectorAll('[data-folder-nav]').forEach(function(btn) {
        btn.onclick = function() {
          currentFolderId = btn.dataset.folderNav || null;
          renderNotebookList();
        };
      });
    }

    const folderParent = selectedFolder ? selectedFolder.id : null;
    const visibleFolders = currentFolderId === '__root__' ? [] : folderChildren(folderParent);
    if (foldersRoot) {
      foldersRoot.innerHTML = visibleFolders.map(function(folder) {
        const count = folderNotebookCount(folder.id);
        const subcount = folderChildren(folder.id).length;
        return '<article class="nb-folder" data-drop-folder="' + escapeHtml(folder.id) + '" style="--folder-color:' + escapeHtml(folder.color || '#315a9b') + '">' +
          '<div class="nb-folder-head">' +
            '<span class="nb-folder-icon">' + escapeHtml(folder.icon || '📁') + '</span>' +
            '<div><div class="nb-folder-title">' + escapeHtml(folder.name) + '</div><div class="nb-folder-meta">' + count + ' cuaderno(s)' + (subcount ? ' · ' + subcount + ' subcarpeta(s)' : '') + '</div></div>' +
          '</div>' +
          '<div class="nb-folder-actions">' +
            '<button class="nb-btn primary" data-folder-open="' + escapeHtml(folder.id) + '">Abrir</button>' +
            '<button class="nb-btn" data-folder-newnb="' + escapeHtml(folder.id) + '">＋ Cuaderno</button>' +
            '<button class="nb-btn" data-folder-sub="' + escapeHtml(folder.id) + '">＋ Subcarpeta</button>' +
            '<button class="nb-btn" data-folder-rename="' + escapeHtml(folder.id) + '">✏️</button>' +
            '<button class="nb-btn" data-folder-style="' + escapeHtml(folder.id) + '">🎨</button>' +
            '<button class="nb-btn" data-folder-up="' + escapeHtml(folder.id) + '">↑</button>' +
            '<button class="nb-btn" data-folder-down="' + escapeHtml(folder.id) + '">↓</button>' +
            '<button class="nb-btn danger" data-folder-delete="' + escapeHtml(folder.id) + '">🗑</button>' +
          '</div>' +
        '</article>';
      }).join('');
      foldersRoot.querySelectorAll('[data-folder-open]').forEach(function(btn) { btn.onclick = function() { currentFolderId = btn.dataset.folderOpen; renderNotebookList(); }; });
      foldersRoot.querySelectorAll('[data-folder-newnb]').forEach(function(btn) { btn.onclick = function() { createNotebookInFolder(btn.dataset.folderNewnb); }; });
      foldersRoot.querySelectorAll('[data-folder-sub]').forEach(function(btn) { btn.onclick = function() { createFolder(btn.dataset.folderSub); }; });
      foldersRoot.querySelectorAll('[data-folder-rename]').forEach(function(btn) { btn.onclick = function() { renameFolder(btn.dataset.folderRename); }; });
      foldersRoot.querySelectorAll('[data-folder-style]').forEach(function(btn) { btn.onclick = function() { editFolderAppearance(btn.dataset.folderStyle); }; });
      foldersRoot.querySelectorAll('[data-folder-up]').forEach(function(btn) { btn.onclick = function() { moveFolder(btn.dataset.folderUp, -1); }; });
      foldersRoot.querySelectorAll('[data-folder-down]').forEach(function(btn) { btn.onclick = function() { moveFolder(btn.dataset.folderDown, 1); }; });
      foldersRoot.querySelectorAll('[data-folder-delete]').forEach(function(btn) { btn.onclick = function() { deleteFolder(btn.dataset.folderDelete); }; });
    }

    let items = store.order.map(function(id) { return store.notebooks[id]; }).filter(Boolean);

    // Current folder filter.
    if (currentFolderId === '__root__') {
      items = items.filter(function(nb) { return !nb.folderId; });
    } else if (selectedFolder) {
      items = items.filter(function(nb) { return nb.folderId === selectedFolder.id; });
    }

    // Search by notebook name (also topic name as a useful extra).
    const query = folderSearch.trim().toLocaleLowerCase('es');
    if (query) {
      items = items.filter(function(nb) {
        return String(nb.title || '').toLocaleLowerCase('es').includes(query) ||
          String(nb.topicTitle || '').toLocaleLowerCase('es').includes(query);
      });
    }

    // Topic filter.
    const topicFilter = document.getElementById('nbTopicFilter');
    if (topicFilter) {
      const topics = new Map();
      Object.values(store.notebooks).forEach(function(nb) {
        if (nb && nb.topicId) topics.set(nb.topicId, nb.topicTitle || nb.topicId);
      });
      const topicOptions = [
        '<option value="all">Todas las fichas</option>',
        '<option value="linked">Solo vinculados a ficha</option>',
        '<option value="free">Solo cuadernos libres</option>'
      ];
      Array.from(topics.entries()).sort(function(a,b){ return String(a[1]).localeCompare(String(b[1]), 'es'); }).forEach(function(entry) {
        topicOptions.push('<option value="' + escapeHtml(entry[0]) + '">' + escapeHtml(entry[1]) + '</option>');
      });
      topicFilter.innerHTML = topicOptions.join('');
      if (![...topicFilter.options].some(function(o){ return o.value === libraryTopicFilter; })) libraryTopicFilter = 'all';
      topicFilter.value = libraryTopicFilter;
      topicFilter.onchange = function() {
        libraryTopicFilter = topicFilter.value;
        renderNotebookList();
      };
    }
    if (libraryTopicFilter === 'linked') items = items.filter(function(nb) { return !!nb.topicId; });
    else if (libraryTopicFilter === 'free') items = items.filter(function(nb) { return !nb.topicId; });
    else if (libraryTopicFilter !== 'all') items = items.filter(function(nb) { return nb.topicId === libraryTopicFilter; });

    // Exact creation date filter.
    const dateFilter = document.getElementById('nbDateFilter');
    if (dateFilter) {
      dateFilter.value = libraryDateFilter;
      dateFilter.onchange = function() {
        libraryDateFilter = dateFilter.value || '';
        renderNotebookList();
      };
    }
    if (libraryDateFilter) {
      items = items.filter(function(nb) {
        const d = notebookCreatedDate(nb);
        if (!d.getTime()) return false;
        const localDate = [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0')
        ].join('-');
        return localDate === libraryDateFilter;
      });
    }

    // Sort.
    const sortSelect = document.getElementById('nbSort');
    if (sortSelect) {
      sortSelect.value = librarySort;
      sortSelect.onchange = function() {
        librarySort = sortSelect.value || 'recent';
        renderNotebookList();
      };
    }
    if (librarySort === 'old') {
      items.sort(function(a,b){ return notebookCreatedDate(a) - notebookCreatedDate(b); });
    } else if (librarySort === 'az') {
      items.sort(function(a,b){ return String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' }); });
    } else {
      items.sort(function(a,b){ return notebookUpdatedDate(b) - notebookUpdatedDate(a); });
    }

    // View mode.
    root.classList.toggle('list', libraryViewMode === 'list');
    const gridBtn = document.getElementById('nbGridView');
    const listBtn = document.getElementById('nbListView');
    if (gridBtn) {
      gridBtn.classList.toggle('active', libraryViewMode === 'grid');
      gridBtn.onclick = function() {
        libraryViewMode = 'grid';
        INFO1_LOCAL.setItem('info1-notebook-library-view-v1', 'grid');
        renderNotebookList();
      };
    }
    if (listBtn) {
      listBtn.classList.toggle('active', libraryViewMode === 'list');
      listBtn.onclick = function() {
        libraryViewMode = 'list';
        INFO1_LOCAL.setItem('info1-notebook-library-view-v1', 'list');
        renderNotebookList();
      };
    }

    if (titleRoot) {
      titleRoot.textContent = selectedFolder
        ? (selectedFolder.icon || '📁') + ' ' + selectedFolder.name + ' · Cuadernos'
        : (currentFolderId === '__root__' ? '🗒️ Cuadernos sin carpeta' : '📓 Todos los cuadernos');
    }

    if (!items.length) {
      root.innerHTML = '<div class="empty">No encontré cuadernos con los filtros actuales.</div>';
      bindFolderDropTargets();
      return;
    }

    const folderOptions = ['<option value="">Sin carpeta</option>'].concat(
      store.folderOrder.map(function(id) {
        const folder = store.folders[id];
        if (!folder) return '';
        const depth = Math.max(0, folderPath(folder.id).length - 1);
        return '<option value="' + escapeHtml(folder.id) + '">' + escapeHtml('—'.repeat(depth) + (depth ? ' ' : '') + (folder.icon || '📁') + ' ' + folder.name) + '</option>';
      }).filter(Boolean)
    ).join('');

    root.innerHTML = items.map(function(nb) {
      const pageCount = Array.isArray(nb.pages) ? nb.pages.length : 0;
      const strokeCount = (nb.pages || []).reduce(function(n, p) { return n + ((p.strokes || []).length); }, 0);
      const folder = nb.folderId ? store.folders[nb.folderId] : null;
      const linkedLabel = nb.topicId ? ('📚 ' + escapeHtml(nb.topicTitle || 'Vinculado a ficha')) : '🗒️ Cuaderno libre';
      const dateText = dateLabel(nb.createdAt);
      return '<article class="nb-card" draggable="true" data-nb-card="' + escapeHtml(nb.id) + '">' +
        '<div class="nb-cover" data-nb-open="' + escapeHtml(nb.id) + '" title="Abrir ' + escapeHtml(nb.title) + '">' +
          '<canvas data-nb-preview="' + escapeHtml(nb.id) + '" aria-label="Vista previa de la primera hoja"></canvas>' +
          '<button class="nb-favorite ' + (nb.favorite ? '' : 'off') + '" data-nb-favorite="' + escapeHtml(nb.id) + '" type="button" title="' + (nb.favorite ? 'Quitar de favoritos' : 'Marcar como favorito') + '">' + (nb.favorite ? '★' : '☆') + '</button>' +
          '<span class="nb-cover-badge">' + pageCount + ' hoja' + (pageCount === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="nb-card-info">' +
          '<h3>' + escapeHtml(nb.title) + '</h3>' +
          '<div class="meta">📅 ' + escapeHtml(dateText) + '</div>' +
          '<div class="meta">' + (folder ? escapeHtml((folder.icon || '📁') + ' ' + folder.name) : '📂 Sin carpeta') + '</div>' +
          '<div class="meta">' + linkedLabel + '</div>' +
          '<div class="meta">' + strokeCount + ' trazos · actualizado ' + escapeHtml(dateLabel(nb.updatedAt || nb.createdAt)) + '</div>' +
        '</div>' +
        '<div class="row">' +
          '<button class="nb-btn primary" data-nb-open="' + escapeHtml(nb.id) + '">Abrir</button>' +
          '<button class="nb-btn" data-nb-duplicate="' + escapeHtml(nb.id) + '">⧉ Duplicar</button>' +
          '<button class="nb-btn" data-nb-link="' + escapeHtml(nb.id) + '">🔗</button>' +
          '<select class="nb-move-select" data-nb-folder="' + escapeHtml(nb.id) + '" aria-label="Mover cuaderno de carpeta">' + folderOptions + '</select>' +
          '<button class="nb-btn danger" data-nb-delete="' + escapeHtml(nb.id) + '">🗑</button>' +
        '</div>' +
      '</article>';
    }).join('');

    root.querySelectorAll('[data-nb-preview]').forEach(function(preview) {
      renderNotebookPreview(preview, getNotebook(preview.dataset.nbPreview));
    });
    root.querySelectorAll('[data-nb-open]').forEach(function(btn) {
      btn.onclick = function(e) {
        if (e.target && e.target.closest && e.target.closest('[data-nb-favorite]')) return;
        const nb = getNotebook(btn.dataset.nbOpen);
        if (nb) openNotebook(nb.id, nb.pages && nb.pages[0] ? nb.pages[0].id : null, false, true);
      };
    });
    root.querySelectorAll('[data-nb-favorite]').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        toggleNotebookFavorite(btn.dataset.nbFavorite);
      };
    });
    root.querySelectorAll('[data-nb-duplicate]').forEach(function(btn) {
      btn.onclick = function() { duplicateNotebook(btn.dataset.nbDuplicate); };
    });
    root.querySelectorAll('[data-nb-link]').forEach(function(btn) {
      btn.onclick = function() {
        const nb = getNotebook(btn.dataset.nbLink);
        if (!nb) return;
        currentNotebookId = nb.id;
        currentPageId = nb.pages && nb.pages[0] ? nb.pages[0].id : null;
        copyLink();
      };
    });
    root.querySelectorAll('[data-nb-folder]').forEach(function(select) {
      const nb = getNotebook(select.dataset.nbFolder);
      select.value = nb && nb.folderId ? nb.folderId : '';
      select.onchange = function() { setNotebookFolder(select.dataset.nbFolder, select.value || null); };
    });
    root.querySelectorAll('[data-nb-delete]').forEach(function(btn) {
      btn.onclick = function() { deleteNotebook(btn.dataset.nbDelete); };
    });

    // Native drag (desktop) + long-press pointer drag (touch/iPad).
    root.querySelectorAll('[data-nb-card]').forEach(function(card) {
      const nb = getNotebook(card.dataset.nbCard);
      card.ondragstart = function(e) {
        if (!e.dataTransfer || !nb) return;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/info1-notebook', nb.id);
      };
      card.ondragend = function() {
        card.classList.remove('dragging');
        clearDragTargets();
      };
      card.onpointerdown = function(e) {
        if (!nb || (e.target && e.target.closest && e.target.closest('button,select,input'))) return;
        if (e.pointerType === 'mouse') return;
        startTouchNotebookDrag(card, nb, e);
      };
    });
    bindFolderDropTargets();
  }

  function openNotebook(id, pageId, remoteReadOnly, announce) {
    if (currentNotebookId !== id) pageSelection.clear();
    const nb = getNotebook(id);
    if (!nb) {
      broadcast('snapshot-request', { notebookId: id });
      flashStatus('Esperando el cuaderno desde la otra pantalla…');
      return;
    }
    currentNotebookId = id;
    const page = getPage(nb, pageId);
    currentPageId = page ? page.id : null;
    readOnly = !!remoteReadOnly || followMode;
    INFO1_LOCAL.setItem(OPEN_KEY, JSON.stringify({ notebookId: id, pageId: currentPageId }));
    openNotebookView();
    const list = document.getElementById('nbListPanel');
    const editor = document.getElementById('nbEditorPanel');
    if (list) list.classList.add('hidden');
    if (editor) editor.classList.remove('hidden');
    renderEditor();
    if (announce !== false) sendFocus();
  }

  function renderEditor() {
    const root = document.getElementById('nbEditorPanel');
    const nb = getNotebook(currentNotebookId);
    if (!root || !nb) return;
    const page = getPage(nb, currentPageId);
    if (page) currentPageId = page.id;

    root.innerHTML =
      '<div class="nb-editor-top">' +
        '<button id="nbBack" class="nb-btn" type="button">← Todos los cuadernos</button>' +
        '<div class="nb-title-wrap"><h2>' + escapeHtml(nb.title) + '</h2><div class="nb-live ' + (channelReady ? 'ok' : 'warn') + '">' + (channelReady ? '● Tiempo real conectado' : '● Modo local / conectando') + (readOnly ? ' · Solo lectura' : ' · Editando') + '</div><div class="nb-live">' + (nb.folderId && folderById(nb.folderId) ? escapeHtml((folderById(nb.folderId).icon || '📁') + ' ' + folderById(nb.folderId).name) : '🗒️ Sin carpeta') + '</div></div>' +
        '<div class="nb-actions">' +
          '<button id="nbRename" class="nb-btn" type="button">✏️ Nombre</button>' +
          (nb.topicId ? '<button id="nbAnother" class="nb-btn" type="button">＋ Otro de esta ficha</button>' : '') +
          '<button id="nbCopyLink" class="nb-btn" type="button">🔗 Copiar link</button>' +
        '</div>' +
      '</div>' +
      '<div id="nbPages" class="nb-pages"></div>' +
      '<div class="nb-page-manager">' +
        '<div class="nb-page-manager-head">' +
          '<strong>▦ Hojas del cuaderno</strong>' +
          '<span id="nbSelectedCount" class="nb-selected-count">0 seleccionadas</span>' +
          '<button id="nbSelectAllPages" class="nb-btn" type="button">Seleccionar todas</button>' +
          '<select id="nbPageTargetNotebook" aria-label="Cuaderno destino"></select>' +
          '<button id="nbCopyPages" class="nb-btn" type="button">Copiar a…</button>' +
          '<button id="nbMovePages" class="nb-btn" type="button">Mover a…</button>' +
          '<button id="nbDeletePages" class="nb-btn danger" type="button">Borrar seleccionadas</button>' +
          '<button id="nbInsertFirstPage" class="nb-btn" type="button">＋ Hoja al inicio</button>' +
        '</div>' +
        '<div id="nbPageThumbs" class="nb-page-thumbs"></div>' +
      '</div>' +
      '<div class="nb-toolbar">' +
        '<button id="nbPen" class="active" type="button">✏️ Lápiz</button>' +
        '<select id="nbBrush" aria-label="Tipo de lápiz">' +
          '<option value="ballpoint">Bolígrafo</option>' +
          '<option value="fountain">Pluma</option>' +
          '<option value="pencil">Lápiz grafito</option>' +
        '</select>' +
        '<button id="nbHighlighter" type="button">🖍️ Resaltador</button>' +
        '<button id="nbLine" type="button">📏 Línea</button>' +
        '<select id="nbShape" aria-label="Forma geométrica">' +
          '<option value="">⬡ Formas</option>' +
          '<option value="circle">◯ Círculo</option>' +
          '<option value="rectangle">▭ Rectángulo</option>' +
          '<option value="triangle">△ Triángulo</option>' +
        '</select>' +
        '<button id="nbEraser" type="button">🧽 Borrador</button>' +
        '<select id="nbEraserMode" aria-label="Modo del borrador">' +
          '<option value="pixel">Borrar parte</option>' +
          '<option value="stroke">Borrar trazo completo</option>' +
        '</select>' +
        '<input id="nbColor" type="color" value="#16264a" aria-label="Color">' +
        '<label class="small">Grosor <input id="nbWidth" type="range" min="1" max="18" value="4"></label>' +
        '<button id="nbUndo" type="button">↶ Deshacer</button>' +
        '<button id="nbRedo" type="button">↷ Rehacer</button>' +
        '<button id="nbZoomOut" type="button" title="Alejar">−</button>' +
        '<button id="nbZoomLabel" type="button" title="Restablecer zoom">100%</button>' +
        '<button id="nbZoomIn" type="button" title="Acercar">＋</button>' +
        '<button id="nbFingerMode" type="button">☝️ Dedo mueve</button>' +
        '<span id="nbInputStatus" class="nb-input-status" title="Entrada detectada">⌁ Touch / mouse</span>' +
        '<button id="nbPasteImage" type="button">📋 Pegar foto</button>' +
        '<button id="nbPhotoLibrary" type="button">🖼️ Fototeca/archivo</button>' +
        '<button id="nbCameraImage" type="button">📷 Cámara</button>' +
        '<input id="nbImageFiles" class="nb-file-hidden" type="file" accept="image/*" multiple>' +
        '<input id="nbCameraFile" class="nb-file-hidden" type="file" accept="image/*" capture="environment">' +
        '<button id="nbClear" type="button">Limpiar página</button>' +
        '<button id="nbAddPage" type="button">＋ Página</button>' +
        '<button id="nbDeletePage" type="button">🗑 Página</button>' +
        '<button id="nbMode" type="button">' + (readOnly ? '🔒 Solo lectura' : '✍️ Editar') + '</button>' +
      '</div>' +
      '<div id="nbImageTools" class="nb-image-tools">' +
        '<span id="nbImageLabel" class="label">🖼️ Imagen</span>' +
        '<button id="nbImageCrop" class="nb-btn" type="button">✂️ Recortar</button>' +
        '<button id="nbImageDuplicate" class="nb-btn" type="button">⧉ Duplicar</button>' +
        '<button id="nbImageLock" class="nb-btn" type="button">🔓 Bloquear</button>' +
        '<button id="nbImageFront" class="nb-btn" type="button">⬆️ Al frente</button>' +
        '<button id="nbImageBack" class="nb-btn" type="button">⬇️ Atrás</button>' +
        '<button id="nbImageBackground" class="nb-btn" type="button">🖼️ Fondo</button>' +
        '<button id="nbImageDelete" class="nb-btn danger" type="button">🗑 Eliminar</button>' +
      '</div>' +
      '<div id="nbCanvasScroller" class="nb-canvas-wrap">' +
        '<div class="nb-canvas-hint">Pencil escribe · dedo mueve · pellizcá para zoom</div>' +
        '<div id="nbCanvasStage" class="nb-canvas-stage">' +
          '<div id="nbImageBackgroundLayer" class="nb-image-bg-layer"></div>' +
          '<canvas id="info1NotebookCanvas"></canvas>' +
          '<div id="nbImageLayer" class="nb-image-layer"></div>' +
        '</div>' +
        (readOnly ? '<div class="nb-readonly-banner">👀 Solo lectura · viendo en vivo</div>' : '') +
      '</div>' +
      '<div id="nbBottomPager" class="nb-bottom-pager" aria-label="Navegación de hojas">' +
        '<button id="nbPrevPage" type="button" aria-label="Hoja anterior">‹</button>' +
        '<div id="nbBottomCount" class="nb-bottom-count">1 / 1</div>' +
        '<button id="nbNextPage" type="button" aria-label="Hoja siguiente">›</button>' +
      '</div>';

    document.getElementById('nbBack').onclick = showList;
    document.getElementById('nbRename').onclick = renameNotebook;
    const another = document.getElementById('nbAnother');
    if (another) another.onclick = createAnotherForCurrentTopic;
    document.getElementById('nbCopyLink').onclick = copyLink;
    document.getElementById('nbAddPage').onclick = addPage;
    document.getElementById('nbDeletePage').onclick = deleteCurrentPage;
    document.getElementById('nbUndo').onclick = undo;
    document.getElementById('nbRedo').onclick = redo;
    document.getElementById('nbClear').onclick = clearPage;
    installImageInputs();
    document.getElementById('nbImageCrop').onclick = function(){ if (selectedImageId) cropImage(selectedImageId); };
    document.getElementById('nbImageDuplicate').onclick = function(){ if (selectedImageId) duplicateImage(selectedImageId); };
    document.getElementById('nbImageLock').onclick = function(){ if (selectedImageId) toggleImageLock(selectedImageId); };
    document.getElementById('nbImageFront').onclick = function(){ if (selectedImageId) imageLayerChange(selectedImageId,1); };
    document.getElementById('nbImageBack').onclick = function(){ if (selectedImageId) imageLayerChange(selectedImageId,-1); };
    document.getElementById('nbImageBackground').onclick = function(){ if (selectedImageId) toggleImageBackground(selectedImageId); };
    document.getElementById('nbImageDelete').onclick = function(){ if (selectedImageId) deleteImage(selectedImageId); };
    document.getElementById('nbMode').onclick = function() {
      if (followMode) {
        followMode = false;
        INFO1_LOCAL.setItem(FOLLOW_KEY, '0');
      }
      readOnly = !readOnly;
      renderEditor();
      updateFollowButton();
      sendFocus();
    };

    const selectAllPages = document.getElementById('nbSelectAllPages');
    if (selectAllPages) selectAllPages.onclick = function() {
      if (readOnly) return;
      const all = (nb.pages || []).map(function(p) { return p.id; });
      const allSelected = all.length && all.every(function(id) { return pageSelection.has(id); });
      pageSelection.clear();
      if (!allSelected) all.forEach(function(id) { pageSelection.add(id); });
      renderPageManager();
    };
    const insertFirst = document.getElementById('nbInsertFirstPage');
    if (insertFirst) {
      insertFirst.disabled = readOnly;
      insertFirst.onclick = function() {
        if (readOnly) return;
        const p = blankPage('Página ' + ((nb.pages || []).length + 1));
        if (!Array.isArray(nb.pages)) nb.pages = [];
        nb.pages.unshift(p);
        currentPageId = p.id;
        pageSelection.clear();
        syncNotebookPages(nb, { currentPageId: p.id });
        sendFocus();
      };
    }
    const copyPages = document.getElementById('nbCopyPages');
    const movePages = document.getElementById('nbMovePages');
    const deletePages = document.getElementById('nbDeletePages');
    if (copyPages) {
      copyPages.disabled = readOnly;
      copyPages.onclick = function() {
        const target = document.getElementById('nbPageTargetNotebook');
        if (!target || !target.value) return flashStatus('Elegí un cuaderno destino');
        transferSelectedPages(target.value, 'copy');
      };
    }
    if (movePages) {
      movePages.disabled = readOnly;
      movePages.onclick = function() {
        const target = document.getElementById('nbPageTargetNotebook');
        if (!target || !target.value) return flashStatus('Elegí un cuaderno destino');
        transferSelectedPages(target.value, 'move');
      };
    }
    if (deletePages) {
      deletePages.disabled = readOnly;
      deletePages.onclick = deleteSelectedPages;
    }

    let tool = 'pen';
    let shapeType = '';
    const pen = document.getElementById('nbPen');
    const highlighter = document.getElementById('nbHighlighter');
    const lineBtn = document.getElementById('nbLine');
    const shapeSelect = document.getElementById('nbShape');
    const eraser = document.getElementById('nbEraser');
    const brushSelect = document.getElementById('nbBrush');
    const eraserModeSelect = document.getElementById('nbEraserMode');
    const fingerModeBtn = document.getElementById('nbFingerMode');

    if (brushSelect) {
      brushSelect.value = ['ballpoint','fountain','pencil'].includes(currentBrush) ? currentBrush : 'ballpoint';
      brushSelect.onchange = function() {
        currentBrush = brushSelect.value;
        INFO1_LOCAL.setItem(BRUSH_KEY, currentBrush);
        selectTool('pen');
      };
    }
    if (eraserModeSelect) {
      eraserModeSelect.value = eraserMode;
      eraserModeSelect.onchange = function() {
        eraserMode = eraserModeSelect.value === 'stroke' ? 'stroke' : 'pixel';
        INFO1_LOCAL.setItem(ERASER_MODE_KEY, eraserMode);
        selectTool('eraser');
        flashStatus(eraserMode === 'stroke' ? '🧽 Borrador por trazos' : '🧽 Borrador libre');
      };
    }

    function updateFingerButton() {
      if (!fingerModeBtn) return;
      fingerModeBtn.classList.toggle('active', fingerPanMode);
      fingerModeBtn.textContent = fingerPanMode ? '☝️ Dedo mueve' : '☝️ Dedo dibuja';
    }
    updateFingerButton();
    if (fingerModeBtn) fingerModeBtn.onclick = function() {
      fingerPanMode = !fingerPanMode;
      INFO1_LOCAL.setItem(PENCIL_MODE_KEY, fingerPanMode ? 'pan' : 'draw');
      updateFingerButton();
      flashStatus(fingerPanMode ? '☝️ Dedo mueve · Pencil escribe' : '✍️ Dedo también dibuja');
    };

    function selectTool(next, shape) {
      tool = next;
      shapeType = shape || '';
      pen.classList.toggle('active', next === 'pen');
      highlighter && highlighter.classList.toggle('active', next === 'highlighter');
      lineBtn && lineBtn.classList.toggle('active', next === 'line');
      eraser.classList.toggle('active', next === 'eraser');
      if (shapeSelect) {
        shapeSelect.classList.toggle('active', next === 'shape');
        if (next !== 'shape') shapeSelect.value = '';
      }
      if (eraserModeSelect) eraserModeSelect.classList.toggle('active', next === 'eraser');
    }

    pen.onclick = function() { selectTool('pen'); };
    if (highlighter) highlighter.onclick = function() { selectTool('highlighter'); };
    if (lineBtn) lineBtn.onclick = function() { selectTool('line'); };
    if (shapeSelect) shapeSelect.onchange = function() {
      if (shapeSelect.value) selectTool('shape', shapeSelect.value);
    };
    eraser.onclick = function() { selectTool('eraser'); };

    const zoomLabel = document.getElementById('nbZoomLabel');
    function setZoom(next, anchor) {
      const pageNow = getPage(nb, currentPageId);
      if (!pageNow) return;
      setPageZoom(pageNow, next, anchor);
      if (zoomLabel) zoomLabel.textContent = Math.round(pageNow.zoom * 100) + '%';
    }
    const zoomOut = document.getElementById('nbZoomOut');
    const zoomIn = document.getElementById('nbZoomIn');
    if (zoomOut) zoomOut.onclick = function() { const p = getPage(nb,currentPageId); setZoom((p.zoom || 1) / 1.2); };
    if (zoomIn) zoomIn.onclick = function() { const p = getPage(nb,currentPageId); setZoom((p.zoom || 1) * 1.2); };
    if (zoomLabel) {
      const p = getPage(nb,currentPageId);
      zoomLabel.textContent = Math.round((p.zoom || 1) * 100) + '%';
      zoomLabel.title = 'Zoom ' + Math.round((p.zoom || 1) * 100) + '% · tocar para 100%';
      zoomLabel.onclick = function() { setZoom(1); };
    }

    renderPages();
    setupCanvas(
      function() { return tool; },
      function() { return eraserMode; },
      function() { return shapeType; },
      function() { return currentBrush; }
    );
    renderImageLayer();

    // Si ya estaba en pantalla completa durante esta sesión, conservarla.
    // No restauramos un estado viejo de localStorage al abrir en iPad.
    requestAnimationFrame(function() {
      const notebookUi=window.INFO1_NOTEBOOK_INTERFACE;
      if (notebookUi && notebookUi.fullscreen && typeof notebookUi.repairFullscreen==='function') {
        notebookUi.repairFullscreen();
      }
    });
  }

  function setCurrentPage(pageId) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || !Array.isArray(nb.pages) || !nb.pages.length) return;
    const next = nb.pages.find(function(p) { return p.id === pageId; });
    if (!next) return;
    currentPageId = next.id;
    selectedImageId = null;
    INFO1_LOCAL.setItem(OPEN_KEY, JSON.stringify({ notebookId: nb.id, pageId: currentPageId }));
    applyCanvasGeometry(next);
    restorePageViewport(next);
    renderPages();
    redraw();
    sendFocus();
  }

  function movePage(direction) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || !Array.isArray(nb.pages) || !nb.pages.length) return;
    let index = nb.pages.findIndex(function(p) { return p.id === currentPageId; });
    if (index < 0) index = 0;
    const nextIndex = Math.max(0, Math.min(nb.pages.length - 1, index + direction));
    if (nextIndex === index) return;
    setCurrentPage(nb.pages[nextIndex].id);
  }

  function updateBottomPager() {
    const nb = getNotebook(currentNotebookId);
    const count = document.getElementById('nbBottomCount');
    const prev = document.getElementById('nbPrevPage');
    const next = document.getElementById('nbNextPage');
    if (!nb || !Array.isArray(nb.pages) || !nb.pages.length || !count || !prev || !next) return;
    let index = nb.pages.findIndex(function(p) { return p.id === currentPageId; });
    if (index < 0) index = 0;
    count.textContent = (index + 1) + ' / ' + nb.pages.length;
    prev.disabled = index <= 0;
    next.disabled = index >= nb.pages.length - 1;
    prev.onclick = function() { movePage(-1); };
    next.onclick = function() { movePage(1); };
  }

  function renderPageManager() {
    const root = document.getElementById('nbPageThumbs');
    const nb = getNotebook(currentNotebookId);
    if (!root || !nb) return;

    // Remove stale selections.
    pageSelection.forEach(function(id) {
      if (!(nb.pages || []).some(function(p) { return p.id === id; })) pageSelection.delete(id);
    });

    const target = document.getElementById('nbPageTargetNotebook');
    if (target) {
      const store = ensureStore();
      const opts = ['<option value="">Cuaderno destino…</option>'];
      store.order.forEach(function(id) {
        const other = store.notebooks[id];
        if (!other || other.id === nb.id) return;
        opts.push('<option value="' + escapeHtml(other.id) + '">' + escapeHtml(other.title) + '</option>');
      });
      const previous = target.value;
      target.innerHTML = opts.join('');
      if ([...target.options].some(function(o) { return o.value === previous; })) target.value = previous;
    }

    const count = document.getElementById('nbSelectedCount');
    if (count) count.textContent = pageSelection.size + ' seleccionada' + (pageSelection.size === 1 ? '' : 's');

    root.innerHTML = (nb.pages || []).map(function(page, index) {
      return '<article class="nb-page-thumb ' + (page.id === currentPageId ? 'active ' : '') + (pageSelection.has(page.id) ? 'selected' : '') + '" draggable="' + (!readOnly ? 'true' : 'false') + '" data-page-thumb="' + escapeHtml(page.id) + '">' +
        '<label class="nb-page-check" title="Seleccionar hoja"><input type="checkbox" data-page-select="' + escapeHtml(page.id) + '" ' + (pageSelection.has(page.id) ? 'checked' : '') + (readOnly ? ' disabled' : '') + '></label>' +
        '<div class="nb-page-preview" data-page-open-thumb="' + escapeHtml(page.id) + '" title="Abrir ' + escapeHtml(page.title) + '">' +
          '<canvas data-page-preview="' + escapeHtml(page.id) + '"></canvas>' +
        '</div>' +
        '<div class="nb-page-thumb-title">' + (index + 1) + '. ' + escapeHtml(page.title || ('Página ' + (index + 1))) + '</div>' +
        '<div class="nb-page-thumb-actions">' +
          '<button class="nb-btn" type="button" data-page-rename="' + escapeHtml(page.id) + '" ' + (readOnly ? 'disabled' : '') + '>✏️ Nombre</button>' +
          '<button class="nb-btn" type="button" data-page-duplicate="' + escapeHtml(page.id) + '" ' + (readOnly ? 'disabled' : '') + '>⧉ Duplicar</button>' +
          '<button class="nb-btn nb-insert-after" type="button" data-page-insert-after="' + escapeHtml(page.id) + '" ' + (readOnly ? 'disabled' : '') + '>＋ Insertar después</button>' +
        '</div>' +
      '</article>';
    }).join('');

    refreshPageManagerPreviews();

    root.querySelectorAll('[data-page-open-thumb]').forEach(function(el) {
      el.onclick = function() { setCurrentPage(el.dataset.pageOpenThumb); };
    });
    root.querySelectorAll('[data-page-select]').forEach(function(input) {
      input.onchange = function() {
        if (input.checked) pageSelection.add(input.dataset.pageSelect);
        else pageSelection.delete(input.dataset.pageSelect);
        renderPageManager();
      };
    });
    root.querySelectorAll('[data-page-rename]').forEach(function(btn) {
      btn.onclick = function() { renamePage(btn.dataset.pageRename); };
    });
    root.querySelectorAll('[data-page-duplicate]').forEach(function(btn) {
      btn.onclick = function() { duplicatePage(btn.dataset.pageDuplicate); };
    });
    root.querySelectorAll('[data-page-insert-after]').forEach(function(btn) {
      btn.onclick = function() { insertPageAfter(btn.dataset.pageInsertAfter); };
    });

    root.querySelectorAll('[data-page-thumb]').forEach(function(card) {
      const pageId = card.dataset.pageThumb;
      card.ondragstart = function(e) {
        if (readOnly || !e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/info1-page', pageId);
        card.classList.add('dragging');
      };
      card.ondragend = function() {
        card.classList.remove('dragging');
        root.querySelectorAll('.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
      };
      card.ondragover = function(e) {
        if (readOnly || !e.dataTransfer) return;
        e.preventDefault();
        root.querySelectorAll('.drop-target').forEach(function(el) { el.classList.remove('drop-target'); });
        card.classList.add('drop-target');
      };
      card.ondrop = function(e) {
        if (readOnly || !e.dataTransfer) return;
        e.preventDefault();
        const sourceId = e.dataTransfer.getData('text/info1-page');
        card.classList.remove('drop-target');
        if (sourceId) reorderPage(sourceId, pageId);
      };
      card.onpointerdown = function(e) {
        if (readOnly || (e.target && e.target.closest && e.target.closest('button,input,label'))) return;
        if (e.pointerType === 'mouse') return;
        startTouchPageReorder(card, pageId, e);
      };
    });
  }

  function renderPages() {
    const root = document.getElementById('nbPages');
    const nb = getNotebook(currentNotebookId);
    if (!root || !nb) return;
    root.innerHTML = (nb.pages || []).map(function(p) {
      return '<button class="nb-page-tab ' + (p.id === currentPageId ? 'active' : '') + '" data-page="' + escapeHtml(p.id) + '">' + escapeHtml(p.title) + '</button>';
    }).join('');
    root.querySelectorAll('[data-page]').forEach(function(btn) {
      btn.onclick = function() {
        setCurrentPage(btn.dataset.page);
      };
    });
    updateBottomPager();
    renderPageManager();
  }

  function mediaAsset(assetId) {
    return assetId ? ensureStore().mediaAssets[assetId] || null : null;
  }

  function pageImageById(page, id) {
    if (!page || !Array.isArray(page.images)) return null;
    return page.images.find(function(image) { return image.id === id; }) || null;
  }

  function nextImageZ(page) {
    return 10 + (page && page.images ? page.images.reduce(function(max, image) {
      return Math.max(max, Number(image.z) || 0);
    }, 0) : 0);
  }

  function cleanUnusedMediaAssets() {
    const store = ensureStore();
    const used = new Set();
    Object.values(store.notebooks).forEach(function(nb) {
      (nb.pages || []).forEach(function(page) {
        (page.images || []).forEach(function(image) { if (image.assetId) used.add(image.assetId); });
      });
    });
    Object.keys(store.mediaAssets).forEach(function(id) {
      if (!used.has(id)) delete store.mediaAssets[id];
    });
  }

  function commitImageChange(page, message) {
    const nb = getNotebook(currentNotebookId);
    if (!nb || !page) return;
    normalizePage(page);
    nb.updatedAt = new Date().toISOString();
    cleanUnusedMediaAssets();
    persist();
    if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.syncImages) {
      window.INFO1_NOTEBOOK_RESILIENCE.syncImages(nb.id, page.id, page.images || [], ensureStore().mediaAssets || {});
    }
    renderImageLayer();
    refreshPageManagerPreviews();
    renderNotebookList();
    if (message) flashStatus(message);
  }

  function imageLogicalPosition(clientX, clientY) {
    const stage = document.getElementById('nbCanvasStage');
    if (!stage) return {x:120,y:120};
    const r = stage.getBoundingClientRect();
    const scale = Math.max(0.001, r.width / LOGICAL_WIDTH);
    return {
      x: clamp((clientX - r.left) / scale, 0, LOGICAL_WIDTH),
      y: Math.max(0, (clientY - r.top) / scale)
    };
  }

  function defaultImagePosition(page) {
    const scroller = document.getElementById('nbCanvasScroller');
    const scale = currentCanvasScale();
    return {
      x: Math.max(40, ((scroller ? scroller.scrollLeft : 0) / Math.max(0.001, scale)) + 100),
      y: Math.max(40, ((scroller ? scroller.scrollTop : 0) / Math.max(0.001, scale)) + 100)
    };
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise(function(resolve, reject) {
      const image = new Image();
      image.onload = function() { resolve(image); };
      image.onerror = function() { reject(new Error('No se pudo abrir la imagen')); };
      image.src = dataUrl;
    });
  }

  function fileToDataUrl(file) {
    return new Promise(function(resolve, reject) {
      const reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(reader.error || new Error('No se pudo leer la imagen')); };
      reader.readAsDataURL(file);
    });
  }

  async function compressImageFile(file) {
    if (!file || !String(file.type || '').startsWith('image/')) throw new Error('El archivo no es una imagen');
    const raw = await fileToDataUrl(file);
    const source = await loadImageFromDataUrl(raw);
    let maxSide = 1600;
    let quality = 0.84;
    let result = raw;
    let outW = source.naturalWidth || source.width || 1200;
    let outH = source.naturalHeight || source.height || 900;

    for (let attempt = 0; attempt < 3; attempt++) {
      const ratio = Math.min(1, maxSide / Math.max(outW, outH));
      const w = Math.max(1, Math.round(outW * ratio));
      const h = Math.max(1, Math.round(outH * ratio));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const c2 = cv.getContext('2d');
      c2.fillStyle = '#fff';
      c2.fillRect(0,0,w,h);
      c2.drawImage(source,0,0,w,h);
      result = cv.toDataURL('image/webp', quality);
      if (!result.startsWith('data:image/webp')) result = cv.toDataURL('image/jpeg', quality);
      outW = w;
      outH = h;
      if (result.length < 850000) break;
      maxSide = Math.max(900, Math.round(maxSide * 0.78));
      quality = Math.max(0.68, quality - 0.08);
    }
    return {
      dataUrl: result,
      width: outW,
      height: outH,
      name: file.name || 'imagen',
      type: result.slice(5, result.indexOf(';')) || file.type || 'image/webp'
    };
  }

  async function addImageData(data, position) {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!nb || !page || readOnly || !data || !data.dataUrl) return null;
    const store = ensureStore();
    const assetId = uuid();
    store.mediaAssets[assetId] = {
      id: assetId,
      dataUrl: data.dataUrl,
      width: Number(data.width) || 800,
      height: Number(data.height) || 600,
      name: data.name || 'imagen',
      type: data.type || 'image/webp',
      createdAt: new Date().toISOString()
    };
    const aspect = Math.max(0.05, store.mediaAssets[assetId].width / Math.max(1, store.mediaAssets[assetId].height));
    const pos = position || defaultImagePosition(page);
    const w = Math.min(420, LOGICAL_WIDTH * 0.55);
    const h = clamp(w / aspect, 80, 620);
    const image = {
      id: uuid(),
      assetId: assetId,
      x: clamp(pos.x - w / 2, 0, Math.max(0, LOGICAL_WIDTH - w)),
      y: Math.max(0, pos.y - h / 2),
      w: w,
      h: h,
      rotation: 0,
      z: nextImageZ(page),
      locked: false,
      background: false,
      crop: {top:0,right:0,bottom:0,left:0}
    };
    page.images.push(image);
    selectedImageId = image.id;
    maybeGrowPage(page, image.y + image.h + 100);
    commitImageChange(page, '🖼️ Imagen agregada');
    return image;
  }

  async function addImageFiles(files, position) {
    const list = Array.from(files || []).filter(function(file) { return String(file.type || '').startsWith('image/'); });
    for (const file of list) {
      try {
        const data = await compressImageFile(file);
        await addImageData(data, position);
      } catch (error) {
        console.warn('INFO1 imagen', error);
        flashStatus('No se pudo insertar una imagen');
      }
    }
  }

  async function pasteImageFromClipboard() {
    if (readOnly) return;
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find(function(t) { return t.startsWith('image/'); });
          if (!type) continue;
          const blob = await item.getType(type);
          const file = new File([blob], 'pegada.' + (type.split('/')[1] || 'png'), {type:type});
          await addImageFiles([file]);
          return;
        }
      }
      flashStatus('Copiá una imagen y usá Ctrl/⌘ + V');
    } catch (_) {
      flashStatus('Usá Ctrl/⌘ + V para pegar la imagen');
    }
  }

  function duplicateImage(imageId) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const source = pageImageById(page, imageId);
    if (!source || readOnly) return;
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = uuid();
    copy.x = clamp(source.x + 35, 0, LOGICAL_WIDTH - Math.min(source.w, LOGICAL_WIDTH));
    copy.y = source.y + 35;
    copy.z = nextImageZ(page);
    copy.background = false;
    copy.locked = false;
    page.images.push(copy);
    selectedImageId = copy.id;
    commitImageChange(page, '⧉ Imagen duplicada');
  }

  function deleteImage(imageId) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    if (!page || readOnly) return;
    page.images = page.images.filter(function(image) { return image.id !== imageId; });
    if (selectedImageId === imageId) selectedImageId = null;
    commitImageChange(page, '🗑 Imagen eliminada');
  }

  function cropImage(imageId) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const image = pageImageById(page, imageId);
    if (!image || readOnly || image.locked) return;
    const crop = image.crop || {left:0,top:0,right:0,bottom:0};
    const raw = prompt(
      'Recorte en porcentajes: izquierda, arriba, derecha, abajo (0–45).\nEjemplo: 10,0,10,0',
      [crop.left,crop.top,crop.right,crop.bottom].join(',')
    );
    if (raw === null) return;
    const values = raw.split(',').map(function(v) { return clamp(Number(v.trim()) || 0, 0, 45); });
    if (values.length !== 4) return flashStatus('Usá cuatro valores separados por coma');
    if (values[0] + values[2] >= 90 || values[1] + values[3] >= 90) return flashStatus('El recorte es demasiado grande');
    image.crop = {left:values[0],top:values[1],right:values[2],bottom:values[3]};
    commitImageChange(page, '✂️ Imagen recortada');
  }

  function toggleImageLock(imageId) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const image = pageImageById(page, imageId);
    if (!image || readOnly) return;
    image.locked = !image.locked;
    commitImageChange(page, image.locked ? '🔒 Imagen bloqueada' : '🔓 Imagen desbloqueada');
  }

  function imageLayerChange(imageId, direction) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const image = pageImageById(page, imageId);
    if (!image || readOnly || image.background) return;
    const zs = page.images.filter(function(i){ return !i.background; }).map(function(i){return Number(i.z)||0;});
    image.z = direction > 0 ? Math.max.apply(null,[10].concat(zs)) + 1 : Math.min.apply(null,[10].concat(zs)) - 1;
    commitImageChange(page, direction > 0 ? '⬆️ Imagen al frente' : '⬇️ Imagen hacia atrás');
  }

  function toggleImageBackground(imageId) {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const image = pageImageById(page, imageId);
    const asset = image && mediaAsset(image.assetId);
    if (!image || !asset || readOnly) return;
    if (!image.background) {
      image.normalRect = {x:image.x,y:image.y,w:image.w,h:image.h,rotation:image.rotation,z:image.z,locked:image.locked};
      const aspect = Math.max(0.05, asset.width / Math.max(1,asset.height));
      image.background = true;
      image.locked = true;
      image.x = 0;
      image.y = 0;
      image.w = LOGICAL_WIDTH;
      image.h = Math.min(page.height, Math.max(420, LOGICAL_WIDTH / aspect));
      image.rotation = 0;
      image.z = -100;
    } else {
      const r = image.normalRect || {};
      image.background = false;
      image.locked = !!r.locked;
      image.x = Number.isFinite(r.x) ? r.x : 80;
      image.y = Number.isFinite(r.y) ? r.y : 80;
      image.w = Number.isFinite(r.w) ? r.w : 420;
      image.h = Number.isFinite(r.h) ? r.h : 300;
      image.rotation = Number.isFinite(r.rotation) ? r.rotation : 0;
      image.z = Number.isFinite(r.z) ? r.z : nextImageZ(page);
      delete image.normalRect;
    }
    commitImageChange(page, image.background ? '🖼️ Imagen puesta como fondo' : '🖼️ Imagen quitada del fondo');
  }

  function updateImageTools() {
    const tools = document.getElementById('nbImageTools');
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const image = pageImageById(page, selectedImageId);
    if (!tools) return;
    tools.classList.toggle('active', !!image);
    if (!image) return;
    const asset = mediaAsset(image.assetId);
    const label = document.getElementById('nbImageLabel');
    if (label) label.textContent = '🖼️ ' + ((asset && asset.name) || 'Imagen');
    const lock = document.getElementById('nbImageLock');
    if (lock) lock.textContent = image.locked ? '🔓 Desbloquear' : '🔒 Bloquear';
    const bg = document.getElementById('nbImageBackground');
    if (bg) bg.textContent = image.background ? '↩️ Quitar fondo' : '🖼️ Fondo';
    ['nbImageCrop','nbImageDuplicate','nbImageLock','nbImageFront','nbImageBack','nbImageBackground','nbImageDelete'].forEach(function(id) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = readOnly;
    });
  }

  function applyImageStyle(el, image, scale) {
    el.style.left = (image.x * scale) + 'px';
    el.style.top = (image.y * scale) + 'px';
    el.style.width = (image.w * scale) + 'px';
    el.style.height = (image.h * scale) + 'px';
    el.style.transform = 'rotate(' + (Number(image.rotation)||0) + 'deg)';
    el.style.zIndex = String(Math.max(1, 100 + (Number(image.z)||0)));
    el.classList.toggle('selected', image.id === selectedImageId);
    el.classList.toggle('locked', !!image.locked);
  }

  function startImageMove(e, image, el) {
    if (readOnly || image.locked || image.background) return;
    const collab = window.INFO1_NOTEBOOK_COLLABORATION;
    const collabKey = 'image:' + image.id;
    if (collab && collab.claimObject && !collab.claimObject(collabKey)) return;
    e.stopPropagation();
    e.preventDefault();
    selectedImageId = image.id;
    const scale = currentCanvasScale();
    const start = {x:e.clientX,y:e.clientY,ix:image.x,iy:image.y};
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    imageGesture = {type:'move',id:image.id};
    function move(ev) {
      if (ev.pointerId !== e.pointerId) return;
      if (collab && collab.ownsObject && !collab.ownsObject(collabKey)) return;
      image.x = clamp(start.ix + (ev.clientX-start.x)/Math.max(0.001,scale), 0, Math.max(0,LOGICAL_WIDTH-image.w));
      image.y = Math.max(0, start.iy + (ev.clientY-start.y)/Math.max(0.001,scale));
      applyImageStyle(el,image,scale);
      maybeGrowPage(getPage(getNotebook(currentNotebookId),currentPageId), image.y+image.h+80);
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive) {
        window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive(currentNotebookId, currentPageId, {type:'image', image:JSON.parse(JSON.stringify(image))});
      }
      ev.preventDefault();
    }
    function end(ev) {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove',move);
      el.removeEventListener('pointerup',end);
      el.removeEventListener('pointercancel',end);
      imageGesture = null;
      const stillOwns = !collab || !collab.ownsObject || collab.ownsObject(collabKey);
      if (stillOwns) commitImageChange(getPage(getNotebook(currentNotebookId),currentPageId));
      if (collab && collab.releaseObject) collab.releaseObject(collabKey);
    }
    el.addEventListener('pointermove',move,{passive:false});
    el.addEventListener('pointerup',end);
    el.addEventListener('pointercancel',end);
  }

  function startImageResize(e, image, el) {
    if (readOnly || image.locked || image.background) return;
    const collab = window.INFO1_NOTEBOOK_COLLABORATION;
    const collabKey = 'image:' + image.id;
    if (collab && collab.claimObject && !collab.claimObject(collabKey)) return;
    e.stopPropagation();
    e.preventDefault();
    const scale = currentCanvasScale();
    const start = {x:e.clientX,y:e.clientY,w:image.w,h:image.h};
    const aspect = Math.max(0.05,image.w/Math.max(1,image.h));
    function move(ev) {
      if (ev.pointerId !== e.pointerId) return;
      if (collab && collab.ownsObject && !collab.ownsObject(collabKey)) return;
      const dw = (ev.clientX-start.x)/Math.max(0.001,scale);
      const dh = (ev.clientY-start.y)/Math.max(0.001,scale);
      let w = Math.max(60,start.w + Math.max(dw,dh*aspect));
      w = Math.min(LOGICAL_WIDTH*1.8,w);
      image.w = w;
      image.h = Math.max(50,w/aspect);
      applyImageStyle(el,image,scale);
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive) {
        window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive(currentNotebookId, currentPageId, {type:'image', image:JSON.parse(JSON.stringify(image))});
      }
      ev.preventDefault();
    }
    function end(ev) {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',end,true);
      window.removeEventListener('pointercancel',end,true);
      const stillOwns = !collab || !collab.ownsObject || collab.ownsObject(collabKey);
      if (stillOwns) commitImageChange(getPage(getNotebook(currentNotebookId),currentPageId));
      if (collab && collab.releaseObject) collab.releaseObject(collabKey);
    }
    window.addEventListener('pointermove',move,{capture:true,passive:false});
    window.addEventListener('pointerup',end,true);
    window.addEventListener('pointercancel',end,true);
  }

  function startImageRotate(e, image, el) {
    if (readOnly || image.locked || image.background) return;
    const collab = window.INFO1_NOTEBOOK_COLLABORATION;
    const collabKey = 'image:' + image.id;
    if (collab && collab.claimObject && !collab.claimObject(collabKey)) return;
    e.stopPropagation();
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const cx = r.left+r.width/2, cy=r.top+r.height/2;
    const initialAngle = Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI;
    const base = Number(image.rotation)||0;
    function move(ev) {
      if (ev.pointerId !== e.pointerId) return;
      if (collab && collab.ownsObject && !collab.ownsObject(collabKey)) return;
      const angle = Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;
      image.rotation = base + angle-initialAngle;
      applyImageStyle(el,image,currentCanvasScale());
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive) {
        window.INFO1_NOTEBOOK_RESILIENCE.syncObjectLive(currentNotebookId, currentPageId, {type:'image', image:JSON.parse(JSON.stringify(image))});
      }
      ev.preventDefault();
    }
    function end(ev) {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',end,true);
      window.removeEventListener('pointercancel',end,true);
      const stillOwns = !collab || !collab.ownsObject || collab.ownsObject(collabKey);
      if (stillOwns) commitImageChange(getPage(getNotebook(currentNotebookId),currentPageId));
      if (collab && collab.releaseObject) collab.releaseObject(collabKey);
    }
    window.addEventListener('pointermove',move,{capture:true,passive:false});
    window.addEventListener('pointerup',end,true);
    window.addEventListener('pointercancel',end,true);
  }

  function renderImageLayer() {
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const layer = document.getElementById('nbImageLayer');
    const bgLayer = document.getElementById('nbImageBackgroundLayer');
    const stage = document.getElementById('nbCanvasStage');
    if (!page || !layer || !bgLayer || !stage) return;
    const scale = Math.max(0.001, stage.getBoundingClientRect().width / LOGICAL_WIDTH);
    layer.innerHTML = '';
    bgLayer.innerHTML = '';

    (page.images || []).slice().sort(function(a,b){return (Number(a.z)||0)-(Number(b.z)||0);}).forEach(function(image) {
      const asset = mediaAsset(image.assetId);
      if (!asset || !asset.dataUrl) return;
      const el = document.createElement('div');
      el.className = 'nb-image-object' + (image.background ? ' nb-image-bg' : '');
      el.dataset.imageId = image.id;
      const img = document.createElement('img');
      img.src = asset.dataUrl;
      const crop = image.crop || {top:0,right:0,bottom:0,left:0};
      img.style.clipPath = 'inset(' + crop.top + '% ' + crop.right + '% ' + crop.bottom + '% ' + crop.left + '%)';
      el.appendChild(img);

      if (image.background) {
        el.style.left = (image.x*scale)+'px';
        el.style.top = (image.y*scale)+'px';
        el.style.width = (image.w*scale)+'px';
        el.style.height = (image.h*scale)+'px';
        el.style.transform = 'rotate('+(Number(image.rotation)||0)+'deg)';
        bgLayer.appendChild(el);
        return;
      }

      if (image.id === selectedImageId && !readOnly) {
        const resize = document.createElement('span');
        resize.className = 'nb-image-handle nb-image-resize';
        resize.title = 'Cambiar tamaño';
        resize.onpointerdown = function(e){ startImageResize(e,image,el); };
        el.appendChild(resize);
        const rotate = document.createElement('span');
        rotate.className = 'nb-image-handle nb-image-rotate';
        rotate.title = 'Rotar';
        rotate.onpointerdown = function(e){ startImageRotate(e,image,el); };
        el.appendChild(rotate);
      }
      applyImageStyle(el,image,scale);
      el.onpointerdown = function(e) {
        if (e.target && e.target.classList && e.target.classList.contains('nb-image-handle')) return;
        selectedImageId = image.id;
        renderImageLayer();
        updateImageTools();
        if (!image.locked) startImageMove(e,image,document.querySelector('[data-image-id="'+image.id+'"]'));
      };
      layer.appendChild(el);
    });
    updateImageTools();
  }

  function drawPageImagesPreview(ctx2, page, width, height) {
    if (!page || !Array.isArray(page.images)) return;
    const scaleX = width / LOGICAL_WIDTH;
    const scaleY = height / Math.max(INITIAL_PAGE_HEIGHT,Number(page.height)||INITIAL_PAGE_HEIGHT);
    page.images.slice().sort(function(a,b){return (Number(a.z)||0)-(Number(b.z)||0);}).forEach(function(object) {
      const asset = mediaAsset(object.assetId);
      if (!asset || !asset.dataUrl) return;
      const img = new Image();
      img.onload = function() {
        ctx2.save();
        const x = object.x*scaleX, y=object.y*scaleY, w=object.w*scaleX, h=object.h*scaleY;
        ctx2.translate(x+w/2,y+h/2);
        ctx2.rotate((Number(object.rotation)||0)*Math.PI/180);
        ctx2.globalAlpha = object.background ? 0.92 : 1;
        ctx2.drawImage(img,-w/2,-h/2,w,h);
        ctx2.restore();
      };
      img.src = asset.dataUrl;
    });
  }

  function installImageInputs() {
    const fileInput = document.getElementById('nbImageFiles');
    const cameraInput = document.getElementById('nbCameraFile');
    const photoBtn = document.getElementById('nbPhotoLibrary');
    const cameraBtn = document.getElementById('nbCameraImage');
    const pasteBtn = document.getElementById('nbPasteImage');
    if (photoBtn && fileInput) photoBtn.onclick = function(){ if (!readOnly) fileInput.click(); };
    if (cameraBtn && cameraInput) cameraBtn.onclick = function(){ if (!readOnly) cameraInput.click(); };
    if (pasteBtn) pasteBtn.onclick = pasteImageFromClipboard;
    if (fileInput) fileInput.onchange = async function() {
      await addImageFiles(fileInput.files);
      fileInput.value = '';
    };
    if (cameraInput) cameraInput.onchange = async function() {
      await addImageFiles(cameraInput.files);
      cameraInput.value = '';
    };

    const scroller = document.getElementById('nbCanvasScroller');
    if (scroller) {
      scroller.ondragover = function(e) {
        if (readOnly) return;
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
          e.preventDefault();
          scroller.classList.add('nb-drop-active');
        }
      };
      scroller.ondragleave = function(){ scroller.classList.remove('nb-drop-active'); };
      scroller.ondrop = async function(e) {
        scroller.classList.remove('nb-drop-active');
        if (readOnly || !e.dataTransfer) return;
        const files = Array.from(e.dataTransfer.files || []).filter(function(f){return String(f.type||'').startsWith('image/');});
        if (!files.length) return;
        e.preventDefault();
        await addImageFiles(files,imageLogicalPosition(e.clientX,e.clientY));
      };
    }

    if (!imagePasteListenerInstalled) {
      imagePasteListenerInstalled = true;
      document.addEventListener('paste', function(e) {
        const editor = document.getElementById('nbEditorPanel');
        if (!editor || editor.classList.contains('hidden') || readOnly) return;
        const files = [];
        Array.from((e.clipboardData && e.clipboardData.items) || []).forEach(function(item) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        });
        if (files.length) {
          e.preventDefault();
          addImageFiles(files);
        }
      });
    }
  }

  function pointSegmentDistancePx(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const denom = abx * abx + aby * aby;
    const t = denom > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom)) : 0;
    const x = ax + abx * t;
    const y = ay + aby * t;
    return Math.hypot(px - x, py - y);
  }

  function currentCanvasScale() {
    if (!canvas) return 1;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0.001, rect.width / LOGICAL_WIDTH);
  }

  function strokeHitAt(stroke, point, page, cssWidth, scale, radiusPx) {
    if (!stroke || stroke.tool === 'eraser' || !Array.isArray(stroke.points) || !stroke.points.length) return false;
    const pts = stroke.points;
    const px = point.x * cssWidth;
    const py = point.y * scale;
    const threshold = Math.max(radiusPx, Number(stroke.width || 4) * scale * 0.5 + 5);
    if (pts.length === 1) {
      return Math.hypot(px - pts[0].x * cssWidth, py - pts[0].y * scale) <= threshold;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (pointSegmentDistancePx(
        px, py,
        a.x * cssWidth, a.y * scale,
        b.x * cssWidth, b.y * scale
      ) <= threshold) return true;
    }
    if (stroke.shapeData) {
      const d = stroke.shapeData;
      const synthetic = [];
      if (stroke.shapeType === 'line') {
        synthetic.push({x:d.x1,y:d.y1},{x:d.x2,y:d.y2});
      } else if (stroke.shapeType === 'circle') {
        const cx = (d.x1 + d.x2) / 2;
        const cy = (d.y1 + d.y2) / 2;
        const rx = Math.abs(d.x2 - d.x1) / 2;
        const ry = Math.abs(d.y2 - d.y1) / 2;
        for (let i = 0; i <= 36; i++) {
          const a = (Math.PI * 2 * i) / 36;
          synthetic.push({x:cx + Math.cos(a)*rx,y:cy + Math.sin(a)*ry});
        }
      } else if (stroke.shapeType === 'rectangle') {
        const x1=Math.min(d.x1,d.x2),x2=Math.max(d.x1,d.x2),y1=Math.min(d.y1,d.y2),y2=Math.max(d.y1,d.y2);
        synthetic.push({x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2},{x:x1,y:y1});
      } else if (stroke.shapeType === 'triangle') {
        const x1=(d.x1+d.x2)/2,y1=Math.min(d.y1,d.y2),x2=Math.min(d.x1,d.x2),y2=Math.max(d.y1,d.y2),x3=Math.max(d.x1,d.x2);
        synthetic.push({x:x1,y:y1},{x:x2,y:y2},{x:x3,y:y2},{x:x1,y:y1});
      }
      for (let i = 1; i < synthetic.length; i++) {
        if (pointSegmentDistancePx(
          px, py,
          synthetic[i-1].x * cssWidth, synthetic[i-1].y * scale,
          synthetic[i].x * cssWidth, synthetic[i].y * scale
        ) <= threshold) return true;
      }
    }
    return false;
  }

  function eraseWholeStrokesAtEvent(e) {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!nb || !page || readOnly || !Array.isArray(page.strokes) || !page.strokes.length || !canvas) return false;
    const point = pointFromEvent(e);
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(0.001, rect.width / LOGICAL_WIDTH);
    const eraserWidth = Number((document.getElementById('nbWidth') || {}).value || 4);
    const radius = Math.max(10, eraserWidth * scale * 1.8);
    const removedIds = [];

    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const stroke = page.strokes[i];
      if (!stroke || strokeEraseSeen.has(stroke.id)) continue;
      if (strokeHitAt(stroke, point, page, Math.max(1, rect.width), scale, radius)) {
        removedIds.push(stroke.id);
        strokeEraseSeen.add(stroke.id);
        page.strokes.splice(i, 1);
      }
    }

    if (!removedIds.length) return false;
    page.redoStack = [];
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('stroke-delete', {
      notebookId: nb.id,
      pageId: page.id,
      strokeIds: removedIds
    });
    redraw();
    refreshPageManagerPreviews();
    renderNotebookList();
    return true;
  }

  function canvasCssSize(page) {
    const scroller = document.getElementById('nbCanvasScroller');
    const zoom = clamp(Number(page && page.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
    const fitWidth = Math.max(300, (scroller ? scroller.clientWidth : 900) - 24);
    const width = Math.max(260, fitWidth * zoom);
    const height = Math.max(400, (Number(page && page.height) || INITIAL_PAGE_HEIGHT) * width / LOGICAL_WIDTH);
    return { width, height };
  }

  function canvasMemoryBudget() {
    const memory = Number(navigator.deviceMemory || 0);
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (memory && memory <= 2) return 6500000;
    if (memory && memory <= 4) return 9000000;
    if (coarse) return 7600000;
    return MAX_CANVAS_PIXELS;
  }

  function resizeCanvas() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(1, r.width);
    const cssH = Math.max(1, r.height);
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const device = coarse ? Math.max(1, Math.min(1.5, window.devicePixelRatio || 1)) : Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const budget = canvasMemoryBudget();
    const pixelCap = Math.sqrt(budget / Math.max(1, cssW * cssH));
    const dimensionCap = Math.min(MAX_CANVAS_DIMENSION / cssW, MAX_CANVAS_DIMENSION / cssH);
    const backingScale = Math.max(0.10, Math.min(device, pixelCap, dimensionCap));
    const w = Math.max(1, Math.round(cssW * backingScale));
    const h = Math.max(1, Math.round(cssH * backingScale));
    lastRenderStats.backingScale = backingScale;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function applyCanvasGeometry(page) {
    page = normalizePage(page);
    const stage = document.getElementById('nbCanvasStage');
    if (!page || !stage || !canvas) return;
    const size = canvasCssSize(page);
    stage.style.width = Math.round(size.width) + 'px';
    stage.style.height = Math.round(size.height) + 'px';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    resizeCanvas();
    renderImageLayer();
    const label = document.getElementById('nbZoomLabel');
    if (label) label.textContent = Math.round(page.zoom * 100) + '%';
  }

  function restorePageViewport(page) {
    const scroller = document.getElementById('nbCanvasScroller');
    if (!scroller || !page) return;
    requestAnimationFrame(function() {
      const scale = currentCanvasScale();
      scroller.scrollTop = Math.max(0, Number(page.scrollY || 0) * scale);
      scroller.scrollLeft = Math.max(0, Number(page.scrollX || 0) * scale);
    });
  }

  function sendFocusSoon(delay) {
    if (focusBroadcastTimer) return;
    focusBroadcastTimer = setTimeout(function() {
      focusBroadcastTimer = null;
      sendFocus();
    }, Math.max(35, Number(delay) || 70));
  }

  function persistViewportSoon(page) {
    clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(function() {
      if (!page) return;
      persist();
      sendFocus();
    }, 320);
  }

  function growPage(page, amount) {
    if (!page) return;
    page.height = Math.max(INITIAL_PAGE_HEIGHT, Number(page.height) || INITIAL_PAGE_HEIGHT) + (amount || PAGE_GROW_BY);
    applyCanvasGeometry(page);
    redraw();
    persistViewportSoon(page);
    broadcast('page-layout', {
      notebookId: currentNotebookId,
      pageId: page.id,
      height: page.height,
      zoom: page.zoom
    });
  }

  function maybeGrowPage(page, logicalY) {
    if (!page) return;
    if (page.height - logicalY < 260) growPage(page, PAGE_GROW_BY);
  }

  function setPageZoom(page, nextZoom, anchor) {
    const scroller = document.getElementById('nbCanvasScroller');
    if (!page || !scroller || !canvas) return;
    const oldScale = currentCanvasScale();
    const ax = anchor && Number.isFinite(anchor.x) ? anchor.x : scroller.clientWidth / 2;
    const ay = anchor && Number.isFinite(anchor.y) ? anchor.y : scroller.clientHeight / 2;
    const logicalX = (scroller.scrollLeft + ax) / Math.max(0.001, oldScale);
    const logicalY = (scroller.scrollTop + ay) / Math.max(0.001, oldScale);
    page.zoom = clamp(Number(nextZoom) || 1, MIN_ZOOM, MAX_ZOOM);
    applyCanvasGeometry(page);
    redraw();
    requestAnimationFrame(function() {
      const newScale = currentCanvasScale();
      scroller.scrollLeft = Math.max(0, logicalX * newScale - ax);
      scroller.scrollTop = Math.max(0, logicalY * newScale - ay);
      page.scrollX = scroller.scrollLeft / Math.max(0.001, newScale);
      page.scrollY = scroller.scrollTop / Math.max(0.001, newScale);
      sendFocus();
      persistViewportSoon(page);
    });
  }

  function previewPinchZoom(page, nextZoom, gesture) {
    const stage = document.getElementById('nbCanvasStage');
    const label = document.getElementById('nbZoomLabel');
    if (!page || !stage || !gesture) return;
    const zoom = clamp(Number(nextZoom) || 1, MIN_ZOOM, MAX_ZOOM);
    gesture.pendingZoom = zoom;
    const ratio = zoom / Math.max(0.001, gesture.startZoom || 1);
    stage.style.willChange = 'transform';
    stage.style.transformOrigin = (gesture.stageOriginX || 0) + 'px ' + (gesture.stageOriginY || 0) + 'px';
    stage.style.transform = 'scale(' + ratio + ')';
    if (label) label.textContent = Math.round(zoom * 100) + '%';
  }

  function commitPinchZoom(page, gesture) {
    const stage = document.getElementById('nbCanvasStage');
    if (stage) {
      stage.style.transform = '';
      stage.style.transformOrigin = '0 0';
      stage.style.willChange = '';
    }
    if (!page || !gesture) return;
    setPageZoom(page, gesture.pendingZoom || gesture.startZoom || page.zoom || 1, {
      x: gesture.anchorX,
      y: gesture.anchorY
    });
  }

  function classifyHeldShape(stroke) {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return null;
    const pts = stroke.points;
    const xy = pts.map(function(p) { return { x: p.x * LOGICAL_WIDTH, y: p.y }; });
    let path = 0;
    for (let i = 1; i < xy.length; i++) path += Math.hypot(xy[i].x - xy[i-1].x, xy[i].y - xy[i-1].y);
    const first = xy[0];
    const last = xy[xy.length - 1];
    const direct = Math.hypot(last.x - first.x, last.y - first.y);
    if (path > 24 && direct / Math.max(1, path) > 0.94) {
      return {
        type: 'line',
        label: 'Línea',
        data: { x1: pts[0].x, y1: pts[0].y, x2: pts[pts.length-1].x, y2: pts[pts.length-1].y }
      };
    }

    if (pts.length < 8) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    xy.forEach(function(p) {
      minX = Math.min(minX,p.x); maxX = Math.max(maxX,p.x);
      minY = Math.min(minY,p.y); maxY = Math.max(maxY,p.y);
    });
    const w = maxX - minX;
    const h = maxY - minY;
    const largest = Math.max(w,h);
    const smallest = Math.min(w,h);
    const closed = Math.hypot(last.x-first.x,last.y-first.y) <= Math.max(34, largest*0.34);

    if (closed && w > 28 && h > 28) {
      // Rectángulo/cuadrado: buscamos puntos que sigan los cuatro bordes y que
      // realmente hayan pasado cerca de las cuatro esquinas. Esto evita que un
      // círculo se confunda con un cuadrado.
      const edgeTol = Math.max(10, smallest * 0.105);
      let edgeHits = 0;
      xy.forEach(function(p) {
        const edgeDistance = Math.min(
          Math.abs(p.x-minX), Math.abs(p.x-maxX),
          Math.abs(p.y-minY), Math.abs(p.y-maxY)
        );
        if (edgeDistance <= edgeTol) edgeHits++;
      });
      const cornerTol = Math.max(16, smallest * 0.14);
      const corners = [
        {x:minX,y:minY},{x:maxX,y:minY},
        {x:maxX,y:maxY},{x:minX,y:maxY}
      ];
      const cornerHits = corners.filter(function(c) {
        return xy.some(function(p){ return Math.hypot(p.x-c.x,p.y-c.y) <= cornerTol; });
      }).length;
      const edgeRatio = edgeHits / Math.max(1,xy.length);
      const aspect = w / Math.max(1,h);
      if (cornerHits >= 4 && edgeRatio >= 0.58 && aspect > 0.28 && aspect < 3.6) {
        const square = aspect > 0.78 && aspect < 1.28;
        return {
          type: 'rectangle',
          label: square ? 'Cuadrado' : 'Rectángulo',
          data: {
            x1: minX / LOGICAL_WIDTH,
            y1: minY,
            x2: maxX / LOGICAL_WIDTH,
            y2: maxY
          }
        };
      }

      // Círculo/elipse. Se prueba después del rectángulo para que los cuadrados
      // dibujados a mano no terminen convertidos en círculos.
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const radii = xy.map(function(p){
        const nx=(p.x-cx)/Math.max(1,w/2);
        const ny=(p.y-cy)/Math.max(1,h/2);
        return Math.hypot(nx,ny);
      });
      const mean = radii.reduce(function(a,b){return a+b;},0) / radii.length;
      const variance = radii.reduce(function(a,b){ const d=b-mean; return a+d*d;},0) / radii.length;
      const radialCv = Math.sqrt(variance) / Math.max(0.001,mean);
      const ratio = w / Math.max(1,h);
      if (ratio > 0.42 && ratio < 2.35 && radialCv < 0.18) {
        return {
          type: 'circle',
          label: ratio > 0.82 && ratio < 1.22 ? 'Círculo' : 'Elipse',
          data: {
            x1: minX / LOGICAL_WIDTH,
            y1: minY,
            x2: maxX / LOGICAL_WIDTH,
            y2: maxY
          }
        };
      }
    }
    return null;
  }

  function scheduleShapeHoldSnap() {
    if (!currentDraft || !['pen','highlighter'].includes(currentDraft.tool) || currentDraft.points.length < 2 || currentDraft.snappedByHold) return;
    const last=currentDraft.points[currentDraft.points.length-1];
    const anchor={x:last.x*LOGICAL_WIDTH,y:last.y};
    const prev=currentDraft._shapeHoldAnchor;
    const moved=!prev||Math.hypot(anchor.x-prev.x,anchor.y-prev.y)>=7;
    if (!moved && shapeHoldTimer) return;
    if (moved) currentDraft._shapeHoldAnchor=anchor;
    clearTimeout(shapeHoldTimer);
    shapeHoldTimer = setTimeout(function() {
      if (!currentDraft || currentDraft.snappedByHold) return;
      const recognized = classifyHeldShape(currentDraft);
      if (!recognized) return;
      currentDraft.shapeType = recognized.type;
      currentDraft.shapeData = recognized.data;
      currentDraft.snappedByHold = true;
      currentDraft._shapeSnapAnchor = currentDraft._shapeHoldAnchor;
      redraw();
      if (navigator.vibrate) navigator.vibrate(18);
      flashStatus((recognized.type==='line'?'📏 ':'⬡ ')+(recognized.label||'Forma')+' reconocida');
    }, 520);
  }

  function setupCanvas(getTool, getEraserMode, getShapeType, getBrush) {
    canvas = document.getElementById('info1NotebookCanvas');
    const scroller = document.getElementById('nbCanvasScroller');
    if (!canvas || !scroller) return;
    ctx = canvas.getContext('2d');
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!page) return;

    applyCanvasGeometry(page);
    restorePageViewport(page);
    redraw();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(function() {
      const activePage = getPage(getNotebook(currentNotebookId), currentPageId);
      if (!activePage) return;
      const scale = currentCanvasScale();
      const logicalY = scroller.scrollTop / Math.max(0.001, scale);
      const logicalX = scroller.scrollLeft / Math.max(0.001, scale);
      applyCanvasGeometry(activePage);
      redraw();
      requestAnimationFrame(function() {
        const nextScale = currentCanvasScale();
        scroller.scrollTop = logicalY * nextScale;
        scroller.scrollLeft = logicalX * nextScale;
      });
    });
    resizeObserver.observe(scroller);

    if (viewportCleanup) {
      try { viewportCleanup(); } catch (_) {}
      viewportCleanup = null;
    }
    const viewport = window.visualViewport;
    const onViewportResize = function() {
      clearTimeout(viewportResizeTimer);
      viewportResizeTimer = setTimeout(function() {
        const p = getPage(getNotebook(currentNotebookId), currentPageId);
        if (!p) return;
        const logicalY = scroller.scrollTop / Math.max(0.001, currentCanvasScale());
        applyCanvasGeometry(p);
        requestRedraw();
        requestAnimationFrame(function() {
          scroller.scrollTop = logicalY * currentCanvasScale();
        });
      }, 80);
    };
    if (viewport) {
      viewport.addEventListener('resize', onViewportResize, { passive:true });
    }
    window.addEventListener('orientationchange', onViewportResize, { passive:true });
    viewportCleanup = function() {
      if (viewport) {
        viewport.removeEventListener('resize', onViewportResize);
      }
      window.removeEventListener('orientationchange', onViewportResize);
    };

    scroller.onscroll = function() {
      const p = getPage(getNotebook(currentNotebookId), currentPageId);
      if (!p || !canvas) return;
      const scale = currentCanvasScale();
      p.scrollY = scroller.scrollTop / Math.max(0.001, scale);
      p.scrollX = scroller.scrollLeft / Math.max(0.001, scale);
      if (lastViewportPaintY === null || Math.abs(p.scrollY - lastViewportPaintY) > 520) requestRedraw();
      sendFocusSoon(60);
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 260) {
        growPage(p, PAGE_GROW_BY);
      } else {
        persistViewportSoon(p);
      }
    };

    activePointers.clear();
    gestureState = null;
    drawPointerId = null;

    // En iPad/Safari una pulsación prolongada puede intentar seleccionar el
    // contenido de la hoja como texto. La pizarra no es contenido seleccionable.
    if (scroller.dataset.nbSelectionGuard !== '1') {
      scroller.dataset.nbSelectionGuard = '1';
      const blockNativeSelection = function(ev) {
        const target = ev.target;
        if (target && target.closest && target.closest('input,textarea,select,[contenteditable="true"]')) return;
        ev.preventDefault();
      };
      scroller.addEventListener('selectstart', blockNativeSelection, true);
      scroller.addEventListener('contextmenu', blockNativeSelection, true);
      scroller.addEventListener('dragstart', blockNativeSelection, true);
    }

    function pointerPair() {
      return Array.from(activePointers.values()).slice(0,2);
    }

    function beginTouchGesture(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      if (activePointers.size >= 2) {
        if (currentDraft) {
          currentDraft = null;
          pointQueue = [];
          drawPointerId = null;
          clearTimeout(shapeHoldTimer);
          redraw();
        }
        const pair = pointerPair();
        const dx = pair[1].x - pair[0].x;
        const dy = pair[1].y - pair[0].y;
        const centerClientX = (pair[0].x + pair[1].x) / 2;
        const centerClientY = (pair[0].y + pair[1].y) / 2;
        const scrollerRect = scroller.getBoundingClientRect();
        const stage = document.getElementById('nbCanvasStage');
        const stageRect = stage ? stage.getBoundingClientRect() : scrollerRect;
        const centerX = centerClientX - scrollerRect.left;
        const centerY = centerClientY - scrollerRect.top;
        const p = getPage(getNotebook(currentNotebookId), currentPageId);
        gestureState = {
          type: 'pinch',
          startDistance: Math.max(10, Math.hypot(dx,dy)),
          startZoom: p ? p.zoom : 1,
          pendingZoom: p ? p.zoom : 1,
          anchorX: centerX,
          anchorY: centerY,
          stageOriginX: centerClientX - stageRect.left,
          stageOriginY: centerClientY - stageRect.top
        };
      } else {
        gestureState = {
          type: 'pan',
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startScrollLeft: scroller.scrollLeft,
          startScrollTop: scroller.scrollTop
        };
      }
    }

    canvas.onpointerdown = function(e) {
      if (selectedImageId) {
        selectedImageId = null;
        renderImageLayer();
        updateImageTools();
      }
      const nbNow = getNotebook(currentNotebookId);
      const pageNow = getPage(nbNow, currentPageId);
      if (!nbNow || !pageNow) return;

      if (e.pointerType === 'pen') {
        const firstDetection = !pencilDetected;
        pencilDetected = true;
        const inputStatus = document.getElementById('nbInputStatus');
        if (inputStatus) {
          inputStatus.classList.add('pen');
          const pressureText = typeof e.pressure === 'number' ? ' · presión ' + Math.round(e.pressure * 100) + '%' : '';
          inputStatus.textContent = '✏️ Pencil/stylus' + pressureText;
        }
        if (firstDetection) flashStatus('✏️ Apple Pencil / stylus detectado');
      }

      if (e.pointerType === 'touch') {
        activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
        if (fingerPanMode || activePointers.size >= 2 || readOnly) {
          beginTouchGesture(e);
          e.preventDefault();
          return;
        }
      }

      if (readOnly) return;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      drawPointerId = e.pointerId;
      const tool = getTool();
      if (tool === 'eraser' && getEraserMode && getEraserMode() === 'stroke') {
        strokeEraseActive = true;
        strokeEraseSeen.clear();
        eraseWholeStrokesAtEvent(e);
        e.preventDefault();
        return;
      }

      const startPoint = pointFromEvent(e);
      maybeGrowPage(pageNow, startPoint.y);
      const width = Number(document.getElementById('nbWidth').value || 4);
      currentDraft = {
        id: uuid(),
        tool: tool,
        brush: getBrush ? getBrush() : 'ballpoint',
        coordVersion: 2,
        color: document.getElementById('nbColor').value || '#16264a',
        width: tool === 'highlighter' ? Math.max(10, width * 3) : width,
        startedAt: Date.now(),
        author: window.INFO1_NOTEBOOK_COLLABORATION && window.INFO1_NOTEBOOK_COLLABORATION.authorStamp
          ? window.INFO1_NOTEBOOK_COLLABORATION.authorStamp()
          : null,
        points: [startPoint]
      };
      if (tool === 'line') {
        currentDraft.shapeType = 'line';
        currentDraft.shapeData = { x1:startPoint.x, y1:startPoint.y, x2:startPoint.x, y2:startPoint.y };
      } else if (tool === 'shape') {
        currentDraft.shapeType = (getShapeType && getShapeType()) || 'circle';
        currentDraft.shapeData = { x1:startPoint.x, y1:startPoint.y, x2:startPoint.x, y2:startPoint.y };
      }
      pointQueue = [];
      broadcast('stroke-start', {
        notebookId: nbNow.id,
        pageId: pageNow.id,
        stroke: currentDraft
      });
      scheduleShapeHoldSnap();
      if (tool === 'line' || tool === 'shape') redraw();
      else drawStroke(currentDraft);
      e.preventDefault();
    };

    canvas.onpointermove = function(e) {
      if (e.pointerType === 'touch' && activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
        if (gestureState && (fingerPanMode || activePointers.size >= 2 || readOnly)) {
          if (activePointers.size >= 2) {
            if (gestureState.type !== 'pinch') beginTouchGesture(e);
            const pair = pointerPair();
            const dx = pair[1].x - pair[0].x;
            const dy = pair[1].y - pair[0].y;
            const dist = Math.max(10, Math.hypot(dx,dy));
            const p = getPage(getNotebook(currentNotebookId), currentPageId);
            if (p && gestureState && gestureState.startDistance) {
              const nextZoom = gestureState.startZoom * dist / gestureState.startDistance;
              previewPinchZoom(p, nextZoom, gestureState);
            }
          } else if (gestureState.type === 'pan' && gestureState.pointerId === e.pointerId) {
            gestureState.pendingX = e.clientX;
            gestureState.pendingY = e.clientY;
            if (!gestureState.panFrame) {
              const g = gestureState;
              g.panFrame = requestAnimationFrame(function() {
                g.panFrame = 0;
                scroller.scrollLeft = g.startScrollLeft - ((g.pendingX ?? g.startX) - g.startX);
                scroller.scrollTop = g.startScrollTop - ((g.pendingY ?? g.startY) - g.startY);
              });
            }
          }
          e.preventDefault();
          return;
        }
      }

      if (readOnly || drawPointerId !== e.pointerId) return;
      if (strokeEraseActive) {
        eraseWholeStrokesAtEvent(e);
        e.preventDefault();
        return;
      }
      if (!currentDraft) return;
      const p = pointFromEvent(e);
      const activePage = getPage(getNotebook(currentNotebookId), currentPageId);
      maybeGrowPage(activePage, p.y);

      let forceFullRedraw = false;
      if (currentDraft.snappedByHold && ['pen','highlighter'].includes(currentDraft.tool)) {
        const a=currentDraft._shapeSnapAnchor||currentDraft._shapeHoldAnchor;
        const movedAfterSnap=a?Math.hypot(p.x*LOGICAL_WIDTH-a.x,p.y-a.y):999;
        if (movedAfterSnap < 9) {
          e.preventDefault();
          return;
        }
        delete currentDraft.shapeType;
        delete currentDraft.shapeData;
        currentDraft.snappedByHold = false;
        currentDraft._shapeHoldAnchor={x:p.x*LOGICAL_WIDTH,y:p.y};
        currentDraft._shapeSnapAnchor=null;
        forceFullRedraw = true;
      }

      if (currentDraft.tool === 'line' || currentDraft.tool === 'shape') {
        currentDraft.points = [currentDraft.points[0], p];
        currentDraft.shapeData.x2 = p.x;
        currentDraft.shapeData.y2 = p.y;
        delete currentDraft._bounds;
        currentDraft._boundsVersion = 0;
      } else {
        const previousCount = currentDraft.points.length;
        const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const rawEvents = coalesced.length ? coalesced : [e];
        let added = false;
        rawEvents.forEach(function(sample) {
          const samplePoint = pointFromEvent(sample);
          const last = currentDraft.points[currentDraft.points.length - 1];
          const logicalDistance = last ? Math.hypot((samplePoint.x-last.x)*LOGICAL_WIDTH, samplePoint.y-last.y) : 999;
          if (logicalDistance < 1.4) return;
          currentDraft.points.push(samplePoint);
          pointQueue.push(samplePoint);
          added = true;
        });
        if (!added) return;
        delete currentDraft._bounds;
        currentDraft._boundsVersion = 0;
        schedulePointFlush();
        scheduleShapeHoldSnap();
        if (forceFullRedraw) requestRedraw();
        else drawStrokeIncremental(currentDraft, previousCount);
      }
      if (currentDraft.tool === 'line' || currentDraft.tool === 'shape') requestRedraw();
      e.preventDefault();
    };

    const finish = function(e) {
      if (e.pointerType === 'touch' && activePointers.has(e.pointerId)) {
        if (gestureState && gestureState.type === 'pinch') {
          const pinchPage = getPage(getNotebook(currentNotebookId), currentPageId);
          commitPinchZoom(pinchPage, gestureState);
        }
        activePointers.delete(e.pointerId);
        if (activePointers.size >= 2) {
          beginTouchGesture(e);
        } else if (activePointers.size === 1 && (fingerPanMode || readOnly)) {
          const rem = Array.from(activePointers.entries())[0];
          gestureState = {
            type:'pan',
            pointerId:rem[0],
            startX:rem[1].x,
            startY:rem[1].y,
            startScrollLeft:scroller.scrollLeft,
            startScrollTop:scroller.scrollTop
          };
        } else {
          gestureState = null;
        }
        if (drawPointerId !== e.pointerId) {
          e.preventDefault();
          return;
        }
      }

      if (drawPointerId !== null && e.pointerId !== drawPointerId) return;
      clearTimeout(shapeHoldTimer);

      if (strokeEraseActive) {
        strokeEraseActive = false;
        strokeEraseSeen.clear();
        drawPointerId = null;
        if (e) e.preventDefault();
        return;
      }
      if (!currentDraft) {
        drawPointerId = null;
        return;
      }
      flushPoints();
      const nbFinish = getNotebook(currentNotebookId);
      const pageFinish = getPage(nbFinish, currentPageId);
      if (nbFinish && pageFinish) {
        if (!Array.isArray(pageFinish.strokes)) pageFinish.strokes = [];
        pageFinish.redoStack = [];
        pageFinish.strokes.push(currentDraft);
        nbFinish.updatedAt = new Date().toISOString();
        broadcast('stroke-final', {
          notebookId: nbFinish.id,
          pageId: pageFinish.id,
          stroke: currentDraft
        });
        try { window.INFO1_STATE_STORAGE.journal(nbFinish,pageFinish,currentDraft); }
        catch(error){window.INFO1_LOCAL_SAVE_OK=false;console.warn('INFO1: no se pudo guardar la recuperación del trazo',error);}
        clearTimeout(inkPersistTimer);
        inkPersistTimer = setTimeout(function(){inkPersistTimer=null;persist();}, 450);
        clearTimeout(inkRefreshTimer);
        inkRefreshTimer = setTimeout(function() {
          refreshPageManagerPreviews();
          renderNotebookList();
        }, 700);
      }
      currentDraft = null;
      drawPointerId = null;
      if (e) e.preventDefault();
    };

    canvas.onpointerup = finish;
    canvas.onpointercancel = finish;
    canvas.onpointerleave = function(e) {
      if (e.pointerType === 'mouse' && currentDraft && e.buttons === 0) finish(e);
    };
  }

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    const scale = Math.max(0.001, r.width / LOGICAL_WIDTH);
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
      y: clamp((e.clientY - r.top) / scale, 0, page ? page.height : INITIAL_PAGE_HEIGHT),
      p: typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
    };
  }

  function strokeBounds(stroke) {
    if (!stroke) return null;
    if (stroke._bounds && stroke._boundsVersion === 2) return stroke._bounds;
    let minX = 1, maxX = 0, minY = Infinity, maxY = -Infinity;
    if (stroke.shapeData && stroke.shapeType) {
      const d = stroke.shapeData;
      minX = Math.min(d.x1, d.x2);
      maxX = Math.max(d.x1, d.x2);
      minY = Math.min(d.y1, d.y2);
      maxY = Math.max(d.y1, d.y2);
    } else if (Array.isArray(stroke.points) && stroke.points.length) {
      stroke.points.forEach(function(p) {
        if (!p) return;
        minX = Math.min(minX, Number(p.x) || 0);
        maxX = Math.max(maxX, Number(p.x) || 0);
        minY = Math.min(minY, Number(p.y) || 0);
        maxY = Math.max(maxY, Number(p.y) || 0);
      });
    } else {
      return null;
    }
    const pad = Math.max(8, Number(stroke.width || 4) * 2);
    stroke._bounds = {
      minX: clamp(minX, 0, 1),
      maxX: clamp(maxX, 0, 1),
      minY: Math.max(0, minY - pad),
      maxY: Math.max(0, maxY + pad)
    };
    stroke._boundsVersion = 2;
    return stroke._bounds;
  }

  function visibleLogicalRange() {
    const scroller = document.getElementById('nbCanvasScroller');
    if (!scroller || !canvas) return null;
    const scale = currentCanvasScale();
    return {
      minY: Math.max(0, scroller.scrollTop / Math.max(0.001, scale) - VIEWPORT_OVERSCAN),
      maxY: (scroller.scrollTop + scroller.clientHeight) / Math.max(0.001, scale) + VIEWPORT_OVERSCAN
    };
  }

  function strokeIsNearViewport(stroke, range) {
    if (!range) return true;
    const b = strokeBounds(stroke);
    if (!b) return true;
    return b.maxY >= range.minY && b.minY <= range.maxY;
  }

  function requestRedraw() {
    if (redrawFrame) return;
    redrawFrame = requestAnimationFrame(function() {
      redrawFrame = 0;
      redraw();
    });
  }

  function drawStroke(stroke) {
    if (!ctx || !canvas || !stroke || !stroke.points || !stroke.points.length) return;
    const page = getPage(getNotebook(currentNotebookId), currentPageId);
    if (!page) return;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const sx = canvas.width / cssW;
    const sy = canvas.height / cssH;
    const logicalScale = cssW / LOGICAL_WIDTH;
    const mapX = function(x) { return x * cssW; };
    const mapY = function(y) { return y * logicalScale; };

    ctx.save();
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color || '#16264a';
    ctx.globalAlpha = stroke.tool === 'highlighter' ? 0.28 : (stroke.brush === 'pencil' ? 0.68 : 1);
    let width = Math.max(0.8, Number(stroke.width || 4) * logicalScale);
    if (stroke.brush === 'fountain' && stroke.points.length) {
      const avg = stroke.points.reduce(function(sum,p){ return sum + (Number(p.p)||0.5); },0) / stroke.points.length;
      width *= 0.72 + avg * 0.9;
    } else if (stroke.brush === 'pencil') {
      width *= 0.86;
    }
    ctx.lineWidth = width;

    if (drawShapePath(ctx, stroke, mapX, mapY)) {
      ctx.stroke();
      ctx.restore();
      return;
    }

    const pts = stroke.points;
    ctx.beginPath();
    ctx.moveTo(mapX(pts[0].x), mapY(pts[0].y));
    if (pts.length === 1) {
      ctx.lineTo(mapX(pts[0].x) + 0.01, mapY(pts[0].y) + 0.01);
    } else {
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const mx = mapX((prev.x + cur.x) * 0.5);
        const my = mapY((prev.y + cur.y) * 0.5);
        ctx.quadraticCurveTo(mapX(prev.x), mapY(prev.y), mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(mapX(last.x), mapY(last.y));
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawStrokeIncremental(stroke, fromIndex) {
    if (!stroke || stroke.shapeType || !Array.isArray(stroke.points) || stroke.points.length < 2) return false;
    const start = Math.max(0, Math.min(stroke.points.length - 1, Number(fromIndex) || 0) - 1);
    const pts = stroke.points.slice(start);
    if (pts.length < 2) return false;
    const preview = Object.assign({}, stroke, { points: pts });
    delete preview._bounds;
    delete preview._boundsVersion;
    drawStroke(preview);
    return true;
  }

  function redraw() {
    if (!ctx || !canvas) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    const range = visibleLogicalRange();
    let drawn = 0;
    let skipped = 0;
    (page && page.strokes ? page.strokes : []).forEach(function(stroke) {
      if (strokeIsNearViewport(stroke, range)) {
        drawStroke(stroke);
        drawn++;
      } else {
        skipped++;
      }
    });
    remoteDrafts.forEach(function(stroke, key) {
      if (key.indexOf((currentNotebookId || '') + ':' + (currentPageId || '') + ':') === 0) {
        if (strokeIsNearViewport(stroke, range)) drawStroke(stroke);
      }
    });
    if (currentDraft) drawStroke(currentDraft);
    lastRenderStats.drawn = drawn;
    lastRenderStats.skipped = skipped;
    const scroller = document.getElementById('nbCanvasScroller');
    if (scroller) lastViewportPaintY = scroller.scrollTop / Math.max(0.001, currentCanvasScale());
  }

  function schedulePointFlush() {
    if (pointFlushTimer) return;
    pointFlushTimer = setTimeout(function() {
      pointFlushTimer = null;
      flushPoints();
    }, 15);
  }

  function flushPoints() {
    if (!currentDraft || !pointQueue.length) return;
    const pts = pointQueue.splice(0);
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!nb || !page) return;
    broadcast('stroke-points', {
      notebookId: nb.id,
      pageId: page.id,
      strokeId: currentDraft.id,
      points: pts
    });
  }

  function updateFollowButton() {
    const btn = document.getElementById('nbFollowBtn');
    if (!btn) return;
    btn.classList.toggle('active', followMode);
    btn.textContent = followMode ? '👀 Siguiendo otra pantalla' : '👀 Seguir otra pantalla';
  }

  function setFollowMode(enabled) {
    followMode = !!enabled;
    INFO1_LOCAL.setItem(FOLLOW_KEY, followMode ? '1' : '0');
    updateFollowButton();
    flashStatus(followMode ? '👀 Siguiendo la pizarra compartida en vivo' : '✍️ Dejaste de seguir la otra pantalla');
    if (followMode && currentNotebookId) {
      readOnly = true;
      renderEditor();
    }
    return followMode;
  }

  function toggleFollow() {
    setFollowMode(!followMode);
  }

  function flashStatus(text) {
    document.querySelector('.nb-status-toast') && document.querySelector('.nb-status-toast').remove();
    const el = document.createElement('div');
    el.className = 'nb-status-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 1800);
  }

  function cloudContext() {
    const status = window.INFO1_CLOUD && window.INFO1_CLOUD.status;
    return {
      connected: !!(status && status.connected && window.INFO1_SUPABASE_CLIENT),
      workspaceId: status && status.workspaceId ? status.workspaceId : null
    };
  }

  function desiredChannelName() {
    const c = cloudContext();
    if (!c.connected || !c.workspaceId) return null;
    return 'info1-notebooks-' + CHANNEL_VERSION + '-' + c.workspaceId;
  }

  function connectRealtime() {
    const sb = window.INFO1_SUPABASE_CLIENT;
    const desired = desiredChannelName();
    if (!sb || !desired) {
      if (channel && channelClient) {
        try { channelClient.removeChannel(channel); } catch (_) {}
      }
      channel = null; channelName = null; channelClient = null;
      channelReady = false;
      channelConnecting = false;
      updateCloudStatus();
      return;
    }
    if (channel && channelClient === sb && channelName === desired && (channelReady || channelConnecting)) return;

    if (channel) {
      try { channelClient && channelClient.removeChannel(channel); } catch (_) {}
      channel = null;
      channelReady = false;
      channelConnecting = false;
    }

    channelName = desired;
    channelClient = sb;
    channelConnecting = true;
    const thisChannel = sb.channel(desired, { config: { broadcast: { self: false, ack: true } } })
      .on('broadcast', { event: 'nb' }, function(msg) {
        handleRemote(msg && msg.payload ? msg.payload : {});
      });
    channel = thisChannel;
    thisChannel.subscribe(function(status) {
      if (channel !== thisChannel) return;
      channelReady = status === 'SUBSCRIBED';
      if (channelReady) {
        channelConnecting = false;
        updateCloudStatus();
        if (currentNotebookId) sendFocus();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        channelConnecting = false;
        channelReady = false;
        try { sb.removeChannel(thisChannel); } catch (_) {}
        if (channel === thisChannel) {
          channel = null;
          channelName = null;
          channelClient = null;
        }
        updateCloudStatus();
        setTimeout(connectRealtime, 650);
      }
    });
  }

  function updateCloudStatus() {
    const el = document.getElementById('nbCloudStatus');
    if (el) {
      const c = cloudContext();
      el.className = 'nb-live ' + (channelReady ? 'ok' : 'warn');
      el.textContent = channelReady
        ? '● Tiempo real conectado · tablet y notebook pueden verse al instante'
        : (c.connected ? '● Conectando tiempo real…' : '● Modo local · conectá INFO 1 a la nube para compartir entre dispositivos');
    }
    const live = document.querySelector('#nbEditorPanel .nb-live');
    if (live) {
      live.className = 'nb-live ' + (channelReady ? 'ok' : 'warn');
      live.textContent = (channelReady ? '● Tiempo real conectado' : '● Modo local / conectando') + (readOnly ? ' · Solo lectura' : ' · Editando');
    }
  }

  function broadcast(kind, payload) {
    const transient=['focus','snapshot-request','stroke-start','stroke-points'];
    if(!transient.includes(kind)) {
      window.INFO1_NOTEBOOK_MERGE.stamp(ensureStore());
      payload=Object.assign({},payload,{_v:window.INFO1_NOTEBOOK_MERGE.version()});
      const nb=ensureStore().notebooks[payload.notebookId];
      if(kind==='pages-replaced'&&nb)payload.deletedPages=nb._deletedPages||{};
      if(kind==='page-cleared'&&nb)payload.strokeIds=Object.keys(getPage(nb,payload.pageId)?._deletedStrokes||{});
    }
    const body = Object.assign({
      kind,
      deviceId: deviceId(),
      at: Date.now()
    }, payload || {});
    if (!channel || !channelReady) {
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent) {
        window.INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent(kind, payload || {});
      }
      return;
    }
    try {
      Promise.resolve(channel.send({ type: 'broadcast', event: 'nb', payload: body })).then(function(result) {
        if (result !== 'ok') throw new Error('Envío no confirmado');
      }).catch(function() {
        window.INFO1_NOTEBOOK_RESILIENCE?.enqueueBaseEvent(kind, payload || {});
      });
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.onBaseBroadcast) {
        window.INFO1_NOTEBOOK_RESILIENCE.onBaseBroadcast(kind, payload || {});
      }
    } catch (_) {
      if (window.INFO1_NOTEBOOK_RESILIENCE && window.INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent) {
        window.INFO1_NOTEBOOK_RESILIENCE.enqueueBaseEvent(kind, payload || {});
      }
    }
  }

  function sendFocus() {
    const nb = getNotebook(currentNotebookId);
    if (!nb) return;
    const page = getPage(nb, currentPageId);
    broadcast('focus', {
      notebookId: nb.id,
      pageId: currentPageId,
      title: nb.title,
      editing: !readOnly,
      scrollY: page ? page.scrollY : 0,
      scrollX: page ? page.scrollX : 0,
      zoom: page ? page.zoom : 1
    });
  }

  function handleRemote(m) {
    if (!m || m.deviceId === deviceId()) return;
    const transient=['focus','snapshot-request','stroke-start','stroke-points'];
    // Finish local ink before a remote structural update rebuilds the canvas.
    if(currentDraft && ['snapshot','pages-replaced','page-deleted','notebook-deleted'].includes(m.kind) && canvas?.onpointerup)
      canvas.onpointerup({pointerId:drawPointerId,pointerType:'pen',preventDefault(){}});
    if(!transient.includes(m.kind))window.INFO1_NOTEBOOK_MERGE.stamp(ensureStore());
    const targetNb=ensureStore().notebooks[m.notebookId];
    const targetPage=targetNb?.pages?.find(p=>p.id===m.pageId);
    const incomingVersion=m._v||String(Number(m.at)||0).padStart(16,'0')+':'+(m.deviceId||'legacy');
    m={...m,_v:incomingVersion};
    const nid=m.notebookId||m.notebook?.id;
    const removedNotebook=ensureStore()._deletedNotebooks?.[nid];
    if(removedNotebook && incomingVersion<=removedNotebook)return;
    if(m.kind==='notebook-created' && removedNotebook && (m.notebook._v||'')<=removedNotebook)return;
    if(['notebook-deleted','notebook-renamed','notebook-favorite','notebook-folder'].includes(m.kind) && incomingVersion<(targetNb?._v||''))return;
    const pid=m.pageId||m.page?.id;
    if(pid && targetNb?._deletedPages?.[pid] && incomingVersion<=targetNb._deletedPages[pid])return;
    if(m.kind==='page-deleted' && incomingVersion<(targetPage?._v||''))return;
    if(m.kind==='stroke-delete' && Array.isArray(m.strokeIds))m.strokeIds=m.strokeIds.filter(id=>incomingVersion>=(targetPage?.strokes?.find(x=>x.id===id)?._v||''));
    if(m.stroke?.id||m.strokeId){
      const id=m.stroke?.id||m.strokeId;
      const known=targetPage?.strokes?.find(x=>x.id===id)?._v||'';
      const deleted=targetPage?._deletedStrokes?.[id]||'';
      if(incomingVersion < known || incomingVersion <= deleted)return;
    }
    applyRemote(m);
    if(!transient.includes(m.kind)) {
      if(['snapshot','pages-replaced'].includes(m.kind))window.INFO1_NOTEBOOK_MERGE.adopt(ensureStore());
      else window.INFO1_NOTEBOOK_MERGE.stamp(ensureStore(),incomingVersion);
    }
    if (!['focus','snapshot-request','stroke-start','stroke-points'].includes(m.kind)) {
      try {
        if (window.INFO1_CLOUD?.cacheRealtimeState) window.INFO1_CLOUD.cacheRealtimeState(appState());
        else INFO1_LOCAL.setItem(STATE_KEY, JSON.stringify(appState()));
      } catch (error) {
        window.INFO1_NOTEBOOK_RESILIENCE?.onPersistEnd(false);
        console.warn('INFO1 cuadernos: no se pudo guardar el cambio recibido', error);
      }
    }
  }

  function applyRemote(m) {
    if (!m || m.deviceId === deviceId()) return;
    const store = ensureStore();

    if (m.kind === 'focus') {
      if (!store.notebooks[m.notebookId]) {
        broadcast('snapshot-request', { notebookId: m.notebookId });
      }
      if (followMode && store.notebooks[m.notebookId]) {
        const remoteNb = store.notebooks[m.notebookId];
        const remotePage = getPage(remoteNb, m.pageId);
        let zoomChanged = false;
        if (remotePage) {
          if (Number.isFinite(Number(m.zoom))) {
            const nextZoom = clamp(Number(m.zoom), MIN_ZOOM, MAX_ZOOM);
            zoomChanged = Math.abs((Number(remotePage.zoom) || 1) - nextZoom) > 0.002;
            remotePage.zoom = nextZoom;
          }
          if (Number.isFinite(Number(m.scrollY))) remotePage.scrollY = Math.max(0, Number(m.scrollY));
          if (Number.isFinite(Number(m.scrollX))) remotePage.scrollX = Math.max(0, Number(m.scrollX));
        }
        if (currentNotebookId !== m.notebookId || currentPageId !== m.pageId) {
          openNotebook(m.notebookId, m.pageId, true, false);
        } else {
          readOnly = true;
          if (remotePage) {
            if (zoomChanged) {
              applyCanvasGeometry(remotePage);
              redraw();
            }
            const scroller = document.getElementById('nbCanvasScroller');
            if (scroller) {
              requestAnimationFrame(function() {
                const scale = currentCanvasScale();
                scroller.scrollTop = Math.max(0, Number(remotePage.scrollY || 0) * scale);
                scroller.scrollLeft = Math.max(0, Number(remotePage.scrollX || 0) * scale);
              });
            }
          }
        }
      } else if (currentNotebookId === m.notebookId && m.pageId && currentPageId !== m.pageId && readOnly) {
        currentPageId = m.pageId;
        const p = getPage(store.notebooks[m.notebookId], m.pageId);
        if (p) {
          applyCanvasGeometry(p);
          restorePageViewport(p);
        }
        renderPages();
        redraw();
      }
      return;
    }

    if (m.kind === 'snapshot-request') {
      const nb = store.notebooks[m.notebookId];
      if (nb) broadcast('snapshot', { notebook: nb });
      return;
    }

    if (m.kind === 'snapshot' && m.notebook && m.notebook.id) {
      if(store._deletedNotebooks?.[m.notebook.id] && (!m.notebook._v || m.notebook._v<=store._deletedNotebooks[m.notebook.id]))return;
      store.notebooks[m.notebook.id] = window.INFO1_NOTEBOOK_MERGE.notebook(store.notebooks[m.notebook.id],m.notebook);
      if (!store.order.includes(m.notebook.id)) store.order.unshift(m.notebook.id);
      renderNotebookList();
      if (followMode || currentNotebookId === m.notebook.id) openNotebook(m.notebook.id, currentPageId || (m.notebook.pages[0] && m.notebook.pages[0].id), followMode || readOnly, false);
      return;
    }

    if (m.kind === 'notebook-created' && m.notebook && m.notebook.id) {
      if (!store.notebooks[m.notebook.id]) {
        store.notebooks[m.notebook.id] = m.notebook;
        store.order.unshift(m.notebook.id);
      }
      renderNotebookList();
      return;
    }

    if (m.kind === 'notebook-deleted') {
      store._deletedNotebooks??={};store._deletedNotebooks[m.notebookId]=m._v;
      delete store.notebooks[m.notebookId];
      store.order = store.order.filter(function(id) { return id !== m.notebookId; });
      if (currentNotebookId === m.notebookId) showList();
      renderNotebookList();
      return;
    }

    if (m.kind === 'folder-created' && m.folder && m.folder.id) {
      store.folders[m.folder.id] = m.folder;
      if (!store.folderOrder.includes(m.folder.id)) store.folderOrder.push(m.folder.id);
      renderNotebookList();
      return;
    }

    if (m.kind === 'folder-updated' && m.folder && m.folder.id) {
      store.folders[m.folder.id] = m.folder;
      if (!store.folderOrder.includes(m.folder.id)) store.folderOrder.push(m.folder.id);
      renderNotebookList();
      return;
    }

    if (m.kind === 'folder-deleted') {
      const parentId = m.parentId || null;
      Object.values(store.notebooks).forEach(function(item) {
        if (item && item.folderId === m.folderId) item.folderId = parentId;
      });
      Object.values(store.folders).forEach(function(folder) {
        if (folder && folder.parentId === m.folderId) folder.parentId = parentId;
      });
      delete store.folders[m.folderId];
      store.folderOrder = store.folderOrder.filter(function(id) { return id !== m.folderId; });
      if (currentFolderId === m.folderId) currentFolderId = parentId || null;
      renderNotebookList();
      return;
    }

    if (m.kind === 'folder-order' && Array.isArray(m.order)) {
      store.folderOrder = m.order.filter(function(id) { return !!store.folders[id]; });
      Object.keys(store.folders).forEach(function(id) { if (!store.folderOrder.includes(id)) store.folderOrder.push(id); });
      renderNotebookList();
      return;
    }

    if (m.kind === 'notebook-favorite') {
      const fav = store.notebooks[m.notebookId];
      if (fav) {
        fav.favorite = !!m.favorite;
        fav.updatedAt = new Date().toISOString();
        renderNotebookList();
      }
      return;
    }

    if (m.kind === 'notebook-folder') {
      const moved = store.notebooks[m.notebookId];
      if (moved) {
        moved.folderId = m.folderId && store.folders[m.folderId] ? m.folderId : null;
        moved.updatedAt = new Date().toISOString();
        renderNotebookList();
        if (currentNotebookId === moved.id) renderEditor();
      }
      return;
    }

    const nb = store.notebooks[m.notebookId];
    if (!nb) {
      if (m.notebookId) broadcast('snapshot-request', { notebookId: m.notebookId });
      return;
    }

    if (m.kind === 'notebook-renamed') {
      nb.title = m.title || nb.title;
      nb.updatedAt = new Date().toISOString();
      renderNotebookList();
      if (currentNotebookId === nb.id) renderEditor();
      return;
    }

    if (m.kind === 'pages-replaced' && Array.isArray(m.pages)) {
      const merged=window.INFO1_NOTEBOOK_MERGE.notebook(nb,{...nb,pages:m.pages,_deletedPages:m.deletedPages||{}});
      nb.pages=merged.pages;nb._deletedPages=merged._deletedPages;
      if (!nb.pages.length) nb.pages = [blankPage('Página 1')];
      nb.updatedAt = new Date().toISOString();
      if (currentNotebookId === nb.id) {
        if (m.currentPageId && nb.pages.some(function(p) { return p.id === m.currentPageId; }) && readOnly) currentPageId = m.currentPageId;
        if (!nb.pages.some(function(p) { return p.id === currentPageId; })) currentPageId = nb.pages[0].id;
        renderPages();
        redraw();
      }
      renderNotebookList();
      return;
    }

    if (m.kind === 'page-layout') {
      const layoutPage = nb.pages?.find(p=>p.id===m.pageId);
      if (layoutPage) {
        if (Number.isFinite(Number(m.height))) layoutPage.height = Math.max(INITIAL_PAGE_HEIGHT, Number(m.height));
        if (Number.isFinite(Number(m.zoom))) layoutPage.zoom = clamp(Number(m.zoom), MIN_ZOOM, MAX_ZOOM);
        if (currentNotebookId === nb.id && currentPageId === layoutPage.id) {
          applyCanvasGeometry(layoutPage);
          redraw();
        }
      }
      return;
    }

    if (m.kind === 'page-added' && m.page) {
      if (!Array.isArray(nb.pages)) nb.pages = [];
      if (!nb.pages.some(function(p) { return p.id === m.page.id; })) nb.pages.push(m.page);
      if (currentNotebookId === nb.id) renderPages();
      return;
    }

    if (m.kind === 'page-deleted') {
      nb._deletedPages??={};nb._deletedPages[m.pageId]=m._v;
      nb.pages = (nb.pages || []).filter(function(p) { return p.id !== m.pageId; });
      if (currentNotebookId === nb.id && currentPageId === m.pageId) {
        currentPageId = nb.pages[0] ? nb.pages[0].id : null;
        renderEditor();
      }
      return;
    }

    const page = nb.pages?.find(p=>p.id===m.pageId);
    if (!page) return;
    if (!Array.isArray(page.strokes)) page.strokes = [];

    if (m.kind === 'stroke-start' && m.stroke) {
      const key = nb.id + ':' + page.id + ':' + m.stroke.id;
      remoteDrafts.set(key, JSON.parse(JSON.stringify(m.stroke)));
      if (followMode && (currentNotebookId !== nb.id || currentPageId !== page.id)) openNotebook(nb.id, page.id, true, false);
      redraw();
      return;
    }

    if (m.kind === 'stroke-points') {
      const key = nb.id + ':' + page.id + ':' + m.strokeId;
      const draft = remoteDrafts.get(key);
      if (draft && Array.isArray(m.points)) {
        draft.points.push.apply(draft.points, m.points);
        redraw();
      }
      return;
    }

    if (m.kind === 'stroke-final' && m.stroke && m.stroke.id) {
      const key = nb.id + ':' + page.id + ':' + m.stroke.id;
      remoteDrafts.delete(key);
      const index = page.strokes.findIndex(function(s) { return s.id === m.stroke.id; });
      if (index >= 0) page.strokes[index] = JSON.parse(JSON.stringify(m.stroke));
      else page.strokes.push(JSON.parse(JSON.stringify(m.stroke)));
      page.redoStack = [];
      nb.updatedAt = new Date().toISOString();
      redraw();
      refreshPageManagerPreviews();
      renderNotebookList();
      return;
    }

    if (m.kind === 'stroke-restored' && m.stroke && m.stroke.id) {
      if (!page.strokes.some(function(s) { return s.id === m.stroke.id; })) {
        page.strokes.push(JSON.parse(JSON.stringify(m.stroke)));
      }
      nb.updatedAt = new Date().toISOString();
      redraw();
      refreshPageManagerPreviews();
      renderNotebookList();
      return;
    }

    if (m.kind === 'stroke-end') {
      const key = nb.id + ':' + page.id + ':' + m.strokeId;
      const draft = remoteDrafts.get(key);
      if (draft) {
        if (!page.strokes.some(function(s) { return s.id === draft.id; })) page.strokes.push(draft);
        remoteDrafts.delete(key);
        nb.updatedAt = new Date().toISOString();
        redraw();
        refreshPageManagerPreviews();
        renderNotebookList();
      }
      return;
    }

    if (m.kind === 'stroke-delete' && Array.isArray(m.strokeIds)) {
      page._deletedStrokes??={};for(const id of m.strokeIds)page._deletedStrokes[id]=[page._deletedStrokes[id]||'',m._v].sort().pop();
      const ids = new Set(m.strokeIds);
      page.strokes = page.strokes.filter(function(s) { return !ids.has(s.id); });
      nb.updatedAt = new Date().toISOString();
      redraw();
      refreshPageManagerPreviews();
      renderNotebookList();
      return;
    }

    if (m.kind === 'undo') {
      page._deletedStrokes??={};page._deletedStrokes[m.strokeId]=m._v;
      page.strokes = page.strokes.filter(function(s) { return s.id !== m.strokeId; });
      redraw();
      refreshPageManagerPreviews();
      renderNotebookList();
      return;
    }

    if (m.kind === 'page-cleared') {
      const ids=new Set(m.strokeIds || page.strokes.filter(x=>(x._v||'')<=(m._v||'')).map(x=>x.id));
      page._deletedStrokes??={};for(const id of ids)page._deletedStrokes[id]=[page._deletedStrokes[id]||'',m._v].sort().pop();
      page.strokes = page.strokes.filter(x=>!ids.has(x.id) || (x._v||'')>(m._v||''));
      page.redoStack = [];
      redraw();
      refreshPageManagerPreviews();
      renderNotebookList();
    }
  }

  function enhanceTopicCards() {
    document.querySelectorAll('.topic').forEach(function(card) {
      if (card.dataset.nbEnhanced === '1') return;
      const edit = card.querySelector('[data-edit]');
      const actions = card.querySelector('.actions');
      const title = card.querySelector('.topic-title');
      if (!edit || !actions || !title) return;
      card.dataset.nbEnhanced = '1';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nb-open-card';
      btn.textContent = '📓 Cuaderno';
      btn.dataset.topicId = edit.dataset.edit;
      btn.onclick = function(e) {
        e.stopPropagation();
        createForTopic(edit.dataset.edit, title.textContent.trim());
      };
      actions.appendChild(btn);
    });
  }

  function enhanceTopicModal() {
    const modal = document.getElementById('topicModal');
    if (!modal || document.getElementById('nbModalActions')) return;
    const header = modal.querySelector('.modal-topic-header');
    if (!header) return;
    const row = document.createElement('div');
    row.id = 'nbModalActions';
    row.className = 'nb-actions';
    row.style.marginTop = '10px';
    row.innerHTML =
      '<button id="nbModalOpen" class="nb-btn" type="button">📓 Abrir cuaderno</button>' +
      '<button id="nbModalNew" class="nb-btn" type="button">＋ Nuevo cuaderno</button>';
    header.appendChild(row);

    document.getElementById('nbModalOpen').onclick = function(e) {
      e.stopPropagation();
      try {
        if (typeof currentEdit === 'undefined' || !currentEdit) return;
        const title = document.getElementById('modalTitle').textContent.trim() || currentEdit.id;
        createForTopic(currentEdit.id, title);
        document.getElementById('modalBack') && document.getElementById('modalBack').classList.remove('show');
      } catch (_) {}
    };
    document.getElementById('nbModalNew').onclick = function(e) {
      e.stopPropagation();
      try {
        if (typeof currentEdit === 'undefined' || !currentEdit) return;
        const title = document.getElementById('modalTitle').textContent.trim() || currentEdit.id;
        createNotebook({ topicId: currentEdit.id, title, topicTitle: title });
        document.getElementById('modalBack') && document.getElementById('modalBack').classList.remove('show');
      } catch (_) {}
    };
  }

  function observeApp() {
    let pending = null;
    const observer = new MutationObserver(function(mutations) {
      const relevant = mutations.some(function(m) {
        const target = m.target && m.target.nodeType === 1 ? m.target : null;
        return !(target && target.closest && target.closest('#notebooksView'));
      });
      if (!relevant || pending) return;
      pending = setTimeout(function() {
        pending = null;
        enhanceTopicCards();
        enhanceTopicModal();
      }, 80);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function openFromHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h.startsWith('cuaderno=')) return;
    const params = new URLSearchParams(h);
    const notebookId = params.get('cuaderno');
    const pageId = params.get('pagina');
    if (!notebookId) return;
    const tryOpen = function(attempt) {
      if (getNotebook(notebookId)) {
        openNotebook(notebookId, pageId, followMode, true);
      } else if (attempt < 10) {
        broadcast('snapshot-request', { notebookId });
        setTimeout(function() { tryOpen(attempt + 1); }, 500);
      }
    };
    setTimeout(function() { tryOpen(0); }, 500);
  }

  document.addEventListener('click', function(e) {
    const target = e.target && e.target.closest ? e.target.closest('[data-view],[data-partial]') : null;
    if (!target) return;
    if (target.id === 'nbNavTab' || (target.dataset && target.dataset.view === 'notebooksView')) return;
    clearTopNotebookActive();
  });

  function boot() {
    if (!ensureUi()) {
      setTimeout(boot, 300);
      return;
    }
    observeApp();
    updateFollowButton();
    connectRealtime();
    window.INFO1_NOTEBOOK_MERGE.adopt(ensureStore());
    const flushInk=()=>{
      if(currentDraft&&canvas?.onpointerup)canvas.onpointerup({pointerId:drawPointerId,pointerType:'pen',preventDefault(){}});
      if(inkPersistTimer){clearTimeout(inkPersistTimer);inkPersistTimer=null;persist();}
    };
    window.addEventListener('pagehide',flushInk);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)flushInk();});
    setInterval(connectRealtime, 1200);
    setInterval(updateCloudStatus, 1200);
    window.addEventListener('info1:workspace-changed', function() {
      if (channel && channelClient) {
        try { channelClient.removeChannel(channel); } catch (_) {}
      }
      channel = null;
      channelName = null;
      channelClient = null;
      channelReady = false;
      channelConnecting = false;
      remoteDrafts.clear();
      setTimeout(connectRealtime, 120);
    });
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    window.addEventListener('info1:remote-state-applied', function() {
      window.INFO1_NOTEBOOK_MERGE.adopt(ensureStore());
      renderNotebookList();
      if (currentNotebookId && !currentDraft) {
        if (getNotebook(currentNotebookId)) renderEditor();
        else showList();
      } else if (!currentNotebookId) openFromHash();
    });

    window.INFO1_NOTEBOOKS = {
      createStandalone,
      createForTopic,
      duplicate: duplicateNotebook,
      duplicatePage: duplicatePage,
      renamePage: renamePage,
      redo: redo,
      addImageFiles: addImageFiles,
      pasteImage: pasteImageFromClipboard,
      duplicateImage: duplicateImage,
      deleteImage: deleteImage,
      _bridge: {
        persist: persist,
        broadcast: broadcast,
        deviceId: deviceId,
        cloudContext: cloudContext,
        isChannelReady: function() { return channelReady; },
        getChannel: function() { return channel; },
        currentPage: function() { return getPage(getNotebook(currentNotebookId), currentPageId); },
        mediaAssets: function() { return ensureStore().mediaAssets; },
        currentNotebook: function() { return getNotebook(currentNotebookId); },
        refreshCanvas: function() {
          renderImageLayer();
          requestRedraw();
        },
        refresh: function() {
          renderImageLayer();
          redraw();
          refreshPageManagerPreviews();
          renderNotebookList();
          updateCloudStatus();
        }
      },
      setZoom: function(value) {
        const nb = getNotebook(currentNotebookId);
        const page = getPage(nb, currentPageId);
        if (page) setPageZoom(page, value);
      },
      diagnostics: function() {
        const page = getPage(getNotebook(currentNotebookId), currentPageId);
        return {
          pointerEvents: 'PointerEvent' in window,
          touchPoints: navigator.maxTouchPoints || 0,
          pencilDetected: pencilDetected,
          fingerPanMode: fingerPanMode,
          zoom: page ? page.zoom : null,
          pageHeight: page ? page.height : null,
          scrollY: page ? page.scrollY : null,
          render: Object.assign({}, lastRenderStats),
          canvasBudgetPixels: canvasMemoryBudget(),
          viewport: { width: window.innerWidth, height: window.innerHeight }
        };
      },
      createFolder: function(parentId) { return createFolder(parentId || null); },
      moveToFolder: setNotebookFolder,
      folders: function() { const store = ensureStore(); return store.folderOrder.map(function(id) { return store.folders[id]; }).filter(Boolean); },
      open: openNotebook,
      list: function() { return ensureStore().order.map(function(id) { return ensureStore().notebooks[id]; }).filter(Boolean); },
      get current() { return currentNotebookId; },
      get isDrawing() { return !!currentDraft; },
      setFollow: setFollowMode,
      get follow() { return followMode; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();