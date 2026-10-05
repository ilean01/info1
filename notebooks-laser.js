(() => {
  'use strict';

  const DEVICE_KEY = 'info1-notebook-device-v1';
  const OPEN_KEY = 'info1-notebook-open-v1';
  const MODE_KEY = 'info1-notebook-laser-mode-v1';
  const COLOR_KEY = 'info1-notebook-laser-color-v1';
  const WIDTH_KEY = 'info1-notebook-laser-width-v1';
  const POINT_KEY = 'info1-notebook-laser-point-v1';
  const RETURN_KEY = 'info1-notebook-laser-auto-return-v1';
  const CHANNEL_VERSION = 'v1';
  const LOGICAL_WIDTH = 1000;
  const TRAIL_LIFETIME = 1800;
  const POINT_LIFETIME = 450;
  const REMOTE_STALE = 4500;
  const SEND_INTERVAL = 30;

  let active = false;
  let pointerId = null;
  let localSession = null;
  let channel = null;
  let channelClient = null;
  let channelName = null;
  let ready = false;
  let observer = null;
  let tickTimer = null;
  let sendTimer = null;
  let pendingFrame = null;
  let lastSendAt = 0;
  let remoteSessions = new Map();
  let localGhosts = [];

  function api() { return window.INFO1_NOTEBOOKS || null; }
  function bridge() { const a = api(); return a && a._bridge ? a._bridge : null; }
  function collaboration() { return window.INFO1_NOTEBOOK_COLLABORATION || null; }

  function uuid() {
    return (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'laser-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function deviceId() {
    const b = bridge();
    if (b && b.deviceId) return b.deviceId();
    let id = INFO1_LOCAL.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      INFO1_LOCAL.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function identity() {
    const c = collaboration();
    if (c && typeof c.identity === 'function') return c.identity();
    return { id: deviceId(), name: 'Usuario', device: 'Dispositivo', color: '#ef4444' };
  }

  function cloud() {
    const status = window.INFO1_CLOUD && window.INFO1_CLOUD.status;
    return {
      connected: !!(status && status.connected && window.INFO1_SUPABASE_CLIENT),
      workspaceId: status && status.workspaceId ? status.workspaceId : null,
      client: window.INFO1_SUPABASE_CLIENT || null
    };
  }

  function openInfo() {
    try { return JSON.parse(INFO1_LOCAL.getItem(OPEN_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function currentIds() {
    const a = api();
    const open = openInfo();
    return { notebookId: a && a.current ? a.current : null, pageId: open.pageId || null };
  }

  function editorVisible() {
    const panel = document.getElementById('nbEditorPanel');
    return !!panel && !panel.classList.contains('hidden') && !!document.getElementById('nbCanvasStage');
  }

  function settingMode() {
    return INFO1_LOCAL.getItem(MODE_KEY) === 'trail' ? 'trail' : 'point';
  }

  function settingColor() {
    const v = INFO1_LOCAL.getItem(COLOR_KEY) || '#ff2d55';
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#ff2d55';
  }

  function settingWidth() {
    return clamp(Number(INFO1_LOCAL.getItem(WIDTH_KEY)) || 7, 2, 24);
  }

  function settingPoint() {
    return clamp(Number(INFO1_LOCAL.getItem(POINT_KEY)) || 22, 8, 72);
  }

  function autoReturn() {
    // Compatibilidad con diagnósticos antiguos: el láser ahora es siempre persistente.
    return false;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function topic(workspaceId) {
    return 'info1-notebook-laser-' + CHANNEL_VERSION + '-' + workspaceId;
  }

  function disconnect() {
    const c = cloud();
    if (channel && channelClient) {
      try { channelClient.removeChannel(channel); } catch (_) {}
    }
    channel = null;
    channelName = null;
    ready = false;
    updateStatus();
  }

  function connect() {
    const c = cloud();
    if (!c.connected || !c.workspaceId || !c.client || !navigator.onLine) {
      if (ready || channel) disconnect();
      return;
    }
    const wanted = topic(c.workspaceId);
    if (channel && channelClient === c.client && channelName === wanted) return;
    disconnect();
    channelName = wanted;
    channelClient = c.client;
    channel = c.client.channel(wanted, { config: { broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'laser' }, msg => handleRemote(msg && msg.payload ? msg.payload : {}))
      .subscribe(status => {
        ready = status === 'SUBSCRIBED';
        updateStatus();
      });
  }

  function send(kind, payload) {
    if (!ready || !channel || !navigator.onLine) return false;
    const me = identity();
    const body = Object.assign({
      kind,
      deviceId: deviceId(),
      name: me.name || 'Usuario',
      device: me.device || 'Dispositivo',
      at: Date.now()
    }, payload || {});
    try {
      channel.send({ type: 'broadcast', event: 'laser', payload: body });
      return true;
    } catch (_) {
      return false;
    }
  }

  function logicalPoint(e) {
    const stage = document.getElementById('nbCanvasStage');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = rect.width / LOGICAL_WIDTH;
    return {
      x: clamp((e.clientX - rect.left) / scale, 0, LOGICAL_WIDTH),
      y: Math.max(0, (e.clientY - rect.top) / scale),
      pressure: Number.isFinite(e.pressure) ? e.pressure : 0.5,
      pointerType: e.pointerType || 'mouse'
    };
  }

  function stageMetrics() {
    const stage = document.getElementById('nbCanvasStage');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return null;
    const scale = rect.width / LOGICAL_WIDTH;
    return { stage, rect, scale, logicalHeight: Math.max(1, rect.height / scale) };
  }

  function ensureStyles() {
    if (document.getElementById('nbLaserStyles')) return;
    const style = document.createElement('style');
    style.id = 'nbLaserStyles';
    style.textContent =
      '.nb-laser-hit{position:absolute;inset:0;z-index:80;pointer-events:none;touch-action:none;background:transparent;cursor:crosshair}' +
      '.nb-laser-hit.active{pointer-events:auto}' +
      '.nb-laser-layer{position:absolute;inset:0;z-index:79;pointer-events:none;overflow:visible}' +
      '.nb-laser-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}' +
      '.nb-laser-dot{position:absolute;border-radius:999px;transform:translate(-50%,-50%);pointer-events:none;box-shadow:0 0 0 2px #fff,0 0 18px currentColor,0 0 34px currentColor;transition:opacity .18s linear}' +
      '.nb-laser-label{position:absolute;transform:translate(14px,12px);padding:3px 7px;border-radius:7px;background:#09101fe8;color:#fff;border:1px solid #ffffff35;font:800 10px/1.15 system-ui;white-space:nowrap;box-shadow:0 4px 14px #0008;pointer-events:none}' +
      '.nb-laser-control{display:inline-flex;gap:5px;align-items:center}' +
      '.nb-laser-control input[type=color]{width:42px;height:38px;padding:3px;border-radius:9px;border:1px solid #38527d;background:#0b152a}' +
      '.nb-laser-control input[type=range]{width:92px}' +
      '.nb-laser-control select{min-height:38px}' +
      '.nb-laser-status{font:800 11px system-ui;padding:5px 8px;border-radius:999px;border:1px solid #38527d;background:#0c1830;color:#bcd2ff}' +
      '.nb-laser-status.ready{color:#8ef0c8;border-color:#2f8f67}.nb-laser-status.offline{color:#ffb2b9;border-color:#a44b55}' +
      '.nb-qtool.nb-laser-quick.active{background:#7f1d2d!important;border-color:#ff6b81!important;box-shadow:0 0 0 2px #ff4d6d44,0 0 18px #ff2d5555!important}' +
      '@media(max-width:900px){.nb-laser-control .nb-laser-long{display:none}.nb-laser-control input[type=range]{width:72px}}';
    document.head.appendChild(style);
  }

  function ensureLayers() {
    const metrics = stageMetrics();
    if (!metrics) return null;
    const stage = metrics.stage;
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';

    let layer = document.getElementById('nbLaserLayer');
    if (!layer || layer.parentNode !== stage) {
      if (layer) layer.remove();
      layer = document.createElement('div');
      layer.id = 'nbLaserLayer';
      layer.className = 'nb-laser-layer';
      stage.appendChild(layer);
    }

    let hit = document.getElementById('nbLaserHit');
    if (!hit || hit.parentNode !== stage) {
      if (hit) hit.remove();
      hit = document.createElement('div');
      hit.id = 'nbLaserHit';
      hit.className = 'nb-laser-hit';
      stage.appendChild(hit);
      bindHitLayer(hit);
    }
    hit.classList.toggle('active', active);
    return { layer, hit };
  }

  function bindHitLayer(hit) {
    hit.addEventListener('pointerdown', e => {
      if (!active || pointerId !== null) return;
      const p = logicalPoint(e);
      const ids = currentIds();
      if (!p || !ids.notebookId || !ids.pageId) return;
      pointerId = e.pointerId;
      try { hit.setPointerCapture(e.pointerId); } catch (_) {}
      const me = identity();
      localSession = {
        sessionId: uuid(),
        deviceId: deviceId(),
        notebookId: ids.notebookId,
        pageId: ids.pageId,
        mode: settingMode(),
        color: settingColor(),
        width: settingWidth(),
        pointSize: settingPoint(),
        name: me.name || 'Usuario',
        device: me.device || 'Dispositivo',
        points: [p],
        active: true,
        startedAt: Date.now(),
        updatedAt: Date.now()
      };
      send('laser-start', compactSession(localSession, [p]));
      renderAll();
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    hit.addEventListener('pointermove', e => {
      if (!active || e.pointerId !== pointerId || !localSession) return;
      const p = logicalPoint(e);
      if (!p) return;
      localSession.points.push(p);
      if (localSession.points.length > 180) localSession.points.splice(0, localSession.points.length - 180);
      localSession.updatedAt = Date.now();
      queueFrame(p);
      renderAll();
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    const end = e => {
      if (e.pointerId !== pointerId || !localSession) return;
      const p = logicalPoint(e);
      if (p) localSession.points.push(p);
      localSession.active = false;
      localSession.endedAt = Date.now();
      localSession.updatedAt = Date.now();
      flushFrame(true);
      send('laser-end', compactSession(localSession, p ? [p] : []));
      localGhosts.push(localSession);
      localSession = null;
      pointerId = null;
      renderAll();
      try { hit.releasePointerCapture(e.pointerId); } catch (_) {}
      // El láser queda activo para el siguiente gesto. Solo cambia al elegir Lápiz
      // (o al desactivarlo explícitamente con L/Escape).
      e.preventDefault();
      e.stopPropagation();
    };

    hit.addEventListener('pointerup', end, { passive: false });
    hit.addEventListener('pointercancel', end, { passive: false });
  }

  function compactSession(session, points) {
    return {
      sessionId: session.sessionId,
      notebookId: session.notebookId,
      pageId: session.pageId,
      mode: session.mode,
      color: session.color,
      width: session.width,
      pointSize: session.pointSize,
      points: points || [],
      active: session.active
    };
  }

  function queueFrame(point) {
    if (!localSession) return;
    if (!pendingFrame || pendingFrame.sessionId !== localSession.sessionId) {
      pendingFrame = { sessionId: localSession.sessionId, points: [] };
    }
    pendingFrame.points.push(point);
    if (pendingFrame.points.length > 20) pendingFrame.points.splice(0, pendingFrame.points.length - 20);
    const wait = Math.max(0, SEND_INTERVAL - (Date.now() - lastSendAt));
    if (!sendTimer) sendTimer = setTimeout(() => flushFrame(false), wait);
  }

  function flushFrame(force) {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (!localSession || !pendingFrame || pendingFrame.sessionId !== localSession.sessionId || !pendingFrame.points.length) {
      pendingFrame = null;
      return;
    }
    const pts = pendingFrame.points.splice(0);
    pendingFrame = null;
    lastSendAt = Date.now();
    send('laser-frame', compactSession(localSession, pts));
    if (force) lastSendAt = Date.now();
  }

  function handleRemote(m) {
    if (!m || m.deviceId === deviceId() || !m.sessionId) return;
    const ids = currentIds();
    if (!ids.notebookId || m.notebookId !== ids.notebookId || m.pageId !== ids.pageId) return;
    const key = m.deviceId + ':' + m.sessionId;
    let s = remoteSessions.get(key);
    if (!s || m.kind === 'laser-start') {
      s = {
        sessionId: m.sessionId,
        deviceId: m.deviceId,
        notebookId: m.notebookId,
        pageId: m.pageId,
        mode: m.mode === 'trail' ? 'trail' : 'point',
        color: /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : '#ff2d55',
        width: clamp(Number(m.width) || 7, 2, 24),
        pointSize: clamp(Number(m.pointSize) || 22, 8, 72),
        name: m.name || 'Otra persona',
        device: m.device || '',
        points: [],
        active: true,
        startedAt: m.at || Date.now(),
        updatedAt: Date.now()
      };
      remoteSessions.set(key, s);
    }
    if (Array.isArray(m.points) && m.points.length) {
      m.points.forEach(p => {
        if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return;
        s.points.push({ x: Number(p.x), y: Number(p.y), pressure: Number(p.pressure) || 0.5, pointerType: p.pointerType || '' });
      });
      if (s.points.length > 220) s.points.splice(0, s.points.length - 220);
    }
    s.updatedAt = Date.now();
    if (m.kind === 'laser-end' || m.active === false) {
      s.active = false;
      s.endedAt = Date.now();
    } else {
      s.active = true;
    }
    renderAll();
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(k => el.setAttribute(k, attrs[k]));
    return el;
  }

  function pointsToPath(points) {
    if (!points || !points.length) return '';
    if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
    let d = 'M ' + points[0].x + ' ' + points[0].y;
    for (let i = 1; i < points.length; i++) d += ' L ' + points[i].x + ' ' + points[i].y;
    return d;
  }

  function renderSession(layer, s, now) {
    if (!s || !s.points || !s.points.length) return;
    const metrics = stageMetrics();
    if (!metrics) return;
    const last = s.points[s.points.length - 1];
    const age = s.active ? 0 : Math.max(0, now - (s.endedAt || s.updatedAt || now));
    const ttl = s.mode === 'trail' ? TRAIL_LIFETIME : POINT_LIFETIME;
    if (!s.active && age >= ttl) return;
    const opacity = s.active ? 1 : clamp(1 - age / ttl, 0, 1);

    if (s.mode === 'trail' && s.points.length > 1) {
      const svg = svgEl('svg', {
        class: 'nb-laser-svg',
        viewBox: '0 0 1000 ' + metrics.logicalHeight,
        preserveAspectRatio: 'none'
      });
      const path = svgEl('path', {
        d: pointsToPath(s.points),
        fill: 'none',
        stroke: s.color,
        'stroke-width': s.width,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
        opacity: String(opacity)
      });
      path.style.filter = 'drop-shadow(0 0 5px ' + s.color + ')';
      svg.appendChild(path);
      layer.appendChild(svg);
    }

    const dot = document.createElement('div');
    dot.className = 'nb-laser-dot';
    dot.style.left = (last.x * metrics.scale) + 'px';
    dot.style.top = (last.y * metrics.scale) + 'px';
    dot.style.width = s.pointSize + 'px';
    dot.style.height = s.pointSize + 'px';
    dot.style.background = s.color;
    dot.style.color = s.color;
    dot.style.opacity = String(opacity);
    layer.appendChild(dot);

    if (s.active || age < 700) {
      const label = document.createElement('div');
      label.className = 'nb-laser-label';
      label.style.left = (last.x * metrics.scale) + 'px';
      label.style.top = (last.y * metrics.scale) + 'px';
      label.style.opacity = String(opacity);
      label.textContent = '🔴 ' + (s.name || 'Usuario') + (s.device ? ' · ' + s.device : '');
      layer.appendChild(label);
    }
  }

  function cleanupSessions(now) {
    remoteSessions.forEach((s, key) => {
      if (s.active && now - (s.updatedAt || 0) > REMOTE_STALE) {
        s.active = false;
        s.endedAt = now;
      }
      const ttl = s.mode === 'trail' ? TRAIL_LIFETIME : POINT_LIFETIME;
      if (!s.active && now - (s.endedAt || 0) > ttl + 250) remoteSessions.delete(key);
    });
    localGhosts = localGhosts.filter(s => {
      const ttl = s.mode === 'trail' ? TRAIL_LIFETIME : POINT_LIFETIME;
      return now - (s.endedAt || 0) <= ttl + 250;
    });
  }

  function renderAll() {
    if (!editorVisible()) return;
    const now = Date.now();
    cleanupSessions(now);
    const hasLaserContent = !!localSession || localGhosts.length > 0 || remoteSessions.size > 0;
    const existing = document.getElementById('nbLaserLayer');
    if (!hasLaserContent) {
      if (existing && existing.childNodes.length) existing.replaceChildren();
      return;
    }
    const layers = ensureLayers();
    if (!layers) return;
    const layer = layers.layer;
    layer.replaceChildren();
    const ids = currentIds();
    localGhosts.forEach(s => { if (s.notebookId === ids.notebookId && s.pageId === ids.pageId) renderSession(layer, s, now); });
    if (localSession && localSession.notebookId === ids.notebookId && localSession.pageId === ids.pageId) renderSession(layer, localSession, now);
    remoteSessions.forEach(s => { if (s.notebookId === ids.notebookId && s.pageId === ids.pageId) renderSession(layer, s, now); });
  }

  function setActive(next, restorePen) {
    next = !!next;
    if (next && !editorVisible()) return;
    active = next;
    if (!active && pointerId !== null) {
      pointerId = null;
      if (localSession) {
        localSession.active = false;
        localSession.endedAt = Date.now();
        send('laser-end', compactSession(localSession, []));
        localGhosts.push(localSession);
        localSession = null;
      }
    }
    const hit = document.getElementById('nbLaserHit');
    if (hit) hit.classList.toggle('active', active);
    syncControls();
    if (!active && restorePen) {
      const pen = document.getElementById('nbPen');
      if (pen && !pen.disabled) pen.click();
    }
  }

  function toggle() { setActive(!active, active); }

  function ensureQuickButton() {
    const tools = document.querySelector('#nbWritingDock .nb-writing-dock-tools');
    if (!tools) return;
    let btn = document.getElementById('nbLaserQuick');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'nbLaserQuick';
      btn.type = 'button';
      btn.className = 'nb-qtool nb-laser-quick';
      btn.title = 'Láser persistente · queda activo hasta elegir Lápiz · atajo L';
      btn.innerHTML = '<span class="ico">🔴</span><span class="txt">Láser</span>';
      const lasso = tools.querySelector('[data-qtool="lasso"]');
      if (lasso && lasso.nextSibling) tools.insertBefore(btn, lasso.nextSibling);
      else tools.appendChild(btn);
      btn.onclick = () => setActive(!active, active);
    }
    btn.classList.toggle('active', active);
  }

  function ensureAdvancedControls() {
    const bar = document.querySelector('#nbEditorPanel .nb-toolbar');
    if (!bar || document.getElementById('nbLaserTool')) return;

    const btn = document.createElement('button');
    btn.id = 'nbLaserTool';
    btn.type = 'button';
    btn.textContent = '🔴 Láser';
    btn.title = 'Láser persistente · queda activo hasta elegir Lápiz (L)';
    btn.onclick = () => setActive(!active, active);

    const wrap = document.createElement('span');
    wrap.className = 'nb-laser-control';
    wrap.innerHTML =
      '<select id="nbLaserMode" aria-label="Modo del láser"><option value="point">● Punto</option><option value="trail">〰 Trazo</option></select>' +
      '<input id="nbLaserColor" type="color" aria-label="Color del láser">' +
      '<label class="small nb-laser-long">Trazo <input id="nbLaserWidth" type="range" min="2" max="24" step="1"></label>' +
      '<label class="small nb-laser-long">Punto <input id="nbLaserPoint" type="range" min="8" max="72" step="1"></label>' +
      '<span class="small nb-laser-long">Permanece activo hasta elegir ✏️ Lápiz</span>' +
      '<span id="nbLaserStatus" class="nb-laser-status">Láser local</span>';

    const modeBtn = document.getElementById('nbMode');
    if (modeBtn) bar.insertBefore(btn, modeBtn);
    else bar.appendChild(btn);
    if (modeBtn) bar.insertBefore(wrap, modeBtn);
    else bar.appendChild(wrap);

    const mode = document.getElementById('nbLaserMode');
    const color = document.getElementById('nbLaserColor');
    const width = document.getElementById('nbLaserWidth');
    const point = document.getElementById('nbLaserPoint');
    mode.value = settingMode();
    color.value = settingColor();
    width.value = String(settingWidth());
    point.value = String(settingPoint());
    mode.onchange = () => INFO1_LOCAL.setItem(MODE_KEY, mode.value === 'trail' ? 'trail' : 'point');
    color.oninput = () => INFO1_LOCAL.setItem(COLOR_KEY, color.value);
    width.oninput = () => INFO1_LOCAL.setItem(WIDTH_KEY, String(clamp(Number(width.value) || 7, 2, 24)));
    point.oninput = () => INFO1_LOCAL.setItem(POINT_KEY, String(clamp(Number(point.value) || 22, 8, 72)));
  }

  function updateStatus() {
    const status = document.getElementById('nbLaserStatus');
    if (!status) return;
    status.classList.remove('ready', 'offline');
    if (!navigator.onLine) {
      status.classList.add('offline');
      status.textContent = active ? '🔴 Láser activo · sin conexión' : 'Láser · sin conexión';
    } else if (ready) {
      status.classList.add('ready');
      status.textContent = active ? '🔴 Láser activo · tiempo real' : 'Láser · tiempo real';
    } else {
      status.textContent = active ? '🔴 Láser activo · local / conectando' : 'Láser · local / conectando';
    }
  }

  function syncControls() {
    const btn = document.getElementById('nbLaserTool');
    if (btn) btn.classList.toggle('active', active);
    const q = document.getElementById('nbLaserQuick');
    if (q) q.classList.toggle('active', active);
    const hit = document.getElementById('nbLaserHit');
    if (hit) hit.classList.toggle('active', active);
    updateStatus();
  }

  function ensureUi() {
    if (!editorVisible()) return;
    ensureStyles();
    ensureAdvancedControls();
    ensureQuickButton();
    ensureLayers();
    syncControls();
  }

  function keyboard(e) {
    if (!editorVisible() || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      setActive(false, true);
      return;
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      setActive(!active, active);
    }
  }

  function contextChanged() {
    const ids = currentIds();
    remoteSessions.forEach((s, key) => {
      if (s.notebookId !== ids.notebookId || s.pageId !== ids.pageId) remoteSessions.delete(key);
    });
    if (localSession && (localSession.notebookId !== ids.notebookId || localSession.pageId !== ids.pageId)) {
      send('laser-end', compactSession(localSession, []));
      localSession = null;
      pointerId = null;
      // Al cambiar de página el modo láser se conserva.
      syncControls();
    }
  }

  function diagnostics() {
    const ids = currentIds();
    return {
      active,
      mode: settingMode(),
      color: settingColor(),
      width: settingWidth(),
      pointSize: settingPoint(),
      autoReturn: autoReturn(),
      realtimeReady: ready,
      online: navigator.onLine,
      notebookId: ids.notebookId,
      pageId: ids.pageId,
      remoteLasers: remoteSessions.size,
      pointerType: localSession && localSession.points.length ? localSession.points[localSession.points.length - 1].pointerType : null
    };
  }

  function boot() {
    ensureStyles();
    connect();
    ensureUi();
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('click', e => {
      const target=e.target&&e.target.closest?e.target.closest('#nbPen,[data-qtool="pen"]'):null;
      if(target&&active){
        // Elegir Lápiz es la acción explícita que termina el modo láser.
        setActive(false,false);
      }
      setTimeout(() => {
        if (!editorVisible()) return;
        ensureUi();
        contextChanged();
      }, 0);
    }, true);
    window.addEventListener('online', () => { connect(); updateStatus(); });
    window.addEventListener('offline', () => { ready = false; updateStatus(); });
    window.addEventListener('resize', () => {
      if (localSession || localGhosts.length || remoteSessions.size) renderAll();
    }, { passive: true });

    // Keep this deliberately light. Pointer and realtime events repaint immediately;
    // this timer only discovers a newly opened editor and expires old laser trails.
    tickTimer = setInterval(() => {
      connect();
      if (!editorVisible()) return;
      ensureUi();
      contextChanged();
      if (localSession || localGhosts.length || remoteSessions.size) renderAll();
    }, 1200);

    window.INFO1_NOTEBOOK_LASER = {
      activate: () => setActive(true, false),
      deactivate: () => setActive(false, true),
      toggle,
      diagnostics,
      get active() { return active; },
      get ready() { return ready; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
