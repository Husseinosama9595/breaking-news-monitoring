import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';
import { createAccountController } from '../../src/controllers/accountController.js';
import { createAccountRouter } from '../../src/routes/accountRoutes.js';

const accounts = [];
let nextId = 1;
const token = createAdminToken();
const registry = { list: () => ['mock', 'nitter'], getDefaultName: () => 'mock' };

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matches(account, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return expected.every((clause) => matches(account, clause));
    if (key === '$or') return expected.some((clause) => matches(account, clause));
    if (key === '_id' && expected && typeof expected === 'object' && '$ne' in expected) {
      return account._id !== String(expected.$ne);
    }
    if (expected && typeof expected === 'object' && '$exists' in expected) return expected.$exists ? key in account : !(key in account);
    if (expected && typeof expected === 'object' && '$regex' in expected) return new RegExp(expected.$regex, expected.$options).test(String(account[key] ?? ''));
    if (expected === null) return account[key] == null;
    return String(account[key]) === String(expected);
  });
}

function query(operation) {
  let offset = 0;
  let pageSize = Number.POSITIVE_INFINITY;
  return {
    select() { return this; },
    sort() { return this; },
    skip(value) { offset = value; return this; },
    limit(value) { pageSize = value; return this; },
    async lean() { const result = await operation(); return clone(Array.isArray(result) ? result.slice(offset, offset + pageSize) : result); },
  };
}

const accountModel = {
  find(filter) { return query(() => accounts.filter((account) => matches(account, filter))); },
  findOne(filter) { return query(() => accounts.find((account) => matches(account, filter)) ?? null); },
  findById(id) { return query(() => accounts.find((account) => account._id === String(id)) ?? null); },
  async countDocuments(filter) { return accounts.filter((account) => matches(account, filter)).length; },
  findOneAndUpdate(filter, update) {
    return query(() => {
      const account = accounts.find((item) => matches(item, filter));
      if (!account) return null;
      Object.assign(account, clone(update.$set), { updatedAt: new Date() });
      return account;
    });
  },
  async create(fields) {
    if (accounts.some((account) => account.platform === fields.platform
      && account.normalizedUsername === fields.normalizedUsername)) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    const now = new Date();
    const account = {
      _id: String(nextId++).padStart(24, '0'),
      displayName: null,
      notificationBaselineAt: null,
      lastSuccessfulFetchAt: null,
      ...clone(fields),
      createdAt: now,
      updatedAt: now,
    };
    accounts.push(account);
    return clone(account);
  },
};

const controller = createAccountController({ accountModel, registry, providerMode: 'account' });
const router = createAccountRouter({ accountModel, registry, providerMode: 'account' });

async function invoke(handler, { id, body, query = {} } = {}) {
  const response = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handler({ params: { id }, body, query }, response);
  return { status: response.statusCode, body: response.payload };
}

beforeEach(() => {
  accounts.length = 0;
  nextId = 1;
});

test('registers all requested routes behind requireAdmin and rejects unauthenticated requests', () => {
  assert.equal(router.stack[0].handle, requireAdmin, 'router-wide admin middleware runs before route handlers');
  const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods),
  }));
  assert.deepEqual(routes, [
    { path: '/', methods: ['get'] },
    { path: '/', methods: ['post'] },
    { path: '/:id', methods: ['get'] },
    { path: '/:id/enable', methods: ['patch'] },
    { path: '/:id/disable', methods: ['patch'] },
    { path: '/:id', methods: ['patch'] },
  ]);

  const response = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; return this; } };
  let nextCalled = false;
  requireAdmin({ get: () => '' }, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
  requireAdmin({ get: () => 'Bearer invalid-token' }, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);

  let authenticatedNext = false;
  requireAdmin({ get: (header) => header === 'authorization' ? `Bearer ${token}` : '' }, response, () => { authenticatedNext = true; });
  assert.equal(authenticatedNext, true);
});

