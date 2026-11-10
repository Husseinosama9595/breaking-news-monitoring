import { assertFeedProvider } from './feedProvider.js';
import { MockNewsProvider } from './mockNewsProvider.js';
import { env } from '../config/environment.js';
import { NitterProvider } from './nitterProvider.js';

/** Registry of provider implementations selected by monitored account. */
export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.defaultName = null;
  }

  /** @param {import('./feedProvider.js').FeedProvider} provider @param {{ defaultProvider?: boolean }} [options] */
  register(provider, { defaultProvider = false } = {}) {
    assertFeedProvider(provider);
    if (this.providers.has(provider.name)) throw new Error(`Feed provider "${provider.name}" is already registered`);
    this.providers.set(provider.name, provider);
    if (defaultProvider || this.defaultName === null) this.defaultName = provider.name;
    return provider;
  }

  /** @param {string} name */
  get(name) { return this.providers.get(name) ?? null; }

  getDefault() { return this.defaultName ? this.get(this.defaultName) : null; }

  getDefaultName() { return this.defaultName; }

  list() { return [...this.providers.keys()]; }
}

export const providerRegistry = new ProviderRegistry();
export const mockNewsProvider = new MockNewsProvider();
export const nitterProvider = new NitterProvider({
  instances: env.nitterInstances,
  instanceTimeoutMs: env.nitterInstanceTimeoutMs,
  cooldownMs: env.nitterInstanceCooldownMs,
});
providerRegistry.register(mockNewsProvider, { defaultProvider: env.feedProvider !== 'nitter' });
providerRegistry.register(nitterProvider, { defaultProvider: env.feedProvider === 'nitter' });

export default providerRegistry;
