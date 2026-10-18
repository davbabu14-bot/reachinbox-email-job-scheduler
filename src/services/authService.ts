import { OAuth2Client } from 'google-auth-library';
import { User } from '@prisma/client';
import prisma from '../config/db';
import { env } from '../config/env';

export interface VerifiedGoogleUser {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * Validates a Google Identity Services ID token on the backend using Google's official library.
 * Never trusts unverified payload attributes sent from the client.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleUser> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Google ID token is required');
  }

  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is not configured in backend environment');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Invalid Google ID token payload');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: payload.name || payload.email,
    avatarUrl: payload.picture,
  };
}

/**
 * Finds an existing user by Google ID or creates a new authoritative User record in PostgreSQL.
 */
export async function findOrCreateGoogleUser(profile: VerifiedGoogleUser): Promise<User> {
  return prisma.user.upsert({
    where: { googleId: profile.googleId },
    update: {
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    },
    create: {
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    },
  });
}

/**
 * Retrieves a user by primary ID.
 */
export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
  });
}
