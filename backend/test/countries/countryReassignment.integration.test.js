import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/environment.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import Post from '../../src/models/Post.js';
import accountRoutes from '../../src/routes/accountRoutes.js';
import postRoutes from '../../src/routes/postRoutes.js';
import notificationRoutes from '../../src/routes/notificationRoutes.js';
import { createAdminToken } from '../../src/middleware/auth.js';

function localMongoHost(uriValue) {
  try {
    const { hostname } = new URL(uriValue);
    return ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());
  } catch { return false; }
}

test('historical post and notification follow the account country after reassignment through protected APIs', {
  timeout: 30_000,
}, async (t) => {
  if (env.nodeEnv === 'production') return t.skip('refusing integration test under production configuration');
  if (!localMongoHost(env.mongoUri)) return t.skip('requires a local MongoDB host; no remote database is accessed');

  const databaseName = `bnm_country_move_test_${process.pid}_${randomUUID().slice(0, 8)}`;
  let server;
  try {
    await mongoose.connect(env.mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
    await Promise.all([MonitoredAccount.init(), Post.init()]);

    const username = `Ctry${randomUUID().slice(0, 8)}`;
    const account = await MonitoredAccount.create({
      platform: 'x', username, normalizedUsername: username.toLowerCase(), category: 'World News',
      countryCode: 'IR', enabled: true, providerName: 'nitter', monitoringStatus: 'active',
    });
    const postId = new mongoose.Types.ObjectId();
    const readAt = new Date('2026-11-10T10:30:00.000Z');
    const dedupeKey = `x:country-move-${randomUUID()}`;
    await Post.create({
      _id: postId,
      dedupeKey,
      providerName: 'nitter',
      providerPostId: `country-move-${randomUUID()}`,
      canonicalPostId: `country-move-${randomUUID()}`,
      monitoredAccount: account._id,
      username,
      author: { username, displayName: 'Country Move Test' },
      text: 'Isolated historical country reassignment integration fixture.',
      postUrl: `https://x.com/${username}/status/1234567890`,
      category: 'World News',
      publishedAt: new Date('2026-11-09T10:00:00.000Z'),
      receivedAt: new Date('2026-11-09T10:00:05.000Z'),
      retrievedAt: new Date('2026-11-09T10:00:05.000Z'),
      processingStatus: 'processed',
      processedAt: new Date('2026-11-09T10:00:06.000Z'),
      notificationStatus: 'sent',
      telegramSent: true,
      telegramSentAt: new Date('2026-11-09T10:00:07.000Z'),
      notificationAttempts: 1,
      dashboardNotification: { createdAt: new Date('2026-11-09T10:00:05.000Z'), readAt },
    });

    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    app.use('/api/posts', postRoutes);
    app.use('/api/notifications', notificationRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${createAdminToken()}`, 'Content-Type': 'application/json' };
    const getCountryPost = async (country) => {
      const response = await fetch(`${baseUrl}/api/posts?country=${country}`, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    const getCountryNotification = async (country) => {
      const response = await fetch(`${baseUrl}/api/notifications?country=${country}`, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };

    const before = await getCountryPost('IR');
    assert.equal(before.pagination.total, 1);
    assert.equal(String(before.posts[0]._id), String(postId));
    const beforeHistory = await getCountryNotification('IR');
    assert.equal(beforeHistory.pagination.total, 1);
    assert.equal(beforeHistory.notifications[0].read, true);
    assert.equal(beforeHistory.notifications[0].readAt, readAt.toISOString());

    const update = await fetch(`${baseUrl}/api/accounts/${account._id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ countryCode: 'US' }),
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).account.countryCode, 'US');

    const moved = await getCountryPost('US');
    assert.equal(moved.pagination.total, 1);
    assert.equal(String(moved.posts[0]._id), String(postId));
    assert.equal(moved.posts[0].countryCode, 'US');
    assert.equal((await getCountryPost('IR')).pagination.total, 0);
    const movedHistory = await getCountryNotification('US');
    assert.equal(movedHistory.pagination.total, 1);
    assert.equal(movedHistory.notifications[0].notificationId, String(postId));
    assert.equal(movedHistory.notifications[0].read, true);
    assert.equal(movedHistory.notifications[0].readAt, readAt.toISOString());
    assert.equal((await getCountryNotification('IR')).pagination.total, 0);

    const persisted = await Post.findById(postId).lean();
    assert.equal(String(persisted._id), String(postId));
    assert.equal(persisted.dedupeKey, dedupeKey);
    assert.equal(persisted.notificationStatus, 'sent');
    assert.equal(persisted.notificationAttempts, 1);
    assert.equal(persisted.dashboardNotification.readAt.toISOString(), readAt.toISOString());
    assert.equal(await Post.countDocuments({ monitoredAccount: account._id }), 1);
    assert.equal(await Post.countDocuments({ monitoredAccount: account._id, 'dashboardNotification.createdAt': { $exists: true } }), 1);
    assert.equal(await MonitoredAccount.countDocuments({ _id: account._id }), 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
    }
  }
});
