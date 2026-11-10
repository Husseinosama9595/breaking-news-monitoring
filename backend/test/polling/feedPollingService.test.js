import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { ProviderRegistry } from '../../src/providers/providerRegistry.js';
import { FeedPollingService } from '../../src/services/feedPollingService.js';

const testDatabaseName = `breaking_news_monitor_step3_${process.pid}`;
const quietLogger = { info() {}, warn() {}, error() {} };

before(async () => {
  if (env.nodeEnv === 'production') throw new Error('Refusing to run polling tests against production configuration');
  try {
    await mongoose.connect(env.mongoUri, { dbName: testDatabaseName, serverSelectionTimeoutMS: 5000 });
    await Promise.all([MonitoredAccount.init(), Post.init()]);
  } catch {
    await mongoose.disconnect().catch(() => {});
    throw new Error('Could not connect to the configured local MongoDB for isolated polling tests');
  }
});

after(async () => {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([Post.deleteMany({}), MonitoredAccount.deleteMany({})]);
});

async function makeAccount(username, providerName = 'mock') {
  return MonitoredAccount.create({
    platform: 'x', username, normalizedUsername: username.toLowerCase(),
    category: 'World News', providerName, enabled: true, monitoringStatus: 'active',
  });
}

function makeService(mock, { timeoutMs = 120, intervalMs = 45000, registry } = {}) {
  const providerRegistry = registry ?? new ProviderRegistry();
  if (!registry) providerRegistry.register(mock, { defaultProvider: true });
  return new FeedPollingService({
    registry: providerRegistry,
    intervalMs,
    timeoutMs,
    logger: quietLogger,
  });
}

test('polls mock posts, persists them, suppresses repeat duplicates, and ingests a new post', async () => {
  let now = new Date('2026-05-01T10:00:00.000Z');
  const mock = new MockNewsProvider({ clock: () => new Date(now) });
  const service = makeService(mock);
  const account = await makeAccount('Reuters');

  const first = await service.pollAccount(account.toObject());
  assert.equal(first.status, 'success');
  assert.equal(first.insertedCount, 1);
  assert.equal(await Post.countDocuments(), 1);

  now = new Date(now.getTime() + 30_000);
  const repeated = await service.pollAccount(account.toObject());
  assert.equal(repeated.status, 'success');
  assert.equal(repeated.insertedCount, 0);
  assert.equal(repeated.duplicateCount, 1);
  assert.equal(await Post.countDocuments(), 1);

  mock.publish('Reuters', { text: '[MOCK] Simulated newly published post.' });
  now = new Date(now.getTime() + 30_000);
  const newPost = await service.pollAccount(account.toObject());
  assert.equal(newPost.insertedCount, 1);
  assert.equal(await Post.countDocuments(), 2);
  const savedAccount = await MonitoredAccount.findById(account._id).lean();
  assert.equal(savedAccount.lastSeenProviderPostId, 'mock-new-reuters-0001');
  assert.ok(savedAccount.lastPollAttemptAt instanceof Date);
  assert.equal(savedAccount.lastPollErrorAt, null);
});

test('successful empty feed updates last successful fetch but leaves post checkpoint empty', async () => {
  const mock = new MockNewsProvider();
  mock.setScenario('EmptySource', 'empty');
  const service = makeService(mock);
  const account = await makeAccount('EmptySource');
  const result = await service.pollAccount(account.toObject());
  assert.equal(result.status, 'success');
  assert.equal(result.receivedCount, 0);
  const saved = await MonitoredAccount.findById(account._id).lean();
  assert.ok(saved.lastSuccessfulFetchAt instanceof Date);
  assert.equal(saved.lastSeenProviderPostId, null);
  assert.equal(saved.lastSeenPublishedAt, null);
});

