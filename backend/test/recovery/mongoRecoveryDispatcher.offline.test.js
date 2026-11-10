import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILED_JOB_CLEANUP_LIMIT,
  FAILED_JOB_RETENTION_AGE_MS,
} from '../../src/queues/notificationQueue.js';
import { notificationJobId, postJobId } from '../../src/queues/jobIds.js';
import { MongoRecoveryDispatcher } from '../../src/services/mongoRecoveryDispatcher.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const quietLogger = { info() {}, warn() {}, error() {} };

function compare(value, expected) {
  const left = value instanceof Date ? value.getTime() : value;
  const right = expected instanceof Date ? expected.getTime() : expected;
  return left === right || String(left) === String(right);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((child) => matches(document, child));
    if (key === '$nor') return expected.every((child) => !matches(document, child));
    const value = document[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$exists') return Object.hasOwn(document, key) === operand;
        if (operator === '$nin') return operand.every((entry) => !compare(value, entry));
        if (operator === '$lt') return value != null && new Date(value).getTime() < new Date(operand).getTime();
        if (operator === '$lte') return value != null && new Date(value).getTime() <= new Date(operand).getTime();
        if (operator === '$ne') return !compare(value, operand);
        return false;
      });
    }
    if (expected === null) return value == null;
    return compare(value, expected);
  });
}

function makeHarness(records, { redisInitiallyReady = true } = {}) {
  const storedPosts = records.map((record) => structuredClone(record));
  const jobs = new Map();
  const cleanCalls = [];
  let ready = redisInitiallyReady;
  const postModel = {
    find(filter) {
      let limit = Infinity;
      const query = {
        sort() { return this; },
        limit(value) { limit = value; return this; },
        async lean() {
          return storedPosts.filter((post) => matches(post, filter)).slice(0, limit).map((post) => structuredClone(post));
        },
      };
      return query;
    },
    async updateOne(filter, update) {
      const record = storedPosts.find((post) => matches(post, filter));
      if (!record) return { modifiedCount: 0 };
      Object.assign(record, structuredClone(update.$set ?? {}));
      return { modifiedCount: 1 };
    },
  };
  const queue = {
    async clean(grace, limit, state) {
      cleanCalls.push({ grace, limit, state });
      return [];
    },
    async getJob(id) {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        id,
        async getState() { return job.state; },
        async remove() { jobs.delete(id); },
      };
    },
    async add(name, data, options) {
      jobs.set(options.jobId, { name, data, options, state: 'waiting' });
      return jobs.get(options.jobId);
    },
  };
  const dispatcher = new MongoRecoveryDispatcher({
    postModel,
    accountModel: { find() { throw new Error('account query not expected in Mock mode'); } },
    providerNameMode: 'mock',
    queueProvider: () => queue,
    redisReady: () => ready,
    notificationsEnabled: () => true,
    intervalMs: 5000,
    staleAfterMs: 120_000,
    batchSize: 100,
    logger: quietLogger,
    clock: () => new Date(now),
  });
  return {
    dispatcher, storedPosts, jobs, cleanCalls,
    setRedisReady(value) { ready = value; },
  };
}

test('pending MongoDB work is redispatched after simulated Redis recovery with stable IDs', async () => {
  const harness = makeHarness([{
    _id: 'pending-1', processingStatus: 'pending', notificationStatus: 'pending',
    processingNextAttemptAt: null, createdAt: new Date(now.getTime() - 1000),
  }], { redisInitiallyReady: false });

  const unavailable = await harness.dispatcher.dispatchOnce();
  assert.equal(unavailable.status, 'redis-unavailable');
  assert.equal(harness.jobs.size, 0);

  harness.setRedisReady(true);
  const recovered = await harness.dispatcher.dispatchOnce();
  assert.equal(recovered.enqueued, 1);
  assert.equal(harness.jobs.has(postJobId('pending-1')), true);

  const repeated = await harness.dispatcher.dispatchOnce();
  assert.equal(repeated.enqueued, 0);
  assert.equal(repeated.alreadyQueued, 1);
  assert.equal(harness.jobs.size, 1);
});

test('stale processing records are reset and re-enqueued for processing', async () => {
  const harness = makeHarness([{
    _id: 'stale-processing', processingStatus: 'processing', notificationStatus: 'pending',
    processingStartedAt: new Date(now.getTime() - 180_000), processingNextAttemptAt: null,
    createdAt: new Date(now.getTime() - 300_000),
  }]);

  const result = await harness.dispatcher.dispatchOnce();

  assert.equal(result.enqueued, 1);
  assert.equal(harness.storedPosts[0].processingStatus, 'pending');
  assert.equal(harness.storedPosts[0].processingErrorCode, 'STALE_PROCESSING_RECOVERED');
  assert.equal(harness.jobs.has(postJobId('stale-processing')), true);
});

test('stale sending notifications are reset and re-enqueued with a deterministic ID', async () => {
  const harness = makeHarness([{
    _id: 'stale-sending', processingStatus: 'processed', notificationStatus: 'sending',
    notificationStartedAt: new Date(now.getTime() - 180_000), notificationNextAttemptAt: null,
    createdAt: new Date(now.getTime() - 300_000),
  }]);

  const result = await harness.dispatcher.dispatchOnce();

  assert.equal(result.enqueued, 1);
  assert.equal(harness.storedPosts[0].notificationStatus, 'pending');
  assert.equal(harness.storedPosts[0].notificationErrorCode, 'STALE_NOTIFICATION_RECOVERED');
  assert.equal(harness.jobs.has(notificationJobId('stale-sending')), true);
  assert.equal(harness.jobs.get(notificationJobId('stale-sending')).name, 'send-notification');
});

test('already-sent notifications are never redispatched', async () => {
  const harness = makeHarness([{
    _id: 'already-sent', processingStatus: 'processed', notificationStatus: 'sent',
    telegramSent: true, telegramSentAt: now, notificationStartedAt: null,
    createdAt: new Date(now.getTime() - 300_000),
  }]);

  const result = await harness.dispatcher.dispatchOnce();

  assert.equal(result.enqueued, 0);
  assert.equal(result.scanned, 0);
  assert.equal(harness.jobs.size, 0);
});

test('dispatcher cleans only expired failed BullMQ jobs using the bounded retention window', async () => {
  const harness = makeHarness([]);

  await harness.dispatcher.dispatchOnce();

  assert.deepEqual(harness.cleanCalls, [{
    grace: FAILED_JOB_RETENTION_AGE_MS,
    limit: FAILED_JOB_CLEANUP_LIMIT,
    state: 'failed',
  }]);
});
