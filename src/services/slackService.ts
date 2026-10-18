import crypto from 'crypto';
import { WebClient } from '@slack/web-api';
import prisma from '../config/db';
import redis from '../config/redis';
import { env } from '../config/env';
import { encrypt, decrypt } from '../utils/crypto';

export interface SlackStatus {
  connected: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
}

export interface SlackNotificationResult {
  sent: boolean;
  reason?: string;
  ts?: string;
}

const DEFAULT_REDIRECT_URI = 'http://localhost:3001/api/v2/slack/callback';

/**
 * Generates an OAuth 2.0 authorization URL for connecting a Slack workspace.
 * Stores a cryptographically secure CSRF state token in Redis with a 10-minute TTL.
 */
export async function getSlackAuthorizeUrl(userId: string): Promise<string> {
  const clientId = env.SLACK_CLIENT_ID || process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    throw new Error('SLACK_CLIENT_ID is not configured in backend environment');
  }

  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = env.SLACK_REDIRECT_URI || process.env.SLACK_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  // Persist state mapping to Redis (10 minutes TTL)
  await redis.set(`slack:oauth:state:${state}`, userId, 'EX', 600);

  const scopes = ['chat:write', 'channels:read', 'groups:read'].join(',');
  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  return authUrl.toString();
}

/**
 * Handles the OAuth callback from Slack, validates CSRF state, exchanges the code for
 * credentials, and stores encrypted bot tokens in PostgreSQL.
 */
export async function handleSlackOAuthCallback(code: string, state: string): Promise<{ userId: string; teamName: string; channelName: string }> {
  if (!code || !state) {
    throw new Error('Invalid OAuth callback parameters: code and state are required');
  }

  const stateKey = `slack:oauth:state:${state}`;
  const userId = await redis.get(stateKey);

  if (!userId) {
    throw new Error('Invalid or expired Slack OAuth state parameter (CSRF protection failed)');
  }

  // Delete state key immediately to prevent replay
  await redis.del(stateKey);

  const clientId = env.SLACK_CLIENT_ID || process.env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET || process.env.SLACK_CLIENT_SECRET;
  const redirectUri = env.SLACK_REDIRECT_URI || process.env.SLACK_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error('Slack OAuth credentials (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET) are not configured');
  }

  // Exchange code for access token via Slack API
  const client = new WebClient();
  const oauthResponse = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!oauthResponse.ok || !oauthResponse.access_token) {
    throw new Error(`Slack OAuth token exchange failed: ${oauthResponse.error || 'Unknown error'}`);
  }

  const accessToken = oauthResponse.access_token as string;
  const teamId = (oauthResponse.team?.id || 'unknown_team') as string;
  const teamName = (oauthResponse.team?.name || 'Slack Workspace') as string;
  let incomingChannelId = (oauthResponse.incoming_webhook?.channel_id || '') as string;
  let incomingChannelName = (oauthResponse.incoming_webhook?.channel || '') as string;

  // If incoming webhook channel was not provided, discover the workspace's default public channel
  if (!incomingChannelId) {
    try {
      const authedClient = new WebClient(accessToken);
      const convList = await authedClient.conversations.list({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
      });

      if (convList.channels && convList.channels.length > 0) {
        const defaultChannel =
          convList.channels.find((c: any) => c.is_general) ||
          convList.channels.find((c: any) => c.name === 'general') ||
          convList.channels[0];

        if (defaultChannel?.id) {
          incomingChannelId = defaultChannel.id;
          incomingChannelName = defaultChannel.name || 'general';
          authedClient.conversations.join({ channel: incomingChannelId }).catch(() => {});
        }
      }
    } catch (listErr: any) {
      console.warn('[SlackService] Could not discover public channels during OAuth callback:', listErr.message);
    }
  }

  if (!incomingChannelName) {
    incomingChannelName = 'general';
  }

  // Encrypt access token at rest using AES-256-GCM
  const { encrypted, iv } = encrypt(accessToken);

  await prisma.slackIntegration.upsert({
    where: { userId },
    update: {
      teamId,
      teamName,
      accessTokenEncrypted: encrypted,
      accessTokenIv: iv,
      channelId: incomingChannelId,
      channelName: incomingChannelName,
    },
    create: {
      userId,
      teamId,
      teamName,
      accessTokenEncrypted: encrypted,
      accessTokenIv: iv,
      channelId: incomingChannelId,
      channelName: incomingChannelName,
    },
  });

  return { userId, teamName, channelName: incomingChannelName };
}

