// index.js — Multi-Account WhatsApp bot (admin login, QR, per-session API/Webhook, SSE, rehydrate on boot)
// Env: ADMIN_USER, ADMIN_PASS, PUPPETEER_EXECUTABLE_PATH, SUPABASE_DB_URL
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const qrcode = require('qrcode');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Client, LocalAuth, MessageMedia, Location, Poll } = require('whatsapp-web.js');

const { DB } = require('./db'); // <<<< Supabase Postgres CRUD
const { createClient } = require('@supabase/supabase-js');

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin'; // legacy
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin'; // legacy
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';
const SIGNUP_DAILY_LIMIT = parseInt(process.env.SIGNUP_DAILY_LIMIT || '5', 10);
const SESSION_BASE = process.env.SESSION_DIR || path.join(process.cwd(), 'sessions');
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Ensure LocalAuth base directory exists (for persistence across deployments)
try { fs.mkdirSync(SESSION_BASE, { recursive: true }); console.log('[BOOT] LocalAuth base directory:', SESSION_BASE); } catch (e) { console.error('Failed to ensure SESSION_BASE dir:', e?.message || e); }

// ====== Çoklu Client + SSE ======
const clients = new Map(); // sessionId -> { client, qr, ready }
const events = new EventEmitter();

const randomKey = (len = 24) => crypto.randomBytes(len).toString('hex');
const hmac = (secret, bodyStr) =>
  !secret ? '' : crypto.createHmac('sha256', secret).update(bodyStr, 'utf8').digest('hex');

async function postWebhook(sessionId, event, data) {
  const s = await DB.get(sessionId);
  if (!s?.webhook_url) return;
  const payload = { sessionId, event, data, ts: Date.now() };
  const body = JSON.stringify(payload);
  const sig = hmac(s.webhook_secret, body);
  try {
    await axios.post(s.webhook_url, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Signature': sig } : {}) }
    });
  } catch (e) {
    console.error('Webhook fail:', sessionId, e?.response?.status || e?.message);
  }
}

async function createSession({ id, name, userId }) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_BASE, clientId: id }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], executablePath: EXEC_PATH }
  });

  clients.set(id, { client, qr: null, ready: false });

  client.on('qr', async (qr) => {
    const dataUrl = await qrcode.toDataURL(qr);
    const e = clients.get(id);
    if (e) e.qr = dataUrl;
    await DB.setStatus(id, 'pending');
    events.emit('status', { sessionId: id, status: 'pending' });
  });

  client.on('ready', async () => {
    const e = clients.get(id);
    if (e) { e.ready = true; e.qr = null; }
    await DB.setStatus(id, 'ready');
    events.emit('status', { sessionId: id, status: 'ready' });
    await postWebhook(id, 'ready', {});
  });

  client.on('disconnected', async (reason) => {
    const e = clients.get(id);
    if (e) e.ready = false;
    await DB.setStatus(id, 'disconnected');
    events.emit('status', { sessionId: id, status: 'disconnected', reason });
    await postWebhook(id, 'disconnected', { reason });
    client.initialize(); // auto-reconnect
  });

  client.on('message', async (msg) => {
    const payload = {
      sessionId: id,
      from: msg.from, to: msg.to, body: msg.body, isGroup: msg.isGroup, timestamp: msg.timestamp
    };
    events.emit('message', payload);
    await postWebhook(id, 'message', payload);
  });

  client.initialize();

  await DB.upsertSession({
    id, name: name || id, status: 'pending',
    api_key: null, webhook_url: null, webhook_secret: null,
    user_id: userId || null,
    created_at: Date.now()
  });

  return id;
}

function destroySessionSync(id) {
  const e = clients.get(id);
  if (e) { try { e.client.destroy(); } catch {} clients.delete(id); }
}

function ensureClient(id) {
  const e = clients.get(id);
  if (!e) throw new Error('session not found');
  return e.client;
}

async function sendText(sessionId, to, text) {
  const client = ensureClient(sessionId);
  const chatId = toChatId(to);
  return client.sendMessage(chatId, text);
}

