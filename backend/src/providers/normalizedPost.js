import { FeedProviderError } from './providerErrors.js';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function invalid(providerName, field, message) {
  return new FeedProviderError(`Invalid ${providerName} feed data: ${field} ${message}`, {
    providerName,
    code: 'INVALID_PROVIDER_DATA',
    retryable: false,
  });
}

function normalizeDate(value, providerName, field, { required = false } = {}) {
  if (value == null && !required) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(providerName, field, 'must be a valid date');
  return date;
}

function normalizeUrl(value, providerName, field) {
  if (value == null || value === '') return null;
  if (!isNonEmptyString(value)) throw invalid(providerName, field, 'must be an HTTP(S) URL');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    return url.toString();
  } catch {
    throw invalid(providerName, field, 'must be an HTTP(S) URL');
  }
}

/**
 * Validate and normalize a provider post. Timestamps are returned as Date instances.
 * Provider IDs are namespaced separately by the persistence layer in a later step.
 * @param {unknown} value
 * @param {string} providerName
 * @returns {import('./feedProvider.js').NormalizedFeedPost}
 */
export function normalizeFeedPost(value, providerName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(providerName, 'post', 'must be an object');
  }
  const post = /** @type {Record<string, unknown>} */ (value);
  if (!isNonEmptyString(providerName)) throw new TypeError('providerName must be a non-empty string');
  if (post.providerName !== providerName) throw invalid(providerName, 'providerName', 'must match the active provider');
  if (!isNonEmptyString(post.providerPostId)) throw invalid(providerName, 'providerPostId', 'must be a non-empty string');
  if (!isNonEmptyString(post.sourceUsername)) throw invalid(providerName, 'sourceUsername', 'must be a non-empty string');
  if (typeof post.text !== 'string') throw invalid(providerName, 'text', 'must be a string');

  const authorValue = post.author;
  if (!authorValue || typeof authorValue !== 'object' || Array.isArray(authorValue)) {
    throw invalid(providerName, 'author', 'must be an object');
  }
  const author = /** @type {Record<string, unknown>} */ (authorValue);
  if (!isNonEmptyString(author.username)) throw invalid(providerName, 'author.username', 'must be a non-empty string');
  if (author.displayName != null && typeof author.displayName !== 'string') {
    throw invalid(providerName, 'author.displayName', 'must be a string when provided');
  }
  if (post.sourceAccountId != null && typeof post.sourceAccountId !== 'string') {
    throw invalid(providerName, 'sourceAccountId', 'must be a string when provided');
  }

  const raw = post.raw;
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw invalid(providerName, 'raw', 'must be an object when provided');
  }

  return {
    providerName,
    providerPostId: post.providerPostId.trim(),
    canonicalPostId: post.canonicalPostId == null ? null : String(post.canonicalPostId),
    sourceAccountId: post.sourceAccountId == null ? null : post.sourceAccountId,
    sourceUsername: post.sourceUsername.replace(/^@/, '').trim(),
    author: {
      username: author.username.replace(/^@/, '').trim(),
      ...(typeof author.displayName === 'string' ? { displayName: author.displayName } : {}),
    },
    text: post.text,
    postUrl: normalizeUrl(post.postUrl, providerName, 'postUrl'),
    providerUrl: normalizeUrl(post.providerUrl, providerName, 'providerUrl'),
    publishedAt: normalizeDate(post.publishedAt, providerName, 'publishedAt'),
    retrievedAt: normalizeDate(post.retrievedAt, providerName, 'retrievedAt', { required: true }),
    ...(raw == null ? {} : { raw }),
  };
}

/**
 * Validate the common batch returned by every provider.
 * @param {unknown} value
 * @param {string} providerName
 * @returns {import('./feedProvider.js').FeedProviderBatch}
 */
export function validateProviderBatch(value, providerName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(providerName, 'batch', 'must be an object');
  }
  const batch = /** @type {Record<string, unknown>} */ (value);
  if (batch.providerName !== providerName) throw invalid(providerName, 'batch.providerName', 'must match the active provider');
  if (!Array.isArray(batch.posts)) throw invalid(providerName, 'batch.posts', 'must be an array');
  const fetchedAt = normalizeDate(batch.fetchedAt, providerName, 'fetchedAt', { required: true });
  if (batch.nextCursor != null && typeof batch.nextCursor !== 'string') {
    throw invalid(providerName, 'batch.nextCursor', 'must be a string when provided');
  }
  return {
    providerName,
    posts: batch.posts.map((post) => normalizeFeedPost(post, providerName)),
    fetchedAt,
    ...(typeof batch.nextCursor === 'string' ? { nextCursor: batch.nextCursor } : {}),
  };
}
