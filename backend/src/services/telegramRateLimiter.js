import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/environment.js';
import { getRedisConnection } from '../config/redis.js';

const ACQUIRE_SCRIPT = `
-- bnm:telegram:acquire
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
local nextAt = tonumber(redis.call('HGET', KEYS[2], 'nextAt')) or 0
local pauseUntil = tonumber(redis.call('HGET', KEYS[2], 'pauseUntil')) or 0
local availableAt = math.max(nextAt, pauseUntil)
if availableAt > now then return {0, availableAt - now} end
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return {1, 0} end
return {0, ARGV[3]}
`;

const RELEASE_SCRIPT = `
-- bnm:telegram:release
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[2])
local retryAfter = tonumber(ARGV[3]) or 0
local nextAt = now + interval
local oldPause = tonumber(redis.call('HGET', KEYS[2], 'pauseUntil')) or 0
local pauseUntil = math.max(oldPause, now + retryAfter)
redis.call('HSET', KEYS[2], 'nextAt', nextAt, 'pauseUntil', pauseUntil)
redis.call('PEXPIRE', KEYS[2], math.max(interval, retryAfter) + 60000)
redis.call('DEL', KEYS[1])
return 1
`;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Redis-coordinated, per-chat send gate. A short distributed lease serializes
 * sends across all workers sharing Redis; Redis time controls spacing and cooldowns.
 */
export class RedisTelegramRateLimiter {
  /** @param {{ connectionProvider?: () => import('ioredis').default|null, minIntervalMs?: number, leaseMs?: number, contentionPollMs?: number, logger?: Pick<Console, 'warn'>, wait?: (milliseconds: number) => Promise<void> }} [options] */
  constructor({
    connectionProvider = getRedisConnection,
    minIntervalMs = env.telegramMinIntervalMs,
    leaseMs = 30_000,
    contentionPollMs = 50,
    logger = console,
    wait: waitImpl = wait,
  } = {}) {
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) throw new TypeError('minIntervalMs must be a non-negative integer');
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new TypeError('leaseMs must be at least 1000 ms');
    if (!Number.isInteger(contentionPollMs) || contentionPollMs < 1) throw new TypeError('contentionPollMs must be a positive integer');
    if (typeof connectionProvider !== 'function' || typeof waitImpl !== 'function') throw new TypeError('connectionProvider and wait must be functions');
    this.connectionProvider = connectionProvider;
    this.minIntervalMs = minIntervalMs;
    this.leaseMs = leaseMs;
    this.contentionPollMs = contentionPollMs;
    this.logger = logger;
    this.wait = waitImpl;
    this.localTails = new Map();
    this.localNextAt = new Map();
    this.localPauseUntil = new Map();
  }

  /** Run one Telegram request while holding the shared per-chat send gate. */
  async run(chatId, operation, { timeoutMs = 10_000 } = {}) {
    const connection = this.connectionProvider();
    const chatKey = createHash('sha256').update(String(chatId)).digest('hex');
    if (!connection) return this.#runLocally(chatKey, operation);
    if (connection.status !== 'ready') throw new Error('Redis is unavailable for Telegram rate coordination');
    const lockKey = `bnm:telegram:rate:${chatKey}:lock`;
    const stateKey = `bnm:telegram:rate:${chatKey}:state`;
    const token = randomUUID();
    const leaseMs = Math.max(this.leaseMs, timeoutMs + 5000);

    while (true) {
      const [acquired, delayMs] = await connection.eval(
        ACQUIRE_SCRIPT, 2, lockKey, stateKey, token, String(leaseMs), String(this.contentionPollMs),
      );
      if (Number(acquired) === 1) break;
      await this.wait(Math.max(1, Math.min(Number(delayMs) || this.contentionPollMs, 60_000)));
    }

    let result;
    let operationError;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    try {
      await connection.eval(
        RELEASE_SCRIPT,
        2,
        lockKey,
        stateKey,
        token,
        String(this.minIntervalMs),
        String(Math.max(0, Number(operationError?.retryAfterMs) || 0)),
      );
    } catch (releaseError) {
      // Preserve Telegram's response (especially its retry_after) for MongoDB.
      // A successful send must also remain successful to avoid duplicate delivery.
      this.logger.warn?.('Could not persist Telegram rate-limit timing in Redis:', releaseError.message);
    }

    if (operationError) throw operationError;
    return result;
  }

  async #runLocally(chatKey, operation) {
    const previous = this.localTails.get(chatKey) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.localTails.set(chatKey, tail);
    await previous;
    try {
      const availableAt = Math.max(this.localNextAt.get(chatKey) ?? 0, this.localPauseUntil.get(chatKey) ?? 0);
      if (availableAt > Date.now()) await this.wait(availableAt - Date.now());
      return await operation();
    } catch (error) {
      const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
      if (retryAfterMs) this.localPauseUntil.set(chatKey, Date.now() + retryAfterMs);
      throw error;
    } finally {
      this.localNextAt.set(chatKey, Date.now() + this.minIntervalMs);
      release();
      if (this.localTails.get(chatKey) === tail) this.localTails.delete(chatKey);
    }
  }
}

export const telegramRateLimiter = new RedisTelegramRateLimiter();
export default telegramRateLimiter;
