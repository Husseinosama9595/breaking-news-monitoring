import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { authInterceptor } from '../interceptors/auth.interceptor';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const API_BASE = 'http://localhost:3000';

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('posts login credentials to the existing endpoint and stores the returned token in sessionStorage', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'stale-session-token');
    let completed = false;
    auth.login({ username: 'local-test-admin', password: 'test-only-password' }).subscribe(() => { completed = true; });

    const request = http.expectOne(`${API_BASE}/api/auth/login`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.has('Authorization')).toBe(false);
    expect(request.request.body).toEqual({ username: 'local-test-admin', password: 'test-only-password' });
    request.flush({ accessToken: 'mock-jwt-for-unit-test', tokenType: 'Bearer', expiresIn: 28800 });

    expect(completed).toBe(true);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('mock-jwt-for-unit-test');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('propagates invalid-credential responses without retaining a token', () => {
    let receivedError: unknown;
    auth.login({ username: 'invalid-test-user', password: 'invalid-test-password' })
      .subscribe({ error: (error: unknown) => { receivedError = error; } });
    const request = http.expectOne(`${API_BASE}/api/auth/login`);
    request.flush({ error: 'Invalid username or password' }, { status: 401, statusText: 'Unauthorized' });

    expect(receivedError).toBeInstanceOf(HttpErrorResponse);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('validates a stored token through the session endpoint and attaches its Bearer header', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'mock-session-jwt');
    const initialized = auth.initialize();
    const request = http.expectOne(`${API_BASE}/api/auth/session`);

    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe('Bearer mock-session-jwt');
    request.flush({ authenticated: true });

    await expect(initialized).resolves.toBe(true);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('attaches the Bearer token to an absolute protected backend API URL', () => {
    const client = TestBed.inject(HttpClient);
    sessionStorage.setItem(TOKEN_KEY, 'mock-session-jwt');
    client.get(`${API_BASE}/api/accounts`).subscribe();

    const request = http.expectOne(`${API_BASE}/api/accounts`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer mock-session-jwt');
    request.flush({ accounts: [] });
  });

  it('clears a stored token when the session endpoint rejects it', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'expired-test-jwt');
    const initialized = auth.initialize();
    const request = http.expectOne(`${API_BASE}/api/auth/session`);
    request.flush({ error: 'Invalid or expired authentication token' }, { status: 401, statusText: 'Unauthorized' });

    await expect(initialized).resolves.toBe(false);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('keeps the token when session validation cannot reach the backend', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'temporarily-unverified-jwt');
    const initialized = auth.initialize();
    const request = http.expectOne(`${API_BASE}/api/auth/session`);
    request.error(new ProgressEvent('error'));

    await expect(initialized).resolves.toBe(false);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('temporarily-unverified-jwt');
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('does not call the session endpoint when there is no stored token', async () => {
    await expect(auth.initialize()).resolves.toBe(false);
    http.expectNone(`${API_BASE}/api/auth/session`);
    expect(auth.status()).toBe('unauthenticated');
  });

  it('does not attach the admin token to an unrelated external request', () => {
    const client = TestBed.inject(HttpClient);
    sessionStorage.setItem(TOKEN_KEY, 'mock-session-jwt');
    client.get('https://example.invalid/resource').subscribe();

    const request = http.expectOne('https://example.invalid/resource');
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ ok: true });
  });
});