/**
 * Returns safe Slack integration status without exposing tokens or internal secrets.
 */
export async function getSlackStatus(userId: string): Promise<SlackStatus> {
  let integration = await prisma.slackIntegration.findUnique({
    where: { userId },
  });

  if (!integration) {
    return { connected: false };
  }

  // Auto-resolve channelId if empty
  if (!integration.channelId) {
    try {
      const accessToken = decrypt(integration.accessTokenEncrypted, integration.accessTokenIv);
      const authedClient = new WebClient(accessToken);
      const convList = await authedClient.conversations.list({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
      });

      if (convList.channels && convList.channels.length > 0) {
        const defaultChannel =
          convList.channels.find((c: any) => c.is_general) ||
          convList.channels.find((c: any) => c.name === 'general') ||
          convList.channels[0];

        if (defaultChannel?.id) {
          integration = await prisma.slackIntegration.update({
            where: { userId },
            data: {
              channelId: defaultChannel.id,
              channelName: defaultChannel.name || 'general',
            },
          });
        }
      }
    } catch (err: any) {
      console.warn(`[SlackService] Auto-resolving channelId failed for user ${userId}:`, err.message);
    }
  }

  return {
    connected: true,
    teamId: integration.teamId,
    teamName: integration.teamName,
    channelId: integration.channelId,
    channelName: integration.channelName,
  };
}

/**
 * Disconnects Slack integration and deletes stored credentials.
 */
export async function disconnectSlack(userId: string): Promise<boolean> {
  try {
    await prisma.slackIntegration.delete({
      where: { userId },
    });
    return true;
  } catch (err: any) {
    if (err.code === 'P2025') {
      return false; // Record didn't exist
    }
    throw err;
  }
}

/**
 * Updates the alert channel for a user's Slack workspace.
 */
