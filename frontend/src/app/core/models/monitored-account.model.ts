export type AccountCategory =
  | 'World News'
  | 'Politics'
  | 'Military & Security'
  | 'Economy & Finance'
  | 'Technology'
  | 'Business'
  | 'Emergencies'
  | 'Other';

export type AccountMonitoringStatus = 'active' | 'paused' | 'error';
export type FeedFreshnessStatus = 'fresh' | 'stale' | 'empty' | 'unknown';
export type AccountPollStatus = 'success' | 'failed';

/** Additive public poll health DTO returned by the Accounts API. */
export interface MonitoredAccountPollHealth {
  lastStartedAt?: string | null;
  lastCompletedAt?: string | null;
  lastDurationMs?: number | null;
  lastStatus?: AccountPollStatus | null;
  lastErrorCode?: string | null;
  returnedEntryCount?: number | null;
  insertedPostCount?: number | null;
  duplicatePostCount?: number | null;
  feedObservedAt?: string | null;
  newestPublishedAt?: string | null;
  timestampedEntryCount?: number | null;
  untimestampedEntryCount?: number | null;
  freshness?: FeedFreshnessStatus | null;
  freshnessMaxAgeMs?: number | null;
}

/** Public account DTO returned by GET /api/accounts. */
export interface MonitoredAccount {
  _id: string;
  platform: 'x';
  username: string;
  displayName: string | null;
  category: AccountCategory;
  countryCode?: string | null;
  countryName?: string | null;
  enabled: boolean;
  providerName: string;
  monitoringStatus: AccountMonitoringStatus;
  lastSuccessfulFetchAt: string | null;
  pollHealth?: MonitoredAccountPollHealth | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoredAccountsResponse {
  accounts: MonitoredAccount[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
}

export interface MonitoredAccountResponse {
  account: MonitoredAccount;
}

export interface CreateMonitoredAccountRequest {
  username: string;
  displayName?: string | null;
  category?: AccountCategory;
  countryCode?: string | null;
  providerName?: string;
}

export interface UpdateMonitoredAccountRequest {
  username?: string;
  displayName?: string | null;
  category?: AccountCategory;
  countryCode?: string | null;
  providerName?: string;
}
