
/* ===== INFO1 v14 · inteligencia de estudio, persistencia y vistas personales ===== */
(function(){
  if(!state.__settings || typeof state.__settings!=="object") state.__settings={};
  if(!state.__examSim || typeof state.__examSim!=="object") state.__examSim={history:[]};
  if(!Array.isArray(state.__examSim.history)) state.__examSim.history=[];

  const _v13Save=save;
  let v14ServerSyncTimer=null,v14LastSyncStatus='',syncBusy=false,syncDirty=false,syncBlocked=!!window.INFO1_BOOT?.error||(location.protocol!=='file:'&&!window.INFO1_BOOT),syncRevision=window.INFO1_BOOT?.revision||0,localSaveFailed=false;
  save=function(){
    state.__settings??={};state.__settings.lastSavedAt=new Date().toISOString();
    try{INFO1_LOCAL.setItem(STORAGE_KEY,JSON.stringify(state));INFO1_LOCAL.setItem(STORAGE_KEY+'-v15-unsynced','1');localSaveFailed=false;}catch(e){localSaveFailed=true;window.INFO1_LOCAL_SAVE_OK=false;}
    window.dispatchEvent(new Event('info1:local-save'));
    syncDirty=true;v14LastSyncStatus=localSaveFailed?' · navegador sin espacio: copia pendiente':' · copia en carpeta pendiente';renderPersistStatus();
    clearTimeout(v14ServerSyncTimer);v14ServerSyncTimer=setTimeout(flushStudyState,400);
  };
  async function flushStudyState(){
  if(syncBusy||!syncDirty||syncBlocked)return;
  // GitHub Pages has no local persistence server. Supabase handles
  // synchronization through cloud-sync.js, so never call /api/state.
  if(location.hostname.endsWith("github.io")){
    syncDirty=false;
    v14LastSyncStatus=' · Supabase activo';
    renderPersistStatus();
    return;
  }
    if(location.protocol==='file:'){v14LastSyncStatus=localSaveFailed?' · ERROR: exportá un backup antes de cerrar':' · navegador guardado; abrí el servidor para la copia en carpeta';renderPersistStatus();return;}
    syncBusy=true;syncDirty=false;
    try{const r=await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,expectedRevision:syncRevision})});
      if(r.status===409){syncBlocked=true;syncDirty=true;v14LastSyncStatus=' · conflicto: otra ventana guardó antes. Tus cambios locales se conservan.';document.getElementById('syncTools').hidden=false;return;}
      if(!r.ok)throw Error('HTTP '+r.status);const result=await r.json();syncRevision=result.revision;if(!syncDirty){try{INFO1_LOCAL.removeItem(STORAGE_KEY+'-v15-unsynced');}catch(e){}}v14LastSyncStatus=localSaveFailed?' · copia en carpeta guardada; navegador sin espacio':' · navegador y carpeta guardados';
    }catch(e){syncDirty=true;v14LastSyncStatus=localSaveFailed?' · NO guardado: exportá un backup antes de cerrar':' · navegador guardado; copia en carpeta pendiente';}
    finally{syncBusy=false;renderPersistStatus();if(syncDirty&&!syncBlocked)v14ServerSyncTimer=setTimeout(flushStudyState,4000);}
  }
  function downloadStateSnapshot(value,name){const blob=new Blob([JSON.stringify({version:15,state:value},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  function normalizeLoadedState(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Progreso inválido');value.__settings??={};value.__examSim??={history:[]};value.__examSim.history??=[];value.__photoTipos??={};value.__flashcards??={};value.__flashcardsP2??={ile:{},elias:{}};value.__flashGameP2??={ile:0,elias:0,turn:'ile'};value.__settings.p2AllUnknownResetV143=true;return value;}
  function applyLoadedState(value){state=normalizeLoadedState(value);activeP2Profile=state.__settings.p2Profile==='elias'?'elias':'ile';switchPartial(state.__settings.activePartial||'p1',{persist:false,render:true});renderP2Flashcard();renderDuel();renderWritten();save();}
  async function restoreAutoState(){
    if(location.protocol==='file:')return alert('Abrí el servidor para recuperar la copia de la carpeta.');
    try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error();const obj=await r.json();if(!obj.state)return alert('Todavía no hay una copia en la carpeta.');
      if(!confirm('¿Recuperar la copia de '+fmtShortDate(obj.savedAt)+'? Se descargará antes una copia del progreso actual. Las fotos se conservan.'))return;
      downloadStateSnapshot(state,'info1_antes_de_recuperar.json');syncRevision=obj.revision||0;syncBlocked=false;applyLoadedState(obj.state);
    }catch(e){alert('No se pudo recuperar la copia. No se modificó el progreso.');}
  }
  async function showStateHistory(){
    const root=document.getElementById('versionHistory');
    root.hidden=false;
    root.textContent='Cargando copias de estudio…';
    const sb=window.INFO1_SUPABASE_CLIENT;
    const workspaceId=window.INFO1_CLOUD?.status?.workspaceId;
    if(!sb || !workspaceId){
      root.textContent='Conectá tu cuenta a Supabase para consultar las copias históricas. Podés exportar un backup completo desde Ajustes.';
      return;
    }
    try {
      const {data,error}=await sb.from('info1_state_history')
        .select('revision,captured_at')
        .eq('workspace_id',workspaceId)
        .order('captured_at',{ascending:false}).limit(40);
      if(error)throw error;
      root.replaceChildren();
      const heading=document.createElement('h3');heading.textContent='Copias históricas de estudio';
      const detail=document.createElement('p');
      detail.textContent='Se crea una copia de fichas y progreso como máximo cada 5 minutos; se conservan hasta 40. Las pizarras y fotos no forman parte de estas versiones y no se reemplazan al restaurar.';
      root.append(heading,detail);
      if(!data?.length){
        const empty=document.createElement('p');empty.textContent='Todavía no hay copias históricas.';
        root.appendChild(empty);return;
      }
      for(const version of data){
        const button=document.createElement('button');
        button.textContent='Versión '+version.revision+' · '+fmtShortDate(version.captured_at);
        button.onclick=async()=>{
          if(!confirm('¿Recuperar este progreso? Se descargará primero un backup completo del estado local. Los cuadernos se mantendrán como están.'))return;
          button.disabled=true;
          try{
            const {data:backup,error:readError}=await sb.from('info1_state_history')
              .select('state,revision')
              .eq('workspace_id',workspaceId).eq('revision',version.revision).single();
            if(readError||!backup?.state)throw readError||new Error('No se encontró la versión');
            downloadStateSnapshot(state,'info1_antes_de_restaurar.json');
            // La copia histórica no incluye dibujos: conservar siempre los actuales.
            const restored=Object.assign({},backup.state,{
              __notebooksV1:state.__notebooksV1
            });
            applyLoadedState(restored);
            root.hidden=true;
            alert('Progreso restaurado localmente. Comprobá el indicador de guardado en la nube antes de cerrar.');
          }catch(e){alert('No se restauró el historial: '+(e?.message||'error desconocido'));}
          finally{button.disabled=false;}
        };
        root.appendChild(button);
      }
    }catch(e){root.textContent='No se pudo consultar el historial: '+(e?.message||'error desconocido');}
  }
  function fmtShortDate(iso){
    if(!iso)return "—";const d=parseLocalDateValue(iso);if(Number.isNaN(d.getTime()))return "—";
    if(typeof iso==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(iso))return d.toLocaleDateString("es-PY",{day:"2-digit",month:"2-digit",year:"numeric"});
    return d.toLocaleString("es-PY",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  }
  function renderPersistStatus(){
    const saveEl=document.getElementById('saveStatus'),back=document.getElementById('lastBackupStatus');
    const storage=window.INFO1_STATE_STORAGE?.status();
    if(saveEl && storage){saveEl.textContent=storage.error?'⚠️ Error al guardar en este dispositivo: '+storage.error:storage.pending?'💾 Guardando en este dispositivo…':'💾 Guardado en este dispositivo';}
    else if(saveEl)saveEl.innerHTML=`<strong>💾 Guardado automático</strong> · ${state.__settings?.lastSavedAt?fmtShortDate(state.__settings.lastSavedAt):"ahora"}${v14LastSyncStatus}`;
    if(back)back.textContent=state.__settings?.lastBackupAt?`Backup: ${fmtShortDate(state.__settings.lastBackupAt)} ✅`:'Backup: todavía no exportado';
  }


  window.addEventListener('info1:storage-status',renderPersistStatus);

  /* Recuperatorio */
  function recoverySettingField(){return activePartial==='p2'?'recoveryDateTimeP2':'recoveryDateTimeP1';}
  function currentRecoveryValue(){return state.__settings?.[recoverySettingField()]||'';}
  function formatRecoveryDate(value){if(!value)return 'Elegí la fecha y hora del recuperatorio.';const d=new Date(value);if(Number.isNaN(d.getTime()))return 'Fecha inválida.';return 'Recuperatorio: '+d.toLocaleString('es-PY',{weekday:'long',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});}
  function updateRecoveryCountdown(){
    const value=currentRecoveryValue(),days=document.getElementById('recoveryDays'),hours=document.getElementById('recoveryHours'),mins=document.getElementById('recoveryMinutes'),st=document.getElementById('recoveryCountdownState'),lab=document.getElementById('recoveryDateLabel');
    if(!days)return;
    if(!value){days.textContent=hours.textContent=mins.textContent='—';st.textContent='Configurá la fecha';lab.textContent=`Elegí la fecha y hora del recuperatorio del ${activePartial==='p2'?'segundo':'primer'} parcial.`;return;}
    const target=new Date(value),diff=target-Date.now();lab.textContent=formatRecoveryDate(value);
    if(!Number.isFinite(diff)){st.textContent='Fecha inválida';return;}
    if(diff<=0){days.textContent='0';hours.textContent='00';mins.textContent='00';st.textContent='Ya llegó';return;}
    const tm=Math.floor(diff/60000);days.textContent=Math.floor(tm/1440);hours.textContent=pad2(Math.floor((tm%1440)/60));mins.textContent=pad2(tm%60);st.textContent='Plan B disponible';
  }
  function saveRecoverySetting(){state.__settings[recoverySettingField()]=document.getElementById('recoveryDateTime').value||'';save();updateRecoveryCountdown();}

  /* Exámenes únicos + radar */
  function uniqueExams(){return EXAM_ARCHIVE.filter(x=>x.page!==15);}
  const RADAR_CATS=['PDA','NPDA','TM','Gramáticas','Potencia','Demostración','Enumeración','Church'];
  function examYear(x){const m=String(x.date).match(/(20\d{2})/);return m?Number(m[1]):0;}
  function radarStats(){
    const rows=uniqueExams();
    return RADAR_CATS.map(cat=>{const hits=rows.filter(x=>x.tags.includes(cat));return {cat,count:hits.length,total:rows.length,last:hits.slice().sort((a,b)=>examYear(b)-examYear(a))[0]?.date||'—'};}).sort((a,b)=>b.count-a.count||a.cat.localeCompare(b.cat));
  }
  function renderRadarMini(){
    const root=document.getElementById('examRadarMini');if(!root)return;
    if(activePartial!=='p2'){root.innerHTML='<div class="small">El radar histórico está preparado para el segundo parcial. En el primero seguí usando prioridad + estado + errores.</div>';return;}
    const arr=radarStats().slice(0,5),mx=Math.max(...arr.map(x=>x.count),1);
    root.innerHTML=arr.map(x=>`<div class="radar-row"><b>${escapeHtml(x.cat)}</b><div class="radar-track"><div class="radar-fill" style="width:${Math.round(x.count/mx*100)}%"></div></div><span class="radar-count">${x.count}/${x.total}</span></div>`).join('');
  }
  function renderExamRadar(){
    const root=document.getElementById('examRadarGrid'),meta=document.getElementById('examUniqueCount');if(!root)return;
    const arr=radarStats(),total=uniqueExams().length;meta.textContent=`${total} exámenes únicos`;
    const descriptions={PDA:'Diseño, variantes de pila, aceptación y comparación de potencia.',NPDA:'No determinismo, diseños y demostraciones formales.',TM:'Definición formal, variantes, simulación y diseños.',Gramáticas:'Construcción, derivaciones y relación con reconocedores.',Potencia:'Inclusiones, equivalencias y restricciones de modelos.',Demostración:'Corrección formal, doble inclusión, contrarrecíproca e invariantes.',Enumeración:'Procedimientos para enumerar FA, PDA, gramáticas o TM.',Church:'Tesis de Church–Turing y noción de algoritmo.'};
    root.innerHTML=arr.map(x=>`<article class="radar-card"><span class="flash-kicker">Historial real</span><strong>${x.count}</strong><h3>${escapeHtml(x.cat)}</h3><p>${descriptions[x.cat]||''}</p><div class="radar-bar"><div style="width:${Math.round(x.count/total*100)}%"></div></div><div class="radar-foot">Apareció en ${x.count} de ${total} exámenes · última aparición registrada: ${escapeHtml(x.last)}</div></article>`).join('');
  }

  /* Recomendaciones */
  function p2BlockForSection(si){return si<=2?'PDA':si<=5?'NPDA':si<=8?'Gramáticas':'TM';}
  function examFreqForSection(si){const cat=p2BlockForSection(si);return radarStats().find(x=>x.cat===cat)?.count||0;}
  function recommendationRows(){
    const rows=[];
    data.forEach((sec,si)=>sec.items.forEach((item,ii)=>{
      const id=idFor(si,ii),shared=getItemState(id),status=topicDisplayStatus(si,ii,id),reasons=[];let score=0;
      if(status==='unknown'){score+=105;reasons.push('🔴 falta base');}
      else if(status==='some'){score+=70;reasons.push('🟡 reforzar');}
      else if(status==='none'){score+=48;reasons.push('⚪ evaluar');}
      if(item[2]==='exam'){score+=36;reasons.push('📝 examen');}
      if(item[2]==='proof'){score+=28;reasons.push('∴ demostración');}
      if(item[2]==='core'){score+=14;reasons.push('🧱 núcleo');}
      if(shared.priority==='urgent'){score+=45;reasons.push('🚨 urgente');}
      else if(shared.priority==='high'){score+=24;reasons.push('⬆️ alta');}
      if(shared.review){score+=22;reasons.push('🔁 repasar');}
      if(shared.practice){score+=24;reasons.push('🧪 practicar');}
      const errs=(shared.errores||[]).length;if(errs){score+=Math.min(30,errs*7);reasons.push(`⚠️ ${errs} error${errs===1?'':'es'}`);}
      if(activePartial==='p2'){
        const f=examFreqForSection(si);score+=f*2.2;if(f>=4)reasons.push(`📡 ${f} exámenes`);
        const a=p2PersonState('ile',si,ii).status,b=p2PersonState('elias',si,ii).status;if(a!==b){score+=12;reasons.push('🤝 nivel distinto');}
      }
      if(status==='known'&&!shared.review&&!shared.practice&&shared.priority==='normal')score-=75;
      rows.push({si,ii,item,id,status,score,reasons});
    }));
    return rows.sort((a,b)=>b.score-a.score||a.si-b.si||a.ii-b.ii);
  }
  function studyNowHtml(rows,limit=5){return rows.slice(0,limit).map((x,i)=>`<div class="study-now-row" data-study-open="${x.si}:${x.ii}"><div class="study-now-rank">${i+1}</div><div><div class="study-now-title">${escapeHtml(x.item[0])}</div><div class="study-now-meta">${x.reasons.slice(0,4).map(r=>`<span class="reason-chip">${escapeHtml(r)}</span>`).join('')}</div></div><span class="study-now-open">Abrir →</span></div>`).join('');}
  function wireStudyRows(root){root?.querySelectorAll('[data-study-open]').forEach(el=>el.onclick=()=>{const [si,ii]=el.dataset.studyOpen.split(':').map(Number);openModal(si,ii);});}
  function renderStudyNow(){
    const rows=recommendationRows(),mini=document.getElementById('studyNowList'),full=document.getElementById('studyNowFull');
    if(mini){mini.innerHTML=studyNowHtml(rows,5);wireStudyRows(mini);}
    if(full){full.innerHTML='';rows.slice(0,20).forEach(x=>full.appendChild(topicCard(x.si,x.ii,x.item)));}
  }

  /* Vistas individuales */
  function p2Entries(){const out=[];dataSecond.forEach((sec,si)=>sec.items.forEach((item,ii)=>out.push({si,ii,item,section:sec.title})));return out;}
  function personCardHtml(profile,x){const st=p2PersonState(profile,x.si,x.ii),other=p2PersonState(profile==='ile'?'elias':'ile',x.si,x.ii);return `<div class="person-topic" data-person-open="${x.si}:${x.ii}"><b>${escapeHtml(x.item[0])}</b><small>${escapeHtml(x.section)} · ${statusLabelShort(st.status)}</small><div class="evaluation-count">${SKILLS.filter(k=>st.skills[k]!=="none").length}/4 habilidades evaluadas</div><div class="pair-note">${profile==='ile'?'Elías':'Ile'}: ${statusLabelShort(other.status)}</div></div>`;}
  function renderPersonView(profile){
    const prefix=profile==='ile'?'ile':'elias',grid=document.getElementById(prefix+'ProgressGrid'),summary=document.getElementById(prefix+'ProgressSummary'),meta=document.getElementById(prefix+'ProgressMeta');if(!grid)return;
    const all=p2Entries(),groups={known:[],some:[],unknown:[],none:[]};all.forEach(x=>groups[p2PersonState(profile,x.si,x.ii).status].push(x));
    meta.textContent=`${groups.known.length} sé · ${groups.some.length} medio · ${groups.unknown.length} no sé`;
    summary.innerHTML=`<div class="flash-stat"><strong>${groups.known.length}</strong><span>🟢 sé</span></div><div class="flash-stat"><strong>${groups.some.length}</strong><span>🟡 más o menos</span></div><div class="flash-stat"><strong>${groups.unknown.length}</strong><span>🔴 no sé</span></div><div class="flash-stat"><strong>${groups.none.length}</strong><span>⚪ sin evaluar</span></div>`;
    const buckets=[['known','🟢 Lo que ya domina'],['unknown','🔴 Lo que necesita aprender'],['some','🟡 Lo que necesita reforzar'],['none','⚪ Todavía sin evaluar']];
    grid.innerHTML=buckets.map(([k,t])=>`<section class="person-bucket"><h3>${t} · ${groups[k].length}</h3><div class="person-topic-list">${groups[k].map(x=>personCardHtml(profile,x)).join('')||'<div class="empty">Vacío</div>'}</div></section>`).join('');
    grid.querySelectorAll('[data-person-open]').forEach(el=>el.onclick=()=>{const [si,ii]=el.dataset.personOpen.split(':').map(Number);switchPartial('p2',{persist:true,render:false});openModal(si,ii);});
  }
  function renderTogetherView(){
    const root=document.getElementById('togetherProgressGrid'),meta=document.getElementById('togetherProgressMeta');if(!root)return;
    const g={both:[],ile:[],elias:[],need:[]};
    p2Entries().forEach(x=>{const a=p2PersonState('ile',x.si,x.ii).status,b=p2PersonState('elias',x.si,x.ii).status;if(a==='known'&&b==='known')g.both.push(x);else if(a==='known'&&b!=='known')g.ile.push(x);else if(b==='known'&&a!=='known')g.elias.push(x);else g.need.push(x);});
    meta.textContent=`${g.both.length} ambos · ${g.need.length} por trabajar`;
    const rows=[['both','🟢 Ambos lo saben'],['ile','👩 Ile puede ayudar a Elías'],['elias','👨 Elías puede ayudar a Ile'],['need','🧩 Los dos necesitan trabajarlo']];
    root.innerHTML=rows.map(([k,title])=>`<section class="together-card"><h3>${title} · ${g[k].length}</h3><div class="person-topic-list">${g[k].map(x=>`<div class="person-topic" data-together-open="${x.si}:${x.ii}"><b>${escapeHtml(x.item[0])}</b><small>Ile ${statusLabelShort(p2PersonState('ile',x.si,x.ii).status)} · Elías ${statusLabelShort(p2PersonState('elias',x.si,x.ii).status)}</small></div>`).join('')||'<div class="empty">Vacío</div>'}</div></section>`).join('');
    root.querySelectorAll('[data-together-open]').forEach(el=>el.onclick=()=>{const [si,ii]=el.dataset.togetherOpen.split(':').map(Number);openModal(si,ii);});
  }

  /* Red de conocimiento */
  let kgProfile='both';
  const KG_POS=[[160,85],[500,85],[840,85],[160,235],[500,235],[840,235],[160,385],[500,385],[840,385],[160,535],[500,535],[840,535]];
  const KG_EDGES=[[0,1],[1,2],[1,3],[3,4],[4,5],[0,6],[6,7],[7,8],[2,8],[5,8],[8,9],[5,9],[9,10],[10,11],[2,11],[5,11]];
  const KG_PRE={0:[],1:[0],2:[0,1],3:[1],4:[3],5:[3,4],6:[0],7:[6],8:[6,7,2,5],9:[8],10:[9],11:[9,10,2,5]};
  function skillNum(v){return v==='known'?1:v==='some'?.5:0;}
  function masteryColor(v){if(v<.03)return '#33435f';if(v<.35)return '#a23c50';if(v<.72)return '#aa8730';return '#2a9c72';}
  function shortSectionTitle(si){const raw=dataSecond[si].title.replace(/^\d+\.\s*/,'');const parts=raw.split('·');return [parts[0].trim(),(parts[1]||'').trim()].filter(Boolean);}
  function sectionMastery(si,profile=kgProfile){let total=0,n=0;for(let ii=0;ii<dataSecond[si].items.length;ii++)for(const k of SKILLS){const a=skillNum(p2PersonState('ile',si,ii).skills[k]),b=skillNum(p2PersonState('elias',si,ii).skills[k]);total+=profile==='both'?Math.min(a,b):profile==='average'?(a+b)/2:profile==='ile'?a:b;n++;}return n?total/n:0;}
  function renderKnowledgeMap(){
    const svg=document.getElementById('knowledgeSvg');if(!svg)return;svg.setAttribute('role','group');
    const mastery=dataSecond.map((_,si)=>sectionMastery(si));
    const edges=KG_EDGES.map(([a,b])=>{const [x1,y1]=KG_POS[a],[x2,y2]=KG_POS[b],m=Math.min(mastery[a],mastery[b]),cls=m>=.65?'active':m>=.3?'partial':'';return `<path class="kg-edge ${cls}" d="M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}"/>`;}).join('');
    const nodes=dataSecond.map((sec,si)=>{const [x,y]=KG_POS[si],m=mastery[si],a=Math.round(sectionMastery(si,'ile')*100),b=Math.round(sectionMastery(si,'elias')*100),[title,desc]=shortSectionTitle(si);return `<g class="kg-node" tabindex="0" role="button" aria-label="${escapeHtml(sec.title)}. Ile ${a}%, Elías ${b}%" data-kg-node="${si}"><circle cx="${x}" cy="${y}" r="56" fill="${masteryColor(m)}"/><text x="${x}" y="${y-16}"><tspan x="${x}">${escapeHtml(title)}</tspan><tspan class="kg-small" x="${x}" dy="16">${escapeHtml(desc.slice(0,21))}</tspan><tspan class="kg-small" x="${x}" dy="16">Ile ${a}% · Elías ${b}%</tspan><tspan class="kg-small" x="${x}" dy="16">${Math.round(m*100)}% ${kgProfile==='both'?'en común':''}</tspan></text></g>`;}).join('');svg.innerHTML=edges+nodes;
    svg.querySelectorAll('[data-kg-node]').forEach(el=>{el.onclick=()=>showKnowledgeNode(+el.dataset.kgNode);el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}};});
  }
  function showKnowledgeNode(si){
    const root=document.getElementById('knowledgeDetail'),pre=KG_PRE[si]||[];root.innerHTML=`<h3>${escapeHtml(dataSecond[si].title)}</h3><p>Antes conviene repasar: ${pre.length?pre.map(i=>escapeHtml(dataSecond[i].title)).join(' · '):'es un bloque de entrada.'}</p><p class="small">Las conexiones son una ruta sugerida de estudio; no bloquean el acceso a ningún tema. “Ambos” muestra lo compartido y “Promedio” combina sus avances.</p><div class="network-topic-grid">${dataSecond[si].items.map((item,ii)=>`<button data-network-topic="${si}:${ii}"><b>${ii+1}. ${escapeHtml(item[0])}</b><span>Ile: ${statusLabelShort(p2PersonState('ile',si,ii).status)} · Elías: ${statusLabelShort(p2PersonState('elias',si,ii).status)}</span></button>`).join('')}</div>`;root.querySelectorAll('[data-network-topic]').forEach(b=>b.onclick=()=>{const [s,i]=b.dataset.networkTopic.split(':').map(Number);openModal(s,i);});
  }

  function prereqLabels(si){const pre=KG_PRE[si]||[];return pre.map(i=>dataSecond[i]?.title).filter(Boolean);}
  function renderStudyGuide(){
    const root=document.getElementById('modalStudyGuide');if(!root||!currentEdit)return;
    const si=currentEdit.si,ii=currentEdit.ii,item=data[si].items[ii];
    if(activePartial!=='p2'){root.innerHTML='<p>Se conserva el material del primer parcial. La ampliación de esta versión corresponde al segundo parcial.</p>';return;}
    const g=TOPIC_GUIDES[si][ii],example=g.example,ex=g.exercise;
    const source=`<p class="source-detail">${escapeHtml(g.source)}<br><a href="/info1/materiales/Hopcroft_referencia.pdf#page=${g.page}" target="_blank" rel="noopener">Abrir referencia en el libro</a></p>`;
    if(guideMode==='learn')root.innerHTML=`<div class="guide-grid"><div class="guide-box"><h5>La idea</h5><p>${escapeHtml(g.explanation)}</p><h5>Cada símbolo importa</h5><p>${escapeHtml(g.notation)}</p>${source}</div><div class="guide-box"><h5>Ejemplo desarrollado</h5><p><b>${escapeHtml(example.q)}</b></p><p class="worked-solution">${escapeHtml(example.a)}</p><p class="small">Ejemplo y explicación elaborados para estudiar este tema; la referencia respalda el concepto.</p></div></div>`;
    else if(guideMode==='practice')root.innerHTML=`<div class="guide-grid"><div class="guide-box"><h5>Ejercicio relacionado</h5><p>${escapeHtml(ex.q)}</p><details class="guide-solution"><summary>Primera pista</summary><p>${escapeHtml(g.hint)}</p></details><details class="guide-solution"><summary>Solución desarrollada</summary><p class="worked-solution">${escapeHtml(ex.a)}</p></details></div><div class="guide-box"><h5>Cómo corregirse · 10 puntos</h5><ol><li>Interpretar las condiciones y símbolos: 2 puntos.</li><li>Dar la construcción, cálculo o argumento pedido: 4 puntos.</li><li>Justificar por qué funciona: 3 puntos.</li><li>Revisar un caso límite o error: 1 punto.</li></ol><p>Compará con la solución. En un ejercicio conceptual, la justificación reemplaza la construcción.</p>${source}<button id="practiceWrittenTopic">Practicar por escrito</button></div></div>`;
    else root.innerHTML=`<div class="guide-box"><h5>Comprobar sin mirar</h5><p>${escapeHtml(example.q)}</p><details><summary>Respuesta para comparar</summary><p>${escapeHtml(example.a)}</p></details><p>${escapeHtml(g.check)}</p><p>Después calificá cada habilidad para Ile y Elías. “Sé” requiere las cuatro en verde; las pendientes siguen visibles.</p></div>`;
    document.getElementById('practiceWrittenTopic')?.addEventListener('click',()=>{closeModal();startWrittenFromTopic(si,ii);});document.querySelectorAll('[data-guide-mode]').forEach(b=>b.classList.toggle('active',b.dataset.guideMode===guideMode));
  }

  /* Simulacro */
  let sim=null,simTicker=null;
  function simPool(){const cat=document.getElementById('simCategory')?.value||'all';let pool=FLASHCARDS_P2.filter(c=>cat==='all'||c.cat===cat);const focused=pool.filter(c=>{const t=c.topic;if(!Array.isArray(t))return false;const tag=dataSecond[t[0]]?.items[t[1]]?.[2];return tag==='exam'||tag==='proof';});return focused.length>=15?focused:pool;}
  function shuffleCopy(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
  function renderSimHistory(){const root=document.getElementById('simHistory');if(!root)return;const rows=(state.__examSim.history||[]).slice().reverse().slice(0,12);root.innerHTML=rows.length?rows.map(x=>`<div class="sim-history-row"><span>${fmtShortDate(x.at)} · ${x.who==='both'?'Juntos':x.who==='ile'?'Ile':'Elías'}</span><b>${x.correct}/${x.total} bien</b><span>${Math.round((x.correct+x.partial*.5)/Math.max(1,x.total)*100)}%</span></div>`).join(''):'<div class="empty">Todavía no hicieron simulacros.</div>';}
  function startSim(){const count=Number(document.getElementById('simCount').value)||10,min=Number(document.getElementById('simMinutes').value)||30,pool=shuffleCopy(simPool()).slice(0,count);if(!pool.length)return alert('No hay preguntas para ese filtro.');sim={cards:pool,index:0,grades:[],who:document.getElementById('simWho').value,start:Date.now(),deadline:Date.now()+min*60000,minutes:min,revealed:false};document.getElementById('simArea').classList.remove('v14-hide');document.getElementById('simFinish').classList.remove('v14-hide');document.getElementById('simStatusBadge').textContent='En curso';clearInterval(simTicker);simTicker=setInterval(updateSimTimer,500);renderSimCard();updateSimTimer();}
  function updateSimTimer(){if(!sim)return;const rem=Math.max(0,sim.deadline-Date.now()),sec=Math.ceil(rem/1000),m=Math.floor(sec/60),s=sec%60;document.getElementById('simTimer').textContent=`${pad2(m)}:${pad2(s)}`;if(rem<=0)finishSim(true);}
  function renderSimCard(){if(!sim)return;const c=sim.cards[sim.index];document.getElementById('simCounter').textContent=`Pregunta ${sim.index+1} / ${sim.cards.length}`;document.getElementById('simScoreLive').textContent=`${sim.grades.length} corregidas` ;document.getElementById('simKicker').textContent=c.cat+' · '+(c.source||'');document.getElementById('simQuestion').textContent=c.q;const ans=document.getElementById('simAnswer');ans.textContent=c.a;ans.classList.toggle('v14-hide',!sim.revealed);document.querySelectorAll('.sim-grade').forEach(b=>b.classList.toggle('v14-hide',!sim.revealed));document.getElementById('simReveal').classList.toggle('v14-hide',sim.revealed);}
  function revealSim(){if(!sim)return;sim.revealed=true;renderSimCard();}
  function gradeSim(level){if(!sim||!sim.revealed)return;const c=sim.cards[sim.index];sim.grades.push(level);if(sim.who!=='both'){p2Store(sim.who)[c.id]=scheduledGrade(p2Store(sim.who)[c.id],level==='correct'?'known':level==='partial'?'some':'again');}sim.index++;sim.revealed=false;save();if(sim.index>=sim.cards.length)finishSim(false);else renderSimCard();}
  function finishSim(timeout){if(!sim)return;clearInterval(simTicker);const total=sim.cards.length,correct=sim.grades.filter(x=>x==='correct').length,partial=sim.grades.filter(x=>x==='partial').length,wrong=total-correct-partial;state.__examSim.history.push({at:new Date().toISOString(),who:sim.who,total,correct,partial,wrong,ms:Date.now()-sim.start,timeout:!!timeout});save();alert(`Simulacro terminado\n\n🟢 ${correct} bien\n🟡 ${partial} parcial\n🔴 ${wrong} mal\n\nPuntaje orientativo: ${Math.round((correct+partial*.5)/Math.max(1,total)*100)}%`);sim=null;document.getElementById('simArea').classList.add('v14-hide');document.getElementById('simStatusBadge').textContent='Listo';renderSimHistory();}

  /* Wrappers de funciones existentes */
  const _v13OpenModal=openModal;
  openModal=function(si,ii){_v13OpenModal(si,ii);guideMode='learn';renderStudyGuide();};
  const _v13RenderAll=renderAll;
  renderAll=function(){_v13RenderAll();renderStudyNow();renderRadarMini();renderExamRadar();if(activePartial==='p2'){renderPersonView('ile');renderPersonView('elias');renderTogetherView();renderKnowledgeMap();}renderPersistStatus();renderSimHistory();};
  const _v13OpenView=openView;
  openView=function(viewId){_v13OpenView(viewId);if(viewId==='studyNowView')renderStudyNow();if(viewId==='ileProgressView')renderPersonView('ile');if(viewId==='eliasProgressView')renderPersonView('elias');if(viewId==='togetherProgressView')renderTogetherView();if(viewId==='knowledgeMapView')renderKnowledgeMap();if(viewId==='examRadarView')renderExamRadar();if(viewId==='examSimView')renderSimHistory();};
  const _v13SwitchPartial=switchPartial;
  switchPartial=function(partial,opts={}){_v13SwitchPartial(partial,opts);const isP2=partial==='p2';['ileProgressTab','eliasProgressTab','togetherProgressTab','knowledgeMapTab','examSimTab','examRadarTab'].forEach(id=>document.getElementById(id)?.classList.toggle('hidden',!isP2));document.getElementById('recoveryDateTime').value=currentRecoveryValue();updateRecoveryCountdown();const active=[...document.querySelectorAll('.view.active')][0]?.id;if(!isP2&&['ileProgressView','eliasProgressView','togetherProgressView','knowledgeMapView','examRadarView','examSimView'].includes(active))openView('boardView');renderRadarMini();};

  /* Export v14, incluyendo todos los nuevos datos porque viven dentro de state */
  document.getElementById('exportBtn').onclick=async()=>{const btn=document.getElementById('exportBtn'),old=btn.textContent;btn.disabled=true;btn.textContent='Preparando…';try{state.__settings.lastBackupAt=new Date().toISOString();save();const photos=await exportPhotosForBackup(),blob=new Blob([JSON.stringify({version:15,exportedAt:new Date().toISOString(),state,photos},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='info1_backup_estudio_completo_v15.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);renderPersistStatus();}finally{btn.disabled=false;btn.textContent=old;}};

  function writtenData(){state.__written??={active:null,history:[]};state.__written.history??=[];return state.__written;}
  function writtenQuestion(key){return WRITTEN_BANK.find(x=>x.id===key);}
  function newWritten(questions,who,minutes){if(writtenData().active&&!confirm('Hay una práctica en curso. ¿Archivarla y comenzar otra?'))return;if(writtenData().active){writtenData().history.push({...writtenData().active,status:'archived'});}writtenData().active={id:uuid(),questions:questions.map(x=>x.id),who,answers:{ile:{},elias:{}},index:0,status:'running',startedAt:new Date().toISOString(),deadline:Date.now()+minutes*60000,remaining:minutes*60000};save();openView('writtenView');renderWritten();}
  function startWritten(){const cat=document.getElementById('writtenCategory').value,chosen=shuffleCopy(WRITTEN_BANK.filter(q=>cat==='all'||q.cat===cat)),n=+document.getElementById('writtenCount').value;newWritten(chosen.slice(0,n),document.getElementById('writtenWho').value,+document.getElementById('writtenMinutes').value);}
  function startWrittenFromTopic(si,ii){const exact=WRITTEN_BANK.find(q=>q.topic[0]===si&&q.topic[1]===ii),pool=WRITTEN_BANK.filter(q=>q.topic[0]===si);if(exact)newWritten([exact],'both',20);else if(pool.length)newWritten(pool.slice(0,3),'both',30);else newWritten(WRITTEN_BANK.filter(q=>q.cat===['PDA','NPDA','Gramáticas','TM'][Math.floor(si/3)]).slice(0,3),'both',30);}
  function writtenAnswer(exam,who,qid){exam.answers[who]??={};exam.answers[who][qid]??={text:'',photos:[],scores:[]};return exam.answers[who][qid];}
  function writtenParticipants(exam){return exam.who==='both'?['ile','elias']:[exam.who];}
  function writtenScore(exam,who){let score=0;for(const id of exam.questions){const q=writtenQuestion(id),a=writtenAnswer(exam,who,id);q.rubric.forEach((r,i)=>{score+=Number(a.scores[i])||0;});}return score;}
  function renderWritten(){
    const root=document.getElementById('writtenWork');if(!root)return;const ex=writtenData().active;
    if(!ex){root.innerHTML='<p>Elegí un bloque y empezá. Las respuestas y las fotos se guardan por persona.</p>';renderWrittenHistory();return;}
    const q=writtenQuestion(ex.questions[ex.index]);if(!q){root.textContent='No se encontró esta pregunta. Exportá el backup para conservar la práctica.';return;}
    const review=ex.status==='review',paused=ex.status==='paused';root.innerHTML=`<div class="written-top"><strong>Pregunta ${ex.index+1} de ${ex.questions.length} · ${escapeHtml(q.cat)}</strong><b id="writtenClock"></b><span>${review?'Corrección':paused?'En pausa':'En curso'}</span></div><h3>${escapeHtml(q.prompt)}</h3><p class="source-detail">${escapeHtml(q.source)} · práctica elaborada para este centro de estudio.</p><div class="written-people">${writtenParticipants(ex).map(w=>{const a=writtenAnswer(ex,w,q.id);return `<section><h4>${w==='ile'?'Ile':'Elías'}</h4><textarea data-written-text="${w}" placeholder="Escribí tu razonamiento, construcción o demostración…" ${review||paused?'readonly':''}>${escapeHtml(a.text)}</textarea><label class="photo-label">Adjuntar foto de la resolución<input type="file" accept="image/*" multiple data-written-photo="${w}" ${review||paused?'disabled':''}></label><div id="writtenPhotos-${w}" class="written-photos"></div>${review?`<h4>Calificación de ${w==='ile'?'Ile':'Elías'}</h4>${q.rubric.map((r,i)=>`<label class="rubric-row">${escapeHtml(r[0])}<select data-score-who="${w}" data-score-index="${i}">${Array.from({length:r[1]+1},(_,n)=>`<option value="${n}" ${Number(a.scores[i]||0)===n?'selected':''}>${n} / ${r[1]}</option>`).join('')}</select></label>`).join('')}`:''}</section>`;}).join('')}</div>${review?`<details class="written-solution"><summary>Solución y justificación</summary><p>${escapeHtml(q.solution)}</p></details><p>Autocorrección con criterios: no hay evaluación automática de texto o fotografías. Calificá a cada persona por separado.</p>`:''}<div class="written-actions"><button id="writtenPrevious" ${ex.index===0?'disabled':''}>Anterior</button><button id="writtenNext" ${ex.index===ex.questions.length-1?'disabled':''}>Siguiente</button><button id="writtenPause" ${review?'hidden':''}>${paused?'Reanudar':'Guardar y pausar'}</button><button id="writtenSubmit">${review?'Guardar resultados y cerrar':'Entregar para corregir'}</button></div>`;
    root.querySelectorAll('[data-written-text]').forEach(el=>el.oninput=()=>{writtenAnswer(ex,el.dataset.writtenText,q.id).text=el.value;save();});
    root.querySelectorAll('[data-written-photo]').forEach(el=>el.onchange=async()=>{const who=el.dataset.writtenPhoto;el.disabled=true;try{for(const file of el.files){if(!file.type.startsWith('image/'))continue;const blob=await compressImageFile(file),photoId=uuid();await putPhotoRecord({photoId,topicId:`p2:${who}:${q.topic[0]}:${q.topic[1]}`,name:'Simulacro · '+file.name,type:blob.type,createdAt:new Date().toISOString(),evidenceType:'progress',blob});writtenAnswer(ex,who,q.id).photos.push(photoId);save();}renderWritten();}catch(e){alert('No se pudo guardar una foto. La respuesta escrita se conserva.');el.disabled=false;}});
    root.querySelectorAll('[data-score-who]').forEach(el=>el.onchange=()=>{writtenAnswer(ex,el.dataset.scoreWho,q.id).scores[+el.dataset.scoreIndex]=+el.value;save();});
    document.getElementById('writtenPrevious').onclick=()=>{ex.index--;save();renderWritten();};document.getElementById('writtenNext').onclick=()=>{ex.index++;save();renderWritten();};
    document.getElementById('writtenPause').onclick=()=>{if(ex.status==='paused'){ex.deadline=Date.now()+ex.remaining;ex.status='running';}else{ex.remaining=Math.max(0,ex.deadline-Date.now());ex.status='paused';}save();renderWritten();};
    document.getElementById('writtenSubmit').onclick=()=>{if(review){ex.finishedAt=new Date().toISOString();ex.status='finished';writtenData().history.push(ex);writtenData().active=null;save();renderWritten();}else if(confirm('¿Entregar? Después se muestran las soluciones y ya no se editan las respuestas.')){ex.remaining=Math.max(0,ex.status==='paused'?ex.remaining:ex.deadline-Date.now());ex.status='review';save();renderWritten();}};
    writtenParticipants(ex).forEach(async who=>{const ids=writtenAnswer(ex,who,q.id).photos;if(!ids.length)return;const rows=await getPhotosForTopic(`p2:${who}:${q.topic[0]}:${q.topic[1]}`).catch(()=>[]);const target=document.getElementById('writtenPhotos-'+who);if(!target||writtenData().active!==ex||ex.questions[ex.index]!==q.id)return;for(const p of rows.filter(r=>ids.includes(r.photoId))){const img=document.createElement('img');img.alt='Resolución de '+who;img.src=await blobToDataURL(p.blob);target.appendChild(img);}});
    updateWrittenClock();renderWrittenHistory();
  }
  function updateWrittenClock(){const ex=writtenData().active,el=document.getElementById('writtenClock');if(!ex)return;const remaining=ex.status==='running'?Math.max(0,ex.deadline-Date.now()):ex.remaining;if(el)el.textContent=formatHMS(remaining);if(ex.status==='running'&&remaining<=0){ex.remaining=0;ex.status='review';save();renderWritten();}}
  function renderWrittenHistory(){const root=document.getElementById('writtenHistory');if(!root)return;root.innerHTML=writtenData().history.slice().reverse().map(ex=>`<button data-exam-review="${ex.id}">${fmtShortDate(ex.finishedAt||ex.startedAt)} · ${ex.status==='archived'?'Archivado sin terminar':writtenParticipants(ex).map(w=>(w==='ile'?'Ile':'Elías')+': '+writtenScore(ex,w)+'/'+(ex.questions.length*10)).join(' · ')} · Ver respuestas</button>`).join('')||'<p>Todavía no hay resultados.</p>';root.querySelectorAll('[data-exam-review]').forEach(b=>b.onclick=()=>{if(writtenData().active)return alert('Pausá y terminá o archivá la práctica actual antes de abrir otra.');const original=writtenData().history.find(x=>x.id===b.dataset.examReview);writtenData().active=JSON.parse(JSON.stringify(original));writtenData().active.id=uuid();writtenData().active.status='review';writtenData().active.index=0;save();renderWritten();});}

  /* Eventos v14 */
  document.getElementById('saveRecoveryDate').onclick=saveRecoverySetting;
  document.getElementById('recoveryDateTime').addEventListener('change',saveRecoverySetting);
  document.getElementById('refreshStudyNow').onclick=renderStudyNow;document.getElementById('refreshStudyNowFull').onclick=renderStudyNow;
  document.getElementById('openExamRadar').onclick=()=>openView(activePartial==='p2'?'examRadarView':'studyNowView');
  document.getElementById('restoreAutoState').onclick=restoreAutoState;
  document.querySelectorAll('[data-kg-profile]').forEach(b=>b.onclick=()=>{kgProfile=b.dataset.kgProfile;document.querySelectorAll('[data-kg-profile]').forEach(x=>x.classList.toggle('active',x===b));renderKnowledgeMap();document.getElementById('knowledgeDetail').textContent='Tocá un nodo para ver dominio, prerrequisitos y qué revisar antes.';});
  document.querySelectorAll('[data-guide-mode]').forEach(b=>b.onclick=()=>{guideMode=b.dataset.guideMode;renderStudyGuide();});
  document.getElementById('simStart').onclick=startSim;document.getElementById('simReveal').onclick=revealSim;document.getElementById('simFinish').onclick=()=>finishSim(false);document.querySelectorAll('[data-sim-grade]').forEach(b=>b.onclick=()=>gradeSim(b.dataset.simGrade));

  /* Ajuste de importación: después de importar, v14 vuelve a crear defaults y conserva todo */


  /* Inicialización visual */
  document.getElementById('recoveryDateTime').value=currentRecoveryValue();
  updateRecoveryCountdown();setInterval(updateRecoveryCountdown,1000);
  renderPersistStatus();renderStudyNow();renderRadarMini();renderExamRadar();renderSimHistory();
  switchPartial(activePartial,{persist:false,render:false});
  renderAll();
  // Written practice is a separate workflow from the existing oral timed quiz.
  const writtenTab=document.createElement('button');writtenTab.className='tab';writtenTab.id='writtenTab';writtenTab.dataset.view='writtenView';writtenTab.textContent='Simulacro escrito';document.getElementById('examSimTab').after(writtenTab);writtenTab.onclick=()=>openView('writtenView');
  const _v15View=openView;openView=function(id){_v15View(id);if(id==='writtenView')renderWritten();};
  const _v15Partial=switchPartial;switchPartial=function(partial,opts={}){_v15Partial(partial,opts);document.getElementById('writtenTab').classList.toggle('hidden',partial!=='p2');if(partial!=='p2'&&document.getElementById('writtenView').classList.contains('active'))openView('boardView');};
  document.getElementById('writtenStart').onclick=startWritten;setInterval(updateWrittenClock,1000);
  document.getElementById('showVersions').onclick=showStateHistory;document.getElementById('retrySync').onclick=()=>{if(syncBlocked){alert('Exportá un backup completo y usá “Recuperar copia Mac” para cargar la versión guardada por la otra ventana. Tus cambios permanecen en este navegador.');return;}syncDirty=true;flushStudyState();};
  document.getElementById('useLocalRecovery').onclick=()=>{let old=V15_LOCAL_RECOVERY;try{old??=JSON.parse(INFO1_LOCAL.getItem(STORAGE_KEY+'-v15-recovery')||'null');}catch(e){}if(!old)return alert('No hay otra copia local pendiente.');if(confirm('¿Recuperar el progreso anterior de este navegador? Se descarga antes una copia del estado actual.')){downloadStateSnapshot(state,'info1_antes_de_recuperar_local.json');applyLoadedState(old);}};
  document.getElementById('syncTools').hidden=!(syncBlocked||V15_LOCAL_RECOVERY);if(location.protocol!=='file:'&&!window.INFO1_BOOT){v14LastSyncStatus=' · reiniciá el servidor para activar el guardado protegido de esta versión';renderPersistStatus();}if(window.INFO1_BOOT?.error){v14LastSyncStatus=' · ERROR al leer la copia; archivo conservado. Exportá tu progreso antes de recuperar.';renderPersistStatus();}
  const sub=document.createElement('select');sub.id='p2FcSection';sub.setAttribute('aria-label','Sección de flashcards');sub.innerHTML='<option value="all">Las 12 secciones</option>'+dataSecond.map((sec,i)=>`<option value="${i}">${escapeHtml(sec.title)} · 50</option>`).join('');document.getElementById('p2FcCategory').after(sub);sub.onchange=()=>{document.getElementById('p2FcCategory').value='all';p2FcIndex=0;renderP2Flashcard();};document.getElementById('p2FcCategory').addEventListener('change',()=>{sub.value='all';p2FcIndex=0;renderP2Flashcard();});
  const dueOption=document.createElement('option');dueOption.value='due';dueOption.textContent='Me toca repasar hoy';document.getElementById('p2FcMode').appendChild(dueOption);
  const dueLabel=document.createElement('div');dueLabel.id='p2DueSummary';document.getElementById('p2FcCard').before(dueLabel);
  const oldP2Render=renderP2Flashcard;renderP2Flashcard=function(){oldP2Render();const store=p2Store(),n=FLASHCARDS_P2.filter(c=>p2Due(store[c.id])).length,c=p2Filtered()[p2FcIndex];dueLabel.textContent=`${activeP2Profile==='ile'?'Ile':'Elías'} · ${n} tarjetas para repasar hoy`+(c&&store[c.id]?.due?' · Esta tarjeta: '+new Date(store[c.id].due).toLocaleString('es-PY'):'');};
  const avg=document.createElement('button');avg.type='button';avg.dataset.kgProfile='average';avg.textContent='Promedio';document.querySelector('[data-kg-profile="both"]').after(avg);avg.onclick=()=>{kgProfile='average';document.querySelectorAll('[data-kg-profile]').forEach(b=>b.classList.toggle('active',b===avg));renderKnowledgeMap();};
  const personalFilters=[];
  for(const who of ['ile','elias']){const grid=document.getElementById(who+'ProgressGrid'),bar=document.createElement('div');bar.className='person-filter';bar.innerHTML='<input type="search" placeholder="Buscar en mis temas…" aria-label="Buscar en el progreso"><select aria-label="Filtrar por estado"><option value="all">Todos los estados</option><option value="known">Sé</option><option value="some">Más o menos</option><option value="unknown">No sé</option><option value="none">Sin evaluar por completo</option></select>';grid.before(bar);const apply=()=>{const query=bar.querySelector('input').value.toLowerCase(),status=bar.querySelector('select').value;grid.querySelectorAll('[data-person-open]').forEach(el=>{const [si,ii]=el.dataset.personOpen.split(':').map(Number);el.hidden=!el.textContent.toLowerCase().includes(query)||(status!=='all'&&p2PersonState(who,si,ii).status!==status);});};personalFilters.push(apply);bar.querySelector('input').oninput=apply;bar.querySelector('select').onchange=apply;}
  document.getElementById('importFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const obj=JSON.parse(await f.text());let source=obj.state||obj;if(obj?.localStorage&&typeof obj.localStorage==='object'){const packed=obj.localStorage[STORAGE_KEY];if(typeof packed==='string'){try{source=JSON.parse(packed)}catch(_){throw Error('El backup del navegador contiene progreso inválido')}}}const candidate=normalizeLoadedState(source);if(!Object.keys(candidate).some(k=>/^\d+:\d+$|^p2:/.test(k)))throw Error('No contiene fichas de estudio');const photos=Array.isArray(obj.photos)?obj.photos:[];for(const p of photos){if(!p?.photoId||!p?.topicId||!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(p.dataUrl||''))throw Error('Foto inválida');dataURLToBlob(p.dataUrl);}if(!confirm('¿Importar este progreso? Se descargará una copia del progreso actual. Las fotos existentes se conservan y se agregan las del backup que falten.'))return;downloadStateSnapshot(state,'info1_antes_de_importar.json');const existing=new Set((await getAllPhotos()).map(p=>p.photoId));for(const p of photos){if(existing.has(p.photoId))continue;await putPhotoRecord({...p,blob:dataURLToBlob(p.dataUrl)});}applyLoadedState(candidate);alert('Backup importado. Se conservaron las fotos existentes. Si la nube marca conflicto, elegí “Mantener este dispositivo” para subir esta copia correcta.');}catch(err){alert('No se completó la importación: '+err.message+'. El progreso anterior no se reemplazó; las fotos que ya se hubieran agregado se conservan.');}finally{e.target.value='';}};
  window.addEventListener('beforeunload',e=>{if(syncDirty&&localSaveFailed){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&syncDirty&&!syncBlocked&&!syncBusy&&location.protocol!=='file:'){flushStudyState();}});
  const renderBeforeFilters=renderAll;renderAll=function(){renderBeforeFilters();personalFilters.forEach(apply=>apply());};
  renderWritten();renderP2Flashcard();switchPartial(activePartial,{persist:false,render:false});if(!window.INFO1_WAS_LOCAL_STATE)save();

  const evidence=document.createElement('section');evidence.className='written-shell';evidence.innerHTML='<h3>Localizar ejercicios en los exámenes</h3><p>El radar resume el archivo histórico; no predice qué va a entrar. Abrí el PDF para leer el enunciado completo. “Parcial” conserva la denominación del documento cuando no especifica primero o segundo.</p><label>Tipo <select id="evidenceKind"><option value="all">Todos</option><option>Segundo parcial</option><option>Recuperatorio</option><option>Parcial</option><option>1.er parcial</option></select></label> <label>Tema <select id="evidenceTopic"><option value="all">Todos</option>'+RADAR_CATS.map(x=>'<option>'+x+'</option>').join('')+'</select></label><div id="evidenceRows"></div>';
  document.getElementById('examRadarGrid').after(evidence);
  const preciseExercises={6:[['1','TM de acceso aleatorio y simulación secuencial'],['2','Enumeración de DFA de ocho estados'],['3','Codificación de funciones o lenguajes'],['4','Tesis de Church']],12:[['1','Diseño de PDA/NPDA y demostración de corrección'],['2','Mezclado perfecto y clausura'],['3','Autómata con alfabeto de pila {0,1} y equivalencia de potencia']],16:[['1','Enumeración de autómatas finitos no deterministas'],['3','Simulación de un FA no determinista mediante TM']],17:[['1','Operación long y clausura de lenguajes regulares'],['2','Diseño de NPDA y prueba de corrección'],['3','Propiedad de un DFA con bucles para un símbolo']]};
  function renderEvidence(){const kind=document.getElementById('evidenceKind').value,tag=document.getElementById('evidenceTopic').value,rows=uniqueExams().filter(x=>(kind==='all'||(kind==='Recuperatorio'?x.kind.startsWith(kind):x.kind===kind))&&(tag==='all'||x.tags.includes(tag)));document.getElementById('evidenceRows').innerHTML=rows.map(x=>`<article class="evidence-row"><h4>${escapeHtml(x.kind)} · ${escapeHtml(x.date)}</h4><p>${escapeHtml(x.topics)}</p>${(preciseExercises[x.page]||[]).map(([n,t])=>`<p><a href="/info1/materiales/examenes_merged.pdf#page=${x.page}" target="_blank" rel="noopener">Página ${x.page} · tema ${n}: ${escapeHtml(t)}</a></p>`).join('')}<a href="/info1/materiales/examenes_merged.pdf#page=${x.page}" target="_blank" rel="noopener">Abrir página ${x.page} completa</a></article>`).join('')||'<p>No hay exámenes con esa combinación.</p>';}
  document.getElementById('evidenceKind').onchange=renderEvidence;document.getElementById('evidenceTopic').onchange=renderEvidence;renderEvidence();

})();


renderToday();
setInterval(renderToday,30000);
