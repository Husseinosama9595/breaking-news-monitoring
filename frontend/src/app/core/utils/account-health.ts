import type { FeedFreshnessStatus, MonitoredAccount } from '../models/monitored-account.model';

const FEED_FRESHNESS_STATUSES: readonly FeedFreshnessStatus[] = ['fresh', 'stale', 'empty', 'unknown'];

/** Legacy or malformed DTOs are presented as unknown rather than healthy. */
export function accountFeedFreshness(account: Pick<MonitoredAccount, 'pollHealth'>): FeedFreshnessStatus {
  const freshness = account.pollHealth?.freshness;
  return freshness && FEED_FRESHNESS_STATUSES.includes(freshness) ? freshness : 'unknown';
}

/** Keep absent and invalid API timestamps out of DatePipe bindings. */
export function isValidApiTimestamp(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}
