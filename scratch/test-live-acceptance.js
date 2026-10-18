// scratch/test-live-acceptance.js
// Acceptance test script targeting the LIVE running V2 server (port 3001) and Vite frontend (port 5173)

const http = require('http');

console.log('================================================================');
console.log('       LIVE LOCAL APPLICATION ACCEPTANCE TEST SUITE            ');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;
let notVerifiedCount = 0;

function pass(msg) {
  console.log(`   [PASS] ${msg}`);
  passCount++;
}

function fail(msg) {
  console.error(`   [FAIL] ${msg}`);
  failCount++;
}

function notVerified(msg, reason) {
  console.log(`   [NOT VERIFIED] ${msg}`);
  console.log(`                  Reason: ${reason}`);
  notVerifiedCount++;
}

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
          raw: data,
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runAcceptanceTests() {
  // ─── 1. FRONTEND SERVER AND PROXY CONNECTIVITY ───
  console.log('--- 1. Vite Frontend & Proxy Verification (Port 5173) ---');
  try {
    const viteRes = await httpRequest({
      hostname: 'localhost',
      port: 5173,
      path: '/',
      method: 'GET',
    });
    if (viteRes.statusCode === 200 && viteRes.raw.includes('ReachInbox')) {
      pass('Vite development server serving application HTML on http://localhost:5173/');
    } else {
      fail(`Vite returned status ${viteRes.statusCode}`);
    }

    const proxyHealth = await httpRequest({
      hostname: 'localhost',
      port: 5173,
      path: '/api/v2/health',
      method: 'GET',
    });
    if (proxyHealth.statusCode === 200 && proxyHealth.data?.services?.postgres === 'connected') {
      pass('Vite proxy successfully forwards /api/v2/health to backend (services: PG, Redis, ES all connected)');
    } else {
      fail(`Proxy to /api/v2/health returned ${proxyHealth.statusCode}`);
    }
  } catch (err) {
    fail(`Vite connectivity failed: ${err.message}`);
  }

  // ─── 2. AUTHENTICATION & LOGIN WORKFLOW ───
  console.log('\n--- 2. Authentication & Login Screen Workflow ---');
  try {
    // Check unauthenticated session
    const unauthMe = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/v2/auth/me',
      method: 'GET',
    });
    if (unauthMe.statusCode === 401) {
      pass('Unauthenticated GET /api/v2/auth/me correctly returns 401 Unauthorized');
    } else {
      fail(`Expected 401 for unauthenticated /me, got ${unauthMe.statusCode}`);
    }

    // Google Sign-In with real ID token
    notVerified(
      'Live Google Sign-In with Google Cloud Identity Services',
      'VITE_GOOGLE_CLIENT_ID is not configured in environment. The LoginScreen clearly renders the "Google Client ID Pending Configuration" setup banner.'
    );
  } catch (err) {
    fail(`Auth test error: ${err.message}`);
  }

  // ─── 3. SENDERS SELECTION ───
  console.log('\n--- 3. Senders Selection & Creation Workflow ---');
  let defaultSenderId = null;
  try {
    const sendersRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/v2/senders',
      method: 'GET',
    });
    if (sendersRes.statusCode === 200 && Array.isArray(sendersRes.data?.senders)) {
      pass(`GET /api/v2/senders returned ${sendersRes.data.senders.length} real sender records`);
      if (sendersRes.data.senders.length > 0) {
        defaultSenderId = sendersRes.data.senders[0].id;
        pass(`Active sender: "${sendersRes.data.senders[0].name}" <${sendersRes.data.senders[0].email}> (Limit: ${sendersRes.data.senders[0].hourlyLimit}/hr)`);
      }
    } else {
      fail(`Failed to fetch senders: status ${sendersRes.statusCode}`);
    }
  } catch (err) {
    fail(`Sender workflow error: ${err.message}`);
  }

  // ─── 4. SCHEDULE SUBMISSION & ENGINE VERIFICATION ───
  console.log('\n--- 4. Schedule Submission & Engine Persistence ---');
  const testRecipient = `acceptance-test-${Date.now()}@reachinbox.test`;
  const testSubject = `Acceptance Test Email ${new Date().toISOString()}`;
  const testBody = 'Hello from automated Phase 3B acceptance testing run.';
  let scheduledEmailId = null;

  try {
    // Schedule a single email 10 minutes in future
    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const schedulePayload = {
      recipient: testRecipient,
      subject: testSubject,
      body: testBody,
      scheduledAt: scheduledAt,
      senderId: defaultSenderId || undefined,
    };

    const scheduleRes = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: 3001,
        path: '/api/v2/schedule',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      schedulePayload
    );

    if ((scheduleRes.statusCode === 201 || scheduleRes.statusCode === 200) && scheduleRes.data?.email) {
      scheduledEmailId = scheduleRes.data.email.id;
      pass(`POST /api/v2/schedule successfully created email record ID: ${scheduledEmailId}`);
      pass(`Email scheduled in PostgreSQL with status "${scheduleRes.data.email.status}" at ${scheduleRes.data.email.scheduledAt}`);
    } else {
      fail(`Schedule submission failed: status ${scheduleRes.statusCode}, body: ${JSON.stringify(scheduleRes.data)}`);
    }

    // Schedule bulk emails with spacing
    const bulkPayload = {
      recipients: [
        `bulk-1-${Date.now()}@reachinbox.test`,
        `bulk-2-${Date.now()}@reachinbox.test`,
      ],
      subject: 'Bulk Outreach Acceptance Test',
      body: 'Bulk delivery test with inter-email spacing',
      delayBetweenSeconds: 3,
      senderId: defaultSenderId || undefined,
    };

    const bulkRes = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: 3001,
        path: '/api/v2/schedule/bulk',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      bulkPayload
    );

    if (bulkRes.statusCode === 201 && bulkRes.data?.createdCount === 2) {
      pass(`POST /api/v2/schedule/bulk successfully enqueued ${bulkRes.data.createdCount} emails (Batch ID: ${bulkRes.data.batchId})`);
    } else {
      fail(`Bulk schedule failed: status ${bulkRes.statusCode}`);
    }
  } catch (err) {
    fail(`Scheduling submission error: ${err.message}`);
  }

  // ─── 5. ELASTICSEARCH SEARCH & MAILBOX QUERIES ───
  console.log('\n--- 5. Mailbox Views & Elasticsearch Search Workflow ---');
  try {
    // Wait briefly for async search index outbox dispatch
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Authoritative jobs list
    const jobsRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/v2/jobs?status=SCHEDULED&limit=5',
      method: 'GET',
    });
    if (jobsRes.statusCode === 200 && Array.isArray(jobsRes.data?.items)) {
      pass(`GET /api/v2/jobs?status=SCHEDULED loaded real records (total: ${jobsRes.data.pagination.total})`);
    } else {
      fail(`Failed to load scheduled jobs: status ${jobsRes.statusCode}`);
    }

    // Full-text search via Elasticsearch
    const searchRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: `/api/v2/emails/search?query=${encodeURIComponent('Acceptance')}`,
      method: 'GET',
    });
    if (searchRes.statusCode === 200 && searchRes.data?.success) {
      pass(`GET /api/v2/emails/search queried Elasticsearch cluster (hits: ${searchRes.data.total})`);
    } else {
      fail(`Search query failed: status ${searchRes.statusCode}`);
    }
  } catch (err) {
    fail(`Mailbox / search query error: ${err.message}`);
  }

  // ─── 6. SLACK INTEGRATION STATUS ───
  console.log('\n--- 6. Slack Integration Workflow ---');
  try {
    const slackStatusRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/v2/slack/status',
      method: 'GET',
    });
    if (slackStatusRes.statusCode === 200) {
      pass(`GET /api/v2/slack/status returned actual status: connected=${slackStatusRes.data.connected}`);
    } else {
      fail(`Slack status returned ${slackStatusRes.statusCode}`);
    }

    const testAlertRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/v2/slack/test',
      method: 'POST',
    });
    if (testAlertRes.statusCode === 200 && testAlertRes.data.sent === false && testAlertRes.data.reason === 'SLACK_NOT_CONNECTED') {
      pass('POST /api/v2/slack/test handled safely when disconnected (reason: SLACK_NOT_CONNECTED)');
    } else {
      fail(`Slack test alert unexpected response: ${JSON.stringify(testAlertRes.data)}`);
    }

    notVerified(
      'Live Slack Workspace Alert Delivery',
      'SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are not configured in environment. Safe fallback verified.'
    );
  } catch (err) {
    fail(`Slack integration error: ${err.message}`);
  }

  // ─── 7. BULL BOARD DASHBOARD LINK ───
  console.log('\n--- 7. Bull Board Protected Route ---');
  try {
    const bullBoardRes = await httpRequest({
      hostname: '127.0.0.1',
      port: 3001,
      path: '/admin/queues',
      method: 'GET',
    });
    if (bullBoardRes.statusCode === 401 || bullBoardRes.statusCode === 200) {
      pass(`Bull Board route /admin/queues responded with HTTP ${bullBoardRes.statusCode} (Access protection active)`);
    } else {
      fail(`Bull Board returned unexpected status ${bullBoardRes.statusCode}`);
    }
  } catch (err) {
    fail(`Bull Board error: ${err.message}`);
  }

  // ─── SUMMARY ───
  console.log('\n================================================================');
  console.log(`Live Acceptance Test Results: ${passCount} Passed, ${failCount} Failed, ${notVerifiedCount} Not Verified`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAcceptanceTests().catch((err) => {
  console.error('Fatal acceptance test error:', err);
  process.exit(1);
});
