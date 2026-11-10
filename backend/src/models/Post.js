import mongoose from 'mongoose';

export const POST_PRIORITIES = Object.freeze(['CRITICAL', 'HIGH', 'NORMAL']);
export const PROCESSING_STATUSES = Object.freeze(['pending', 'processing', 'processed', 'failed']);
export const NOTIFICATION_STATUSES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'skipped']);

const authorSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  displayName: { type: String, default: null },
}, { _id: false });

const dashboardNotificationSchema = new mongoose.Schema({
  createdAt: { type: Date, required: true },
  readAt: { type: Date, default: null },
}, { _id: false });

const postSchema = new mongoose.Schema({
  dedupeKey: { type: String, required: true },
  providerName: { type: String, required: true, trim: true },
  providerPostId: { type: String, required: true, trim: true },
  canonicalPostId: { type: String, default: null },
  monitoredAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'MonitoredAccount', required: true },
  sourceAccountId: { type: String, default: null },
  username: { type: String, required: true, trim: true },
  author: { type: authorSchema, required: true },
  text: { type: String, required: true },
  postUrl: { type: String, default: null },
  providerUrl: { type: String, default: null },
  category: { type: String, default: 'Other', trim: true },
  priority: { type: String, enum: POST_PRIORITIES, default: 'NORMAL', required: true },
  publishedAt: { type: Date, default: null },
  receivedAt: { type: Date, required: true },
  retrievedAt: { type: Date, required: true },
  raw: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Present only when this newly inserted post is eligible for dashboard notification.
  dashboardNotification: { type: dashboardNotificationSchema, default: undefined },

  // MongoDB remains the durable work ledger. Redis jobs can be reconstructed from these states.
  processingStatus: { type: String, enum: PROCESSING_STATUSES, default: 'pending', required: true },
  processingAttempts: { type: Number, default: 0, min: 0, required: true },
  processingStartedAt: { type: Date, default: null },
  processingNextAttemptAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  processingError: { type: String, default: null },
  processingErrorCode: { type: String, default: null },
  processingFailedAt: { type: Date, default: null },

  notificationStatus: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending', required: true },
  telegramSent: { type: Boolean, default: false, required: true },
  telegramSentAt: { type: Date, default: null },
  telegramMessageId: { type: String, default: null },
  notificationStartedAt: { type: Date, default: null },
  notificationNextAttemptAt: { type: Date, default: null },
  notificationFailedAt: { type: Date, default: null },
  notificationAttempts: { type: Number, default: 0, min: 0, required: true },
  notificationError: { type: String, default: null },
  notificationErrorCode: { type: String, default: null },
}, { timestamps: true, minimize: false });

postSchema.index({ dedupeKey: 1 }, { unique: true, name: 'uniq_post_dedupe_key' });
postSchema.index({ processingStatus: 1, processingStartedAt: 1, createdAt: 1 }, { name: 'pending_processing_recovery' });
postSchema.index({ processingStatus: 1, notificationStatus: 1, processingNextAttemptAt: 1, processingStartedAt: 1, createdAt: 1 }, { name: 'processing_dispatch_recovery' });
postSchema.index({ processingStatus: 1, notificationStatus: 1, notificationNextAttemptAt: 1, notificationStartedAt: 1, createdAt: 1 }, { name: 'notification_dispatch_recovery' });
postSchema.index({ monitoredAccount: 1, publishedAt: -1, createdAt: -1 }, { name: 'account_recent_posts' });
postSchema.index({ 'dashboardNotification.createdAt': -1, _id: -1 }, {
  name: 'dashboard_notification_history',
  partialFilterExpression: { 'dashboardNotification.createdAt': { $exists: true } },
});
postSchema.index({ 'dashboardNotification.readAt': 1, 'dashboardNotification.createdAt': -1 }, {
  name: 'dashboard_notification_unread',
  partialFilterExpression: { 'dashboardNotification.createdAt': { $exists: true } },
});

/** @type {import('mongoose').Model} */
export const Post = mongoose.models.Post ?? mongoose.model('Post', postSchema);

export default Post;
