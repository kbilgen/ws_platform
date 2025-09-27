// session.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth } = require('whatsapp-web.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SESSION_ID = process.env.SESSION_ID;

if (!SESSION_ID) {
  console.error('SESSION_ID is required');
  process.exit(1);
}

async function getSessionRow(id) {
  const { data, error } = await supabase.from('sessions').select('*').eq('id', id).single();
  if (error || !data) throw new Error('Session not found');
  return data;
}

async function setStatus(id, status) {
  await supabase.from('sessions').update({ status }).eq('id', id);
}

async function main() {
  const row = await getSessionRow(SESSION_ID);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_ID }), // DB yerine LocalAuth kullanıyorsan bu kalır
    puppeteer: process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox'] }
      : { args: ['--no-sandbox'] },
  });

  client.on('qr', qr => {
    console.log(`[QR] ${SESSION_ID}: ${qr}`); // QR’ı paneline/DB’ye yazmak istersen burada yaz
  });

  client.on('ready', async () => {
    console.log(`[READY] ${SESSION_ID}`);
    await setStatus(SESSION_ID, 'ready');
  });

  client.on('disconnected', async () => {
    console.log(`[DISCONNECTED] ${SESSION_ID}`);
    await setStatus(SESSION_ID, 'disconnected');
    process.exit(1); // Railway yeniden başlatır
  });

  await setStatus(SESSION_ID, 'pending');
  await client.initialize();
}

main().catch(err => {
  console.error('Session boot error:', err);
  process.exit(1);
});
