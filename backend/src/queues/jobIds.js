/** Stable BullMQ ID for a post-processing job. */
export const postJobId = (postId) => `post-${String(postId)}`;

/** Stable BullMQ ID for a Telegram notification job. */
export const notificationJobId = (postId) => `telegram-${String(postId)}`;
