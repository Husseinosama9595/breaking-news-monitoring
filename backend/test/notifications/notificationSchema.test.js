import test from 'node:test';
import assert from 'node:assert/strict';
import Post from '../../src/models/Post.js';

test('embeds dashboard notification timestamps in the durable Post schema', () => {
  assert.equal(Post.schema.path('dashboardNotification.createdAt').instance, 'Date');
  assert.equal(Post.schema.path('dashboardNotification.readAt').instance, 'Date');
  const legacy = new Post({
    dedupeKey: 'provider:mock:legacy', providerName: 'mock', providerPostId: 'legacy',
    monitoredAccount: '000000000000000000000001', username: 'SignalDesk',
    author: { username: 'SignalDesk' }, text: 'Legacy post', receivedAt: new Date(), retrievedAt: new Date(),
  });
  assert.equal(legacy.dashboardNotification, undefined, 'existing posts do not receive retroactive notification metadata');
});

test('indexes notification history and unread lookups while keeping one document per dedupe key', () => {
  const indexes = Post.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.dedupeKey === 1 && options.unique === true));
  assert.ok(indexes.some(([keys, options]) => keys['dashboardNotification.createdAt'] === -1
    && keys._id === -1 && options.partialFilterExpression?.['dashboardNotification.createdAt']?.$exists === true));
  assert.ok(indexes.some(([keys, options]) => keys['dashboardNotification.readAt'] === 1
    && keys['dashboardNotification.createdAt'] === -1 && options.partialFilterExpression?.['dashboardNotification.createdAt']?.$exists === true));
});
