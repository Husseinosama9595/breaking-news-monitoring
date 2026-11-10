export interface CountryCatalogItem {
  countryCode: string;
  countryName: string;
}

export interface CountrySummary {
  countryCode: string | null;
  countryName?: string;
  accountCount: number;
  activeAccountCount: number;
  failedPollAccountCount: number;
  staleFeedAccountCount: number;
  unknownFeedAccountCount: number;
  postCount: number;
  postsDetectedToday: number;
  latestPublishedAt: string | null;
}

export interface CountryOverviewResponse {
  countries: CountrySummary[];
  unassigned: CountrySummary;
  totals: {
    countryCount: number;
    accountCount: number;
    activeAccountCount: number;
    postCount: number;
    postsDetectedToday: number;
  };
  serverTime: string;
  dayStartsAt: string;
}

export interface CountryCatalogResponse {
  countries: CountryCatalogItem[];
}
