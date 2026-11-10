import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';
import { createNotificationController } from '../../src/controllers/notificationController.js';
import { createNotificationRouter } from '../../src/routes/notificationRoutes.js';

const records = [];
const monitoredAccounts = [
  { _id: 'account-ir', platform: 'x', countryCode: 'IR' },
  { _id: 'account-us', platform: 'x', countryCode: 'US' },
  { _id: 'account-none', platform: 'x', countryCode: null },
];
let failQueries = false;
const token = createAdminToken();

function getPath(record, path) {
  return path.split('.').reduce((value, key) => value?.[key], record);
}

function matches(record, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = getPath(record, path);
    if (expected === null) return actual == null;
    if (expected && typeof expected === 'object') {
      if ('$in' in expected) return expected.$in.includes(actual?._id ?? actual);
      if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
      if ('$gte' in expected && !(actual instanceof Date ? actual : new Date(actual))
        || ('$gte' in expected && (actual == null || new Date(actual) < expected.$gte))) return false;
      return true;
    }
    return String(actual) === String(expected);
  });
}

function query(operation) {
  return {
    sortOrder: {}, offset: 0, pageSize: 20, populated: false,
    select() { return this; },
    populate() { this.populated = true; return this; },
    sort(value) { this.sortOrder = value; return this; },
    skip(value) { this.offset = value; return this; },
    limit(value) { this.pageSize = value; return this; },
    async lean() {
      if (failQueries) throw new Error('database unavailable');
      const result = await operation(this);
      const attachAccount = (record) => this.populated && record
        ? { ...record, monitoredAccount: monitoredAccounts.find((account) => account._id === record.monitoredAccount) ?? null }
        : record;
      return Array.isArray(result) ? result.map(attachAccount) : attachAccount(result);
    },
  };
}

const model = {
  find(filter) {
    return query((state) => records.filter((record) => matches(record, filter)).sort((left, right) => {
      for (const [path, direction] of Object.entries(state.sortOrder)) {
        const a = getPath(left, path);
        const b = getPath(right, path);
        const compared = a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : String(a).localeCompare(String(b));
        if (compared) return compared * direction;
      }
      return 0;
    }).slice(state.offset, state.offset + state.pageSize));
  },
  countDocuments(filter) {
    return { then(resolve, reject) { if (failQueries) return reject(new Error('database unavailable')); resolve(records.filter((record) => matches(record, filter)).length); } };
  },
  findOneAndUpdate(filter, update) {
    return query(() => {
      const record = records.find((item) => matches(item, filter));
      if (!record) return null;
      record.dashboardNotification.readAt = update.$set['dashboardNotification.readAt'];
      return record;
    });
  },
  findOne(filter) { return query(() => records.find((record) => matches(record, filter)) ?? null); },
  async updateMany(filter, update) {
    if (failQueries) throw new Error('database unavailable');
    const targets = records.filter((record) => matches(record, filter));
    for (const record of targets) record.dashboardNotification.readAt = update.$set['dashboardNotification.readAt'];
    return { modifiedCount: targets.length };
  },
};

const accountModel = {
  find(filter) {
    return query(() => monitoredAccounts.filter((account) => {
      if (filter.$or) return account.countryCode == null;
      return !filter.countryCode || account.countryCode === filter.countryCode;
    }));
  },
};

function post(id, createdAt, readAt = null, fields = {}) {
  return {
    _id: id,
    monitoredAccount: 'account-ir',
    username: 'SignalDesk',
    author: { username: 'SignalDesk', displayName: 'Signal Desk' },
    text: `Post ${id}`,
    postUrl: `https://x.com/SignalDesk/status/${id}`,
    publishedAt: new Date('2026-11-10T12:00:00.000Z'),
    category: 'World News',
    dashboardNotification: { createdAt: new Date(createdAt), readAt: readAt ? new Date(readAt) : null },
    ...fields,
  };
}

const controller = createNotificationController({ postModel: model, accountModel, clock: () => new Date('2026-11-10T13:00:00.000Z') });
const router = createNotificationRouter({ postModel: model, accountModel });

beforeEach(() => { records.length = 0; failQueries = false; monitoredAccounts[0].countryCode = 'IR'; });

function response() {
  return { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; return this; } };
}

async function invoke(handler, { query: requestQuery = {}, id, bearer = token } = {}) {
  const res = response();
  let authorized = false;
  requireAdmin({ params: { id }, query: requestQuery, get: (header) => header === 'authorization' && bearer ? `Bearer ${bearer}` : '' }, res, () => { authorized = true; });
  if (authorized) await handler({ params: { id }, query: requestQuery }, res);
  return { status: res.statusCode, body: res.payload };
}

test('registers protected notification history, unread-count, and read routes', () => {
  assert.equal(router.stack[0].handle, requireAdmin);
  assert.deepEqual(router.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path, methods: Object.keys(layer.route.methods),
  })), [
    { path: '/unread-count', methods: ['get'] },
    { path: '/', methods: ['get'] },
    { path: '/read-all', methods: ['patch'] },
    { path: '/:id/read', methods: ['patch'] },
  ]);
});

