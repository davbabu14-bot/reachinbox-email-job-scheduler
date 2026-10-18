import { OutboxStatus } from '@prisma/client';
import prisma from '../config/db';
import { emailQueue, EmailJobData } from '../queue/emailQueue';

let isRunning = false;
let dispatchTimer: NodeJS.Timeout | null = null;

interface RawOutboxEntry {
  id: string;
  email_id: string;
  scheduled_at: Date;
  payload_json: any;
  attempts: number;
}

/**
 * Dispatches a batch of pending outbox entries to BullMQ with transactional locking.
 * Uses PostgreSQL's `FOR UPDATE SKIP LOCKED` to minimize duplicate concurrent outbox
 * dispatches across multiple scheduler workers.
 *
 * ARCHITECTURAL DELIVERY GUARANTEES NOTE:
 * The transactional outbox pattern paired with deterministic BullMQ job IDs provides
 * queue-level deduplication and at-least-once delivery semantics. PostgreSQL/outbox
 * reliability and idempotency checks significantly reduce duplicate risk, but cannot
 * guarantee theoretical exactly-once external SMTP delivery across the crash window
 * between remote SMTP acceptance and local database transaction commit.
 */
export async function dispatchPendingOutbox(batchSize: number = 50): Promise<number> {
  let dispatchedCount = 0;

  try {
    await prisma.$transaction(
      async (tx) => {
        // Fetch pending outbox records locking the rows so concurrent workers skip them
        const pendingEntries = await tx.$queryRaw<RawOutboxEntry[]>`
          SELECT id, email_id, scheduled_at, payload_json, attempts
          FROM email_outbox
          WHERE status = 'PENDING'
          ORDER BY created_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        if (pendingEntries.length === 0) {
          return;
        }

        for (const entry of pendingEntries) {
          try {
            const payload = entry.payload_json as EmailJobData;
            const scheduledEpoch = new Date(entry.scheduled_at).getTime();
            const now = Date.now();
            const delay = Math.max(0, scheduledEpoch - now);

            // Deterministic job ID provides queue-level deduplication in BullMQ
            const jobId = `outbox-${entry.email_id}`;

            await emailQueue.add('send-email', payload, {
              jobId,
              delay,
            });

            await tx.emailOutbox.update({
              where: { id: entry.id },
              data: {
                status: OutboxStatus.ENQUEUED,
              },
            });

            dispatchedCount++;
          } catch (err: any) {
            console.error(`[OutboxDispatcher] Error enqueueing outbox entry ${entry.id}:`, err.message);
            await tx.emailOutbox.update({
              where: { id: entry.id },
              data: {
                attempts: entry.attempts + 1,
                lastError: err.message || 'Unknown queue dispatch error',
              },
            });
          }
        }
      },
      {
        timeout: 10000,
      }
    );
  } catch (error: any) {
    // Ignore transaction errors during process shutdown / disconnection
    if (!error.message?.includes('Transaction not found') && !error.message?.includes('closed transaction')) {
      console.error('[OutboxDispatcher] Transaction failed during outbox dispatch:', error.message);
    }
  }

  return dispatchedCount;
}

/**
 * Starts the background outbox polling loop without using cron.
 */
export function startOutboxDispatcher(intervalMs: number = 2000): void {
  if (isRunning) return;
  isRunning = true;

  const poll = async () => {
    if (!isRunning) return;
    try {
      await dispatchPendingOutbox();
    } catch (err: any) {
      console.error('[OutboxDispatcher] Polling error:', err.message);
    } finally {
      if (isRunning) {
        // Apply +/- 20% random jitter to avoid synchronization across instances
        const jitter = Math.floor((Math.random() - 0.5) * 0.4 * intervalMs);
        dispatchTimer = setTimeout(poll, Math.max(500, intervalMs + jitter));
      }
    }
  };

  poll();
}

/**
 * Gracefully stops the outbox dispatcher.
 */
export function stopOutboxDispatcher(): void {
  isRunning = false;
  if (dispatchTimer) {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
  }
}
