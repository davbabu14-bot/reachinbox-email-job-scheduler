import { OAuth2Client } from 'google-auth-library';
import { User } from '@prisma/client';
import bcrypt from 'bcryptjs';
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

/**
 * Registers a new user with an email and hashed password.
 */
export async function registerWithPassword(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<User> {
  const normalizedEmail = input.email.toLowerCase().trim();

  if (!input.password || input.password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    const error: any = new Error('An account with this email address already exists');
    error.code = 'USER_ALREADY_EXISTS';
    throw error;
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const name: string = input.name?.trim() || normalizedEmail.split('@')[0] || 'User';

  return prisma.user.create({
    data: {
      email: normalizedEmail,
      name,
      passwordHash,
    },
  });
}

/**
 * Authenticates a user with an email and plaintext password.
 * Returns the user record or throws an error on invalid credentials.
 */
export async function loginWithPassword(input: {
  email: string;
  password: string;
}): Promise<User> {
  const normalizedEmail = input.email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user || !user.passwordHash) {
    const error: any = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const isValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!isValid) {
    const error: any = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  return user;
}
