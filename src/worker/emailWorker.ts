import { Worker, Job, DelayedError, WorkerOptions } from 'bullmq';
import { EmailStatus } from '@prisma/client';
import prisma from '../config/db';
import { env } from '../config/env';
import { QUEUE_NAME, EmailJobData } from '../queue/emailQueue';
import { reserveSenderSlot } from '../services/rateLimiter';
import { sendEmail } from '../services/mailerService';
import { updateEmailStatus } from '../services/emailService';
import { notifySenderQuotaExceeded } from '../services/slackService';
import { dispatchPendingSearchIndex } from '../services/searchService';

const concurrency = Number(process.env.WORKER_CONCURRENCY) || 5;
const minSpacingMs =
  Number(process.env.MIN_INTER_SEND_DELAY_MS) ||
  (Number(process.env.DEFAULT_MIN_INTER_DELAY_SEC) || 2) * 1000;
const defaultHourlyLimit = Number(process.env.DEFAULT_HOURLY_LIMIT) || 50;

/**
 * Core processor for executing scheduled email sends.
 */
export async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<any> {
  const { emailId } = job.data;

  // 1. Authoritative Database Check
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { sender: true },
  });

  if (!email) {
    console.warn(`[Worker] Email record ${emailId} not found in database. Skipping.`);
    return { skipped: true, reason: 'RECORD_NOT_FOUND' };
  }

  // Idempotency: avoid double-sending if already marked SENT
  if (email.status === EmailStatus.SENT) {
    console.log(`[Worker] Email ${emailId} is already marked SENT. Skipping redundant send.`);
    return { skipped: true, reason: 'ALREADY_SENT', previewUrl: email.previewUrl };
  }

  // 2. Distributed Atomic Reservation (Inter-send Spacing & Hourly Quota)
  const hourlyLimit = email.sender.hourlyLimit || defaultHourlyLimit;
  const reservation = await reserveSenderSlot(email.senderId, hourlyLimit, minSpacingMs);

  if (!reservation.allowed) {
    const nextEligibleTime = Date.now() + reservation.waitMs;
    console.log(
      `[Worker] Sender ${email.senderId} throttled (${reservation.reason}). Postponing job ${job.id} by ${reservation.waitMs}ms to ${new Date(nextEligibleTime).toISOString()}`
    );

    // If throttled due to hourly quota exhaustion, notify connected Slack workspace (with atomic deduplication)
    if (reservation.reason === 'HOURLY_QUOTA') {
      notifySenderQuotaExceeded(email.senderId, hourlyLimit)
        .then((result) => {
          console.log(
            `[Worker] Slack quota alert result for sender ${email.senderId}: sent=${result.sent}, ts=${result.ts || 'none'}, reason=${result.reason || 'none'}`
          );
        })
        .catch((err) => {
          console.warn(`[Worker] Slack notification error for sender ${email.senderId}:`, err.message);
        });
    }

    // BullMQ delayed job API using lock token
    if (token) {
      await job.moveToDelayed(nextEligibleTime, token);
    }
    throw new DelayedError();
  }

  // 3. Transition state to PROCESSING once quota slot is reserved
  console.log(`[Worker] Slot reserved for email ${email.id}. Transitioning to PROCESSING...`);
  await updateEmailStatus(email.id, {
    status: EmailStatus.PROCESSING,
    attemptsMade: email.attemptsMade + 1,
  });

  // 4. SMTP Dispatch
  try {
    console.log(`[Worker] Calling sendEmail for ${email.id} to ${email.recipient}...`);
    const sendResult = await sendEmail(email.sender, email);
    console.log(`[Worker] sendEmail succeeded for ${email.id}. Preview: ${sendResult.previewUrl}`);

    // ─────────────────────────────────────────────────────────────────────────
    // DELIVERY GUARANTEES & CRASH WINDOW NOTE:
    // If the worker process or host crashes immediately after the remote SMTP
    // server accepts the email but before the database status update is committed
    // below, BullMQ will detect worker failure and re-queue the job upon recovery.
    // Across distributed boundaries with external SMTP side-effects, this produces
    // at-least-once delivery semantics. The system cannot guarantee exactly-once
    // external SMTP delivery if a crash occurs in this narrow window, although
    // pre-flight database status checks and idempotency keys prevent duplicate
    // execution for any retry triggered prior to SMTP acceptance.
    // ─────────────────────────────────────────────────────────────────────────

    await updateEmailStatus(email.id, {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      previewUrl: sendResult.previewUrl,
    });
    dispatchPendingSearchIndex().catch(() => {});

    console.log(`[Worker] Successfully sent email ${email.id} to ${email.recipient}`);
    return {
      success: true,
      emailId: email.id,
      previewUrl: sendResult.previewUrl,
    };
  } catch (error: any) {
    console.error(`[Worker] Failed sending email ${email.id}:`, error.message);

    const maxAttempts = job.opts.attempts || 3;
    const isFinalAttempt = (job.attemptsMade + 1) >= maxAttempts;

    if (isFinalAttempt) {
      await updateEmailStatus(email.id, {
        status: EmailStatus.FAILED,
        failedAt: new Date(),
        errorMessage: error.message || 'SMTP delivery failed',
      });
    } else {
      // Revert status to SCHEDULED so it accurately reflects pending retry in BullMQ
      await updateEmailStatus(email.id, {
        status: EmailStatus.SCHEDULED,
        errorMessage: `Attempt ${job.attemptsMade + 1} failed: ${error.message}`,
      });
    }

    throw error;
  }
}

const redisUrl = new URL(env.REDIS_URL);

const workerOptions: WorkerOptions = {
  concurrency,
  connection: {
    host: redisUrl.hostname || '127.0.0.1',
    port: Number(redisUrl.port) || 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
};

export function createEmailWorker(customOptions: Partial<WorkerOptions> = {}): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(QUEUE_NAME, processEmailJob, {
    ...workerOptions,
    ...customOptions,
  });

  worker.on('failed', (job, err) => {
    if (err instanceof DelayedError) return;
    console.error(`[Worker] Job ${job?.id} failed with error:`, err.message);
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed.`);
  });

  return worker;
}

// If invoked directly from CLI (npm run worker:v2)
if (require.main === module) {
  console.log(`[Worker] Starting ReachInbox v2 Worker on queue "${QUEUE_NAME}" (concurrency: ${concurrency})...`);
  const worker = createEmailWorker();

  const shutdown = async () => {
    console.log('[Worker] Gracefully shutting down worker...');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default createEmailWorker;
