'use strict';

const nodemailer = require('nodemailer');

/** Cached Nodemailer transporter — initialised once per worker process. */
let transporter = null;

/**
 * Returns a Nodemailer SMTP transporter backed by Ethereal's fake SMTP service.
 *
 * Resolution order:
 *   1. ETHEREAL_USER + ETHEREAL_PASS environment variables (if both set).
 *   2. Auto-generated Ethereal test account (credentials printed to console).
 *
 * Emails sent through Ethereal are NEVER delivered to real recipients.
 */
async function getTransporter() {
  if (transporter) return transporter;

  let auth;

  if (process.env.ETHEREAL_USER && process.env.ETHEREAL_PASS) {
    auth = {
      user: process.env.ETHEREAL_USER,
      pass: process.env.ETHEREAL_PASS,
    };
    console.log(`[Mailer] Using Ethereal account from environment: ${auth.user}`);
  } else {
    const account = await nodemailer.createTestAccount();
    auth = { user: account.user, pass: account.pass };
    console.log(`[Mailer] Ethereal test account created: ${account.user}`);
    console.log('[Mailer] NOTE: emails are intercepted by Ethereal; no real delivery occurs.');
  }

  transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false, // STARTTLS
    auth,
  });

  return transporter;
}

/**
 * Sends an email through Ethereal and returns delivery metadata.
 *
 * @param {{ to: string, subject: string, body: string }} options
 * @returns {Promise<{ messageId: string, previewUrl: string|null }>}
 */
async function sendMail({ to, subject, body }) {
  const transport = await getTransporter();

  // Build a minimal HTML body from the plain-text content.
  const htmlBody = body
    .split('\n')
    .map((line) => `<p style="margin:0 0 8px;font-family:Arial,sans-serif;">${line}</p>`)
    .join('\n');

  const info = await transport.sendMail({
    from: '"ReachInbox Scheduler \u2709" <scheduler@ethereal.email>',
    to,
    subject,
    text: body,
    html: `<div style="max-width:600px;padding:24px;">\n${htmlBody}\n</div>`,
  });

  // getTestMessageUrl returns false when the transport is not Ethereal-backed.
  const previewUrl = nodemailer.getTestMessageUrl(info) || null;

  return { messageId: info.messageId, previewUrl };
}

module.exports = { sendMail, getTransporter };
