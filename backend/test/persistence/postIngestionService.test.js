import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import { ingestProviderBatch, createPostDedupeKey } from '../../src/services/postIngestionService.js';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { normalizeFeedPost } from '../../src/providers/normalizedPost.js';

function makeNitterBatch(username, items, fetchedAt) {
  return {
    providerName: 'nitter',
    fetchedAt,
    posts: items.map(({ id, publishedAt, text = `Nitter item ${id}` }) => normalizeFeedPost({
      providerName: 'nitter', providerPostId: id, canonicalPostId: id,
      sourceUsername: username, author: { username }, text,
      postUrl: `https://x.com/${username}/status/${id}`,
      providerUrl: 'https://xitter.cf', publishedAt,
      retrievedAt: fetchedAt,
    }, 'nitter')),
  };
}

const testDatabaseName = 'breaking_news_monitor_step2_test';

before(async () => {
  if (env.nodeEnv === 'production') throw new Error('Refusing to run persistence tests against production configuration');
  try {
    await mongoose.connect(env.mongoUri, { dbName: testDatabaseName, serverSelectionTimeoutMS: 5000 });
    await Promise.all([MonitoredAccount.init(), Post.init()]);
  } catch {
    await mongoose.disconnect().catch(() => {});
    throw new Error('Could not connect to the configured local MongoDB for isolated persistence tests');
  }
});

