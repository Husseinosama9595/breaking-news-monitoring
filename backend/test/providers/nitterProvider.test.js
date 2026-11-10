import test from 'node:test';
import assert from 'node:assert/strict';
import { NitterProvider, parseNitterFeed } from '../../src/providers/nitterProvider.js';
import { createPostDedupeKey } from '../../src/services/postIngestionService.js';

const now = new Date('2026-11-09T21:00:00.000Z');
const firstInstance = 'https://nitter-one.example';
const secondInstance = 'https://nitter-two.example';

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Test feed</title>${items}</channel></rss>`;
const item = ({ id = '1999999999999999999', text = 'A headline', date = 'Mon, 09 Nov 2026 20:59:00 GMT', link = `https://x.com/Reuters/status/${id}`, extra = '' } = {}) => `<item><title>Reuters</title><link>${link}</link>${id ? `<guid isPermaLink="false">${id}</guid>` : ''}${date ? `<pubDate>${date}</pubDate>` : ''}<dc:creator>Reuters</dc:creator><description><![CDATA[${text}]]></description>${extra}</item>`;
const response = (status, body, contentType = 'application/rss+xml') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
  async text() { return body; },
});

test('parses multiple RSS posts and maps original X IDs, links, authors and timestamps', () => {
  const batch = parseNitterFeed(rss(`${item()}${item({ id: '1888888888888888888', text: 'Second post' })}`), {
    username: '@Reuters', instanceUrl: firstInstance, retrievedAt: now,
  });
  assert.equal(batch.providerName, 'nitter');
  assert.equal(batch.posts.length, 2);
  assert.equal(batch.posts[0].providerPostId, '1999999999999999999');
  assert.equal(batch.posts[0].canonicalPostId, '1999999999999999999');
  assert.equal(batch.posts[0].postUrl, 'https://x.com/Reuters/status/1999999999999999999');
  assert.equal(batch.posts[0].sourceUsername, 'Reuters');
  assert.equal(batch.posts[0].author.username, 'Reuters');
  assert.equal(batch.posts[0].publishedAt.toISOString(), '2026-11-09T20:59:00.000Z');
  assert.equal(batch.posts[1].text, 'Second post');
});

test('creates a deterministic fallback ID and preserves missing publication time as null', () => {
  const xml = rss('<item><title>Reuters</title><description>Post without an ID or timestamp</description></item>');
  const first = parseNitterFeed(xml, { username: 'Reuters', instanceUrl: firstInstance, retrievedAt: now });
  const second = parseNitterFeed(xml, { username: 'Reuters', instanceUrl: secondInstance, retrievedAt: now });
  assert.equal(first.posts.length, 1);
  assert.match(first.posts[0].providerPostId, /^nitter-[a-f0-9]{32}$/);
  assert.equal(first.posts[0].providerPostId, second.posts[0].providerPostId);
  assert.equal(first.posts[0].canonicalPostId, null);
  assert.equal(first.posts[0].publishedAt, null);
  assert.equal(first.posts[0].postUrl, null);
});

test('decodes HTML entities and removes embedded markup from post text', () => {
  const batch = parseNitterFeed(rss(item({ text: 'Alert &amp; update &mdash; &lt;b&gt;confirmed&lt;/b&gt; &#39;now&#39;' })), {
    username: 'Reuters', instanceUrl: firstInstance, retrievedAt: now,
  });
  assert.equal(batch.posts[0].text, "Alert & update — confirmed 'now'");
});

test('rejects malformed XML and skips incomplete entries without identity or text', () => {
  assert.throws(() => parseNitterFeed('<rss><channel><item></channel></rss>', {
    username: 'Reuters', instanceUrl: firstInstance, retrievedAt: now,
  }), { code: 'NITTER_INVALID_XML', retryable: true });
  const batch = parseNitterFeed(rss('<item><description></description></item>'), {
    username: 'Reuters', instanceUrl: firstInstance, retrievedAt: now,
  });
  assert.equal(batch.posts.length, 0);
});

