(() => {
  'use strict';

  const STATE_KEY = 'info1-study-center-v4-priority';
  const STORE_KEY = '__notebooksV1';
  const DEVICE_KEY = 'info1-notebook-device-v1';
  const FOLLOW_KEY = 'info1-notebook-follow-v1';
  const OPEN_KEY = 'info1-notebook-open-v1';
  const CHANNEL_VERSION = 'v1';

  let currentNotebookId = null;
  let currentPageId = null;
  let readOnly = false;
  let followMode = localStorage.getItem(FOLLOW_KEY) === '1';
  let channel = null;
  let channelName = null;
  let channelReady = false;
  let currentDraft = null;
  let pointQueue = [];
  let pointFlushTimer = null;
  let remoteDrafts = new Map();
  let resizeObserver = null;
  let canvas = null;
  let ctx = null;

  function uuid() {
    return crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'nb-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function appState() {
    try {
      if (typeof state !== 'undefined' && state && typeof state === 'object') return state;
    } catch (_) {}
    try {
      const value = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function ensureStore() {
    const s = appState();
    if (!s[STORE_KEY] || typeof s[STORE_KEY] !== 'object') {
      s[STORE_KEY] = {
        version: 1,
        channelToken: uuid().replace(/-/g, ''),
        notebooks: {},
        order: [],
        updatedAt: new Date().toISOString()
      };
      persist();
    }
    const store = s[STORE_KEY];
    if (!store.notebooks || typeof store.notebooks !== 'object') store.notebooks = {};
    if (!Array.isArray(store.order)) store.order = Object.keys(store.notebooks);
    if (!store.channelToken) store.channelToken = uuid().replace(/-/g, '');
    return store;
  }

  function persist() {
    const s = appState();
    if (s[STORE_KEY]) s[STORE_KEY].updatedAt = new Date().toISOString();
    try {
      if (typeof save === 'function') {
        save();
      } else {
        localStorage.setItem(STATE_KEY, JSON.stringify(s));
      }
    } catch (e) {
      console.warn('INFO1 cuadernos: no se pudo guardar', e);
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
    return nb.pages.find(p => p.id === pageId) || nb.pages[0] || null;
  }

  function topicNotebookList(topicId) {
    const store = ensureStore();
    return store.order
      .map(id => store.notebooks[id])
      .filter(nb => nb && nb.topicId === topicId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
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
      createdAt,
      updatedAt: createdAt,
      pages: [{
        id: pageId,
        title: 'Página 1',
        createdAt,
        strokes: []
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
    createNotebook({ title: title.trim() || 'Cuaderno libre' });
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
      topicTitle: nb.topicTitle || nb.title.split(' · ')[0]
    });
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
    const p = {
      id: uuid(),
      title: 'Página ' + ((nb.pages || []).length + 1),
      createdAt: new Date().toISOString(),
      strokes: []
    };
    if (!Array.isArray(nb.pages)) nb.pages = [];
    nb.pages.push(p);
    nb.updatedAt = new Date().toISOString();
    currentPageId = p.id;
    persist();
    broadcast('page-added', { notebookId: nb.id, page: p });
    renderEditor();
    sendFocus();
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
    const removed = page.strokes.pop();
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('undo', { notebookId: nb.id, pageId: page.id, strokeId: removed.id });
    redraw();
  }

  function clearPage() {
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    if (!page || readOnly || !page.strokes || !page.strokes.length) return;
    if (!confirm('¿Borrar todos los trazos de esta página?')) return;
    page.strokes = [];
    nb.updatedAt = new Date().toISOString();
    persist();
    broadcast('page-cleared', { notebookId: nb.id, pageId: page.id });
    redraw();
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
      '.nb-grid{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:12px}' +
      '@media(max-width:1050px){.nb-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.nb-grid{grid-template-columns:1fr}}' +
      '.nb-card{border:1px solid var(--line);background:#0d1730;border-radius:16px;padding:14px;display:grid;gap:8px}' +
      '.nb-card h3{margin:0;font-size:16px}.nb-card .meta{font-size:12px;color:var(--muted)}.nb-card .row{display:flex;gap:7px;flex-wrap:wrap}' +
      '.nb-topic-btn{margin-left:auto}' +
      '.nb-editor{display:grid;gap:12px}' +
      '.nb-editor-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}' +
      '.nb-title-wrap{min-width:220px;flex:1}.nb-title-wrap h2{margin:0 0 4px;font-size:clamp(22px,3vw,34px)}' +
      '.nb-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid var(--line);background:#0c1529;border-radius:14px}' +
      '.nb-toolbar button,.nb-toolbar select,.nb-toolbar input{border:1px solid #3a4d71;background:#111d35;color:#fff;border-radius:9px;padding:8px 9px}' +
      '.nb-toolbar button.active{background:#285499;border-color:#76a7ff}' +
      '.nb-toolbar input[type=color]{width:42px;height:36px;padding:3px}.nb-toolbar input[type=range]{width:110px;padding:0}' +
      '.nb-pages{display:flex;gap:7px;overflow:auto;padding-bottom:3px}.nb-page-tab{white-space:nowrap;border:1px solid var(--line);background:#101a31;color:#cbd5e1;border-radius:999px;padding:7px 10px;font-weight:800}' +
      '.nb-page-tab.active{background:#1b3769;color:#fff;border-color:#5e8de6}' +
      '.nb-canvas-wrap{position:relative;min-height:62vh;border:1px solid #50617b;border-radius:16px;overflow:hidden;background-color:#fff;background-image:linear-gradient(#dbe4f055 1px,transparent 1px),linear-gradient(90deg,#dbe4f055 1px,transparent 1px);background-size:28px 28px;touch-action:none;box-shadow:0 18px 60px #0005}' +
      '#info1NotebookCanvas{display:block;width:100%;height:62vh;min-height:500px;touch-action:none;cursor:crosshair}' +
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
            '<div id="nbList" class="nb-grid" style="margin-top:12px"></div>' +
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

    renderNotebookList();
    enhanceTopicCards();
    enhanceTopicModal();
    return true;
  }

  function openNotebookView() {
    document.querySelectorAll('.tab').forEach(function(b) {
      b.classList.toggle('active', b.dataset && b.dataset.view === 'notebooksView');
    });
    document.querySelectorAll('.view').forEach(function(v) {
      v.classList.toggle('active', v.id === 'notebooksView');
    });
    document.querySelectorAll('.nav-menu[open]').forEach(function(d) { d.removeAttribute('open'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  function renderNotebookList() {
    const root = document.getElementById('nbList');
    if (!root) return;
    const store = ensureStore();
    const items = store.order.map(function(id) { return store.notebooks[id]; }).filter(Boolean);
    if (!items.length) {
      root.innerHTML = '<div class="empty">Todavía no hay cuadernos. Creá uno libre o abrí una ficha y tocá “📓 Cuaderno”.</div>';
      return;
    }

    root.innerHTML = items.map(function(nb) {
      const pageCount = Array.isArray(nb.pages) ? nb.pages.length : 0;
      const strokeCount = (nb.pages || []).reduce(function(n, p) { return n + ((p.strokes || []).length); }, 0);
      return '<article class="nb-card">' +
        '<h3>' + escapeHtml(nb.title) + '</h3>' +
        '<div class="meta">' + (nb.topicId ? '📚 ' + escapeHtml(nb.topicTitle || 'Vinculado a una ficha') + ' · ' : '🗒️ Libre · ') + pageCount + ' pág. · ' + strokeCount + ' trazos</div>' +
        '<div class="meta">Actualizado ' + escapeHtml(dateLabel(nb.updatedAt || nb.createdAt)) + '</div>' +
        '<div class="row">' +
          '<button class="nb-btn primary" data-nb-open="' + escapeHtml(nb.id) + '">Abrir</button>' +
          '<button class="nb-btn" data-nb-link="' + escapeHtml(nb.id) + '">🔗 Link</button>' +
          '<button class="nb-btn danger" data-nb-delete="' + escapeHtml(nb.id) + '">Borrar</button>' +
        '</div>' +
      '</article>';
    }).join('');

    root.querySelectorAll('[data-nb-open]').forEach(function(btn) {
      btn.onclick = function() {
        const nb = getNotebook(btn.dataset.nbOpen);
        openNotebook(nb.id, nb.pages && nb.pages[0] ? nb.pages[0].id : null, false, true);
      };
    });
    root.querySelectorAll('[data-nb-link]').forEach(function(btn) {
      btn.onclick = function() {
        const nb = getNotebook(btn.dataset.nbLink);
        currentNotebookId = nb.id;
        currentPageId = nb.pages && nb.pages[0] ? nb.pages[0].id : null;
        copyLink();
      };
    });
    root.querySelectorAll('[data-nb-delete]').forEach(function(btn) {
      btn.onclick = function() { deleteNotebook(btn.dataset.nbDelete); };
    });
  }

  function openNotebook(id, pageId, remoteReadOnly, announce) {
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
    localStorage.setItem(OPEN_KEY, JSON.stringify({ notebookId: id, pageId: currentPageId }));
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
        '<div class="nb-title-wrap"><h2>' + escapeHtml(nb.title) + '</h2><div class="nb-live ' + (channelReady ? 'ok' : 'warn') + '">' + (channelReady ? '● Tiempo real conectado' : '● Modo local / conectando') + (readOnly ? ' · Solo lectura' : ' · Editando') + '</div></div>' +
        '<div class="nb-actions">' +
          '<button id="nbRename" class="nb-btn" type="button">✏️ Nombre</button>' +
          (nb.topicId ? '<button id="nbAnother" class="nb-btn" type="button">＋ Otro de esta ficha</button>' : '') +
          '<button id="nbCopyLink" class="nb-btn" type="button">🔗 Copiar link</button>' +
        '</div>' +
      '</div>' +
      '<div id="nbPages" class="nb-pages"></div>' +
      '<div class="nb-toolbar">' +
        '<button id="nbPen" class="active" type="button">✏️ Lápiz</button>' +
        '<button id="nbEraser" type="button">🧽 Borrador</button>' +
        '<input id="nbColor" type="color" value="#16264a" aria-label="Color">' +
        '<label class="small">Grosor <input id="nbWidth" type="range" min="1" max="18" value="4"></label>' +
        '<button id="nbUndo" type="button">↶ Deshacer</button>' +
        '<button id="nbClear" type="button">Limpiar página</button>' +
        '<button id="nbAddPage" type="button">＋ Página</button>' +
        '<button id="nbDeletePage" type="button">🗑 Página</button>' +
        '<button id="nbMode" type="button">' + (readOnly ? '🔒 Solo lectura' : '✍️ Editar') + '</button>' +
      '</div>' +
      '<div class="nb-canvas-wrap">' +
        '<canvas id="info1NotebookCanvas"></canvas>' +
        (readOnly ? '<div class="nb-readonly-banner">👀 Solo lectura · viendo en vivo</div>' : '') +
      '</div>';

    document.getElementById('nbBack').onclick = showList;
    document.getElementById('nbRename').onclick = renameNotebook;
    const another = document.getElementById('nbAnother');
    if (another) another.onclick = createAnotherForCurrentTopic;
    document.getElementById('nbCopyLink').onclick = copyLink;
    document.getElementById('nbAddPage').onclick = addPage;
    document.getElementById('nbDeletePage').onclick = deleteCurrentPage;
    document.getElementById('nbUndo').onclick = undo;
    document.getElementById('nbClear').onclick = clearPage;
    document.getElementById('nbMode').onclick = function() {
      if (followMode) {
        followMode = false;
        localStorage.setItem(FOLLOW_KEY, '0');
      }
      readOnly = !readOnly;
      renderEditor();
      updateFollowButton();
      sendFocus();
    };

    let tool = 'pen';
    const pen = document.getElementById('nbPen');
    const eraser = document.getElementById('nbEraser');
    function selectTool(next) {
      tool = next;
      pen.classList.toggle('active', next === 'pen');
      eraser.classList.toggle('active', next === 'eraser');
    }
    pen.onclick = function() { selectTool('pen'); };
    eraser.onclick = function() { selectTool('eraser'); };

    renderPages();
    setupCanvas(function() { return tool; });
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
        currentPageId = btn.dataset.page;
        renderPages();
        redraw();
        sendFocus();
      };
    });
  }

  function setupCanvas(getTool) {
    canvas = document.getElementById('info1NotebookCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resizeCanvas();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(function() {
      resizeCanvas();
      redraw();
    });
    resizeObserver.observe(canvas);

    canvas.onpointerdown = function(e) {
      if (readOnly) return;
      const nb = getNotebook(currentNotebookId);
      const page = getPage(nb, currentPageId);
      if (!nb || !page) return;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      const tool = getTool();
      currentDraft = {
        id: uuid(),
        tool,
        color: document.getElementById('nbColor').value || '#16264a',
        width: Number(document.getElementById('nbWidth').value || 4),
        points: [pointFromEvent(e)]
      };
      pointQueue = [];
      broadcast('stroke-start', {
        notebookId: nb.id,
        pageId: page.id,
        stroke: currentDraft
      });
      redraw();
      e.preventDefault();
    };

    canvas.onpointermove = function(e) {
      if (!currentDraft || readOnly) return;
      const p = pointFromEvent(e);
      const last = currentDraft.points[currentDraft.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.0012) return;
      currentDraft.points.push(p);
      pointQueue.push(p);
      schedulePointFlush();
      redraw();
      e.preventDefault();
    };

    const finish = function(e) {
      if (!currentDraft) return;
      flushPoints();
      const nb = getNotebook(currentNotebookId);
      const page = getPage(nb, currentPageId);
      if (nb && page) {
        if (!Array.isArray(page.strokes)) page.strokes = [];
        page.strokes.push(currentDraft);
        nb.updatedAt = new Date().toISOString();
        persist();
        broadcast('stroke-end', {
          notebookId: nb.id,
          pageId: page.id,
          strokeId: currentDraft.id
        });
      }
      currentDraft = null;
      redraw();
      if (e) e.preventDefault();
    };

    canvas.onpointerup = finish;
    canvas.onpointercancel = finish;
    canvas.onpointerleave = function(e) {
      if (currentDraft && e.buttons === 0) finish(e);
    };
  }

  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))),
      p: typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
    };
  }

  function resizeCanvas() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function drawStroke(stroke) {
    if (!ctx || !canvas || !stroke || !stroke.points || !stroke.points.length) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, Number(stroke.width || 4));
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color || '#16264a';

    const pts = stroke.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    if (pts.length === 1) {
      ctx.lineTo(pts[0].x * w + 0.01, pts[0].y * h + 0.01);
    } else {
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const mx = (prev.x + cur.x) * 0.5 * w;
        const my = (prev.y + cur.y) * 0.5 * h;
        ctx.quadraticCurveTo(prev.x * w, prev.y * h, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x * w, last.y * h);
    }
    ctx.stroke();
    ctx.restore();
  }

  function redraw() {
    if (!ctx || !canvas) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nb = getNotebook(currentNotebookId);
    const page = getPage(nb, currentPageId);
    (page && page.strokes ? page.strokes : []).forEach(drawStroke);
    remoteDrafts.forEach(function(stroke, key) {
      if (key.indexOf((currentNotebookId || '') + ':' + (currentPageId || '') + ':') === 0) drawStroke(stroke);
    });
    if (currentDraft) drawStroke(currentDraft);
  }

  function schedulePointFlush() {
    if (pointFlushTimer) return;
    pointFlushTimer = setTimeout(function() {
      pointFlushTimer = null;
      flushPoints();
    }, 45);
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

  function toggleFollow() {
    followMode = !followMode;
    localStorage.setItem(FOLLOW_KEY, followMode ? '1' : '0');
    updateFollowButton();
    flashStatus(followMode ? '👀 Modo seguir activado' : '✍️ Modo seguir desactivado');
    if (followMode && currentNotebookId) {
      readOnly = true;
      renderEditor();
    }
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
    const token = ensureStore().channelToken;
    return 'info1-notebooks-' + CHANNEL_VERSION + '-' + c.workspaceId + '-' + token;
  }

  function connectRealtime() {
    const sb = window.INFO1_SUPABASE_CLIENT;
    const desired = desiredChannelName();
    if (!sb || !desired) {
      channelReady = false;
      updateCloudStatus();
      return;
    }
    if (channel && channelName === desired) return;

    if (channel) {
      try { sb.removeChannel(channel); } catch (_) {}
      channel = null;
      channelReady = false;
    }

    channelName = desired;
    channel = sb.channel(desired, { config: { broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'nb' }, function(msg) {
        handleRemote(msg && msg.payload ? msg.payload : {});
      })
      .subscribe(function(status) {
        channelReady = status === 'SUBSCRIBED';
        updateCloudStatus();
        if (channelReady && currentNotebookId) sendFocus();
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
    if (!channel || !channelReady) return;
    const body = Object.assign({
      kind,
      deviceId: deviceId(),
      at: Date.now()
    }, payload || {});
    try {
      channel.send({ type: 'broadcast', event: 'nb', payload: body });
    } catch (_) {}
  }

  function sendFocus() {
    const nb = getNotebook(currentNotebookId);
    if (!nb) return;
    broadcast('focus', {
      notebookId: nb.id,
      pageId: currentPageId,
      title: nb.title,
      editing: !readOnly
    });
  }

  function handleRemote(m) {
    if (!m || m.deviceId === deviceId()) return;
    const store = ensureStore();

    if (m.kind === 'focus') {
      if (!store.notebooks[m.notebookId]) {
        broadcast('snapshot-request', { notebookId: m.notebookId });
      }
      if (followMode) {
        if (store.notebooks[m.notebookId]) openNotebook(m.notebookId, m.pageId, true, false);
      } else if (currentNotebookId === m.notebookId && m.pageId && currentPageId !== m.pageId && readOnly) {
        currentPageId = m.pageId;
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
      store.notebooks[m.notebook.id] = m.notebook;
      if (!store.order.includes(m.notebook.id)) store.order.unshift(m.notebook.id);
      renderNotebookList();
      if (followMode || currentNotebookId === m.notebook.id) openNotebook(m.notebook.id, currentPageId || (m.notebook.pages[0] && m.notebook.pages[0].id), true, false);
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
      delete store.notebooks[m.notebookId];
      store.order = store.order.filter(function(id) { return id !== m.notebookId; });
      if (currentNotebookId === m.notebookId) showList();
      renderNotebookList();
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

    if (m.kind === 'page-added' && m.page) {
      if (!Array.isArray(nb.pages)) nb.pages = [];
      if (!nb.pages.some(function(p) { return p.id === m.page.id; })) nb.pages.push(m.page);
      if (currentNotebookId === nb.id) renderPages();
      return;
    }

    if (m.kind === 'page-deleted') {
      nb.pages = (nb.pages || []).filter(function(p) { return p.id !== m.pageId; });
      if (currentNotebookId === nb.id && currentPageId === m.pageId) {
        currentPageId = nb.pages[0] ? nb.pages[0].id : null;
        renderEditor();
      }
      return;
    }

    const page = getPage(nb, m.pageId);
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

    if (m.kind === 'stroke-end') {
      const key = nb.id + ':' + page.id + ':' + m.strokeId;
      const draft = remoteDrafts.get(key);
      if (draft) {
        if (!page.strokes.some(function(s) { return s.id === draft.id; })) page.strokes.push(draft);
        remoteDrafts.delete(key);
        nb.updatedAt = new Date().toISOString();
        redraw();
      }
      return;
    }

    if (m.kind === 'undo') {
      page.strokes = page.strokes.filter(function(s) { return s.id !== m.strokeId; });
      redraw();
      return;
    }

    if (m.kind === 'page-cleared') {
      page.strokes = [];
      redraw();
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
    const observer = new MutationObserver(function() {
      enhanceTopicCards();
      enhanceTopicModal();
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

  function boot() {
    if (!ensureUi()) {
      setTimeout(boot, 300);
      return;
    }
    observeApp();
    updateFollowButton();
    connectRealtime();
    setInterval(connectRealtime, 1200);
    setInterval(updateCloudStatus, 1200);
    openFromHash();

    window.INFO1_NOTEBOOKS = {
      createStandalone,
      createForTopic,
      open: openNotebook,
      list: function() { return ensureStore().order.map(function(id) { return ensureStore().notebooks[id]; }).filter(Boolean); },
      get current() { return currentNotebookId; },
      get follow() { return followMode; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();