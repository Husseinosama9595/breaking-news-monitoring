import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authInterceptor } from '../../core/interceptors/auth.interceptor';
import { DashboardPageComponent } from './dashboard-page.component';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const API_URL = 'http://localhost:3000/api/accounts';
const POSTS_API_URL = 'http://localhost:3000/api/posts?page=1&limit=5';
const EMPTY_COUNTRY_OVERVIEW = { countries: [], unassigned: { countryCode: null, accountCount: 0, activeAccountCount: 0, failedPollAccountCount: 0, staleFeedAccountCount: 0, unknownFeedAccountCount: 0, postCount: 0, postsDetectedToday: 0, latestPublishedAt: null }, totals: { countryCount: 0, accountCount: 0, activeAccountCount: 0, postCount: 0, postsDetectedToday: 0 }, serverTime: '2026-11-10T12:00:00.000Z', dayStartsAt: '2026-11-10T00:00:00.000Z' };

describe('DashboardPageComponent account roster', () => {
  let fixture: ComponentFixture<DashboardPageComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_KEY, 'dashboard-test-token');
    TestBed.configureTestingModule({
      imports: [DashboardPageComponent],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: CountriesApiService, useValue: { overview: signal(EMPTY_COUNTRY_OVERVIEW), getOverview: () => of(EMPTY_COUNTRY_OVERVIEW), refreshOverview: () => of(EMPTY_COUNTRY_OVERVIEW) } },
        { provide: LiveNotificationsService, useValue: { lastLiveNotification: signal(null) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DashboardPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('loads the account DTO response and renders its account fields', () => {
    const request = http.expectOne(API_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe('Bearer dashboard-test-token');
    request.flush({ accounts: [{
      _id: 'account-1',
      platform: 'x',
      username: 'realDonaldTrump',
      displayName: 'Donald J. Trump',
      category: 'Politics',
      enabled: true,
      providerName: 'nitter',
      monitoringStatus: 'active',
      lastSuccessfulFetchAt: '2026-11-10T09:15:00.000Z',
      pollHealth: {
        lastStartedAt: '2026-11-10T09:14:59.000Z', lastCompletedAt: '2026-11-10T09:15:01.000Z',
        lastDurationMs: 2000, lastStatus: 'success', lastErrorCode: null,
        returnedEntryCount: 8, insertedPostCount: 2, duplicatePostCount: 6,
        feedObservedAt: '2026-11-10T09:15:00.000Z', newestPublishedAt: '2026-11-10T09:10:00.000Z',
        timestampedEntryCount: 8, untimestampedEntryCount: 0, freshness: 'fresh', freshnessMaxAgeMs: 21600000,
      },
      createdAt: '2026-11-01T09:15:00.000Z',
      updatedAt: '2026-11-10T09:15:00.000Z',
    }] });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();

    const roster = fixture.nativeElement.querySelector('.accounts-panel') as HTMLElement;
    expect(roster.textContent).toContain('@realDonaldTrump');
    expect(roster.textContent).toContain('Donald J. Trump');
    expect(roster.textContent).toContain('Politics');
    expect(roster.textContent).toContain('nitter');
    expect(roster.textContent).toContain('active');
    expect(roster.textContent).toContain('Enabled');
    expect(roster.textContent).toContain('Fetched');
    expect(roster.textContent).toContain('Fresh');
    expect(roster.textContent).toContain('Poll succeeded');
    expect(roster.querySelector('a[routerLink="/accounts"]')).not.toBeNull();
  });

  it('shows an empty state for an empty account response', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No monitored accounts found.');
    const kpis = fixture.nativeElement.querySelectorAll('.kpi-number') as NodeListOf<HTMLElement>;
    expect(kpis[0].textContent?.trim()).toBe('0');
    expect(kpis[1].textContent?.trim()).toBe('0');
    expect(kpis[2].textContent?.trim()).toBe('0');
    expect(kpis[3].textContent?.trim()).toBe('0');
  });

  it('renders real posts returned by the posts API without demo entries', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    http.expectOne(POSTS_API_URL).flush({ posts: [{
      _id: 'post-1', username: 'wireDesk', author: { username: 'wireDesk', displayName: 'Wire Desk' },
      text: 'A real API fixture used by the test.', publishedAt: '2026-11-10T08:00:00.000Z',
      postUrl: 'https://x.com/wireDesk/status/123', category: 'World News', providerName: 'nitter', priority: 'HIGH',
      processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T08:01:00.000Z',
    }], pagination: { page: 1, limit: 5, total: 3, totalPages: 1 } });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Wire Desk');
    expect(page.textContent).toContain('A real API fixture used by the test.');
    expect(page.textContent).not.toContain('DEMO SOURCE');
    expect(page.querySelector('a[href="https://x.com/wireDesk/status/123"]')).toBeNull();
    expect(page.querySelector('.kpi-grid')?.textContent).toContain('3');
  });

  it('shows a post API error and can retry that endpoint', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    http.expectOne(POSTS_API_URL).flush({ error: 'Post service unavailable' }, { status: 500, statusText: 'Internal Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Post service unavailable');
    (fixture.nativeElement.querySelector('.feed-state button') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No collected posts yet');
  });

  it('shows a retry action after an API error and retries the same endpoint', () => {
    http.expectOne(API_URL).flush({ error: 'Account service unavailable' }, {
      status: 500,
      statusText: 'Internal Server Error',
    });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Account service unavailable');

    const retry = fixture.nativeElement.querySelector('.accounts-message button') as HTMLButtonElement;
    retry.click();
    fixture.detectChanges();
    const retryRequest = http.expectOne(API_URL);
    retryRequest.flush({ accounts: [] });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No monitored accounts found.');
  });

  it('calculates total, active and disabled counts from account status fields', () => {
    http.expectOne(API_URL).flush({ accounts: [
      { _id: '1', platform: 'x', username: 'activeOne', displayName: null, category: 'Other', enabled: true, providerName: 'mock', monitoringStatus: 'active', lastSuccessfulFetchAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: '2', platform: 'x', username: 'activeTwo', displayName: null, category: 'Other', enabled: true, providerName: 'nitter', monitoringStatus: 'active', lastSuccessfulFetchAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: '3', platform: 'x', username: 'disabledOne', displayName: null, category: 'Other', enabled: false, providerName: 'mock', monitoringStatus: 'paused', lastSuccessfulFetchAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { _id: '4', platform: 'x', username: 'errorOne', displayName: null, category: 'Other', enabled: true, providerName: 'nitter', monitoringStatus: 'error', lastSuccessfulFetchAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ] });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 7, totalPages: 2 } });
    fixture.detectChanges();

    const kpis = fixture.nativeElement.querySelectorAll('.kpi-number') as NodeListOf<HTMLElement>;
    expect(kpis[0].textContent?.trim()).toBe('0');
    expect(kpis[1].textContent?.trim()).toBe('4');
    expect(kpis[2].textContent?.trim()).toBe('0');
    expect(kpis[3].textContent?.trim()).toBe('7');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('2 active · 1 disabled');
  });

  it('clears account KPIs to unavailable after an account API error', () => {
    http.expectOne(API_URL).flush({ error: 'Account service unavailable' }, {
      status: 500,
      statusText: 'Internal Server Error',
    });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();

    const kpis = fixture.nativeElement.querySelectorAll('.kpi-number') as NodeListOf<HTMLElement>;
    expect(kpis[0].textContent?.trim()).toBe('0');
    expect(kpis[1].textContent?.trim()).toBe('—');
    expect(kpis[2].textContent?.trim()).toBe('0');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Account service unavailable');
  });

  it('refreshes the account request and updates the statistics', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.dashboard-refresh') as HTMLButtonElement).click();
    fixture.detectChanges();

    http.expectOne(API_URL).flush({ accounts: [{
      _id: 'refresh-1', platform: 'x', username: 'freshAccount', displayName: null,
      category: 'World News', enabled: true, providerName: 'nitter', monitoringStatus: 'active',
      lastSuccessfulFetchAt: null,
      pollHealth: {
        lastStartedAt: null, lastCompletedAt: null, lastDurationMs: null, lastStatus: 'failed',
        lastErrorCode: 'NITTER_INSTANCES_COOLING_DOWN', returnedEntryCount: null, insertedPostCount: null,
        duplicatePostCount: null, feedObservedAt: null, newestPublishedAt: null,
        timestampedEntryCount: null, untimestampedEntryCount: null, freshness: 'unknown', freshnessMaxAgeMs: 21600000,
      },
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    }] });
    http.expectOne(POSTS_API_URL).flush({ posts: [], pagination: { page: 1, limit: 5, total: 1, totalPages: 1 } });
    fixture.detectChanges();

    const kpis = fixture.nativeElement.querySelectorAll('.kpi-number') as NodeListOf<HTMLElement>;
    expect(kpis[0].textContent?.trim()).toBe('0');
    expect(kpis[1].textContent?.trim()).toBe('1');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Unknown');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Poll failed');
  });
});
