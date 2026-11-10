import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';
import { createPostController } from '../../src/controllers/postController.js';
import { createPostRouter } from '../../src/routes/postRoutes.js';

const records = [];
const monitoredAccounts = [
  { _id: 'account-ir', platform: 'x', countryCode: 'IR' },
  { _id: 'account-us', platform: 'x', countryCode: 'US' },
  { _id: 'account-none', platform: 'x', countryCode: null },
];
let databaseFailure = false;
const token = createAdminToken();

function post(id, fields = {}) {
  const now = new Date('2026-11-10T12:00:00.000Z');
  return {
    _id: id,
    username: 'Reuters',
    author: { username: 'Reuters', displayName: 'Reuters' },
    text: `Post ${id}`,
    publishedAt: now,
    postUrl: `https://x.com/Reuters/status/${id}`,
    category: 'World News',
    providerName: 'nitter',
    priority: 'HIGH',
    processingStatus: 'processed',
    notificationStatus: 'sent',
    telegramSent: true,
    createdAt: now,
    raw: { shouldNeverBeReturned: true },
    notificationError: 'private internal error',
    telegramMessageId: 'private-message-id',
    ...fields,
  };
}

function matches(record, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$and') return expected.every((clause) => matches(record, clause));
    if (field === '$or') return expected.some((clause) => matches(record, clause));
    const actual = record[field];
    if (field === 'monitoredAccount' && expected?.$in) return expected.$in.includes(actual);
    if (expected && typeof expected === 'object' && expected.$regex) {
      const value = field.includes('.') ? field.split('.').reduce((item, key) => item?.[key], record) : actual;
      return new RegExp(expected.$regex, expected.$options).test(String(value ?? ''));
    }
    return actual === expected;
  });
}

const postModel = {
  find(filter) {
    if (databaseFailure) throw new Error('simulated database failure');
    return {
      sortOrder: { publishedAt: -1, createdAt: -1, _id: -1 },
      offset: 0,
      pageSize: 20,
      select(fields) { this.selectedFields = fields; return this; },
      populate() { this.populateAccount = true; return this; },
      sort(order) { this.sortOrder = order; return this; },
      skip(value) { this.offset = value; return this; },
      limit(value) { this.pageSize = value; return this; },
      async lean() {
        if (databaseFailure) throw new Error('simulated database failure');
        return records.filter((record) => matches(record, filter))
          .sort((left, right) => {
            for (const [field, direction] of Object.entries(this.sortOrder)) {
              const a = left[field] instanceof Date ? left[field].getTime() : left[field];
              const b = right[field] instanceof Date ? right[field].getTime() : right[field];
              if (a < b) return -1 * direction;
              if (a > b) return direction;
            }
            return 0;
          })
          .slice(this.offset, this.offset + this.pageSize)
          .map((record) => this.populateAccount
            ? ({ ...record, monitoredAccount: monitoredAccounts.find((account) => account._id === record.monitoredAccount) ?? null })
            : record);
      },
    };
  },
  async countDocuments(filter) {
    if (databaseFailure) throw new Error('simulated database failure');
    return records.filter((record) => matches(record, filter)).length;
  },
};

const accountModel = {
  find(filter) {
    return {
      select() { return this; },
      async lean() {
        if (filter.countryCode) return monitoredAccounts.filter((account) => account.countryCode === filter.countryCode);
        if (filter.$or) return monitoredAccounts.filter((account) => account.countryCode == null);
        return monitoredAccounts;
      },
    };
  },
};

const controller = createPostController({ postModel, accountModel });
const router = createPostRouter({ postModel, accountModel });

beforeEach(() => {
  records.length = 0;
  databaseFailure = false;
});

async function invoke(query = {}, bearer = token) {
  const response = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let authorized = false;
  requireAdmin({ get: (header) => header === 'authorization' && bearer ? `Bearer ${bearer}` : '' }, response, () => {
    authorized = true;
  });
  if (authorized) await controller.list({ query }, response);
  return { status: response.statusCode, body: response.payload };
}

