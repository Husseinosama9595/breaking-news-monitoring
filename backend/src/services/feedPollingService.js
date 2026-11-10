import MonitoredAccount from '../models/MonitoredAccount.js';
import { env } from '../config/environment.js';
import { fetchProviderBatch } from '../providers/feedProvider.js';
import { FeedProviderError, ProviderTimeoutError } from '../providers/providerErrors.js';
import providerRegistry from '../providers/providerRegistry.js';
import { ingestProviderBatch } from './postIngestionService.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Summarize feed freshness without treating empty or undated feeds as fresh. */
export function summarizeFeedFreshness(posts, observedAt, maxAgeMs = env.feedFreshnessMaxAgeMs) {
  if (!Array.isArray(posts)) throw new TypeError('posts must be an array');
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) throw new TypeError('observedAt must be a valid Date');
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000) throw new TypeError('maxAgeMs must be an integer of at least 1000 ms');

  const timestamped = posts
    .map((post) => post?.publishedAt)
    .filter((value) => value instanceof Date && !Number.isNaN(value.getTime()));
  const latestPublishedAt = timestamped.reduce(
    (latest, value) => !latest || value > latest ? value : latest,
    null,
  );

  let freshnessStatus = 'unknown';
  if (posts.length === 0) freshnessStatus = 'empty';
  else if (latestPublishedAt) {
    const ageMs = observedAt.getTime() - latestPublishedAt.getTime();
    if (ageMs >= 0) freshnessStatus = ageMs <= maxAgeMs ? 'fresh' : 'stale';
  }

  return {
    latestPublishedAt,
    timestampedEntryCount: timestamped.length,
    untimestampedEntryCount: posts.length - timestamped.length,
    freshnessStatus,
  };
}

/** Poll active monitored accounts and persist each normalized batch to MongoDB. */
export class FeedPollingService {
  /**
   * @param {{ registry?: import('../providers/providerRegistry.js').ProviderRegistry, accountModel?: typeof MonitoredAccount, ingest?: typeof ingestProviderBatch, intervalMs?: number, timeoutMs?: number, concurrency?: number, jitterMs?: number, providerNameMode?: 'account'|'mock'|'nitter', logger?: Pick<Console, 'info'|'warn'|'error'>, clock?: () => Date, random?: () => number, wait?: (milliseconds: number) => Promise<void> }} [options]
   */
  constructor({
    registry = providerRegistry,
    accountModel = MonitoredAccount,
    ingest = ingestProviderBatch,
    intervalMs = env.feedPollIntervalMs,
    timeoutMs = env.feedPollTimeoutMs,
    concurrency = env.feedPollConcurrency,
    jitterMs = env.feedPollJitterMs,
    freshnessMaxAgeMs = env.feedFreshnessMaxAgeMs,
    providerNameMode = env.feedProvider,
    logger = console,
    clock = () => new Date(),
    random = Math.random,
    wait = delay,
  } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new TypeError('intervalMs must be an integer of at least 1000 ms');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw new TypeError('timeoutMs must be an integer of at least 100 ms');
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
    if (!Number.isInteger(jitterMs) || jitterMs < 0) throw new TypeError('jitterMs must be a non-negative integer');
    if (typeof random !== 'function' || typeof wait !== 'function') throw new TypeError('random and wait must be functions');
    if (!Number.isInteger(freshnessMaxAgeMs) || freshnessMaxAgeMs < 1000) throw new TypeError('freshnessMaxAgeMs must be an integer of at least 1000 ms');
    this.registry = registry;
    this.accountModel = accountModel;
    this.ingest = ingest;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.concurrency = concurrency;
    this.jitterMs = jitterMs;
    this.freshnessMaxAgeMs = freshnessMaxAgeMs;
    this.providerNameMode = providerNameMode;
    this.logger = logger;
    this.clock = clock;
    this.random = random;
    this.wait = wait;
    this.timer = null;
    this.inFlightAccounts = new Map();
    this.activeCycle = null;
    this.stopping = false;
  }

  /** Start immediate polling and a recurring interval. Safe to call more than once. */
  start() {
    if (this.timer) return false;
    this.stopping = false;
    this.logger.info?.(`Feed polling started (interval ${this.intervalMs} ms; timeout ${this.timeoutMs} ms; concurrency ${this.concurrency}; jitter ${this.jitterMs} ms).`);
    this.timer = setInterval(() => this.#startCycle(), this.intervalMs);
    this.timer.unref?.();
    this.#startCycle();
    return true;
  }

  /** Stop scheduling and wait for current provider/persistence operations to settle. */
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([this.activeCycle, ...this.inFlightAccounts.values()].filter(Boolean));
    this.logger.info?.('Feed polling stopped.');
  }

