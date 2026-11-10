import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { ingestProviderBatch } from '../../src/services/postIngestionService.js';
import { MongoRecoveryDispatcher, postJobId } from '../../src/services/mongoRecoveryDispatcher.js';
import { PostProcessingWorker } from '../../src/queues/postProcessingWorker.js';
import { PostProcessingError } from '../../src/queues/processingErrors.js';
import { ProcessingRuntime } from '../../src/services/processingRuntime.js';

const testDatabaseName = `breaking_news_monitor_step4_${process.pid}`;
const quietLogger = { info() {}, warn() {}, error() {} };

before(async () => {
  if (env.nodeEnv === 'production') throw new Error('Refusing to run processing tests against production configuration');
  try {
    await mongoose.connect(env.mongoUri, { dbName: testDatabaseName, serverSelectionTimeoutMS: 5000 });
    await Promise.all([MonitoredAccount.init(), Post.init()]);
  } catch {
    await mongoose.disconnect().catch(() => {});
    throw new Error('Could not connect to the configured local MongoDB for isolated processing tests');
  }
});

beforeEach(async () => {
  await Promise.all([Post.deleteMany({}), MonitoredAccount.deleteMany({})]);
});

after(async () => {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function makePendingPost(username = 'ProcessingTest') {
  const mock = new MockNewsProvider();
  mock.publish(username, { text: `[MOCK] durable post for ${username}` });
  const batch = await mock.fetchRecentPosts({ username });
  const ingested = await ingestProviderBatch({
    account: { username, platform: 'x', category: 'Other' },
    batch,
  });
  return Post.findOne({ providerPostId: batch.posts[0].providerPostId }).lean();
}

function makeWorker(options = {}) {
  return new PostProcessingWorker({
    logger: quietLogger,
    notificationService: { isConfigured: () => false },
    maxAttempts: 3,
    backoffMs: 100,
    ...options,
  });
}

function makeFakeQueue() {
  const jobs = new Map();
  const view = (job) => job && ({
    id: job.id,
    data: job.data,
    opts: job.opts,
    getState: async () => job.state,
    remove: async () => { jobs.delete(job.id); },
  });
  return {
    jobs,
    async getJob(id) { return view(jobs.get(id)); },
    async add(name, data, opts) {
      if (jobs.has(opts.jobId)) return view(jobs.get(opts.jobId));
      const job = { id: opts.jobId, name, data, opts, state: 'waiting' };
      jobs.set(job.id, job);
      return view(job);
    },
  };
}

test('successfully processes a queued post once without implying Telegram delivery', async () => {
  const savedPost = await makePendingPost();
  let processorCalls = 0;
  const worker = makeWorker({ processor: async () => { processorCalls += 1; } });
  const job = { name: 'process-post', data: { postId: String(savedPost._id) }, opts: { attempts: 3 }, attemptsMade: 0 };

  const result = await worker.processJob(job);
  const duplicate = await worker.processJob(job);
  const saved = await Post.findById(savedPost._id).lean();
  assert.equal(result.status, 'processed');
  assert.equal(duplicate.status, 'skipped');
  assert.equal(processorCalls, 1);
  assert.equal(saved.processingStatus, 'processed');
  assert.equal(saved.processingAttempts, 1);
  assert.ok(saved.processedAt instanceof Date);
  assert.equal(saved.notificationStatus, 'pending');
  assert.equal(saved.telegramSent, false);
  assert.equal(saved.telegramSentAt, null);
});

test('retryable failures return to pending with backoff metadata and can later succeed', async () => {
  const savedPost = await makePendingPost();
  let calls = 0;
  const worker = makeWorker({ processor: async () => {
    calls += 1;
    if (calls === 1) throw new PostProcessingError('Temporary local processing failure', { code: 'TEMPORARY', retryable: true });
  } });
  const job = { name: 'process-post', data: { postId: String(savedPost._id) }, opts: { attempts: 3 }, attemptsMade: 0 };
  await assert.rejects(worker.processJob(job), /Temporary local processing failure/);
  const retryState = await Post.findById(savedPost._id).lean();
  assert.equal(retryState.processingStatus, 'pending');
  assert.equal(retryState.processingAttempts, 1);
  assert.equal(retryState.processingErrorCode, 'TEMPORARY');
  assert.ok(retryState.processingNextAttemptAt instanceof Date);

  const retried = await worker.processJob({ ...job, attemptsMade: 1 });
  const processed = await Post.findById(savedPost._id).lean();
  assert.equal(retried.status, 'processed');
  assert.equal(processed.processingAttempts, 2);
  assert.equal(processed.processingStatus, 'processed');
});

test('permanent failures become terminal and do not consume BullMQ retry attempts', async () => {
  const savedPost = await makePendingPost();
  const worker = makeWorker({ processor: async () => {
    throw new PostProcessingError('Invalid persisted content', { code: 'INVALID_CONTENT', retryable: false });
  } });
  let discarded = false;
  const job = {
    name: 'process-post', data: { postId: String(savedPost._id) }, opts: { attempts: 5 }, attemptsMade: 0,
    discard() { discarded = true; },
  };
  await assert.rejects(worker.processJob(job), (error) => error.code === 'INVALID_CONTENT');
  const saved = await Post.findById(savedPost._id).lean();
  assert.equal(discarded, true);
  assert.equal(saved.processingStatus, 'failed');
  assert.equal(saved.processingAttempts, 1);
  assert.equal(saved.processingErrorCode, 'INVALID_CONTENT');
  assert.ok(saved.processingFailedAt instanceof Date);
  assert.equal(saved.notificationStatus, 'pending');
});

test('retryable failures stop at the configured maximum attempt count', async () => {
  const savedPost = await makePendingPost();
  const worker = makeWorker({ processor: async () => {
    throw new PostProcessingError('Always retryable', { code: 'TEMPORARY', retryable: true });
  } });
  const job = { name: 'process-post', data: { postId: String(savedPost._id) }, opts: { attempts: 2 }, attemptsMade: 0 };
  await assert.rejects(worker.processJob(job), /Always retryable/);
  let discarded = false;
  const lastJob = { ...job, attemptsMade: 1, discard() { discarded = true; } };
  await assert.rejects(worker.processJob(lastJob), (error) => error.code === 'MAX_ATTEMPTS_EXHAUSTED');
  const saved = await Post.findById(savedPost._id).lean();
  assert.equal(discarded, true);
  assert.equal(saved.processingAttempts, 2);
  assert.equal(saved.processingStatus, 'failed');
  assert.equal(saved.processingNextAttemptAt, null);
});

test('dispatcher avoids duplicate jobs using a deterministic BullMQ job ID', async () => {
  const savedPost = await makePendingPost();
  const queue = makeFakeQueue();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => queue,
    redisReady: () => true,
    notificationsEnabled: () => false,
    logger: quietLogger,
  });
  const first = await dispatcher.dispatchOnce();
  const second = await dispatcher.dispatchOnce();
  assert.equal(first.enqueued, 1);
  assert.equal(second.alreadyQueued, 1);
  assert.equal(queue.jobs.size, 1);
  assert.ok(queue.jobs.has(postJobId(savedPost._id)));
});

