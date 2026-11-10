import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';
import { createCountryController } from '../../src/controllers/countryController.js';
import { createCountryRouter } from '../../src/routes/countryRoutes.js';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';

const groups = [
  { _id: 'IR', accountCount: 2, activeAccountCount: 1, failedPollAccountCount: 1, staleFeedAccountCount: 1, unknownFeedAccountCount: 0, postCount: 15, postsDetectedToday: 3, latestPublishedAt: new Date('2026-11-10T12:00:00.000Z') },
  { _id: null, accountCount: 1, activeAccountCount: 1, failedPollAccountCount: 0, staleFeedAccountCount: 0, unknownFeedAccountCount: 1, postCount: 2, postsDetectedToday: 1, latestPublishedAt: null },
];
let capturedPipeline;
const accountModel = { aggregate: async (pipeline) => { capturedPipeline = pipeline; return groups; } };
const postModel = { collection: { name: 'posts' } };
const controller = createCountryController({ accountModel, postModel, clock: () => new Date('2026-11-10T15:14:15.000Z') });
const router = createCountryRouter({ accountModel, postModel });

function response() {
  return { statusCode: 200, payload: undefined, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
}

test('country API is protected by admin auth and exposes only catalog and overview reads', () => {
  assert.equal(router.stack[0].handle, requireAdmin);
  assert.deepEqual(router.stack.filter((layer) => layer.route).map((layer) => [layer.route.path, Object.keys(layer.route.methods)]), [
    ['/catalog', ['get']], ['/', ['get']],
  ]);
});

test('catalog contains standardized alpha-2 codes and names', async () => {
  const res = response();
  await controller.catalog({}, res);
  assert.ok(res.payload.countries.some((country) => country.countryCode === 'IR' && country.countryName === 'Iran'));
  assert.ok(res.payload.countries.every((country) => /^[A-Z]{2}$/.test(country.countryCode) && country.countryName));
});

test('account schema accepts nullable country assignment, rejects non-ISO codes, and indexes country monitoring queries', async () => {
  const indexes = MonitoredAccount.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.platform === 1 && keys.countryCode === 1 && options.name === 'account_country_monitoring'));
  const valid = new MonitoredAccount({ platform: 'x', username: 'countryDesk', normalizedUsername: 'countrydesk', providerName: 'nitter', countryCode: 'IR' });
  assert.equal(valid.countryCode, 'IR');
  const invalid = new MonitoredAccount({ platform: 'x', username: 'badCountry', normalizedUsername: 'badcountry', providerName: 'nitter', countryCode: 'ZZ' });
  await assert.rejects(invalid.validate(), /countryCode/);
  const unassigned = new MonitoredAccount({ platform: 'x', username: 'unassigned', normalizedUsername: 'unassigned', providerName: 'mock', countryCode: null });
  assert.equal(unassigned.countryCode, null);
});

test('overview groups actual account-linked post counts, includes unassigned totals, and uses UTC day boundary', async () => {
  const res = response();
  await controller.list({}, res);
  assert.deepEqual(res.payload.totals, { countryCount: 1, accountCount: 3, activeAccountCount: 2, postCount: 17, postsDetectedToday: 4 });
  assert.equal(res.payload.countries[0].countryName, 'Iran');
  assert.equal(res.payload.unassigned.accountCount, 1);
  assert.equal(res.payload.dayStartsAt, '2026-11-10T00:00:00.000Z');
  assert.equal(capturedPipeline[1].$lookup.from, 'posts');
  assert.deepEqual(capturedPipeline[1].$lookup.pipeline[0].$match.$expr, { $eq: ['$monitoredAccount', '$$accountId'] });
  assert.deepEqual(capturedPipeline[0].$match, { platform: 'x' });
});
