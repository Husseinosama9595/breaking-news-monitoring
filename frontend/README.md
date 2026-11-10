# Breaking News Monitor frontend

Angular standalone application for the existing backend. It includes administrator login/session validation and protected routes. News metrics and feed views remain visual placeholders; no simulated post or account data is presented as live.

## Requirements

- Node.js 24.15+ (the installed Node 24.19 runtime is compatible with Angular 22)
- npm

## Install and run

From PowerShell:

```powershell
Set-Location "C:\Users\husse\OneDrive\Desktop\Real-Time Breaking News Monitoring & Alerting Platform\frontend"
npm install
npm start
```

Open `http://localhost:4200`. Routes include `/login`, `/dashboard`, `/accounts`, `/posts`, `/notifications`, and `/settings`.

## Backend URL configuration

`src/environments/environment.ts` sets `apiBaseUrl` to `http://localhost:3000` for development. The auth service uses the existing `POST /api/auth/login` and `GET /api/auth/session` endpoints. Ensure the backend's already configured CORS origin permits `http://localhost:4200`.

The JWT is stored in browser `sessionStorage`, attached only to same-origin backend `/api/*` requests, and removed when the session is rejected or the administrator signs out. On startup, a stored token is checked against the session endpoint before protected routes render. The backend has no revocation endpoint, so logout clears the browser session; it does not revoke an already-issued stateless JWT server-side.

## Manual authentication check

1. Start the backend using its normal local setup, then run `npm start` here.
2. Visit `/login`, enter the administrator credentials configured locally for the backend, and submit. Do not share those credentials.
3. Try invalid credentials to confirm the backend's error appears on the form.
4. Refresh a protected route such as `/accounts`. A valid session should remain signed in; an expired/invalid token should be cleared and return to `/login`.
5. Visit `/dashboard`, `/accounts`, `/posts`, `/notifications`, and `/settings` while signed out to confirm each redirects to `/login`.
6. Sign out using the control at the bottom of the sidebar. The token should be removed from session storage and the app should return to `/login`.

Frontend unit tests use Angular's HTTP testing backend with test-only values; they do not send credentials to the real API.

## Build

```powershell
npm run build
```

The routed shell uses Angular standalone components and strict TypeScript. Bootstrap 5.3.8 and Bootstrap Icons are installed from npm; UI behavior does not depend on a remote CDN.
