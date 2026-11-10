import mongoose from 'mongoose';
import MonitoredAccount from '../models/MonitoredAccount.js';
import Post from '../models/Post.js';
import { validateProviderBatch } from '../providers/normalizedPost.js';
import { publishNewPost } from './postEventService.js';

const cleanUsername = (username) => String(username ?? '').trim().replace(/^@/, '');

/**
 * Produce a stable dedupe key. Canonical X IDs deduplicate across providers; the
 * fallback namespaces IDs by provider to avoid collisions between provider formats.
 * @param {import('../providers/feedProvider.js').NormalizedFeedPost} post
 */
export function createPostDedupeKey(post) {
  const canonicalId = post.canonicalPostId?.trim();
  return canonicalId
    ? `x:${canonicalId}`
    : `provider:${post.providerName}:${post.providerPostId}`;
}

/**
 * Persist a provider batch before allowing callers to queue any work. Account
 * checkpoints advance only after every post upsert succeeds. Replaying a batch is
 * safe because each upsert uses the unique dedupe key and only sets fields on insert.
 * @param {{ account: { username: string, displayName?: string, category?: string, platform?: string, providerAccountId?: string }, batch: import('../providers/feedProvider.js').FeedProviderBatch, receivedAt?: Date }} input
 * @returns {Promise<{ account: import('mongoose').HydratedDocument, receivedCount: number, insertedCount: number, duplicateCount: number, checkpoint: { postId: string, publishedAt: Date }|null }>}
 */
