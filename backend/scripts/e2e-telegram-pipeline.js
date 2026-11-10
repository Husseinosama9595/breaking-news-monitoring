import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { env } from '../src/config/environment.js';
import MonitoredAccount from '../src/models/MonitoredAccount.js';
import Post from '../src/models/Post.js';
import { MockNewsProvider } from '../src/providers/mockNewsProvider.js';
import { ProviderRegistry } from '../src/providers/providerRegistry.js';
import { FeedPollingService } from '../src/services/feedPollingService.js';
import { MongoRecoveryDispatcher } from '../src/services/mongoRecoveryDispatcher.js';
import { PostProcessingWorker } from '../src/queues/postProcessingWorker.js';
import { notificationJobId } from '../src/queues/jobIds.js';
import { TelegramNotificationService, validateTelegramChatId } from '../src/services/telegramNotificationService.js';

const DATABASE_NAME = 'BreakingNewsE2E';
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 150;
const quietLogger = { info() {}, warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) };

function requireExplicitSendFlag() {
  if (!process.argv.includes('--send-real-telegram')) {
    throw new Error('Refusing to send a real Telegram message. Re-run with --send-real-telegram to explicitly authorize one test delivery.');
  }
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--send-real-telegram');
  if (unknown.length) throw new Error('Unsupported command-line option.');
  if (env.nodeEnv === 'production') throw new Error('Refusing to run the E2E script with NODE_ENV=production.');
  if (!env.telegramBotToken || !env.telegramChatId) throw new Error('Telegram is not configured; no message was sent.');
  validateTelegramChatId(env.telegramChatId);
}

function scopedPostModel(postId) {
  const target = String(postId);
  return {
    find(filter = {}) { return Post.find({ ...filter, _id: target }); },
    findById() { return Post.findById(target); },
    findOneAndUpdate(filter, update, options) {
      return Post.findOneAndUpdate({ ...filter, _id: target }, update, options);
    },
    updateOne(filter, update, options) {
      return Post.updateOne({ ...filter, _id: target }, update, options);
    },
  };
}

async function waitForFinalState(postId) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    latest = await Post.findById(postId).select(
      'processingStatus notificationStatus processingError notificationError notificationAttempts telegramMessageId',
    ).lean();
    if (latest?.processingStatus === 'processed' && latest.notificationStatus === 'sent') return latest;
    if (latest?.processingStatus === 'failed' || latest?.notificationStatus === 'failed') {
      throw new Error(`Pipeline reached a terminal failure (processing=${latest.processingStatus}, notification=${latest.notificationStatus}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for processed/sent state (last state: processing=${latest?.processingStatus ?? 'missing'}, notification=${latest?.notificationStatus ?? 'missing'}).`);
}

