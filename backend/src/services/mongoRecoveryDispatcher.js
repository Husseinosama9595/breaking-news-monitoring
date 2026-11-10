import { env } from '../config/environment.js';
import Post from '../models/Post.js';
import MonitoredAccount from '../models/MonitoredAccount.js';
import {
  FAILED_JOB_CLEANUP_LIMIT,
  FAILED_JOB_RETENTION_AGE_MS,
  getNotificationQueue,
} from '../queues/notificationQueue.js';
import { notificationJobId, postJobId } from '../queues/jobIds.js';
import { redisStatus } from '../config/redis.js';
import { telegramNotificationService } from './telegramNotificationService.js';

export { postJobId } from '../queues/jobIds.js';

const ACTIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'prioritized']);

/** Reconstruct process and notification jobs from MongoDB's durable states. */
export class MongoRecoveryDispatcher {
  /**
    * @param {{ postModel?: typeof Post, accountModel?: typeof MonitoredAccount, providerNameMode?: 'account'|'mock'|'nitter', queueProvider?: () => import('bullmq').Queue|null, redisReady?: () => boolean, notificationsEnabled?: () => boolean, intervalMs?: number, staleAfterMs?: number, batchSize?: number, maxAttempts?: number, backoffMs?: number, notificationMaxAttempts?: number, notificationBackoffMs?: number, logger?: Pick<Console, 'info'|'warn'|'error'>, clock?: () => Date }} [options]
   */
  constructor({
    postModel = Post,
    accountModel = MonitoredAccount,
    providerNameMode = env.feedProvider,
    queueProvider = getNotificationQueue,
    redisReady = () => redisStatus().ready,
    notificationsEnabled = () => telegramNotificationService.isConfigured(),
    intervalMs = env.postRecoveryIntervalMs,
    staleAfterMs = env.postStaleAfterMs,
    batchSize = env.postRecoveryBatchSize,
    maxAttempts = env.postJobMaxAttempts,
    backoffMs = env.postJobBackoffMs,
    notificationMaxAttempts = env.telegramMaxAttempts,
    notificationBackoffMs = env.telegramBackoffMs,
    logger = console,
    clock = () => new Date(),
  } = {}) {
    for (const [name, value] of Object.entries({ intervalMs, staleAfterMs, batchSize, maxAttempts, backoffMs, notificationMaxAttempts, notificationBackoffMs })) {
      if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    this.postModel = postModel;
    this.accountModel = accountModel;
    this.providerNameMode = providerNameMode;
    this.queueProvider = queueProvider;
    this.redisReady = redisReady;
    this.notificationsEnabled = notificationsEnabled;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.backoffMs = backoffMs;
    this.notificationMaxAttempts = notificationMaxAttempts;
    this.notificationBackoffMs = notificationBackoffMs;
    this.logger = logger;
    this.clock = clock;
    this.timer = null;
    this.activeDispatch = null;
  }

  /** Start periodic recovery and run one pass immediately. */
  start() {
    if (this.timer) return false;
    this.timer = setInterval(() => { void this.#runSafely(); }, this.intervalMs);
    this.timer.unref?.();
    void this.#runSafely();
    this.logger.info?.(`MongoDB recovery dispatcher started (interval ${this.intervalMs} ms).`);
    return true;
  }

  /** Stop scheduling and wait for the active dispatch pass. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeDispatch) await this.activeDispatch.catch(() => {});
    this.logger.info?.('MongoDB recovery dispatcher stopped.');
  }

  /** Queue jobs only; MongoDB status is changed by the worker after operations run. */
  async dispatchOnce() {
    if (!this.redisReady()) return this.#emptyResult('redis-unavailable');
    let queue;
    try { queue = this.queueProvider(); } catch (error) {
      this.logger.warn?.('BullMQ queue is unavailable; MongoDB work remains pending:', error.message);
      return this.#emptyResult('redis-unavailable', 'QUEUE_UNAVAILABLE');
    }
    if (!queue) return this.#emptyResult('redis-unavailable');

    // Failed Redis jobs are diagnostic copies; MongoDB remains authoritative.
    // Clean only terminal failed jobs and retain a recent window for debugging.
    if (typeof queue.clean === 'function') {
      try {
        await queue.clean(FAILED_JOB_RETENTION_AGE_MS, FAILED_JOB_CLEANUP_LIMIT, 'failed');
      } catch (error) {
        this.logger.warn?.('Could not clean expired failed BullMQ jobs:', error.message);
      }
    }

    const now = this.clock();
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const totals = { status: 'success', scanned: 0, enqueued: 0, alreadyQueued: 0, failed: 0 };
    const baselineProviderFilter = this.providerNameMode === 'nitter'
      ? {}
      : this.providerNameMode === 'account'
        ? { providerName: 'nitter' }
        : null;
    const baselineAccounts = baselineProviderFilter
      ? await this.accountModel.find(baselineProviderFilter).select('_id notificationBaselineAt').lean()
      : [];
    const baselineAccountIds = baselineAccounts
      .filter((account) => !account.notificationBaselineAt)
      .map((account) => account._id);
    // Exclude Nitter posts with no trustworthy publication time or at/before
    // their account's baseline. This mirrors the worker's final send guard.
    const historicalPostExclusions = baselineAccounts
      .filter((account) => account.notificationBaselineAt)
      .map((account) => ({
        monitoredAccount: account._id,
        $or: [
          { publishedAt: null },
          { publishedAt: { $exists: false } },
          { publishedAt: { $lte: account.notificationBaselineAt } },
        ],
      }));
    const providerSafetyFilter = {
      ...(baselineAccountIds.length ? { monitoredAccount: { $nin: baselineAccountIds } } : {}),
      ...(historicalPostExclusions.length ? { $nor: historicalPostExclusions } : {}),
    };

    const processingQuery = {
      ...providerSafetyFilter,
      notificationStatus: 'pending',
      $or: [
        { processingStatus: 'pending', $or: [
          { processingNextAttemptAt: null },
          { processingNextAttemptAt: { $lte: now } },
        ] },
        { processingStatus: 'processing', processingStartedAt: { $lt: staleBefore } },
      ],
    };
    const processing = await this.#findEligible(processingQuery, totals);
    for (const post of processing) {
      if (post.processingStatus === 'processing') {
        const reset = await this.postModel.updateOne({
          _id: post._id,
          processingStatus: 'processing',
          processingStartedAt: { $lt: staleBefore },
        }, { $set: {
          processingStatus: 'pending',
          processingStartedAt: null,
          processingNextAttemptAt: null,
          processingError: 'Recovered stale processing state after worker interruption.',
          processingErrorCode: 'STALE_PROCESSING_RECOVERED',
        } }).catch((error) => { throw new Error(`Could not reset stale processing post: ${error.message}`); });
        if (!reset.modifiedCount) { totals.alreadyQueued += 1; continue; }
      }
      await this.#countEnqueue(totals, () => this.#ensureJob(queue, {
        id: postJobId(post._id), name: 'process-post', postId: post._id,
        attempts: this.maxAttempts, backoffMs: this.backoffMs,
      }), post._id);
    }

    if (this.notificationsEnabled()) {
      const notificationQuery = {
        ...providerSafetyFilter,
        processingStatus: 'processed',
        $or: [
          { notificationStatus: 'pending', $or: [
            { notificationNextAttemptAt: null },
            { notificationNextAttemptAt: { $lte: now } },
          ] },
          { notificationStatus: 'sending', notificationStartedAt: { $lt: staleBefore } },
        ],
      };
      const notifications = await this.#findEligible(notificationQuery, totals);
      for (const post of notifications) {
        if (post.notificationStatus === 'sending') {
          const reset = await this.postModel.updateOne({
            _id: post._id,
            processingStatus: 'processed',
            notificationStatus: 'sending',
            notificationStartedAt: { $lt: staleBefore },
          }, { $set: {
            notificationStatus: 'pending',
            notificationStartedAt: null,
            notificationNextAttemptAt: null,
            notificationError: 'Recovered stale notification state after worker interruption.',
            notificationErrorCode: 'STALE_NOTIFICATION_RECOVERED',
          } }).catch((error) => { throw new Error(`Could not reset stale notification post: ${error.message}`); });
          if (!reset.modifiedCount) { totals.alreadyQueued += 1; continue; }
        }
        await this.#countEnqueue(totals, () => this.#ensureJob(queue, {
          id: notificationJobId(post._id), name: 'send-notification', postId: post._id,
          attempts: this.notificationMaxAttempts, backoffMs: this.notificationBackoffMs,
        }), post._id);
      }
    }
    return totals;
  }

  #emptyResult(status, code) {
    return { status, ...(code ? { code } : {}), scanned: 0, enqueued: 0, alreadyQueued: 0, failed: 0 };
  }

  async #findEligible(query, totals) {
    try {
      const posts = await this.postModel.find(query).sort({ createdAt: 1 }).limit(this.batchSize).lean();
      totals.scanned += posts.length;
      return posts;
    } catch (error) {
      throw new Error(`MongoDB recovery query failed: ${error.message}`);
    }
  }

  async #countEnqueue(totals, operation, postId) {
    try {
      const result = await operation();
      totals[result] += 1;
    } catch (error) {
      totals.failed += 1;
      totals.status = 'partial';
      this.logger.warn?.(`Could not dispatch post ${postId}: ${error.message}`);
    }
  }

  async #ensureJob(queue, { id, name, postId, attempts, backoffMs }) {
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (ACTIVE_JOB_STATES.has(state)) return 'alreadyQueued';
      await existing.remove();
    }
    await queue.add(name, { postId: String(postId) }, {
      jobId: id,
      attempts,
      backoff: { type: 'exponential', delay: backoffMs },
    });
    return 'enqueued';
  }

  async #runSafely() {
    if (this.activeDispatch) return this.activeDispatch;
    this.activeDispatch = this.dispatchOnce()
      .catch((error) => {
        this.logger.error?.('MongoDB recovery dispatcher failed:', error.message);
        return { status: 'failed', code: 'RECOVERY_DISPATCH_FAILED', scanned: 0, enqueued: 0, alreadyQueued: 0, failed: 1 };
      })
      .finally(() => { this.activeDispatch = null; });
    return this.activeDispatch;
  }
}

export const mongoRecoveryDispatcher = new MongoRecoveryDispatcher();
export default mongoRecoveryDispatcher;
