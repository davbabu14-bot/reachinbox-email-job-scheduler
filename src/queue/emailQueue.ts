import { Queue, QueueOptions } from 'bullmq';
import { env } from '../config/env';

export const QUEUE_NAME = 'email-scheduler-v2';

export interface EmailJobData {
  emailId: string;
  senderId: string;
  idempotencyKey: string;
  scheduledAt: string; // ISO string
}

const redisUrl = new URL(env.REDIS_URL);

const queueOptions: QueueOptions = {
  connection: {
    host: redisUrl.hostname || '127.0.0.1',
    port: Number(redisUrl.port) || 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      count: 1000,
      age: 7 * 24 * 3600, // 7 days
    },
    removeOnFail: {
      count: 1000,
      age: 7 * 24 * 3600,
    },
  },
};

export const emailQueue = new Queue<EmailJobData>(QUEUE_NAME, queueOptions);

export default emailQueue;
