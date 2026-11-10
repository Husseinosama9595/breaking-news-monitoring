import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authInterceptor } from '../../core/interceptors/auth.interceptor';
import { LivePostNotification } from '../../core/models/live-notification.model';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { CountryFeedPageComponent } from './country-feed-page.component';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const SUMMARY = { countryCode: 'IR', countryName: 'Iran', accountCount: 1, activeAccountCount: 1, failedPollAccountCount: 0, staleFeedAccountCount: 0, unknownFeedAccountCount: 0, postCount: 1, postsDetectedToday: 1, latestPublishedAt: '2026-11-10T10:00:00.000Z' };
const OVERVIEW = { countries: [SUMMARY], unassigned: { ...SUMMARY, countryCode: null, countryName: undefined, accountCount: 0, postCount: 0 }, totals: { countryCount: 1, accountCount: 1, activeAccountCount: 1, postCount: 1, postsDetectedToday: 1 }, serverTime: '2026-11-10T12:00:00.000Z', dayStartsAt: '2026-11-10T00:00:00.000Z' };

describe('CountryFeedPageComponent', () => {
  let fixture: ComponentFixture<CountryFeedPageComponent>;
  let http: HttpTestingController;
  const liveEvent = signal<LivePostNotification | null>(null);
  const routeParams = new BehaviorSubject(convertToParamMap({ countryCode: 'IR' }));

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_KEY, 'country-test-token');
    liveEvent.set(null);
    routeParams.next(convertToParamMap({ countryCode: 'IR' }));
    TestBed.configureTestingModule({
      imports: [CountryFeedPageComponent],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: routeParams.asObservable() } },
        { provide: LiveNotificationsService, useValue: { lastLiveNotification: liveEvent } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CountryFeedPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => { http.verify({ ignoreCancelled: true }); sessionStorage.clear(); vi.useRealTimers(); });

  function flushOverview(): void {
    const overview = http.expectOne('http://localhost:3000/api/countries');
    expect(overview.request.headers.get('Authorization')).toBe('Bearer country-test-token');
    overview.flush(OVERVIEW);
  }

  function flushCountryData(country = 'IR', options: { search?: string; category?: string; notificationStatus?: string; page?: number; posts?: unknown[]; totalPages?: number } = {}): void {
    const apiCountry = country === 'UNASSIGNED' ? 'unassigned' : country;
    http.expectOne(`http://localhost:3000/api/accounts?country=${apiCountry}`).flush({ accounts: [{ _id: 'a1', platform: 'x', username: 'sourceIR', displayName: 'Iran Source', countryCode: country === 'UNASSIGNED' ? null : country, countryName: 'Iran', category: 'Politics', enabled: true, providerName: 'nitter', monitoringStatus: 'active', lastSuccessfulFetchAt: null, pollHealth: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }] });
    let url = `http://localhost:3000/api/posts?country=${apiCountry}&page=${options.page ?? 1}&limit=20`;
    if (options.search) url += `&search=${encodeURIComponent(options.search)}`;
    if (options.category) url += `&category=${encodeURIComponent(options.category)}`;
    if (options.notificationStatus) url += `&notificationStatus=${options.notificationStatus}`;
    http.expectOne(url).flush({ posts: options.posts ?? [{ _id: 'p1', monitoredAccountId: 'a1', countryCode: country === 'UNASSIGNED' ? null : country, countryName: 'Iran', username: 'sourceIR', text: 'Country scoped post content', publishedAt: '2026-11-10T10:00:00.000Z', postUrl: 'https://x.com/sourceIR/status/1', category: 'Politics', providerName: 'nitter', priority: 'HIGH', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T10:00:01.000Z' }], pagination: { page: options.page ?? 1, limit: 20, total: options.posts?.length ?? 1, totalPages: options.totalPages ?? 1 } });
  }

  function flushLiveRefresh(): void {
    http.expectOne('http://localhost:3000/api/countries').flush(OVERVIEW);
    http.expectOne('http://localhost:3000/api/posts?country=IR&page=1&limit=20').flush({ posts: [{ _id: 'p2', monitoredAccountId: 'a1', countryCode: 'IR', countryName: 'Iran', username: 'sourceIR', text: 'Updated country feed post', publishedAt: '2026-11-10T12:00:00.000Z', postUrl: 'https://x.com/sourceIR/status/2', category: 'Politics', providerName: 'nitter', priority: 'HIGH', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T12:00:01.000Z' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
  }

  it('loads the selected country summary, assigned accounts, and country-filtered posts', () => {
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Iran');
    expect(page.textContent).toContain('Iran Source');
    expect(page.textContent).toContain('Country scoped post content');
    expect(page.querySelector('a[href="https://x.com/sourceIR/status/1"]')).not.toBeNull();
  });

  it('refreshes the same country feed when its existing global SSE service receives a matching event', () => {
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    liveEvent.set({ eventId: 'p2', notificationId: 'p2', postId: 'p2', username: 'sourceIR', displayName: null, textPreview: 'new', postUrl: null, publishedAt: null, detectedAt: '2026-11-10T12:00:00.000Z', readAt: null, category: 'Politics', countryCode: 'IR', countryName: 'Iran', monitoredAccountId: 'a1', read: false });
    fixture.detectChanges();
    flushLiveRefresh();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Updated country feed post');
  });

  it('resolves current account country when an SSE event carries a stale country after reassignment', () => {
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    liveEvent.set({ eventId: 'p3', notificationId: 'p3', postId: 'p3', username: 'sourceIR', displayName: null, textPreview: 'new', postUrl: null, publishedAt: null, detectedAt: '2026-11-10T12:00:00.000Z', readAt: null, category: 'Politics', countryCode: 'US', countryName: 'United States', monitoredAccountId: 'a1', read: false });
    fixture.detectChanges();
    const currentAccount = http.expectOne('http://localhost:3000/api/accounts/a1');
    expect(currentAccount.request.headers.get('Authorization')).toBe('Bearer country-test-token');
    currentAccount.flush({ account: { _id: 'a1', countryCode: 'IR' } });
    flushLiveRefresh();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Updated country feed post');
  });

  it('debounces partial case-insensitive search and preserves country while resetting pagination', async () => {
    vi.useFakeTimers();
    flushOverview();
    flushCountryData('IR', { totalPages: 3 });
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.country-pagination button:last-child')!.click();
    const pageTwo = http.expectOne('http://localhost:3000/api/posts?country=IR&page=2&limit=20');
    pageTwo.flush({ posts: [], pagination: { page: 2, limit: 20, total: 41, totalPages: 3 } });
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[formControlName="search"]')!;
    input.value = 'elon';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect((fixture.componentInstance as unknown as { pendingSearchTerm: string | null }).pendingSearchTerm).toBe('elon');
    await vi.advanceTimersByTimeAsync(349);
    http.expectNone((request) => request.url === 'http://localhost:3000/api/posts' && request.params.has('search'));
    await vi.advanceTimersByTimeAsync(1);
    expect((fixture.componentInstance as unknown as { pendingSearchTerm: string | null }).pendingSearchTerm).toBeNull();
    const search = http.expectOne('http://localhost:3000/api/posts?country=IR&page=1&limit=20&search=elon');
    search.flush({ posts: [{ _id: 'elon', username: 'elonmusk', author: { username: 'elonmusk', displayName: 'Elon Musk' }, text: 'A post about space', publishedAt: '2026-11-10T10:00:00.000Z', postUrl: null, category: 'Technology', priority: 'NORMAL', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T10:00:00.000Z' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('@elonmusk');

    input.value = 'ELON';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(350);
    http.expectOne('http://localhost:3000/api/posts?country=IR&page=1&limit=20&search=ELON').flush({ posts: [{ _id: 'elon-case', username: 'elonmusk', author: { username: 'elonmusk', displayName: 'Elon Musk' }, text: 'A post about space', publishedAt: '2026-11-10T10:00:00.000Z', postUrl: null, category: 'Technology', priority: 'NORMAL', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T10:00:00.000Z' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('@elonmusk');
  });

  it('supports @-prefixed search and clears immediately without dropping the country filter', async () => {
    vi.useFakeTimers();
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[formControlName="search"]')!;
    input.value = '@elon';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(350);
    http.expectOne((request) => request.url === 'http://localhost:3000/api/posts' && request.params.get('country') === 'IR' && request.params.get('search') === '@elon').flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.country-filters .clear-button')!.click();
    const restored = http.expectOne('http://localhost:3000/api/posts?country=IR&page=1&limit=20');
    restored.flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    expect(restored.request.params.get('country')).toBe('IR');
  });

  it('searches only within Unassigned and cancels stale country requests when switching feeds', async () => {
    vi.useFakeTimers();
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    routeParams.next(convertToParamMap({ countryCode: 'UNASSIGNED' }));
    http.expectOne('http://localhost:3000/api/accounts?country=unassigned').flush({ accounts: [] });
    const stale = http.expectOne('http://localhost:3000/api/posts?country=unassigned&page=1&limit=20');
    stale.flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[formControlName="search"]')!;
    input.value = 'ELON';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(350);
    const unassignedSearch = http.expectOne('http://localhost:3000/api/posts?country=unassigned&page=1&limit=20&search=ELON');
    unassignedSearch.flush({ posts: [{ _id: 'elon', username: 'elonmusk', author: { username: 'elonmusk', displayName: 'Elon Musk' }, text: 'Unassigned match', publishedAt: null, postUrl: null, category: 'Other', priority: 'NORMAL', processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T10:00:00.000Z' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Unassigned match');
    input.value = 'stale-search';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(350);
    const staleSearch = http.expectOne('http://localhost:3000/api/posts?country=unassigned&page=1&limit=20&search=stale-search');
    routeParams.next(convertToParamMap({ countryCode: 'US' }));
    expect(staleSearch.cancelled).toBe(true);
    http.expectOne('http://localhost:3000/api/accounts?country=US').flush({ accounts: [] });
    http.expectOne('http://localhost:3000/api/posts?country=US&page=1&limit=20&search=stale-search').flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    expect(staleSearch.cancelled).toBe(true);
  });

  it('shows empty results after a successful search with no matches', async () => {
    vi.useFakeTimers();
    flushOverview();
    flushCountryData();
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[formControlName="search"]')!;
    input.value = 'nothing-matches';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(350);
    http.expectOne('http://localhost:3000/api/posts?country=IR&page=1&limit=20&search=nothing-matches').flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No posts match this country');
  });
});
