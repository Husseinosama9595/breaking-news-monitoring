/** Error raised by the persisted-post processing stage. */
export class PostProcessingError extends Error {
  /** @param {string} message @param {{ code: string, retryable: boolean, cause?: unknown }} options */
  constructor(message, { code, retryable, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PostProcessingError';
    this.code = code;
    this.retryable = retryable;
  }
}
