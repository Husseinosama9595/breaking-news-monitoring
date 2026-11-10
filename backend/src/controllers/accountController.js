import mongoose from 'mongoose';
import MonitoredAccount, { ACCOUNT_CATEGORIES } from '../models/MonitoredAccount.js';
import providerRegistry from '../providers/providerRegistry.js';
import { env } from '../config/environment.js';

const PUBLIC_FIELDS = [
  '_id', 'platform', 'username', 'displayName', 'category', 'enabled',
  'providerName', 'monitoringStatus', 'lastSuccessfulFetchAt', 'createdAt', 'updatedAt',
];
const POLL_HEALTH_SELECT = [
  'lastPollAttemptAt', 'lastPollCompletedAt', 'lastPollDurationMs', 'lastPollStatus',
  'lastPollErrorCode', 'lastPollEntryCount', 'lastPollInsertedCount', 'lastPollDuplicateCount',
  'lastProviderFeedObservedAt', 'lastProviderFeedLatestPublishedAt',
  'lastProviderFeedTimestampedEntryCount', 'lastProviderFeedUntimestampedEntryCount',
  'lastProviderFeedFreshnessStatus',
].join(' ');
const PUBLIC_SELECT = `${PUBLIC_FIELDS.filter((field) => field !== '_id').join(' ')} ${POLL_HEALTH_SELECT}`;
const CREATE_FIELDS = new Set(['username', 'displayName', 'category', 'providerName']);
const UPDATE_FIELDS = CREATE_FIELDS;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

function accountDto(account) {
  if (!account) return null;
  const source = typeof account.toObject === 'function' ? account.toObject() : account;
  const dto = Object.fromEntries(PUBLIC_FIELDS
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]));
  dto.pollHealth = {
    lastStartedAt: source.lastPollAttemptAt ?? null,
    lastCompletedAt: source.lastPollCompletedAt ?? null,
    lastDurationMs: source.lastPollDurationMs ?? null,
    lastStatus: source.lastPollStatus ?? null,
    lastErrorCode: source.lastPollErrorCode ?? null,
    returnedEntryCount: source.lastPollEntryCount ?? null,
    insertedPostCount: source.lastPollInsertedCount ?? null,
    duplicatePostCount: source.lastPollDuplicateCount ?? null,
    feedObservedAt: source.lastProviderFeedObservedAt ?? null,
    newestPublishedAt: source.lastProviderFeedLatestPublishedAt ?? null,
    timestampedEntryCount: source.lastProviderFeedTimestampedEntryCount ?? null,
    untimestampedEntryCount: source.lastProviderFeedUntimestampedEntryCount ?? null,
    freshness: source.lastProviderFeedFreshnessStatus ?? 'unknown',
    freshnessMaxAgeMs: env.feedFreshnessMaxAgeMs,
  };
  return dto;
}

