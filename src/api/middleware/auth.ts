import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import prisma from '../../config/db';

// Extend Express Request type to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Middleware that requires a valid, authenticated user session.
 * Rejects unauthenticated requests with 401 Unauthorized.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionUserId = (req.session as any)?.userId;

  // Support X-Test-User-Id strictly in non-production or test environments for automated suites
  const testUserId =
    process.env.NODE_ENV !== 'production' && req.headers['x-test-user-id']
      ? (req.headers['x-test-user-id'] as string)
      : null;

  const targetUserId = sessionUserId || testUserId;

  if (!targetUserId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Please log in with Google.',
    });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!user) {
      if (req.session) {
        req.session.destroy(() => {});
      }
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authenticated session refers to a user record that no longer exists.',
      });
      return;
    }

    req.user = user;
    next();
  } catch (error: any) {
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to verify authenticated session.',
    });
  }
}

/**
 * Middleware that ensures an email resource being accessed belongs to the authenticated user.
 */
export async function requireEmailOwnership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }

  const email = await prisma.email.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });

  if (!email || email.userId !== userId) {
    // Return 404 to avoid leaking existence of emails belonging to other users
    res.status(404).json({ error: 'NotFound', message: 'Email not found' });
    return;
  }

  next();
}

/**
 * Middleware that ensures a sender resource being accessed or scheduled through belongs to the authenticated user.
 */
export async function requireSenderOwnership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const senderId = (paramId || req.body?.senderId) as string | undefined;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    return;
  }

  if (!senderId) {
    res.status(400).json({ error: 'BadRequest', message: 'senderId is required' });
    return;
  }

  const sender = await prisma.sender.findUnique({
    where: { id: senderId },
    select: { id: true, userId: true },
  });

  if (!sender || sender.userId !== userId) {
    res.status(404).json({ error: 'NotFound', message: 'Sender not found or does not belong to user' });
    return;
  }

  next();
}