async function sendMedia(sessionId, { to, caption, base64, filename, mime }) {
  const client = ensureClient(sessionId);
  let b64 = (base64 || '').trim();
  const m = b64.match(/^data:(.+);base64,(.*)$/);
  if (m) { mime = m[1]; b64 = m[2]; }
  const mm = new MessageMedia(mime || 'application/octet-stream', b64, filename || 'file');
  const chatId = toChatId(to);
  return client.sendMessage(chatId, mm, { caption });
}

// ====== Express App ======
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));
// arka proxy'lerde gerçek IP'yi almak için
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

// Frontend config for Supabase (expose URL and ANON key)
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(`
    window.ENV_SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || '')};
    window.ENV_SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')};
    window.ENV_TURNSTILE_SITE_KEY = ${JSON.stringify(process.env.TURNSTILE_SITE_KEY || '')};
    window.ENV_HCAPTCHA_SITE_KEY = ${JSON.stringify(process.env.HCAPTCHA_SITE_KEY || '')};
    window.ENV_PUBLIC_BASE_URL = ${JSON.stringify(process.env.PUBLIC_BASE_URL || '')};
  `);
});

// Clean URL for app shell
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Current user info (server-validated) for dynamic app page
app.get('/api/me', supaAuth, async (req, res) => {
  try {
    const user = req.user; // from supaAuth
    const sessions = await DB.listByUser(user.id);
    res.json({ ok: true, user: { id: user.id, email: user.email || null }, counts: { sessions: sessions.length } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed to load profile' });
  }
});

// Admin auth (legacy) — header: X-Admin-Auth: base64("user:pass")
function adminAuth(req, res, next) {
  const h = req.headers['x-admin-auth'];
  if (!h) return res.status(401).json({ ok: false, error: 'admin auth required' });
  const [u, p] = Buffer.from(h, 'base64').toString('utf8').split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  return res.status(401).json({ ok: false, error: 'invalid admin creds' });
}

// Supabase auth — Bearer token in Authorization header or token param (SSE)
async function supaAuth(req, res, next) {
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase not configured' });
  let token = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && req.query && req.query.token) token = req.query.token;
  if (!token) return res.status(401).json({ ok: false, error: 'auth token required' });
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: 'invalid token' });
    req.user = data.user;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'auth failed' });
  }
}

// Tenant API key auth (more flexible)
// Accept API key from multiple locations to avoid client pitfalls:
// - Header: X-API-Key: <key>
// - Header: Authorization: Bearer <key>
// - Body: { api_key: "..." }
// - Query: ?api_key=...
async function keyAuth(req, res, next) {
  try {
    const sid = req.params.sessionId || req.query.sessionId || req.body?.sessionId;
    // prefer explicit header first
    let key = req.headers['x-api-key'];
    if (!key) {
      const auth = req.headers['authorization'] || '';
      if (auth.startsWith('Bearer ')) key = auth.slice(7).trim();
    }
    if (!key) key = req.body?.api_key || req.query?.api_key;

    if (!sid || !key) {
      return res.status(401).json({
        ok: false,
        error: 'sessionId & API key required',
        howTo: {
          header: 'X-API-Key: <api_key>',
          bearer: 'Authorization: Bearer <api_key>',
          example_header: `curl -X POST ${req.protocol}://${req.get('host')}/api/<sessionId>/send-text -H 'Content-Type: application/json' -H 'X-API-Key: <api_key>' -d '{"to":"+9053...","text":"Hello"}'`,
          example_bearer: `curl -X POST ${req.protocol}://${req.get('host')}/api/<sessionId>/send-text -H 'Authorization: Bearer <api_key>' -H 'Content-Type: application/json' -d '{"to":"+9053...","text":"Hello"}'`,
          example_query: `curl -X POST '${req.protocol}://${req.get('host')}/api/<sessionId>/send-text?api_key=<api_key>' -H 'Content-Type: application/json' -d '{"to":"+9053...","text":"Hello"}'`
        }
      });
    }

    const s = await DB.get(sid);
    if (!s || s.api_key !== key) return res.status(403).json({ ok: false, error: 'invalid api key' });

    // attach for downstream if needed
    req.session = s;
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'auth error' });
  }
}