  /** One poll cycle, exposed for deterministic local tests and future operator tooling. */
  async pollOnce() {
    if (this.stopping) return { status: 'stopped', accountCount: 0, results: [] };
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.#pollAccountsOnce();
    this.activeCycle = cycle;
    try {
      return await cycle;
    } finally {
      if (this.activeCycle === cycle) this.activeCycle = null;
    }
  }

  async #pollAccountsOnce() {
    let accounts;
    try {
      accounts = await this.accountModel.find({
        platform: 'x', enabled: true, monitoringStatus: 'active',
      }).lean();
    } catch (error) {
      this.logger.error?.('Could not retrieve monitored accounts for polling:', error.message);
      return { status: 'failed', code: 'ACCOUNT_QUERY_FAILED', accountCount: 0, results: [] };
    }

    const results = new Array(accounts.length);
    let nextAccountIndex = 0;
    const workerCount = Math.min(this.concurrency, accounts.length);
    const pollWorker = async () => {
      while (nextAccountIndex < accounts.length && !this.stopping) {
        const index = nextAccountIndex++;
        const account = accounts[index];
        if (this.jitterMs > 0) {
          let randomValue = 0;
          try {
            randomValue = Number(this.random());
          } catch (error) {
            this.logger.warn?.('Polling jitter source failed; continuing without delay:', error.message);
          }
          if (!Number.isFinite(randomValue)) randomValue = 0;
          const jitter = Math.floor(Math.min(1, Math.max(0, randomValue)) * this.jitterMs);
          try {
            if (jitter > 0) await this.wait(jitter);
          } catch (error) {
            this.logger.warn?.('Polling jitter wait failed; continuing without delay:', error.message);
          }
        }
        if (this.stopping) {
          results[index] = { status: 'stopped', accountId: String(account?._id ?? '') };
          continue;
        }
        try {
          results[index] = await this.pollAccount(account);
        } catch (error) {
          // Keep unexpected failures local to this account and continue draining the list.
          this.logger.error?.(`Unexpected polling failure for ${account?.username ?? 'unknown account'}:`, error.message);
          results[index] = { status: 'failed', accountId: String(account?._id ?? ''), code: 'POLL_UNEXPECTED_FAILURE' };
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => pollWorker()));
    for (let index = 0; index < accounts.length; index += 1) {
      if (!results[index]) results[index] = { status: 'stopped', accountId: String(accounts[index]?._id ?? '') };
    }
    return {
      status: this.stopping
        ? 'stopped'
        : results.some((result) => result.status === 'failed') ? 'partial' : 'success',
      accountCount: accounts.length,
      results,
    };
  }