test('creates and lists an account with schema defaults and a pending Nitter baseline', async () => {
  const created = await invoke(controller.create, { body: { username: '@Reuters', category: 'World News', providerName: 'nitter' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.username, 'Reuters');
  assert.equal(created.body.account.platform, 'x');
  assert.equal(created.body.account.normalizedUsername, undefined);
  assert.equal(created.body.account.providerName, 'nitter');
  assert.equal(created.body.account.enabled, true);
  assert.equal(created.body.account.monitoringStatus, 'active');
  assert.equal(created.body.account.notificationBaselineAt, undefined, 'internal baseline is not exposed in the API DTO');
  assert.equal(accounts[0].notificationBaselineAt, null, 'first successful Nitter poll establishes the baseline');

  const listed = await invoke(controller.list);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.accounts.length, 1);
  assert.deepEqual(listed.body.accounts[0].pollHealth, {
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastStatus: null,
    lastErrorCode: null,
    returnedEntryCount: null,
    insertedPostCount: null,
    duplicatePostCount: null,
    feedObservedAt: null,
    newestPublishedAt: null,
    timestampedEntryCount: null,
    untimestampedEntryCount: null,
    freshness: 'unknown',
    freshnessMaxAgeMs: listed.body.accounts[0].pollHealth.freshnessMaxAgeMs,
  });
  assert.equal('lastError' in listed.body.accounts[0], false, 'internal error text is not exposed');
});

test('supports country assignment and filtering without exposing or resetting the Nitter baseline', async () => {
  const created = await invoke(controller.create, { body: { username: 'CountrySource', countryCode: 'ir' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.countryCode, 'IR');
  assert.equal(created.body.account.countryName, 'Iran');
  const account = accounts[0];
  account.notificationBaselineAt = new Date('2026-11-10T10:00:00.000Z');
  const updated = await invoke(controller.update, { id: account._id, body: { countryCode: 'US' } });
  assert.equal(updated.body.account.countryCode, 'US');
  assert.equal(account.notificationBaselineAt.toISOString(), '2026-11-10T10:00:00.000Z');
  assert.equal((await invoke(controller.list, { query: { country: 'US' } })).body.accounts.length, 1);
  assert.equal((await invoke(controller.list, { query: { country: 'unassigned' } })).body.accounts.length, 0);
});

test('rejects country assignments that are not valid ISO alpha-2 codes', async () => {
  assert.equal((await invoke(controller.create, { body: { username: 'InvalidCode', countryCode: 'ZZ' } })).status, 400);
  assert.equal((await invoke(controller.create, { body: { username: 'InvalidCode', countryCode: ['IR'] } })).status, 400);
});

test('retrieves one account and returns 404 for a missing account', async () => {
  await invoke(controller.create, { body: { username: 'Reuters' } });
  const id = accounts[0]._id;
  const found = await invoke(controller.getById, { id });
  assert.equal(found.status, 200);
  assert.equal(found.body.account.username, 'Reuters');
  assert.equal((await invoke(controller.getById, { id: '000000000000000000000099' })).status, 404);
  assert.equal((await invoke(controller.getById, { id: 'invalid-id' })).status, 400);
});

test('exposes polling health and freshness while omitting internal error text', async () => {
  await invoke(controller.create, { body: { username: 'FreshnessSource', providerName: 'nitter' } });
  const startedAt = new Date('2026-11-10T10:00:00.000Z');
  const completedAt = new Date('2026-11-10T10:00:02.000Z');
  const newestPublishedAt = new Date('2026-11-10T09:59:00.000Z');
  Object.assign(accounts[0], {
    lastPollAttemptAt: startedAt,
    lastPollCompletedAt: completedAt,
    lastPollDurationMs: 2000,
    lastPollStatus: 'success',
    lastPollEntryCount: 3,
    lastPollInsertedCount: 2,
    lastPollDuplicateCount: 1,
    lastProviderFeedObservedAt: completedAt,
    lastProviderFeedLatestPublishedAt: newestPublishedAt,
    lastProviderFeedTimestampedEntryCount: 2,
    lastProviderFeedUntimestampedEntryCount: 1,
    lastProviderFeedFreshnessStatus: 'fresh',
    lastError: 'internal diagnostic text must not be returned',
  });

  const response = await invoke(controller.list);
  assert.deepEqual(response.body.accounts[0].pollHealth, {
    lastStartedAt: startedAt,
    lastCompletedAt: completedAt,
    lastDurationMs: 2000,
    lastStatus: 'success',
    lastErrorCode: null,
    returnedEntryCount: 3,
    insertedPostCount: 2,
    duplicatePostCount: 1,
    feedObservedAt: completedAt,
    newestPublishedAt,
    timestampedEntryCount: 2,
    untimestampedEntryCount: 1,
    freshness: 'fresh',
    freshnessMaxAgeMs: response.body.accounts[0].pollHealth.freshnessMaxAgeMs,
  });
  assert.equal('lastError' in response.body.accounts[0], false);
});

test('updates supported account fields without changing the established baseline', async () => {
  await invoke(controller.create, { body: { username: 'Reuters', providerName: 'nitter' } });
  const baselineAt = new Date('2026-11-10T10:00:00.000Z');
  accounts[0].notificationBaselineAt = baselineAt;
  const response = await invoke(controller.update, {
    id: accounts[0]._id,
    body: { username: 'ReutersWorld', displayName: 'Reuters World', category: 'World News', providerName: 'mock' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.account.username, 'ReutersWorld');
  assert.equal(response.body.account.providerName, 'mock');
  assert.equal(accounts[0].notificationBaselineAt.toISOString(), baselineAt.toISOString());
});

test('enables and disables monitoring using existing enabled and monitoringStatus fields', async () => {
  await invoke(controller.create, { body: { username: 'Reuters' } });
  const id = accounts[0]._id;
  assert.equal((await invoke(controller.disable, { id })).status, 200);
  assert.equal(accounts[0].enabled, false);
  assert.equal(accounts[0].monitoringStatus, 'paused');
  assert.equal((await invoke(controller.enable, { id })).status, 200);
  assert.equal(accounts[0].enabled, true);
  assert.equal(accounts[0].monitoringStatus, 'active');
});

test('rejects invalid usernames, categories, providers, IDs, and client-supplied internal fields', async () => {
  for (const body of [
    { username: 'not a username' },
    { username: 'Reuters', category: 'Unlisted' },
    { username: 'Reuters', providerName: 'rsshub' },
    { username: 'Reuters', notificationBaselineAt: '2026-11-10T10:00:00.000Z' },
    { username: 'Reuters', enabled: false },
  ]) assert.equal((await invoke(controller.create, { body })).status, 400);
  assert.equal((await invoke(controller.update, { id: 'invalid-id', body: { category: 'Politics' } })).status, 400);
  assert.equal((await invoke(controller.update, {
    id: '000000000000000000000001', body: { notificationBaselineAt: new Date().toISOString() },
  })).status, 400);
  assert.equal((await invoke(controller.enable, {
    id: '000000000000000000000001', body: { notificationBaselineAt: new Date().toISOString() },
  })).status, 400);
});

test('prevents duplicate usernames regardless of case or leading @', async () => {
  assert.equal((await invoke(controller.create, { body: { username: '@Reuters' } })).status, 201);
  const duplicate = await invoke(controller.create, { body: { username: 'reuters' } });
  assert.equal(duplicate.status, 409);
  await invoke(controller.create, { body: { username: 'OtherSource' } });
  const duplicateUpdate = await invoke(controller.update, {
    id: accounts[1]._id,
    body: { username: 'REUTERS' },
  });
  assert.equal(duplicateUpdate.status, 409);
  assert.equal(accounts.length, 2);
});

test('searches usernames and display names case-insensitively with partial and optional-@ matching', async () => {
  await invoke(controller.create, { body: { username: 'realDonaldTrump', displayName: 'Donald Trump' } });
  await invoke(controller.create, { body: { username: 'CNN', displayName: 'Cable News Network' } });
  await invoke(controller.create, { body: { username: 'elonmusk', displayName: 'Elon Musk' } });
  for (const search of ['trum', 'TRUM', '@trum', 'donald tr']) {
    const response = await invoke(controller.list, { query: { search: `  ${search}  ` } });
    assert.deepEqual(response.body.accounts.map((account) => account.username), ['realDonaldTrump']);
  }
  for (const search of ['elonmusk', 'elon', 'ELON', '@elon', '@elonmusk', '  elon  ']) {
    const response = await invoke(controller.list, { query: { search } });
    assert.deepEqual(response.body.accounts.map((account) => account.username), ['elonmusk'], `search=${search}`);
  }
  assert.deepEqual((await invoke(controller.list, { query: { search: '@cnn' } })).body.accounts.map((account) => account.username), ['CNN']);
  assert.deepEqual((await invoke(controller.list, { query: { search: '.*' } })).body.accounts, [], 'regex metacharacters are treated literally');
  assert.equal((await invoke(controller.list, { query: { search: '   ' } })).body.accounts.length, 3);
});

test('combines account search with country and unassigned filters on the server', async () => {
  await invoke(controller.create, { body: { username: 'IranDesk', displayName: 'Tehran Monitor', countryCode: 'IR' } });
  await invoke(controller.create, { body: { username: 'IranAnalyst', displayName: 'Unassigned Iran source' } });
  await invoke(controller.create, { body: { username: 'OtherSource', countryCode: 'US' } });
  assert.deepEqual((await invoke(controller.list, { query: { country: 'IR', search: 'iran' } })).body.accounts.map((account) => account.username), ['IranDesk']);
  assert.deepEqual((await invoke(controller.list, { query: { country: 'unassigned', search: 'IRAN' } })).body.accounts.map((account) => account.username), ['IranAnalyst']);
  assert.deepEqual((await invoke(controller.list, { query: { country: 'US', search: 'iran' } })).body.accounts, []);
});

test('paginates account search results and reports the filtered result count', async () => {
  for (const username of ['SourceOne', 'SourceTwo', 'SourceThree']) {
    await invoke(controller.create, { body: { username, displayName: 'Shared News Desk' } });
  }
  const first = await invoke(controller.list, { query: { search: 'news', page: '1', limit: '2' } });
  const second = await invoke(controller.list, { query: { search: 'NEWS', page: '2', limit: '2' } });
  assert.deepEqual(first.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });
  assert.deepEqual(second.body.pagination, { page: 2, limit: 2, total: 3, totalPages: 2 });
  assert.equal(first.body.accounts.length, 2);
  assert.equal(second.body.accounts.length, 1);
  assert.equal((await invoke(controller.list, { query: { page: '1', limit: '101' } })).status, 400);
  assert.equal((await invoke(controller.list, { query: { search: ['Reuters', 'CNN'] } })).status, 400);
  assert.equal((await invoke(controller.list, { query: { search: 'x'.repeat(121) } })).status, 400);
  assert.equal((await invoke(controller.list, { query: { status: 'unknown' } })).status, 400);
});
