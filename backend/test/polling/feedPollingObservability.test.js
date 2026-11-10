import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedPollingService, summarizeFeedFreshness } from '../../src/services/feedPollingService.js';
import { FeedProviderError } from '../../src/providers/providerErrors.js';

const BASE = new Date('2026-11-10T12:00:00.000Z');
const quietLogger = { info() {}, warn() {}, error() {} };

function makePost({ id = 'post-1', publishedAt = new Date(BASE.getTime() - 30_000) } = {}) {
  return {
    providerName: 'mock', providerPostId: id, canonicalPostId: null, sourceAccountId: null,
    sourceUsername: 'FreshnessTest', author: { username: 'FreshnessTest' }, text: `Post ${id}`,
    postUrl: null, providerUrl: null, publishedAt, retrievedAt: BASE,
  };
}

function makeHarness({ posts = [makePost()], ingestResult, ingestError, fetchError, clockValues } = {}) {
  const writes = [];
  let tick = 0;
  const clock = () => {
    const current = tick++;
    return new Date(clockValues?.[current] ?? BASE.getTime() + current * 100);
  };
  const provider = {
    name: 'mock',
    async fetchRecentPosts() {
      if (fetchError) throw fetchError;
      return { providerName: 'mock', posts, fetchedAt: BASE };
    },
  };
  const registry = { get: (name) => name === 'mock' ? provider : null, getDefaultName: () => 'mock' };
  const accountModel = {
    async updateOne(filter, update) { writes.push({ filter, update }); return { modifiedCount: 1 }; },
  };
  const service = new FeedPollingService({
    registry,
    accountModel,
    providerNameMode: 'mock',
    freshnessMaxAgeMs: 60 * 60 * 1000,
    logger: quietLogger,
    clock,
    ingest: async () => {
      if (ingestError) throw ingestError;
      return ingestResult ?? { receivedCount: posts.length, insertedCount: posts.length, duplicateCount: 0 };
    },
  });
  const account = { _id: 'account-1', username: 'FreshnessTest', category: 'Other', platform: 'x' };
  return { service, account, writes };
}

const finalHealthWrite = (writes) => writes.at(-1)?.update?.$set;

test('records successful poll duration, returned entries, inserts, duplicates, and fresh timestamps', async () => {
  const { service, account, writes } = makeHarness({
    posts: [makePost(), makePost({ id: 'post-2' })],
    ingestResult: { receivedCount: 2, insertedCount: 1, duplicateCount: 1 },
    clockValues: [BASE, new Date(BASE.getTime() + 100), new Date(BASE.getTime() + 250)],
  });
  const result = await service.pollAccount(account);
  const health = finalHealthWrite(writes);

  assert.equal(result.status, 'success');
  assert.equal(result.pollHealth.durationMs, 250);
  assert.equal(result.pollHealth.entryCount, 2);
  assert.equal(result.pollHealth.insertedCount, 1);
  assert.equal(result.pollHealth.duplicateCount, 1);
  assert.equal(health.lastPollStatus, 'success');
  assert.equal(health.lastPollEntryCount, 2);
  assert.equal(health.lastPollInsertedCount, 1);
  assert.equal(health.lastPollDuplicateCount, 1);
  assert.equal(health.lastProviderFeedFreshnessStatus, 'fresh');
  assert.equal(writes[0].update.$set.lastPollAttemptAt.toISOString(), BASE.toISOString());
});

