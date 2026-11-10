import { FeedProviderError, ProviderTimeoutError } from './providerErrors.js';
import { normalizeFeedPost } from './normalizedPost.js';

const DEFAULT_TIMEOUT_MS = 100;

/** Deterministic examples for local development only; not claims about real events. */
export const MOCK_POST_FIXTURES = Object.freeze([
  Object.freeze({
    providerName: 'mock', providerPostId: 'mock-reuters-0001', canonicalPostId: null,
    sourceAccountId: 'mock-account-reuters', sourceUsername: 'Reuters',
    author: Object.freeze({ username: 'Reuters', displayName: 'Mock News Desk' }),
    text: '[MOCK] Example post from a deterministic local fixture.',
    postUrl: 'https://example.invalid/Reuters/status/mock-reuters-0001', providerUrl: null,
    publishedAt: '2025-01-01T12:00:00.000Z', retrievedAt: '2025-01-01T12:00:01.000Z',
    raw: Object.freeze({ fixture: true }),
  }),
  Object.freeze({
    providerName: 'mock', providerPostId: 'mock-nasa-0001', canonicalPostId: null,
    sourceAccountId: 'mock-account-nasa', sourceUsername: 'NASA',
    author: Object.freeze({ username: 'NASA', displayName: 'Mock Space Agency' }),
    text: '[MOCK] Second fixture used to verify multi-account feed handling.',
    postUrl: 'https://example.invalid/NASA/status/mock-nasa-0001', providerUrl: null,
    publishedAt: '2025-01-01T11:00:00.000Z', retrievedAt: '2025-01-01T12:00:01.000Z',
    raw: Object.freeze({ fixture: true }),
  }),
]);

const normalizeUsername = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();

/**
 * In-memory provider for local development and deterministic tests. Scenarios are
 * configured per account using setScenario(); normal polls intentionally return the
 * same fixture IDs, which exercises downstream idempotency.
 */
export class MockNewsProvider {
  /**
   * @param {{ fixtures?: readonly object[], clock?: () => Date, defaultTimeoutMs?: number }} [options]
   */
  constructor({ fixtures = MOCK_POST_FIXTURES, clock = () => new Date(), defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Array.isArray(fixtures)) throw new TypeError('fixtures must be an array');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 1) throw new TypeError('defaultTimeoutMs must be a positive number');
    this.name = 'mock';
    this.clock = clock;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.fixtures = fixtures.map((fixture) => normalizeFeedPost(fixture, this.name));
    this.published = [];
    this.scenarios = new Map();
    this.sequence = 0;
  }

  /**
   * @param {{ username: string, displayName?: string }} account
   * @param {{ limit?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async fetchRecentPosts(account, { limit = 50, timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    const username = normalizeUsername(account?.username);
    if (!username) throw new FeedProviderError('Mock account username is required', {
      providerName: this.name, code: 'INVALID_ACCOUNT', retryable: false,
    });
    if (account.platform && account.platform.toLowerCase() !== 'x') {
      throw new FeedProviderError('MockNewsProvider only accepts X account fixtures', {
        providerName: this.name, code: 'UNSUPPORTED_PLATFORM', retryable: false,
      });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new FeedProviderError('limit must be an integer from 1 to 500', {
        providerName: this.name, code: 'INVALID_OPTIONS', retryable: false,
      });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new FeedProviderError('timeoutMs must be a positive number', {
        providerName: this.name, code: 'INVALID_OPTIONS', retryable: false,
      });
    }
    if (signal?.aborted) throw new FeedProviderError('Mock feed request was aborted', {
      providerName: this.name, code: 'PROVIDER_ABORTED', retryable: true,
    });

    const scenario = this.scenarios.get(username);
    if (scenario?.type === 'permanent-error') {
      throw new FeedProviderError(scenario.message ?? 'Simulated permanent provider error', {
        providerName: this.name, code: 'MOCK_PERMANENT_ERROR', retryable: false,
      });
    }
    if (scenario?.type === 'retryable-error') {
      throw new FeedProviderError(scenario.message ?? 'Simulated retryable provider error', {
        providerName: this.name, code: 'MOCK_RETRYABLE_ERROR', retryable: true,
      });
    }
    if (scenario?.type === 'timeout') await this.#simulateTimeout(scenario, timeoutMs, signal);

    let posts = scenario?.type === 'empty' ? [] : [...this.published, ...this.fixtures]
      .filter((post) => normalizeUsername(post.sourceUsername) === username)
      .map((post) => ({ ...post, retrievedAt: this.clock() }))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    if (scenario?.type === 'duplicate' && posts.length) posts = [posts[0], posts[0], ...posts.slice(1)];
    posts = posts.slice(0, limit).map((post) => normalizeFeedPost(post, this.name));
    return { providerName: this.name, posts, fetchedAt: this.clock() };
  }

  /** Add a simulated new post; returns its normalized post with a deterministic ID. */
  publish(username, draft) {
    const cleanUsername = String(username ?? '').trim().replace(/^@/, '');
    if (!cleanUsername) throw new TypeError('username is required');
    if (!draft || typeof draft !== 'object' || typeof draft.text !== 'string') {
      throw new TypeError('draft must be an object with string text');
    }
    this.sequence += 1;
    const safeName = normalizeUsername(cleanUsername).replace(/[^a-z0-9_-]/g, '-') || 'account';
    const id = draft.providerPostId ?? `mock-new-${safeName}-${String(this.sequence).padStart(4, '0')}`;
    const now = this.clock();
    const post = normalizeFeedPost({
      providerName: this.name,
      providerPostId: id,
      canonicalPostId: draft.canonicalPostId ?? null,
      sourceAccountId: draft.sourceAccountId ?? `mock-account-${safeName}`,
      sourceUsername: cleanUsername,
      author: { username: cleanUsername, ...(draft.displayName ? { displayName: draft.displayName } : {}) },
      text: draft.text,
      postUrl: draft.postUrl ?? `https://example.invalid/${encodeURIComponent(cleanUsername)}/status/${encodeURIComponent(id)}`,
      providerUrl: null,
      publishedAt: draft.publishedAt ?? now,
      retrievedAt: now,
      raw: { simulated: true },
    }, this.name);
    this.published.unshift(post);
    return post;
  }

  /** Configure `empty`, `duplicate`, `timeout`, `retryable-error`, or `permanent-error`. */
  setScenario(username, type, options = {}) {
    const key = normalizeUsername(username);
    const valid = ['empty', 'duplicate', 'timeout', 'retryable-error', 'permanent-error'];
    if (!key) throw new TypeError('username is required');
    if (!valid.includes(type)) throw new TypeError(`scenario must be one of: ${valid.join(', ')}`);
    if (type === 'timeout' && options.delayMs != null && (!Number.isFinite(options.delayMs) || options.delayMs < 0)) {
      throw new TypeError('timeout delayMs must be a non-negative number');
    }
    this.scenarios.set(key, { type, ...options });
  }

  clearScenario(username) { this.scenarios.delete(normalizeUsername(username)); }

  reset() {
    this.published = [];
    this.scenarios.clear();
    this.sequence = 0;
  }

  async #simulateTimeout(scenario, timeoutMs, signal) {
    const delayMs = Math.min(scenario.delayMs ?? timeoutMs, timeoutMs);
    let timer;
    let abort;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(resolve, delayMs);
        abort = () => {
          clearTimeout(timer);
          reject(new FeedProviderError('Mock feed request was aborted', {
            providerName: this.name, code: 'PROVIDER_ABORTED', retryable: true,
          }));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
    throw new ProviderTimeoutError(this.name, timeoutMs);
  }
}