test('timeouts and retryable/permanent provider errors do not advance successful checkpoints', async () => {
  let now = new Date('2026-06-01T00:00:00.000Z');
  const mock = new MockNewsProvider({ clock: () => new Date(now) });
  const service = makeService(mock, { timeoutMs: 120 });
  const account = await makeAccount('Reuters');
  const initial = await service.pollAccount(account.toObject());
  assert.equal(initial.status, 'success');
  const checkpointBefore = await MonitoredAccount.findById(account._id).lean();
  const savedCheckpoint = checkpointBefore.lastSeenProviderPostId;
  const successfulAt = checkpointBefore.lastSuccessfulFetchAt.toISOString();

  now = new Date(now.getTime() + 60_000);
  mock.setScenario('Reuters', 'timeout');
  const timeout = await service.pollAccount(account.toObject());
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT');
  assert.equal(timeout.retryable, true);

  mock.setScenario('Reuters', 'retryable-error');
  const transient = await service.pollAccount(account.toObject());
  assert.equal(transient.code, 'MOCK_RETRYABLE_ERROR');
  assert.equal(transient.retryable, true);

  mock.setScenario('Reuters', 'permanent-error');
  const permanent = await service.pollAccount(account.toObject());
  assert.equal(permanent.code, 'MOCK_PERMANENT_ERROR');
  assert.equal(permanent.retryable, false);

  const saved = await MonitoredAccount.findById(account._id).lean();
  assert.equal(saved.lastSeenProviderPostId, savedCheckpoint);
  assert.equal(saved.lastSuccessfulFetchAt.toISOString(), successfulAt);
  assert.ok(saved.lastPollAttemptAt instanceof Date);
  assert.ok(saved.lastPollErrorAt instanceof Date);
  assert.match(saved.lastError, /Simulated permanent provider error/);
});

test('prevents concurrent polling of the same account', async () => {
  const mock = new MockNewsProvider();
  const originalFetch = mock.fetchRecentPosts.bind(mock);
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  mock.fetchRecentPosts = async (...args) => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 35));
    concurrent -= 1;
    return originalFetch(...args);
  };
  const service = makeService(mock);
  const account = await makeAccount('Reuters');

  const firstPromise = service.pollAccount(account.toObject());
  const overlapping = await service.pollAccount(account.toObject());
  const first = await firstPromise;
  assert.equal(overlapping.status, 'skipped-overlap');
  assert.equal(first.status, 'success');
  assert.equal(calls, 1);
  assert.equal(maxConcurrent, 1);
});

test('polls all enabled active accounts and stops cleanly', async () => {
  const mock = new MockNewsProvider();
  const service = makeService(mock, { intervalMs: 45000 });
  await makeAccount('Reuters');
  await makeAccount('NASA');
  await makeAccount('Disabled').then((account) => MonitoredAccount.updateOne({ _id: account._id }, { $set: { enabled: false } }));

  const result = await service.pollOnce();
  assert.equal(result.status, 'success');
  assert.equal(result.accountCount, 2);
  assert.equal(await Post.countDocuments(), 2);
  assert.equal(service.start(), true);
  assert.equal(service.start(), false);
  await service.stop();
  assert.equal(service.timer, null);
});

test('registry rejects duplicates and keeps mock as the selected default', () => {
  const registry = new ProviderRegistry();
  const mock = new MockNewsProvider();
  registry.register(mock, { defaultProvider: true });
  assert.equal(registry.getDefault(), mock);
  assert.deepEqual(registry.list(), ['mock']);
  assert.throws(() => registry.register(new MockNewsProvider()), /already registered/);
});

test('supports forcing Nitter for existing mock-tagged account records and stores the selected provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockNewsProvider(), { defaultProvider: true });
  registry.register({ name: 'nitter', async fetchRecentPosts() {
    return {
      providerName: 'nitter', fetchedAt: new Date(), posts: [{
        providerName: 'nitter', providerPostId: '1999000000000000001', canonicalPostId: '1999000000000000001',
        sourceAccountId: null, sourceUsername: 'SwitchSource', author: { username: 'SwitchSource' },
        text: 'Nitter-selected post', postUrl: 'https://x.com/SwitchSource/status/1999000000000000001',
        providerUrl: 'https://nitter.example', publishedAt: new Date(), retrievedAt: new Date(),
      }],
    };
  } });
  const service = new FeedPollingService({ registry, providerNameMode: 'nitter', intervalMs: 45000, timeoutMs: 1000, logger: quietLogger });
  const account = await makeAccount('SwitchSource', 'mock');
  const result = await service.pollAccount(account.toObject());
  assert.equal(result.status, 'success');
  assert.equal(result.providerName, 'nitter');
  const savedAccount = await MonitoredAccount.findById(account._id).lean();
  assert.equal(savedAccount.providerName, 'nitter');
  assert.equal(await Post.countDocuments({ providerName: 'nitter' }), 1);
});