test('records a successful poll containing only duplicate posts', async () => {
  const { service, account, writes } = makeHarness({
    ingestResult: { receivedCount: 1, insertedCount: 0, duplicateCount: 1 },
  });
  const result = await service.pollAccount(account);

  assert.equal(result.status, 'success');
  assert.equal(result.insertedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(finalHealthWrite(writes).lastPollStatus, 'success');
});

test('treats a successful empty feed as empty rather than a poll failure', async () => {
  const { service, account, writes } = makeHarness({
    posts: [], ingestResult: { receivedCount: 0, insertedCount: 0, duplicateCount: 0 },
  });
  const result = await service.pollAccount(account);
  const health = finalHealthWrite(writes);

  assert.equal(result.status, 'success');
  assert.equal(result.pollHealth.entryCount, 0);
  assert.equal(result.pollHealth.freshnessStatus, 'empty');
  assert.equal(health.lastProviderFeedFreshnessStatus, 'empty');
  assert.equal(health.lastProviderFeedLatestPublishedAt, null);
});

test('marks a successful provider response stale when its newest valid post exceeds the heuristic age', async () => {
  const oldPost = makePost({ publishedAt: new Date(BASE.getTime() - 2 * 60 * 60 * 1000) });
  const { service, account, writes } = makeHarness({ posts: [oldPost] });
  const result = await service.pollAccount(account);

  assert.equal(result.status, 'success');
  assert.equal(result.pollHealth.freshnessStatus, 'stale');
  assert.equal(finalHealthWrite(writes).lastProviderFeedFreshnessStatus, 'stale');
});

test('does not infer freshness from missing or future publication timestamps', async () => {
  for (const publishedAt of [null, new Date(BASE.getTime() + 60_000)]) {
    const { service, account } = makeHarness({ posts: [makePost({ publishedAt })] });
    const result = await service.pollAccount(account);
    assert.equal(result.status, 'success');
    assert.equal(result.pollHealth.freshnessStatus, 'unknown');
    assert.equal(result.pollHealth.timestampedEntryCount, publishedAt ? 1 : 0);
    assert.equal(result.pollHealth.untimestampedEntryCount, publishedAt ? 0 : 1);
  }
});

test('rejects invalid publication dates without recording the feed as fresh', async () => {
  const { service, account, writes } = makeHarness({ posts: [makePost({ publishedAt: new Date('invalid') })] });
  const result = await service.pollAccount(account);

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'INVALID_PROVIDER_DATA');
  assert.equal(finalHealthWrite(writes).lastPollStatus, 'failed');
  assert.equal(finalHealthWrite(writes).lastProviderFeedFreshnessStatus, undefined);
});

test('records provider request failures without changing prior feed freshness evidence', async () => {
  const { service, account, writes } = makeHarness({
    fetchError: new FeedProviderError('unavailable', { providerName: 'mock', code: 'MOCK_UNAVAILABLE', retryable: true }),
  });
  const result = await service.pollAccount(account);
  const health = finalHealthWrite(writes);

  assert.equal(result.status, 'failed');
  assert.equal(result.pollHealth.errorCode, 'MOCK_UNAVAILABLE');
  assert.equal(health.lastPollStatus, 'failed');
  assert.equal(health.lastPollEntryCount, null);
  assert.equal(health.lastPollErrorCode, 'MOCK_UNAVAILABLE');
  assert.equal(health.lastProviderFeedFreshnessStatus, undefined);
});

test('does not report success or advance successful-fetch/checkpoint fields when persistence fails', async () => {
  const { service, account, writes } = makeHarness({ ingestError: new Error('simulated persistence failure') });
  const result = await service.pollAccount(account);
  const health = finalHealthWrite(writes);

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'POLL_FAILED');
  assert.equal(health.lastPollStatus, 'failed');
  assert.equal(health.lastPollEntryCount, 1, 'provider response count is retained for diagnostics');
  assert.equal(health.lastPollInsertedCount, null);
  assert.equal(health.lastProviderFeedFreshnessStatus, 'fresh', 'provider freshness is distinct from persistence success');
  assert.equal(writes.some(({ update }) => Object.hasOwn(update.$set, 'lastSuccessfulFetchAt')), false);
  assert.equal(writes.some(({ update }) => Object.hasOwn(update.$set, 'lastSeenPublishedAt')), false);
});

test('summarizes a nonempty feed with no valid timestamps as unknown', () => {
  const result = summarizeFeedFreshness([makePost({ publishedAt: null })], BASE, 60 * 60 * 1000);
  assert.equal(result.freshnessStatus, 'unknown');
  assert.equal(result.latestPublishedAt, null);
  assert.equal(result.timestampedEntryCount, 0);
  assert.equal(result.untimestampedEntryCount, 1);
});