test('falls back after primary HTTP failure and tracks instance health', async () => {
  const calls = [];
  const provider = new NitterProvider({ instances: [firstInstance, secondInstance], clock: () => new Date(now), fetchImpl: async (url) => {
    calls.push(new URL(url).origin);
    return new URL(url).origin === firstInstance ? response(503, 'unavailable') : response(200, rss(item()));
  } });
  const batch = await provider.fetchRecentPosts({ username: 'Reuters', platform: 'x' });
  assert.equal(batch.posts.length, 1);
  assert.deepEqual(calls, [firstInstance, secondInstance]);
  const [primary, secondary] = provider.getInstanceHealth();
  assert.equal(primary.lastStatusCode, 503);
  assert.equal(primary.consecutiveFailures, 1);
  assert.equal(secondary.lastStatusCode, 200);
  assert.equal(secondary.consecutiveFailures, 0);
});

test('marks all-instance HTTP failures retryable and never permanently fails an account', async () => {
  const provider = new NitterProvider({ instances: [firstInstance, secondInstance], fetchImpl: async () => response(404, 'missing') });
  await assert.rejects(provider.fetchRecentPosts({ username: 'Reuters' }), (error) => {
    assert.equal(error.code, 'NITTER_ALL_INSTANCES_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual(provider.getInstanceHealth().map((state) => state.consecutiveFailures), [1, 1]);
});

test('times out a failed primary, falls back, and avoids retrying the primary during cooldown', async () => {
  let nowMs = now.getTime();
  let primaryAvailable = false;
  const calls = [];
  const provider = new NitterProvider({
    instances: [firstInstance, secondInstance], instanceTimeoutMs: 100, cooldownMs: 1000,
    clock: () => new Date(nowMs),
    fetchImpl: async (url, options) => {
      const host = new URL(url).origin;
      calls.push(host);
      if (host === firstInstance && !primaryAvailable) return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      return response(200, rss(item()));
    },
  });
  await provider.fetchRecentPosts({ username: 'Reuters' }, { timeoutMs: 1000 });
  assert.deepEqual(calls, [firstInstance, secondInstance]);
  calls.length = 0;
  await provider.fetchRecentPosts({ username: 'Reuters' }, { timeoutMs: 1000 });
  assert.deepEqual(calls, [secondInstance]);

  nowMs += 1001;
  primaryAvailable = true;
  calls.length = 0;
  await provider.fetchRecentPosts({ username: 'Reuters' }, { timeoutMs: 1000 });
  assert.deepEqual(calls, [firstInstance]);
  assert.equal(provider.getInstanceHealth()[0].consecutiveFailures, 0);
});

test('validates accounts, instance URLs and HTTP request errors', async () => {
  assert.throws(() => new NitterProvider({ instances: ['http://insecure.example'] }), /HTTPS/);
  const provider = new NitterProvider({ instances: [firstInstance], fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(provider.fetchRecentPosts({ username: 'bad username' }), { code: 'INVALID_ACCOUNT', retryable: false });
  await assert.rejects(provider.fetchRecentPosts({ username: 'Reuters' }), { code: 'NITTER_ALL_INSTANCES_FAILED', retryable: true });
});

test('canonical post IDs deduplicate equivalent posts returned by different instances', () => {
  const primary = parseNitterFeed(rss(item()), { username: 'Reuters', instanceUrl: firstInstance, retrievedAt: now }).posts[0];
  const fallback = parseNitterFeed(rss(item()), { username: 'Reuters', instanceUrl: secondInstance, retrievedAt: now }).posts[0];
  assert.equal(createPostDedupeKey(primary), createPostDedupeKey(fallback));
  assert.equal(createPostDedupeKey(primary), 'x:1999999999999999999');
});

test('preserves mock provider registration semantics in the test registry', async () => {
  const { MockNewsProvider } = await import('../../src/providers/mockNewsProvider.js');
  const { ProviderRegistry } = await import('../../src/providers/providerRegistry.js');
  const registry = new ProviderRegistry();
  const mock = new MockNewsProvider();
  registry.register(mock, { defaultProvider: true });
  registry.register(new NitterProvider({ instances: [] }));
  assert.equal(registry.getDefault(), mock);
  assert.deepEqual(registry.list(), ['mock', 'nitter']);
});
