import test from 'node:test';
import assert from 'node:assert/strict';
import { PostProcessingWorker } from '../../src/queues/postProcessingWorker.js';

const baseline = new Date('2026-07-01T12:00:00.000Z');
const publishedAfter = new Date('2026-07-01T12:00:01.000Z');
const fixedNow = new Date('2026-07-01T12:01:00.000Z');

function query(value) {
  return { select() { return this; }, async lean() { return value == null ? null : structuredClone(value); } };
}

function createHarness(options = {}) {
  const {
    providerName = 'nitter', notificationBaselineAt = baseline,
    providerNameMode = 'account', afterClaim,
  } = options;
  const publishedAt = Object.hasOwn(options, 'publishedAt') ? options.publishedAt : publishedAfter;
  const account = { _id: 'account-1', providerName, notificationBaselineAt };
  const post = {
    _id: 'post-1', providerName: 'nitter', monitoredAccount: account._id, publishedAt,
    processingStatus: 'processed', notificationStatus: 'pending', notificationStartedAt: null,
    notificationNextAttemptAt: null, notificationAttempts: 0, telegramSent: false,
  };
  const postModel = {
    findById() { return query(post); },
    findOneAndUpdate(_filter, update) {
      if (post.processingStatus !== 'processed' || post.notificationStatus !== 'pending') return query(null);
      Object.assign(post, structuredClone(update.$set));
      post.notificationAttempts += update.$inc.notificationAttempts;
      afterClaim?.({ account, post });
      return query(post);
    },
    async updateOne(filter, update) {
      const startedAtMatches = filter.notificationStartedAt == null
        ? post.notificationStartedAt == null
        : post.notificationStartedAt?.getTime?.() === filter.notificationStartedAt.getTime();
      if (String(filter._id) !== String(post._id)
        || post.notificationStatus !== filter.notificationStatus
        || !startedAtMatches
        || (filter.processingStatus && post.processingStatus !== filter.processingStatus)) {
        return { modifiedCount: 0 };
      }
      Object.assign(post, structuredClone(update.$set));
      return { modifiedCount: 1 };
    },
  };
  const accountModel = { findById() { return query(account); } };
  let sendCalls = 0;
  const worker = new PostProcessingWorker({
    postModel, accountModel, providerNameMode, logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(fixedNow),
    notificationService: {
      isConfigured: () => true,
      async sendNotification() { sendCalls += 1; return { messageId: 'mock-message' }; },
    },
  });
  return { worker, post, account, get sendCalls() { return sendCalls; } };
}

const job = { name: 'send-notification', data: { postId: 'post-1' }, opts: { attempts: 3 }, attemptsMade: 0 };

test('rechecks provider after claim when account changes from Mock to Nitter', async () => {
  const harness = createHarness({
    providerName: 'mock', notificationBaselineAt: null,
    afterClaim({ account }) { account.providerName = 'nitter'; },
  });
  const result = await harness.worker.processNotificationJob(job);
  assert.equal(result.reason, 'nitter-baseline-pending');
  assert.equal(harness.sendCalls, 0);
  assert.equal(harness.post.notificationStatus, 'pending');
  assert.equal(harness.post.notificationStartedAt, null);
  assert.equal(harness.post.notificationErrorCode, 'NITTER_BASELINE_PENDING');
});

test('rechecks a changed baseline after claim and marks a now-historical post skipped', async () => {
  const harness = createHarness({
    afterClaim({ account }) { account.notificationBaselineAt = new Date('2026-07-01T12:00:02.000Z'); },
  });
  const result = await harness.worker.processNotificationJob(job);
  assert.equal(result.reason, 'post-at-or-before-nitter-baseline');
  assert.equal(harness.sendCalls, 0);
  assert.equal(harness.post.notificationStatus, 'skipped');
  assert.equal(harness.post.notificationErrorCode, 'NITTER_POST_AT_OR_BEFORE_BASELINE');
});

test('claim release does not overwrite a status changed by another worker', async () => {
  const harness = createHarness({
    afterClaim({ account, post }) {
      account.notificationBaselineAt = null;
      post.notificationStatus = 'sent';
      post.notificationStartedAt = null;
      post.telegramSent = true;
    },
  });
  const result = await harness.worker.processNotificationJob(job);
  assert.equal(result.status, 'lease-lost');
  assert.equal(harness.sendCalls, 0);
  assert.equal(harness.post.notificationStatus, 'sent');
  assert.equal(harness.post.telegramSent, true);
});

test('missing, null, and invalid Nitter publication timestamps are skipped without Telegram delivery', async (t) => {
  for (const [label, publishedAt] of [['missing', undefined], ['null', null], ['invalid', 'not-a-date']]) {
    await t.test(label, async () => {
      const harness = createHarness({ publishedAt });
      const result = await harness.worker.processNotificationJob(job);
      assert.equal(result.reason, 'nitter-published-at-invalid');
      assert.equal(harness.sendCalls, 0);
      assert.equal(harness.post.notificationStatus, 'skipped');
      assert.equal(harness.post.notificationErrorCode, 'NITTER_PUBLISHED_AT_INVALID');
    });
  }
});

test('Mock mode remains deliverable when its account has no Nitter baseline', async () => {
  const harness = createHarness({ providerName: 'nitter', notificationBaselineAt: null, providerNameMode: 'mock' });
  const result = await harness.worker.processNotificationJob(job);
  assert.equal(result.status, 'sent');
  assert.equal(harness.sendCalls, 1);
});
