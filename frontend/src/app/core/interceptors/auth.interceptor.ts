import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import { AuthService } from '../auth/auth.service';

function backendApiPath(requestUrl: string): string | null {
  const apiBaseUrl = getApiBaseUrl(environment.apiBaseUrl).trim();

  try {
    const backend = apiBaseUrl ? new URL(apiBaseUrl) : new URL(globalThis.location?.origin ?? 'http://localhost');
    const request = new URL(requestUrl, backend);
    if (request.origin !== backend.origin || !request.pathname.startsWith('/api/')) return null;
    return request.pathname;
  } catch {
    return null;
  }
}

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const path = backendApiPath(request.url);
  const isLoginRequest = path === '/api/auth/login';
  const isSessionValidation = path === '/api/auth/session';
  const token = path && !isLoginRequest ? auth.getAccessToken() : null;
  const authorizedRequest = token
    ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : request;

  return next(authorizedRequest).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && path
        && !isLoginRequest && !isSessionValidation) {
        auth.handleUnauthorized();
      }
      return throwError(() => error);
    }),
  );
};
