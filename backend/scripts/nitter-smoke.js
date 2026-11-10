import { performance } from 'node:perf_hooks';
import { env } from '../src/config/environment.js';
import { NitterProvider } from '../src/providers/nitterProvider.js';

const username = String(process.argv[2] ?? '').trim().replace(/^@/, '');
if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
  console.error('Usage: npm run smoke:nitter -- <public-x-username>');
  process.exitCode = 2;
} else if (!env.nitterInstances.length) {
  console.error('No Nitter instances are configured in NITTER_INSTANCES.');
  process.exitCode = 1;
} else {
  let available = 0;
  for (const instance of env.nitterInstances) {
    const provider = new NitterProvider({
      instances: [instance],
      instanceTimeoutMs: env.nitterInstanceTimeoutMs,
      cooldownMs: env.nitterInstanceCooldownMs,
    });
    const startedAt = performance.now();
    try {
      const batch = await provider.fetchRecentPosts({ username, platform: 'x' }, {
        timeoutMs: env.feedPollTimeoutMs,
        limit: 50,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const instanceState = provider.getInstanceHealth()[0];
      available += 1;
      console.log(`${instance}: HTTP ${instanceState.lastStatusCode ?? 'unknown'}, ${durationMs} ms, ${batch.posts.length} entries`);
      for (const post of batch.posts.slice(0, 3)) {
        console.log(`  ID=${post.canonicalPostId ?? post.providerPostId} Published=${post.publishedAt?.toISOString() ?? 'unknown'} URL=${post.postUrl ?? 'unavailable'}`);
      }
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      const instanceState = provider.getInstanceHealth()[0];
      console.log(`${instance}: HTTP ${instanceState.lastStatusCode ?? 'unavailable'}, ${durationMs} ms, failed (${error.code ?? 'NITTER_REQUEST_FAILED'})`);
    }
  }
  console.log(`Nitter smoke test: ${available}/${env.nitterInstances.length} configured instance(s) returned a usable feed for @${username}. No database or Telegram connection was used.`);
  if (available === 0) process.exitCode = 1;
}
