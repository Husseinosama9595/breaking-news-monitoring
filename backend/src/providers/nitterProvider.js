import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { normalizeFeedPost } from './normalizedPost.js';
import { FeedProviderError } from './providerErrors.js';

const DEFAULT_INSTANCE_TIMEOUT_MS = 4000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  removeNSPrefix: true,
});

const normalizedUsername = (value) => String(value ?? '').trim().replace(/^@/, '');
const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

function providerError(code, message, retryable = true, cause) {
  return new FeedProviderError(message, { providerName: 'nitter', code, retryable, cause });
}

function textValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return textValue(value[0]);
  if (typeof value === 'object') {
    if (value['#text'] != null) return textValue(value['#text']);
    if (value.__cdata != null) return textValue(value.__cdata);
    return '';
  }
  return String(value).trim();
}

function htmlToText(value) {
  return textValue(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“')
    .replace(/&copy;/gi, '©')
    .replace(/&trade;/gi, '™')
    .replace(/<\/(?:p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function entriesFromXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw providerError('NITTER_EMPTY_RESPONSE', 'Nitter returned an empty RSS response');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw providerError('NITTER_UNSAFE_XML', 'Nitter RSS contains a prohibited document type declaration');
  if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) throw providerError('NITTER_FEED_TOO_LARGE', 'Nitter RSS response exceeded the 2 MB limit');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw providerError('NITTER_INVALID_XML', 'Nitter returned malformed RSS XML', true);

  let document;
  try { document = parser.parse(xml); } catch (cause) {
    throw providerError('NITTER_INVALID_XML', 'Nitter RSS could not be parsed', true, cause);
  }
  const root = document.rss?.channel ?? document.feed ?? document.RDF;
  if (!root || typeof root !== 'object') throw providerError('NITTER_INVALID_FEED', 'Nitter response is not an RSS or Atom feed');
  const entries = root.item ?? root.entry ?? [];
  return Array.isArray(entries) ? entries : [entries];
}

function linkFromEntry(entry) {
  const linkValue = entry.link ?? entry.id ?? null;
  if (Array.isArray(linkValue)) {
    const preferred = linkValue.find((item) => item?.['@_rel'] === 'alternate') ?? linkValue[0];
    return textValue(preferred?.['@_href'] ?? preferred);
  }
  if (linkValue && typeof linkValue === 'object') return textValue(linkValue['@_href'] ?? linkValue['#text']);
  return textValue(linkValue);
}

function canonicalStatusId(value) {
  const match = String(value ?? '').match(/(?:^|\/)status(?:es)?\/(\d+)(?:[/?#]|$)/i);
  return match?.[1] ?? null;
}

function originalXPostUrl(entry, username, link, baseUrl) {
  const guid = textValue(entry.guid ?? entry.id);
  const id = canonicalStatusId(link) ?? canonicalStatusId(guid);
  if (id) return { postId: id, postUrl: `https://x.com/${encodeURIComponent(username)}/status/${id}` };

  if (!link) return { postId: null, postUrl: null };
  try {
    const url = new URL(link, `${baseUrl}/`);
    if (!['http:', 'https:'].includes(url.protocol) || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
      return { postId: null, postUrl: null };
    }
    if (url.hostname.toLowerCase().endsWith('twitter.com')) url.hostname = 'x.com';
    return { postId: null, postUrl: url.toString() };
  } catch {
    return { postId: null, postUrl: null };
  }
}

function publishedDate(entry) {
  const rawDate = textValue(entry.pubDate ?? entry.published ?? entry.updated ?? entry.date);
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  return isDate(parsed) ? parsed : null;
}

function stableFallbackId({ username, link, publishedAt, text, guid }) {
  const identity = [username.toLowerCase(), link, publishedAt?.toISOString() ?? '', text, guid].join('\n');
  return `nitter-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

/** Parse an RSS/Atom document into the application's normalized feed batch. */
export function parseNitterFeed(xml, { username, instanceUrl, retrievedAt = new Date(), limit = 50 } = {}) {
  const cleanUsername = normalizedUsername(username);
  if (!cleanUsername) throw providerError('INVALID_ACCOUNT', 'An X username is required', false);
  if (!isDate(retrievedAt)) throw providerError('INVALID_OPTIONS', 'retrievedAt must be a valid Date', false);
  const entries = entriesFromXml(xml);
  const posts = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const link = linkFromEntry(entry);
    const guid = textValue(entry.guid ?? entry.id);
    const { postId: linkedPostId, postUrl } = originalXPostUrl(entry, cleanUsername, link, instanceUrl);
    const text = htmlToText(entry.description ?? entry.encoded ?? entry.content ?? entry.summary ?? entry.title);
    const publishedAt = publishedDate(entry);
    if (!text && !postUrl && !guid) continue;

    const authorName = htmlToText(entry.creator ?? entry.author?.name ?? entry.author) || cleanUsername;
    const canonicalId = linkedPostId ?? canonicalStatusId(guid) ?? (guid && /^\d{5,}$/.test(guid) ? guid : null);
    const providerPostId = canonicalId
      ?? stableFallbackId({ username: cleanUsername, link, publishedAt, text, guid });
    const safePostUrl = postUrl ?? (canonicalId ? `https://x.com/${encodeURIComponent(cleanUsername)}/status/${canonicalId}` : null);

    posts.push(normalizeFeedPost({
      providerName: 'nitter',
      providerPostId,
      canonicalPostId: canonicalId,
      sourceAccountId: null,
      sourceUsername: cleanUsername,
      author: { username: authorName, displayName: authorName },
      text,
      postUrl: safePostUrl,
      providerUrl: instanceUrl,
      publishedAt,
      retrievedAt,
      raw: { guid: guid || null, instanceUrl },
    }, 'nitter'));
    if (posts.length >= limit) break;
  }

  return { providerName: 'nitter', posts, fetchedAt: retrievedAt };
}

function normalizeInstance(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Nitter instances must be non-empty URLs');
  let url;
  try { url = new URL(value.trim()); } catch { throw new TypeError('Nitter instances must be valid HTTPS URLs'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Nitter instances must be HTTPS base URLs without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

/** RSS feed provider for public Nitter-compatible instances. */
export class NitterProvider {
  /**
   * @param {{ instances?: string[], instanceTimeoutMs?: number, cooldownMs?: number, fetchImpl?: typeof fetch, clock?: () => Date }} [options]
   */
  constructor({
    instances = ['https://xitter.cf', 'https://nitter.gq'],
    instanceTimeoutMs = DEFAULT_INSTANCE_TIMEOUT_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    if (!Array.isArray(instances)) throw new TypeError('instances must be an array');
    if (!Number.isInteger(instanceTimeoutMs) || instanceTimeoutMs < 100) throw new TypeError('instanceTimeoutMs must be at least 100 ms');
    if (!Number.isInteger(cooldownMs) || cooldownMs < 0) throw new TypeError('cooldownMs must be a non-negative integer');
    if (typeof fetchImpl !== 'function' || typeof clock !== 'function') throw new TypeError('fetchImpl and clock must be functions');
    this.name = 'nitter';
    this.instances = [...new Set(instances.map(normalizeInstance))];
    this.instanceTimeoutMs = instanceTimeoutMs;
    this.cooldownMs = cooldownMs;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.health = new Map(this.instances.map((instance) => [instance, {
      consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
      cooldownUntil: null, lastStatusCode: null, lastErrorCode: null,
    }]));
  }

  getInstanceHealth() {
    return this.instances.map((instance) => ({ instance, ...this.health.get(instance) }));
  }

  async fetchRecentPosts(account, { limit = 50, timeoutMs = 10_000, signal } = {}) {
    const username = normalizedUsername(account?.username);
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw providerError('INVALID_ACCOUNT', 'A valid X username is required', false);
    if (account?.platform && String(account.platform).toLowerCase() !== 'x') throw providerError('UNSUPPORTED_PLATFORM', 'NitterProvider only supports X accounts', false);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw providerError('INVALID_OPTIONS', 'limit must be an integer from 1 to 500', false);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw providerError('INVALID_OPTIONS', 'timeoutMs must be at least 100 ms', false);
    if (!this.instances.length) throw providerError('NITTER_NO_INSTANCES', 'No Nitter instances are configured', false);
    if (signal?.aborted) throw providerError('PROVIDER_ABORTED', 'Nitter request was aborted', true);

    const startedAt = this.clock().getTime();
    const deadline = startedAt + timeoutMs;
    const now = startedAt;
    const candidates = this.instances.filter((instance) => {
      const cooldownUntil = this.health.get(instance).cooldownUntil;
      return !cooldownUntil || cooldownUntil.getTime() <= now;
    });
    if (!candidates.length) throw providerError('NITTER_INSTANCES_COOLING_DOWN', 'All configured Nitter instances are temporarily cooling down', true);

    const failures = [];
    for (const instance of candidates) {
      if (signal?.aborted) throw providerError('PROVIDER_ABORTED', 'Nitter request was aborted', true);
      const remainingMs = deadline - this.clock().getTime();
      if (remainingMs < 100) break;
      const requestTimeoutMs = Math.max(100, Math.min(this.instanceTimeoutMs, remainingMs));
      try {
        const batch = await this.#fetchInstance(instance, username, { limit, timeoutMs: requestTimeoutMs, signal });
        this.#markSuccess(instance);
        return batch;
      } catch (error) {
        if (signal?.aborted) throw providerError('PROVIDER_ABORTED', 'Nitter request was aborted', true, error);
        const failure = error instanceof FeedProviderError
          ? error
          : providerError('NITTER_REQUEST_FAILED', 'Nitter instance request failed', true, error);
        this.#markFailure(instance, failure);
        failures.push(failure);
      }
    }

    throw providerError(
      failures.some((error) => error.code === 'PROVIDER_TIMEOUT') ? 'PROVIDER_TIMEOUT' : 'NITTER_ALL_INSTANCES_FAILED',
      `Could not retrieve the @${username} feed from ${failures.length} available Nitter instance(s)`,
      true,
      failures.at(-1),
    );
  }

  async #fetchInstance(instance, username, { limit, timeoutMs, signal }) {
    const url = new URL(`${encodeURIComponent(username)}/rss`, `${instance}/`).toString();
    this.health.get(instance).lastStatusCode = null;
    const controller = new AbortController();
    let timer;
    let parentAbort;
    if (signal) {
      parentAbort = () => controller.abort();
      signal.addEventListener('abort', parentAbort, { once: true });
    }
    const requestTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(providerError('PROVIDER_TIMEOUT', `Nitter instance exceeded its ${timeoutMs} ms timeout`, true));
      }, timeoutMs);
    });

    try {
      const request = (async () => {
        let response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
            signal: controller.signal,
          });
        } catch (cause) {
          if (controller.signal.aborted) throw providerError('PROVIDER_TIMEOUT', 'Nitter instance request timed out', true, cause);
          throw providerError('NITTER_NETWORK_ERROR', 'Nitter instance could not be reached', true, cause);
        }
        const state = this.health.get(instance);
        state.lastStatusCode = response.status;
        if (!response.ok) throw providerError(`NITTER_HTTP_${response.status}`, `Nitter instance returned HTTP ${response.status}`, true);

        let xml;
        try { xml = await response.text(); } catch (cause) {
          throw providerError('NITTER_RESPONSE_READ_FAILED', 'Nitter response body could not be read', true, cause);
        }
        const retrievedAt = this.clock();
        const batch = parseNitterFeed(xml, { username, instanceUrl: instance, retrievedAt, limit });
        for (const post of batch.posts) post.raw = { ...post.raw, instanceUrl: instance };
        return batch;
      })();
      return await Promise.race([request, requestTimeout]);
    } finally {
      clearTimeout(timer);
      if (parentAbort) signal.removeEventListener('abort', parentAbort);
    }
  }

  #markSuccess(instance) {
    const state = this.health.get(instance);
    state.consecutiveFailures = 0;
    state.lastSuccessAt = this.clock();
    state.cooldownUntil = null;
    state.lastErrorCode = null;
  }

  #markFailure(instance, error) {
    const state = this.health.get(instance);
    state.consecutiveFailures += 1;
    state.lastFailureAt = this.clock();
    state.cooldownUntil = new Date(this.clock().getTime() + this.cooldownMs);
    state.lastErrorCode = error.code ?? 'NITTER_REQUEST_FAILED';
  }
}

export default NitterProvider;
