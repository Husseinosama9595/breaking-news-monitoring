import app from './src/app.js';
import { env } from './src/config/environment.js';
import { connectDatabase, disconnectDatabase, ensureCountryMonitoringIndex } from './src/config/database.js';
import { connectRedis, disconnectRedis } from './src/config/redis.js';
import { closeQueues } from './src/queues/notificationQueue.js';
import { feedPollingService } from './src/services/feedPollingService.js';
import { processingRuntime } from './src/services/processingRuntime.js';
import { closeEventStreams } from './src/routes/eventRoutes.js';

let server;
let shuttingDown = false;

async function start() {
  await connectDatabase();
  await ensureCountryMonitoringIndex();
  console.info('Country monitoring index is ready.');

  if (env.redisUrl) {
    try {

      await connectRedis();
      console.info('Redis connected; BullMQ is available.');
    } catch (error) {
      console.warn(`Redis unavailable; starting without queue features: ${error.message}`);
    }
  } else {
    console.info('REDIS_URL is empty; starting without Redis/BullMQ.');
  }

  server = app.listen(env.port, () => {
    console.info(`Breaking News Monitor API listening on port ${env.port}`);
  });
  feedPollingService.start();
  processingRuntime.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down.`);

  closeEventStreams();
  const closeHttp = new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
  });

  await Promise.allSettled([closeHttp, feedPollingService.stop(), processingRuntime.stop()]);
  await Promise.allSettled([
    closeQueues(),
    disconnectRedis(),
    disconnectDatabase(),
  ]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((error) => {
  console.error(`Application startup failed: ${error.message}`);
  process.exitCode = 1;
});