after(async () => {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('persists mock posts as durable pending work and repeat ingestion is idempotent', async () => {
  const now = new Date('2026-02-03T04:05:06.000Z');
  const mock = new MockNewsProvider({ clock: () => new Date(now) });
  const batch = await mock.fetchRecentPosts({ username: 'Reuters' });
  const account = { username: 'Reuters', category: 'World News', platform: 'x' };
  const first = await ingestProviderBatch({ account, batch, receivedAt: now });
  const second = await ingestProviderBatch({ account, batch, receivedAt: new Date(now.getTime() + 1000) });

  assert.equal(first.receivedCount, 1);
  assert.equal(first.insertedCount, 1);
  assert.equal(first.duplicateCount, 0);
  assert.equal(second.insertedCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await Post.countDocuments(), 1);

  const saved = await Post.findOne({ providerPostId: batch.posts[0].providerPostId }).lean();
  assert.equal(saved.text, batch.posts[0].text);
  assert.equal(saved.category, 'World News');
  assert.equal(saved.processingStatus, 'pending');
  assert.equal(saved.notificationStatus, 'pending');
  assert.equal(saved.telegramSent, false);
  assert.equal(saved.receivedAt.toISOString(), now.toISOString());

  const savedAccount = await MonitoredAccount.findOne({ normalizedUsername: 'reuters' }).lean();
  assert.equal(savedAccount.lastSeenProviderPostId, batch.posts[0].providerPostId);
  assert.equal(savedAccount.lastSeenPublishedAt.toISOString(), batch.posts[0].publishedAt.toISOString());
  assert.equal(savedAccount.lastSuccessfulFetchAt.toISOString(), batch.fetchedAt.toISOString());
});

test('declares and enforces the unique post dedupe index', async () => {
  const indexes = await Post.collection.indexes();
  const dedupeIndex = indexes.find((index) => index.name === 'uniq_post_dedupe_key');
  assert.ok(dedupeIndex, 'unique dedupe index should be created');
  assert.equal(dedupeIndex.unique, true);
  assert.deepEqual(dedupeIndex.key, { dedupeKey: 1 });

  const mock = new MockNewsProvider();
  const batch = await mock.fetchRecentPosts({ username: 'Reuters' });
  await ingestProviderBatch({ account: { username: 'Reuters' }, batch });
  const stored = await Post.findOne({ dedupeKey: createPostDedupeKey(batch.posts[0]) }).lean();
  await assert.rejects(Post.create({ ...stored, _id: new mongoose.Types.ObjectId() }), (error) => error?.code === 11000);
});

test('does not advance account post checkpoint when post persistence fails', async () => {
  const now = new Date('2026-03-04T05:06:07.000Z');
  const mock = new MockNewsProvider({ clock: () => new Date(now) });
  const batch = await mock.fetchRecentPosts({ username: 'NASA' });
  const originalBulkWrite = Post.bulkWrite;
  Post.bulkWrite = async () => { throw new Error('simulated MongoDB write failure'); };
  try {
    await assert.rejects(ingestProviderBatch({ account: { username: 'NASA' }, batch }), /simulated MongoDB write failure/);
  } finally {
    Post.bulkWrite = originalBulkWrite;
  }
  const storedAccount = await MonitoredAccount.findOne({ normalizedUsername: 'nasa' }).lean();
  assert.ok(storedAccount);
  assert.equal(storedAccount.lastSeenProviderPostId, null);
  assert.equal(storedAccount.lastSeenPublishedAt, null);
  assert.equal(storedAccount.lastSuccessfulFetchAt, null);
  assert.equal(await Post.countDocuments(), 1);
});

test('does not regress a post checkpoint when an older batch arrives later', async () => {
  const mock = new MockNewsProvider({ clock: () => new Date('2026-04-05T06:07:08.000Z') });
  mock.publish('CISA', { text: '[MOCK] older update', publishedAt: '2026-04-01T00:00:00.000Z' });
  const olderBatch = await mock.fetchRecentPosts({ username: 'CISA' });
  mock.publish('CISA', { text: '[MOCK] newer update', publishedAt: '2026-04-02T00:00:00.000Z' });
  const newerBatch = await mock.fetchRecentPosts({ username: 'CISA' });
  await ingestProviderBatch({ account: { username: 'CISA' }, batch: newerBatch });
  await ingestProviderBatch({ account: { username: 'CISA' }, batch: olderBatch });
  const savedAccount = await MonitoredAccount.findOne({ normalizedUsername: 'cisa' }).lean();
  assert.equal(savedAccount.lastSeenProviderPostId, newerBatch.posts[0].providerPostId);
  assert.equal(savedAccount.lastSeenPublishedAt.toISOString(), '2026-04-02T00:00:00.000Z');
});

test('uses canonical X IDs across providers and provider-scoped fallback IDs', async () => {
  const base = { canonicalPostId: '123', providerName: 'rsshub', providerPostId: 'rss-1' };
  assert.equal(createPostDedupeKey(base), createPostDedupeKey({ ...base, providerName: 'nitter', providerPostId: 'nitter-9' }));
  assert.notEqual(
    createPostDedupeKey({ ...base, canonicalPostId: null }),
    createPostDedupeKey({ ...base, canonicalPostId: null, providerName: 'nitter' }),
  );
});

test('Nitter first successful fetch stores history as skipped and suppresses existing unsent posts', async () => {
  const account = await MonitoredAccount.create({
    platform: 'x', username: 'NitterBaseline', normalizedUsername: 'nitterbaseline',
    category: 'Other', enabled: true, providerName: 'nitter', monitoringStatus: 'active',
  });
  await Post.create({
    dedupeKey: 'x:historical-before-enable', providerName: 'nitter', providerPostId: 'historical-before-enable',
    canonicalPostId: 'historical-before-enable', monitoredAccount: account._id,
    username: account.username, author: { username: account.username }, text: 'Already pending historical item',
    postUrl: 'https://x.com/NitterBaseline/status/historical-before-enable', providerUrl: 'https://xitter.cf',
    receivedAt: new Date('2026-05-01T00:00:00Z'), retrievedAt: new Date('2026-05-01T00:00:00Z'),
    processingStatus: 'pending', notificationStatus: 'pending', telegramSent: false,
  });
  const fetchedAt = new Date('2026-05-02T00:00:00Z');
  const batch = makeNitterBatch('NitterBaseline', [
    { id: '100000000000000001', publishedAt: new Date('2026-05-01T12:00:00Z') },
    { id: '100000000000000002', publishedAt: new Date('2026-05-01T11:00:00Z') },
  ], fetchedAt);

  const result = await ingestProviderBatch({ account: account.toObject(), batch, receivedAt: fetchedAt });
  assert.equal(result.insertedCount, 2);
  assert.equal(await Post.countDocuments({ monitoredAccount: account._id, notificationStatus: 'pending' }), 0);
  assert.equal(await Post.countDocuments({ monitoredAccount: account._id, notificationStatus: 'skipped' }), 3);
  const savedAccount = await MonitoredAccount.findById(account._id).lean();
  assert.equal(savedAccount.notificationBaselineAt.toISOString(), '2026-05-01T12:00:00.000Z');
  assert.equal(savedAccount.lastSeenProviderPostId, '100000000000000001');
});

test('after Nitter baseline only newer timestamped posts become notification work', async () => {
  const account = await MonitoredAccount.create({
    platform: 'x', username: 'NitterNewOnly', normalizedUsername: 'nitternewonly',
    category: 'Other', enabled: true, providerName: 'nitter', monitoringStatus: 'active',
    notificationBaselineAt: new Date('2026-05-01T12:00:00Z'),
  });
  const fetchedAt = new Date('2026-05-01T12:05:00Z');
  const batch = makeNitterBatch('NitterNewOnly', [
    { id: '100000000000000010', publishedAt: new Date('2026-05-01T11:59:00Z') },
    { id: '100000000000000011', publishedAt: new Date('2026-05-01T12:01:00Z') },
    { id: '100000000000000012', publishedAt: null, text: 'Missing timestamp' },
  ], fetchedAt);

  await ingestProviderBatch({ account: account.toObject(), batch, receivedAt: fetchedAt });
  const oldPost = await Post.findOne({ providerPostId: '100000000000000010' }).lean();
  const newPost = await Post.findOne({ providerPostId: '100000000000000011' }).lean();
  const unknownDate = await Post.findOne({ providerPostId: '100000000000000012' }).lean();
  assert.equal(oldPost.notificationStatus, 'skipped');
  assert.equal(newPost.notificationStatus, 'pending');
  assert.equal(newPost.processingStatus, 'pending');
  assert.equal(unknownDate.notificationStatus, 'skipped');
  assert.equal(unknownDate.processingStatus, 'processed');
});
