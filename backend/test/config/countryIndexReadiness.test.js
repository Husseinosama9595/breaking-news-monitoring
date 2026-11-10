import test from 'node:test';
import assert from 'node:assert/strict';
import MonitoredAccount from '../../src/models/MonitoredAccount.js';
import { ensureCountryMonitoringIndex } from '../../src/config/database.js';

test('country monitoring index readiness creates only the declared non-destructive index', async () => {
  const calls = [];
  const collection = { async createIndex(keys, options) { calls.push({ keys, options }); return options.name; } };
  const result = await ensureCountryMonitoringIndex({ collection });
  assert.equal(result, 'account_country_monitoring');
  assert.deepEqual(calls, [{
    keys: { platform: 1, countryCode: 1, enabled: 1, monitoringStatus: 1 },
    options: { name: 'account_country_monitoring' },
  }]);
  assert.ok(MonitoredAccount.schema.indexes().some(([keys, options]) =>
    JSON.stringify(keys) === JSON.stringify(calls[0].keys) && options.name === calls[0].options.name));
});

test('country index initialization failure propagates so startup cannot serve without readiness', async () => {
  const failure = new Error('index initialization failed');
  await assert.rejects(ensureCountryMonitoringIndex({ collection: { createIndex: async () => { throw failure; } } }), failure);
});
