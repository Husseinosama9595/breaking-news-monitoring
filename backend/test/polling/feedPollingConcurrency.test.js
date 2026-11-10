import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedPollingService } from '../../src/services/feedPollingService.js';
import { FeedProviderError } from '../../src/providers/providerErrors.js';

const quietLogger = { info() {}, warn() {}, error() {} };

function makeAccount(username) {
  return { _id: username, username, category: 'Other', platform: 'x', providerName: 'mock' };
}

function makeService({ accounts, provider, options = {} }) {
  let accountQueries = 0;
  const service = new FeedPollingService({
    registry: { get: (name) => name === 'mock' ? provider : null, getDefaultName: () => 'mock' },
    accountModel: {
      find() {
        accountQueries += 1;
        return { lean: async () => accounts };
      },
      async updateOne() { return { modifiedCount: 1 }; },
    },
    ingest: async ({ batch }) => ({
      receivedCount: batch.posts.length,
      insertedCount: batch.posts.length,
      duplicateCount: 0,
    }),
    providerNameMode: 'mock',
    intervalMs: 45000,
    timeoutMs: 1000,
    freshnessMaxAgeMs: 60_000,
    logger: quietLogger,
    ...options,
  });
  return { service, get accountQueries() { return accountQueries; } };
}

function batch() {
  return { providerName: 'mock', posts: [], fetchedAt: new Date() };
}

test('bounds concurrent account requests and eventually polls every eligible account', async () => {
  const accounts = Array.from({ length: 9 }, (_, index) => makeAccount(`source-${index}`));
  let active = 0;
  let maximumActive = 0;
  const attempted = [];
  const provider = {
    name: 'mock',
    async fetchRecentPosts({ username }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      attempted.push(username);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return batch();
    },
  };
  const { service } = makeService({ accounts, provider, options: { concurrency: 2, jitterMs: 0 } });

  const result = await service.pollOnce();

  assert.equal(maximumActive, 2);
  assert.deepEqual(new Set(attempted), new Set(accounts.map(({ username }) => username)));
  assert.equal(result.accountCount, accounts.length);
  assert.equal(result.results.filter(({ status }) => status === 'success').length, accounts.length);
});

test('jitter is applied without allowing an overlapping cycle to start', async () => {
  const accounts = [makeAccount('source-a'), makeAccount('source-b')];
  let releaseFirstWait;
  let waitCount = 0;
  const wait = async (milliseconds) => {
    assert.equal(milliseconds, 10);
    waitCount += 1;
    if (waitCount === 1) await new Promise((resolve) => { releaseFirstWait = resolve; });
  };
  let providerCalls = 0;
  const provider = {
    name: 'mock',
    async fetchRecentPosts() { providerCalls += 1; return batch(); },
  };
  const harness = makeService({
    accounts,
    provider,
    options: { concurrency: 1, jitterMs: 20, random: () => 0.5, wait },
  });

  const firstCycle = harness.service.pollOnce();
  while (waitCount === 0) await new Promise((resolve) => setImmediate(resolve));
  const joinedCycle = harness.service.pollOnce();
  assert.equal(harness.accountQueries, 1);
  assert.equal(providerCalls, 0);

  releaseFirstWait();
  const [firstResult, joinedResult] = await Promise.all([firstCycle, joinedCycle]);
  assert.equal(firstResult, joinedResult);
  assert.equal(firstResult.accountCount, 2);
  assert.equal(providerCalls, 2);
  assert.equal(waitCount, 2);
});

test('an account failure is isolated and does not interrupt later polling attempts', async () => {
  const accounts = ['good-a', 'bad', 'good-b'].map(makeAccount);
  const attempted = [];
  const provider = {
    name: 'mock',
    async fetchRecentPosts({ username }) {
      attempted.push(username);
      if (username === 'bad') {
        throw new FeedProviderError('simulated source failure', {
          providerName: 'mock', code: 'MOCK_RETRYABLE_ERROR', retryable: true,
        });
      }
      return batch();
    },
  };
  const { service } = makeService({ accounts, provider, options: { concurrency: 1, jitterMs: 0 } });

  const result = await service.pollOnce();

  assert.deepEqual(attempted, ['good-a', 'bad', 'good-b']);
  assert.deepEqual(result.results.map(({ status }) => status), ['success', 'failed', 'success']);
  assert.equal(result.status, 'partial');
});

test('a jitter-source error does not stop account polling', async () => {
  let calls = 0;
  const provider = { name: 'mock', async fetchRecentPosts() { calls += 1; return batch(); } };
  const { service } = makeService({
    accounts: [makeAccount('source-a')],
    provider,
    options: { concurrency: 1, jitterMs: 20, random: () => { throw new Error('random unavailable'); } },
  });

  const result = await service.pollOnce();

  assert.equal(result.status, 'success');
  assert.equal(calls, 1);
});

test('shutdown clears future scheduling and waits for active polling to settle', async () => {
  let releaseFetch;
  let startedFetch;
  const fetchStarted = new Promise((resolve) => { startedFetch = resolve; });
  let calls = 0;
  const provider = {
    name: 'mock',
    async fetchRecentPosts() {
      calls += 1;
      startedFetch();
      await new Promise((resolve) => { releaseFetch = resolve; });
      return batch();
    },
  };
  const { service } = makeService({
    accounts: [makeAccount('source-a'), makeAccount('source-b'), makeAccount('source-c')], provider,
    options: { concurrency: 1, jitterMs: 0, intervalMs: 45_000 },
  });

  assert.equal(service.start(), true);
  await fetchStarted;
  let stopped = false;
  const stopPromise = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(service.timer, null);

  releaseFetch();
  await stopPromise;
  assert.equal(stopped, true);
  assert.equal((await service.pollOnce()).status, 'stopped');
  assert.equal(calls, 1);
});