test('requires admin authentication before notification access', async () => {
  assert.equal((await invoke(controller.list, { bearer: null })).status, 401);
  assert.equal((await invoke(controller.unreadCount, { bearer: 'invalid' })).status, 401);
});

test('retrieves persisted notification DTOs newest-first with pagination and exact unread count', async () => {
  records.push(
    post('000000000000000000000001', '2026-11-10T12:00:00.000Z'),
    post('000000000000000000000002', '2026-11-10T12:03:00.000Z', '2026-11-10T12:04:00.000Z'),
    post('000000000000000000000003', '2026-11-10T12:02:00.000Z'),
    { _id: '000000000000000000000004', text: 'not a notification' },
  );
  const result = await invoke(controller.list, { query: { page: '1', limit: '2' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });
  assert.equal(result.body.unreadCount, 2);
  assert.deepEqual(result.body.notifications.map((item) => item.notificationId), [
    '000000000000000000000002', '000000000000000000000003',
  ]);
  assert.equal(result.body.notifications[0].read, true);
  assert.equal(result.body.notifications[0].displayName, 'Signal Desk');
  assert.equal(result.body.notifications[0].postUrl, 'https://x.com/SignalDesk/status/000000000000000000000002');
  assert.equal('raw' in result.body.notifications[0], false);
});

test('supports timestamp recovery filters and rejects invalid pagination or cursors', async () => {
  records.push(
    post('000000000000000000000001', '2026-11-10T12:00:00.000Z'),
    post('000000000000000000000002', '2026-11-10T12:02:00.000Z'),
  );
  const since = await invoke(controller.list, { query: { since: '2026-11-10T12:01:00.000Z' } });
  assert.deepEqual(since.body.notifications.map((item) => item.notificationId), ['000000000000000000000002']);
  for (const query of [{ page: '0' }, { limit: '101' }, { page: ['1', '2'] }, { since: 'nope' }, { cursor: 'x' }]) {
    assert.equal((await invoke(controller.list, { query })).status, 400, JSON.stringify(query));
  }
});

test('returns unread count and handles no notification records', async () => {
  records.push(post('000000000000000000000001', '2026-11-10T12:00:00.000Z'));
  assert.deepEqual((await invoke(controller.unreadCount)).body, { unreadCount: 1 });
  assert.equal((await invoke(controller.list)).body.pagination.total, 1);
  records[0].dashboardNotification.readAt = new Date();
  assert.deepEqual((await invoke(controller.unreadCount)).body, { unreadCount: 0 });
  records.length = 0;
  assert.deepEqual((await invoke(controller.list)).body.notifications, []);
});

test('notification country is resolved through the account and reflects reassignment without duplicating records', async () => {
  records.push(post('000000000000000000000008', '2026-11-10T12:00:00.000Z'));
  const initial = await invoke(controller.list);
  assert.equal(initial.body.notifications[0].countryCode, 'IR');
  assert.equal(initial.body.notifications[0].countryName, 'Iran');

  monitoredAccounts[0].countryCode = 'US';
  const moved = await invoke(controller.list, { query: { country: 'US' } });
  assert.equal(moved.body.pagination.total, 1);
  assert.equal(moved.body.notifications[0].notificationId, '000000000000000000000008');
  assert.equal(moved.body.notifications[0].countryCode, 'US');
  assert.equal(moved.body.notifications[0].countryName, 'United States');
  assert.equal(records.length, 1);
});

test('marks one notification read idempotently and distinguishes missing records and IDs', async () => {
  const id = '000000000000000000000001';
  records.push(post(id, '2026-11-10T12:00:00.000Z'));
  const first = await invoke(controller.markRead, { id });
  const second = await invoke(controller.markRead, { id });
  assert.equal(first.body.notification.read, true);
  assert.deepEqual(second.body, first.body);
  assert.equal((await invoke(controller.markRead, { id: 'bad-id' })).status, 400);
  assert.equal((await invoke(controller.markRead, { id: '000000000000000000000099' })).status, 404);
});

test('marks all unread notifications read with an efficient bulk update', async () => {
  records.push(
    post('000000000000000000000001', '2026-11-10T12:00:00.000Z'),
    post('000000000000000000000002', '2026-11-10T12:01:00.000Z'),
    post('000000000000000000000003', '2026-11-10T12:02:00.000Z', '2026-11-10T12:03:00.000Z'),
  );
  assert.deepEqual((await invoke(controller.markAllRead)).body, { updatedCount: 2, unreadCount: 0 });
});

test('database errors return generic responses without leaking internals', async () => {
  failQueries = true;
  assert.deepEqual(await invoke(controller.list), { status: 500, body: { error: 'Could not retrieve notifications' } });
  assert.deepEqual(await invoke(controller.unreadCount), { status: 500, body: { error: 'Could not retrieve unread count' } });
  assert.deepEqual(await invoke(controller.markRead, { id: '000000000000000000000001' }), { status: 500, body: { error: 'Could not update notification' } });
  assert.deepEqual(await invoke(controller.markAllRead), { status: 500, body: { error: 'Could not update notifications' } });
});
