import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFeedProvider, fetchProviderBatch } from '../../src/providers/feedProvider.js';
import { FeedProviderError } from '../../src/providers/providerErrors.js';

const validPost = {
  providerName: 'test', providerPostId: '42', sourceUsername: '@wire',
  author: { username: '@wire' }, text: '', postUrl: 'https://x.com/wire/status/42',
  publishedAt: '2025-02-03T04:05:06Z', retrievedAt: new Date('2025-02-03T04:05:07Z'),
};

test('validates provider contract and normalizes batch/post timestamps and usernames', async () => {
  const provider = { name: 'test', async fetchRecentPosts() {
    return { providerName: 'test', fetchedAt: '2025-02-03T04:05:07Z', posts: [validPost] };
  } };
  assert.doesNotThrow(() => assertFeedProvider(provider));
  const result = await fetchProviderBatch(provider, { username: 'wire' });
  assert.equal(result.posts[0].sourceUsername, 'wire');
  assert.equal(result.posts[0].author.username, 'wire');
  assert.ok(result.fetchedAt instanceof Date);
  assert.ok(result.posts[0].publishedAt instanceof Date);
});

test('rejects malformed provider contracts and returned data with a permanent typed error', async () => {
  assert.throws(() => assertFeedProvider({ name: 'broken' }), /fetchRecentPosts/);
  const provider = { name: 'test', async fetchRecentPosts() {
    return { providerName: 'test', fetchedAt: 'bad-date', posts: [validPost] };
  } };
  await assert.rejects(fetchProviderBatch(provider, { username: 'wire' }), (error) => {
    assert.ok(error instanceof FeedProviderError);
    assert.equal(error.code, 'INVALID_PROVIDER_DATA');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('rejects mismatched provider names and unsafe URLs', async () => {
  const mismatch = { name: 'test', async fetchRecentPosts() {
    return { providerName: 'other', fetchedAt: new Date(), posts: [] };
  } };
  await assert.rejects(fetchProviderBatch(mismatch, { username: 'wire' }), { code: 'INVALID_PROVIDER_DATA' });
  const unsafe = { name: 'test', async fetchRecentPosts() {
    return { providerName: 'test', fetchedAt: new Date(), posts: [{ ...validPost, postUrl: 'javascript:alert(1)' }] };
  } };
  await assert.rejects(fetchProviderBatch(unsafe, { username: 'wire' }), { code: 'INVALID_PROVIDER_DATA', retryable: false });
});

test('wraps unknown provider exceptions as retryable errors and preserves typed errors', async () => {
  const transient = { name: 'test', async fetchRecentPosts() { throw new Error('network'); } };
  await assert.rejects(fetchProviderBatch(transient, { username: 'wire' }), { code: 'PROVIDER_REQUEST_FAILED', retryable: true });
  const known = new FeedProviderError('known', { providerName: 'test', code: 'MAINTENANCE', retryable: false });
  const permanent = { name: 'test', async fetchRecentPosts() { throw known; } };
  await assert.rejects(fetchProviderBatch(permanent, { username: 'wire' }), (error) => error === known);
});
