import { Email, EmailStatus, Prisma, SearchAction } from '@prisma/client';
import prisma from '../config/db';
import { recordSearchIndexEvent } from './searchService';

export interface ScheduleEmailInput {
  userId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: Date;
  idempotencyKey: string;
  batchId?: string;
  refreshIndex?: boolean;
}

export interface ScheduleBulkEmailInput {
  userId: string;
  senderId: string;
  recipients: string[];
  subject: string;
  body: string;
  startTime: Date;
  delayBetweenSeconds: number;
  batchId: string;
  idempotencyKeyPrefix: string;
}

export interface ScheduleEmailResult {
  email: Email;
  isDuplicate: boolean;
}

export interface ScheduleBulkEmailResult {
  batchId: string;
  totalRequested: number;
  createdCount: number;
  duplicateCount: number;
  emails: Email[];
}

/**
 * Schedules a single email within a database transaction, persisting both the authoritative
 * Email record and its transactional EmailOutbox entry atomically.
 */
export async function scheduleEmail(input: ScheduleEmailInput): Promise<ScheduleEmailResult> {
  // Check for existing record with the same idempotency key (duplicate detection)
  const existing = await prisma.email.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing) {
    return {
      email: existing,
      isDuplicate: true,
    };
  }

  // Atomically create Email and EmailOutbox in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Re-check inside transaction to avoid concurrency race
    const concurrentExisting = await tx.email.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (concurrentExisting) {
      return { email: concurrentExisting, isDuplicate: true };
    }

    const email = await tx.email.create({
      data: {
        userId: input.userId,
        senderId: input.senderId,
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        status: EmailStatus.SCHEDULED,
        scheduledAt: input.scheduledAt,
        idempotencyKey: input.idempotencyKey,
        batchId: input.batchId || null,
      },
    });

    await tx.emailOutbox.create({
      data: {
        emailId: email.id,
        scheduledAt: email.scheduledAt,
        status: 'PENDING',
        payloadJson: {
          emailId: email.id,
          senderId: email.senderId,
          idempotencyKey: email.idempotencyKey,
          scheduledAt: email.scheduledAt.toISOString(),
        },
      },
    });

    const sender = await tx.sender.findUnique({ where: { id: email.senderId } });
    await recordSearchIndexEvent(
      { ...email, sender },
      SearchAction.INDEX,
      tx,
      input.refreshIndex ?? true
    );

    return { email, isDuplicate: false };
  });

  return result;
}

/**
 * Schedules a batch of emails across multiple recipients with spacing delays.
 * Each recipient receives a deterministic child idempotency key.
 */
export async function scheduleBulkEmails(input: ScheduleBulkEmailInput): Promise<ScheduleBulkEmailResult> {
  const emails: Email[] = [];
  let createdCount = 0;
  let duplicateCount = 0;

  for (let i = 0; i < input.recipients.length; i++) {
    const recipient = input.recipients[i];
    if (!recipient) continue;

    const childScheduledAt = new Date(input.startTime.getTime() + i * input.delayBetweenSeconds * 1000);
    const childIdempotencyKey = `${input.idempotencyKeyPrefix}:${i}:${recipient.trim().toLowerCase()}`;

    const res = await scheduleEmail({
      userId: input.userId,
      senderId: input.senderId,
      recipient: recipient.trim(),
      subject: input.subject,
      body: input.body,
      scheduledAt: childScheduledAt,
      idempotencyKey: childIdempotencyKey,
      batchId: input.batchId,
      refreshIndex: false,
    });

    emails.push(res.email);
    if (res.isDuplicate) {
      duplicateCount++;
    } else {
      createdCount++;
    }
  }

  return {
    batchId: input.batchId,
    totalRequested: input.recipients.length,
    createdCount,
    duplicateCount,
    emails,
  };
}

/**
 * Retrieves a single email by its ID, including associated sender details.
 */
export async function getEmailById(id: string) {
  return prisma.email.findUnique({
    where: { id },
    include: {
      sender: {
        select: {
          id: true,
          email: true,
          name: true,
          smtpHost: true,
          smtpPort: true,
          hourlyLimit: true,
          isEthereal: true,
        },
      },
    },
  });
}

/**
 * Retrieves a paginated list of emails with optional filtering by status or user.
 */
export async function listEmails(options: {
  userId?: string;
  status?: EmailStatus;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const skip = (page - 1) * limit;

  const where: Prisma.EmailWhereInput = {};
  if (options.userId) where.userId = options.userId;
  if (options.status) where.status = options.status;

  const [total, items] = await Promise.all([
    prisma.email.count({ where }),
    prisma.email.findMany({
      where,
      skip,
      take: limit,
      orderBy: { scheduledAt: 'desc' },
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            name: true,
            isEthereal: true,
          },
        },
      },
    }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Updates the state and delivery metadata of an email record.
 */
export async function updateEmailStatus(
  id: string,
  update: {
    status: EmailStatus;
    previewUrl?: string | null;
    errorMessage?: string | null;
    attemptsMade?: number;
    sentAt?: Date | null;
    failedAt?: Date | null;
  }
): Promise<Email> {
  const updated = await prisma.email.update({
    where: { id },
    data: update,
    include: { sender: true },
  });

  // Non-blocking durable search outbox sync
  recordSearchIndexEvent(updated, SearchAction.UPDATE).catch((err) => {
    console.warn(`[SearchService] Non-blocking update error for email ${id}:`, err.message);
  });

  return updated;
}

