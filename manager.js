// manager.js
require('dotenv').config();
const { spawn } = require('child_process');
const IORedis = require('ioredis');
const { createClient } = require('@supabase/supabase-js');

const r = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const WORKER = process.env.WORKER_NAME || 'manager-1';
const MAX = parseInt(process.env.MAX_SESSIONS || '5', 10);

const children = new Map(); // sessionId -> ChildProcess

async function lockSession(id) {
  // 60 sn kilit; heartbeat ile yenileyeceğiz
  const ok = await r.set(`lock:session:${id}`, WORKER, 'NX', 'EX', 60);
  return ok === 'OK';
}
async function touchSession(id) {
  await r.expire(`lock:session:${id}`, 60);
}

function startChild(sessionId) {
  if (children.has(sessionId)) return;
  const child = spawn('node', ['session.js'], {
    env: { ...process.env, SESSION_ID: sessionId },
    stdio: 'inherit'
  });
  children.set(sessionId, child);
  child.on('exit', (code) => {
    children.delete(sessionId);
    // kilidi serbest bırak (isteğe bağlı)
    r.del(`lock:session:${sessionId}`).catch(() => {});
    console.log('[child-exit]', sessionId, code);
  });
}

async function findWork() {
  // pending veya disconnected ve yeniden başlatılması istenenler
  const { data, error } = await sb
    .from('sessions')
    .select('id, status')
    .in('status', ['pending', 'disconnected']);
  if (error) { console.error(error); return; }

  for (const row of data) {
    if (children.size >= MAX) break;
    const id = row.id;
    // Çalışıyor mu?
    if (children.has(id)) { await touchSession(id); continue; }
    // Kilit almayı dene
    if (await lockSession(id)) {
      console.log('[claim]', id, 'by', WORKER);
      // (opsiyonel) claimed_by güncelle
      sb.from('sessions').update({ /* claimed_by: WORKER */ }).eq('id', id).then(()=>{});
      startChild(id);
    }
  }
}

// Heartbeat / temizlik
setInterval(() => {
  for (const id of children.keys()) touchSession(id).catch(()=>{});
}, 20_000);

// Ana döngü
(async function loop() {
  console.log('[manager] boot', WORKER, 'max=', MAX);
  while (true) {
    try { await findWork(); } catch (e) { console.error('[findWork]', e); }
    await new Promise(r => setTimeout(r, 5000));
  }
})();
