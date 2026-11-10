import { env } from '../config/environment.js';
import { redisStatus } from '../config/redis.js';
import { mongoRecoveryDispatcher } from './mongoRecoveryDispatcher.js';
import { postProcessingWorker } from '../queues/postProcessingWorker.js';

/** Starts BullMQ components only while Redis is ready; retries startup after outages. */
export class ProcessingRuntime {
  /** @param {{ worker?: import('../queues/postProcessingWorker.js').PostProcessingWorker, dispatcher?: import('./mongoRecoveryDispatcher.js').MongoRecoveryDispatcher, redisReady?: () => boolean, checkIntervalMs?: number, logger?: Pick<Console, 'info'|'warn'|'error'> }} [options] */
  constructor({
    worker = postProcessingWorker,
    dispatcher = mongoRecoveryDispatcher,
    redisReady = () => redisStatus().ready,
    checkIntervalMs = env.queueRuntimeCheckIntervalMs,
    logger = console,
  } = {}) {
    if (!Number.isInteger(checkIntervalMs) || checkIntervalMs < 1000) throw new TypeError('checkIntervalMs must be at least 1000 ms');
    this.worker = worker;
    this.dispatcher = dispatcher;
    this.redisReady = redisReady;
    this.checkIntervalMs = checkIntervalMs;
    this.logger = logger;
    this.timer = null;
    this.workerStarted = false;
    this.dispatcherStarted = false;
    this.checking = null;
    this.stopping = false;
  }

  /** Start the Redis readiness watcher and make an immediate readiness check. */
  start() {
    if (this.timer) return false;
    this.stopping = false;
    this.timer = setInterval(() => { void this.checkNow(); }, this.checkIntervalMs);
    this.timer.unref?.();
    void this.checkNow();
    return true;
  }

  /** Exposed to verify Redis recovery without waiting for the next timer tick. */
  async checkNow() {
    if (this.checking) return this.checking;
    this.checking = this.#reconcile()
      .catch((error) => {
        this.logger.warn?.('Could not start post processing runtime:', error.message);
        return false;
      })
      .finally(() => { this.checking = null; });
    return this.checking;
  }

  async #reconcile() {
    if (this.stopping || !this.redisReady()) return false;
    if (!this.workerStarted) {
      await this.worker.start();
      this.workerStarted = true;
    }
    if (!this.dispatcherStarted) {
      this.dispatcher.start();
      this.dispatcherStarted = true;
    }
    return true;
  }

  /** Stop dispatch first, then close the worker and allow active jobs to finish. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    if (this.checking) await this.checking.catch(() => {});
    if (this.dispatcherStarted) {
      await this.dispatcher.stop();
      this.dispatcherStarted = false;
    }
    if (this.workerStarted) {
      await this.worker.stop();
      this.workerStarted = false;
    }
  }
}

export const processingRuntime = new ProcessingRuntime();
export default processingRuntime;
