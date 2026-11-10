import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventController } from '../../src/controllers/eventController.js';
import { createAdminToken, requireAdmin } from '../../src/middleware/auth.js';

class FakeResponse extends EventEmitter {
  constructor({ writeResult = true } = {}) {
    super();
    this.headers = {};
    this.chunks = [];
    this.code = null;
    this.writeResult = writeResult;
    this.writableEnded = false;
    this.destroyed = false;
  }
  status(code) { this.code = code; return this; }
  json(value) { this.body = value; return this; }
  set(headers) { Object.assign(this.headers, headers); return this; }
  flushHeaders() { this.flushed = true; }
  write(value) { this.chunks.push(value); return this.writeResult; }
  end() { this.writableEnded = true; }
}

function fakeRequest(token = null) {
  return { get: (header) => header.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : '' };
}

test('rejects an unauthenticated SSE request before subscribing', () => {
  let subscribeCalls = 0;
  const controller = createEventController({ subscribe() { subscribeCalls += 1; return () => {}; } });
  const response = new FakeResponse();
  let nextCalled = false;

  requireAdmin(fakeRequest(), response, () => { nextCalled = true; controller.stream(fakeRequest(), response); });

  assert.equal(response.code, 401);
  assert.equal(nextCalled, false);
  assert.equal(subscribeCalls, 0);
});

test('authenticated SSE sends a connection frame, streams events, and cleans up on disconnect', () => {
  let subscriber;
  let unsubscribeCalls = 0;
  const controller = createEventController({
    subscribe(listener) { subscriber = listener; return () => { unsubscribeCalls += 1; }; },
    clock: () => new Date('2026-11-10T12:00:00.000Z'),
  });
  const response = new FakeResponse();
  const token = createAdminToken();
  const request = fakeRequest(token);

  requireAdmin(request, response, () => controller.stream(request, response));
  assert.equal(response.code, 200);
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(response.headers['Cache-Control'], 'no-cache, no-transform');
  assert.match(response.chunks[0], /^event: connected\ndata:/);
  assert.equal(typeof subscriber, 'function');

  subscriber({ eventId: 'post-1', postId: 'post-1' });
  assert.match(response.chunks[1], /^event: post\ndata:/);
  response.emit('close');
  assert.equal(unsubscribeCalls, 1);
});

test('emits periodic heartbeat comments and stops heartbeats after disconnect', async () => {
  let unsubscribeCalls = 0;
  const controller = createEventController({
    subscribe() { return () => { unsubscribeCalls += 1; }; },
    heartbeatMs: 1000,
  });
  const response = new FakeResponse();
  controller.stream(fakeRequest(), response);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.ok(response.chunks.some((chunk) => chunk === ': heartbeat\n\n'));

  response.emit('close');
  const chunksAfterDisconnect = response.chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(response.chunks.length, chunksAfterDisconnect);
  assert.equal(unsubscribeCalls, 1);
});

test('closes all open SSE streams during graceful shutdown and cleans subscriptions', () => {
  let unsubscribeCalls = 0;
  const controller = createEventController({
    subscribe() { return () => { unsubscribeCalls += 1; }; },
  });
  const response = new FakeResponse();
  controller.stream(fakeRequest(), response);

  controller.closeAll();
  assert.equal(response.writableEnded, true);
  assert.equal(unsubscribeCalls, 1);
  controller.closeAll();
  assert.equal(unsubscribeCalls, 1);
});
