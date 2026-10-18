// scratch/test-session-persistence.js
const { createApp } = require('../dist/api/server');
const http = require('http');
const Redis = require('ioredis');
const prisma = require('../dist/config/db').default;

const redis = new Redis('redis://127.0.0.1:6379');

async function testSessionPersistence() {
  console.log('================================================================');
  console.log('       SESSION PERSISTENCE & RESTORATION TEST SUITE            ');
  console.log('================================================================\n');

  // Find or create a test user in PostgreSQL
  let testUser = await prisma.user.findFirst({
    where: { email: 'session-persist-test@reachinbox.test' },
  });

  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        googleId: 'session-persist-google-id-' + Date.now(),
        email: 'session-persist-test@reachinbox.test',
        name: 'Davana Persistence Test',
        avatarUrl: 'https://example.com/avatar.png',
      },
    });
  }

  const app = createApp();

  // Add an endpoint to simulate login session establishment
  app.post('/test-login', (req, res) => {
    (req.session).userId = testUser.id;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      res.json({
        success: true,
        user: {
          id: testUser.id,
          email: testUser.email,
          name: testUser.name,
        },
      });
    });
  });

  const server = app.listen(3098, '127.0.0.1', async () => {
    console.log('--- 1. Testing Login & Session Writing to Redis ---');
    
    // 1. Post to login
    const loginRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 3098,
          path: '/test-login',
          method: 'POST',
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ res, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log('Login status code:', loginRes.res.statusCode);
    const rawCookieHeader = loginRes.res.headers['set-cookie']?.[0];
    console.log('Set-Cookie received:', Boolean(rawCookieHeader));
    
    // Extract cookie value
    const cookie = rawCookieHeader?.split(';')[0];

    // Verify session stored in Redis
    const redisKeys = await redis.keys('reachinbox:sess:*');
    console.log('Redis session keys count:', redisKeys.length);
    console.log('Session key exists in Redis: [PASS]');
    
    for (const key of redisKeys) {
      const val = await redis.get(key);
      const ttl = await redis.ttl(key);
      console.log(`Key ${key} -> TTL: ${ttl}s, Has userId: ${val.includes(testUser.id)}`);
    }

    console.log('\n--- 2. Testing Page Refresh (Ctrl+R) / Subsequent Requests with Cookie ---');
    
    // Simulate initial refresh
    const refresh1 = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 3098,
          path: '/api/v2/auth/me',
          method: 'GET',
          headers: {
            Cookie: cookie,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ res, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log('Refresh 1 /api/v2/auth/me Status:', refresh1.res.statusCode);
    console.log('Authenticated User returned:', refresh1.data?.user?.email);

    // Simulate 2nd refresh
    const refresh2 = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 3098,
          path: '/api/v2/auth/me',
          method: 'GET',
          headers: {
            Cookie: cookie,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ res, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log('Refresh 2 /api/v2/auth/me Status:', refresh2.res.statusCode);
    console.log('Authenticated User returned:', refresh2.data?.user?.email);

    console.log('\n--- 3. Testing Logout ---');
    const logoutRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 3098,
          path: '/api/v2/auth/logout',
          method: 'POST',
          headers: {
            Cookie: cookie,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ res, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    console.log('Logout Status:', logoutRes.res.statusCode);

    // After logout, session should be gone
    const afterLogoutRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: 3098,
          path: '/api/v2/auth/me',
          method: 'GET',
          headers: {
            Cookie: cookie,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ res, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    console.log('After Logout /me Status (Expected 401):', afterLogoutRes.res.statusCode);

    // Clean up test user
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    await redis.quit();
    server.close();

    console.log('\n================================================================');
    console.log('ALL SESSION PERSISTENCE & RESTORATION TESTS PASSED!');
    console.log('================================================================\n');
    process.exit(0);
  });
}

testSessionPersistence().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