// ---- Admin endpoints ----
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'invalid creds' });
});

app.get('/admin/sessions', supaAuth, async (req, res) => {
  const rows = await DB.listByUser(req.user.id);
  res.json({ ok: true, sessions: rows });
});

app.post('/admin/sessions', supaAuth, async (req, res) => {
  const { name } = req.body || {};
  const id = 'ws_' + Date.now().toString(36);
  await createSession({ id, name: name || id, userId: req.user.id });
  const api = randomKey();
  const secret = randomKey();
  await DB.setApiKey(id, api);
  await DB.setWebhook(id, null, secret);
  res.json({ ok: true, id, api_key: api, webhook_secret: secret });
});

// QR görüntüleme
app.get('/admin/sessions/:id/qr', supaAuth, async (req, res) => {
  const sid = req.params.id;
  const s = await DB.getByIdAndUser(sid, req.user.id);
  if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
  const e = clients.get(sid);
  if (!e) return res.status(404).json({ ok: false, error: 'session not running' });
  return res.json({ ok: true, qr: e.qr, ready: !!e.ready });
});

// Webhook ayarla
app.post('/admin/sessions/:id/webhook', supaAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  const s = await DB.getByIdAndUser(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
  await DB.setWebhook(req.params.id, url, s.webhook_secret);
  res.json({ ok: true });
});

// Session sil
app.delete('/admin/sessions/:id', supaAuth, async (req, res) => {
  const sid = req.params.id;
  const s = await DB.getByIdAndUser(sid, req.user.id);
  if (!s) return res.status(404).json({ ok:false, error:'session not found' });
  destroySessionSync(sid);
  await DB.del(sid);
  res.json({ ok: true });
});

// === Admin teşhis/aksiyon (status & restart) ===
app.get('/admin/sessions/:id/status', supaAuth, async (req, res) => {
  const sid = req.params.id;
  const s = await DB.getByIdAndUser(sid, req.user.id);
  if (!s) return res.status(404).json({ ok:false, error:'session not found' });
  const e = clients.get(sid);
  return res.json({ ok: true, inMemory: !!e, ready: !!e?.ready, db: s || null });
});

app.post('/admin/sessions/:id/restart', supaAuth, async (req, res) => {
  const sid = req.params.id;
  const s = await DB.getByIdAndUser(sid, req.user.id);
  if (!s) return res.status(404).json({ ok:false, error:'session not found in DB' });
  destroySessionSync(sid);
  await createSession({ id: sid, name: s.name, userId: s.user_id });
  res.json({ ok:true });
});