test('pending MongoDB work survives Redis outage and is enqueued after Redis recovery or restart', async () => {
  const savedPost = await makePendingPost();
  const queue = makeFakeQueue();
  let ready = false;
  let queueProviderCalls = 0;
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => { queueProviderCalls += 1; return queue; },
    redisReady: () => ready,
    notificationsEnabled: () => false,
    logger: quietLogger,
  });
  const unavailable = await dispatcher.dispatchOnce();
  assert.equal(unavailable.status, 'redis-unavailable');
  assert.equal(queueProviderCalls, 0);
  assert.equal((await Post.findById(savedPost._id).lean()).processingStatus, 'pending');

  ready = true;
  const recovered = await dispatcher.dispatchOnce();
  assert.equal(recovered.enqueued, 1);

  // Simulate Redis losing its volatile queue while the MongoDB inbox remains intact,
  // followed by a fresh backend/dispatcher instance rebuilding the job.
  queue.jobs.clear();
  const afterRestart = new MongoRecoveryDispatcher({ queueProvider: () => queue, redisReady: () => true, notificationsEnabled: () => false, logger: quietLogger });
  const requeued = await afterRestart.dispatchOnce();
  assert.equal(requeued.enqueued, 1);
  assert.equal(queue.jobs.size, 1);
  const stillPending = await Post.findById(savedPost._id).lean();
  assert.equal(stillPending.processingStatus, 'pending');
  assert.equal(stillPending.notificationStatus, 'pending');
  assert.equal(stillPending.telegramSent, false);
});

