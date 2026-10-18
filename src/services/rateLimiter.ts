import redis from '../config/redis';

const RATE_LIMIT_LUA = `
local history_key = KEYS[1]
local last_send_key = KEYS[2]

local now = tonumber(ARGV[1])
local hourly_limit = tonumber(ARGV[2])
local min_spacing_ms = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])

-- 1. Check minimum inter-send spacing
local last_send = redis.call('GET', last_send_key)
if last_send then
  local elapsed = now - tonumber(last_send)
  if elapsed < min_spacing_ms then
    local wait_ms = min_spacing_ms - elapsed
    return {0, wait_ms, "SPACING_LIMIT"}
  end
end

-- 2. Clean up items outside the rolling 1-hour window
local window_start = now - window_ms
redis.call('ZREMRANGEBYSCORE', history_key, '-inf', window_start)

-- 3. Check hourly quota count
local count = redis.call('ZCARD', history_key)
if count >= hourly_limit then
  -- Fetch the oldest entry in the current window to determine when quota refreshes
  local oldest = redis.call('ZRANGE', history_key, 0, 0, 'WITHSCORES')
  local wait_ms = 5000
  if oldest and #oldest >= 2 then
    local oldest_time = tonumber(oldest[2])
    wait_ms = (oldest_time + window_ms) - now
    if wait_ms < 1000 then wait_ms = 1000 end
  end
  return {0, wait_ms, "HOURLY_QUOTA"}
end

-- 4. Atomically commit reservation
local unique_member = tostring(now) .. '-' .. tostring(math.random(100000, 999999))
redis.call('ZADD', history_key, now, unique_member)
redis.call('PEXPIRE', history_key, window_ms + 60000)
redis.call('SET', last_send_key, now, 'PX', window_ms + 60000)

return {1, 0, "OK"}
`;

export interface ReservationResult {
  allowed: boolean;
  waitMs: number;
  reason: 'OK' | 'SPACING_LIMIT' | 'HOURLY_QUOTA';
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function reserveSenderSlot(
  senderId: string,
  hourlyLimit: number,
  minSpacingMs: number,
  now: number = Date.now()
): Promise<ReservationResult> {
  const historyKey = `rl:sender:${senderId}:history`;
  const lastSendKey = `rl:sender:${senderId}:last_send`;

  const result = (await redis.eval(
    RATE_LIMIT_LUA,
    2,
    historyKey,
    lastSendKey,
    now.toString(),
    hourlyLimit.toString(),
    minSpacingMs.toString(),
    ONE_HOUR_MS.toString()
  )) as [number, number, string];

  return {
    allowed: result[0] === 1,
    waitMs: result[1],
    reason: result[2] as 'OK' | 'SPACING_LIMIT' | 'HOURLY_QUOTA',
  };
}

/**
 * Returns the current usage metrics for a sender without reserving a slot.
 */
export async function getSenderQuotaMetrics(
  senderId: string,
  hourlyLimit: number,
  now: number = Date.now()
): Promise<{ usedInWindow: number; limit: number; remaining: number }> {
  const historyKey = `rl:sender:${senderId}:history`;
  const windowStart = now - ONE_HOUR_MS;

  // Prune expired entries
  await redis.zremrangebyscore(historyKey, '-inf', windowStart);
  const count = await redis.zcard(historyKey);

  return {
    usedInWindow: count,
    limit: hourlyLimit,
    remaining: Math.max(0, hourlyLimit - count),
  };
}

/**
 * Resets the rate limiting keys for a sender (primarily for testing and cleanups).
 */
export async function resetSenderRateLimits(senderId: string): Promise<void> {
  const historyKey = `rl:sender:${senderId}:history`;
  const lastSendKey = `rl:sender:${senderId}:last_send`;
  await redis.del(historyKey, lastSendKey);
}
