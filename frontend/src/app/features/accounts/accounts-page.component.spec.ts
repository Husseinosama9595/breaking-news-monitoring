import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authInterceptor } from '../../core/interceptors/auth.interceptor';
import { AccountsPageComponent } from './accounts-page.component';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const API_URL = 'http://localhost:3000/api/accounts';
const POLL_HEALTH = {
  lastStartedAt: '2026-11-10T09:14:59.000Z',
  lastCompletedAt: '2026-11-10T09:15:01.000Z',
  lastDurationMs: 2000,
  lastStatus: 'success' as const,
  lastErrorCode: null,
  returnedEntryCount: 8,
  insertedPostCount: 2,
  duplicatePostCount: 6,
  feedObservedAt: '2026-11-10T09:15:00.000Z',
  newestPublishedAt: '2026-11-10T09:10:00.000Z',
  timestampedEntryCount: 8,
  untimestampedEntryCount: 0,
  freshness: 'fresh' as const,
  freshnessMaxAgeMs: 21600000,
};
const ACCOUNT = {
  _id: 'account-1',
  platform: 'x' as const,
  username: 'realDonaldTrump',
  displayName: 'Donald J. Trump',
  category: 'Politics' as const,
  enabled: true,
  providerName: 'nitter',
  monitoringStatus: 'active' as const,
  lastSuccessfulFetchAt: '2026-11-10T09:15:00.000Z',
  pollHealth: POLL_HEALTH,
  createdAt: '2026-11-01T09:15:00.000Z',
  updatedAt: '2026-11-10T09:15:00.000Z',
};

