import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';
import { createPostController } from '../../src/controllers/postController.js';
import { createPostRouter } from '../../src/routes/postRoutes.js';

const records = [];
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
    const actual = record[field];
    if (expected && typeof expected === 'object' && expected.$regex) {
      return new RegExp(expected.$regex, expected.$options).test(String(actual ?? ''));
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
          .slice(this.offset, this.offset + this.pageSize);
      },
    };
  },
  async countDocuments(filter) {
    if (databaseFailure) throw new Error('simulated database failure');
    return records.filter((record) => matches(record, filter)).length;
  },
};

const controller = createPostController({ postModel });
const router = createPostRouter({ postModel });

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
