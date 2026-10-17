'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const { sendMail } = require('./mailer');
const { emailQueue, redisConnection, QUEUE_NAME } = require('./queue');

console.log('[Worker] Starting email worker process...');
console.log(
  `[Worker] Queue: "${QUEUE_NAME}"   Redis: ${redisConnection.host}:${redisConnection.port}`
);

// ── Processor ─────────────────────────────────────────────────────────────────
/**
 * BullMQ job processor — invoked once per job when the job's delay has elapsed.
 *
 * Returns an object that BullMQ persists as job.returnvalue, making the
 * Ethereal preview URL available through the REST API and dashboard.
 *
 * @param {import('bullmq').Job} job
 */
async function processEmail(job) {
  const { to, subject, body, scheduledAt } = job.data;

  console.log(
    `[Worker] Processing job ${job.id} → to="${to}" scheduledAt="${scheduledAt}"`
  );

  const result = await sendMail({ to, subject, body });

  console.log(`[Worker] Job ${job.id} sent. MessageId: ${result.messageId}`);
  if (result.previewUrl) {
    console.log(`[Worker] Ethereal preview: ${result.previewUrl}`);
  }

  // Returned object is stored in job.returnvalue — surfaced via GET /api/jobs
  return {
    messageId: result.messageId,
    previewUrl: result.previewUrl,
    sentAt: new Date().toISOString(),
  };
}

// ── Worker ────────────────────────────────────────────────────────────────────
const worker = new Worker(QUEUE_NAME, processEmail, {
  connection: redisConnection,
  concurrency: 5, // process up to 5 jobs simultaneously
});

// ── Event handlers ────────────────────────────────────────────────────────────
worker.on('completed', (job, result) => {
  console.log(
    `[Worker] \u2713 Job ${job.id} completed.  Preview: ${result?.previewUrl || 'N/A'}`
  );
});

worker.on('failed', (job, err) => {
  console.error(
    `[Worker] \u2717 Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? '?'}): ${err.message}`
  );
});

worker.on('error', (err) => {
  // Connection-level errors; BullMQ will automatically reconnect.
  console.error('[Worker] Worker error (connection/Redis):', err.message);
});

worker.on('stalled', (jobId) => {
  console.warn(`[Worker] Job ${jobId} stalled — will be retried automatically.`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
/**
 * Waits for in-flight jobs to finish before exiting.
 * Also closes the Queue connection opened by requiring ./queue.
 */
async function shutdown(signal) {
  console.log(`\n[Worker] Received ${signal} — draining and shutting down...`);
  try {
    await worker.close();       // finish active jobs, stop polling
    await emailQueue.close();   // close the Queue connection from ./queue
  } catch (err) {
    console.error('[Worker] Error during shutdown:', err.message);
  }
  console.log('[Worker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
