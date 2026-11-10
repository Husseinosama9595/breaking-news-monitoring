import dotenv from 'dotenv';
import { z } from 'zod';

// In local development, the ignored .env is the source of truth even if the
// parent shell has stale variables. Production process variables take priority.
dotenv.config({ override: process.env.NODE_ENV !== 'production' });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRONTEND_URL: z.string().url().default('http://localhost:4200'),
  EXTRA_CORS_ORIGINS: z.string().default(''),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().default(''),
  FEED_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(45000),
  FEED_POLL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  FEED_POLL_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  FEED_POLL_JITTER_MS: z.coerce.number().int().min(0).max(60000).default(1000),
  FEED_FRESHNESS_MAX_AGE_MS: z.coerce.number().int().min(1000).max(604800000).default(21600000),
  FEED_PROVIDER: z.enum(['account', 'mock', 'nitter']).default('account'),
  NITTER_INSTANCES: z.string().default('https://xitter.cf,https://nitter.gq'),
  NITTER_INSTANCE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(4000),
  NITTER_INSTANCE_COOLDOWN_MS: z.coerce.number().int().min(0).max(3600000).default(60000),
  POST_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  POST_JOB_BACKOFF_MS: z.coerce.number().int().min(100).max(300000).default(1000),
  POST_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(5000),
  POST_STALE_AFTER_MS: z.coerce.number().int().min(1000).max(86400000).default(120000),
  POST_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  POST_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  QUEUE_RUNTIME_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  TELEGRAM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(1100),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  TELEGRAM_BACKOFF_MS: z.coerce.number().int().min(100).max(300000).default(2000),
  JWT_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1).max(100),
  ADMIN_PASSWORD: z.string().min(12).max(256),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map(({ path, message }) => `${path.join('.')}: ${message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const value = parsed.data;

export const env = Object.freeze({
  nodeEnv: value.NODE_ENV,
  port: value.PORT,
  frontendUrl: value.FRONTEND_URL,
  corsOrigins: new Set([
    value.FRONTEND_URL,
    ...value.EXTRA_CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  ]),
  mongoUri: value.MONGODB_URI,
  redisUrl: value.REDIS_URL || null,
  feedPollIntervalMs: value.FEED_POLL_INTERVAL_MS,
  feedPollTimeoutMs: value.FEED_POLL_TIMEOUT_MS,
  feedPollConcurrency: value.FEED_POLL_CONCURRENCY,
  feedPollJitterMs: value.FEED_POLL_JITTER_MS,
  feedFreshnessMaxAgeMs: value.FEED_FRESHNESS_MAX_AGE_MS,
  feedProvider: value.FEED_PROVIDER,
  nitterInstances: value.NITTER_INSTANCES.split(',').map((instance) => instance.trim()).filter(Boolean),
  nitterInstanceTimeoutMs: value.NITTER_INSTANCE_TIMEOUT_MS,
  nitterInstanceCooldownMs: value.NITTER_INSTANCE_COOLDOWN_MS,
  postJobMaxAttempts: value.POST_JOB_MAX_ATTEMPTS,
  postJobBackoffMs: value.POST_JOB_BACKOFF_MS,
  postRecoveryIntervalMs: value.POST_RECOVERY_INTERVAL_MS,
  postStaleAfterMs: value.POST_STALE_AFTER_MS,
  postRecoveryBatchSize: value.POST_RECOVERY_BATCH_SIZE,
  postWorkerConcurrency: value.POST_WORKER_CONCURRENCY,
  queueRuntimeCheckIntervalMs: value.QUEUE_RUNTIME_CHECK_INTERVAL_MS,
  telegramBotToken: value.TELEGRAM_BOT_TOKEN.trim(),
  telegramChatId: value.TELEGRAM_CHAT_ID.trim(),
  telegramRequestTimeoutMs: value.TELEGRAM_REQUEST_TIMEOUT_MS,
  telegramMinIntervalMs: value.TELEGRAM_MIN_INTERVAL_MS,
  telegramMaxAttempts: value.TELEGRAM_MAX_ATTEMPTS,
  telegramBackoffMs: value.TELEGRAM_BACKOFF_MS,
  jwtSecret: value.JWT_SECRET,
  adminUsername: value.ADMIN_USERNAME,
  adminPassword: value.ADMIN_PASSWORD,
});