// SSE — admin paneline canlı mesaj & durum yayını (Supabase auth via token query)
app.get('/admin/events', supaAuth, (req, res) => {
  const userId = req.user.id;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (type, data) => { res.write(`event: ${type}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const onMsg = async (payload) => {
    try { const s = await DB.getByIdAndUser(payload.sessionId, userId); if (s) send('message', payload); } catch {}
  };
  const onStatus = async (payload) => {
    try { const s = await DB.getByIdAndUser(payload.sessionId, userId); if (s) send('status', payload); } catch {}
  };

  events.on('message', onMsg);
  events.on('status', onStatus);
  req.on('close', () => { events.off('message', onMsg); events.off('status', onStatus); });
});

// ---- Tenant (per-session) API ----
app.post('/api/:sessionId/send-text', keyAuth, async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: 'to & text required' });
    const m = await sendText(req.params.sessionId, to, text);
    res.json({ ok: true, id: m.id.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-text fail' });
  }
});

app.post('/api/:sessionId/send-media', keyAuth, async (req, res) => {
  try {
    const { to, caption, media } = req.body || {};
    if (!to || !media?.base64) return res.status(400).json({ ok: false, error: 'to & media.base64 required' });
    const m = await sendMedia(req.params.sessionId, { to, caption, base64: media.base64, filename: media.filename, mime: media.mime });
    res.json({ ok: true, id: m.id.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-media fail' });
  }
});

// === Advanced messaging & management endpoints ===
function toChatId(raw) {
  const v = (raw || '').trim();
  if (v.includes('@')) return v; // already a chatId
  // Normalize phone numbers like "+9053..." or with spaces/dashes
  let s = v.replace(/\s+/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  // remove any remaining non-digits (e.g., dashes, parentheses)
  s = s.replace(/\D/g, '');
  return `${s}@c.us`;
}
function toGroupId(raw) { const s = (raw||'').trim(); return s.endsWith('@g.us') ? s : `${s}@g.us`; }

// Send sticker from base64 (data URI supported)
app.post('/api/:sessionId/send-sticker', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { to, media, author, name } = req.body || {};
    if (!to || !media?.base64) return res.status(400).json({ ok:false, error:'to & media.base64 required' });
    let b64 = (media.base64||'').trim();
    let mime = media.mime || 'image/webp';
    const m = b64.match(/^data:(.+);base64,(.*)$/);
    if (m) { mime = m[1]; b64 = m[2]; }
    const mm = new MessageMedia(mime, b64, media.filename || 'sticker');
    const sent = await client.sendMessage(toChatId(to), mm, { sendMediaAsSticker: true, stickerAuthor: author, stickerName: name });
    return res.json({ ok:true, id: sent.id.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'send-sticker fail' });
  }
});

// Send location
app.post('/api/:sessionId/send-location', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { to, latitude, longitude, description } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !to) {
      return res.status(400).json({ ok:false, error:'to, latitude(number), longitude(number) required' });
    }
    const loc = new Location(latitude, longitude, description || undefined);
    const sent = await client.sendMessage(toChatId(to), loc);
    return res.json({ ok:true, id: sent.id.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'send-location fail' });
  }
});

// Send poll
app.post('/api/:sessionId/send-poll', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { to, name, options, allowMultipleAnswers } = req.body || {};
    if (!to || !name || !Array.isArray(options) || options.length < 2) return res.status(400).json({ ok:false, error:'to, name, options[>=2] required' });
    const poll = new Poll(name, options, { allowMultipleAnswers: !!allowMultipleAnswers });
    const sent = await client.sendMessage(toChatId(to), poll);
    return res.json({ ok:true, id: sent.id.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'send-poll fail' });
  }
});

// React to a message
app.post('/api/:sessionId/react', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { messageId, emoji } = req.body || {};
    if (!messageId || !emoji) return res.status(400).json({ ok:false, error:'messageId & emoji required' });
    const msg = await client.getMessageById(messageId);
    if (!msg) return res.status(404).json({ ok:false, error:'message not found' });
    await msg.react(emoji);
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'react fail' });
  }
});

// Group management
app.post('/api/:sessionId/group/create', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { name, participants } = req.body || {};
    if (!name) return res.status(400).json({ ok:false, error:'name required' });
    const parts = (participants||[]).map(p => toChatId(p));
    const r = await client.createGroup(name, parts);
    return res.json({ ok:true, gid: r.gid? r.gid._serialized : r.gid, pendingInviteV4: r });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'group create fail' });
  }
});

async function getGroupChat(client, groupId) {
  const gid = toGroupId(groupId);
  const chat = await client.getChatById(gid);
  if (!chat || chat.isGroup !== true) throw new Error('group not found');
  return chat;
}

app.post('/api/:sessionId/group/add', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { groupId, participants } = req.body || {};
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok:false, error:'groupId & participants[] required' });
    const chat = await getGroupChat(client, groupId);
    await chat.addParticipants(participants.map(p=>toChatId(p)));
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'group add fail' }); }
});

app.post('/api/:sessionId/group/remove', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { groupId, participants } = req.body || {};
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok:false, error:'groupId & participants[] required' });
    const chat = await getGroupChat(client, groupId);
    await chat.removeParticipants(participants.map(p=>toChatId(p)));
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'group remove fail' }); }
});

app.post('/api/:sessionId/group/promote', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { groupId, participants } = req.body || {};
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok:false, error:'groupId & participants[] required' });
    const chat = await getGroupChat(client, groupId);
    await chat.promoteParticipants(participants.map(p=>toChatId(p)));
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'group promote fail' }); }
});

app.post('/api/:sessionId/group/demote', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const { groupId, participants } = req.body || {};
    if (!groupId || !Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok:false, error:'groupId & participants[] required' });
    const chat = await getGroupChat(client, groupId);
    await chat.demoteParticipants(participants.map(p=>toChatId(p)));
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'group demote fail' }); }
});

app.get('/api/:sessionId/group/:groupId/invite', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const chat = await getGroupChat(client, req.params.groupId);
    const code = await chat.getInviteCode();
    return res.json({ ok:true, code, link: `https://chat.whatsapp.com/${code}` });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'get invite fail' }); }
});

app.post('/api/:sessionId/group/:groupId/revoke-invite', keyAuth, async (req, res) => {
  try {
    const client = ensureClient(req.params.sessionId);
    const chat = await getGroupChat(client, req.params.groupId);
    await chat.revokeInvite();
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'revoke invite fail' }); }
});

