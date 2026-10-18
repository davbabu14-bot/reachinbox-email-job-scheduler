import nodemailer, { Transporter } from 'nodemailer';
import { Sender, Email } from '@prisma/client';
import { decrypt, encrypt } from '../utils/crypto';
import prisma from '../config/db';

const transporterPool = new Map<string, Transporter>();

export interface SendMailResult {
  messageId: string;
  previewUrl: string | null;
}

/**
 * Retrieves or initializes a cached Nodemailer transporter for a given Sender.
 */
export function getOrCreateTransporter(sender: Sender): Transporter {
  const cached = transporterPool.get(sender.id);
  if (cached) {
    return cached;
  }

  const decryptedPassword = decrypt(sender.smtpPassEncrypted, sender.smtpPassIv);

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: {
      user: sender.smtpUser,
      pass: decryptedPassword,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  transporterPool.set(sender.id, transporter);
  return transporter;
}

/**
 * Creates an ephemeral or permanent Ethereal test account and stores it in the database.
 */
export async function createEtherealSender(
  userId: string,
  senderName: string = 'ReachInbox Demo Sender',
  overrideEmail?: string,
  hourlyLimit: number = 50
): Promise<Sender> {
  const testAccount = await nodemailer.createTestAccount();
  const { encrypted, iv } = encrypt(testAccount.pass);
  const emailToUse = (overrideEmail && overrideEmail.trim().toLowerCase()) || testAccount.user;

  const sender = await prisma.sender.upsert({
    where: {
      userId_email: {
        userId,
        email: emailToUse,
      },
    },
    update: {
      name: senderName,
      smtpHost: testAccount.smtp.host,
      smtpPort: 587,
      smtpUser: testAccount.user,
      smtpPassEncrypted: encrypted,
      smtpPassIv: iv,
      hourlyLimit,
      isEthereal: true,
    },
    create: {
      userId,
      email: emailToUse,
      name: senderName,
      smtpHost: testAccount.smtp.host,
      smtpPort: 587,
      smtpUser: testAccount.user,
      smtpPassEncrypted: encrypted,
      smtpPassIv: iv,
      hourlyLimit,
      isEthereal: true,
    },
  });

  return sender;
}

/**
 * Sends an email using the sender's configured transporter.
 * Returns the message ID and test preview URL (if available).
 */
export async function sendEmail(sender: Sender, email: Email): Promise<SendMailResult> {
  const transporter = getOrCreateTransporter(sender);

  const info = await transporter.sendMail({
    from: `"${sender.name}" <${sender.email}>`,
    to: email.recipient,
    subject: email.subject,
    html: email.body,
    headers: {
      'X-ReachInbox-Email-ID': email.id,
      'X-ReachInbox-Idempotency-Key': email.idempotencyKey,
    },
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;

  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === 'string' ? previewUrl : null,
  };
}

/**
 * Sets a custom or mock transporter for a given Sender ID (e.g. for testing transient failures).
 */
export function setTransporterForSender(senderId: string, transporter: Transporter | any): void {
  transporterPool.set(senderId, transporter as Transporter);
}

/**
 * Removes a custom or cached transporter for a sender.
 */
export function removeTransporterForSender(senderId: string): void {
  transporterPool.delete(senderId);
}

/**
 * Clears cached transporter connections (e.g., during tests or worker shutdown).
 */
export function clearTransporterPool(): void {
  for (const transporter of transporterPool.values()) {
    transporter.close();
  }
  transporterPool.clear();
}

