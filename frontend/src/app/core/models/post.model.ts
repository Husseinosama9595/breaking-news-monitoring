/** Public post DTO returned by GET /api/posts. */
export interface MonitoredPost {
  _id: string;
  username?: string | null;
  author?: { username?: string | null; displayName?: string | null } | null;
  text?: string | null;
  publishedAt?: string | null;
  postUrl?: string | null;
  category?: string | null;
  providerName?: string | null;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL';
  processingStatus: 'pending' | 'processing' | 'processed' | 'failed';
  notificationStatus: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  telegramSent: boolean;
  createdAt: string;
}

export interface PostsResponse {
  posts: MonitoredPost[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface PostsQuery {
  page?: number;
  limit?: number;
  username?: string;
  category?: string;
  notificationStatus?: string;
}
