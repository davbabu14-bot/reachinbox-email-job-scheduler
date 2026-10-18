import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import routes from './routes';
import redis from '../config/redis';
import { env } from '../config/env';
import { startOutboxDispatcher, stopOutboxDispatcher } from '../services/outboxDispatcher';
import { serverAdapter, requireBullBoardAuth } from './bullBoard';
import { initializeElasticsearch } from '../config/elasticsearch';

export function createApp() {
  const app = express();

  // CORS configuration supporting credentials for authenticated frontend origins
  const allowedOrigins = [
    env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ].filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, true); // Permissive in development
        }
      },
      credentials: true,
    })
  );

  // Trust reverse proxy (Vite dev proxy or production reverse proxy)
  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Adapter bridging ioredis with connect-redis v10's node-redis set syntax
  // connect-redis v10 calls client.set(key, val, { expiration: { type: 'EX', value: ttl } })
  // ioredis expects client.set(key, val, 'EX', ttl)
  const redisSessionClient = new Proxy(redis, {
    get(target, prop, receiver) {
      if (prop === 'set') {
        return function (key: string, val: string, options?: any) {
          if (options && typeof options === 'object') {
            if (options.expiration?.type === 'EX') {
              return target.set(key, val, 'EX', options.expiration.value);
            }
            if (options.expiration?.type === 'PX') {
              return target.set(key, val, 'PX', options.expiration.value);
            }
            if (options.EX) {
              return target.set(key, val, 'EX', options.EX);
            }
            if (options.PX) {
              return target.set(key, val, 'PX', options.PX);
            }
          }
          return (target as any).set.apply(target, arguments);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });

  // Redis-backed HTTP-only session management
  const redisStore = new RedisStore({
    client: redisSessionClient as any,
    prefix: 'reachinbox:sess:',
  });

  app.use(
    session({
      store: redisStore,
      secret: env.SESSION_SECRET || 'reachinbox-scheduler-default-session-secret-key-32ch',
      resave: false,
      saveUninitialized: false,
      name: 'reachinbox.sid',
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 3600 * 1000, // 7 days
      },
    })
  );

  // Mount Bull Board queue dashboard under /admin/queues (protected)
  app.use('/admin/queues', requireBullBoardAuth, serverAdapter.getRouter());

  // Mount API endpoints under both /api and /api/v2 for backward & versioned compatibility
  app.use('/api/v2', routes);
  app.use('/api', routes);

  // Root status endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'ReachInbox Email Job Scheduler API (TypeScript Engine)',
      version: '2.0.0',
      status: 'operational',
      health: '/api/v2/health',
      auth: {
        googleLogin: '/api/v2/auth/google',
        currentUser: '/api/v2/auth/me',
        logout: '/api/v2/auth/logout',
      },
      search: '/api/v2/emails/search',
      slack: {
        authorize: '/api/v2/slack/authorize',
        status: '/api/v2/slack/status',
      },
      bullBoard: '/admin/queues',
      jobs: '/api/v2/jobs',
      senders: '/api/v2/senders',
    });
  });

  return app;
}

export function startServer(port: number = Number(process.env.API_V2_PORT) || 3001) {
  const app = createApp();

  // Initialize Elasticsearch index mapping on startup
  initializeElasticsearch().catch((err) => {
    console.warn('[Server] Elasticsearch initial index mapping warning:', err.message);
  });

  // Start background outbox polling dispatcher (every 2000ms)
  startOutboxDispatcher(2000);

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`[API v2] TypeScript scheduler server listening strictly on http://127.0.0.1:${port}`);
    console.log(`[API v2] Bull Board queue dashboard mounted at http://127.0.0.1:${port}/admin/queues`);
  });

  const shutdown = async () => {
    console.log('[API v2] Gracefully shutting down...');
    stopOutboxDispatcher();
    server.close();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { server, app, shutdown };
}

// If executed directly
if (require.main === module) {
  startServer();
}

export default createApp;