export async function updateSlackChannel(userId: string, channelIdOrName: string, channelName?: string): Promise<void> {
  const integration = await prisma.slackIntegration.findUnique({
    where: { userId },
  });

  if (!integration) {
    throw new Error('Slack integration not found for user');
  }

  let targetId = channelIdOrName;
  let targetName = channelName || channelIdOrName.replace(/^#/, '');

  // If not a Slack channel ID (usually starts with C or G), resolve from workspace channels
  if (!targetId.startsWith('C') && !targetId.startsWith('G')) {
    try {
      const accessToken = decrypt(integration.accessTokenEncrypted, integration.accessTokenIv);
      const authedClient = new WebClient(accessToken);
      const convList = await authedClient.conversations.list({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
      });

      const cleanTarget = targetId.replace(/^#/, '').toLowerCase();
      const match = convList.channels?.find((c: any) => c.name.toLowerCase() === cleanTarget);
      if (match?.id) {
        targetId = match.id;
        targetName = match.name || targetName;
      }
    } catch (err: any) {
      console.warn('[SlackService] Error looking up channel by name:', err.message);
    }
  }

  await prisma.slackIntegration.update({
    where: { userId },
    data: {
      channelId: targetId,
      channelName: targetName,
    },
  });
}

/**
 * Posts a notification to the user's connected Slack alert channel.
 * Gracefully no-ops if Slack is not connected without throwing or interrupting the caller.
 */
export async function sendSlackNotification(
  userId: string,
  message: { text: string; blocks?: any[] }
): Promise<SlackNotificationResult> {
  let integration = await prisma.slackIntegration.findUnique({
    where: { userId },
  });

  if (!integration) {
    return { sent: false, reason: 'SLACK_NOT_CONNECTED' };
  }

  try {
    const accessToken = decrypt(integration.accessTokenEncrypted, integration.accessTokenIv);
    const slackClient = new WebClient(accessToken);

    let channelId = integration.channelId;
    let channelName = integration.channelName;

    // If channelId is missing from database record, auto-resolve it from Slack API
    if (!channelId) {
      try {
        const convList = await slackClient.conversations.list({
          types: 'public_channel',
          exclude_archived: true,
          limit: 100,
        });

        if (convList.channels && convList.channels.length > 0) {
          const defaultChannel =
            convList.channels.find((c: any) => c.is_general) ||
            convList.channels.find((c: any) => c.name === 'general') ||
            convList.channels[0];

          if (defaultChannel?.id) {
            channelId = defaultChannel.id;
            channelName = defaultChannel.name || 'general';
            await prisma.slackIntegration.update({
              where: { userId },
              data: { channelId, channelName },
            });
          }
        }
      } catch (listErr: any) {
        console.warn(`[SlackService] Could not resolve channels for user ${userId}:`, listErr.message);
      }
    }

    if (!channelId) {
      return { sent: false, reason: 'NO_SLACK_CHANNEL_CONFIGURED' };
    }

    try {
      const result = await slackClient.chat.postMessage({
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
      });

      return { sent: true, ts: result.ts };
    } catch (postErr: any) {
      const slackErrorCode = postErr.data?.error || postErr.code;

      if (slackErrorCode === 'not_in_channel') {
        // Attempt to auto-join the public channel
        try {
          await slackClient.conversations.join({ channel: channelId });
          const retryResult = await slackClient.chat.postMessage({
            channel: channelId,
            text: message.text,
            blocks: message.blocks,
          });
          return { sent: true, ts: retryResult.ts };
        } catch {
          return {
            sent: false,
            reason: `Slack bot is not in #${channelName}. Please invite the bot by typing /invite in #${channelName}.`,
          };
        }
      }

      if (slackErrorCode === 'channel_not_found') {
        return {
          sent: false,
          reason: `Channel #${channelName} not found. Please verify the channel name or select a valid channel.`,
        };
      }

      return { sent: false, reason: postErr.message || 'Slack API delivery error' };
    }
  } catch (error: any) {
    console.error(`[SlackService] Notification dispatch failed for user ${userId}:`, error.message);
    return { sent: false, reason: error.message };
  }
}

/**
 * Rate limit alert with atomic deduplication.
 * When a sender hits their hourly quota, dispatches a Slack alert to the sender owner.
 * Deduplicates per sender per hourly window (1 hour TTL) in Redis to prevent notification storms.
 */
export async function notifySenderQuotaExceeded(
  senderId: string,
  quotaLimit: number,
  hourlyWindowIso?: string
): Promise<SlackNotificationResult> {
  const sender = await prisma.sender.findUnique({
    where: { id: senderId },
    include: { user: true },
  });

  if (!sender) {
    return { sent: false, reason: 'SENDER_NOT_FOUND' };
  }

  // Hourly window key (e.g. "2026-10-18T02")
  const currentHour = hourlyWindowIso || new Date().toISOString().slice(0, 13);
  const dedupKey = `slack:alert:dedup:${senderId}:${currentHour}`;

  // Atomic Redis reservation: only the first event in the hour window proceeds
  const isFirstAlert = await redis.set(dedupKey, '1', 'EX', 3600, 'NX');

  if (isFirstAlert !== 'OK') {
    return { sent: false, reason: 'DEDUPLICATED_IN_WINDOW' };
  }

  const alertText = `🚨 ReachInbox Alert: Sender ${sender.name} (${sender.email}) reached the hourly quota limit of ${quotaLimit} emails/hr for window ${currentHour}:00. Subsequent jobs are automatically postponed.`;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🚨 Sender Hourly Rate Limit Reached',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Sender:*\n${sender.name} (<${sender.email}>)`,
        },
        {
          type: 'mrkdwn',
          text: `*Hourly Quota:*\n${quotaLimit} emails/hour`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The scheduling engine has automatically postponed remaining jobs until the hourly rolling window resets.`,
      },
    },
  ];

  return sendSlackNotification(sender.userId, { text: alertText, blocks });
}
