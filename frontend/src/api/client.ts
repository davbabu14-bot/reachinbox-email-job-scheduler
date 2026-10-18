import type {
  User,
  Sender,
  EmailRecord,
  SearchResult,
  SlackStatus,
  ScheduleSinglePayload,
  ScheduleBulkPayload,
  EmailStatus,
} from '../types';

const BASE_URL = '/api/v2';

class ApiError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const config: RequestInit = {
    ...options,
    credentials: 'include', // Ensures HTTP-only session cookies are sent
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options.headers,
    },
  };

  try {
    const response = await fetch(url, config);
    const contentType = response.headers.get('content-type');
    const isJson = contentType && contentType.includes('application/json');
    const data = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const errorMessage =
        (typeof data === 'object' && (data.message || data.error)) ||
        `Request failed with status ${response.status}`;
      throw new ApiError(errorMessage, response.status, data);
    }

    return data as T;
  } catch (err: any) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw new ApiError(err.message || 'Network request failed', 0);
  }
}

export const api = {
  // Authentication
  auth: {
    async verifyGoogleToken(idToken: string): Promise<{ success: boolean; user: User }> {
      return request('/auth/google', {
        method: 'POST',
        body: JSON.stringify({ idToken }),
      });
    },

    async loginWithPassword(email: string, password: string): Promise<{ success: boolean; user: User }> {
      return request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
    },

    async registerWithPassword(email: string, password: string, name?: string): Promise<{ success: boolean; user: User }> {
      return request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name }),
      });
    },

    async getCurrentUser(): Promise<{ success: boolean; user: User }> {
      return request('/auth/me', { method: 'GET' });
    },

    async logout(): Promise<{ success: boolean }> {
      return request('/auth/logout', { method: 'POST' });
    },
  },

  // Senders
  senders: {
    async list(): Promise<{ success: boolean; senders: Sender[] }> {
      return request('/senders', { method: 'GET' });
    },

    async create(senderData: Partial<Sender>): Promise<{ success: boolean; sender: Sender }> {
      return request('/senders', {
        method: 'POST',
        body: JSON.stringify(senderData),
      });
    },
  },

  // Emails & Scheduling
  emails: {
    async list(params: { status?: EmailStatus; page?: number; limit?: number } = {}): Promise<{
      success: boolean;
      items: EmailRecord[];
      pagination: { total: number; page: number; limit: number; totalPages: number };
    }> {
      const searchParams = new URLSearchParams();
      if (params.status) searchParams.set('status', params.status);
      if (params.page) searchParams.set('page', String(params.page));
      if (params.limit) searchParams.set('limit', String(params.limit));

      const queryStr = searchParams.toString() ? `?${searchParams.toString()}` : '';
      return request(`/jobs${queryStr}`, { method: 'GET' });
    },

    async getById(id: string): Promise<{ success: boolean; email: EmailRecord }> {
      return request(`/jobs/${id}`, { method: 'GET' });
    },

    async scheduleSingle(payload: ScheduleSinglePayload): Promise<{
      success: boolean;
      isDuplicate: boolean;
      email: EmailRecord;
    }> {
      return request('/schedule', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async scheduleBulk(payload: ScheduleBulkPayload): Promise<{
      success: boolean;
      batchId: string;
      totalRequested: number;
      createdCount: number;
      duplicateCount: number;
      emails: EmailRecord[];
    }> {
      return request('/schedule/bulk', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async search(params: {
      query?: string;
      status?: EmailStatus;
      recipient?: string;
      subject?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    }): Promise<SearchResult> {
      const searchParams = new URLSearchParams();
      if (params.query) searchParams.set('query', params.query);
      if (params.status) searchParams.set('status', params.status);
      if (params.recipient) searchParams.set('recipient', params.recipient);
      if (params.subject) searchParams.set('subject', params.subject);
      if (params.from) searchParams.set('from', params.from);
      if (params.to) searchParams.set('to', params.to);
      if (params.page) searchParams.set('page', String(params.page));
      if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));

      const queryStr = searchParams.toString() ? `?${searchParams.toString()}` : '';
      return request(`/emails/search${queryStr}`, { method: 'GET' });
    },
  },

  // Slack Integration
  slack: {
    async getStatus(): Promise<{ success: boolean } & SlackStatus> {
      return request('/slack/status', { method: 'GET' });
    },

    async getAuthorizeUrl(): Promise<{ success: boolean; authorizeUrl: string }> {
      return request('/slack/authorize', { method: 'GET' });
    },

    async updateChannel(channelId: string, channelName?: string): Promise<{ success: boolean }> {
      return request('/slack/channel', {
        method: 'POST',
        body: JSON.stringify({ channelId, channelName }),
      });
    },

    async disconnect(): Promise<{ success: boolean; disconnected: boolean }> {
      return request('/slack/disconnect', { method: 'POST' });
    },

    async sendTest(): Promise<{ success: boolean; sent: boolean; reason?: string }> {
      return request('/slack/test', { method: 'POST' });
    },
  },

  // Health
  health: {
    async check(): Promise<{
      status: string;
      services: { postgres: string; redis: string; elasticsearch: string };
    }> {
      return request('/health', { method: 'GET' });
    },
  },
};

export default api;
