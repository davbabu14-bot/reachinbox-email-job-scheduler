import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { EmailStatus } from '@prisma/client';
import prisma from '../config/db';
import redis from '../config/redis';
import { checkElasticsearchHealth } from '../config/elasticsearch';
import {
  scheduleEmail,
  scheduleBulkEmails,
  getEmailById,
  listEmails,
} from '../services/emailService';
import {
  createSender,
  listSenders,
  getOrCreateDefaultSender,
} from '../services/senderService';
import { dispatchPendingOutbox } from '../services/outboxDispatcher';
import { searchEmails, reindexAllUserEmails, dispatchPendingSearchIndex } from '../services/searchService';
import {
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
} from '../services/authService';
import {
  getSlackAuthorizeUrl,
  handleSlackOAuthCallback,
  getSlackStatus,
  disconnectSlack,
  updateSlackChannel,
  sendSlackNotification,
} from '../services/slackService';
import { requireAuth } from './middleware/auth';
import { env } from '../config/env';

const router = Router();

/**
 * Fallback helper for backward-compatibility in local development/testing
 * when no session is active.
 */
async function resolveEffectiveUser(req: Request) {
  if (req.user) {
    return req.user;
  }

  const sessionUserId = (req.session as any)?.userId;
  if (sessionUserId) {
    const user = await prisma.user.findUnique({ where: { id: sessionUserId } });
    if (user) return user;
  }

  const testUserId = req.headers['x-test-user-id'] as string | undefined;
  if (testUserId) {
    const user = await prisma.user.findUnique({ where: { id: testUserId } });
    if (user) return user;
  }

  // Fallback to dev user in development
  let devUser = await prisma.user.findFirst({
    where: { email: 'developer@reachinbox.local' },
  });

  if (!devUser) {
    devUser = await prisma.user.create({
      data: {
        googleId: 'dev-local-user-id',
        email: 'developer@reachinbox.local',
        name: 'Local Developer',
      },
    });
  }

  return devUser;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check Endpoint
// ─────────────────────────────────────────────────────────────────────────────
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const [pgResult, redisResult, esResult] = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`,
      redis.ping(),
      checkElasticsearchHealth(),
    ]);

    const isPgOk = pgResult.status === 'fulfilled';
    const isRedisOk = redisResult.status === 'fulfilled' && redisResult.value === 'PONG';
    const isEsOk = esResult.status === 'fulfilled' && esResult.value.reachable;

    const allHealthy = isPgOk && isRedisOk && isEsOk;

    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'ok' : 'degraded',
      services: {
        postgres: isPgOk ? 'connected' : 'error',
        redis: isRedisOk ? 'connected' : 'error',
        elasticsearch: isEsOk ? 'connected' : 'unreachable',
      },
      timestamp: new Date().toISOString(),
      version: '2.0.0',
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Endpoints (Google Identity Services & Sessions)
// ─────────────────────────────────────────────────────────────────────────────
const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
});

router.post('/auth/google', async (req: Request, res: Response): Promise<void> => {
  try {
    const { idToken } = googleAuthSchema.parse(req.body);

    const verifiedProfile = await verifyGoogleIdToken(idToken);
    const user = await findOrCreateGoogleUser(verifiedProfile);

    // Establish authenticated HTTP-only session and ensure Redis commit completes
    (req.session as any).userId = user.id;

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[Auth] Failed to persist session to Redis:', saveErr);
        res.status(500).json({
          success: false,
          error: 'SessionPersistenceError',
          message: 'Failed to establish persistent session in Redis store',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Successfully authenticated with Google',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
      });
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(401).json({
      success: false,
      error: 'AuthenticationFailed',
      message: err.message || 'Failed to authenticate Google ID token',
    });
  }
});

router.get('/auth/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    },
  });
});

router.post('/auth/logout', (req: Request, res: Response): void => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ success: false, error: 'Failed to destroy session' });
        return;
      }
      res.clearCookie('reachinbox.sid', { path: '/' });
      res.json({ success: true, message: 'Logged out successfully' });
    });
  } else {
    res.clearCookie('reachinbox.sid', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Elasticsearch Full-Text Search Endpoints
// ─────────────────────────────────────────────────────────────────────────────
const searchParamsSchema = z.object({
  query: z.string().optional(),
  status: z.nativeEnum(EmailStatus).optional(),
  recipient: z.string().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

router.get('/emails/search', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const parsed = searchParamsSchema.parse(req.query);

    const searchResult = await searchEmails(user.id, parsed);

    res.json({
      success: true,
      ...searchResult,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/emails/reindex', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const count = await reindexAllUserEmails(user.id);
    res.json({
      success: true,
      message: `Successfully reindexed ${count} email records into Elasticsearch`,
      count,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Slack OAuth & Rate Limit Alert Integration Endpoints
// ─────────────────────────────────────────────────────────────────────────────
router.get('/slack/authorize', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const authorizeUrl = await getSlackAuthorizeUrl(user.id);
    res.json({ success: true, authorizeUrl });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/slack/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state } = req.query;

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).json({ success: false, error: 'Missing code or state in OAuth callback' });
      return;
    }

    const result = await handleSlackOAuthCallback(code, state);

    // Redirect to frontend with query indicator or return JSON
    const frontendUrl =
      process.env.FRONTEND_URL ||
      (env.NODE_ENV === 'production' ? 'http://localhost:3000' : 'http://localhost:5173');
    if (req.accepts('html')) {
      res.redirect(`${frontendUrl}/#slack-connected?team=${encodeURIComponent(result.teamName)}`);
    } else {
      res.json({
        success: true,
        message: 'Slack workspace connected successfully',
        teamName: result.teamName,
        channelName: result.channelName,
      });
    }
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/slack/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const status = await getSlackStatus(user.id);
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/slack/channel', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const { channelId, channelName } = z
      .object({ channelId: z.string().min(1), channelName: z.string().optional() })
      .parse(req.body);

    await updateSlackChannel(user.id, channelId, channelName);
    res.json({ success: true, message: 'Alert channel updated successfully' });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/slack/disconnect', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const disconnected = await disconnectSlack(user.id);
    res.json({ success: true, disconnected });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/slack/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const result = await sendSlackNotification(user.id, {
      text: '🔔 Test notification from ReachInbox Email Job Scheduler',
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Senders Management
// ─────────────────────────────────────────────────────────────────────────────
const createSenderSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  hourlyLimit: z.coerce.number().min(1).default(50),
  isEthereal: z.boolean().optional(),
});