// Chat & contact management
app.post('/api/:sessionId/chat/mute', keyAuth, async (req, res) => {
  try { const client = ensureClient(req.params.sessionId); const { chatId, durationMs } = req.body || {}; if (!chatId) return res.status(400).json({ ok:false, error:'chatId required' }); const chat = await client.getChatById(chatId.includes('@')?chatId:toChatId(chatId)); await chat.mute(durationMs || undefined); return res.json({ ok:true }); } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'mute fail' }); }
});
app.post('/api/:sessionId/chat/unmute', keyAuth, async (req, res) => {
  try { const client = ensureClient(req.params.sessionId); const { chatId } = req.body || {}; if (!chatId) return res.status(400).json({ ok:false, error:'chatId required' }); const chat = await client.getChatById(chatId.includes('@')?chatId:toChatId(chatId)); await chat.unmute(); return res.json({ ok:true }); } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'unmute fail' }); }
});
app.post('/api/:sessionId/contact/block', keyAuth, async (req, res) => {
  try { const client = ensureClient(req.params.sessionId); const { contactId } = req.body || {}; if (!contactId) return res.status(400).json({ ok:false, error:'contactId required' }); const id = contactId.includes('@')?contactId:toChatId(contactId); await client.blockContact(id); return res.json({ ok:true }); } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'block fail' }); }
});
app.post('/api/:sessionId/contact/unblock', keyAuth, async (req, res) => {
  try { const client = ensureClient(req.params.sessionId); const { contactId } = req.body || {}; if (!contactId) return res.status(400).json({ ok:false, error:'contactId required' }); const id = contactId.includes('@')?contactId:toChatId(contactId); await client.unblockContact(id); return res.json({ ok:true }); } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'unblock fail' }); }
});
app.get('/api/:sessionId/contact/:id/profile', keyAuth, async (req, res) => {
  try { const client = ensureClient(req.params.sessionId); const id = req.params.id.includes('@')? req.params.id : toChatId(req.params.id); const contact = await client.getContactById(id); const profilePicUrl = await contact.getProfilePicUrl().catch(()=>null); const about = await contact.getAbout?.().catch?.(()=>null) || null; return res.json({ ok:true, contact: { id: contact.id? contact.id._serialized : id, name: contact.name, pushname: contact.pushname, number: contact.number, isBusiness: contact.isBusiness, isEnterprise: contact.isEnterprise, profilePicUrl, about } }); } catch (e) { return res.status(500).json({ ok:false, error: e?.message || 'profile fetch fail' }); }
});

// ---- Unified Bearer token API (no sessionId in path) ----
async function bearerKeyAuth(req, res, next) {
  try {
    const h = req.headers['authorization'] || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ ok:false, error:'Authorization: Bearer <token> required' });
    const token = h.slice(7).trim();
    if (!token) return res.status(401).json({ ok:false, error:'bearer token missing' });
    const s = await DB.getByApiKey(token);
    if (!s) return res.status(403).json({ ok:false, error:'invalid bearer token' });
    req.session = s; // attach full session
    next();
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'auth error' });
  }
}

