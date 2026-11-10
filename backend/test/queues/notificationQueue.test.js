import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMongoDatabaseName } from '../../src/config/database.js';
import {
  FAILED_JOB_CLEANUP_LIMIT,
  FAILED_JOB_RETENTION_AGE_MS,
  FAILED_JOB_RETENTION_COUNT,
  POST_PROCESSING_QUEUE_NAME,
  resolvePostProcessingQueueName,
} from '../../src/queues/notificationQueue.js';
import { PostProcessingWorker } from '../../src/queues/postProcessingWorker.js';

const quietLogger = { info() {}, warn() {}, error() {} };

test('failed BullMQ jobs retain a bounded recent diagnostic window', () => {
  assert.equal(FAILED_JOB_RETENTION_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(FAILED_JOB_RETENTION_COUNT, 1000);
  assert.equal(FAILED_JOB_CLEANUP_LIMIT, 100);
});

test('MongoDB database names resolve to deterministic isolated BullMQ queues', () => {
  const normalUri = 'mongodb://127.0.0.1:27017/BreakingNews';
  const trialUri = 'mongodb://127.0.0.1:27017/BreakingNewsNitterTrial';
  assert.equal(resolveMongoDatabaseName(normalUri), 'BreakingNews');
  assert.equal(resolveMongoDatabaseName(trialUri), 'BreakingNewsNitterTrial');
  assert.equal(resolvePostProcessingQueueName(normalUri), resolvePostProcessingQueueName(normalUri));
  assert.notEqual(resolvePostProcessingQueueName(normalUri), resolvePostProcessingQueueName(trialUri));
  assert.match(resolvePostProcessingQueueName(normalUri), /^post-processing-[a-f0-9]+$/);
  assert.throws(() => resolvePostProcessingQueueName('mongodb://127.0.0.1:27017'), /include a database name/);
  assert.equal(resolveMongoDatabaseName('mongodb://127.0.0.1:27017/%20BreakingNews%20?authSource=admin'), ' BreakingNews ');
  assert.notEqual(
    resolvePostProcessingQueueName('mongodb://127.0.0.1:27017/%20BreakingNews%20'),
    resolvePostProcessingQueueName(normalUri),
  );
  assert.throws(() => resolveMongoDatabaseName('mongodb://127.0.0.1:27017/Bad%ZZ'), /valid encoded database name/);
});

test('configured queue consumer uses the same resolved name as the shared producer queue', async () => {
  let consumedQueueName;
  class FakeWorker {
    constructor(name) { consumedQueueName = name; }
    on() {}
    async waitUntilReady() {}
    async close() {}
  }

  const worker = new PostProcessingWorker({
    workerClass: FakeWorker,
    connectionProvider: () => ({ status: 'ready' }),
    logger: quietLogger,
  });
  await worker.start();
  assert.equal(POST_PROCESSING_QUEUE_NAME, resolvePostProcessingQueueName());
  assert.equal(worker.queueName, POST_PROCESSING_QUEUE_NAME);
  assert.equal(consumedQueueName, POST_PROCESSING_QUEUE_NAME);
  await worker.stop();
});
