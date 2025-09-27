// test-redis.js
require('dotenv').config();
const Redis = require('ioredis');

(async () => {
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });

  try {
    // Basit ping
    const pong = await redis.ping();
    console.log('PING:', pong);

    // Key yaz ve oku
    await redis.set('railway:test', 'ok', 'EX', 60);
    const val = await redis.get('railway:test');
    console.log('GET railway:test =>', val);

    // Kuyruğa test job at (opsiyonel)
    const { Queue } = require('bullmq');
    const q = new Queue(process.env.WEBHOOK_QUEUE_NAME || 'webhooks', { connection: redis });
    const job = await q.add('test', { hello: 'world' });
    console.log('Job queued with id:', job.id);

    process.exit(0);
  } catch (err) {
    console.error('Redis test error:', err);
    process.exit(1);
  }
})();
