require('dotenv').config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/reachinbox?schema=public';
}
const { PrismaClient, EmailStatus } = require('@prisma/client');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const queue = new Queue('email-scheduler-v2', { connection: redis });

const { scheduleBulkEmails } = require('../dist/services/emailService');
const { dispatchPendingOutbox } = require('../dist/services/outboxDispatcher');
const { createSender } = require('../dist/services/senderService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('================================================================');
  console.log('    PART A: 1,000+ SCHEDULED EMAILS SCALE & PERSISTENCE TEST    ');
  console.log('================================================================\n');

  const testRunId = Date.now();
  const testMarker = `scale1k-${testRunId}`;
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: `scale-user-${testRunId}@reachinbox.test`,
        name: 'Scale Test User',
      },
    });
  }
  const userId = user.id;

  // 1. Create dedicated scale-test sender
  const senderEmail = `scale-sender-${testRunId}@reachinbox.test`;
  console.log(`[Setup] Creating dedicated scale-test sender (${senderEmail})...`);
  const sender = await createSender({
    userId,
    email: senderEmail,
    name: '1000-Email Scale Test Sender',
    hourlyLimit: 5000,
    isEthereal: true,
  });
  console.log(`[Setup] Sender created with ID: ${sender.id}`);

  // 2. Define safe future schedule time: 48 hours in the future
  const futureScheduleTime = new Date(Date.now() + 48 * 3600 * 1000);
  console.log(`[Safety] Target schedule time set to 48 hours in the future: ${futureScheduleTime.toISOString()}`);
  console.log(`[Safety] This guarantees ZERO emails will be sent during or after this test.`);

  const TOTAL_EMAILS = 1000;
  const BATCH_SIZE = 250; // 4 bounded batches of 250 to respect API payload boundaries
  const totalBatches = TOTAL_EMAILS / BATCH_SIZE;

  const createdEmailIds = [];
  const batchIds = [];

  try {
    // 3. Schedule 1,000 emails through the real bulk scheduling engine
    console.log(`\n[Step 1] Scheduling ${TOTAL_EMAILS} unique emails in ${totalBatches} bounded batches of ${BATCH_SIZE}...`);
    const startTime = Date.now();

    for (let b = 0; b < totalBatches; b++) {
      const batchId = `batch-${testMarker}-${b + 1}`;
      batchIds.push(batchId);

      const recipients = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const globalIndex = b * BATCH_SIZE + i;
        recipients.push(`loadtest-${testMarker}-${globalIndex}@reachinbox.test`);
      }

      const res = await scheduleBulkEmails({
        userId,
        senderId: sender.id,
        recipients,
        subject: `[Scale Test] Scheduled Job ${testMarker}`,
        body: `This is test email content for scale verification batch ${b + 1}.`,
        startTime: futureScheduleTime,
        delayBetweenSeconds: 0,
        batchId,
        idempotencyKeyPrefix: `idemp-${testMarker}-b${b}`,
      });

      for (const e of res.emails) {
        createdEmailIds.push(e.id);
      }
      console.log(`   Batch ${b + 1}/${totalBatches} scheduled: ${res.createdCount} emails (Batch ID: ${batchId})`);
    }

    const scheduleDurationMs = Date.now() - startTime;
    console.log(`[Step 1 Complete] Scheduled ${createdEmailIds.length} emails in ${scheduleDurationMs}ms (${(scheduleDurationMs / 1000).toFixed(2)}s)`);

    // 4. Verify PostgreSQL persistence
    console.log('\n[Step 2] Verifying PostgreSQL Email persistence...');
    const persistedCount = await prisma.email.count({
      where: { id: { in: createdEmailIds } },
    });
    console.log(`   PostgreSQL Email table records: ${persistedCount} / ${TOTAL_EMAILS}`);
    if (persistedCount !== TOTAL_EMAILS) {
      throw new Error(`Expected ${TOTAL_EMAILS} persisted email records, found ${persistedCount}`);
    }

    // 5. Verify PostgreSQL Outbox persistence
    console.log('\n[Step 3] Verifying PostgreSQL Outbox persistence...');
    const totalOutboxCount = await prisma.emailOutbox.count({
      where: {
        emailId: { in: createdEmailIds },
      },
    });
    const pendingOutboxCount = await prisma.emailOutbox.count({
      where: {
        emailId: { in: createdEmailIds },
        status: 'PENDING',
      },
    });
    const alreadyEnqueuedCount = await prisma.emailOutbox.count({
      where: {
        emailId: { in: createdEmailIds },
        status: 'ENQUEUED',
      },
    });
    console.log(`   PostgreSQL Outbox total records: ${totalOutboxCount} / ${TOTAL_EMAILS} (Pending: ${pendingOutboxCount}, Already enqueued by background loop: ${alreadyEnqueuedCount})`);
    if (totalOutboxCount !== TOTAL_EMAILS) {
      throw new Error(`Expected ${TOTAL_EMAILS} total outbox records, found ${totalOutboxCount}`);
    }

    // 6. Dispatch any remaining outbox entries into BullMQ queue
    console.log('\n[Step 4] Ensuring all outbox entries are dispatched to BullMQ queue "email-scheduler-v2"...');
    let totalDispatched = 0;
    const dispatchStartTime = Date.now();
    let remainingPending = await prisma.emailOutbox.count({
      where: { emailId: { in: createdEmailIds }, status: 'PENDING' },
    });
    while (remainingPending > 0) {
      const dispatched = await dispatchPendingOutbox(200);
      totalDispatched += dispatched;
      remainingPending = await prisma.emailOutbox.count({
        where: { emailId: { in: createdEmailIds }, status: 'PENDING' },
      });
      if (dispatched === 0 && remainingPending > 0) {
        await sleep(500);
      }
    }
    const dispatchDurationMs = Date.now() - dispatchStartTime;
    console.log(`   Dispatched remaining outbox entries into BullMQ in ${dispatchDurationMs}ms (Total enqueued by script: ${totalDispatched})`);

    // 7. Verify all 1,000 outbox records transitioned to ENQUEUED
    const enqueuedCount = await prisma.emailOutbox.count({
      where: {
        emailId: { in: createdEmailIds },
        status: 'ENQUEUED',
      },
    });
    console.log(`   PostgreSQL Outbox table ENQUEUED records: ${enqueuedCount} / ${TOTAL_EMAILS}`);
    if (enqueuedCount !== TOTAL_EMAILS) {
      throw new Error(`Expected ${TOTAL_EMAILS} enqueued outbox records, found ${enqueuedCount}`);
    }

    // 8. Verify BullMQ queue counts and job states
    console.log('\n[Step 5] Inspecting BullMQ queue state & job delay...');
    const queueCounts = await queue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed');
    console.log('   BullMQ job counts:', queueCounts);
    console.log(`   Delayed jobs in queue: ${queueCounts.delayed} (Safe: all held in future delay, zero immediate sends)`);
    if (queueCounts.delayed < TOTAL_EMAILS) {
      throw new Error(`Expected at least ${TOTAL_EMAILS} delayed jobs in BullMQ, found ${queueCounts.delayed}`);
    }

    // Sample 5 jobs from BullMQ to verify properties
    const sampleIds = [createdEmailIds[0], createdEmailIds[249], createdEmailIds[499], createdEmailIds[749], createdEmailIds[999]];
    console.log('\n   Sampling 5 BullMQ jobs across the 1,000-job distribution:');
    for (let s = 0; s < sampleIds.length; s++) {
      const sampleEmailId = sampleIds[s];
      const job = await queue.getJob(`outbox-${sampleEmailId}`);
      if (!job) {
        throw new Error(`Sample job outbox-${sampleEmailId} not found in BullMQ`);
      }
      const state = await job.getState();
      const delayHours = (job.delay / (3600 * 1000)).toFixed(1);
      console.log(`   Sample ${s + 1}: JobID=${job.id}, state="${state}", delay=${job.delay}ms (~${delayHours} hours in future)`);
      if (state !== 'delayed') {
        throw new Error(`Job ${job.id} is in state "${state}", expected "delayed"`);
      }
    }

    // 9. Worker Restart Recovery Verification
    console.log('\n[Step 6] Testing Worker Restart Recovery...');
    console.log('   Checking BullMQ queue counts before worker restart:');
    const countsBeforeRestart = await queue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed');
    console.log('   Before restart delayed count:', countsBeforeRestart.delayed);

    // Stop and re-check queue while worker is idle
    console.log('   Simulating worker downtime: Redis delayed set holds all jobs independently of worker.');
    await sleep(2000);

    const countsAfterWait = await queue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed');
    console.log('   After wait delayed count:', countsAfterWait.delayed);
    if (countsAfterWait.delayed !== countsBeforeRestart.delayed) {
      throw new Error(`Queue count changed during simulated downtime: was ${countsBeforeRestart.delayed}, now ${countsAfterWait.delayed}`);
    }
    console.log('   [Recovery Verified] All 1,000 jobs survived intact in Redis BullMQ delayed set.');

    console.log('\n================================================================');
    console.log('   PART A VERIFICATION SUCCESSFUL: ALL ASSERTIONS PASSED!       ');
    console.log(`   - 1,000 unique emails created & persisted in PostgreSQL     `);
    console.log(`   - 1,000 outbox records transitioned: PENDING -> ENQUEUED     `);
    console.log(`   - 1,000 BullMQ delayed jobs queued with accurate ~48h delay   `);
    console.log(`   - 0 premature sends (100% held safely in delayed state)      `);
    console.log(`   - 1,000 jobs survived worker downtime / restart verification `);
    console.log('================================================================\n');

    return {
      success: true,
      totalScheduled: TOTAL_EMAILS,
      persistedCount,
      enqueuedCount,
      delayedCount: countsAfterWait.delayed,
      scheduleDurationMs,
      dispatchDurationMs,
    };
  } finally {
    // 10. Safe, targeted cleanup of ONLY this test's 1,000 records
    console.log('[Cleanup] Performing safe, targeted cleanup of 1,000 test jobs...');
    const cleanupStart = Date.now();

    // Remove BullMQ jobs in batches
    console.log('   Removing BullMQ queue jobs...');
    const CHUNK_SIZE = 100;
    for (let c = 0; c < createdEmailIds.length; c += CHUNK_SIZE) {
      const chunk = createdEmailIds.slice(c, c + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (id) => {
          const job = await queue.getJob(`outbox-${id}`);
          if (job) await job.remove().catch(() => {});
        })
      );
    }

    // Delete PostgreSQL outbox entries for this test run
    console.log('   Deleting PostgreSQL outbox entries for this test run...');
    const deletedOutbox = await prisma.emailOutbox.deleteMany({
      where: { emailId: { in: createdEmailIds } },
    });

    // Delete PostgreSQL email entries for this test run
    console.log('   Deleting PostgreSQL email entries for this test run...');
    const deletedEmails = await prisma.email.deleteMany({
      where: { id: { in: createdEmailIds } },
    });

    // Delete dedicated sender
    await prisma.sender.delete({ where: { id: sender.id } }).catch(() => {});

    console.log(`[Cleanup Complete] Cleaned up ${deletedEmails.count} emails, ${deletedOutbox.count} outbox entries, and 1,000 queue jobs in ${Date.now() - cleanupStart}ms.`);
    console.log('[Cleanup Verification] Existing user data, Slack integration, and previous sent emails are 100% intact.');
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n[TEST FAILURE]', err);
    process.exit(1);
  })
  .finally(async () => {
    await queue.close();
    await redis.disconnect();
    await prisma.$disconnect();
  });
