// index.js
// npm i whatsapp-web.js express qrcode-terminal dotenv body-parser axios

const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');
const axios = require('axios');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
require('dotenv').config();

// ====== Env ======
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
let WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SESSION_DIR = process.env.SESSION_DIR || '/data/session';
const PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// ====== WhatsApp Client ======
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: PUPPETEER_EXECUTABLE_PATH
  }
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('QR üretildi. WhatsApp → Bağlı Cihazlar → Tara.');
});

client.on('ready', async () => {
  console.log('✅ WhatsApp bağlantısı KURULDU!');
  try {
    const me = await client.getMe();
    console.log('Hesap:', me?.pushname || me?.id?.user || me?.id?._serialized);
  } catch {}
});

client.on('auth_failure', (m) => console.error('❌ Auth hatası:', m));
client.on('disconnected', (reason) => {
  console.log('⚠️ Koptu:', reason);
  client.initialize();
});

// ====== Webhook yardım ======
function signPayload(str) {
  if (!WEBHOOK_SECRET) return '';
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(str, 'utf8').digest('hex');
}
async function postToWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  const payload = { event, data, ts: Date.now() };
  const body = JSON.stringify(payload);
  const signature = signPayload(body);
  try {
    await axios.post(WEBHOOK_URL, payload, {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Signature': signature } : {})
      }
    });
  } catch (e) {
    console.error('Webhook gönderimi başarısız:', e?.response?.status || e?.message);
  }
}

// ====== Mesaj dinleyici ======
client.on('message', async (msg) => {
  // Webhook'a ham olay
  postToWebhook('message', {
    from: msg.from,
    to: msg.to,
    body: msg.body,
    isGroup: msg.isGroup,
    timestamp: msg.timestamp
  });

  const text = (msg.body || '').trim();

  if (text === '!ping') return msg.reply('pong');
  if (text === '!help') {
    return msg.reply(
      [
        'Komutlar:',
        '• !ping   → pong',
        '• !kim    → chat id / from bilgisi',
      ].join('\n')
    );
  }
  if (text === '!kim') {
    const chat = await msg.getChat();
    return msg.reply(`Chat ID: ${chat.id._serialized}\nFrom: ${msg.from}`);
  }

  // Buraya kendi iş akışını ekleyebilirsin (CRM kaydı, sipariş vb.)
});

// ====== HTTP API ======
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

function requireToken(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && token === API_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// Sağlık
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-web.js api',
    ready: !!client.info?.wid
  });
});

// Webhook ayarla/göster
app.post('/api/set-webhook', requireToken, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Geçerli url verin' });
  }
  WEBHOOK_URL = url;
  return res.json({ ok: true, webhook_url: WEBHOOK_URL });
});
app.get('/api/get-webhook', requireToken, (req, res) => {
  res.json({ ok: true, webhook_url: WEBHOOK_URL, has_secret: !!WEBHOOK_SECRET });
});

// Metin gönder
// body: { to: "905xxxxxxxxx" | "905xxxxxxxxx@c.us", text: "..." }
app.post('/api/send-text', requireToken, async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: 'to ve text zorunlu' });

    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const m = await client.sendMessage(chatId, text);
    res.json({ ok: true, id: m.id.id, to: chatId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-text fail' });
  }
});

// Medya gönder
// body: { to, caption?, media: { base64, mime?, filename? } }
app.post('/api/send-media', requireToken, async (req, res) => {
  try {
    const { to, caption, media } = req.body || {};
    if (!to || !media?.base64) {
      return res.status(400).json({ ok: false, error: 'to ve media.base64 zorunlu' });
    }

    let b64 = media.base64.trim();
    const m = b64.match(/^data:(.+);base64,(.*)$/);
    let mime = media.mime || 'application/octet-stream';
    if (m) { mime = m[1]; b64 = m[2]; }
    const mm = new MessageMedia(mime, b64, media.filename || 'file');

    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const msg = await client.sendMessage(chatId, mm, { caption });
    res.json({ ok: true, id: msg.id.id, to: chatId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-media fail' });
  }
});

// Başlıkla (chat adıyla) gönder
// body: { titleContains, text }
app.post('/api/send-by-title', requireToken, async (req, res) => {
  try {
    const { titleContains, text } = req.body || {};
    if (!titleContains || !text) {
      return res.status(400).json({ ok: false, error: 'titleContains ve text zorunlu' });
    }
    const chats = await client.getChats();
    const chat = chats.find(c => (c.name || '').toLowerCase().includes(titleContains.toLowerCase()));
    if (!chat) return res.status(404).json({ ok: false, error: 'Sohbet bulunamadı' });

    const msg = await client.sendMessage(chat.id._serialized, text);
    res.json({ ok: true, id: msg.id.id, to: chat.id._serialized, title: chat.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'send-by-title fail' });
  }
});

// Dış tetik (sisteminden bizi çağırıp mesaj yollat)
app.post('/api/trigger', requireToken, async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: 'to ve text zorunlu' });
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const m = await client.sendMessage(chatId, text);
    res.json({ ok: true, id: m.id.id, to: chatId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'trigger fail' });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP API hazır → http://localhost:${PORT}`);
});

client.initialize();
