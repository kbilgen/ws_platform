// queue.js
const { Queue, QueueEvents, Worker } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function makeQueue(name) {
  return new Queue(name, { connection });
}

function makeWorker(name, processor, opts = {}) {
  return new Worker(name, processor, { connection, ...opts });
}

function makeQueueEvents(name) {
  return new QueueEvents(name, { connection });
}

module.exports = { makeQueue, makeWorker, makeQueueEvents };
