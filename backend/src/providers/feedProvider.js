import { FeedProviderError } from './providerErrors.js';
import { validateProviderBatch } from './normalizedPost.js';

/** @typedef {{ username: string, displayName?: string, platform?: string }} FeedAccount */
/** @typedef {{ username: string, displayName?: string }} FeedAuthor */
/**
 * @typedef {object} NormalizedFeedPost
 * @property {string} providerName
 * @property {string} providerPostId
 * @property {string|null} canonicalPostId
 * @property {string|null} sourceAccountId
 * @property {string} sourceUsername
 * @property {FeedAuthor} author
 * @property {string} text
 * @property {string|null} postUrl
 * @property {string|null} providerUrl
 * @property {Date|null} publishedAt
 * @property {Date} retrievedAt
 * @property {Record<string, unknown>} [raw]
 */
/** @typedef {{ providerName: string, posts: NormalizedFeedPost[], fetchedAt: Date, nextCursor?: string }} FeedProviderBatch */
/** @typedef {{ limit?: number, timeoutMs?: number, signal?: AbortSignal, cursor?: string }} FetchRecentPostsOptions */

/**
 * Structural interface for a feed provider. Implementations must expose `name` and
 * `fetchRecentPosts(account, options)` and return a validated or normalizable batch.
 * @typedef {object} FeedProvider
 * @property {string} name
 * @property {(account: FeedAccount, options?: FetchRecentPostsOptions) => Promise<FeedProviderBatch>} fetchRecentPosts
 */

/**
 * Check that a provider has the minimum callable contract.
 * @param {unknown} provider
 * @returns {asserts provider is FeedProvider}
 */
export function assertFeedProvider(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.name !== 'string' || !provider.name.trim()) {
    throw new TypeError('Feed provider must have a non-empty name');
  }
  if (typeof provider.fetchRecentPosts !== 'function') {
    throw new TypeError(`${provider.name} must implement fetchRecentPosts(account, options)`);
  }
}

/**
 * Fetch then runtime-validate a provider response; unknown exceptions are classified
 * as retryable provider failures so callers can apply consistent retry policy.
 * @param {FeedProvider} provider
 * @param {FeedAccount} account
 * @param {FetchRecentPostsOptions} [options]
 * @returns {Promise<FeedProviderBatch>}
 */
export async function fetchProviderBatch(provider, account, options = {}) {
  assertFeedProvider(provider);
  try {
    return validateProviderBatch(await provider.fetchRecentPosts(account, options), provider.name);
  } catch (error) {
    if (error instanceof FeedProviderError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new FeedProviderError(`${provider.name} request timed out`, {
        providerName: provider.name,
        code: 'PROVIDER_TIMEOUT',
        retryable: true,
        cause: error,
      });
    }
    throw new FeedProviderError(`${provider.name} request failed`, {
      providerName: provider.name,
      code: 'PROVIDER_REQUEST_FAILED',
      retryable: true,
      cause: error,
    });
  }
}