export function createPostIngestionService({
  accountModel = MonitoredAccount,
  postModel = Post,
  publishPostEvent = publishNewPost,
} = {}) {
  return async function ingestProviderBatch({ account, batch, receivedAt = new Date() }) {
  const username = cleanUsername(account?.username);
  if (!username) throw new TypeError('account.username is required');
  if (!mongoose.isValidObjectId(account?._id) && account?._id != null) throw new TypeError('account._id must be a valid MongoDB ObjectId');
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) throw new TypeError('receivedAt must be a valid Date');

  const normalizedBatch = validateProviderBatch(batch, batch?.providerName);
  const normalizedUsername = username.toLowerCase();
  const accountFilter = account._id
    ? { _id: account._id }
    : { platform: (account.platform ?? 'x').toLowerCase(), normalizedUsername };
  const storedAccount = await accountModel.findOneAndUpdate(
    accountFilter,
    {
      $setOnInsert: {
        platform: (account.platform ?? 'x').toLowerCase(),
        username,
        normalizedUsername,
        displayName: account.displayName ?? null,
        category: account.category ?? 'Other',
        enabled: true,
        providerName: normalizedBatch.providerName,
        providerAccountId: account.providerAccountId ?? null,
        monitoringStatus: 'active',
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );

  const isNitterBatch = normalizedBatch.providerName === 'nitter';
  const establishingNitterBaseline = isNitterBatch && storedAccount.notificationBaselineAt == null;
  const baselineAt = establishingNitterBaseline
    ? (normalizedBatch.posts
      .filter((post) => post.publishedAt)
      .reduce((latest, post) => !latest || post.publishedAt > latest ? post.publishedAt : latest, null)
      ?? normalizedBatch.fetchedAt)
    : storedAccount.notificationBaselineAt;

  if (establishingNitterBaseline) {
    // Existing queue jobs are harmless after this atomic state change: workers
    // claim only notificationStatus=pending, and the baseline gate below blocks
    // Nitter notifications until notificationBaselineAt is persisted.
    await postModel.updateMany({
      monitoredAccount: storedAccount._id,
      notificationStatus: { $ne: 'sent' },
    }, { $set: {
      processingStatus: 'processed',
      processingStartedAt: null,
      processingNextAttemptAt: null,
      processedAt: receivedAt,
      processingError: null,
      processingErrorCode: null,
      processingFailedAt: null,
      notificationStatus: 'skipped',
      notificationStartedAt: null,
      notificationNextAttemptAt: null,
      notificationFailedAt: null,
      notificationError: null,
      notificationErrorCode: 'INITIAL_HISTORY_SUPPRESSED',
      telegramSent: false,
    } });
  }

  const uniquePosts = new Map();
  for (const post of normalizedBatch.posts) uniquePosts.set(createPostDedupeKey(post), post);
  const postsToWrite = [...uniquePosts].map(([dedupeKey, post]) => ({
    dedupeKey,
    post,
    _id: new mongoose.Types.ObjectId(),
  }));
  const writeOperations = postsToWrite.map(({ dedupeKey, post, _id }) => ({
    updateOne: {
      filter: { dedupeKey },
      update: {
        $setOnInsert: {
          _id,
          dedupeKey,
          providerName: post.providerName,
          providerPostId: post.providerPostId,
          canonicalPostId: post.canonicalPostId,
          monitoredAccount: storedAccount._id,
          sourceAccountId: post.sourceAccountId,
          username: post.sourceUsername,
          author: post.author,
          text: post.text,
          postUrl: post.postUrl,
          providerUrl: post.providerUrl,
          category: storedAccount.category,
          priority: 'NORMAL',
          publishedAt: post.publishedAt,
          receivedAt,
          retrievedAt: post.retrievedAt,
          ...(post.raw === undefined ? {} : { raw: post.raw }),
          processingStatus: establishingNitterBaseline || (isNitterBatch && (!post.publishedAt || post.publishedAt <= baselineAt))
            ? 'processed'
            : 'pending',
          processingAttempts: 0,
          ...(establishingNitterBaseline || (isNitterBatch && (!post.publishedAt || post.publishedAt <= baselineAt))
            ? { processedAt: receivedAt, notificationStatus: 'skipped', notificationErrorCode: 'INITIAL_HISTORY_SUPPRESSED' }
            : {
              notificationStatus: 'pending',
              dashboardNotification: { createdAt: receivedAt, readAt: null },
            }),
          telegramSent: false,
          notificationAttempts: 0,
        },
      },
      upsert: true,
    },
  }));

  // A failed or partially failed bulk write throws before the checkpoint update.
  const writeResult = writeOperations.length
    ? await postModel.bulkWrite(writeOperations, { ordered: true })
    : { upsertedCount: 0 };

  // BulkWriteResult.upsertedIds identifies the operations that inserted new rows.
  // Duplicates and first-poll Nitter history never emit dashboard events.
  const upsertedIds = writeResult.upsertedIds ?? {};
  const insertedEntries = Array.isArray(upsertedIds)
    ? upsertedIds.map((entry) => [entry.index, entry._id])
    : upsertedIds instanceof Map
      ? [...upsertedIds.entries()]
      : Object.entries(upsertedIds);
  for (const [rawIndex, rawId] of insertedEntries) {
    const index = Number(rawIndex);
    const entry = postsToWrite[index];
    if (!entry) continue;
    const postIsBaselineHistory = establishingNitterBaseline
      || (isNitterBatch && (!entry.post.publishedAt || entry.post.publishedAt <= baselineAt));
    if (postIsBaselineHistory) continue;
    const postId = String(rawId?._id ?? rawId ?? entry._id);
    try {
      publishPostEvent({
        eventId: postId,
        notificationId: postId,
        postId,
        username: entry.post.sourceUsername || username,
        displayName: entry.post.author?.displayName ?? null,
        textPreview: entry.post.text,
        postUrl: entry.post.postUrl,
        publishedAt: entry.post.publishedAt?.toISOString?.() ?? null,
        detectedAt: receivedAt.toISOString(),
        category: storedAccount.category,
        monitoredAccountId: String(storedAccount._id),
        countryCode: storedAccount.countryCode ?? null,
      });
    } catch {
      // Event delivery is best-effort and must not undo durable post ingestion.
    }
  }

  const checkpointPost = normalizedBatch.posts
    .filter((post) => post.publishedAt)
    .sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime())[0];
  await accountModel.updateOne(
    { _id: storedAccount._id },
    {
      $max: { lastSuccessfulFetchAt: normalizedBatch.fetchedAt },
      ...(establishingNitterBaseline ? { $set: { notificationBaselineAt: baselineAt } } : {}),
    },
  );
  if (checkpointPost) {
    // The conditional update keeps an older, delayed batch from moving a checkpoint backwards.
    await accountModel.updateOne(
      {
        _id: storedAccount._id,
        $or: [
          { lastSeenPublishedAt: null },
          { lastSeenPublishedAt: { $lt: checkpointPost.publishedAt } },
        ],
      },
      { $set: { lastSeenProviderPostId: checkpointPost.providerPostId, lastSeenPublishedAt: checkpointPost.publishedAt } },
    );
  }

  const duplicateCount = normalizedBatch.posts.length - (writeResult.upsertedCount ?? 0);
  return {
    account: storedAccount,
    receivedCount: normalizedBatch.posts.length,
    insertedCount: writeResult.upsertedCount ?? 0,
    duplicateCount,
    checkpoint: checkpointPost ? { postId: checkpointPost.providerPostId, publishedAt: checkpointPost.publishedAt } : null,
  };
  };
}

export const ingestProviderBatch = createPostIngestionService();