test('dispatcher resets stale processing records and re-enqueues them', async () => {
  const savedPost = await makePendingPost();
  const staleAt = new Date(Date.now() - 60_000);
  await Post.updateOne({ _id: savedPost._id }, { $set: {
    processingStatus: 'processing', processingStartedAt: staleAt, processingAttempts: 1,
  } });
  const queue = makeFakeQueue();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => queue,
    redisReady: () => true,
    notificationsEnabled: () => false,
    staleAfterMs: 1000,
    logger: quietLogger,
  });
  const result = await dispatcher.dispatchOnce();
  const recovered = await Post.findById(savedPost._id).lean();
  assert.equal(result.enqueued, 1);
  assert.equal(recovered.processingStatus, 'pending');
  assert.equal(recovered.processingStartedAt, null);
  assert.equal(recovered.processingErrorCode, 'STALE_PROCESSING_RECOVERED');
});

test('retry-delayed posts wait until processingNextAttemptAt before Redis recovery dispatch', async () => {
  const savedPost = await makePendingPost();
  const dueAt = new Date(Date.now() + 60_000);
  await Post.updateOne({ _id: savedPost._id }, { $set: {
    processingNextAttemptAt: dueAt,
    processingError: 'Waiting for retry backoff',
  } });
  const queue = makeFakeQueue();
  let now = new Date();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => queue,
    redisReady: () => true,
    notificationsEnabled: () => false,
    clock: () => now,
    logger: quietLogger,
  });
  const early = await dispatcher.dispatchOnce();
  assert.equal(early.scanned, 0);
  now = new Date(dueAt.getTime() + 1);
  const due = await dispatcher.dispatchOnce();
  assert.equal(due.enqueued, 1);
});

test('runtime waits for Redis before starting and shuts down dispatcher before worker', async () => {
  let ready = false;
  const calls = [];
  const worker = { async start() { calls.push('worker-start'); }, async stop() { calls.push('worker-stop'); } };
  const dispatcher = { start() { calls.push('dispatcher-start'); }, async stop() { calls.push('dispatcher-stop'); } };
  const runtime = new ProcessingRuntime({
    worker, dispatcher, redisReady: () => ready, checkIntervalMs: 5000, logger: quietLogger,
  });
  runtime.start();
  assert.equal(await runtime.checkNow(), false);
  assert.deepEqual(calls, []);
  ready = true;
  assert.equal(await runtime.checkNow(), true);
  assert.deepEqual(calls, ['worker-start', 'dispatcher-start']);
  await runtime.stop();
  assert.deepEqual(calls, ['worker-start', 'dispatcher-start', 'dispatcher-stop', 'worker-stop']);
});

test('real BullMQ worker consumes a dispatched job when local Redis is available', async (t) => {
  if (!env.redisUrl) return t.skip('REDIS_URL is not configured; fake-queue and recovery tests still cover outages');
  const redis = new IORedis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
  } catch {
    redis.disconnect();
    return t.skip('Local Redis is unavailable; fake-queue and recovery tests still cover outages');
  }

  const queueName = `post-processing-step4-${process.pid}`;
  const queue = new Queue(queueName, { connection: redis });
  const eventsConnection = redis.duplicate({ lazyConnect: true, retryStrategy: () => null });
  const events = new QueueEvents(queueName, { connection: eventsConnection });
  const worker = new PostProcessingWorker({
    queueName, connectionProvider: () => redis, notificationService: { isConfigured: () => false }, logger: quietLogger,
  });
  const savedPost = await makePendingPost('BullMQSource');
  try {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    await worker.start();
    const dispatcher = new MongoRecoveryDispatcher({
      queueProvider: () => queue,
      redisReady: () => redis.status === 'ready',
      notificationsEnabled: () => false,
      maxAttempts: 3,
      logger: quietLogger,
    });
    await dispatcher.dispatchOnce();
    const job = await queue.getJob(postJobId(savedPost._id));
    assert.ok(job);
    await job.waitUntilFinished(events, 5000);
    const processed = await Post.findById(savedPost._id).lean();
    assert.equal(processed.processingStatus, 'processed');
    assert.equal(processed.notificationStatus, 'pending');
    assert.equal(processed.telegramSent, false);
  } finally {
    await worker.stop().catch(() => {});
    await events.close().catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
    if (eventsConnection.status !== 'end') eventsConnection.disconnect();
    if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
  }
});
