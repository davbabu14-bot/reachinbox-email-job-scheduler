import IORedis, { RedisOptions } from 'ioredis';
import { env } from './env';

export const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export function createRedisConnection(overrides: Partial<RedisOptions> = {}): IORedis {
  return new IORedis(env.REDIS_URL, {
    ...redisOptions,
    ...overrides,
  });
}

// Default singleton client for application queries and health checks
export const redis = createRedisConnection();

export default redis;
