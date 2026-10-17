'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { emailQueue } = require('./queue');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Validation ───────────────────────────────────────────────────────────────
/** Minimal RFC-5322–inspired email regex (sufficient for basic validation). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Serialises a BullMQ Job object into a safe, API-friendly shape.
 *
 * @param {import('bullmq').Job} job
 * @param {string} status
 */
function formatJob(job, status) {
  return {
    id: job.id,
    status,
    to: job.data.to,
    subject: job.data.subject,
    scheduledAt: job.data.scheduledAt,
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    previewUrl: job.returnvalue?.previewUrl ?? null,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade ?? 0,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/schedule
 *
 * Schedule a future email via a BullMQ delayed job.
 * Body: { to, subject, body, scheduledAt }
 */
app.post('/api/schedule', async (req, res) => {
  const { to, subject, body, scheduledAt } = req.body ?? {};

  // --- Required-field presence check ---
  if (!to || !subject || !body || !scheduledAt) {
    return res.status(400).json({
      error: 'Missing required fields: to, subject, body, scheduledAt',
    });
  }

  // --- Recipient email ---
  if (!EMAIL_RE.test(String(to).trim())) {
    return res.status(400).json({ error: 'Invalid recipient email address.' });
  }

  // --- Subject ---
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'subject must be a non-empty string.' });
  }

  // --- Body ---
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body must be a non-empty string.' });
  }

  // --- Scheduled date ---
  const scheduledDate = new Date(scheduledAt);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduledAt is not a valid ISO date/time.' });
  }

  const delay = scheduledDate.getTime() - Date.now();
  if (delay <= 0) {
    return res.status(400).json({
      error: 'scheduledAt must be a future date/time.',
    });
  }

  try {
    const job = await emailQueue.add(
      'send-email',
      {
        to: String(to).trim(),
        subject: String(subject).trim(),
        body: String(body).trim(),
        scheduledAt: scheduledDate.toISOString(),
      },
      { delay }
    );

    return res.status(201).json({
      id: job.id,
      message: 'Email scheduled successfully.',
      scheduledAt: scheduledDate.toISOString(),
      delayMs: delay,
    });
  } catch (err) {
    console.error('[POST /api/schedule]', err.message);
    return res.status(503).json({
      error: 'Could not schedule email. Redis may be unavailable.',
    });
  }
});

/**
 * GET /api/jobs
 *
 * Returns all jobs grouped by BullMQ state.
 * States fetched: delayed, active, waiting, completed, failed.
 */
app.get('/api/jobs', async (req, res) => {
  try {
    const [delayed, active, waiting, completed, failed] = await Promise.all([
      emailQueue.getJobs(['delayed']),
      emailQueue.getJobs(['active']),
      emailQueue.getJobs(['waiting']),
      emailQueue.getJobs(['completed']),
      emailQueue.getJobs(['failed']),
    ]);

    return res.json({
      delayed: delayed.map((j) => formatJob(j, 'delayed')),
      active: active.map((j) => formatJob(j, 'active')),
      waiting: waiting.map((j) => formatJob(j, 'waiting')),
      completed: completed.map((j) => formatJob(j, 'completed')),
      failed: failed.map((j) => formatJob(j, 'failed')),
    });
  } catch (err) {
    console.error('[GET /api/jobs]', err.message);
    return res.status(503).json({
      error: 'Could not fetch jobs. Redis may be unavailable.',
    });
  }
});

/**
 * GET /api/jobs/:id
 *
 * Returns a single job by ID including its current state.
 */
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await emailQueue.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `Job ${req.params.id} not found.` });
    }
    const state = await job.getState();
    return res.json(formatJob(job, state));
  } catch (err) {
    console.error('[GET /api/jobs/:id]', err.message);
    return res.status(503).json({ error: 'Could not fetch job details.' });
  }
});

/**
 * GET /api/health
 *
 * Pings Redis through BullMQ's underlying connection.
 * Used by the dashboard status badge.
 */
app.get('/api/health', async (req, res) => {
  try {
    const client = await emailQueue.backend.client;
    await client.ping();
    return res.json({
      status: 'ok',
      redis: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: 'degraded',
      redis: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[Server] ReachInbox Scheduler   → http://localhost:${PORT}`);
  console.log(`[Server] Dashboard              → http://localhost:${PORT}/`);
  console.log(`[Server] Health check           → http://localhost:${PORT}/api/health`);
});

server.on('error', (err) => {
  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Server] Received ${signal} — shutting down gracefully...`);
  server.close(async () => {
    try {
      await emailQueue.close();
    } catch (e) {
      console.error('[Server] Error closing queue:', e.message);
    }
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app; // exported for potential testing
