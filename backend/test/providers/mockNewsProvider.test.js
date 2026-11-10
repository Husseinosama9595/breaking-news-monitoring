import test from 'node:test';
import assert from 'node:assert/strict';
import { MockNewsProvider } from '../../src/providers/mockNewsProvider.js';
import { fetchProviderBatch } from '../../src/providers/feedProvider.js';
import { FeedProviderError, ProviderTimeoutError } from '../../src/providers/providerErrors.js';

const fixedNow = new Date('2026-01-01T00:00:00.000Z');
const provider = () => new MockNewsProvider({ clock: () => new Date(fixedNow), defaultTimeoutMs: 8 });

test('returns deterministic predefined fixtures for matching accounts', async () => {
  const mock = provider();
  const first = await fetchProviderBatch(mock, { username: '@Reuters', platform: 'x' });
  const second = await fetchProviderBatch(mock, { username: 'reuters' });
  assert.equal(first.posts.length, 1);
  assert.equal(first.posts[0].providerPostId, 'mock-reuters-0001');
  assert.deepEqual(first.posts.map((post) => post.providerPostId), second.posts.map((post) => post.providerPostId));
  assert.match(first.posts[0].text, /^\[MOCK\]/);
});

test('publishes simulated posts with stable generated IDs and returns newest first', async () => {
  const mock = provider();
  const older = mock.publish('Reuters', { text: '[MOCK] older', publishedAt: '2025-01-01T00:00:00Z' });
  const newer = mock.publish('@Reuters', { text: '[MOCK] newer' });
  assert.equal(older.providerPostId, 'mock-new-reuters-0001');
  assert.equal(newer.providerPostId, 'mock-new-reuters-0002');
  const result = await fetchProviderBatch(mock, { username: 'Reuters' });
  assert.equal(result.posts[0].providerPostId, newer.providerPostId);
  assert.equal(result.posts[0].retrievedAt.toISOString(), fixedNow.toISOString());
});

test('supports empty, duplicate, and repeated polling scenarios', async () => {
  const mock = provider();
  mock.setScenario('Reuters', 'empty');
  assert.equal((await mock.fetchRecentPosts({ username: 'Reuters' })).posts.length, 0);
  mock.setScenario('Reuters', 'duplicate');
  const batch = await mock.fetchRecentPosts({ username: 'Reuters' });
  assert.equal(batch.posts.length, 2);
  assert.equal(batch.posts[0].providerPostId, batch.posts[1].providerPostId);
  mock.clearScenario('Reuters');
  const again = await mock.fetchRecentPosts({ username: 'Reuters' });
  assert.equal(again.posts[0].providerPostId, batch.posts[0].providerPostId);
});

test('simulates timeout as a retryable typed provider error', async () => {
  const mock = provider();
  mock.setScenario('Reuters', 'timeout');
  await assert.rejects(mock.fetchRecentPosts({ username: 'Reuters' }, { timeoutMs: 8 }), (error) => {
    assert.ok(error instanceof ProviderTimeoutError);
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('simulates retryable and permanent provider errors', async () => {
  const mock = provider();
  mock.setScenario('Reuters', 'retryable-error');
  await assert.rejects(mock.fetchRecentPosts({ username: 'Reuters' }), (error) => {
    assert.ok(error instanceof FeedProviderError);
    assert.equal(error.code, 'MOCK_RETRYABLE_ERROR');
    assert.equal(error.retryable, true);
    return true;
  });
  mock.setScenario('Reuters', 'permanent-error');
  await assert.rejects(mock.fetchRecentPosts({ username: 'Reuters' }), (error) => {
    assert.equal(error.code, 'MOCK_PERMANENT_ERROR');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('validates account, platform, options and reset behavior', async () => {
  const mock = provider();
  await assert.rejects(mock.fetchRecentPosts({ username: '' }), { code: 'INVALID_ACCOUNT', retryable: false });
  await assert.rejects(mock.fetchRecentPosts({ username: 'Reuters', platform: 'instagram' }), { code: 'UNSUPPORTED_PLATFORM' });
  await assert.rejects(mock.fetchRecentPosts({ username: 'Reuters' }, { limit: 0 }), { code: 'INVALID_OPTIONS' });
  mock.publish('Reuters', { text: '[MOCK] item' });
  mock.setScenario('Reuters', 'empty');
  mock.reset();
  assert.equal((await mock.fetchRecentPosts({ username: 'Reuters' })).posts.length, 1);
});
