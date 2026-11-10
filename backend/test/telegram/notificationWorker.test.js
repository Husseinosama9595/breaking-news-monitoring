import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { ingestProviderBatch } from '../../src/services/postIngestionService.js';
import { MongoRecoveryDispatcher } from '../../src/services/mongoRecoveryDispatcher.js';
import { notificationJobId } from '../../src/queues/jobIds.js';
import { PostProcessingWorker } from '../../src/queues/postProcessingWorker.js';
import { TelegramNotificationError } from '../../src/services/telegramNotificationService.js';

const testDatabaseName = `breaking_news_monitor_telegram_${process.pid}`;
const quietLogger = { info() {}, warn() {}, error() {} };

before(async () => {
  if (env.nodeEnv === 'production') throw new Error('Refusing to run notification tests against production configuration');
  try {
    await mongoose.connect(env.mongoUri, { dbName: testDatabaseName, serverSelectionTimeoutMS: 5000 });
    await Promise.all([MonitoredAccount.init(), Post.init()]);
  } catch {
    await mongoose.disconnect().catch(() => {});
    throw new Error('Could not connect to the configured local MongoDB for isolated notification tests');
  }
});

beforeEach(async () => {
  await Promise.all([Post.deleteMany({}), MonitoredAccount.deleteMany({})]);
});

