# HTTP interceptors

`auth.interceptor.ts` adds the session Bearer token only to same-origin backend `/api/*` requests. A 401 from protected API requests clears the local session and redirects to login; login and startup session validation errors are handled by their callers.
