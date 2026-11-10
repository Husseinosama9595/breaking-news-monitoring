import Post, { NOTIFICATION_STATUSES } from '../models/Post.js';
import MonitoredAccount, { ACCOUNT_CATEGORIES } from '../models/MonitoredAccount.js';
import { countryNameForCode, normalizeCountryCode } from '../data/countryCatalog.js';
import { escapeRegexLiteral, normalizeSearchTerm } from '../utils/searchText.js';

const PUBLIC_FIELDS = [
  '_id', 'monitoredAccount', 'username', 'author', 'text', 'publishedAt', 'postUrl', 'category',
  'providerName', 'priority', 'processingStatus', 'notificationStatus', 'telegramSent', 'createdAt',
];
const POST_SELECT = PUBLIC_FIELDS.join(' ');
const ALLOWED_QUERY_FIELDS = new Set(['page', 'limit', 'username', 'search', 'category', 'notificationStatus', 'country']);
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const MAX_SEARCH_LENGTH = 120;

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
  return escapeRegexLiteral(value);
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
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') return { error: 'search must be a single text value' };
    if (query.search.length > MAX_SEARCH_LENGTH) return { error: `search must be ${MAX_SEARCH_LENGTH} characters or fewer` };
    const term = normalizeSearchTerm(query.search);
    if (term) {
      const regex = escapeRegex(term);
      filter.$or = [
        { text: { $regex: regex, $options: 'i' } },
        { username: { $regex: regex, $options: 'i' } },
        { 'author.username': { $regex: regex, $options: 'i' } },
        { 'author.displayName': { $regex: regex, $options: 'i' } },
      ];
    }
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

  let countryCode;
  let unassigned = false;
  if (query.country !== undefined) {
    if (typeof query.country !== 'string') return { error: 'country must be an ISO alpha-2 code or unassigned' };
    if (query.country.toLowerCase() === 'unassigned') unassigned = true;
    else {
      const country = normalizeCountryCode(query.country);
      if (country.error) return { error: 'country must be a valid ISO 3166-1 alpha-2 code or unassigned' };
      countryCode = country.value;
    }
  }

  return { value: { page: pageResult.value, limit: limitResult.value, filter, countryCode, unassigned } };
}

function postDto(post) {
  const dto = Object.fromEntries(PUBLIC_FIELDS
    .filter((field) => post[field] !== undefined)
    .map((field) => [field, post[field]]));
  const account = post.monitoredAccount && typeof post.monitoredAccount === 'object' ? post.monitoredAccount : null;
  dto.monitoredAccountId = account?._id ? String(account._id) : null;
  dto.countryCode = account?.countryCode ?? null;
  dto.countryName = countryNameForCode(dto.countryCode);
  delete dto.monitoredAccount;
  return dto;
}

/** Build read-only post listing handlers with an injectable model for tests. */
export function createPostController({ postModel = Post, accountModel = MonitoredAccount } = {}) {
  async function list(req, res) {
    const parsed = parsePostQuery(req.query ?? {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { page, limit, filter, countryCode, unassigned } = parsed.value;
    const skip = (page - 1) * limit;
    try {
      if (countryCode !== undefined || unassigned) {
        const accountFilter = { platform: 'x' };
        if (unassigned) accountFilter.$or = [{ countryCode: null }, { countryCode: { $exists: false } }];
        else accountFilter.countryCode = countryCode;
        const accountIds = await accountModel.find(accountFilter).select('_id').lean();
        if (accountIds.length === 0) {
          return res.json({ posts: [], pagination: { page, limit, total: 0, totalPages: 0 } });
        }
        filter.monitoredAccount = { $in: accountIds.map((account) => account._id) };
      }
      const [posts, total] = await Promise.all([
        postModel.find(filter)
          .select(POST_SELECT)
          .populate('monitoredAccount', 'countryCode')
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