describe('AccountsPageComponent', () => {
  let fixture: ComponentFixture<AccountsPageComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_KEY, 'accounts-test-token');
    TestBed.configureTestingModule({
      imports: [AccountsPageComponent],
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([{ path: 'login', children: [] }]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AccountsPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('loads and displays account fields with a count from the API response', () => {
    const request = http.expectOne(API_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe('Bearer accounts-test-token');
    request.flush({ accounts: [ACCOUNT] });
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('1 account');
    expect(page.textContent).toContain('@realDonaldTrump');
    expect(page.textContent).toContain('Donald J. Trump');
    expect(page.textContent).toContain('Politics');
    expect(page.textContent).toContain('nitter');
    expect(page.textContent).toContain('active');
    expect(page.textContent).toContain('Enabled');
    expect(page.textContent).toContain('Fresh');
    expect(page.textContent).toContain('Succeeded');
    expect(page.textContent).toContain('Entries returned');
    expect(page.textContent).toContain('8');
    expect(page.textContent).toContain('Posts inserted');
    expect(page.textContent).toContain('2000 ms');
    expect(page.textContent).toContain('ACCOUNT MANAGEMENT');
  });

  it('distinguishes fresh, stale, empty and unknown feed freshness', () => {
    http.expectOne(API_URL).flush({ accounts: [
      { ...ACCOUNT, _id: 'fresh', pollHealth: { ...POLL_HEALTH, freshness: 'fresh' } },
      { ...ACCOUNT, _id: 'stale', pollHealth: { ...POLL_HEALTH, freshness: 'stale' } },
      { ...ACCOUNT, _id: 'empty', pollHealth: { ...POLL_HEALTH, freshness: 'empty', returnedEntryCount: 0 } },
      { ...ACCOUNT, _id: 'unknown', pollHealth: { ...POLL_HEALTH, freshness: 'unknown', newestPublishedAt: null } },
    ] });
    fixture.detectChanges();

    const badges = fixture.nativeElement.querySelectorAll('.freshness-badge') as NodeListOf<HTMLElement>;
    expect([...badges].map((badge) => badge.textContent?.trim())).toEqual(['Fresh', 'Stale', 'Empty', 'Unknown']);
    expect(badges[0].classList.contains('freshness-fresh')).toBe(true);
    expect(badges[1].classList.contains('freshness-stale')).toBe(true);
    expect(badges[2].classList.contains('freshness-empty')).toBe(true);
    expect(badges[3].classList.contains('freshness-unknown')).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not a provider failure');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('cannot be determined');
  });

  it('handles legacy poll-health nulls and missing or invalid timestamps safely', () => {
    http.expectOne(API_URL).flush({ accounts: [{
      ...ACCOUNT,
      lastSuccessfulFetchAt: 'not-a-date',
      pollHealth: null,
    }] });
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('.freshness-unknown')?.textContent?.trim()).toBe('Unknown');
    expect(page.textContent).toContain('Never');
    expect(page.textContent).toContain('Not polled');
    expect(page.textContent).toContain('Not available');
    expect(page.textContent).toContain('Entries returned');
  });

  it('shows failed poll outcome and safe provider error code without raw error details', () => {
    http.expectOne(API_URL).flush({ accounts: [{
      ...ACCOUNT,
      pollHealth: { ...POLL_HEALTH, lastStatus: 'failed', lastErrorCode: 'NITTER_INSTANCES_COOLING_DOWN', freshness: 'stale' },
    }] });
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Failed');
    expect(page.textContent).toContain('Provider error code: NITTER_INSTANCES_COOLING_DOWN');
    expect(page.textContent).not.toContain('stack');
  });

  it('shows an empty state for an empty account response', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('0 accounts');
    expect(page.textContent).toContain('No monitored accounts yet');
    expect(page.querySelector('table')).toBeNull();
  });

  it('shows an error and retries GET /api/accounts', () => {
    http.expectOne(API_URL).flush({ error: 'Account service unavailable' }, {
      status: 500,
      statusText: 'Internal Server Error',
    });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Account service unavailable');

    const retry = fixture.nativeElement.querySelector('.retry-button') as HTMLButtonElement;
    retry.click();
    fixture.detectChanges();
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No monitored accounts yet');
  });

  it('handles an unauthorized account response through the existing auth interceptor', () => {
    http.expectOne(API_URL).flush({ error: 'Invalid or expired authentication token' }, {
      status: 401,
      statusText: 'Unauthorized',
    });
    fixture.detectChanges();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Invalid or expired authentication token');
  });

  it('refreshes the account list manually', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.refresh-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const refreshRequest = http.expectOne(API_URL);
    expect(refreshRequest.request.method).toBe('GET');
    refreshRequest.flush({ accounts: [] });
  });

  it('creates an account with normalized username and refreshes the list', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.add-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    (page.querySelector('#account-username') as HTMLInputElement).value = '@Reuters';
    (page.querySelector('#account-username') as HTMLInputElement).dispatchEvent(new Event('input'));
    (page.querySelector('#account-display-name') as HTMLInputElement).value = 'Reuters';
    (page.querySelector('#account-display-name') as HTMLInputElement).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (page.querySelector('.dialog-actions button[type="submit"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const create = http.expectOne(API_URL);
    expect(create.request.method).toBe('POST');
    expect(create.request.headers.get('Authorization')).toBe('Bearer accounts-test-token');
    expect(create.request.body).toEqual({ username: 'Reuters', displayName: 'Reuters', category: 'Other' });
    create.flush({ account: { ...ACCOUNT, username: 'Reuters', displayName: 'Reuters', category: 'Other' } }, { status: 201, statusText: 'Created' });
    fixture.detectChanges();
    http.expectOne(API_URL).flush({ accounts: [{ ...ACCOUNT, username: 'Reuters', displayName: 'Reuters', category: 'Other' }] });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Account added.');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('@Reuters');
  });

  it('rejects invalid usernames without sending a create request', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.add-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const username = page.querySelector('#account-username') as HTMLInputElement;
    username.value = 'username-is-too-long';
    username.dispatchEvent(new Event('input'));
    username.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(page.textContent).toContain('Enter 1–15 letters, numbers, or underscores.');
    expect((page.querySelector('.dialog-actions button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    http.expectNone(API_URL);
  });

  it('shows backend duplicate username errors and does not refresh on failure', () => {
    http.expectOne(API_URL).flush({ accounts: [] });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.add-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const username = page.querySelector('#account-username') as HTMLInputElement;
    username.value = 'Reuters';
    username.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (page.querySelector('.dialog-actions button[type="submit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne(API_URL).flush({ error: 'An account with this X username already exists' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('An account with this X username already exists');
    http.expectNone(API_URL);
  });

  it('updates account fields and refreshes after a successful edit', () => {
    http.expectOne(API_URL).flush({ accounts: [ACCOUNT] });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.text-action') as HTMLButtonElement).click();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const displayName = page.querySelector('#account-display-name') as HTMLInputElement;
    displayName.value = 'Reuters News';
    displayName.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (page.querySelector('.dialog-actions button[type="submit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const update = http.expectOne(`${API_URL}/account-1`);
    expect(update.request.method).toBe('PATCH');
    expect(update.request.body).toEqual({ username: 'realDonaldTrump', displayName: 'Reuters News', category: 'Politics', providerName: 'nitter' });
    update.flush({ account: { ...ACCOUNT, displayName: 'Reuters News' } });
    fixture.detectChanges();
    http.expectOne(API_URL).flush({ accounts: [{ ...ACCOUNT, displayName: 'Reuters News' }] });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Account updated.');
  });

  it('enables or disables monitoring through supported endpoints and refreshes', () => {
    http.expectOne(API_URL).flush({ accounts: [ACCOUNT] });
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.text-action') as NodeListOf<HTMLButtonElement>;
    buttons[1].click();
    fixture.detectChanges();
    const disable = http.expectOne(`${API_URL}/account-1/disable`);
    expect(disable.request.method).toBe('PATCH');
    expect(disable.request.body).toEqual({});
    disable.flush({ account: { ...ACCOUNT, enabled: false, monitoringStatus: 'paused' } });
    fixture.detectChanges();
    http.expectOne(API_URL).flush({ accounts: [{
      ...ACCOUNT,
      enabled: false,
      monitoringStatus: 'paused',
      pollHealth: { ...POLL_HEALTH, freshness: 'stale', lastStatus: 'failed', lastErrorCode: 'MOCK_RETRYABLE_ERROR' },
    }] });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Monitoring disabled.');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Stale');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('MOCK_RETRYABLE_ERROR');
  });
});
