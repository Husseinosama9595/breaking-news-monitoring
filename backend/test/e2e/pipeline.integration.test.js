import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { ProviderRegistry } from '../../src/providers/providerRegistry.js';
import { FeedPollingService } from '../../src/services/feedPollingService.js';
import { MongoRecoveryDispatcher } from '../../src/services/mongoRecoveryDispatcher.js';
import { PostProcessingWorker } from '../../src/queues/postProcessingWorker.js';
import { TelegramNotificationService } from '../../src/services/telegramNotificationService.js';

const databaseName = `breaking_news_e2e_test_${process.pid}_${randomUUID().slice(0, 8)}`;
const queueName = `bnm-e2e-test-${process.pid}-${randomUUID().slice(0, 12)}`;
const quietLogger = { info() {}, warn() {}, error() {} };
let redis;
let queue;
let worker;

before(async () => {
  if (env.nodeEnv === 'production') throw new Error('Refusing to run E2E integration test with production configuration');
  await mongoose.connect(env.mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([MonitoredAccount.init(), Post.init()]);
  if (!env.redisUrl) return;
  redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: true });
  redis.on('error', () => {});
  await redis.connect();
  queue = new Queue(queueName, { connection: redis });
  await queue.waitUntilReady();
});

after(async () => {
  if (worker) await worker.stop().catch(() => {});
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
  if (redis && redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

function scopePost(postId) {
  const target = String(postId);
  return {
    find(filter = {}) { return Post.find({ ...filter, _id: target }); },
    findById() { return Post.findById(target); },
    findOneAndUpdate(filter, update, options) { return Post.findOneAndUpdate({ ...filter, _id: target }, update, options); },
    updateOne(filter, update, options) { return Post.updateOne({ ...filter, _id: target }, update, options); },
  };
}

async function waitForState(postId) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const post = await Post.findById(postId).lean();
    if (post?.processingStatus === 'processed' && post.notificationStatus === 'sent') return post;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Post.findById(postId).lean();
}

test('poll → Mongo inbox → isolated BullMQ worker → mocked Telegram → final Mongo states', {
  skip: !env.redisUrl && 'Set local REDIS_URL to run the BullMQ orchestration integration test',
  timeout: 30_000,
}, async () => {
  const runId = randomUUID();
  const username = `integration-${runId.slice(0, 8)}`;
  const providerPostId = `mock-integration-${runId}`;
  const mock = new MockNewsProvider({ fixtures: [] });
  mock.publish(username, { providerPostId, text: `[MOCK E2E TEST ${runId}] Pipeline integration fixture.` });
  const registry = new ProviderRegistry();
  registry.register(mock, { defaultProvider: true });
  const account = await MonitoredAccount.create({
    platform: 'x', username, normalizedUsername: username.toLowerCase(), category: 'Other',
    enabled: true, providerName: 'mock', monitoringStatus: 'active',
  });
  const poller = new FeedPollingService({ registry, intervalMs: 45_000, timeoutMs: 2000, logger: quietLogger });
  const pollResult = await poller.pollAccount(account.toObject());
  assert.equal(pollResult.status, 'success');
  assert.equal(pollResult.insertedCount, 1);
  const post = await Post.findOne({ providerPostId }).lean();
  assert.ok(post, 'post is durable before queue dispatch');
  assert.equal(post.processingStatus, 'pending');
  assert.equal(post.notificationStatus, 'pending');

  const requests = [];
  const telegram = new TelegramNotificationService({
    token: 'automated-test-token', chatId: '@mock_test_channel',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 777 } }; } };
    },
  });
  const scoped = scopePost(post._id);
  worker = new PostProcessingWorker({
    postModel: scoped, queueName, queueProvider: () => queue,
    connectionProvider: () => redis, notificationService: telegram,
    logger: quietLogger,
  });
  const dispatcher = new MongoRecoveryDispatcher({
    postModel: scoped, queueProvider: () => queue, redisReady: () => redis.status === 'ready',
    notificationsEnabled: () => telegram.isConfigured(), logger: quietLogger,
  });
  await worker.start();
  const dispatch = await dispatcher.dispatchOnce();
  assert.equal(dispatch.enqueued, 1);

  const finalPost = await waitForState(post._id);
  assert.equal(finalPost?.processingStatus, 'processed');
  assert.equal(finalPost?.notificationStatus, 'sent');
  assert.equal(finalPost?.telegramSent, true);
  assert.equal(finalPost?.telegramMessageId, '777');
  assert.equal(requests.length, 1, 'one mocked Telegram request was made');
  assert.equal(requests[0].body.chat_id, '@mock_test_channel');
  assert.match(requests[0].body.text, new RegExp(runId));
  assert.match(requests[0].url, /^https:\/\/api\.telegram\.org\/botautomated-test-token\/sendMessage$/);
});
