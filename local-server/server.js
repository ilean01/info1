'use strict';
// INFO 1 local backend prototype. Does not alter the existing frontend or Supabase.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const db = new Database(path.join(DATA, 'info1.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS board_events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, board_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS board_events_lookup ON board_events(workspace_id,board_id,created_at);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS imported_browser_backups (
 id TEXT PRIMARY KEY, source_origin TEXT NOT NULL, exported_at TEXT NOT NULL,
 imported_at TEXT NOT NULL, payload TEXT NOT NULL
);
`);
const getWorkspace = db.prepare('SELECT state,revision,updated_at FROM workspaces WHERE id=?');
const putWorkspace = db.prepare(`INSERT INTO workspaces(id,state,revision,updated_at) VALUES(?,?,1,?)
 ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=workspaces.revision+1,updated_at=excluded.updated_at`);
const getBoard = db.prepare('SELECT id,payload,created_at FROM board_events WHERE workspace_id=? AND board_id=? ORDER BY created_at,id LIMIT 5000');
const putEvent = db.prepare('INSERT OR IGNORE INTO board_events(id,workspace_id,board_id,payload,created_at) VALUES(?,?,?,?,?)');
const PORT = Number(process.env.INFO1_PORT || 3030);
const HOST = process.env.INFO1_HOST || '0.0.0.0';
const tokenPath = path.join(DATA, 'access-token');
let TOKEN;
if (process.env.INFO1_TOKEN) TOKEN=process.env.INFO1_TOKEN;
else if (fs.existsSync(tokenPath)) TOKEN=fs.readFileSync(tokenPath,'utf8').trim();
else { TOKEN=crypto.randomBytes(24).toString('hex'); fs.writeFileSync(tokenPath,TOKEN,{mode:0o600,flag:'wx'}); }
const authorized = req => {
  const h=req.headers.authorization || '';
  const supplied=h.startsWith('Bearer ') ? h.slice(7) : '';
  const a=Buffer.from(supplied), b=Buffer.from(TOKEN);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
};
const validId = s => typeof s==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const json = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'null'});res.end(JSON.stringify(data));};
async function body(req) {
  let size=0,chunks=[];
  for await (const chunk of req) {size+=chunk.length;if(size>12*1024*1024)throw Error('Payload too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/health')return json(res,200,{ok:true,mode:'local',database:'sqlite'});
    if(req.method==='GET' && (url.pathname==='/' || url.pathname==='/backup.html')) {
      const file=path.join(__dirname,'backup.html');
      const html=fs.readFileSync(file);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(html);
    }
    if(req.method==='GET' && url.pathname==='/api/backup/download') {
      if(!authorized(req))return json(res,401,{error:'Unauthorized'});
      const filename=url.searchParams.get('file')||'';
      if(!/^backup-[0-9TZ-]+\\.sqlite$/.test(filename))return json(res,400,{error:'Invalid filename'});
      const full=path.join(DATA,filename);
      if(!fs.existsSync(full))return json(res,404,{error:'Backup not found'});
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+filename+'"','Cache-Control':'no-store'});
      return fs.createReadStream(full).pipe(res);
    }
    if(!authorized(req))return json(res,401,{error:'Unauthorized'});
    if(req.method==='POST' && url.pathname==='/api/import-browser-backup'){
      // Store the complete export unchanged. Never merge/overwrite existing study state.
      // The user must explicitly review and migrate records later.
      const data=await body(req);
      if(data?.format!=='info1-browser-complete-v1'||!Array.isArray(data.databases)||!data.localStorage)
        return json(res,400,{error:'Invalid INFO 1 backup'});
      const payload=JSON.stringify(data),id=crypto.createHash('sha256').update(payload).digest('hex');
      db.prepare('INSERT OR IGNORE INTO imported_browser_backups(id,source_origin,exported_at,imported_at,payload) VALUES(?,?,?,?,?)')
        .run(id,String(data.origin||''),String(data.exportedAt||''),new Date().toISOString(),payload);
      return json(res,200,{ok:true,importId:id,bytes:Buffer.byteLength(payload),note:'Archivo preservado sin fusionar ni reemplazar el estado actual'});
    }
    if(req.method==='GET' && url.pathname==='/api/import-browser-backups'){
      const rows=db.prepare('SELECT id,source_origin,exported_at,imported_at,length(payload) AS bytes FROM imported_browser_backups ORDER BY imported_at DESC').all();
      return json(res,200,{backups:rows});
    }
    if(req.method==='GET' && url.pathname==='/api/state'){
      const w=url.searchParams.get('workspace')||'shared';if(!validId(w))return json(res,400,{error:'Invalid workspace'});
      return json(res,200,getWorkspace.get(w)||{state:'{}',revision:0,updated_at:null});
    }
    if(req.method==='PUT' && url.pathname==='/api/state'){
      const v=await body(req),w=v.workspace||'shared';
      if(!validId(w)||!Number.isInteger(v.expectedRevision)||v.expectedRevision<0||typeof v.state!=='object'||v.state===null||Array.isArray(v.state))return json(res,400,{error:'Invalid state'});
      const result=db.transaction(()=>{
        const current=getWorkspace.get(w),revision=current?.revision||0;
        if(revision!==v.expectedRevision)return {conflict:true,revision};
        putWorkspace.run(w,JSON.stringify(v.state),new Date().toISOString());
        return {ok:true,revision:revision+1};
      })();
      return json(res,result.conflict?409:200,result);
    }
    if(req.method==='GET' && url.pathname==='/api/board-events'){
      const w=url.searchParams.get('workspace')||'shared',b=url.searchParams.get('board');
      if(!validId(w)||!validId(b))return json(res,400,{error:'Invalid identifiers'});
      return json(res,200,{events:getBoard.all(w,b).map(r=>({id:r.id,...JSON.parse(r.payload),createdAt:r.created_at}))});
    }
    if(req.method==='POST' && url.pathname==='/api/backup'){
      const file=path.join(DATA,'backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
      await db.backup(file);
      return json(res,200,{ok:true,filename:path.basename(file)});
    }
    return json(res,404,{error:'Not found'});
  }catch(e){return json(res,e.message==='Payload too large'?413:400,{error:e.message});}
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:512*1024});
wss.on('connection',(ws,req)=>{
  const url=new URL(req.url,'http://localhost');
  const workspace=url.searchParams.get('workspace')||'shared',board=url.searchParams.get('board');
  const token=url.searchParams.get('token');
  const a=Buffer.from(token||''),b=Buffer.from(TOKEN);
  if(!validId(workspace)||!validId(board)||a.length!==b.length||!crypto.timingSafeEqual(a,b)){ws.close(1008,'Unauthorized');return;}
  ws.workspace=workspace;ws.board=board;
  ws.on('message',raw=>{
    try {
      const v=JSON.parse(raw.toString());
      if(!validId(v.id)||!['stroke','erase','object','cursor'].includes(v.type))return;
      const msg={id:v.id,type:v.type,data:v.data};
      const serialized=JSON.stringify(msg);
      if(serialized.length>400000)return;
      if(v.type!=='cursor')putEvent.run(v.id,workspace,board,serialized,new Date().toISOString());
      for(const client of wss.clients)if(client.readyState===WebSocket.OPEN&&client.workspace===workspace&&client.board===board&&client!==ws)client.send(serialized);
      ws.send(JSON.stringify({ack:v.id}));
    }catch(e){ws.send(JSON.stringify({error:'Invalid event'}));}
  });
});
server.listen(PORT,HOST,()=>{
  console.log('INFO 1 servidor LAN en puerto '+PORT);
  for(const net of Object.values(os.networkInterfaces()).flat())if(net&&net.family==='IPv4'&&!net.internal)console.log('Red local: http://'+net.address+':'+PORT+'/health');
  console.log('Token local: '+TOKEN+' (guardado en local-server/data/access-token; no compartir públicamente)');
});
