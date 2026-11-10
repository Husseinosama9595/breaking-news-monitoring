import IORedis from 'ioredis';
import { env } from './environment.js';

let connection;
let lastErrorMessage = '';
let lastErrorLoggedAt = 0;

export function getRedisConnection() {
  if (!env.redisUrl) return null;
  if (!connection) {
    connection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 250, 3000),
    });
    connection.on('error', (error) => {
      // ioredis retries unavailable servers. Avoid flooding the console on every retry.
      const now = Date.now();
      if (error.message !== lastErrorMessage || now - lastErrorLoggedAt >= 30_000) {
        console.error('Redis connection error:', error.message);
        lastErrorMessage = error.message;
        lastErrorLoggedAt = now;
      }
    });
  }
  return connection;
}

export async function connectRedis() {
  const client = getRedisConnection();
  if (!client) return { enabled: false, ready: false };
  if (client.status === 'wait') await client.connect();
  return { enabled: true, ready: client.status === 'ready' };
}

export function redisStatus() {
  if (!env.redisUrl) return { enabled: false, ready: false };
  return { enabled: true, ready: connection?.status === 'ready' };
}

export async function disconnectRedis() {
  if (connection && connection.status !== 'end') {
    if (connection.status === 'ready') await connection.quit();
    else connection.disconnect();
  }
  connection = undefined;
  lastErrorMessage = '';
  lastErrorLoggedAt = 0;
}