after(async () => {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function makeProcessedPost(username = 'TelegramTest') {
  const mock = new MockNewsProvider();
  mock.publish(username, { text: `[MOCK] message from ${username}` });
  const batch = await mock.fetchRecentPosts({ username });
  await ingestProviderBatch({ account: { username, category: 'World News' }, batch });
  const saved = await Post.findOne({ providerPostId: batch.posts[0].providerPostId });
  saved.processingStatus = 'processed';
  saved.processedAt = new Date();
  await saved.save();
  return saved.toObject();
}

async function makeNitterPendingNotification(username, {
  accountProviderName = 'nitter',
  postProviderName = 'nitter',
  baselineAt = null,
  publishedAt = new Date('2026-07-01T11:00:00.000Z'),
} = {}) {
  const account = await MonitoredAccount.create({
    platform: 'x', username, normalizedUsername: username.toLowerCase(), category: 'Other',
    enabled: true, providerName: accountProviderName, monitoringStatus: 'active', notificationBaselineAt: baselineAt,
  });
  return Post.create({
    dedupeKey: `x:${username}-historical`, providerName: postProviderName, providerPostId: `${username}-historical`,
    canonicalPostId: `${username}-historical`, monitoredAccount: account._id, username,
    author: { username }, text: 'Historical post queued before baseline',
    postUrl: `https://x.com/${username}/status/${username}-historical`, providerUrl: 'https://xitter.cf',
    publishedAt, receivedAt: new Date(), retrievedAt: new Date(), processingStatus: 'processed',
    notificationStatus: 'pending', telegramSent: false, processedAt: new Date(),
  }).then((post) => post.toObject());
}

function makeWorker(notificationService, options = {}) {
  return new PostProcessingWorker({ notificationService, logger: quietLogger, notificationMaxAttempts: 3, notificationBackoffMs: 100, ...options });
}

function makeNotificationJob(postId, attempts = 3) {
  return { name: 'send-notification', data: { postId: String(postId) }, opts: { attempts }, attemptsMade: 0 };
}

function makeQueue() {
  const jobs = new Map();
  const view = (job) => job && ({
    id: job.id,
    name: job.name,
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

test('records sent only after the mocked Telegram client accepts the message', async () => {
  const post = await makeProcessedPost();
  const calls = [];
  const notifier = {
    isConfigured: () => true,
    async sendNotification(value) {
      calls.push(value._id.toString());
      return { messageId: '9001', sentAt: new Date('2026-07-01T12:00:00.000Z') };
    },
  };
  const worker = makeWorker(notifier);
  const result = await worker.processNotificationJob(makeNotificationJob(post._id));
  const saved = await Post.findById(post._id).lean();
  assert.equal(result.status, 'sent');
  assert.deepEqual(calls, [String(post._id)]);
  assert.equal(saved.notificationStatus, 'sent');
  assert.equal(saved.telegramSent, true);
  assert.equal(saved.telegramMessageId, '9001');
  assert.equal(saved.telegramSentAt.toISOString(), '2026-07-01T12:00:00.000Z');
  assert.equal(saved.notificationAttempts, 1);
});

test('duplicate notification job execution does not send twice after MongoDB records success', async () => {
  const post = await makeProcessedPost();
  let calls = 0;
  const worker = makeWorker({ isConfigured: () => true, async sendNotification() { calls += 1; return { messageId: '1' }; } });
  const job = makeNotificationJob(post._id);
  assert.equal((await worker.processNotificationJob(job)).status, 'sent');
  assert.equal((await worker.processNotificationJob(job)).status, 'skipped');
  assert.equal(calls, 1);
});

test('queued and retried Nitter jobs cannot send before baseline or after Mongo marks history skipped', async () => {
  const post = await makeNitterPendingNotification('BaselineQueueGuard');
  let sends = 0;
  const worker = makeWorker({ isConfigured: () => true, async sendNotification() { sends += 1; return { messageId: 'should-not-send' }; } });
  const job = makeNotificationJob(post._id);

  const blocked = await worker.processNotificationJob(job);
  assert.equal(blocked.reason, 'nitter-baseline-pending');
  assert.equal((await Post.findById(post._id).lean()).notificationStatus, 'pending');

  await Post.updateOne({ _id: post._id }, { $set: {
    processingStatus: 'processed', notificationStatus: 'skipped',
    notificationErrorCode: 'INITIAL_HISTORY_SUPPRESSED',
  } });
  await MonitoredAccount.updateOne({ _id: post.monitoredAccount }, { $set: { notificationBaselineAt: new Date() } });
  const staleProcessingJob = await worker.processPostJob({ name: 'process-post', data: { postId: String(post._id) } });
  assert.equal(staleProcessingJob.status, 'skipped', 'a stale processing job cannot reclaim work already marked skipped');
  const retriedQueuedJob = await worker.processNotificationJob(job);
  assert.equal(retriedQueuedJob.status, 'lease-lost');
  assert.equal(sends, 0);
  assert.equal((await Post.findById(post._id).lean()).notificationStatus, 'skipped');
});

test('atomic notification claim prevents concurrent workers from sending the same post', async () => {
  const post = await makeProcessedPost();
  let calls = 0;
  const worker = makeWorker({
    isConfigured: () => true,
    async sendNotification() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { messageId: '2' };
    },
  });
  const results = await Promise.all([
    worker.processNotificationJob(makeNotificationJob(post._id)),
    worker.processNotificationJob(makeNotificationJob(post._id)),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.status).sort(), ['sent', 'skipped']);
});

test('retryable Telegram errors leave notification pending with backoff; permanent errors fail terminally', async () => {
  const retryPost = await makeProcessedPost('RetrySource');
  let retryCalls = 0;
  const retryWorker = makeWorker({
    isConfigured: () => true,
    async sendNotification() {
      retryCalls += 1;
      if (retryCalls === 1) throw new TelegramNotificationError('Temporary Telegram failure', {
        code: 'TELEGRAM_TIMEOUT', retryable: true, retryAfterMs: 50,
      });
      return { messageId: '3' };
    },
  });
  const job = makeNotificationJob(retryPost._id, 3);
  await assert.rejects(retryWorker.processNotificationJob(job), { code: 'TELEGRAM_TIMEOUT' });
  const waiting = await Post.findById(retryPost._id).lean();
  assert.equal(waiting.notificationStatus, 'pending');
  assert.equal(waiting.notificationAttempts, 1);
  assert.ok(waiting.notificationNextAttemptAt instanceof Date);
  assert.equal(waiting.telegramSent, false);
  const retried = await makeWorker(retryWorker.notificationService, {
    clock: () => new Date(waiting.notificationNextAttemptAt.getTime() + 1),
  }).processNotificationJob({ ...job, attemptsMade: 1 });
  assert.equal(retried.status, 'sent');

  const permanentPost = await makeProcessedPost('ForbiddenSource');
  const permanentWorker = makeWorker({ isConfigured: () => true, async sendNotification() {
    throw new TelegramNotificationError('Telegram rejected sendMessage (403)', { code: 'TELEGRAM_API_403', retryable: false });
  } });
  let discarded = false;
  await assert.rejects(permanentWorker.processNotificationJob({
    ...makeNotificationJob(permanentPost._id), discard() { discarded = true; },
  }), { code: 'TELEGRAM_API_403' });
  const failed = await Post.findById(permanentPost._id).lean();
  assert.equal(discarded, true);
  assert.equal(failed.notificationStatus, 'failed');
  assert.equal(failed.notificationErrorCode, 'TELEGRAM_API_403');
  assert.ok(failed.notificationFailedAt instanceof Date);
  assert.equal(failed.telegramSent, false);
});

test('exhausted retryable notification attempts become failed in MongoDB', async () => {
  const post = await makeProcessedPost();
  let now = new Date();
  const worker = makeWorker({ isConfigured: () => true, async sendNotification() {
    throw new TelegramNotificationError('Rate limited', { code: 'TELEGRAM_RATE_LIMITED', retryable: true });
  } }, { clock: () => new Date(now) });
  const job = makeNotificationJob(post._id, 2);
  await assert.rejects(worker.processNotificationJob(job), { code: 'TELEGRAM_RATE_LIMITED' });
  const retryState = await Post.findById(post._id).lean();
  now = new Date(retryState.notificationNextAttemptAt.getTime() + 1);
  let discarded = false;
  await assert.rejects(worker.processNotificationJob({ ...job, attemptsMade: 1, discard() { discarded = true; } }), {
    code: 'MAX_ATTEMPTS_EXHAUSTED',
  });
  const saved = await Post.findById(post._id).lean();
  assert.equal(discarded, true);
  assert.equal(saved.notificationAttempts, 2);
  assert.equal(saved.notificationStatus, 'failed');
  assert.equal(saved.notificationErrorCode, 'MAX_ATTEMPTS_EXHAUSTED');
});

test('notification jobs remain pending when the Telegram service is disabled', async () => {
  const post = await makeProcessedPost();
  const worker = makeWorker({ isConfigured: () => false, async sendNotification() { throw new Error('must not send'); } });
  const result = await worker.processNotificationJob(makeNotificationJob(post._id));
  const saved = await Post.findById(post._id).lean();
  assert.equal(result.status, 'notification-disabled');
  assert.equal(saved.notificationStatus, 'pending');
  assert.equal(saved.notificationAttempts, 0);
  assert.equal(saved.notificationStartedAt, null);
  assert.equal(saved.telegramSent, false);
});

test('dispatcher recovers pending and stale-sending notifications with deterministic IDs', async () => {
  const pending = await makeProcessedPost('PendingNotify');
  const stale = await makeProcessedPost('StaleNotify');
  await Post.updateOne({ _id: stale._id }, { $set: {
    notificationStatus: 'sending',
    notificationStartedAt: new Date(Date.now() - 60_000),
    notificationAttempts: 1,
  } });
  const jobs = makeQueue();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => jobs,
    redisReady: () => true,
    notificationsEnabled: () => true,
    staleAfterMs: 1000,
    logger: quietLogger,
  });
  const result = await dispatcher.dispatchOnce();
  assert.equal(result.enqueued, 2);
  assert.equal(jobs.jobs.get(notificationJobId(pending._id)).name, 'send-notification');
  assert.equal(jobs.jobs.get(notificationJobId(stale._id)).name, 'send-notification');
  const recovered = await Post.findById(stale._id).lean();
  assert.equal(recovered.notificationStatus, 'pending');
  assert.equal(recovered.notificationErrorCode, 'STALE_NOTIFICATION_RECOVERED');
});

test('recovery dispatcher holds Nitter work until the account baseline is established', async () => {
  const post = await makeNitterPendingNotification('BaselineDispatchGuard');
  const queue = makeQueue();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => queue,
    redisReady: () => true,
    notificationsEnabled: () => true,
    logger: quietLogger,
  });
  const result = await dispatcher.dispatchOnce();
  assert.equal(result.enqueued, 0);
  assert.equal(queue.jobs.size, 0);
  assert.equal((await Post.findById(post._id).lean()).notificationStatus, 'pending');
});

