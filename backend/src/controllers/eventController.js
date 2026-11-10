import { subscribeToNewPosts } from '../services/postEventService.js';

function encodeEvent(name, value) {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

/** Stream authenticated, process-local post events to one dashboard connection. */
export function createEventController({
  subscribe = subscribeToNewPosts,
  heartbeatMs = 25_000,
  clock = () => new Date(),
} = {}) {
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000) {
    throw new TypeError('heartbeatMs must be an integer of at least 1000 ms');
  }

  const activeStreams = new Set();

  function stream(_req, res) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    let heartbeat;
    let unsubscribe = () => {};
    let closeForShutdown = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      activeStreams.delete(closeForShutdown);
      res.off?.('close', cleanup);
      res.off?.('error', cleanup);
    };
    closeForShutdown = () => {
      cleanup();
      if (!res.destroyed && !res.writableEnded) {
        try { res.end(); } catch { /* The socket may already be closing. */ }
      }
    };
    const write = (chunk) => {
      if (closed || res.destroyed || res.writableEnded) return;
      try {
        if (!res.write(chunk)) {
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
      }
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
    activeStreams.add(closeForShutdown);
    unsubscribe = subscribe((event) => {
      if (!closed) write(encodeEvent('post', event));
    });
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    heartbeat.unref?.();
    write(encodeEvent('connected', { connectedAt: clock().toISOString() }));

    return cleanup;
  }

  function closeAll() {
    for (const closeStream of [...activeStreams]) closeStream();
  }

  return { stream, closeAll };
}

export default createEventController;
