import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authInterceptor } from '../../core/interceptors/auth.interceptor';
import { GlobalSearchPageComponent } from './global-search-page.component';

const API_URL = 'http://localhost:3000/api';
const TOKEN_KEY = 'breaking-news-monitor.access-token';
const ACCOUNTS = { accounts: [{ _id: 'a1', platform: 'x' as const, username: 'elonmusk', displayName: 'Elon Musk', category: 'Technology' as const, countryCode: 'US', countryName: 'United States', enabled: true, providerName: 'nitter', monitoringStatus: 'active' as const, lastSuccessfulFetchAt: null, pollHealth: null, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' }], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } };
const POSTS = { posts: [{ _id: 'p1', monitoredAccountId: 'a1', countryCode: 'US', countryName: 'United States', username: 'elonmusk', author: { username: 'elonmusk', displayName: 'Elon Musk' }, text: 'Satellite update', publishedAt: '2026-11-10T10:00:00.000Z', postUrl: 'https://x.com/elonmusk/status/1', category: 'Technology', providerName: 'nitter', priority: 'HIGH' as const, processingStatus: 'processed' as const, notificationStatus: 'sent' as const, telegramSent: true, createdAt: '2026-11-10T10:00:01.000Z' }], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } };

describe('GlobalSearchPageComponent', () => {
  let fixture: ComponentFixture<GlobalSearchPageComponent>;
  let http: HttpTestingController;
  const queryParams = new BehaviorSubject(convertToParamMap({ q: 'elon' }));

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_KEY, 'global-search-test-token');
    queryParams.next(convertToParamMap({ q: 'elon' }));
    TestBed.configureTestingModule({
      imports: [GlobalSearchPageComponent],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: queryParams.asObservable() } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GlobalSearchPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => { http.verify({ ignoreCancelled: true }); sessionStorage.clear(); });

  function expectSearchRequests(term: string): { accounts: ReturnType<HttpTestingController['expectOne']>; posts: ReturnType<HttpTestingController['expectOne']> } {
    const accounts = http.expectOne(`${API_URL}/accounts?search=${encodeURIComponent(term)}&page=1&limit=100`);
    const posts = http.expectOne(`${API_URL}/posts?search=${encodeURIComponent(term)}&page=1&limit=100`);
    expect(accounts.request.headers.get('Authorization')).toBe('Bearer global-search-test-token');
    expect(posts.request.headers.get('Authorization')).toBe('Bearer global-search-test-token');
    return { accounts, posts };
  }

  it('searches both existing APIs and renders matched sources and post text', () => {
    const requests = expectSearchRequests('elon');
    requests.accounts.flush(ACCOUNTS);
    requests.posts.flush(POSTS);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Search results');
    expect(page.textContent).toContain('Elon Musk');
    expect(page.textContent).toContain('Satellite update');
    expect(page.querySelector('.post-result a')?.getAttribute('href')).toBe('https://x.com/elonmusk/status/1');
  });

  it('shows a clear empty state when neither API returns matches', () => {
    const requests = expectSearchRequests('elon');
    requests.accounts.flush({ accounts: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
    requests.posts.flush({ posts: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No results found');
  });

  it('uses a new query parameter to cancel stale requests and search again', () => {
    const first = expectSearchRequests('elon');
    queryParams.next(convertToParamMap({ q: 'rocket' }));
    expect(first.accounts.cancelled).toBe(true);
    expect(first.posts.cancelled).toBe(true);
    const next = expectSearchRequests('rocket');
    next.accounts.flush({ accounts: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
    next.posts.flush({ posts: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('“rocket”');
  });

  it('shows an API error and retries both searches', () => {
    const requests = expectSearchRequests('elon');
    requests.accounts.flush({ error: 'Search unavailable' }, { status: 500, statusText: 'Internal Server Error' });
    expect(requests.posts.cancelled).toBe(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Search unavailable');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.search-error button')!.click();
    const retry = expectSearchRequests('elon');
    retry.accounts.flush(ACCOUNTS);
    retry.posts.flush(POSTS);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Satellite update');
  });
});