function isObjectBody(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(body, allowedFields) {
  return Object.keys(body).filter((field) => !allowedFields.has(field));
}

function parseUsername(value) {
  if (typeof value !== 'string') return { error: 'username must be a string' };
  const username = value.trim().replace(/^@/, '');
  if (!USERNAME_PATTERN.test(username)) {
    return { error: 'username must be a valid X username (1–15 letters, numbers, or underscores)' };
  }
  return { value: username };
}

function parseOptionalFields(body, { providerNames }) {
  const fields = {};
  if (Object.hasOwn(body, 'displayName')) {
    if (body.displayName !== null && typeof body.displayName !== 'string') {
      return { error: 'displayName must be a string or null' };
    }
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : null;
    if (displayName?.length > 120) return { error: 'displayName must be 120 characters or fewer' };
    fields.displayName = displayName || null;
  }
  if (Object.hasOwn(body, 'category')) {
    if (typeof body.category !== 'string' || !ACCOUNT_CATEGORIES.includes(body.category)) {
      return { error: `category must be one of: ${ACCOUNT_CATEGORIES.join(', ')}` };
    }
    fields.category = body.category;
  }
  if (Object.hasOwn(body, 'providerName')) {
    if (typeof body.providerName !== 'string' || !providerNames.includes(body.providerName)) {
      return { error: `providerName must be one of: ${providerNames.join(', ')}` };
    }
    fields.providerName = body.providerName;
  }
  return { value: fields };
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

function validationError(res, message) {
  return res.status(400).json({ error: message });
}

function sendServerError(res) {
  return res.status(500).json({ error: 'Could not complete the account request' });
}

/** Build controller handlers with injectable persistence/provider dependencies for tests. */
export function createAccountController({
  accountModel = MonitoredAccount,
  registry = providerRegistry,
  providerMode = env.feedProvider,
} = {}) {
  const getProviderNames = () => registry.list();

  async function findDuplicate(normalizedUsername, excludedId = null) {
    const filter = { platform: 'x', normalizedUsername };
    if (excludedId) filter._id = { $ne: excludedId };
    return accountModel.findOne(filter).select('_id').lean();
  }

  async function list(_req, res) {
    try {
      const accounts = await accountModel.find({ platform: 'x' })
        .select(PUBLIC_SELECT).sort({ createdAt: -1, _id: -1 }).lean();
      return res.json({ accounts: accounts.map(accountDto) });
    } catch {
      return sendServerError(res);
    }
  }

  async function getById(req, res) {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return validationError(res, 'id must be a valid MongoDB ObjectId');
    try {
      const account = await accountModel.findById(req.params.id).select(PUBLIC_SELECT).lean();
      if (!account) return res.status(404).json({ error: 'Monitored account not found' });
      return res.json({ account: accountDto(account) });
    } catch {
      return sendServerError(res);
    }
  }

  async function create(req, res) {
    if (!isObjectBody(req.body)) return validationError(res, 'Request body must be a JSON object');
    const extraFields = unknownFields(req.body, CREATE_FIELDS);
    if (extraFields.length) return validationError(res, `Unsupported field(s): ${extraFields.join(', ')}`);
    const usernameResult = parseUsername(req.body.username);
    if (usernameResult.error) return validationError(res, usernameResult.error);
    const optionalResult = parseOptionalFields(req.body, { providerNames: getProviderNames() });
    if (optionalResult.error) return validationError(res, optionalResult.error);

    const username = usernameResult.value;
    const normalizedUsername = username.toLowerCase();
    const providerName = optionalResult.value.providerName
      ?? (providerMode === 'nitter' || providerMode === 'mock' ? providerMode : registry.getDefaultName());
    if (!providerName || !getProviderNames().includes(providerName)) {
      return validationError(res, 'No supported feed provider is available');
    }

    try {
      if (await findDuplicate(normalizedUsername)) {
        return res.status(409).json({ error: 'An account with this X username already exists' });
      }
      const account = await accountModel.create({
        platform: 'x',
        username,
        normalizedUsername,
        displayName: optionalResult.value.displayName ?? null,
        category: optionalResult.value.category ?? 'Other',
        enabled: true,
        providerName,
        monitoringStatus: 'active',
      });
      return res.status(201).json({ account: accountDto(account) });
    } catch (error) {
      if (isDuplicateKey(error)) return res.status(409).json({ error: 'An account with this X username already exists' });
      if (error?.name === 'ValidationError' || error?.name === 'CastError') {
        return validationError(res, 'Account data failed schema validation');
      }
      return sendServerError(res);
    }
  }

  async function update(req, res) {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return validationError(res, 'id must be a valid MongoDB ObjectId');
    if (!isObjectBody(req.body)) return validationError(res, 'Request body must be a JSON object');
    const extraFields = unknownFields(req.body, UPDATE_FIELDS);
    if (extraFields.length) return validationError(res, `Unsupported field(s): ${extraFields.join(', ')}`);
    if (Object.keys(req.body).length === 0) return validationError(res, 'At least one supported field is required');

    const updates = {};
    if (Object.hasOwn(req.body, 'username')) {
      const usernameResult = parseUsername(req.body.username);
      if (usernameResult.error) return validationError(res, usernameResult.error);
      updates.username = usernameResult.value;
      updates.normalizedUsername = usernameResult.value.toLowerCase();
    }
    const optionalResult = parseOptionalFields(req.body, { providerNames: getProviderNames() });
    if (optionalResult.error) return validationError(res, optionalResult.error);
    Object.assign(updates, optionalResult.value);

    try {
      if (updates.normalizedUsername && await findDuplicate(updates.normalizedUsername, req.params.id)) {
        return res.status(409).json({ error: 'An account with this X username already exists' });
      }
      const account = await accountModel.findOneAndUpdate(
        { _id: req.params.id, platform: 'x' },
        { $set: updates },
        { new: true, runValidators: true },
      ).select(PUBLIC_SELECT).lean();
      if (!account) return res.status(404).json({ error: 'Monitored account not found' });
      return res.json({ account: accountDto(account) });
    } catch (error) {
      if (isDuplicateKey(error)) return res.status(409).json({ error: 'An account with this X username already exists' });
      if (error?.name === 'ValidationError' || error?.name === 'CastError') {
        return validationError(res, 'Account data failed schema validation');
      }
      return sendServerError(res);
    }
  }

  async function setEnabled(req, res, enabled) {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return validationError(res, 'id must be a valid MongoDB ObjectId');
    if (req.body !== undefined && (!isObjectBody(req.body) || Object.keys(req.body).length > 0)) {
      return validationError(res, 'Enable and disable endpoints do not accept request fields');
    }
    try {
      const account = await accountModel.findOneAndUpdate(
        { _id: req.params.id, platform: 'x' },
        { $set: { enabled, monitoringStatus: enabled ? 'active' : 'paused' } },
        { new: true, runValidators: true },
      ).select(PUBLIC_SELECT).lean();
      if (!account) return res.status(404).json({ error: 'Monitored account not found' });
      return res.json({ account: accountDto(account) });
    } catch (error) {
      if (error?.name === 'ValidationError' || error?.name === 'CastError') {
        return validationError(res, 'Account data failed schema validation');
      }
      return sendServerError(res);
    }
  }

  return {
    list,
    getById,
    create,
    update,
    enable: (req, res) => setEnabled(req, res, true),
    disable: (req, res) => setEnabled(req, res, false),
  };
}

export default createAccountController;