test('registers only GET / behind router-wide admin authentication', () => {
  assert.equal(router.stack[0].handle, requireAdmin);
  const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods),
  }));
  assert.deepEqual(routes, [{ path: '/', methods: ['get'] }]);
});

test('rejects unauthenticated and invalid-JWT requests', async () => {
  assert.deepEqual(await invoke({}, null), { status: 401, body: { error: 'Authentication required' } });
  assert.deepEqual(await invoke({}, 'invalid-token'), { status: 401, body: { error: 'Invalid or expired authentication token' } });
});

test('returns authenticated posts newest-first with safe fields and default pagination', async () => {
  records.push(
    post('older', { publishedAt: new Date('2026-11-10T09:00:00.000Z') }),
    post('newer', { publishedAt: new Date('2026-11-10T11:00:00.000Z') }),
  );

  const response = await invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });
  assert.deepEqual(response.body.posts.map((item) => item._id), ['newer', 'older']);
  assert.deepEqual(response.body.posts[0], {
    _id: 'newer', username: 'Reuters', author: { username: 'Reuters', displayName: 'Reuters' },
    text: 'Post newer', publishedAt: new Date('2026-11-10T11:00:00.000Z'),
    postUrl: 'https://x.com/Reuters/status/newer', category: 'World News', providerName: 'nitter',
    priority: 'HIGH', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true,
    monitoredAccountId: null, countryCode: null, countryName: null,
    createdAt: new Date('2026-11-10T12:00:00.000Z'),
  });
  assert.equal('raw' in response.body.posts[0], false);
  assert.equal('notificationError' in response.body.posts[0], false);
  assert.equal('telegramMessageId' in response.body.posts[0], false);
});

