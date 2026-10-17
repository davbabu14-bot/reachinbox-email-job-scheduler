'use strict';

require('dotenv').config();

const { Queue } = require('bullmq');

const QUEUE_NAME = 'email-scheduler';

/**
 * IORedis connection options shared by both Queue (server) and Worker.
 *
 * maxRetriesPerRequest: null  — required by BullMQ for blocking Redis commands.
 * enableReadyCheck: false     — prevents IORedis from waiting for the READY
 *                               state, which can stall startup if Redis is
 *                               briefly unavailable.
 */
const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const emailQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5_000, // 5 s initial back-off; doubles on each retry
    },
    // Retain history for the dashboard without growing Redis indefinitely.
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

emailQueue.on('error', (err) => {
  console.error('[Queue] Redis error:', err.message);
});

module.exports = { emailQueue, redisConnection, QUEUE_NAME };
