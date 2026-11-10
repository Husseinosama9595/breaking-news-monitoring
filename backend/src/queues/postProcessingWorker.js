import { Worker } from 'bullmq';
import { env } from '../config/environment.js';
import Post from '../models/Post.js';
import MonitoredAccount from '../models/MonitoredAccount.js';
import { getRedisConnection } from '../config/redis.js';
import { getNotificationQueue, POST_PROCESSING_QUEUE_NAME } from './notificationQueue.js';
import { notificationJobId } from './jobIds.js';
import { PostProcessingError } from './processingErrors.js';
import { TelegramNotificationError, telegramNotificationService } from '../services/telegramNotificationService.js';

/** Minimal processing stage; classification and AI are intentionally out of scope. */
export async function processPersistedPost(post) {
  if (!post?.providerName || !post?.providerPostId || !post?.username || typeof post.text !== 'string') {
    throw new PostProcessingError('Persisted post is missing required processing fields', {
      code: 'INVALID_PERSISTED_POST', retryable: false,
    });
  }
  return { accepted: true };
}

/** BullMQ worker for durable processing and the separately tracked Telegram stage. */
export class PostProcessingWorker {
  /**
   * @param {{ postModel?: typeof Post, accountModel?: typeof MonitoredAccount, providerNameMode?: 'account'|'mock'|'nitter', queueName?: string, processor?: (post: object) => Promise<unknown>, notificationService?: import('../services/telegramNotificationService.js').TelegramNotificationService, queueProvider?: () => import('bullmq').Queue|null, connectionProvider?: () => object|null, workerClass?: typeof Worker, concurrency?: number, maxAttempts?: number, backoffMs?: number, notificationMaxAttempts?: number, notificationBackoffMs?: number, logger?: Pick<Console, 'info'|'warn'|'error'>, clock?: () => Date }} [options]
   */
  constructor({
    postModel = Post,
    accountModel = MonitoredAccount,
    providerNameMode = env.feedProvider,
    queueName = POST_PROCESSING_QUEUE_NAME,
    processor = processPersistedPost,
    notificationService = telegramNotificationService,
    queueProvider = getNotificationQueue,
    connectionProvider = getRedisConnection,
    workerClass = Worker,
    concurrency = env.postWorkerConcurrency,
    maxAttempts = env.postJobMaxAttempts,
    backoffMs = env.postJobBackoffMs,
    notificationMaxAttempts = env.telegramMaxAttempts,
    notificationBackoffMs = env.telegramBackoffMs,
    logger = console,
    clock = () => new Date(),
  } = {}) {
    for (const [name, value] of Object.entries({ concurrency, maxAttempts, backoffMs, notificationMaxAttempts, notificationBackoffMs })) {
      if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    this.postModel = postModel;
    this.accountModel = accountModel;
    this.providerNameMode = providerNameMode;
    this.queueName = queueName;
    this.processor = processor;
    this.notificationService = notificationService;
    this.queueProvider = queueProvider;
    this.connectionProvider = connectionProvider;
    this.workerClass = workerClass;
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.backoffMs = backoffMs;
    this.notificationMaxAttempts = notificationMaxAttempts;
    this.notificationBackoffMs = notificationBackoffMs;
    this.logger = logger;
    this.clock = clock;
    this.worker = null;
  }

  /** Start BullMQ consumption after its Redis connection is ready. */
  async start() {
    if (this.worker) return false;
    const connection = this.connectionProvider();
    if (!connection || connection.status !== 'ready') throw new Error('Redis is not ready; processing worker was not started');
    const worker = new this.workerClass(
      this.queueName,
      (job) => this.processJob(job),
      { connection, concurrency: this.concurrency },
    );
    this.worker = worker;
    worker.on('error', (error) => this.logger.error?.('Post processing worker error:', error.message));
    worker.on('failed', (job, error) => this.logger.warn?.(`Post processing job ${job?.id ?? 'unknown'} failed: ${error.message}`));
    try {
      await worker.waitUntilReady();
      this.logger.info?.(`Post processing worker ready (concurrency ${this.concurrency}).`);
      return true;
    } catch (error) {
      this.worker = null;
      await worker.close(true).catch(() => {});
      throw error;
    }
  }

  /** Close intake and wait for active job handlers to finish. */
  async stop() {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    await worker.close();
    this.logger.info?.('Post processing worker stopped.');
  }

  /** Route independent job stages to distinct MongoDB state transitions. */
  async processJob(job) {
    if (job?.name === 'send-notification') return this.processNotificationJob(job);
    if (job?.name && job.name !== 'process-post') return { status: 'skipped', reason: 'unsupported-job' };
    return this.processPostJob(job);
  }

  /** Process one post, persist completion, then enqueue notification work if configured. */
  async processPostJob(job) {
    const postId = job?.data?.postId;
    if (!postId) return { status: 'failed', code: 'POST_ID_REQUIRED' };
    const startedAt = this.clock();
    const post = await this.postModel.findOneAndUpdate(
      { _id: postId, processingStatus: 'pending', notificationStatus: 'pending' },
      {
        $set: {
          processingStatus: 'processing',
          processingStartedAt: startedAt,
          processingNextAttemptAt: null,
          processedAt: null,
          processingFailedAt: null,
          processingError: null,
          processingErrorCode: null,
        },
        $inc: { processingAttempts: 1 },
      },
      { new: true },
    ).lean();
    if (!post) return { status: 'skipped', reason: 'post-not-pending' };

    try {
      await this.processor(post);
    } catch (error) {
      return this.#recordProcessingFailure(post, startedAt, job, error);
    }

    const updated = await this.postModel.updateOne({
      _id: post._id,
      processingStatus: 'processing',
      processingStartedAt: startedAt,
    }, { $set: {
      processingStatus: 'processed',
      processingStartedAt: null,
      processingNextAttemptAt: null,
      processedAt: this.clock(),
      processingError: null,
      processingErrorCode: null,
      processingFailedAt: null,
    } });
    if (!updated.modifiedCount) return { status: 'lease-lost', postId: String(post._id) };

    // MongoDB has durably recorded processed + notification pending. If this enqueue
    // fails or the worker crashes, the recovery dispatcher will recreate this job.
    let notificationQueued = false;
    if (this.notificationService?.isConfigured?.()) {
      try {
        const queue = this.queueProvider();
        if (queue) {
          await queue.add('send-notification', { postId: String(post._id) }, {
            jobId: notificationJobId(post._id),
            attempts: this.notificationMaxAttempts,
            backoff: { type: 'exponential', delay: this.notificationBackoffMs },
          });
          notificationQueued = true;
        }
      } catch {
        this.logger.warn?.(`Could not enqueue Telegram notification for post ${post._id}; MongoDB recovery will retry.`);
      }
    }
    return { status: 'processed', postId: String(post._id), notificationQueued };
  }

  /** Send only posts whose processing stage is complete and notification claim succeeds. */
  async processNotificationJob(job) {
    const postId = job?.data?.postId;
    if (!postId) return { status: 'failed', code: 'POST_ID_REQUIRED' };
    const candidate = await this.postModel.findById(postId).select('providerName monitoredAccount publishedAt').lean();
    const initialGuard = candidate ? await this.#getNitterBaselineGuard(candidate) : null;
    if (initialGuard?.reason === 'nitter-baseline-pending') {
      return { status: 'skipped', reason: initialGuard.reason, postId: String(postId) };
    }
    if (initialGuard) {
      return this.#skipPendingNotification(postId, initialGuard);
    }
    if (!this.notificationService?.isConfigured?.()) {
      return { status: 'notification-disabled', postId: String(postId) };
    }
    const now = this.clock();
    const post = await this.postModel.findOneAndUpdate(
      {
        _id: postId,
        processingStatus: 'processed',
        notificationStatus: 'pending',
        $or: [{ notificationNextAttemptAt: null }, { notificationNextAttemptAt: { $lte: now } }],
      },
      {
        $set: {
          notificationStatus: 'sending',
          notificationStartedAt: now,
          notificationNextAttemptAt: null,
          notificationError: null,
          notificationErrorCode: null,
          notificationFailedAt: null,
        },
        $inc: { notificationAttempts: 1 },
      },
      { new: true },
    ).lean();
    if (!post) return { status: 'skipped', reason: 'notification-not-pending-or-not-due' };

    // Provider assignment and the Nitter baseline may change while this job is
    // being claimed. Re-read the associated account after the claim, immediately
    // before delivery, and release only this worker's claim if it is no longer safe.
    const finalGuard = await this.#getNitterBaselineGuard(post);
    if (finalGuard) return this.#releaseNotificationClaim(post, now, finalGuard);

    let delivery;
    try {
      delivery = await this.notificationService.sendNotification(post);
    } catch (error) {
      return this.#recordNotificationFailure(post, now, job, error);
    }

    // This Mongo write follows Telegram acceptance. If it fails, stale-sending
    // recovery retries later; a duplicate message is possible in that window.
    const saved = await this.postModel.updateOne({
      _id: post._id,
      notificationStatus: 'sending',
      notificationStartedAt: now,
    }, { $set: {
      notificationStatus: 'sent',
      telegramSent: true,
      telegramSentAt: delivery?.sentAt ?? this.clock(),
      telegramMessageId: delivery?.messageId ?? null,
      notificationStartedAt: null,
      notificationNextAttemptAt: null,
      notificationError: null,
      notificationErrorCode: null,
      notificationFailedAt: null,
    } });
    return saved.modifiedCount
      ? { status: 'sent', postId: String(post._id), telegramMessageId: delivery?.messageId ?? null }
      : { status: 'lease-lost', postId: String(post._id) };
  }

  async #getNitterBaselineGuard(post) {
    if (this.providerNameMode === 'mock') return null;
    const account = await this.accountModel.findById(post.monitoredAccount)
      .select('providerName notificationBaselineAt').lean();
    const effectiveProvider = this.providerNameMode === 'nitter'
      ? 'nitter'
      : (account?.providerName || post.providerName || 'mock');
    if (effectiveProvider !== 'nitter') return null;

    const baselineAt = account?.notificationBaselineAt == null
      ? NaN
      : new Date(account.notificationBaselineAt).getTime();
    if (!Number.isFinite(baselineAt)) {
      return { reason: 'nitter-baseline-pending', errorCode: 'NITTER_BASELINE_PENDING' };
    }
    const publishedAt = post.publishedAt == null ? NaN : new Date(post.publishedAt).getTime();
    if (!Number.isFinite(publishedAt)) {
      return { reason: 'nitter-published-at-invalid', errorCode: 'NITTER_PUBLISHED_AT_INVALID' };
    }
    if (publishedAt <= baselineAt) {
      return { reason: 'post-at-or-before-nitter-baseline', errorCode: 'NITTER_POST_AT_OR_BEFORE_BASELINE' };
    }
    return null;
  }

