import { Client } from '@elastic/elasticsearch';
import { env } from './env';

export const EMAIL_INDEX = 'reachinbox_emails_v1';
export const EMAIL_ALIAS = 'reachinbox_emails';

export const esClient = new Client({
  node: env.ELASTICSEARCH_NODE || 'http://127.0.0.1:9200',
  headers: {
    accept: 'application/vnd.elasticsearch+json; compatible-with=8',
    'content-type': 'application/vnd.elasticsearch+json; compatible-with=8',
  },
  maxRetries: 3,
  requestTimeout: 10000,
});

export const EMAIL_INDEX_MAPPING = {
  mappings: {
    properties: {
      emailId: { type: 'keyword' },
      userId: { type: 'keyword' },
      senderId: { type: 'keyword' },
      senderEmail: { type: 'keyword' },
      senderName: { type: 'text' },
      recipient: { type: 'keyword' },
      subject: {
        type: 'text',
        analyzer: 'standard',
        fields: {
          keyword: { type: 'keyword', ignore_above: 256 },
        },
      },
      body: { type: 'text', analyzer: 'standard' },
      status: { type: 'keyword' },
      scheduledAt: { type: 'date' },
      sentAt: { type: 'date' },
      failedAt: { type: 'date' },
      errorMessage: { type: 'text' },
      attemptsMade: { type: 'integer' },
      idempotencyKey: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
};

/**
 * Initializes the versioned Elasticsearch index and alias if not already present.
 */
export async function initializeElasticsearch(): Promise<{ index: string; created: boolean }> {
  try {
    const exists = await esClient.indices.exists({ index: EMAIL_INDEX });

    if (!exists) {
      console.log(`[Elasticsearch] Index ${EMAIL_INDEX} does not exist. Creating with mapping...`);
      await esClient.indices.create({
        index: EMAIL_INDEX,
        ...(EMAIL_INDEX_MAPPING as any),
      });

      // Point alias to versioned index
      await esClient.indices.putAlias({
        index: EMAIL_INDEX,
        name: EMAIL_ALIAS,
      });

      console.log(`[Elasticsearch] Index ${EMAIL_INDEX} created with alias ${EMAIL_ALIAS}.`);
      return { index: EMAIL_INDEX, created: true };
    }

    // Verify alias exists
    const aliasExists = await esClient.indices.existsAlias({
      name: EMAIL_ALIAS,
      index: EMAIL_INDEX,
    });

    if (!aliasExists) {
      await esClient.indices.putAlias({
        index: EMAIL_INDEX,
        name: EMAIL_ALIAS,
      });
      console.log(`[Elasticsearch] Alias ${EMAIL_ALIAS} attached to ${EMAIL_INDEX}.`);
    }

    return { index: EMAIL_INDEX, created: false };
  } catch (error: any) {
    console.error('[Elasticsearch] Initialization error:', error.message);
    throw error;
  }
}

/**
 * Health check helper for Elasticsearch service.
 */
export async function checkElasticsearchHealth(): Promise<{ status: string; reachable: boolean; details?: any }> {
  try {
    const health = await esClient.cluster.health();
    return {
      status: health.status || 'unknown',
      reachable: true,
      details: health,
    };
  } catch (error: any) {
    return {
      status: 'unreachable',
      reachable: false,
      details: { error: error.message },
    };
  }
}

export default esClient;
