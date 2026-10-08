/* Versioned notebook reconciliation. Missing entries are not deletions. */
(() => {
  'use strict';
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  let clock = Date.now(), baseline = null, forcedVersion=null;
  const actor = sessionStorage.getItem('info1-sync-actor') || crypto.randomUUID();
  sessionStorage.setItem('info1-sync-actor', actor);
  const version = () => forcedVersion || String(clock = Math.max(Date.now(), clock + 1)).padStart(16,'0') + ':' + actor;
  const ver = v => v?._v || '';
  const max = (a,b) => (a||'') > (b||'') ? a : b;
  const map = list => Object.fromEntries((list||[]).filter(v=>v?.id).map(v=>[v.id,v]));
  const sig = (v, omit=[]) => JSON.stringify(v, (k,val) => k.startsWith('_') || omit.includes(k) ? undefined : val);
  function deletions(a={},b={}) { const r={...a}; for(const k of Object.keys(b))r[k]=max(r[k],b[k]); return r; }
  function stampList(list, oldList, parent, key, nested) {
    const old=map(oldList), now=map(list);
    parent[key]={...(parent[key]||{})};
    for(const id of Object.keys(old))if(!now[id])parent[key][id]=version();
    for(const item of list||[]) {
      const before=old[item.id];
      if(nested)nested(item,before||{});
      if(!before || sig(item,nested?['strokes','images','redoStack']:[])!==sig(before,nested?['strokes','images','redoStack']:[]))item._v=version();
      else item._v=max(item._v,before._v)||'';
      if(parent[key][item.id] && ver(item)<=parent[key][item.id])item._v=version();
    }
  }
  function stampPage(p,old) {
    p._deletedStrokes=deletions(old._deletedStrokes,p._deletedStrokes);
    p._deletedImages=deletions(old._deletedImages,p._deletedImages);
    stampList(p.strokes,old.strokes,p,'_deletedStrokes');
    stampList(p.images,old.images,p,'_deletedImages');
  }
  function stamp(store, suppliedVersion=null) {
    forcedVersion=suppliedVersion;
    if(!store){forcedVersion=null;return;}
    if(!baseline){adopt(store);forcedVersion=null;return;}
    store._deletedNotebooks=deletions(baseline._deletedNotebooks,store._deletedNotebooks);
    const old=baseline.notebooks||{}, now=store.notebooks||{};
    for(const id of Object.keys(old))if(!now[id])store._deletedNotebooks[id]=version();
    for(const nb of Object.values(now)) {
      const prev=old[nb.id]||{};
      nb._deletedPages=deletions(prev._deletedPages,nb._deletedPages);
      stampList(nb.pages,prev.pages,nb,'_deletedPages',stampPage);
      if(!old[nb.id] || sig(nb,['pages','updatedAt'])!==sig(prev,['pages','updatedAt']))nb._v=version();
      else nb._v=max(nb._v,prev._v)||'';
    }
    store._deletedFolders=deletions(baseline._deletedFolders,store._deletedFolders);
    stampList(Object.values(store.folders||{}),Object.values(baseline.folders||{}),store,'_deletedFolders');
    adopt(store);forcedVersion=null;
  }
  function adopt(store){baseline=clone(store||{}); const scan=v=>{if(!v||typeof v!=='object')return; if(v._v)clock=Math.max(clock,Number(v._v.split(':')[0])||0);for(const [k,x] of Object.entries(v)){if(k.startsWith('_deleted'))for(const t of Object.values(x||{}))clock=Math.max(clock,Number(String(t).split(':')[0])||0);else if(typeof x==='object')scan(x);}};scan(store);}
  function mergeList(a,b,tombstones,nested) {
    const left=map(a),right=map(b),order=[...new Set([...(a||[]).map(x=>x.id),...(b||[]).map(x=>x.id)])];
    return order.map(id=>{
      const x=left[id],y=right[id];let value=x&&y?(nested?nested(x,y):clone(ver(y)>ver(x)?y:x)):clone(x||y);
      return value && (!tombstones[id] || ver(value)>tombstones[id]) ? value : null;
    }).filter(Boolean);
  }
  function mergePage(a,b) {
    const out=clone(ver(b)>ver(a)?b:a);
    out._deletedStrokes=deletions(a._deletedStrokes,b._deletedStrokes);
    out._deletedImages=deletions(a._deletedImages,b._deletedImages);
    out.strokes=mergeList(a.strokes,b.strokes,out._deletedStrokes);
    out.images=mergeList(a.images,b.images,out._deletedImages);
    out.height=Math.max(a.height||0,b.height||0,out.height||0);
    return out;
  }
  function notebook(a,b) {
    if(!a||!b)return clone(a||b);
    const out=clone(ver(b)>ver(a)?b:a);
    out._deletedPages=deletions(a._deletedPages,b._deletedPages);
    out.pages=mergeList(a.pages,b.pages,out._deletedPages,mergePage);
    return out;
  }
  function stores(a={},b={}) {
    const out={...clone(b),...clone(a)};
    out._deletedNotebooks=deletions(a._deletedNotebooks,b._deletedNotebooks);
    out.notebooks={};
    for(const id of new Set([...Object.keys(a.notebooks||{}),...Object.keys(b.notebooks||{})])) {
      const n=notebook(a.notebooks?.[id],b.notebooks?.[id]);
      if(n&&(!out._deletedNotebooks[id]||ver(n)>out._deletedNotebooks[id]))out.notebooks[id]=n;
    }
    out.order=[...new Set([...(a.order||[]),...(b.order||[]),...Object.keys(out.notebooks)])].filter(id=>out.notebooks[id]);
    out.mediaAssets={...(b.mediaAssets||{}),...(a.mediaAssets||{})};
    out._deletedFolders=deletions(a._deletedFolders,b._deletedFolders);
    out.folders=map(mergeList(Object.values(a.folders||{}),Object.values(b.folders||{}),out._deletedFolders));
    out.folderOrder=[...new Set([...(a.folderOrder||[]),...(b.folderOrder||[])])].filter(id=>out.folders[id]);
    return out;
  }
  function withNotebooks(local,remote){const out=clone(remote||{});out.__notebooksV1=stores(local?.__notebooksV1,remote?.__notebooksV1);return out;}
  // Three-way merge study fields; preserve explicit conflicts for the existing UI.
  function state(base,local,remote) {
    const conflicts=[];
    function walk(b,l,r,path){
      if(path==='__notebooksV1')return stores(l,r);
      if(JSON.stringify(l)===JSON.stringify(r))return clone(l);
      if(JSON.stringify(l)===JSON.stringify(b))return clone(r);
      if(JSON.stringify(r)===JSON.stringify(b))return clone(l);
      // Independent finished study sessions are additive. Only merge appends;
      // edits/deletions of an existing session still require conflict handling.
      if(path.endsWith('.sesiones') && Array.isArray(l) && Array.isArray(r) &&
         (b===undefined || Array.isArray(b)) &&
         (b||[]).every(x=>l.some(y=>JSON.stringify(x)===JSON.stringify(y)) && r.some(y=>JSON.stringify(x)===JSON.stringify(y)))) {
        const sessions=new Map();
        for(const entry of [...l,...r]){
          const key=entry.id || entry.inicio;
          if(!key){conflicts.push(path);return clone(l);}
          const old=sessions.get(key);
          if(!old || Number(entry.ms)>Number(old.ms))sessions.set(key,clone(entry));
        }
        return [...sessions.values()];
      }
      if(path==='__settings.lastSavedAt')return (l||'')>(r||'')?l:r;
      if(l&&r&&typeof l==='object'&&typeof r==='object'&&!Array.isArray(l)&&!Array.isArray(r)){
        const out={};for(const k of new Set([...Object.keys(l),...Object.keys(r)])){const v=walk(b?.[k],l[k],r[k],path?path+'.'+k:k);if(v!==undefined)out[k]=v;}return out;
      }
      conflicts.push(path);return clone(l);
    }
    return {value:walk(base||{},local||{},remote||{},''),conflicts};
  }
  window.INFO1_NOTEBOOK_MERGE={stamp,adopt,notebook,stores,withNotebooks,state,version,clone};
})();