async function waitForCompletedJob(job) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let state;
  while (Date.now() < deadline) {
    state = await job.getState();
    if (state === 'completed' || state === 'failed') return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for duplicate BullMQ job to settle (last state=${state ?? 'unknown'}).`);
}

async function run() {
  requireExplicitSendFlag();
  if (!env.redisUrl) throw new Error('REDIS_URL is empty; BullMQ is required for this end-to-end test.');

  const runId = randomUUID();
  const queueName = `bnm-e2e-${process.pid}-${runId.slice(0, 12)}`;
  const username = `mock-e2e-${runId.slice(0, 8)}`;
  const providerPostId = `mock-e2e-${runId}`;
  let redis;
  let queue;
  let worker;
  let connected = false;
  let finalPost;
  let telegramSendCalls = 0;
  let testError;
  const cleanupErrors = [];

  try {
    await mongoose.connect(env.mongoUri, { dbName: DATABASE_NAME, serverSelectionTimeoutMS: 5000 });
    connected = true;
    if (mongoose.connection.name !== DATABASE_NAME) throw new Error('MongoDB did not select the dedicated E2E database.');
    await Promise.all([MonitoredAccount.init(), Post.init()]);

    redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
    redis.on('error', () => {}); // Never print a connection URL or credentials from Redis errors.
    await redis.connect();
    if (redis.status !== 'ready') throw new Error('Redis did not become ready.');

    queue = new Queue(queueName, { connection: redis, defaultJobOptions: {
      attempts: env.postJobMaxAttempts,
      backoff: { type: 'exponential', delay: env.postJobBackoffMs },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: false,
    } });
    await queue.waitUntilReady();

    // This provider has no fixtures; only the one explicitly published post can be polled.
    const provider = new MockNewsProvider({ fixtures: [] });
    const registry = new ProviderRegistry();
    registry.register(provider, { defaultProvider: true });
    provider.publish(username, {
      providerPostId,
      text: `[TEST] [MOCK E2E TEST ${runId}] This is a simulated pipeline verification post, not real news.`,
      category: 'Other',
    });

    const account = await MonitoredAccount.create({
      platform: 'x', username, normalizedUsername: username.toLowerCase(),
      displayName: 'Local E2E Mock Source', category: 'Other', enabled: true,
      providerName: 'mock', monitoringStatus: 'active',
    });
    const poller = new FeedPollingService({
      registry, providerNameMode: 'mock', intervalMs: 45_000, timeoutMs: 10_000, logger: quietLogger,
    });
    const polled = await poller.pollAccount(account.toObject());
    if (polled.status !== 'success' || polled.insertedCount !== 1) {
      throw new Error(`Mock post was not ingested exactly once (status=${polled.status}, inserted=${polled.insertedCount ?? 0}).`);
    }
    const post = await Post.findOne({ providerPostId }).lean();
    if (!post) throw new Error('Ingested test post could not be read back from MongoDB.');
    finalPost = post;

    // Restrict both dispatcher and worker to the one post created in this run.
    const scoped = scopedPostModel(post._id);
    const telegramService = new TelegramNotificationService({
      fetchImpl: (...args) => {
        telegramSendCalls += 1;
        return globalThis.fetch(...args);
      },
    });
    worker = new PostProcessingWorker({
      postModel: scoped, queueName, queueProvider: () => queue,
      connectionProvider: () => redis, notificationService: telegramService,
      notificationMaxAttempts: 1,
      logger: quietLogger,
    });
    const dispatcher = new MongoRecoveryDispatcher({
      postModel: scoped, queueProvider: () => queue, redisReady: () => redis.status === 'ready',
      notificationsEnabled: () => telegramService.isConfigured(), logger: quietLogger,
      intervalMs: 45_000,
    });
    await worker.start();
    const dispatched = await dispatcher.dispatchOnce();
    if (dispatched.enqueued < 1) throw new Error(`The test post was not dispatched (dispatcher status=${dispatched.status}).`);
    finalPost = await waitForFinalState(post._id);

    // Re-submit the same deterministic notification job. BullMQ retains completed
    // jobs for this unique queue, so the same job ID must resolve to the completed
    // job without invoking Telegram a second time.
    const duplicateJobId = notificationJobId(post._id);
    const sendsBeforeDuplicate = telegramSendCalls;
    const duplicateJob = await queue.add('send-notification', { postId: String(post._id) }, {
      jobId: duplicateJobId,
      attempts: env.telegramMaxAttempts,
      backoff: { type: 'exponential', delay: env.telegramBackoffMs },
    });
    const duplicateState = await waitForCompletedJob(duplicateJob);
    if (String(duplicateJob.id) !== duplicateJobId || duplicateState !== 'completed') {
      throw new Error(`Duplicate notification job was not deduplicated (state=${duplicateState}).`);
    }
    if (telegramSendCalls !== sendsBeforeDuplicate) {
      throw new Error('Duplicate notification submission triggered another Telegram API send.');
    }

    finalPost = await Post.findById(post._id)
      .select('processingStatus notificationStatus notificationAttempts telegramMessageId telegramSent')
      .lean();
    if (finalPost?.processingStatus !== 'processed' || finalPost?.notificationStatus !== 'sent'
      || !finalPost.telegramSent || !finalPost.telegramMessageId) {
      throw new Error('Final MongoDB notification state or Telegram message ID is incomplete.');
    }
    if (telegramSendCalls !== 1) {
      throw new Error(`Expected exactly one Telegram send call; observed ${telegramSendCalls}.`);
    }
    console.log(`E2E Telegram pipeline succeeded. Test post MongoDB ID: ${post._id}`);
    console.log(`Dedicated database: ${DATABASE_NAME}. Final states: processing=${finalPost.processingStatus}, notification=${finalPost.notificationStatus}.`);
    console.log(`Telegram message ID: ${finalPost.telegramMessageId}; notification attempts: ${finalPost.notificationAttempts}; Telegram send calls: ${telegramSendCalls}.`);
    console.log(`Duplicate job ${duplicateJobId} resolved as ${duplicateState}; no additional Telegram send occurred.`);
  } catch (error) {
    testError = error;
  } finally {
    if (worker) await worker.stop().catch(() => cleanupErrors.push('worker shutdown failed'));
    if (queue) {
      // Queue name is unique to this invocation; no other BullMQ queue is touched.
      await queue.obliterate({ force: true }).catch(() => cleanupErrors.push('dedicated BullMQ queue cleanup failed'));
      await queue.close().catch(() => cleanupErrors.push('dedicated BullMQ queue close failed'));
    }
    if (redis && redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
    if (connected) await mongoose.disconnect().catch(() => cleanupErrors.push('MongoDB disconnect failed'));
  }

  if (!testError && cleanupErrors.length) testError = new Error(cleanupErrors.join('; '));
  if (testError) {
    console.error(`E2E Telegram pipeline failed${finalPost?._id ? ` for test post ${finalPost._id}` : ''}: ${testError.message}`);
    process.exitCode = 1;
  }
}

await run().catch((error) => {
  // Keep the refusal/failure output concise and never dump configuration objects.
  console.error(`E2E Telegram pipeline refused or failed: ${error.message}`);
  process.exitCode = 1;
});
