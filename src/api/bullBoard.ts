import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Request, Response, NextFunction } from 'express';
import { emailQueue } from '../queue/emailQueue';

export const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue, { readOnlyMode: true })],
  serverAdapter,
});

/**
 * Access control middleware for Bull Board dashboard.
 * Requires an authenticated user session or a valid admin secret header.
 */
export function requireBullBoardAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow if user is authenticated via session
  if (req.session && (req.session as any).userId) {
    return next();
  }

  // Allow if admin API key header matches (e.g. for operations monitoring)
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  const configuredAdminKey = process.env.ADMIN_API_KEY || 'reachinbox-admin-secret-dev-key';

  if (adminKey && adminKey === configuredAdminKey) {
    return next();
  }

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Access to the BullMQ management dashboard requires an authenticated session or admin credentials.',
  });
}
