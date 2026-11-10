# Route guards

`auth.guard.ts` validates the admin session before protected routes activate and redirects unauthenticated users to `/login`. Its `loginGuard` redirects an authenticated administrator to `/dashboard`.
