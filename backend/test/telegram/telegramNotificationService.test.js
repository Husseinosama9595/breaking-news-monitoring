import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTelegramNotification,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TelegramNotificationError,
  TelegramNotificationService,
} from '../../src/services/telegramNotificationService.js';

const post = {
  username: 'Reuters',
  text: 'Example local test post.',
  category: 'World News',
  priority: 'HIGH',
  publishedAt: new Date('2026-06-01T10:20:30.000Z'),
  receivedAt: new Date('2026-06-01T10:20:32.000Z'),
  postUrl: 'https://example.invalid/Reuters/status/mock-id',
};

test('formats source, content, priority, timestamps, and original link as plain text', () => {
  const message = formatTelegramNotification(post);
  assert.match(message, /🚨 BREAKING NEWS/);
  assert.match(message, /Source: @Reuters/);
  assert.match(message, /Example local test post\./);
  assert.match(message, /Category: World News/);
  assert.match(message, /Priority: HIGH/);
  assert.match(message, /Published: 2026-06-01 10:20:30 UTC/);
  assert.match(message, /Detected: 2026-06-01 10:20:32 UTC/);
  assert.match(message, /https:\/\/example\.invalid\/Reuters\/status\/mock-id/);
  assert.doesNotMatch(message, /parse_mode|<b>/);
});

test('truncates oversized post text to the Bot API message limit', () => {
  const message = formatTelegramNotification({ ...post, text: 'x'.repeat(6000) });
  assert.ok(Array.from(message).length <= TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.match(message, /\[truncated\]/);
  assert.ok(message.endsWith(post.postUrl));
  const hugeHeader = formatTelegramNotification({ ...post, username: 'u'.repeat(5000), category: 'c'.repeat(5000), text: 'content' });
  assert.ok(Array.from(hugeHeader).length <= TELEGRAM_MAX_MESSAGE_LENGTH);
});

test('keeps Telegram disabled when credentials are absent and reports a typed permanent error', async () => {
  let requests = 0;
  const service = new TelegramNotificationService({ token: '', chatId: '', fetchImpl: async () => { requests += 1; } });
  assert.equal(service.isConfigured(), false);
  await assert.rejects(service.sendNotification(post), (error) => {
    assert.ok(error instanceof TelegramNotificationError);
    assert.equal(error.code, 'TELEGRAM_NOT_CONFIGURED');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(requests, 0);
});

test('rejects an invalid chat ID before making a request', async () => {
  let requests = 0;
  const service = new TelegramNotificationService({ token: 'fake-test-token', chatId: 'not a chat', fetchImpl: async () => { requests += 1; } });
  await assert.rejects(service.sendNotification(post), { code: 'INVALID_CHAT_ID', retryable: false });
  assert.equal(requests, 0);
});

test('sends JSON to the official sendMessage endpoint and returns Telegram message metadata', async () => {
  let captured;
  const service = new TelegramNotificationService({
    token: 'mock-token-for-tests',
    chatId: '@world_news_channel',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 123 } }) };
    },
    clock: () => new Date('2026-06-01T10:20:33.000Z'),
  });
  const result = await service.sendNotification(post);
  assert.equal(captured.url, 'https://api.telegram.org/botmock-token-for-tests/sendMessage');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.body.chat_id, '@world_news_channel');
  assert.match(captured.body.text, /Example local test post\./);
  assert.equal(result.messageId, '123');
  assert.equal(result.chatId, '@world_news_channel');
  assert.equal(result.sentAt.toISOString(), '2026-06-01T10:20:33.000Z');
});

test('classifies request timeout and network errors as retryable without leaking request URL', async () => {
  const timeoutService = new TelegramNotificationService({
    token: 'never-log-this-token', chatId: '-1001234567890', timeoutMs: 100,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(timeoutService.sendNotification(post), (error) => {
    assert.equal(error.code, 'TELEGRAM_TIMEOUT');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /never-log-this-token/);
    return true;
  });

  const networkService = new TelegramNotificationService({
    token: 'never-log-this-token', chatId: '-1001234567890',
    fetchImpl: async () => { throw new Error('socket closed'); },
  });
  await assert.rejects(networkService.sendNotification(post), (error) => {
    assert.equal(error.code, 'TELEGRAM_NETWORK_ERROR');
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes('never-log-this-token'), false);
    return true;
  });
});

test('treats rate limits as retryable and retains Telegram retry_after guidance', async () => {
  const service = new TelegramNotificationService({ token: 'mock-token', chatId: '-1001234567890', fetchImpl: async () => ({
    ok: false, status: 429,
    json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 4 } }),
  }) });
  await assert.rejects(service.sendNotification(post), (error) => {
    assert.equal(error.code, 'TELEGRAM_RATE_LIMITED');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 4000);
    return true;
  });
});

test('treats invalid credentials/chat permissions as permanent API failures', async () => {
  const service = new TelegramNotificationService({ token: 'mock-token', chatId: '-1001234567890', fetchImpl: async () => ({
    ok: false, status: 403,
    json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot is not a channel administrator' }),
  }) });
  await assert.rejects(service.sendNotification(post), (error) => {
    assert.equal(error.code, 'TELEGRAM_API_403');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /mock-token/);
    return true;
  });
});
