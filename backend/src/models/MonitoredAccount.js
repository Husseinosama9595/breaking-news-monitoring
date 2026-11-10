import mongoose from 'mongoose';
import { isValidCountryCode } from '../data/countryCatalog.js';

export const ACCOUNT_CATEGORIES = Object.freeze([
  'World News', 'Politics', 'Military & Security', 'Economy & Finance',
  'Technology', 'Business', 'Emergencies', 'Other',
]);

const monitoredAccountSchema = new mongoose.Schema({
  platform: { type: String, required: true, enum: ['x'], default: 'x', lowercase: true, trim: true },
  username: { type: String, required: true, trim: true },
  normalizedUsername: { type: String, required: true, lowercase: true, trim: true },
  displayName: { type: String, default: null, trim: true },
  countryCode: {
    type: String,
    default: null,
    uppercase: true,
    trim: true,
    validate: { validator: (value) => value == null || isValidCountryCode(value), message: 'countryCode must be a valid ISO 3166-1 alpha-2 code' },
  },
  category: { type: String, enum: ACCOUNT_CATEGORIES, default: 'Other', required: true },
  enabled: { type: Boolean, default: true, required: true },
  providerName: { type: String, required: true, trim: true },
  providerAccountId: { type: String, default: null, trim: true },
  monitoringStatus: { type: String, enum: ['active', 'paused', 'error'], default: 'active', required: true },
  lastSeenProviderPostId: { type: String, default: null },
  lastSeenPublishedAt: { type: Date, default: null },
  // Nitter history must be baselined before any queued notification can send.
  notificationBaselineAt: { type: Date, default: null },
  lastSuccessfulFetchAt: { type: Date, default: null },
  lastPollAttemptAt: { type: Date, default: null },
  lastPollCompletedAt: { type: Date, default: null },
  lastPollDurationMs: { type: Number, default: null, min: 0 },
  lastPollStatus: { type: String, enum: ['success', 'failed'], default: null },
  lastPollErrorCode: { type: String, default: null },
  lastPollEntryCount: { type: Number, default: null, min: 0 },
  lastPollInsertedCount: { type: Number, default: null, min: 0 },
  lastPollDuplicateCount: { type: Number, default: null, min: 0 },
  lastProviderFeedObservedAt: { type: Date, default: null },
  lastProviderFeedLatestPublishedAt: { type: Date, default: null },
  lastProviderFeedTimestampedEntryCount: { type: Number, default: null, min: 0 },
  lastProviderFeedUntimestampedEntryCount: { type: Number, default: null, min: 0 },
  lastProviderFeedFreshnessStatus: { type: String, enum: ['fresh', 'stale', 'empty', 'unknown'], default: 'unknown' },
  lastPollErrorAt: { type: Date, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true, minimize: false });

monitoredAccountSchema.index({ platform: 1, normalizedUsername: 1 }, { unique: true, name: 'uniq_account_platform_username' });
monitoredAccountSchema.index({ platform: 1, countryCode: 1, enabled: 1, monitoringStatus: 1 }, { name: 'account_country_monitoring' });

/** @type {import('mongoose').Model} */
export const MonitoredAccount = mongoose.models.MonitoredAccount
  ?? mongoose.model('MonitoredAccount', monitoredAccountSchema);

export default MonitoredAccount;
