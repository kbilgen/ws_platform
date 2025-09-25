// lib/sessionManager.js
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('./db');

const BASE_DATA = process.env.SESSION_DIR || '/data/sessions';
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

const clients = new Map(); // sessionId -> { client, qr, ready }

function hmac(secret, bodyStr) {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(bodyStr, 'utf8').digest('hex');
}

async function sendWebhook(sessionId, event, data) {
  const s = db.getSession(sessionId);
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

function ensureClient(sessionId) {
  return clients.get(sessionId);
}

async function createSession({ id, name }) {
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(BASE_DATA),
      clientId: id, // ayrı klasör: /data/sessions/Default/<id>
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: EXEC_PATH
    }
  });

  clients.set(id, { client, qr: null, ready: false });

  client.on('qr', async qr => {
    const png = await qrcode.toDataURL(qr); // frontend’e göstermek için
    const entry = clients.get(id); if (entry) entry.qr = png;
    db.setStatus(id, 'pending');
  });

  client.on('ready', async () => {
    const entry = clients.get(id); if (entry) { entry.ready = true; entry.qr = null; }
    db.setStatus(id, 'ready');
    await sendWebhook(id, 'ready', {});
  });

  client.on('disconnected', async (reason) => {
    const entry = clients.get(id); if (entry) { entry.ready = false; }
    db.setStatus(id, 'disconnected');
    await sendWebhook(id, 'disconnected', { reason });
    client.initialize(); // auto-reconnect
  });

  client.on('message', async (msg) => {
    await sendWebhook(id, 'message', {
      from: msg.from, to: msg.to, body: msg.body, isGroup: msg.isGroup, timestamp: msg.timestamp
    });
  });

  client.initialize();

  db.upsertSession({
    id, name, status: 'pending',
    api_key: null, webhook_url: null, webhook_secret: null,
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
  db.deleteSession(id);
}

function generateKey() { return crypto.randomBytes(24).toString('hex'); }

async function sendText(id, text, to) {
  const e = ensureClient(id); if (!e) throw new Error('session not found');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  return e.client.sendMessage(chatId, text);
}

async function sendMedia(id, { to, caption, base64, filename, mime }) {
  const e = ensureClient(id); if (!e) throw new Error('session not found');
  let b64 = base64.trim();
  const m = b64.match(/^data:(.+);base64,(.*)$/);
  if (m) { mime = m[1]; b64 = m[2]; }
  const mm = new MessageMedia(mime || 'application/octet-stream', b64, filename || 'file');
  const chatId = to.includes('@') ? to : `${to}@c.us`;
  return e.client.sendMessage(chatId, mm, { caption });
}

module.exports = {
  clients,
  createSession,
  destroySession,
  sendText,
  sendMedia,
  generateKey
};
