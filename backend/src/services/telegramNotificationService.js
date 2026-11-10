import { env } from '../config/environment.js';
import { telegramRateLimiter } from './telegramRateLimiter.js';

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Typed Telegram send failure with retry guidance. Never contains the bot token. */
export class TelegramNotificationError extends Error {
  /** @param {string} message @param {{ code: string, retryable: boolean, statusCode?: number, retryAfterMs?: number }} options */
  constructor(message, { code, retryable, statusCode, retryAfterMs }) {
    super(message);
    this.name = 'TelegramNotificationError';
    this.code = code;
    this.retryable = retryable;
    if (statusCode != null) this.statusCode = statusCode;
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;
  }
}

/** Validate a Telegram numeric chat ID or public channel username. */
export function validateTelegramChatId(value) {
  const chatId = String(value ?? '').trim();
  if (/^-?[1-9]\d*$/.test(chatId)) return chatId;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chatId)) return chatId;
  throw new TelegramNotificationError('TELEGRAM_CHAT_ID must be a numeric chat ID or @channel username', {
    code: 'INVALID_CHAT_ID', retryable: false,
  });
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`;
}

const codePointLength = (value) => Array.from(value).length;

/** Format a plain-text Telegram message without parse-mode escaping hazards. */
export function formatTelegramNotification(post) {
  const priority = post.priority || 'NORMAL';
  const title = priority === 'CRITICAL' || priority === 'HIGH' ? '🚨 BREAKING NEWS' : '📰 NEWS UPDATE';
  const username = String(post.username || post.author?.username || 'Unknown source').replace(/^@/, '');
  const header = [title, `Source: @${username}`];
  if (post.category) header.push(`Category: ${post.category}`);
  header.push(`Priority: ${priority}`);
  const publishedAt = formatTimestamp(post.publishedAt);
  if (publishedAt) header.push(`Published: ${publishedAt}`);
  const detectedAt = formatTimestamp(post.receivedAt || post.retrievedAt);
  if (detectedAt) header.push(`Detected: ${detectedAt}`);

  const footer = post.postUrl ? ['Original post:', String(post.postUrl)] : [];
  const prefix = header.join('\n');
  const suffix = footer.join('\n');
  const content = String(post.text ?? '').trim() || '[No post text]';
  const reserved = codePointLength(prefix) + codePointLength(suffix) + (suffix ? 4 : 2);
  const contentBudget = Math.max(0, TELEGRAM_MAX_MESSAGE_LENGTH - reserved);
  let clipped = Array.from(content).slice(0, contentBudget).join('');
  if (codePointLength(content) > contentBudget && contentBudget >= 14) {
    clipped = `${Array.from(content).slice(0, contentBudget - 13).join('')}… [truncated]`;
  }
  const parts = [prefix, '', clipped];
  if (suffix) parts.push('', suffix);
  const message = parts.join('\n');
  const messageCharacters = Array.from(message);
  if (messageCharacters.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return message;
  return `${messageCharacters.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 13).join('')}… [truncated]`;
}

/** Telegram Bot API client. Uses Node's built-in fetch and supports injected clients in tests. */
export class TelegramNotificationService {
  /**
   * @param {{ token?: string, chatId?: string, timeoutMs?: number, fetchImpl?: typeof fetch, clock?: () => Date, rateLimiter?: { run: (chatId: string, operation: () => Promise<unknown>, options?: { timeoutMs?: number }) => Promise<unknown> }|null }} [options]
   */
  constructor({
    token = env.telegramBotToken,
    chatId = env.telegramChatId,
    timeoutMs = env.telegramRequestTimeoutMs,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    rateLimiter = null,
  } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw new TypeError('timeoutMs must be an integer of at least 100 ms');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.token = String(token ?? '').trim();
    this.chatId = String(chatId ?? '').trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.rateLimiter = rateLimiter;
  }

  isConfigured() { return Boolean(this.token && this.chatId); }

  /** Send one post; resolves only after Telegram returns `ok: true`. */
  async sendNotification(post) {
    if (!this.token || !this.chatId) {
      throw new TelegramNotificationError('Telegram credentials are not configured', {
        code: 'TELEGRAM_NOT_CONFIGURED', retryable: false,
      });
    }
    const chatId = validateTelegramChatId(this.chatId);
    const message = formatTelegramNotification(post);
    const send = () => this.#sendRequest(chatId, message);
    if (!this.rateLimiter) return send();
    try {
      return await this.rateLimiter.run(chatId, send, { timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof TelegramNotificationError) throw error;
      throw new TelegramNotificationError('Telegram send coordination is temporarily unavailable', {
        code: 'TELEGRAM_RATE_LIMITER_UNAVAILABLE', retryable: true,
      });
    }
  }

  async #sendRequest(chatId, message) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TelegramNotificationError('Telegram request timed out', {
          code: 'TELEGRAM_TIMEOUT', retryable: true,
        }));
      }, this.timeoutMs);
    });

    const request = (async () => {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: controller.signal,
      });
      let body;
      try { body = await response.json(); } catch {
        throw new TelegramNotificationError('Telegram returned an invalid response', {
          code: 'TELEGRAM_INVALID_RESPONSE', retryable: response.status >= 500,
          statusCode: response.status,
        });
      }

      if (!response.ok || body?.ok !== true) {
        const statusCode = Number(body?.error_code) || response.status || 500;
        const retryable = statusCode === 429 || statusCode >= 500;
        const retryAfterMs = Number.isFinite(body?.parameters?.retry_after)
          ? Math.max(0, body.parameters.retry_after * 1000)
          : undefined;
        throw new TelegramNotificationError(`Telegram rejected sendMessage (${statusCode})`, {
          code: statusCode === 429 ? 'TELEGRAM_RATE_LIMITED' : `TELEGRAM_API_${statusCode}`,
          retryable,
          statusCode,
          retryAfterMs,
        });
      }

      return {
        messageId: body.result?.message_id == null ? null : String(body.result.message_id),
        chatId,
        sentAt: this.clock(),
      };
    })();

    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof TelegramNotificationError) throw error;
      if (timedOut || controller.signal.aborted) {
        throw new TelegramNotificationError('Telegram request timed out', { code: 'TELEGRAM_TIMEOUT', retryable: true });
      }
      throw new TelegramNotificationError('Telegram network request failed', {
        code: 'TELEGRAM_NETWORK_ERROR', retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export const telegramNotificationService = new TelegramNotificationService({ rateLimiter: telegramRateLimiter });
export default telegramNotificationService;