test('effective Nitter account blocks a queued Mock post until baseline and suppresses posts at or before it', async () => {
  const post = await makeNitterPendingNotification('MockStoredButNitterEffective', {
    accountProviderName: 'nitter', postProviderName: 'mock',
  });
  let sends = 0;
  const worker = makeWorker({ isConfigured: () => true, async sendNotification() { sends += 1; return {}; } }, { providerNameMode: 'account' });
  const job = makeNotificationJob(post._id);
  assert.equal((await worker.processNotificationJob(job)).reason, 'nitter-baseline-pending');

  const baselineAt = new Date('2026-07-01T12:00:00.000Z');
  await MonitoredAccount.updateOne({ _id: post.monitoredAccount }, { $set: { notificationBaselineAt: baselineAt } });
  const atBaseline = await worker.processNotificationJob(job);
  assert.equal(atBaseline.reason, 'post-at-or-before-nitter-baseline');
  assert.equal(sends, 0);
  assert.equal((await Post.findById(post._id).lean()).notificationStatus, 'skipped');
});

test('effective Nitter account sends a genuinely new post after its baseline', async () => {
  const baselineAt = new Date('2026-07-01T12:00:00.000Z');
  const post = await makeNitterPendingNotification('NewAfterNitterBaseline', {
    accountProviderName: 'nitter', postProviderName: 'mock', baselineAt,
    publishedAt: new Date('2026-07-01T12:00:01.000Z'),
  });
  let sends = 0;
  const worker = makeWorker({ isConfigured: () => true, async sendNotification() { sends += 1; return { messageId: 'new' }; } }, { providerNameMode: 'account' });
  assert.equal((await worker.processNotificationJob(makeNotificationJob(post._id))).status, 'sent');
  assert.equal(sends, 1);
});

