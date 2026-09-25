(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const BUCKET = 'info1-photos';
  const CLOUD_CTX_KEY = 'info1-cloud-context-v1';
  const OFFLINE_KEY = 'info1-cloud-offline';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let cachedContext = null;
  let contextPromise = null;

  function apiRoute(input) {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return null;
    let url;
    try { url = new URL(raw, location.origin); } catch { return null; }
    if (url.origin !== location.origin) return null;
    if (url.pathname === '/api/health') return { type:'health', url };
    if (url.pathname === '/api/photos') return { type:'photos', url };
    if (url.pathname === '/api/state') return { type:'state', url };
    if (url.pathname === '/api/state/history') return { type:'state-history', url };
    const m = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
    if (m) return { type:'photo', id:decodeURIComponent(m[1]), url };
    return null;
  }

  function json(data, status=200) {
    return new Response(JSON.stringify(data), {
      status,
      headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
    });
  }

  function readCloudContext() {
    try { return JSON.parse(localStorage.getItem(CLOUD_CTX_KEY) || 'null'); }
    catch { return null; }
  }

  function saveCloudContext(workspaceId, userId) {
    try {
      localStorage.setItem(CLOUD_CTX_KEY, JSON.stringify({workspaceId,userId,updatedAt:new Date().toISOString()}));
    } catch {}
  }

  async function resolveCloudContext() {
    if (localStorage.getItem(OFFLINE_KEY) === '1') return null;
    const sb = window.INFO1_SUPABASE_CLIENT;
    if (!sb) return null;

    const { data, error } = await sb.auth.getSession();
    if (error || !data?.session?.user?.id) return null;
    const user = data.session.user;

    if (cachedContext?.user?.id === user.id && cachedContext?.workspaceId) return cachedContext;

    let workspaceId = readCloudContext()?.workspaceId || null;
    if (!workspaceId) {
      const { data:membership, error:membershipError } = await sb
        .from('info1_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();
      if (membershipError || !membership?.workspace_id) return null;
      workspaceId = membership.workspace_id;
    }

    cachedContext = { sb, workspaceId, user };
    saveCloudContext(workspaceId, user.id);
    return cachedContext;
  }

  async function cloudContext() {
    if (cachedContext?.workspaceId) return cachedContext;
    if (!contextPromise) {
      contextPromise = resolveCloudContext().finally(() => { contextPromise = null; });
    }
    return contextPromise;
  }

  function safeName(value) {
    return String(value || 'foto.jpg')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-zA-Z0-9._-]+/g,'-')
      .replace(/-+/g,'-')
      .slice(0,100) || 'foto.jpg';
  }

  function dataUrlToBlob(dataUrl) {
    const [head, body] = String(dataUrl || '').split(',');
    if (!head || body == null) throw new Error('Imagen inválida');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], {type:mime});
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen'));
      reader.readAsDataURL(blob);
    });
  }

  async function bodyJson(input, init) {
    if (init?.body != null) {
      if (typeof init.body === 'string') return JSON.parse(init.body || '{}');
      if (init.body instanceof Blob) return JSON.parse(await init.body.text());
    }
    if (input instanceof Request) return await input.clone().json();
    return {};
  }

  async function listPhotos(ctx, topicId) {
    let q = ctx.sb.from('info1_photos')
      .select('id,topic_id,storage_path,original_name,mime_type,evidence_type,created_at,created_by')
      .eq('workspace_id', ctx.workspaceId)
      .order('created_at', {ascending:true});
    if (topicId) q = q.eq('topic_id', topicId);
    const {data, error} = await q;
    if (error) throw error;

    const rows = [];
    for (const row of data || []) {
      try {
        const {data:blob, error:downloadError} = await ctx.sb.storage.from(BUCKET).download(row.storage_path);
        if (downloadError) throw downloadError;
        rows.push({
          photoId:row.id,
          topicId:row.topic_id,
          name:row.original_name || 'foto.jpg',
          type:row.mime_type || blob.type || 'image/jpeg',
          createdAt:row.created_at,
          evidenceType:row.evidence_type || 'progress',
          createdBy:row.created_by,
          dataUrl:await blobToDataUrl(blob)
        });
      } catch (e) {
        console.warn('INFO1 photo download skipped', row.id, e);
      }
    }
    return rows;
  }

  async function createPhoto(ctx, payload) {
    if (!payload?.topicId || !payload?.dataUrl) throw new Error('Faltan datos de la foto');
    const id = UUID_RE.test(String(payload.photoId || ''))
      ? String(payload.photoId)
      : (crypto.randomUUID ? crypto.randomUUID() : null);
    if (!id) throw new Error('Este navegador no puede generar un identificador seguro para la foto');

    const blob = dataUrlToBlob(payload.dataUrl);
    const name = safeName(payload.name || 'foto.jpg');
    const path = `${ctx.workspaceId}/${ctx.user.id}/${id}-${name}`;
    const mime = payload.type || blob.type || 'image/jpeg';

    const {error:uploadError} = await ctx.sb.storage.from(BUCKET)
      .upload(path, blob, {contentType:mime, cacheControl:'3600', upsert:false});
    if (uploadError) throw uploadError;

    const row = {
      id,
      workspace_id:ctx.workspaceId,
      topic_id:String(payload.topicId),
      storage_path:path,
      original_name:name,
      mime_type:mime,
      evidence_type:payload.evidenceType || 'progress',
      created_by:ctx.user.id,
      created_at:payload.createdAt || new Date().toISOString()
    };
    const {data, error} = await ctx.sb.from('info1_photos').insert(row).select('id').single();
    if (error) {
      await ctx.sb.storage.from(BUCKET).remove([path]).catch(()=>{});
      throw error;
    }
    return {photoId:data.id};
  }

  async function getPhotoRow(ctx, id) {
    const {data, error} = await ctx.sb.from('info1_photos')
      .select('id,storage_path')
      .eq('workspace_id',ctx.workspaceId)
      .eq('id',id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deletePhoto(ctx, id) {
    if (!UUID_RE.test(String(id || ''))) throw new Error('ID de foto inválido');
    const row = await getPhotoRow(ctx,id);
    if (!row) return;
    const {error:storageError} = await ctx.sb.storage.from(BUCKET).remove([row.storage_path]);
    if (storageError) throw storageError;
    const {error} = await ctx.sb.from('info1_photos')
      .delete()
      .eq('workspace_id',ctx.workspaceId)
      .eq('id',id);
    if (error) throw error;
  }

  async function deleteAllPhotos(ctx) {
    const {data, error} = await ctx.sb.from('info1_photos')
      .select('id,storage_path')
      .eq('workspace_id',ctx.workspaceId);
    if (error) throw error;
    const paths = (data || []).map(r => r.storage_path).filter(Boolean);
    if (paths.length) {
      const {error:storageError} = await ctx.sb.storage.from(BUCKET).remove(paths);
      if (storageError) throw storageError;
    }
    const {error:deleteError} = await ctx.sb.from('info1_photos')
      .delete()
      .eq('workspace_id',ctx.workspaceId);
    if (deleteError) throw deleteError;
  }

  async function patchPhoto(ctx, id, payload) {
    if (!UUID_RE.test(String(id || ''))) throw new Error('ID de foto inválido');
    const type = String(payload?.evidenceType || 'progress');
    const {data, error} = await ctx.sb.from('info1_photos')
      .update({evidence_type:type})
      .eq('workspace_id',ctx.workspaceId)
      .eq('id',id)
      .select('id,evidence_type')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Foto no encontrada');
    return {photoId:data.id,evidenceType:data.evidence_type};
  }

  window.fetch = async function info1Fetch(input, init={}) {
    const route = apiRoute(input);
    if (!route) return nativeFetch(input, init);

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    // The bridge itself being loaded is enough to report health. This avoids
    // hundreds of concurrent 5-second waits from the old photo-preview code.
    if (route.type === 'health') {
      return json({ok:true,provider:'supabase-bridge'});
    }

    // Silence the legacy localhost state sync. cloud-sync.js is the only code
    // that writes study progress to Supabase.
    if (route.type === 'state' && method === 'POST') {
      return json({revision:Date.now(),savedAt:new Date().toISOString(),provider:'cloud-sync'});
    }
    if (route.type === 'state-history' && method === 'GET') {
      return json({versions:[]});
    }
    if (route.type === 'state' && method === 'GET') {
      return json({error:'El progreso se recupera desde Supabase.'},404);
    }

    try {
      const ctx = await cloudContext();
      if (!ctx) {
        if (route.type === 'photos' && method === 'GET') return json([]);
        return json({error:'La nube de INFO 1 todavía no está conectada.'},503);
      }

      if (route.type === 'photos' && method === 'GET') {
        return json(await listPhotos(ctx, route.url.searchParams.get('topicId')));
      }
      if (route.type === 'photos' && method === 'POST') {
        return json(await createPhoto(ctx, await bodyJson(input,init)),201);
      }
      if (route.type === 'photos' && method === 'DELETE') {
        await deleteAllPhotos(ctx);
        return json({ok:true});
      }
      if (route.type === 'photo' && method === 'DELETE') {
        await deletePhoto(ctx,route.id);
        return json({ok:true});
      }
      if (route.type === 'photo' && method === 'PATCH') {
        return json(await patchPhoto(ctx,route.id,await bodyJson(input,init)));
      }
      return json({error:'Método no permitido'},405);
    } catch (e) {
      console.error('INFO1 Supabase media bridge',e);
      return json({error:e?.message || 'Error al sincronizar la foto'},500);
    }
  };

  window.INFO1_MEDIA_BRIDGE_READY = true;
  console.info('INFO1: puente Supabase activo sin API local');
})();