  async #skipPendingNotification(postId, guard) {
    const saved = await this.postModel.updateOne({
      _id: postId,
      processingStatus: 'processed',
      notificationStatus: 'pending',
    }, { $set: {
      notificationStatus: 'skipped',
      notificationStartedAt: null,
      notificationNextAttemptAt: null,
      notificationError: guard.reason,
      notificationErrorCode: guard.errorCode,
      notificationFailedAt: null,
    } });
    return saved.modifiedCount
      ? { status: 'skipped', reason: guard.reason, postId: String(postId) }
      : { status: 'lease-lost', postId: String(postId) };
  }

  async #releaseNotificationClaim(post, startedAt, guard) {
    const baselinePending = guard.reason === 'nitter-baseline-pending';
    const saved = await this.postModel.updateOne({
      _id: post._id,
      notificationStatus: 'sending',
      notificationStartedAt: startedAt,
    }, { $set: {
      notificationStatus: baselinePending ? 'pending' : 'skipped',
      notificationStartedAt: null,
      notificationNextAttemptAt: null,
      notificationError: guard.reason,
      notificationErrorCode: guard.errorCode,
      notificationFailedAt: null,
    } });
    return saved.modifiedCount
      ? { status: 'skipped', reason: guard.reason, postId: String(post._id) }
      : { status: 'lease-lost', postId: String(post._id) };
  }

  async #recordProcessingFailure(post, startedAt, job, error) {
    const retryable = error instanceof PostProcessingError ? error.retryable : true;
    const code = error instanceof PostProcessingError ? error.code : 'PROCESSING_FAILED';
    const message = String(error?.message ?? 'Post processing failed').slice(0, 2000);
    const maxAttempts = Math.max(1, Number(job.opts?.attempts) || this.maxAttempts);
    const exhausted = retryable && post.processingAttempts >= maxAttempts;
    const terminal = !retryable || exhausted;
    const delay = Math.min(this.backoffMs * (2 ** Math.max(0, post.processingAttempts - 1)), 2147483647);
    const updated = await this.postModel.updateOne({
      _id: post._id, processingStatus: 'processing', processingStartedAt: startedAt,
    }, { $set: {
      processingStatus: terminal ? 'failed' : 'pending',
      processingStartedAt: null,
      processingNextAttemptAt: terminal ? null : new Date(this.clock().getTime() + delay),
      processingError: message,
      processingErrorCode: exhausted ? 'MAX_ATTEMPTS_EXHAUSTED' : code,
      processingFailedAt: terminal ? this.clock() : null,
    } });
    if (!updated.modifiedCount) return { status: 'lease-lost', postId: String(post._id) };
    if (terminal) {
      job.discard?.();
      if (exhausted) throw new PostProcessingError('Post processing exhausted its retry limit', {
        code: 'MAX_ATTEMPTS_EXHAUSTED', retryable: false, cause: error,
      });
    }
    throw error;
  }

  async #recordNotificationFailure(post, startedAt, job, error) {
    const retryable = error instanceof TelegramNotificationError ? error.retryable : true;
    const code = error instanceof TelegramNotificationError ? error.code : 'TELEGRAM_SEND_FAILED';
    const message = String(error?.message ?? 'Telegram send failed').slice(0, 1000);
    const maxAttempts = Math.max(1, Number(job.opts?.attempts) || this.notificationMaxAttempts);
    const exhausted = retryable && post.notificationAttempts >= maxAttempts;
    const terminal = !retryable || exhausted;
    const exponentialDelay = Math.min(this.notificationBackoffMs * (2 ** Math.max(0, post.notificationAttempts - 1)), 2147483647);
    const delay = Math.max(exponentialDelay, error?.retryAfterMs ?? 0);
    const updated = await this.postModel.updateOne({
      _id: post._id, notificationStatus: 'sending', notificationStartedAt: startedAt,
    }, { $set: {
      notificationStatus: terminal ? 'failed' : 'pending',
      notificationStartedAt: null,
      notificationNextAttemptAt: terminal ? null : new Date(this.clock().getTime() + delay),
      notificationError: message,
      notificationErrorCode: exhausted ? 'MAX_ATTEMPTS_EXHAUSTED' : code,
      notificationFailedAt: terminal ? this.clock() : null,
      telegramSent: false,
    } });
    if (!updated.modifiedCount) return { status: 'lease-lost', postId: String(post._id) };
    if (terminal) {
      job.discard?.();
      if (exhausted) throw new TelegramNotificationError('Telegram notification exhausted its retry limit', {
        code: 'MAX_ATTEMPTS_EXHAUSTED', retryable: false,
      });
    }
    throw error;
  }
}

export const postProcessingWorker = new PostProcessingWorker();
export default postProcessingWorker;
