import { Queue } from 'bullmq';
import { env } from '../config/environment.js';
import { getRedisConnection } from '../config/redis.js';
import { resolveMongoDatabaseName } from '../config/database.js';

let notificationQueue;

// BullMQ durations use seconds for removeOnFail.age and milliseconds for Queue.clean().
export const FAILED_JOB_RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILED_JOB_RETENTION_COUNT = 1000;
export const FAILED_JOB_CLEANUP_LIMIT = 100;

/** Resolve a queue name with an injective database-name suffix; this never connects to MongoDB. */
export function resolvePostProcessingQueueName(mongoUri = env.mongoUri) {
  const databaseName = resolveMongoDatabaseName(mongoUri);
  return `post-processing-${Buffer.from(databaseName, 'utf8').toString('hex')}`;
}

export const POST_PROCESSING_QUEUE_NAME = resolvePostProcessingQueueName();

// Queue is optional locally; MongoDB remains the source of truth for pending work.
export function getNotificationQueue() {
  if (!env.redisUrl) return null;
  if (!notificationQueue) {
    notificationQueue = new Queue(POST_PROCESSING_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: env.postJobMaxAttempts,
        backoff: { type: 'exponential', delay: env.postJobBackoffMs },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: {
          age: Math.floor(FAILED_JOB_RETENTION_AGE_MS / 1000),
          count: FAILED_JOB_RETENTION_COUNT,
        },
      },
    });
  }
  return notificationQueue;
}

export async function closeQueues() {
  if (notificationQueue) await notificationQueue.close();
  notificationQueue = undefined;
}