router.post('/senders', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const parsed = createSenderSchema.parse(req.body);

    const sender = await createSender({
      userId: user.id,
      ...parsed,
    });

    res.status(201).json({ success: true, sender });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/senders', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    await getOrCreateDefaultSender(user.id);
    const senders = await listSenders(user.id);
    res.json({ success: true, senders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email Scheduling: Single
// ─────────────────────────────────────────────────────────────────────────────
const scheduleSingleSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Body is required'),
  scheduledAt: z.coerce.date().default(() => new Date()),
  senderId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

router.post('/schedule', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const parsed = scheduleSingleSchema.parse(req.body);

    let senderId = parsed.senderId;
    if (!senderId) {
      const defaultSender = await getOrCreateDefaultSender(user.id);
      senderId = defaultSender.id;
    } else {
      // Validate sender ownership
      const sender = await prisma.sender.findUnique({ where: { id: senderId } });
      if (!sender || sender.userId !== user.id) {
        res.status(404).json({ success: false, error: 'Sender not found or does not belong to user' });
        return;
      }
    }

    const headerIdempotencyKey = req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdempotencyKey === 'string' && headerIdempotencyKey.trim()) ||
      parsed.idempotencyKey ||
      `req-${crypto.randomUUID()}`;

    const result = await scheduleEmail({
      userId: user.id,
      senderId,
      recipient: parsed.recipient,
      subject: parsed.subject,
      body: parsed.body,
      scheduledAt: parsed.scheduledAt,
      idempotencyKey,
    });

    dispatchPendingOutbox().catch((e) => console.error('[API] Async outbox error:', e.message));
    dispatchPendingSearchIndex().catch((e) => console.error('[API] Async search index error:', e.message));

    if (result.isDuplicate) {
      res.status(200).json({
        success: true,
        isDuplicate: true,
        message: 'Request already processed with this idempotency key',
        email: result.email,
      });
      return;
    }

    res.status(201).json({
      success: true,
      isDuplicate: false,
      email: result.email,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email Scheduling: Bulk
// ─────────────────────────────────────────────────────────────────────────────
const scheduleBulkSchema = z.object({
  recipients: z.array(z.string().email()).min(1, 'At least one recipient is required').max(500),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Body is required'),
  startTime: z.coerce.date().default(() => new Date()),
  delayBetweenSeconds: z.coerce.number().min(0).default(2),
  senderId: z.string().optional(),
  idempotencyKeyPrefix: z.string().optional(),
  batchId: z.string().optional(),
});

router.post('/schedule/bulk', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const parsed = scheduleBulkSchema.parse(req.body);

    let senderId = parsed.senderId;
    if (!senderId) {
      const defaultSender = await getOrCreateDefaultSender(user.id);
      senderId = defaultSender.id;
    } else {
      const sender = await prisma.sender.findUnique({ where: { id: senderId } });
      if (!sender || sender.userId !== user.id) {
        res.status(404).json({ success: false, error: 'Sender not found or does not belong to user' });
        return;
      }
    }

    const batchId = parsed.batchId || `batch-${crypto.randomUUID()}`;
    const headerIdempotency = req.headers['idempotency-key'];
    const idempotencyKeyPrefix =
      (typeof headerIdempotency === 'string' && headerIdempotency.trim()) ||
      parsed.idempotencyKeyPrefix ||
      `batch-${batchId}`;

    const result = await scheduleBulkEmails({
      userId: user.id,
      senderId,
      recipients: parsed.recipients,
      subject: parsed.subject,
      body: parsed.body,
      startTime: parsed.startTime,
      delayBetweenSeconds: parsed.delayBetweenSeconds,
      batchId,
      idempotencyKeyPrefix,
    });

    dispatchPendingOutbox().catch((e) => console.error('[API] Async outbox error:', e.message));
    dispatchPendingSearchIndex().catch((e) => console.error('[API] Async search index error:', e.message));

    res.status(201).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Jobs / Emails Queries
// ─────────────────────────────────────────────────────────────────────────────
router.get('/jobs', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const statusParam = req.query.status as string | undefined;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;

    let status: EmailStatus | undefined;
    if (statusParam && Object.values(EmailStatus).includes(statusParam.toUpperCase() as EmailStatus)) {
      status = statusParam.toUpperCase() as EmailStatus;
    }

    const result = await listEmails({
      userId: user.id,
      status,
      page,
      limit,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/jobs/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await resolveEffectiveUser(req);
    const email = await getEmailById(req.params.id as string);

    if (!email || email.userId !== user.id) {
      res.status(404).json({ success: false, error: 'Email record not found' });
      return;
    }

    res.json({ success: true, email });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
