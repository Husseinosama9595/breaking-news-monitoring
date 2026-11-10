import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePostCreatedEvent,
  postEventSubscriberCount,
  publishNewPost,
  subscribeToNewPosts,
} from '../../src/services/postEventService.js';

const event = {
  eventId: 'post-1', postId: 'post-1', username: '@Reuters', displayName: 'Reuters',
  textPreview: 'New post content', postUrl: 'https://x.com/Reuters/status/1',
  publishedAt: '2026-11-10T12:00:00.000Z', detectedAt: '2026-11-10T12:00:03.000Z', category: 'World News',
  monitoredAccountId: 'account-1', countryCode: 'IR',
};

test('normalizes safe public fields and drops unsafe original URLs', () => {
  const normalized = normalizePostCreatedEvent({ ...event, postUrl: 'javascript:alert(1)' });
  assert.equal(normalized.postUrl, null);
  assert.equal(normalized.username, 'Reuters');
  assert.equal(normalized.textPreview, event.textPreview);
  assert.equal(normalizePostCreatedEvent({ ...event, detectedAt: 'not-a-date' }), null);
  assert.equal(normalizePostCreatedEvent({ ...event, postUrl: 'https://attacker.example/path' }).postUrl, null);
  assert.equal(normalized.notificationId, event.eventId);
  assert.equal(normalized.monitoredAccountId, 'account-1');
  assert.equal(normalized.countryCode, 'IR');
  assert.equal(normalized.countryName, 'Iran');
});

test('broadcasts one event to multiple subscribers and supports idempotent cleanup', async () => {
  const firstEvents = [];
  const secondEvents = [];
  const firstCount = postEventSubscriberCount();
  const unsubscribeFirst = subscribeToNewPosts((value) => firstEvents.push(value));
  const unsubscribeSecond = subscribeToNewPosts((value) => secondEvents.push(value));
  try {
    assert.equal(postEventSubscriberCount(), firstCount + 2);
    assert.equal(publishNewPost(event), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstEvents.length, 1);
    assert.equal(secondEvents.length, 1);
    assert.equal(firstEvents[0].postId, 'post-1');
  } finally {
    unsubscribeFirst();
    unsubscribeFirst();
    unsubscribeSecond();
  }
  assert.equal(postEventSubscriberCount(), firstCount);
});

test('a subscriber exception does not prevent delivery to other clients or escape publish', async () => {
  let received = false;
  const unsubscribeFailure = subscribeToNewPosts(() => { throw new Error('closed socket'); });
  const unsubscribeHealthy = subscribeToNewPosts(() => { received = true; });
  try {
    assert.equal(publishNewPost(event), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, true);
  } finally {
    unsubscribeFailure();
    unsubscribeHealthy();
  }
});
