// public/assets/app.js
// Requires: window.supabase, window.ENV_* provided by /config.js

const sb = window.supabase.createClient(window.ENV_SUPABASE_URL, window.ENV_SUPABASE_ANON_KEY);
const token = localStorage.getItem('sb_token');
if(!token){ location.href = '/login.html?next=' + encodeURIComponent('/app'); }

const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type':'application/json' };

const state = { sessions: [], sse:null, recent:[], msgCount:0, selected:null, qrTimer:null };

function setUserPill(email){ document.getElementById('userPill').textContent = email || 'Signed in'; }
(async ()=>{
  try{
    const r = await fetch('/api/me', { headers });
    const j = await r.json();
    if(j?.ok){ setUserPill(j.user?.email || j.user?.id || 'User'); }
    else { setUserPill('User'); }
  }catch{ setUserPill('User'); }
})();

// Navigation
const views = {
  dashboard: document.getElementById('view_dashboard'),
  sessions: document.getElementById('view_sessions'),
  reminders: document.getElementById('view_reminders'),
  subscription: document.getElementById('view_subscription'),
};
function show(view){
  document.querySelectorAll('.menu button').forEach(b=>b.classList.remove('active'));
  document.getElementById('m_'+view).classList.add('active');
  Object.entries(views).forEach(([k,v])=> v.style.display = (k===view? 'block':'none'));
  document.getElementById('crumb').textContent = view.charAt(0).toUpperCase()+view.slice(1);
  if(view==='sessions') loadSessions();
}
document.getElementById('m_dashboard').onclick = ()=>show('dashboard');
document.getElementById('m_sessions').onclick = ()=>show('sessions');
document.getElementById('m_reminders').onclick = ()=>{ populateReminderSessions(); loadReminders(); show('reminders'); };
document.getElementById('m_subscription').onclick = ()=>show('subscription');

// Logout
document.getElementById('logout').onclick = async ()=>{ try{ await sb.auth.signOut(); }catch{} localStorage.removeItem('sb_token'); location.href='/login.html'; };

// Data loaders
async function loadSessions(){
  const r = await fetch('/admin/sessions', { headers });
  const j = await r.json();
  if(!j.ok){ return; }
  const prevId = state.selected?.id || null;
  state.sessions = j.sessions || [];
  renderSessions();
  renderPlan();
  if(prevId){
    const ex = state.sessions.find(x=>x.id===prevId);
    if(ex){ selectSession(prevId); }
  }
}

function renderPlan(){
  const limit = 1; // placeholder plan limit
  const used = state.sessions.length;
  const pct = Math.min(100, Math.round((used/limit)*100));
  document.getElementById('planUsage').textContent = `${used} / ${limit}`;
  document.getElementById('planUsage2').textContent = `${used} of ${limit} WhatsApp sessions used`;
  document.getElementById('planPct').textContent = `${pct}% used`;
  document.getElementById('planProgress').style.width = pct+'%';
  document.getElementById('planProgress2').style.width = pct+'%';
  document.getElementById('dashSessionsEmpty').style.display = used>0 ? 'none':'flex';
}

function pill(status){
  const s = (status||'').toLowerCase();
  if(s==='ready') return '<span class="pill ok">ready</span>';
  if(s==='pending') return '<span class="pill warn">pending</span>';
  if(s==='disconnected') return '<span class="pill bad">disconnected</span>';
  return `<span class="pill">${status||'-'}</span>`;
}