test('returns an empty result with zero total pages', async () => {
  assert.deepEqual(await invoke(), {
    status: 200,
    body: { posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
  });
});

test('country filter scopes posts through the current monitored-account relationship', async () => {
  records.push(
    post('iran-post', { monitoredAccount: 'account-ir' }),
    post('us-post', { monitoredAccount: 'account-us' }),
    post('unassigned-post', { monitoredAccount: 'account-none' }),
  );
  const iran = await invoke({ country: 'IR' });
  assert.equal(iran.status, 200);
  assert.deepEqual(iran.body.posts.map((item) => item._id), ['iran-post']);
  assert.equal(iran.body.posts[0].countryCode, 'IR');
  assert.equal(iran.body.posts[0].countryName, 'Iran');
  assert.equal('monitoredAccount' in iran.body.posts[0], false);

  const unassigned = await invoke({ country: 'unassigned' });
  assert.deepEqual(unassigned.body.posts.map((item) => item._id), ['unassigned-post']);
  assert.equal(unassigned.body.posts[0].countryCode, null);
});

test('rejects invalid or repeated country filters', async () => {
  assert.equal((await invoke({ country: 'ZZ' })).status, 400);
  assert.equal((await invoke({ country: ['IR', 'US'] })).status, 400);
});

test('applies page and limit pagination after newest-first sorting', async () => {
  for (let index = 1; index <= 5; index += 1) {
    records.push(post(`p${index}`, { publishedAt: new Date(`2026-11-10T0${index}:00:00.000Z`) }));
  }

  const response = await invoke({ page: '2', limit: '2' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });
  assert.deepEqual(response.body.posts.map((item) => item._id), ['p3', 'p2']);
});

test('supports exact case-insensitive username, category, and notification status filters', async () => {
  records.push(
    post('reuters', { username: 'Reuters', category: 'World News', notificationStatus: 'sent' }),
    post('other', { username: 'NASA', category: 'Technology', notificationStatus: 'pending' }),
  );

  assert.deepEqual((await invoke({ username: '@reuters' })).body.posts.map((item) => item._id), ['reuters']);
  assert.deepEqual((await invoke({ category: 'Technology' })).body.posts.map((item) => item._id), ['other']);
  assert.deepEqual((await invoke({ notificationStatus: 'pending' })).body.posts.map((item) => item._id), ['other']);
});

test('search matches post text and author identity case-insensitively, partially, and with optional @', async () => {
  records.push(
    post('content-match', { username: 'sourceA', author: { username: 'sourceA', displayName: 'Desk A' }, text: 'Major Trump development in Iran' }),
    post('username-match', { username: 'CNNWorld', author: { username: 'CNNWorld', displayName: 'Cable News' }, text: 'A separate update' }),
    post('display-match', { username: 'sourceC', author: { username: 'sourceC', displayName: 'Donald Trump Reporter' }, text: 'Another update' }),
    post('elon-match', { username: 'elonmusk', author: { username: 'elonmusk', displayName: 'Elon Musk' }, text: 'A reusable test fixture includes a rocket update' }),
  );
  assert.deepEqual((await invoke({ search: '  TRUM  ' })).body.posts.map((item) => item._id).sort(), ['content-match', 'display-match']);
  assert.deepEqual((await invoke({ search: '@cnn' })).body.posts.map((item) => item._id), ['username-match']);
  assert.deepEqual((await invoke({ search: 'separate' })).body.posts.map((item) => item._id), ['username-match']);
  for (const search of ['elon', 'ELON', '@elon', '@elonmusk', '  rocket up  ']) {
    assert.deepEqual((await invoke({ search })).body.posts.map((item) => item._id), ['elon-match'], `search=${search}`);
  }
  assert.deepEqual((await invoke({ username: 'elon' })).body.posts, [], 'username remains the exact-match API filter');
  assert.deepEqual((await invoke({ username: '@elonmusk' })).body.posts.map((item) => item._id), ['elon-match']);
  assert.equal((await invoke({ search: '.*' })).body.pagination.total, 0, 'regex metacharacters are treated literally');
});

test('combines post search with country, account, category filters and filtered pagination counts', async () => {
  records.push(
    post('iran-trump-a', { monitoredAccount: 'account-ir', username: 'Reuters', text: 'Trump update A' }),
    post('iran-trump-b', { monitoredAccount: 'account-ir', username: 'Reuters', text: 'Trump update B' }),
    post('iran-other', { monitoredAccount: 'account-ir', username: 'Reuters', text: 'Economic update' }),
    post('us-trump', { monitoredAccount: 'account-us', username: 'Reuters', text: 'Trump update US' }),
  );
  const first = await invoke({ country: 'IR', search: 'trump', username: '@reuters', category: 'World News', page: '1', limit: '1' });
  assert.deepEqual(first.body.pagination, { page: 1, limit: 1, total: 2, totalPages: 2 });
  assert.equal(first.body.posts.length, 1);
  const second = await invoke({ country: 'IR', search: 'TRUMP', username: 'Reuters', category: 'World News', page: '2', limit: '1' });
  assert.deepEqual(second.body.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
  assert.equal(second.body.posts.length, 1);
  assert.equal((await invoke({ country: 'unassigned', search: 'trump' })).body.pagination.total, 0);
});

test('rejects malformed, out-of-range, repeated, and unsupported query parameters', async () => {
  for (const query of [
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'nope' }, { page: '9007199254740992' },
    { page: '90071992547411', limit: '100' },
    { limit: '0' }, { limit: '101' }, { limit: ['1', '2'] }, { username: 'bad name' },
    { category: 'Unlisted' }, { notificationStatus: 'unknown' }, { raw: 'true' },
  ]) {
    const response = await invoke(query);
    assert.equal(response.status, 400, `${JSON.stringify(query)} should be rejected`);
    assert.equal(typeof response.body.error, 'string');
  }
});

test('returns a generic server error when the database query fails', async () => {
  databaseFailure = true;
  assert.deepEqual(await invoke(), { status: 500, body: { error: 'Could not retrieve posts' } });
});