  /** Poll one account; concurrent calls for that account return `skipped-overlap`. */
  async pollAccount(account) {
    if (!account?._id) return { status: 'failed', code: 'INVALID_ACCOUNT', accountId: null };
    const accountKey = String(account?._id ?? `${account?.platform ?? 'x'}:${account?.normalizedUsername ?? account?.username ?? ''}`);
    if (this.inFlightAccounts.has(accountKey)) {
      return { status: 'skipped-overlap', accountId: accountKey };
    }

    const operation = this.#pollAccount(account, accountKey);
    this.inFlightAccounts.set(accountKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlightAccounts.get(accountKey) === operation) this.inFlightAccounts.delete(accountKey);
    }
  }

  async #pollAccount(account, accountKey) {
    const startedAt = this.clock();
    const providerName = this.providerNameMode === 'account'
      ? (account.providerName || this.registry.getDefaultName())
      : this.providerNameMode;
    const provider = this.registry.get(providerName);
    let batch = null;
    let feedObservedAt = null;
    let freshness = null;
    let ingestion = null;
    try {
      await this.accountModel.updateOne({ _id: account._id }, { $set: { lastPollAttemptAt: startedAt } });
      if (!provider) {
        throw new FeedProviderError(`No feed provider registered as "${providerName}"`, {
          providerName: String(providerName ?? 'unknown'), code: 'PROVIDER_NOT_REGISTERED', retryable: false,
        });
      }

      batch = await this.#fetchWithTimeout(provider, {
        username: account.username,
        displayName: account.displayName ?? undefined,
        platform: account.platform,
        providerAccountId: account.providerAccountId ?? undefined,
      });
      feedObservedAt = this.clock();
      freshness = summarizeFeedFreshness(batch.posts, feedObservedAt, this.freshnessMaxAgeMs);
      ingestion = await this.ingest({
        account: {
          _id: account._id,
          username: account.username,
          displayName: account.displayName ?? undefined,
          category: account.category,
          platform: account.platform,
          providerAccountId: account.providerAccountId ?? undefined,
        },
        batch,
        receivedAt: feedObservedAt,
      });
      const completedAt = this.clock();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      // Clearing stale error metadata is operational only; a failure here must not
      // turn an already-persisted batch into a failed poll or undo its checkpoint.
      await this.accountModel.updateOne({ _id: account._id }, { $set: {
        lastPollCompletedAt: completedAt,
        lastPollDurationMs: durationMs,
        lastPollStatus: 'success',
        lastPollErrorCode: null,
        lastPollEntryCount: batch.posts.length,
        lastPollInsertedCount: ingestion.insertedCount,
        lastPollDuplicateCount: ingestion.duplicateCount,
        lastProviderFeedObservedAt: feedObservedAt,
        lastProviderFeedLatestPublishedAt: freshness.latestPublishedAt,
        lastProviderFeedTimestampedEntryCount: freshness.timestampedEntryCount,
        lastProviderFeedUntimestampedEntryCount: freshness.untimestampedEntryCount,
        lastProviderFeedFreshnessStatus: freshness.freshnessStatus,
        lastError: null,
        lastPollErrorAt: null,
        providerName,
      } })
        .catch((error) => this.logger.warn?.('Could not persist polling health metadata:', error.message));
      return {
        status: 'success', accountId: accountKey, providerName, ...ingestion,
        pollHealth: {
          startedAt, completedAt, durationMs, status: 'success', errorCode: null,
          entryCount: batch.posts.length, insertedCount: ingestion.insertedCount,
          duplicateCount: ingestion.duplicateCount, ...freshness,
        },
      };
    } catch (error) {
      const failure = error instanceof FeedProviderError
        ? error
        : new FeedProviderError('Feed polling or persistence failed', {
          providerName: String(providerName ?? 'unknown'), code: 'POLL_FAILED', retryable: true, cause: error,
        });
      const completedAt = this.clock();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      const errorCode = failure.code ?? 'POLL_FAILED';
      const fields = {
        lastPollCompletedAt: completedAt,
        lastPollDurationMs: durationMs,
        lastPollStatus: 'failed',
        lastPollErrorCode: errorCode,
        lastPollEntryCount: batch?.posts.length ?? null,
        lastPollInsertedCount: ingestion?.insertedCount ?? null,
        lastPollDuplicateCount: ingestion?.duplicateCount ?? null,
        lastError: failure.message.slice(0, 1000),
        lastPollErrorAt: completedAt,
      };
      if (batch && feedObservedAt && freshness) {
        Object.assign(fields, {
          lastProviderFeedObservedAt: feedObservedAt,
          lastProviderFeedLatestPublishedAt: freshness.latestPublishedAt,
          lastProviderFeedTimestampedEntryCount: freshness.timestampedEntryCount,
          lastProviderFeedUntimestampedEntryCount: freshness.untimestampedEntryCount,
          lastProviderFeedFreshnessStatus: freshness.freshnessStatus,
        });
      }
      await this.accountModel.updateOne({ _id: account._id }, { $set: fields })
        .catch((updateError) => this.logger.error?.('Could not persist polling error metadata:', updateError.message));
      this.logger.warn?.(`Feed poll failed for ${account.username}: ${failure.code} (${failure.retryable ? 'retryable' : 'permanent'}).`);
      return {
        status: 'failed', accountId: accountKey, providerName,
        code: failure.code, retryable: failure.retryable,
        pollHealth: {
          startedAt, completedAt, durationMs, status: 'failed', errorCode,
          entryCount: batch?.posts.length ?? null,
          insertedCount: ingestion?.insertedCount ?? null,
          duplicateCount: ingestion?.duplicateCount ?? null,
          ...(freshness ?? {}),
        },
      };
    }
  }

  async #fetchWithTimeout(provider, account) {
    const controller = new AbortController();
    let timer;
    const request = fetchProviderBatch(provider, account, { timeoutMs: this.timeoutMs, signal: controller.signal });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderTimeoutError(provider.name, this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #startCycle() {
    if (this.stopping || this.activeCycle) return;
    void this.pollOnce().catch((error) => {
      this.logger.error?.('Feed polling cycle failed:', error.message);
    });
  }
}

export const feedPollingService = new FeedPollingService();
export default feedPollingService;
