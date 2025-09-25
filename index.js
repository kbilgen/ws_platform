// index.js — Multi-Account WhatsApp bot (admin login, QR, per-session API/Webhook)
// npm i express body-parser dotenv axios better-sqlite3 whatsapp-web.js qrcode

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const qrcode = require('qrcode');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const DATA_DIR = process.env.DATA_DIR || '/data';
const SESSION_DIR = process.env.SESSION_DIR || '/data/sessions';
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// Hazırlık
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ====== DB (SQLite) ======
const DB_FILE = path.join(DATA_DIR, 'app.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,            -- 'pending' | 'ready' | 'disconnected'
  api_key TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at INTEGER
);
`);

const DB = {
  upsertSession(s) {
    db.prepare(`
      INSERT INTO sessions(id,name,status,api_key,webhook_url,webhook_secret,created_at)
      VALUES(@id,@name,@status,@api_key,@webhook_url,@webhook_secret,@created_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        status=excluded.status,
        api_key=COALESCE(excluded.api_key, sessions.api_key),
        webhook_url=COALESCE(excluded.webhook_url, sessions.webhook_url),
        webhook_secret=COALESCE(excluded.webhook_secret, sessions.webhook_secret)
    `).run(s);
  },
  setStatus(id, status) {
    db.prepare(`UPDATE sessions SET status=? WHERE id=?`).run(status, id);
  },
  setWebhook(id, url, secret) {
    db.prepare(`UPDATE sessions SET webhook_url=?, webhook_secret=? WHERE id=?`).run(url, secret, id);
  },
  setApiKey(id, key) {
    db.prepare(`UPDATE sessions SET api_key=? WHERE id=?`).run(key, id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
  },
  list() {
    return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all();
  },
  del(id) {
    db.prepare(`DELETE FROM sessions WHERE id=?`).run(id);
  }
};

// ====== Çoklu Client Yönetimi ======
/**
 * clients: Map<sessionId, { client: Client, qr: dataURL|null, ready: boolean }>
 */
const clients = new Map();

function randomKey(len = 24) {
  return crypto.randomBytes(len).toString('hex');
}
function hmac(secret, bodyStr) {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(bodyStr, 'utf8').digest('hex');
}
async function sendWebhook(sessionId, event, data) {
  const s = DB.get(sessionId);
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

async function createSession({ id, name }) {
  // whatsapp-web.js her clientId için LocalAuth altına ayrı klasör açar.
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_DIR,
      clientId: id
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: EXEC_PATH
    }
  });

  clients.set(id, { client, qr: null, ready: false });

  client.on('qr', async (qr) => {
    const dataUrl = await qrcode.toDataURL(qr);
    const e = clients.get(id);
    if (e) e.qr = dataUrl;
    DB.setStatus(id, 'pending');
  });

  client.on('ready', async () => {
    const e = clients.get(id);
    if (e) { e.ready = true; e.qr = null; }
    DB.setStatus(id, 'ready');
    await sendWebhook(id, 'ready', {});
  });

  client.on('disconnected', async (reason) => {
    const e = clients.get(id);
    if (e) e.ready = false;
    DB.setStatus(id, 'disconnected');
    await sendWebhook(id, 'disconnected', { reason });
    client.initialize(); // otomatik reconnect
  });

  client.on('message', async (msg) => {
    await sendWebhook(id, 'message', {
      from: msg.from, to: msg.to, body: msg.body, isGroup: msg.isGroup, timestamp: msg.timestamp
    });
  });

  client.initialize();

  // DB kaydı (ilk değerler)
  DB.upsertSession({
    id,
    name: name || id,
    status: 'pending',
    api_key: null,
    webhook_url: null,
    webhook_secret: null,
    created_at: Date.now()
  });

  return id;
}

function destroySession(id) {
  const e = clients.get(id);
  if (e) {
    try { e.client.destroy(); } catch {}
    clients.delete(id);
  }
  // LocalAuth klasörlerini elle silmiyoruz; istenirse eklenebilir
  DB.del(id);
}

function requireClient(id) {
  const e = clients.get(id);
  if (!e) throw new Error('session not found');
  return e.client;
}

async function sendText(sessionId, to, text) {
  const client = requireClient(sessionId);
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  return client.sendMessage(chatId, text);
}

async function sendMedia(sessionId, { to, caption, base64, filename, mime }) {
  const client = requireClient(sessionId);
  let b64 = (base64 || '').trim();
  const m = b64.match(/^data:(.+);base64,(.*)$/);
  if (m) { mime = m[1]; b64 = m[2]; }
  const mm = new MessageMedia(mime || 'application/octet-stream', b64, filename || 'file');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  return client.sendMessage(chatId, mm, { caption });
}

// ====== Express App ======
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

// (Opsiyonel) public klasörün varsa sun (login/admin html’lerini koyabilirsin)
app.use(express.static(path.join(__dirname, 'public')));

// Basit admin header auth:  X-Admin-Auth: base64("user:pass")
function adminAuth(req, res, next) {
  const h = req.headers['x-admin-auth'];
  if (!h) return res.status(401).json({ ok: false, error: 'admin auth required' });
  const [u, p] = Buffer.from(h, 'base64').toString('utf8').split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  return res.status(401).json({ ok: false, error: 'invalid admin creds' });
}

// API-key auth (her hat için farklı anahtar)
function keyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  const sid = req.params.sessionId || req.query.sessionId || req.body.sessionId;
  if (!sid || !key) return res.status(401).json({ ok: false, error: 'sessionId & X-API-Key required' });
  const s = DB.get(sid);
  if (!s || s.api_key !== key) return res.status(403).json({ ok: false, error: 'invalid api key' });
  next();
}

// ---- Admin endpoints ----

// (İsteğe bağlı) basit login doğrulaması (admin panel frontendi bunu kullanabilir)
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'invalid creds' });
});

// Yeni session oluştur + QR üretimi başlat + anahtarları ver
app.post('/admin/sessions', adminAuth, async (req, res) => {
  const { name } = req.body || {};
  const id = 'ws_' + Date.now().toString(36);
  await createSession({ id, name: name || id });
  const api = randomKey();
  const secret = randomKey();
  DB.setApiKey(id, api);
  DB.setWebhook(id, null, secret);
  res.json({ ok: true, id, api_key: api, webhook_secret: secret });
});

// QR sorgula (base64 png döner)
app.get('/admin/sessions/:id/qr', adminAuth, (req, res) => {
  const e = clients.get(req.params.id);
  if (!e) return res.status(404).json({ ok: false, error: 'session not found' });
  return res.json({ ok: true, qr: e.qr, ready: e.ready });
});

// Session listesi
app.get('/admin/sessions', adminAuth, (req, res) => {
  res.json({ ok: true, sessions: DB.list() });
});

// Webhook ayarla/güncelle
app.post('/admin/sessions/:id/webhook', adminAuth, (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  const s = DB.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'session not found' });
  DB.setWebhook(req.params.id, url, s.webhook_secret);
  res.json({ ok: true });
});

// (Opsiyonel) Session sil
app.delete('/admin/sessions/:id', adminAuth, (req, res) => {
  destroySession(req.params.id);
  res.json({ ok: true });
});

// ---- Per-session API ----

// Metin gönder
// POST /api/:sessionId/send-text
// headers: X-API-Key
// body: { to: "905xxxxxxxxx" | "905xxxxxxxxx@c.us", text: "..." }
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

// Medya gönder
// POST /api/:sessionId/send-media
// headers: X-API-Key
// body: { to, caption?, media: { base64, filename?, mime? } }
app.post('/api/:sessionId/send-media', keyAuth, async (req, res) => {
  try {
    const { to, caption, media } = req.body || {};
    if (!to || !media?.base64) return res.status(400).json({ ok: false, error: 'to & media.base64 required' });
    const m = await sendMedia(req.params.sessionId, {
      to, caption, base64: media.base64, filename: media.filename, mime: media.mime
    });
    res.json({ ok: true, id: m.id.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-media fail' });
  }
});

// Sağlık
app.get('/health', (req, res) => res.json({ ok: true, sessions: DB.list().length, live: clients.size }));

// Root (isteğe bağlı: login ekranı veya basit bilgi)
app.get('/', (req, res) => {
  // public/login.html varsa onu gönderir, yoksa basit bir metin:
  const file = path.join(__dirname, 'public', 'login.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.send('WhatsApp Multi Bot — /admin endpointlerini kullanın.');
});

app.listen(PORT, () => console.log('HTTP server listening on :' + PORT));
