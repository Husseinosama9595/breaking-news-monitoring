import { safeXPostUrl } from '../utils/xPostUrl.js';
import { countryNameForCode, isValidCountryCode } from '../data/countryCatalog.js';

const subscribers = new Set();

const MAX_TEXT_PREVIEW_LENGTH = 500;

/** Validate and copy the intentionally small public event payload. */
export function normalizePostCreatedEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const { eventId, postId, username, textPreview, detectedAt } = value;
  const notificationId = typeof value.notificationId === 'string' && value.notificationId
    ? value.notificationId
    : eventId;
  if (typeof eventId !== 'string' || !eventId || typeof postId !== 'string' || !postId
    || typeof username !== 'string' || !username.trim()
    || typeof textPreview !== 'string' || !textPreview.trim()
    || typeof detectedAt !== 'string' || !Number.isFinite(Date.parse(detectedAt))) return null;

  const publishedAt = typeof value.publishedAt === 'string' && Number.isFinite(Date.parse(value.publishedAt))
    ? value.publishedAt
    : null;
  const category = typeof value.category === 'string' && value.category.trim()
    ? value.category.trim().slice(0, 100)
    : null;
  const displayName = typeof value.displayName === 'string' && value.displayName.trim()
    ? value.displayName.trim().slice(0, 120)
    : null;
  const monitoredAccountId = typeof value.monitoredAccountId === 'string' && value.monitoredAccountId.trim()
    ? value.monitoredAccountId.trim().slice(0, 64)
    : null;
  const countryCode = typeof value.countryCode === 'string' && isValidCountryCode(value.countryCode)
    ? value.countryCode
    : null;

  return Object.freeze({
    eventId: eventId.slice(0, 128),
    notificationId: notificationId.slice(0, 128),
    postId: postId.slice(0, 128),
    username: username.trim().replace(/^@/, '').slice(0, 100),
    displayName,
    textPreview: textPreview.trim().slice(0, MAX_TEXT_PREVIEW_LENGTH),
    postUrl: safeXPostUrl(value.postUrl),
    publishedAt,
    detectedAt,
    category,
    monitoredAccountId,
    countryCode,
    countryName: countryNameForCode(countryCode),
  });
}

/** Subscribe to process-local post events. Returns an idempotent cleanup function. */
export function subscribeToNewPosts(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  subscribers.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    subscribers.delete(listener);
  };
}

/** Queue a safe event for subscribers without making ingestion wait for socket writes. */
export function publishNewPost(value) {
  const event = normalizePostCreatedEvent(value);
  if (!event) return false;
  queueMicrotask(() => {
    for (const listener of [...subscribers]) {
      try { listener(event); } catch {
        // A disconnected/slow dashboard must never fail ingestion.
      }
    }
  });
  return true;
}

/** Test/diagnostic visibility without exposing subscriber callbacks. */
export function postEventSubscriberCount() {
  return subscribers.size;
}
