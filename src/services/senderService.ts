import { Sender } from '@prisma/client';
import prisma from '../config/db';
import { encrypt } from '../utils/crypto';
import { createEtherealSender } from './mailerService';

export interface CreateSenderInput {
  userId: string;
  email: string;
  name: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  hourlyLimit?: number;
  isEthereal?: boolean;
}

export type SafeSender = Omit<Sender, 'smtpPassEncrypted' | 'smtpPassIv'>;

const SAFE_SENDER_SELECT = {
  id: true,
  userId: true,
  email: true,
  name: true,
  smtpHost: true,
  smtpPort: true,
  smtpUser: true,
  hourlyLimit: true,
  isEthereal: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Creates a new sender record, encrypting the SMTP password at rest.
 */
export async function createSender(input: CreateSenderInput): Promise<SafeSender> {
  const isEthereal = input.isEthereal ?? (!input.smtpHost || input.smtpHost.includes('ethereal.email'));

  if (isEthereal && (!input.smtpUser || !input.smtpPass)) {
    // Generate fresh Ethereal credentials automatically
    const etherealSender = await createEtherealSender(input.userId, input.name || input.email, input.email, input.hourlyLimit ?? 50);
    const { smtpPassEncrypted, smtpPassIv, ...safe } = etherealSender;
    return safe;
  }

  const { encrypted, iv } = encrypt(input.smtpPass || 'placeholder');

  const sender = await prisma.sender.upsert({
    where: {
      userId_email: {
        userId: input.userId,
        email: input.email.toLowerCase().trim(),
      },
    },
    update: {
      name: input.name.trim(),
      smtpHost: input.smtpHost || 'smtp.ethereal.email',
      smtpPort: input.smtpPort || 587,
      smtpUser: input.smtpUser || input.email,
      smtpPassEncrypted: encrypted,
      smtpPassIv: iv,
      hourlyLimit: input.hourlyLimit ?? 50,
      isEthereal,
    },
    create: {
      userId: input.userId,
      email: input.email.toLowerCase().trim(),
      name: input.name.trim(),
      smtpHost: input.smtpHost || 'smtp.ethereal.email',
      smtpPort: input.smtpPort || 587,
      smtpUser: input.smtpUser || input.email,
      smtpPassEncrypted: encrypted,
      smtpPassIv: iv,
      hourlyLimit: input.hourlyLimit ?? 50,
      isEthereal,
    },
    select: SAFE_SENDER_SELECT,
  });

  return sender;
}

/**
 * Lists all configured senders for a user with encrypted secrets excluded.
 */
export async function listSenders(userId: string): Promise<SafeSender[]> {
  return prisma.sender.findMany({
    where: { userId },
    select: SAFE_SENDER_SELECT,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Retrieves a single sender by ID with encrypted secrets excluded.
 */
export async function getSafeSenderById(id: string): Promise<SafeSender | null> {
  return prisma.sender.findUnique({
    where: { id },
    select: SAFE_SENDER_SELECT,
  });
}

/**
 * Ensures at least one working sender exists for a given user (auto-creates Ethereal sender if needed).
 */
export async function getOrCreateDefaultSender(userId: string): Promise<SafeSender> {
  const existing = await prisma.sender.findFirst({
    where: { userId },
    select: SAFE_SENDER_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    return existing;
  }

  return createSender({
    userId,
    email: 'test@ethereal.email',
    name: 'Default Test Sender',
    isEthereal: true,
  });
}