test('global Nitter mode guards stored Mock accounts while account-mode Mock accounts send normally', async () => {
  const globalNitterPost = await makeNitterPendingNotification('GlobalNitterOverride', {
    accountProviderName: 'mock', postProviderName: 'mock', baselineAt: null,
  });
  let sends = 0;
  const notifier = { isConfigured: () => true, async sendNotification() { sends += 1; return {}; } };
  const globalNitterWorker = makeWorker(notifier, { providerNameMode: 'nitter' });
  assert.equal((await globalNitterWorker.processNotificationJob(makeNotificationJob(globalNitterPost._id))).reason, 'nitter-baseline-pending');

  const mockPost = await makeProcessedPost('AccountModeMockStillSends');
  const accountModeWorker = makeWorker(notifier, { providerNameMode: 'account' });
  assert.equal((await accountModeWorker.processNotificationJob(makeNotificationJob(mockPost._id))).status, 'sent');
  assert.equal(sends, 1);
});

test('recovery dispatcher applies global and per-account effective Nitter baseline filters', async () => {
  const storedMock = await makeNitterPendingNotification('GlobalNitterRecoveryGuard', {
    accountProviderName: 'mock', postProviderName: 'mock', baselineAt: null,
  });
  const globalQueue = makeQueue();
  const globalDispatcher = new MongoRecoveryDispatcher({
    providerNameMode: 'nitter', queueProvider: () => globalQueue, redisReady: () => true,
    notificationsEnabled: () => true, logger: quietLogger,
  });
  assert.equal((await globalDispatcher.dispatchOnce()).enqueued, 0);
  assert.equal(globalQueue.jobs.size, 0);

  await MonitoredAccount.updateOne({ _id: storedMock.monitoredAccount }, { $set: {
    providerName: 'nitter', notificationBaselineAt: new Date('2026-07-01T12:00:00.000Z'),
  } });
  const accountQueue = makeQueue();
  const accountDispatcher = new MongoRecoveryDispatcher({
    providerNameMode: 'account', queueProvider: () => accountQueue, redisReady: () => true,
    notificationsEnabled: () => true, logger: quietLogger,
  });
  assert.equal((await accountDispatcher.dispatchOnce()).enqueued, 0);
  assert.equal(accountQueue.jobs.size, 0);
});

test('recovery retries after Telegram accepted but MongoDB success recording failed (duplicate window)', async () => {
  const post = await makeProcessedPost('CrashWindow');
  let accepted = 0;
  const notifier = {
    isConfigured: () => true,
    async sendNotification() { accepted += 1; return { messageId: String(accepted) }; },
  };
  const worker = makeWorker(notifier);
  const originalUpdateOne = Post.updateOne;
  Post.updateOne = async function(filter, update, ...args) {
    if (update?.$set?.notificationStatus === 'sent') throw new Error('simulated process crash before recording send success');
    return originalUpdateOne.call(this, filter, update, ...args);
  };
  try {
    await assert.rejects(worker.processNotificationJob(makeNotificationJob(post._id)), /simulated process crash/);
  } finally {
    Post.updateOne = originalUpdateOne;
  }
  assert.equal(accepted, 1);
  await Post.updateOne({ _id: post._id }, { $set: { notificationStartedAt: new Date(Date.now() - 60_000) } });

  const queue = makeQueue();
  const dispatcher = new MongoRecoveryDispatcher({
    queueProvider: () => queue,
    redisReady: () => true,
    notificationsEnabled: () => true,
    staleAfterMs: 1000,
    logger: quietLogger,
  });
  const recovered = await dispatcher.dispatchOnce();
  assert.equal(recovered.enqueued, 1);
  assert.ok(queue.jobs.has(notificationJobId(post._id)));

  const retried = await worker.processNotificationJob(makeNotificationJob(post._id));
  const saved = await Post.findById(post._id).lean();
  assert.equal(retried.status, 'sent');
  assert.equal(accepted, 2, 'retry may duplicate a message already accepted by Telegram');
  assert.equal(saved.notificationStatus, 'sent');
  assert.equal(saved.notificationAttempts, 2);
});
