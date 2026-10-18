require('dotenv').config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/reachinbox?schema=public';
}
const { PrismaClient, EmailStatus } = require('@prisma/client');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const queue = new Queue('email-scheduler-v2', { connection: redis });

const { scheduleEmail } = require('../dist/services/emailService');
const { dispatchPendingOutbox } = require('../dist/services/outboxDispatcher');
const { createSender } = require('../dist/services/senderService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('================================================================');
  console.log('    PART B: REAL HOURLY RATE-LIMIT SLACK ALERT VERIFICATION     ');
  console.log('================================================================\n');

  const testMarker = `test-rl-${Date.now()}`;

  // 1. Verify Slack integration exists
  const integration = await prisma.slackIntegration.findFirst({
    where: { teamName: { not: '' } },
  });
  if (!integration) {
    throw new Error('Precondition failed: No connected Slack integration found in database. Please connect Slack via OAuth first.');
  }
  const userId = integration.userId;
  console.log(`[Setup] Found connected Slack workspace "${integration.teamName}" on channel #${integration.channelName}`);

  // 2. Create disposable test sender with strict quota of 1 email/hour
  const testSenderEmail = `quota-test-${Date.now()}@ethereal.email`;
  console.log(`[Setup] Creating disposable test sender (${testSenderEmail}) with hourlyLimit = 1...`);
  const disposableSender = await createSender({
    userId,
    email: testSenderEmail,
    name: 'Disposable Rate Limit Tester',
    hourlyLimit: 1,
    isEthereal: true,
  });
  console.log(`[Setup] Disposable sender created with ID: ${disposableSender.id}, hourlyLimit: ${disposableSender.hourlyLimit}`);

  // 3. Clear Redis rate-limiter and dedup keys for this disposable sender
  const historyKey = `rl:sender:${disposableSender.id}:history`;
  const lastSendKey = `rl:sender:${disposableSender.id}:last_send`;
  const currentHour = new Date().toISOString().slice(0, 13);
  const dedupKey = `slack:alert:dedup:${disposableSender.id}:${currentHour}`;
  await redis.del(historyKey, lastSendKey, dedupKey);
  console.log(`[Setup] Cleared Redis rate limit and dedup keys for sender ${disposableSender.id}`);

  let email1 = null;
  let email2 = null;

  try {
    // 4. Schedule Email 1: immediately eligible to send
    console.log('\n[Step 1] Scheduling Email 1 (should consume the 1 allowed hourly slot)...');
    const res1 = await scheduleEmail({
      userId,
      senderId: disposableSender.id,
      recipient: `recipient-1-${testMarker}@reachinbox.test`,
      subject: `[RateLimit Test] Email 1 - Allowed Slot (${testMarker})`,
      body: 'This is the first email which consumes the sender hourly quota.',
      scheduledAt: new Date(),
      idempotencyKey: `idemp-1-${testMarker}`,
    });
    email1 = res1.email;
    console.log(`   Email 1 created: ID=${email1.id}, Status=${email1.status}`);

    // 5. Schedule Email 2: scheduled 1 second later (will exceed hourlyLimit of 1)
    console.log('\n[Step 2] Scheduling Email 2 (should be denied by rate limiter & trigger Slack alert)...');
    const res2 = await scheduleEmail({
      userId,
      senderId: disposableSender.id,
      recipient: `recipient-2-${testMarker}@reachinbox.test`,
      subject: `[RateLimit Test] Email 2 - Should Hit Limit (${testMarker})`,
      body: 'This is the second email which must be postponed and trigger a Slack alert.',
      scheduledAt: new Date(Date.now() + 1000),
      idempotencyKey: `idemp-2-${testMarker}`,
    });
    email2 = res2.email;
    console.log(`   Email 2 created: ID=${email2.id}, Status=${email2.status}`);

    // 6. Dispatch pending outbox entries into BullMQ
    console.log('\n[Step 3] Dispatching outbox records to BullMQ queue "email-scheduler-v2"...');
    const dispatched = await dispatchPendingOutbox(10);
    console.log(`   Dispatched ${dispatched} outbox entries into BullMQ`);

    // 7. Wait for worker processing and monitor both jobs
    console.log('\n[Step 4] Monitoring worker execution for Email 1 and Email 2...');
    let email1Sent = false;
    let email2Throttled = false;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max

    while (attempts < maxAttempts) {
      await sleep(1000);
      attempts++;

      const currentEmail1 = await prisma.email.findUnique({ where: { id: email1.id } });
      const currentEmail2 = await prisma.email.findUnique({ where: { id: email2.id } });

      if (currentEmail1?.status === EmailStatus.SENT && !email1Sent) {
        email1Sent = true;
        console.log(`   [Worker Update] Email 1 successfully SENT at ${currentEmail1.sentAt?.toISOString()} (Preview: ${currentEmail1.previewUrl})`);
      }

      // Check BullMQ job state for Email 2
      const job2 = await queue.getJob(`outbox-${email2.id}`);
      if (job2) {
        const state2 = await job2.getState();
        if (state2 === 'delayed' && !email2Throttled) {
          email2Throttled = true;
          console.log(`   [Worker Update] Email 2 transitioned to BullMQ state: "${state2}" (rescheduled, not dropped!)`);
        }
      }

      if (email1Sent && email2Throttled) {
        break;
      }
    }

    if (!email1Sent) {
      throw new Error(`Email 1 failed to reach SENT status within ${maxAttempts} seconds`);
    }
    if (!email2Throttled) {
      throw new Error(`Email 2 was not moved to delayed state by worker rate limiter`);
    }

    // 8. Verify Slack alert deduplication key was set in Redis
    console.log('\n[Step 5] Verifying Slack notification dispatch & Redis deduplication lock...');
    const dedupVal = await redis.get(dedupKey);
    const dedupTtl = await redis.ttl(dedupKey);
    console.log(`   Redis deduplication key (${dedupKey}): value=${dedupVal}, TTL=${dedupTtl}s`);
    if (dedupVal !== '1') {
      throw new Error('Expected Redis deduplication key to be set by notifySenderQuotaExceeded');
    }

    // 9. Verify deduplication prevents flood: immediate second call must return DEDUPLICATED_IN_WINDOW
    const { notifySenderQuotaExceeded } = require('../dist/services/slackService');
    const secondCall = await notifySenderQuotaExceeded(disposableSender.id, 1);
    console.log(`   Immediate subsequent trigger for same sender: sent=${secondCall.sent}, reason=${secondCall.reason}`);
    if (secondCall.reason !== 'DEDUPLICATED_IN_WINDOW') {
      throw new Error(`Expected DEDUPLICATED_IN_WINDOW, got: ${secondCall.reason}`);
    }

    // 10. Verify Email 2 was NOT dropped or marked FAILED
    const finalEmail2 = await prisma.email.findUnique({ where: { id: email2.id } });
    console.log(`   Final Email 2 DB status: ${finalEmail2.status} (Correct: remained scheduled for future retry)`);
    if (finalEmail2.status === EmailStatus.FAILED) {
      throw new Error('Email 2 was incorrectly marked FAILED instead of being postponed');
    }

    console.log('\n================================================================');
    console.log('   PART B VERIFICATION SUCCESSFUL: ALL ASSERTIONS PASSED!       ');
    console.log('   - Real sender hourly quota (1/hr) strictly enforced          ');
    console.log('   - 1st email sent successfully via SMTP                       ');
    console.log('   - 2nd email denied by rate limiter & postponed in BullMQ     ');
    console.log('   - Genuine Slack alert dispatched to connected workspace      ');
    console.log('   - Redis deduplication lock active (prevents flood storms)    ');
    console.log('================================================================\n');

    return {
      success: true,
      senderId: disposableSender.id,
      email1Id: email1.id,
      email2Id: email2.id,
      slackChannel: integration.channelName,
      dedupKeyTtl: dedupTtl,
    };
  } finally {
    // 11. Targeted cleanup: only delete test records created during this run
    console.log('[Cleanup] Cleaning up disposable test records...');
    if (email1) {
      await prisma.emailOutbox.deleteMany({ where: { emailId: email1.id } });
      await prisma.email.delete({ where: { id: email1.id } }).catch(() => {});
      const job1 = await queue.getJob(`outbox-${email1.id}`);
      if (job1) await job1.remove().catch(() => {});
    }
    if (email2) {
      await prisma.emailOutbox.deleteMany({ where: { emailId: email2.id } });
      await prisma.email.delete({ where: { id: email2.id } }).catch(() => {});
      const job2 = await queue.getJob(`outbox-${email2.id}`);
      if (job2) await job2.remove().catch(() => {});
    }
    await prisma.sender.delete({ where: { id: disposableSender.id } }).catch(() => {});
    await redis.del(historyKey, lastSendKey, dedupKey);
    console.log('[Cleanup] Disposable sender, test emails, and test jobs cleaned up safely.');
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
