import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, defer, firstValueFrom, map, Observable, of, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import { AuthStatus, LoginRequest, LoginResponse, SessionResponse } from '../models/auth.models';

const TOKEN_STORAGE_KEY = 'breaking-news-monitor.access-token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly state = signal<AuthStatus>('checking');
  private initialization: Promise<boolean> | null = null;

  readonly status = this.state.asReadonly();
  readonly isAuthenticated = computed(() => this.state() === 'authenticated');

  /** Validate a stored session once before route guards allow protected views. */
  initialize(): Promise<boolean> {
    if (this.initialization) return this.initialization;

    const token = this.getAccessToken();
    if (!token) {
      this.state.set('unauthenticated');
      this.initialization = Promise.resolve(false);
      return this.initialization;
    }

    this.state.set('checking');
    this.initialization = firstValueFrom(
      defer(() => this.http.get<SessionResponse>(this.endpoint('/api/auth/session'))).pipe(
        map((response) => {
          const valid = response?.authenticated === true;
          if (!valid) this.clearStoredToken();
          return valid;
        }),
        catchError((error: unknown) => {
          if (!(error instanceof HttpErrorResponse) || error.status === 401) this.clearStoredToken();
          return of(false);
        }),
      ),
    ).then((valid) => {
      if (valid) {
        this.state.set('authenticated');
      } else {
        this.state.set('unauthenticated');
      }
      return valid;
    });

    return this.initialization;
  }

  login(credentials: LoginRequest): Observable<void> {
    this.state.set('checking');
    return defer(() => this.http.post<LoginResponse>(this.endpoint('/api/auth/login'), credentials)).pipe(
      tap((response) => {
        if (typeof response?.accessToken !== 'string' || !response.accessToken
          || response.tokenType !== 'Bearer' || !Number.isFinite(response.expiresIn)) {
          throw new Error('The authentication service returned an invalid response.');
        }

        try {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, response.accessToken);
        } catch {
          throw new Error('This browser could not store the sign-in session. Enable session storage and try again.');
        }

        this.initialization = Promise.resolve(true);
        this.state.set('authenticated');
      }),
      map(() => undefined),
      catchError((error: unknown) => {
        this.clearStoredToken();
        this.initialization = Promise.resolve(false);
        this.state.set('unauthenticated');
        return throwError(() => error);
      }),
    );
  }

  /** Local logout: the backend exposes no token-revocation endpoint. */
  logout(): void {
    this.clearStoredToken();
    this.initialization = Promise.resolve(false);
    this.state.set('unauthenticated');
    if (this.router.url !== '/login') void this.router.navigateByUrl('/login');
  }

  getAccessToken(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /** Called by the interceptor for a 401 from a protected backend API route. */
  handleUnauthorized(): void {
    this.clearStoredToken();
    this.initialization = Promise.resolve(false);
    this.state.set('unauthenticated');
    if (this.router.url !== '/login') void this.router.navigateByUrl('/login');
  }

  private endpoint(path: string): string {
    const baseUrl = getApiBaseUrl(environment.apiBaseUrl).trim().replace(/\/+$/, '');
    return `${baseUrl}${path}`;
  }

  private clearStoredToken(): void {
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // The in-memory state is still cleared when browser storage is unavailable.
    }
  }
}
