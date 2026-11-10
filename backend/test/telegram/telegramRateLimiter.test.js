import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisTelegramRateLimiter } from '../../src/services/telegramRateLimiter.js';

class SharedRedisMock {
  constructor() {
    this.status = 'ready';
    this.locks = new Map();
    this.state = new Map();
  }

  async eval(script, _keyCount, lockKey, stateKey, token, leaseMs, value) {
    const now = Date.now();
    if (script.includes('bnm:telegram:acquire')) {
      const entry = this.state.get(stateKey) ?? { nextAt: 0, pauseUntil: 0 };
      const availableAt = Math.max(entry.nextAt, entry.pauseUntil);
      if (availableAt > now) return [0, availableAt - now];
      const currentLock = this.locks.get(lockKey);
      if (currentLock && currentLock.expiresAt > now) return [0, 5];
      this.locks.set(lockKey, { token, expiresAt: now + Number(leaseMs) });
      return [1, 0];
    }

    const currentLock = this.locks.get(lockKey);
    if (currentLock?.token !== token) return 0;
    const entry = this.state.get(stateKey) ?? { nextAt: 0, pauseUntil: 0 };
    const intervalMs = Number(leaseMs);
    const retryAfterMs = Number(value) || 0;
    entry.nextAt = now + intervalMs;
    entry.pauseUntil = Math.max(entry.pauseUntil, now + retryAfterMs);
    this.state.set(stateKey, entry);
    this.locks.delete(lockKey);
    return 1;
  }
}

test('Redis gate serializes concurrent workers and spaces sends for the same chat', async () => {
  const redis = new SharedRedisMock();
  const makeLimiter = () => new RedisTelegramRateLimiter({
    connectionProvider: () => redis, minIntervalMs: 35, leaseMs: 1000, contentionPollMs: 5,
    logger: { warn() {} },
  });
  const starts = [];
  const send = (limiter) => limiter.run('@private_channel', async () => {
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 2));
  }, { timeoutMs: 100 });

  await Promise.all([send(makeLimiter()), send(makeLimiter()), send(makeLimiter())]);
  starts.sort((left, right) => left - right);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 25, `second send started after ${starts[1] - starts[0]}ms`);
  assert.ok(starts[2] - starts[1] >= 25, `third send started after ${starts[2] - starts[1]}ms`);
});

test('429 retry_after pauses every worker sharing the chat gate', async () => {
  const redis = new SharedRedisMock();
  const limiterA = new RedisTelegramRateLimiter({ connectionProvider: () => redis, minIntervalMs: 10, leaseMs: 1000, contentionPollMs: 5, logger: { warn() {} } });
  const limiterB = new RedisTelegramRateLimiter({ connectionProvider: () => redis, minIntervalMs: 10, leaseMs: 1000, contentionPollMs: 5, logger: { warn() {} } });
  const rateLimitedAt = Date.now();
  await assert.rejects(limiterA.run('@private_channel', async () => {
    const error = new Error('Too Many Requests');
    error.retryAfterMs = 100;
    throw error;
  }, { timeoutMs: 100 }), /Too Many Requests/);

  let nextSendAt;
  await limiterB.run('@private_channel', async () => { nextSendAt = Date.now(); }, { timeoutMs: 100 });
  assert.ok(nextSendAt - rateLimitedAt >= 90, `next send started after ${nextSendAt - rateLimitedAt}ms`);
});

test('different Telegram chats have independent rate gates', async () => {
  const redis = new SharedRedisMock();
  const limiter = new RedisTelegramRateLimiter({ connectionProvider: () => redis, minIntervalMs: 100, leaseMs: 1000, logger: { warn() {} } });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let firstStarted = false;
  const first = limiter.run('@channel_one', async () => { firstStarted = true; await blocked; }, { timeoutMs: 100 });
  while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  let secondStarted = false;
  await limiter.run('@channel_two', async () => { secondStarted = true; }, { timeoutMs: 100 });
  release();
  await first;
  assert.equal(secondStarted, true);
});
