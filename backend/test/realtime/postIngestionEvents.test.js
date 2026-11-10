import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { normalizeFeedPost } from '../../src/providers/normalizedPost.js';
import { createPostIngestionService } from '../../src/services/postIngestionService.js';

const accountId = new mongoose.Types.ObjectId();
const receivedAt = new Date('2026-11-10T12:00:03.000Z');

function makePost({ id, providerName = 'mock', publishedAt = new Date('2026-11-10T12:00:00.000Z'), text = `Post ${id}` }) {
  return normalizeFeedPost({
    providerName, providerPostId: id, canonicalPostId: id,
    sourceUsername: 'SignalDesk', author: { username: 'SignalDesk', displayName: 'Signal Desk' },
    text, postUrl: `https://x.com/SignalDesk/status/${id}`, providerUrl: null,
    publishedAt, retrievedAt: receivedAt,
  }, providerName);
}

function makeHarness({ providerName = 'mock', baselineAt = null, countryCode = null, upsertedIndexes, bulkError } = {}) {
  const events = [];
  const order = [];
  const writtenOperations = [];
  const account = {
    _id: accountId,
    username: 'SignalDesk',
    category: 'World News',
    providerName,
    countryCode,
    notificationBaselineAt: baselineAt,
  };
  const accountModel = {
    async findOneAndUpdate() { return account; },
    async updateOne() { order.push('account-checkpoint'); return { modifiedCount: 1 }; },
  };
  const postModel = {
    async updateMany() { return { modifiedCount: 0 }; },
    async bulkWrite(operations) {
      order.push('post-persistence');
      writtenOperations.push(...operations);
      if (bulkError) throw bulkError;
      const upsertedIds = Object.fromEntries((upsertedIndexes ?? operations.map((_, index) => index))
        .map((index) => [index, operations[index].updateOne.update.$setOnInsert._id]));
      return { upsertedCount: Object.keys(upsertedIds).length, upsertedIds };
    },
  };
  const ingest = createPostIngestionService({
    accountModel,
    postModel,
    publishPostEvent(event) { order.push('event-published'); events.push(event); },
  });
  return { ingest, events, order, account, writtenOperations };
}

test('publishes a dashboard event only after a new post was durably upserted', async () => {
  const harness = makeHarness();
  const result = await harness.ingest({
    account: { username: 'SignalDesk' },
    batch: { providerName: 'mock', fetchedAt: receivedAt, posts: [makePost({ id: 'new-post-1' })] },
    receivedAt,
  });

  assert.equal(result.insertedCount, 1);
  assert.deepEqual(harness.writtenOperations[0].updateOne.update.$setOnInsert.dashboardNotification, {
    createdAt: receivedAt,
    readAt: null,
  });
  assert.equal(harness.events.length, 1);
  assert.equal(harness.order[0], 'post-persistence');
  assert.equal(harness.order[1], 'event-published');
  assert.equal(harness.events[0].postId.length, 24);
  assert.equal(harness.events[0].eventId, harness.events[0].postId);
  assert.equal(harness.events[0].notificationId, harness.events[0].postId);
  assert.equal(harness.events[0].username, 'SignalDesk');
  assert.equal(harness.events[0].category, 'World News');
  assert.equal(harness.events[0].postUrl, 'https://x.com/SignalDesk/status/new-post-1');
  assert.equal(harness.events[0].detectedAt, receivedAt.toISOString());
});

test('does not publish duplicate upserts', async () => {
  const harness = makeHarness({ upsertedIndexes: [] });
  const result = await harness.ingest({
    account: { username: 'SignalDesk' },
    batch: { providerName: 'mock', fetchedAt: receivedAt, posts: [makePost({ id: 'duplicate-post' })] },
    receivedAt,
  });

  assert.equal(result.insertedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(harness.events, []);
});

test('includes the source account ID and its current country assignment on the single existing SSE event', async () => {
  const harness = makeHarness({ countryCode: 'IR' });
  await harness.ingest({
    account: { username: 'SignalDesk' },
    batch: { providerName: 'mock', fetchedAt: receivedAt, posts: [makePost({ id: 'country-context' })] },
    receivedAt,
  });
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].monitoredAccountId, String(accountId));
  assert.equal(harness.events[0].countryCode, 'IR');
});

test('does not publish first-poll Nitter baseline history or posts at/before an existing baseline', async () => {
  const firstPoll = makeHarness({ providerName: 'nitter' });
  await firstPoll.ingest({
    account: { username: 'SignalDesk' },
    batch: { providerName: 'nitter', fetchedAt: receivedAt, posts: [makePost({ id: 'baseline-1', providerName: 'nitter' })] },
    receivedAt,
  });
  assert.deepEqual(firstPoll.events, []);
  assert.equal(firstPoll.writtenOperations[0].updateOne.update.$setOnInsert.dashboardNotification, undefined);

  const baseline = new Date('2026-11-10T12:00:00.000Z');
  const laterPoll = makeHarness({ providerName: 'nitter', baselineAt: baseline });
  await laterPoll.ingest({
    account: { username: 'SignalDesk' },
    batch: {
      providerName: 'nitter', fetchedAt: receivedAt,
      posts: [
        makePost({ id: 'old-post', providerName: 'nitter', publishedAt: baseline }),
        makePost({ id: 'new-post', providerName: 'nitter', publishedAt: new Date(baseline.getTime() + 1) }),
      ],
    },
    receivedAt,
  });
  assert.equal(laterPoll.events.length, 1);
  assert.equal(laterPoll.events[0].textPreview, 'Post new-post');
});

test('does not publish before persistence succeeds', async () => {
  const harness = makeHarness({ bulkError: new Error('simulated persistence failure') });
  await assert.rejects(harness.ingest({
    account: { username: 'SignalDesk' },
    batch: { providerName: 'mock', fetchedAt: receivedAt, posts: [makePost({ id: 'failed-persist' })] },
    receivedAt,
  }), /simulated persistence failure/);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.order, ['post-persistence']);
});
