import { EmailStatus, OutboxStatus, SearchAction } from '@prisma/client';
import prisma from '../config/db';
import { esClient, EMAIL_ALIAS } from '../config/elasticsearch';

export interface EmailSearchDocument {
  emailId: string;
  userId: string;
  senderId: string;
  senderEmail: string;
  senderName: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  attemptsMade: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchQueryOptions {
  query?: string;
  status?: EmailStatus;
  recipient?: string;
  subject?: string;
  from?: Date | string;
  to?: Date | string;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  results: EmailSearchDocument[];
}

/**
 * Transforms a Prisma Email model (with sender included) into an Elasticsearch document.
 */
export function buildSearchDocument(email: any): EmailSearchDocument {
  return {
    emailId: email.id,
    userId: email.userId,
    senderId: email.senderId,
    senderEmail: email.sender?.email || '',
    senderName: email.sender?.name || '',
    recipient: email.recipient,
    subject: email.subject,
    body: email.body,
    status: email.status,
    scheduledAt: email.scheduledAt instanceof Date ? email.scheduledAt.toISOString() : email.scheduledAt,
    sentAt: email.sentAt instanceof Date ? email.sentAt.toISOString() : email.sentAt || null,
    failedAt: email.failedAt instanceof Date ? email.failedAt.toISOString() : email.failedAt || null,
    errorMessage: email.errorMessage || null,
    attemptsMade: email.attemptsMade || 0,
    idempotencyKey: email.idempotencyKey,
    createdAt: email.createdAt instanceof Date ? email.createdAt.toISOString() : email.createdAt,
    updatedAt: email.updatedAt instanceof Date ? email.updatedAt.toISOString() : email.updatedAt,
  };
}

/**
 * Records a durable search indexing event in PostgreSQL and immediately attempts to sync to Elasticsearch.
 * If Elasticsearch fails, the PostgreSQL outbox retains the record for automatic retry/repair.
 */
export async function recordSearchIndexEvent(
  email: any,
  action: SearchAction = SearchAction.INDEX,
  txClient?: any,
  refresh: boolean | 'wait_for' = true
): Promise<void> {
  const db = txClient || prisma;
  const doc = buildSearchDocument(email);

  // 1. Persist to PostgreSQL search outbox
  const outboxEntry = await db.searchIndexOutbox.create({
    data: {
      emailId: email.id,
      action,
      status: OutboxStatus.PENDING,
      payloadJson: doc,
    },
  });

  // 2. Best-effort immediate Elasticsearch sync
  try {
    if (action === SearchAction.DELETE) {
      await esClient.delete({
        index: EMAIL_ALIAS,
        id: email.id,
        refresh: refresh === true ? true : false,
      });
    } else {
      await esClient.index({
        index: EMAIL_ALIAS,
        id: email.id,
        document: doc,
        refresh: refresh as any,
      });
    }

    // Mark outbox completed using same db/tx context
    await db.searchIndexOutbox.update({
      where: { id: outboxEntry.id },
      data: { status: OutboxStatus.ENQUEUED },
    });
  } catch (err: any) {
    console.warn(`[SearchService] Immediate ES sync failed for email ${email.id}. Queued for retry:`, err.message);
    try {
      await db.searchIndexOutbox.update({
        where: { id: outboxEntry.id },
        data: {
          lastError: err.message,
          attempts: { increment: 1 },
        },
      });
    } catch (_) {
      // Ignore if transaction rolled back
    }
  }
}

/**
 * Dispatches pending search index outbox records to Elasticsearch (Repair / Replay loop).
 */
export async function dispatchPendingSearchIndex(batchSize: number = 50): Promise<number> {
  let processedCount = 0;

  try {
    await prisma.$transaction(async (tx) => {
      const pending = await tx.$queryRaw<any[]>`
        SELECT id, email_id, action, payload_json, attempts
        FROM search_index_outbox
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (!pending || pending.length === 0) return;

      for (const entry of pending) {
        try {
          const doc = entry.payload_json as EmailSearchDocument;
          if (entry.action === 'DELETE') {
            await esClient.delete({
              index: EMAIL_ALIAS,
              id: entry.email_id,
            });
          } else {
            await esClient.index({
              index: EMAIL_ALIAS,
              id: entry.email_id,
              document: doc,
            });
          }

          await tx.searchIndexOutbox.update({
            where: { id: entry.id },
            data: { status: OutboxStatus.ENQUEUED },
          });

          processedCount++;
        } catch (err: any) {
          console.error(`[SearchService] Outbox replay failed for entry ${entry.id}:`, err.message);
          await tx.searchIndexOutbox.update({
            where: { id: entry.id },
            data: {
              lastError: err.message,
              attempts: { increment: 1 },
            },
          });
        }
      }
    });

    if (processedCount > 0) {
      await esClient.indices.refresh({ index: EMAIL_ALIAS });
    }
  } catch (err: any) {
    console.error('[SearchService] dispatchPendingSearchIndex error:', err.message);
  }

  return processedCount;
}

/**
 * Full repair / backfill mechanism: re-indexes all emails for a specific user from PostgreSQL into Elasticsearch.
 */
export async function reindexAllUserEmails(userId: string): Promise<number> {
  const emails = await prisma.email.findMany({
    where: { userId },
    include: { sender: true },
    orderBy: { createdAt: 'desc' },
  });

  if (emails.length === 0) return 0;

  const operations = emails.flatMap((email) => [
    { index: { _index: EMAIL_ALIAS, _id: email.id } },
    buildSearchDocument(email),
  ]);

  const bulkResponse = await esClient.bulk({
    operations,
    refresh: true,
  });

  if (bulkResponse.errors) {
    console.warn('[SearchService] Some documents failed during reindexing bulk operation.');
  }

  return emails.length;
}

/**
 * Executes a validated, paginated search query against Elasticsearch, strictly scoped to the authenticated user.
 */
export async function searchEmails(userId: string, options: SearchQueryOptions): Promise<SearchResult> {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20));
  const fromOffset = (page - 1) * pageSize;

  const mustClauses: any[] = [];
  const filterClauses: any[] = [
    { term: { userId } }, // Strict tenant / user scoping
  ];

  // Full-text query across searchable fields
  if (options.query && options.query.trim()) {
    mustClauses.push({
      multi_match: {
        query: options.query.trim(),
        fields: ['subject^3', 'body', 'recipient^2', 'errorMessage'],
        fuzziness: 'AUTO',
      },
    });
  }

  // Exact status filter
  if (options.status) {
    filterClauses.push({
      term: { status: options.status },
    });
  }

  // Recipient filter
  if (options.recipient && options.recipient.trim()) {
    filterClauses.push({
      term: { recipient: options.recipient.trim().toLowerCase() },
    });
  }

  // Subject filter
  if (options.subject && options.subject.trim()) {
    mustClauses.push({
      match_phrase_prefix: {
        subject: options.subject.trim(),
      },
    });
  }

  // Date range filter
  if (options.from || options.to) {
    const rangeClause: any = {};
    if (options.from) {
      rangeClause.gte = new Date(options.from).toISOString();
    }
    if (options.to) {
      rangeClause.lte = new Date(options.to).toISOString();
    }
    filterClauses.push({
      range: {
        scheduledAt: rangeClause,
      },
    });
  }

  const query: any = {
    bool: {
      filter: filterClauses,
    },
  };

  if (mustClauses.length > 0) {
    query.bool.must = mustClauses;
  }

  const response = await esClient.search({
    index: EMAIL_ALIAS,
    from: fromOffset,
    size: pageSize,
    query,
    sort: [{ scheduledAt: { order: 'desc' } }],
  });

  const totalHits =
    typeof response.hits.total === 'number'
      ? response.hits.total
      : response.hits.total?.value || 0;

  const results: any[] = response.hits.hits.map((hit) => {
    const src = (hit._source || {}) as any;
    return {
      ...src,
      id: src.id || src.emailId || hit._id,
    };
  });

  return {
    total: totalHits,
    page,
    pageSize,
    totalPages: Math.ceil(totalHits / pageSize) || 1,
    results,
  };
}