function renderSessions(){
  const list = document.getElementById('sessionList');
  list.innerHTML='';
  const term = (document.getElementById('search').value||'').toLowerCase();
  const filt = (document.getElementById('statusFilter').value||'');
  const rows = state.sessions.filter(s=>
    (!term || s.id.toLowerCase().includes(term) || (s.name||'').toLowerCase().includes(term)) &&
    (!filt || (s.status||'')===filt)
  );
  if(rows.length===0){ list.style.display='none'; document.getElementById('emptySessions').style.display='flex'; }
  else { list.style.display='block'; document.getElementById('emptySessions').style.display='none'; }
  rows.forEach(s=>{
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="row" style="justify-content:space-between; gap:12px">
      <div>
        <div style="font-weight:600">${s.name||s.id}</div>
        <div class="muted" style="font-family:ui-monospace,Menlo,monospace">${s.id}</div>
      </div>
      <div>${pill(s.status)}</div>
    </div>`;
    div.style.cursor = 'pointer';
    div.onclick = () => selectSession(s.id);
    list.appendChild(div);
  });
}

// Session selection and QR helpers
function selectSession(id){
  const s = state.sessions.find(x=>x.id===id);
  if(!s){ return; }
  state.selected = s;
  document.getElementById('sessionDetail').style.display = 'block';
  document.getElementById('selInfo').style.display = 'none';
  document.getElementById('selBody').style.display = 'block';
  document.getElementById('selId').textContent = s.id;
  document.getElementById('selName').textContent = s.name || s.id;
  document.getElementById('selApi').textContent = s.api_key || '';
  document.getElementById('selStatus').innerHTML = pill(s.status);
  // refresh cURL examples for this session
  try{ refreshAllCurlExamples(); }catch{}
}

async function showQR(){
  clearInterval(state.qrTimer);
  const box = document.getElementById('qrBox');
  box.innerHTML = '<span class="muted">Waiting QR…</span>';
  await fetchQROnce();
  state.qrTimer = setInterval(fetchQROnce, 3000);
}

async function fetchQROnce(){
  const s = state.selected;
  if(!s) return;
  try{
    const r = await fetch(`/admin/sessions/${encodeURIComponent(s.id)}/qr`, { headers });
    const j = await r.json();
    const box = document.getElementById('qrBox');
    if(!j.ok){ box.textContent = 'Failed to load QR'; return; }
    if(j.ready){
      clearInterval(state.qrTimer);
      box.innerHTML = '<span class="pill ok">Connected ✔</span>';
    } else if(j.qr){
      const img = new Image(); img.src = j.qr; img.style.maxWidth = '260px'; img.style.borderRadius='8px'; img.style.border='1px solid var(--line)';
      box.innerHTML = ''; box.appendChild(img);
    } else {
      box.innerHTML = '<span class="muted">QR not ready, retrying…</span>';
    }
  }catch(e){ /* noop */ }
}

document.getElementById('refreshSessions').onclick = loadSessions;
document.getElementById('newSession').onclick = createSession;
document.getElementById('createSessionEmpty').onclick = createSession;
document.getElementById('dashCreate').onclick = ()=>{ show('sessions'); createSession(); };
document.getElementById('search').oninput = renderSessions;
document.getElementById('statusFilter').onchange = renderSessions;
document.getElementById('showQRBtn').onclick = showQR;
document.getElementById('deleteSession').onclick = deleteSelected;

async function createSession(){
  try{
    const name = prompt('Session name?', 'My WhatsApp Session') || '';
    const r = await fetch('/admin/sessions', { method:'POST', headers, body: JSON.stringify({ name }) });
    const j = await r.json();
    if(!j.ok) throw new Error(j.error||'create failed');
    await loadSessions();
    if(j.id){
      selectSession(j.id);
      showQR();
    }
  }catch(e){ alert(e.message); }
}

async function deleteSelected(){
  const s = state.selected; if(!s) return;
  if(!confirm(`Delete session ${s.name||s.id}? This will disconnect WhatsApp and remove it permanently.`)) return;
  try{
    clearInterval(state.qrTimer);
    const r = await fetch(`/admin/sessions/${encodeURIComponent(s.id)}`, { method:'DELETE', headers });
    if(!r.ok){ const t=await r.text(); alert('Delete failed: '+t); return; }
    state.selected = null;
    document.getElementById('sessionDetail').style.display='none';
    await loadSessions();
    alert('Session deleted');
  }catch(e){ alert('Delete error: '+ (e.message||e)); }
}

// ===== API Playground Helpers =====
function baseUrl(){ const b = (window.ENV_PUBLIC_BASE_URL||'').trim(); return b? b : location.origin; }
function apiKey(){ return state.selected?.api_key || '<api_key>'; }
function sid(){ return state.selected?.id || '<sessionId>'; }
function setText(id, t){ const el = document.getElementById(id); if(el) el.textContent = t; }
async function fileToDataURL(inputId){ const f = document.getElementById(inputId).files[0]; if(!f) return null; return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); }); }

function updateCurlUnified(){
  const curl = `curl -X POST "${baseUrl()}/api/send-message" -H "Authorization: Bearer ${apiKey()}" -H "Content-Type: application/json" -d '{"to": "+9053XXXXXXXXX", "text": "Hello from API!"}'`;
  setText('ap_curlUnified', curl);
}

function curlFor(path, body){
  return `curl -X POST "${baseUrl()}${path}" -H "Content-Type: application/json" -H "X-API-Key: ${apiKey()}" -d '${JSON.stringify(body)}'`;
}

function refreshAllCurlExamples(){
  updateCurlUnified();
  const s = state.selected; if(!s) return;
  // text
  setText('ap_textResp', curlFor(`/api/${sid()}/send-text`, { to: "+9053XXXXXXX", text: "Hello" }));
  // media (example without real base64)
  setText('ap_mediaResp', curlFor(`/api/${sid()}/send-media`, { to: "+9053XXXXXXX", caption: "File", media:{ base64:"data:image/png;base64,BASE64...", filename:"image.png" } }));
  // sticker
  setText('ap_stickerResp', curlFor(`/api/${sid()}/send-sticker`, { to: "+9053XXXXXXX", media:{ base64:"data:image/webp;base64,BASE64...", filename:"sticker.webp" }, author:"Brand", name:"Hello" }));
  // location
  setText('ap_locResp', curlFor(`/api/${sid()}/send-location`, { to: "+9053XXXXXXX", latitude:41.01, longitude:28.97, description:"Istanbul" }));
  // poll
  setText('ap_pollResp', curlFor(`/api/${sid()}/send-poll`, { to: "+9053XXXXXXX", name:"Favori?", options:["A","B"], allowMultipleAnswers:false }));
  // react
  setText('ap_reactResp', curlFor(`/api/${sid()}/react`, { messageId:"true_123@c.us_3EB0...", emoji:"👍" }));
  // group
  setText('ap_gCreateResp', curlFor(`/api/${sid()}/group/create`, { name:"My Group", participants:["9053....","9053...."] }));
  setText('ap_gMembersResp', '');
  setText('ap_gInviteResp', `curl -X GET "${baseUrl()}/api/${sid()}/group/1203...@g.us/invite" -H "X-API-Key: ${apiKey()}"`);
}

// ===== API Playground Actions =====
async function ap_sendText(){ const s=state.selected; if(!s) return alert('Select a session'); const to=elv('ap_toText'); const text=elv('ap_msgText'); const r=await fetch(`/api/${s.id}/send-text`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ to, text })}); setText('ap_textResp', await r.text()); }
async function ap_sendMedia(){ const s=state.selected; if(!s) return alert('Select a session'); const to=elv('ap_toMedia'); const caption=elv('ap_caption'); const b64=await fileToDataURL('ap_mediaFile'); if(!b64) return alert('Select a file'); const r=await fetch(`/api/${s.id}/send-media`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ to, caption, media:{ base64:b64, filename:(document.getElementById('ap_mediaFile').files[0].name) } })}); setText('ap_mediaResp', await r.text()); }
async function ap_sendSticker(){ const s=state.selected; if(!s) return alert('Select a session'); const to=elv('ap_toSticker'); const author=elv('ap_stickerAuthor'); const name=elv('ap_stickerName'); const b64=await fileToDataURL('ap_stickerFile'); if(!b64) return alert('Select an image'); const r=await fetch(`/api/${s.id}/send-sticker`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ to, media:{ base64:b64, filename:(document.getElementById('ap_stickerFile').files[0].name) }, author, name })}); setText('ap_stickerResp', await r.text()); }
async function ap_sendLoc(){ const s=state.selected; if(!s) return alert('Select a session'); const to=elv('ap_toLoc'); const lat=parseFloat(elv('ap_lat')); const lng=parseFloat(elv('ap_lng')); const description=elv('ap_locDesc'); const r=await fetch(`/api/${s.id}/send-location`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ to, latitude:lat, longitude:lng, description })}); setText('ap_locResp', await r.text()); }
async function ap_sendPoll(){ const s=state.selected; if(!s) return alert('Select a session'); const to=elv('ap_toPoll'); const name=elv('ap_pollQ'); const options=elv('ap_pollOpts').split(',').map(x=>x.trim()).filter(Boolean); const allowMultipleAnswers=document.getElementById('ap_pollMulti').checked; const r=await fetch(`/api/${s.id}/send-poll`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ to, name, options, allowMultipleAnswers })}); setText('ap_pollResp', await r.text()); }
async function ap_sendReact(){ const s=state.selected; if(!s) return alert('Select a session'); const messageId=elv('ap_msgId'); const emoji=elv('ap_emoji'); const r=await fetch(`/api/${s.id}/react`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ messageId, emoji })}); setText('ap_reactResp', await r.text()); }

function elv(id){ const e=document.getElementById(id); return (e?.value||'').trim(); }
function splitPhones(v){ return (v||'').split(',').map(x=>x.trim()).filter(Boolean); }
async function ap_gCreate(){ const s=state.selected; if(!s) return alert('Select a session'); const name=elv('ap_gName'); const participants=splitPhones(elv('ap_gParts')); const r=await fetch(`/api/${s.id}/group/create`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ name, participants })}); setText('ap_gCreateResp', await r.text()); }
async function ap_gMembers(action){ const s=state.selected; if(!s) return alert('Select a session'); const groupId=elv('ap_gId'); const participants=splitPhones(elv('ap_gParts2')); const r=await fetch(`/api/${s.id}/group/${action}`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ groupId, participants })}); setText('ap_gMembersResp', await r.text()); }
async function ap_gInvite(){ const s=state.selected; if(!s) return alert('Select a session'); const gid=elv('ap_gId2'); const r=await fetch(`/api/${s.id}/group/${encodeURIComponent(gid)}/invite`, { headers:{'X-API-Key': s.api_key} }); setText('ap_gInviteResp', await r.text()); }
async function ap_gRevoke(){ const s=state.selected; if(!s) return alert('Select a session'); const gid=elv('ap_gId2'); const r=await fetch(`/api/${s.id}/group/${encodeURIComponent(gid)}/revoke-invite`, { method:'POST', headers:{'X-API-Key': s.api_key} }); setText('ap_gInviteResp', await r.text()); }
async function ap_chatMute(){ const s=state.selected; if(!s) return alert('Select a session'); const chatId=elv('ap_chatId'); const durationMs=parseInt(elv('ap_muteMs')||''); const r=await fetch(`/api/${s.id}/chat/mute`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ chatId, durationMs: isNaN(durationMs)? undefined : durationMs })}); setText('ap_chatResp', await r.text()); }
async function ap_chatUnmute(){ const s=state.selected; if(!s) return alert('Select a session'); const chatId=elv('ap_chatId'); const r=await fetch(`/api/${s.id}/chat/unmute`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ chatId })}); setText('ap_chatResp', await r.text()); }
async function ap_block(){ const s=state.selected; if(!s) return alert('Select a session'); const contactId=elv('ap_contactId'); const r=await fetch(`/api/${s.id}/contact/block`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ contactId })}); setText('ap_blockResp', await r.text()); }
async function ap_unblock(){ const s=state.selected; if(!s) return alert('Select a session'); const contactId=elv('ap_contactId'); const r=await fetch(`/api/${s.id}/contact/unblock`, { method:'POST', headers:{'Content-Type':'application/json','X-API-Key':s.api_key}, body: JSON.stringify({ contactId })}); setText('ap_blockResp', await r.text()); }
async function ap_profileGet(){ const s=state.selected; if(!s) return alert('Select a session'); const id=elv('ap_profileId'); const r=await fetch(`/api/${s.id}/contact/${encodeURIComponent(id)}/profile`, { headers:{'X-API-Key': s.api_key} }); try{ const j=await r.json(); document.getElementById('ap_profileResp').textContent = JSON.stringify(j,null,2); }catch{ setText('ap_profileResp', await r.text()); }
}

function wireApiPlayground(){
  const bind = (id, fn) => { const b=document.getElementById(id); if(b) b.onclick = fn; };
  bind('ap_sendText', ap_sendText);
  bind('ap_sendMedia', ap_sendMedia);
  bind('ap_sendSticker', ap_sendSticker);
  bind('ap_sendLoc', ap_sendLoc);
  bind('ap_sendPoll', ap_sendPoll);
  bind('ap_sendReact', ap_sendReact);
  bind('ap_gCreate', ap_gCreate);
  bind('ap_gAdd', ()=>ap_gMembers('add'));
  bind('ap_gRemove', ()=>ap_gMembers('remove'));
  bind('ap_gPromote', ()=>ap_gMembers('promote'));
  bind('ap_gDemote', ()=>ap_gMembers('demote'));
  bind('ap_gInvite', ap_gInvite);
  bind('ap_gRevoke', ap_gRevoke);
  bind('ap_chatMute', ap_chatMute);
  bind('ap_chatUnmute', ap_chatUnmute);
  bind('ap_block', ap_block);
  bind('ap_unblock', ap_unblock);
  bind('ap_profileGet', ap_profileGet);
  // copy buttons for curl from response areas
  bind('ap_copyCurlUnified', ()=>copy('#ap_curlUnified'));
  bind('ap_copyCurlText',    ()=>copy('#ap_textResp'));
  bind('ap_copyCurlMedia',   ()=>copy('#ap_mediaResp'));
  bind('ap_copyCurlSticker', ()=>copy('#ap_stickerResp'));
  bind('ap_copyCurlLoc',     ()=>copy('#ap_locResp'));
  bind('ap_copyCurlPoll',    ()=>copy('#ap_pollResp'));
  bind('ap_copyCurlReact',   ()=>copy('#ap_reactResp'));
  bind('ap_copyCurlGCreate', ()=>copy('#ap_gCreateResp'));
  bind('ap_copyCurlGAdd',    ()=>copy('#ap_gMembersResp'));
  bind('ap_copyCurlGRemove', ()=>copy('#ap_gMembersResp'));
  bind('ap_copyCurlGPromote',()=>copy('#ap_gMembersResp'));
  bind('ap_copyCurlGDemote', ()=>copy('#ap_gMembersResp'));
  bind('ap_copyCurlGInvite', ()=>copy('#ap_gInviteResp'));
  bind('ap_copyCurlGRevoke', ()=>copy('#ap_gInviteResp'));
  bind('ap_copyCurlMute',    ()=>copy('#ap_chatResp'));
  bind('ap_copyCurlBlock',   ()=>copy('#ap_blockResp'));
  bind('ap_copyCurlProfile', ()=>copy('#ap_profileResp'));
}

function copy(sel){
  const t = document.querySelector(sel)?.textContent || '';
  if(!t) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(()=>fallbackCopy(t));
  } else {
    fallbackCopy(t);
  }
}
function fallbackCopy(text){
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }catch{}
}

// Recent Activity + Message Activity via SSE
function startSSE(){
  try{ if(state.sse) state.sse.close(); }catch{}
  const es = new EventSource('/admin/events?token=' + encodeURIComponent(token));
  state.sse = es;
  es.addEventListener('message', ev => {
    state.msgCount++; document.getElementById('msgCount').textContent = state.msgCount;
    addRecent('message');
  });
  es.addEventListener('status', ev => addRecent('status'));
  es.onerror = () => {/* noop */};
}
function addRecent(kind){
  const el = document.getElementById('recent');
  el.textContent = kind==='message' ? 'New message arrived' : 'Session status changed';
}

// ===== Reminders wiring =====
async function populateReminderSessions(){
  const sel = document.getElementById('rm_session'); if(!sel) return;
  sel.innerHTML = '';
  (state.sessions||[]).forEach(s=>{
    const opt = document.createElement('option'); opt.value = s.id; opt.textContent = `${s.name||s.id} (${s.status})`; sel.appendChild(opt);
  });
  if (!state.sessions || state.sessions.length===0){ const opt=document.createElement('option'); opt.value=''; opt.textContent='No session available'; sel.appendChild(opt); }
}
async function loadReminders(){
  try{
    const r = await fetch('/admin/reminders', { headers });
    const j = await r.json();
    renderReminders(j.ok ? (j.reminders||[]) : []);
  }catch{ renderReminders([]); }
}
function renderReminders(rows){
  const list = document.getElementById('rm_list'); const empty = document.getElementById('rm_empty');
  list.innerHTML='';
  if(!rows || rows.length===0){ empty.style.display='flex'; list.style.display='none'; return; }
  empty.style.display='none'; list.style.display='block';
  rows.forEach(rm=>{
    const div = document.createElement('div'); div.className='item';
    const when = new Date(rm.run_at);
    div.innerHTML = `
      <div class="row" style="justify-content:space-between; gap:8px">
        <div>
          <div><b>${rm.message}</b></div>
          <div class="muted" style="font-family:ui-monospace,Menlo,monospace">to: ${rm.recipient} • at: ${when.toISOString().replace('T',' ').slice(0,16)}Z • status: ${rm.status}</div>
        </div>
        <div class="row" style="gap:6px"><button class="btn" data-rm-del="${rm.id}" style="background: var(--bad)">Delete</button></div>
      </div>`;
    list.appendChild(div);
  });
}
document.addEventListener('click', async (e)=>{
  const b = e.target.closest('button[data-rm-del]');
  if(b){ const id = b.getAttribute('data-rm-del'); if(confirm('Delete this reminder?')){ await fetch(`/admin/reminders/${id}`, { method:'DELETE', headers }); await loadReminders(); } }
});
document.getElementById('rm_create').onclick = async ()=>{
  const sessionId = document.getElementById('rm_session').value;
  const recipient = document.getElementById('rm_recipient').value.trim();
  const message = document.getElementById('rm_message').value.trim();
  const date = document.getElementById('rm_date').value;
  const time = document.getElementById('rm_time').value;
  const tz = document.getElementById('rm_tz').value;
  const repeat = document.getElementById('rm_repeat').value;
  const out = document.getElementById('rm_create_resp'); out.textContent='';
  if(!sessionId){ out.textContent='Select a session'; return; }
  if(!recipient || !message || !date || !time){ out.textContent='Recipient, message, date and time are required'; return; }
  try{
    const r = await fetch('/admin/reminders', { method:'POST', headers, body: JSON.stringify({ sessionId, recipient, message, date, time, tz, repeat }) });
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'failed');
    out.textContent = 'Reminder created';
    document.getElementById('rm_message').value='';
    await loadReminders();
  }catch(e){ out.textContent = e.message || 'error'; }
};

// init
loadSessions();
startSSE();
try { wireApiPlayground(); } catch (e) { /* ignore */ }
