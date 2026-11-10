import Post, { NOTIFICATION_STATUSES } from '../models/Post.js';
import { ACCOUNT_CATEGORIES } from '../models/MonitoredAccount.js';

const PUBLIC_FIELDS = [
  '_id', 'username', 'author', 'text', 'publishedAt', 'postUrl', 'category',
  'providerName', 'priority', 'processingStatus', 'notificationStatus', 'telegramSent', 'createdAt',
];
const POST_SELECT = PUBLIC_FIELDS.join(' ');
const ALLOWED_QUERY_FIELDS = new Set(['page', 'limit', 'username', 'category', 'notificationStatus']);
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

function parsePositiveInteger(value, field, defaultValue, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return { value: defaultValue };
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return { error: `${field} must be a positive integer` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { error: `${field} must be a safe integer` };
  if (parsed > maximum) return { error: `${field} must be ${maximum} or fewer` };
  return { value: parsed };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePostQuery(query) {
  const unknownFields = Object.keys(query).filter((field) => !ALLOWED_QUERY_FIELDS.has(field));
  if (unknownFields.length) return { error: `Unsupported query parameter(s): ${unknownFields.join(', ')}` };

  const pageResult = parsePositiveInteger(query.page, 'page', 1);
  if (pageResult.error) return pageResult;
  const limitResult = parsePositiveInteger(query.limit, 'limit', 20, 100);
  if (limitResult.error) return limitResult;
  if (!Number.isSafeInteger((pageResult.value - 1) * limitResult.value)) {
    return { error: 'page and limit produce an unsafe pagination offset' };
  }

  const filter = {};
  if (query.username !== undefined) {
    if (typeof query.username !== 'string') return { error: 'username must be a single X username' };
    const username = query.username.trim().replace(/^@/, '');
    if (!USERNAME_PATTERN.test(username)) return { error: 'username must be a valid X username' };
    filter.username = { $regex: `^${escapeRegex(username)}$`, $options: 'i' };
  }
  if (query.category !== undefined) {
    if (typeof query.category !== 'string' || !ACCOUNT_CATEGORIES.includes(query.category)) {
      return { error: `category must be one of: ${ACCOUNT_CATEGORIES.join(', ')}` };
    }
    filter.category = query.category;
  }
  if (query.notificationStatus !== undefined) {
    if (typeof query.notificationStatus !== 'string' || !NOTIFICATION_STATUSES.includes(query.notificationStatus)) {
      return { error: `notificationStatus must be one of: ${NOTIFICATION_STATUSES.join(', ')}` };
    }
    filter.notificationStatus = query.notificationStatus;
  }

  return { value: { page: pageResult.value, limit: limitResult.value, filter } };
}

function postDto(post) {
  return Object.fromEntries(PUBLIC_FIELDS
    .filter((field) => post[field] !== undefined)
    .map((field) => [field, post[field]]));
}

/** Build read-only post listing handlers with an injectable model for tests. */
export function createPostController({ postModel = Post } = {}) {
  async function list(req, res) {
    const parsed = parsePostQuery(req.query ?? {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { page, limit, filter } = parsed.value;
    const skip = (page - 1) * limit;
    try {
      const [posts, total] = await Promise.all([
        postModel.find(filter)
          .select(POST_SELECT)
          .sort({ publishedAt: -1, createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        postModel.countDocuments(filter),
      ]);
      return res.json({
        posts: posts.map(postDto),
        pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
      });
    } catch {
      return res.status(500).json({ error: 'Could not retrieve posts' });
    }
  }

  return { list };
}

export default createPostController;
