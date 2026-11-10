import MonitoredAccount from '../models/MonitoredAccount.js';
import Post from '../models/Post.js';
import { COUNTRY_CATALOG, isValidCountryCode } from '../data/countryCatalog.js';

function utcDayStart(clock) {
  const now = clock();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function accountCountryPipeline({ postCollection, todayStart }) {
  return [
    { $match: { platform: 'x' } },
    {
      $lookup: {
        from: postCollection,
        let: { accountId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$monitoredAccount', '$$accountId'] } } },
          {
            $group: {
              _id: null,
              postCount: { $sum: 1 },
              postsDetectedToday: { $sum: { $cond: [{ $gte: ['$receivedAt', todayStart] }, 1, 0] } },
              latestPublishedAt: { $max: '$publishedAt' },
            },
          },
        ],
        as: 'postMetrics',
      },
    },
    {
      $project: {
        countryCode: { $ifNull: ['$countryCode', null] },
        enabled: 1,
        monitoringStatus: 1,
        lastPollStatus: 1,
        lastProviderFeedFreshnessStatus: 1,
        postMetrics: {
          $ifNull: [
            { $arrayElemAt: ['$postMetrics', 0] },
            { postCount: 0, postsDetectedToday: 0, latestPublishedAt: null },
          ],
        },
      },
    },
    {
      $group: {
        _id: '$countryCode',
        accountCount: { $sum: 1 },
        activeAccountCount: { $sum: { $cond: [{ $and: ['$enabled', { $eq: ['$monitoringStatus', 'active'] }] }, 1, 0] } },
        failedPollAccountCount: { $sum: { $cond: [{ $eq: ['$lastPollStatus', 'failed'] }, 1, 0] } },
        staleFeedAccountCount: { $sum: { $cond: [{ $eq: ['$lastProviderFeedFreshnessStatus', 'stale'] }, 1, 0] } },
        unknownFeedAccountCount: { $sum: { $cond: [{ $eq: ['$lastProviderFeedFreshnessStatus', 'unknown'] }, 1, 0] } },
        postCount: { $sum: '$postMetrics.postCount' },
        postsDetectedToday: { $sum: '$postMetrics.postsDetectedToday' },
        latestPublishedAt: { $max: '$postMetrics.latestPublishedAt' },
      },
    },
    { $sort: { _id: 1 } },
  ];
}

function groupDto(group) {
  return {
    countryCode: group._id,
    accountCount: group.accountCount,
    activeAccountCount: group.activeAccountCount,
    failedPollAccountCount: group.failedPollAccountCount,
    staleFeedAccountCount: group.staleFeedAccountCount,
    unknownFeedAccountCount: group.unknownFeedAccountCount,
    postCount: group.postCount,
    postsDetectedToday: group.postsDetectedToday,
    latestPublishedAt: group.latestPublishedAt ?? null,
  };
}

/** Protected country catalog and account/post counts, computed through current account relationships. */
export function createCountryController({ accountModel = MonitoredAccount, postModel = Post, clock = () => new Date() } = {}) {
  async function catalog(_req, res) {
    return res.json({ countries: COUNTRY_CATALOG });
  }

  async function list(_req, res) {
    try {
      const now = clock();
      const dayStartsAt = utcDayStart(() => now);
      const groups = await accountModel.aggregate(accountCountryPipeline({
        postCollection: postModel.collection.name,
        todayStart: dayStartsAt,
      }));
      const assigned = groups.filter((group) => isValidCountryCode(group._id)).map(groupDto);
      const unassignedGroup = groups.find((group) => group._id == null);
      const countries = assigned.map((group) => ({
        ...group,
        countryName: COUNTRY_CATALOG.find((country) => country.countryCode === group.countryCode)?.countryName ?? group.countryCode,
      }));
      const unassigned = unassignedGroup ? groupDto(unassignedGroup) : {
        countryCode: null,
        accountCount: 0,
        activeAccountCount: 0,
        failedPollAccountCount: 0,
        staleFeedAccountCount: 0,
        unknownFeedAccountCount: 0,
        postCount: 0,
        postsDetectedToday: 0,
        latestPublishedAt: null,
      };
      const totals = countries.reduce((summary, country) => ({
        countryCount: summary.countryCount + 1,
        accountCount: summary.accountCount + country.accountCount,
        activeAccountCount: summary.activeAccountCount + country.activeAccountCount,
        postCount: summary.postCount + country.postCount,
        postsDetectedToday: summary.postsDetectedToday + country.postsDetectedToday,
      }), { countryCount: 0, accountCount: 0, activeAccountCount: 0, postCount: 0, postsDetectedToday: 0 });
      totals.accountCount += unassigned.accountCount;
      totals.activeAccountCount += unassigned.activeAccountCount;
      totals.postCount += unassigned.postCount;
      totals.postsDetectedToday += unassigned.postsDetectedToday;
      return res.json({ countries, unassigned, totals, serverTime: now.toISOString(), dayStartsAt: dayStartsAt.toISOString() });
    } catch {
      return res.status(500).json({ error: 'Could not retrieve country monitoring data' });
    }
  }

  return { catalog, list };
}

export default createCountryController;
