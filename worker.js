// worker.js
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { makeWorker, makeQueueEvents } = require('./queue');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const QUEUE = process.env.WEBHOOK_QUEUE_NAME || 'webhooks';

function hmac(secret, body) {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

async function getSession(sessionId) {
  const { data, error } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
  if (error) throw error;
  return data;
}

makeWorker(
  QUEUE,
  async job => {
    const { sessionId, event, data, ts } = job.data;
    const session = await getSession(sessionId);
    if (!session?.webhook_url) return;

    const payload = { sessionId, event, data, ts, eventId: job.id };
    const body = JSON.stringify(payload);
    const sig = hmac(session.webhook_secret, body);

    await axios.post(session.webhook_url, payload, {
      timeout: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
      headers: {
        'Content-Type': 'application/json',
        ...(sig ? { 'X-Signature': sig } : {}),
      },
    });
  },
  { concurrency: parseInt(process.env.WEBHOOK_CONCURRENCY || '5', 10) }
);

const qe = makeQueueEvents(QUEUE);
qe.on('completed', ({ jobId }) => console.log('[webhook][ok]', jobId));
qe.on('failed', ({ jobId, failedReason }) => console.error('[webhook][fail]', jobId, failedReason));

console.log('Webhook worker started');
