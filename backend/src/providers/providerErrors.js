/** Base error for failures returned by a feed provider. */
export class FeedProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ providerName: string, code: string, retryable: boolean, cause?: unknown }} options
   */
  constructor(message, { providerName, code, retryable, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FeedProviderError';
    this.providerName = providerName;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Error raised when a provider exceeds its configured time budget. */
export class ProviderTimeoutError extends FeedProviderError {
  /** @param {string} providerName @param {number} timeoutMs */
  constructor(providerName, timeoutMs) {
    super(`${providerName} did not respond within ${timeoutMs} ms`, {
      providerName,
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
