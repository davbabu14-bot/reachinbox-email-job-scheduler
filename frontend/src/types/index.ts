export type EmailStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  createdAt?: string;
}

export interface Sender {
  id: string;
  userId: string;
  email: string;
  name: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  hourlyLimit: number;
  isEthereal: boolean;
  createdAt: string;
}

export interface EmailRecord {
  id: string;
  userId: string;
  senderId: string;
  sender?: {
    id: string;
    email: string;
    name: string;
    isEthereal?: boolean;
  };
  batchId?: string | null;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt?: string | null;
  failedAt?: string | null;
  previewUrl?: string | null;
  errorMessage?: string | null;
  attemptsMade: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  results: EmailRecord[];
}

export interface SlackStatus {
  connected: boolean;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
}

export interface ScheduleSinglePayload {
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  senderId?: string;
  idempotencyKey?: string;
}

export interface ScheduleBulkPayload {
  recipients: string[];
  subject: string;
  body: string;
  startTime: string;
  delayBetweenSeconds: number;
  senderId?: string;
  batchId?: string;
}

export type ViewSection = 'all' | 'scheduled' | 'sent' | 'failed';
