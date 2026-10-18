require('dotenv').config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/reachinbox?schema=public';
}
const http = require('http');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const assert = require('assert');

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

function request(method, path, body = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3001,
        path: `/api/v2${path}`,
        method,
        headers,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = responseBody;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function run() {
  console.log('================================================================');
  console.log('      AUTHENTICATION SUITE: EMAIL/PASSWORD & GOOGLE TESTS       ');
  console.log('================================================================\n');

  const testId = Date.now();
  const testEmail = `auth-test-${testId}@reachinbox.test`;
  const testPassword = 'StrongPassword123!';
  const testName = 'Auth Test User';

  let testUserId = null;

  try {
    // ─── 1. Successful Registration ───
    console.log('--- 1. Testing Registration (POST /api/v2/auth/register) ---');
    const regRes = await request('POST', '/auth/register', {
      email: testEmail,
      password: testPassword,
      name: testName,
    });

    console.log(`   Registration Status: ${regRes.status} (Expected: 201)`);
    assert.strictEqual(regRes.status, 201, 'Registration should return 201');
    assert.strictEqual(regRes.body.success, true, 'Registration body should indicate success');
    assert.strictEqual(regRes.body.user.email, testEmail, 'Returned email should match');
    testUserId = regRes.body.user.id;

    // Verify password is NOT stored in plaintext
    const dbUser = await prisma.user.findUnique({ where: { id: testUserId } });
    assert(dbUser, 'User must exist in PostgreSQL');
    assert(dbUser.passwordHash, 'User must have a passwordHash');
    assert(!dbUser.passwordHash.includes(testPassword), 'Password must NOT be stored in plaintext');
    assert(dbUser.passwordHash.startsWith('$2'), 'Password hash must be a valid bcrypt hash');
    console.log('   [PASS] User created with secure bcrypt hash. Zero plaintext passwords stored.');

    // Verify session cookie was issued
    const regCookie = regRes.headers['set-cookie']?.[0]?.split(';')[0];
    assert(regCookie, 'Registration should issue a session cookie');
    console.log('   [PASS] Session cookie issued on registration.');

    // ─── 2. Duplicate Registration Rejection ───
    console.log('\n--- 2. Testing Duplicate Registration Rejection ---');
    const dupRes = await request('POST', '/auth/register', {
      email: testEmail,
      password: 'AnotherPassword456!',
      name: 'Duplicate Guy',
    });

    console.log(`   Duplicate Reg Status: ${dupRes.status} (Expected: 409)`);
    assert.strictEqual(dupRes.status, 409, 'Duplicate email registration should return 409');
    assert.strictEqual(dupRes.body.error, 'UserAlreadyExists', 'Error code should be UserAlreadyExists');
    console.log('   [PASS] Duplicate registration rejected.');

    // ─── 3. Successful Login ───
    console.log('\n--- 3. Testing Successful Login (POST /api/v2/auth/login) ---');
    const loginRes = await request('POST', '/auth/login', {
      email: testEmail,
      password: testPassword,
    });

    console.log(`   Login Status: ${loginRes.status} (Expected: 200)`);
    assert.strictEqual(loginRes.status, 200, 'Login should return 200');
    assert.strictEqual(loginRes.body.success, true);
    assert.strictEqual(loginRes.body.user.email, testEmail);

    const loginCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0];
    assert(loginCookie, 'Login should issue a signed session cookie');
    console.log('   [PASS] Login successful, session cookie received.');

    // ─── 4. Authenticated /auth/me with Session Cookie ───
    console.log('\n--- 4. Testing Authenticated /auth/me with Session Cookie ---');
    const meRes = await request('GET', '/auth/me', null, loginCookie);
    console.log(`   /auth/me Status: ${meRes.status} (Expected: 200)`);
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.user.email, testEmail);
    console.log(`   [PASS] /auth/me restored session for user: ${meRes.body.user.name}`);

    // ─── 5. Incorrect Password Rejection ───
    console.log('\n--- 5. Testing Incorrect Password Rejection ---');
    const badLoginRes = await request('POST', '/auth/login', {
      email: testEmail,
      password: 'WrongPassword!',
    });

    console.log(`   Bad Password Status: ${badLoginRes.status} (Expected: 401)`);
    assert.strictEqual(badLoginRes.status, 401, 'Wrong password should return 401');
    assert.strictEqual(badLoginRes.body.error, 'InvalidCredentials');
    console.log('   [PASS] Incorrect password rejected with generic safe message.');

    // ─── 6. Login Rate Limiting (Redis-backed) ───
    console.log('\n--- 6. Testing Login Rate Limiting after Consecutive Failures ---');
    for (let attempt = 1; attempt <= 4; attempt++) {
      await request('POST', '/auth/login', { email: testEmail, password: 'WrongPassword!' });
    }
    // 5th failed attempt should trigger HTTP 429
    const rateLimitedRes = await request('POST', '/auth/login', {
      email: testEmail,
      password: 'WrongPassword!',
    });
    console.log(`   Rate Limited Status: ${rateLimitedRes.status} (Expected: 429)`);
    assert.strictEqual(rateLimitedRes.status, 429, 'Excessive failed attempts should return 429');
    assert.strictEqual(rateLimitedRes.body.error, 'TooManyRequests');
    console.log('   [PASS] Redis rate limiter blocked repeated failed login attempts.');

    // Clear rate limit key for clean test state
    await redis.del(`ratelimit:login:${testEmail}`);

    // ─── 7. Google Login Regression ───
    console.log('\n--- 7. Testing Google Login Regression ---');
    // 7.1 Invalid Google token should return 401
    const invalidGoogle = await request('POST', '/auth/google', { idToken: 'invalid.token.here' });
    console.log(`   Invalid Google Token Status: ${invalidGoogle.status} (Expected: 401)`);
    assert.strictEqual(invalidGoogle.status, 401);

    // 7.2 Unauthenticated /auth/me should return 401
    const unauthMe = await request('GET', '/auth/me');
    console.log(`   Unauthenticated /auth/me Status: ${unauthMe.status} (Expected: 401)`);
    assert.strictEqual(unauthMe.status, 401);

    // 7.3 Logout should invalidate session
    const logoutRes = await request('POST', '/auth/logout', null, loginCookie);
    console.log(`   Logout Status: ${logoutRes.status} (Expected: 200)`);
    assert.strictEqual(logoutRes.status, 200);

    const afterLogoutMe = await request('GET', '/auth/me', null, loginCookie);
    console.log(`   After Logout /auth/me Status: ${afterLogoutMe.status} (Expected: 401)`);
    assert.strictEqual(afterLogoutMe.status, 401);
    console.log('   [PASS] Google login endpoints and session invalidation regression verified.');

    console.log('\n================================================================');
    console.log('         ALL AUTHENTICATION TESTS PASSED (7/7)!                 ');
    console.log('================================================================\n');
  } finally {
    // Teardown test user
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
      await redis.del(`ratelimit:login:${testEmail}`);
      console.log('[Cleanup] Test user cleaned up cleanly.');
    }
    await redis.disconnect();
    await prisma.$disconnect();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[AUTH SUITE FAILED]', err);
    process.exit(1);
  });