app.post('/api/send-message', bearerKeyAuth, async (req, res) => {
  try {
    let { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok:false, error:'to & text required' });
    // normalize phone: remove leading '+' and spaces
    if (typeof to === 'string') to = to.replace(/\s+/g,'');
    if (typeof to === 'string' && to.startsWith('+')) to = to.slice(1);
    const m = await sendText(req.session.id, to, text);
    return res.json({ ok:true, id: m.id.id, sessionId: req.session.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'send-message fail' });
  }
});

// Health & root
app.get('/health', async (req, res) => {
  const rows = await DB.list();
  res.json({ ok: true, sessions: rows.length, live: clients.size });
});
app.get('/', (req, res) => {
  const file = path.join(__dirname, 'public', 'login.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.type('text').send('OK');
});

// === Signup proxy with CAPTCHA + per-IP daily limit ===
const signupCounters = new Map(); // ip -> { day: 'YYYY-MM-DD', count: number }
function isOverLimit(ip) {
  const day = new Date().toISOString().slice(0,10);
  const rec = signupCounters.get(ip);
  if (!rec || rec.day !== day) { signupCounters.set(ip, { day, count: 0 }); return false; }
  return rec.count >= SIGNUP_DAILY_LIMIT;
}
function incrCounter(ip) {
  const day = new Date().toISOString().slice(0,10);
  const rec = signupCounters.get(ip);
  if (!rec || rec.day !== day) {
    signupCounters.set(ip, { day, count: 1 });
  } else {
    rec.count += 1;
  }
}

async function verifyCaptcha({ provider, token, ip }) {
  try {
    if (provider === 'turnstile') {
      if (!TURNSTILE_SECRET) return { ok:false, error:'turnstile not configured' };
      const r = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip || ''
      }).toString(), { headers: { 'Content-Type':'application/x-www-form-urlencoded' } });
      if (r.data && r.data.success) return { ok:true };
      return { ok:false, error: 'captcha failed', details: r.data };
    }
    if (provider === 'hcaptcha') {
      if (!HCAPTCHA_SECRET) return { ok:false, error:'hcaptcha not configured' };
      const r = await axios.post('https://hcaptcha.com/siteverify', new URLSearchParams({
        secret: HCAPTCHA_SECRET,
        response: token,
        remoteip: ip || ''
      }).toString(), { headers: { 'Content-Type':'application/x-www-form-urlencoded' } });
      if (r.data && r.data.success) return { ok:true };
      return { ok:false, error: 'captcha failed', details: r.data };
    }
    return { ok:false, error:'unknown provider' };
  } catch (e) {
    return { ok:false, error: e?.message || 'captcha verify error' };
  }
}

app.post('/auth/signup', async (req, res) => {
  try {
    const ip = (req.headers['cf-connecting-ip'] || req.ip || '').toString();
    const { email, password, captchaToken, provider } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:'email & password required' });

    if (isOverLimit(ip)) return res.status(429).json({ ok:false, error:`daily signup limit exceeded (${SIGNUP_DAILY_LIMIT}/day)` });

    const vc = await verifyCaptcha({ provider, token: captchaToken, ip });
    if (!vc.ok) return res.status(400).json({ ok:false, error: vc.error || 'captcha failed' });

    if (!supabase) return res.status(500).json({ ok:false, error:'supabase not configured' });

    const { data, error } = await supabase.auth.signUp({ email, password });
    incrCounter(ip);
    if (error) return res.status(400).json({ ok:false, error: error.message });
    const needsConfirm = !data.session; // email confirm çoğunlukla session döndürmez
    return res.json({ ok:true, needsConfirm, user: data.user || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'signup error' });
  }
});

// === BOOT: tüm session'ları geri yükle (LocalAuth sayesinde QR istemeden bağlanır) ===
async function bootRehydrateAllSessions() {
  try {
    const list = await DB.list();
    for (const s of list) {
      if (!clients.has(s.id)) {
        console.log('[BOOT] restoring session', s.id);
        await createSession({ id: s.id, name: s.name });
      }
    }
    console.log(`[BOOT] restored ${list.length} session(s).`);
  } catch (e) {
    console.error('[BOOT] rehydrate error:', e.message);
  }
}
bootRehydrateAllSessions();

app.listen(PORT, () => console.log('HTTP listening on :' + PORT));
