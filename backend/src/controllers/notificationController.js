import mongoose from 'mongoose';
import Post from '../models/Post.js';
import { safeXPostUrl } from '../utils/xPostUrl.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const ALLOWED_QUERY = new Set(['page', 'limit', 'since']);
const NOTIFICATION_SELECT = [
  '_id', 'username', 'author', 'text', 'postUrl', 'publishedAt', 'category',
  'dashboardNotification.createdAt', 'dashboardNotification.readAt',
].join(' ');

function positiveInteger(value, field, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return { error: `${field} must be a positive integer` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { error: `${field} must be a safe integer` };
  if (parsed > maximum) return { error: `${field} must be ${maximum} or fewer` };
  return { value: parsed };
}

function parseListQuery(query) {
  const unknown = Object.keys(query).filter((key) => !ALLOWED_QUERY.has(key));
  if (unknown.length) return { error: `Unsupported query parameter(s): ${unknown.join(', ')}` };
  const page = positiveInteger(query.page, 'page', 1);
  if (page.error) return page;
  const limit = positiveInteger(query.limit, 'limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  if (limit.error) return limit;
  if (!Number.isSafeInteger((page.value - 1) * limit.value)) return { error: 'page and limit produce an unsafe pagination offset' };
  let since;
  if (query.since !== undefined) {
    const isIsoTimestamp = typeof query.since === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(query.since);
    if (!isIsoTimestamp || !Number.isFinite(Date.parse(query.since))) {
      return { error: 'since must be a valid ISO timestamp' };
    }
    since = new Date(query.since);
  }
  return { value: { page: page.value, limit: limit.value, since } };
}

function dateString(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function notificationDto(post) {
  const meta = post.dashboardNotification;
  const notificationId = String(post._id);
  return {
    notificationId,
    postId: notificationId,
    username: post.username,
    displayName: post.author?.displayName ?? null,
    textPreview: typeof post.text === 'string' ? post.text.slice(0, 500) : '',
    postUrl: safeXPostUrl(post.postUrl),
    publishedAt: dateString(post.publishedAt),
    detectedAt: dateString(meta?.createdAt),
    category: post.category ?? null,
    readAt: dateString(meta?.readAt),
    read: Boolean(meta?.readAt),
  };
}

const hasNotification = { 'dashboardNotification.createdAt': { $exists: true } };
const unreadFilter = {
  ...hasNotification,
  'dashboardNotification.readAt': null,
};

/** Create protected notification history handlers backed by the Post ledger. */
export function createNotificationController({ postModel = Post, clock = () => new Date() } = {}) {
  async function list(req, res) {
    const parsed = parseListQuery(req.query ?? {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { page, limit, since } = parsed.value;
    const filter = { ...hasNotification };
    if (since) filter['dashboardNotification.createdAt'] = { $exists: true, $gte: since };
    try {
      const [posts, total, unreadCount] = await Promise.all([
        postModel.find(filter).select(NOTIFICATION_SELECT)
          .sort({ 'dashboardNotification.createdAt': -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).lean(),
        postModel.countDocuments(filter),
        postModel.countDocuments(unreadFilter),
      ]);
      return res.json({
        notifications: posts.map(notificationDto),
        pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
        unreadCount,
        serverTime: clock().toISOString(),
      });
    } catch {
      return res.status(500).json({ error: 'Could not retrieve notifications' });
    }
  }

  async function unreadCount(_req, res) {
    try {
      const count = await postModel.countDocuments(unreadFilter);
      return res.json({ unreadCount: count });
    } catch {
      return res.status(500).json({ error: 'Could not retrieve unread count' });
    }
  }

  async function markRead(req, res) {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Notification ID must be a valid MongoDB ID' });
    try {
      const filter = { _id: id, ...hasNotification };
      const updated = await postModel.findOneAndUpdate(
        { ...filter, 'dashboardNotification.readAt': null },
        { $set: { 'dashboardNotification.readAt': clock() } },
        { new: true },
      ).select(NOTIFICATION_SELECT).lean();
      if (updated) return res.json({ notification: notificationDto(updated) });

      const existing = await postModel.findOne(filter).select(NOTIFICATION_SELECT).lean();
      if (!existing) return res.status(404).json({ error: 'Notification not found' });
      return res.json({ notification: notificationDto(existing) });
    } catch {
      return res.status(500).json({ error: 'Could not update notification' });
    }
  }

  async function markAllRead(_req, res) {
    try {
      const result = await postModel.updateMany(unreadFilter, {
        $set: { 'dashboardNotification.readAt': clock() },
      });
      const unread = await postModel.countDocuments(unreadFilter);
      return res.json({ updatedCount: result.modifiedCount ?? 0, unreadCount: unread });
    } catch {
      return res.status(500).json({ error: 'Could not update notifications' });
    }
  }

  return { list, unreadCount, markRead, markAllRead };
}

export default createNotificationController;
