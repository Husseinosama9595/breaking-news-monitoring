# Postman — Phase 1 Backend

The Phase 1 collection exercises the health and authentication routes implemented at that stage. The monitored-accounts routes are covered by the Phase 2 collection documented below.

## Import

1. In Postman, select **Import**.
2. Choose `Breaking News Monitor.postman_collection.json` from this folder.
3. The collection's `baseUrl` defaults to `http://127.0.0.1:3000`. Edit its current value if the backend uses another port.
4. Create a local Postman environment named `Breaking News Monitor Local` with `adminUsername` and `adminPassword` variables. Enter the values from your local `backend/.env`; mark `adminPassword` as **Secret** if Postman offers that variable type. Keep the environment local and do not export or share it.
5. Select that environment in Postman. Do not place credentials in the collection JSON.

## Run the regular checks

Start the backend from PowerShell:

```powershell
Set-Location "C:\Users\husse\OneDrive\Desktop\Real-Time Breaking News Monitoring & Alerting Platform\backend"
npm run dev
```

Run the **Health and Readiness** folder. The MongoDB test accepts either valid state: HTTP 200 with MongoDB ready, or HTTP 503 with `not_ready` and MongoDB not ready. The Redis test checks that Redis is optional and that readiness is `ready`, `degraded`, or `not_ready` according to the actual MongoDB/Redis state.

Run **Admin login — valid credentials** before **Admin session — valid JWT**. The login test checks the exact implemented response fields (`accessToken`, `tokenType: "Bearer"`, and `expiresIn: 28800`) and automatically stores the token in the collection variable `jwtToken`. The session request uses that variable. The token is a credential; clear the `jwtToken` current value after testing and do not share/export a collection containing a live token.

The negative authentication requests check the implemented 401 responses for a wrong password, an empty username, missing login fields, missing bearer token, and malformed bearer token.

## Run the rate-limit check separately

The login route allows 10 attempts per 15 minutes per client IP. The **Login Rate Limit — run separately after restart** folder sends 11 requests: the first 10 should receive 401 for invalid empty credentials, and the 11th should receive 429. Run this folder by itself after restarting the backend so its in-memory counter is reset. Do not run it in parallel or after other login requests in the same 15-minute window.

The **Global Rate Limit — 121 iterations, run last** folder tests the Express-wide 120-requests-per-minute limiter. Restart the backend, set the `globalRateLimitCount` collection variable to `0`, and run this folder in Collection Runner with **121 iterations** and no delay. The first 120 requests should return 200 and the 121st should return 429. Finish within one minute. This test rate-limits the Postman client IP across the API until the window expires or the backend restarts. Run the login and global limiter folders separately, restarting between them.

## Implemented routes covered

- `GET /health/live`
- `GET /health/ready`
- `POST /api/auth/login`
- `GET /api/auth/session`

## Test limitations and backend notes

- MongoDB-unavailable readiness is only observable if MongoDB disconnects after the API has started; the server does not listen if MongoDB connection fails during startup. The readiness assertion handles either response branch.
- Redis is optional. The readiness assertions validate both disabled and enabled/unavailable cases without assuming a Redis service is present.
- Rate limiting uses the default in-memory store and is therefore per process. Restarting the backend resets its counters; it is not shared across multiple backend instances.
- The global limit test depends on Runner preserving collection variable updates between iterations and completing all 121 requests within its 60-second window. Do not run it in parallel.
- The Phase 1 collection intentionally covers only health and authentication. Use the Phase 2 Account Management collection below for `/api/accounts`.

## Phase 2 — Account Management API

Import `Breaking-News-Monitor-Phase-2-Accounts.postman_collection.json`. It covers the implemented admin-protected account routes: list, retrieve by ID, create, update, enable, and disable. The API does not implement account deletion.

### Environment and credentials

Select a local Postman environment and define:

- `adminUsername`: the local admin username from `backend/.env`.
- `adminPassword`: the local admin password from `backend/.env`; mark this variable **Secret** and do not export or share the environment.

The collection has `baseUrl`, `jwtToken`, and generated test account variables. It contains no real credentials. Run **Admin login — valid credentials** first; a successful login saves `accessToken` to `jwtToken`. Authenticated requests use that token. Clear `jwtToken` after testing. Before account creation, confirm the local backend is configured for the intended local `BreakingNews` database; the collection cannot inspect the backend database target.

### Recommended run order

Run the collection in folder order:

1. **A. Authentication** — login and session checks.
2. **B. List accounts** — checks the public account DTO and unauthenticated rejection.
3. **C. Create accounts** — creates uniquely generated Nitter and Mock accounts, saves their IDs, and immediately pauses each one. The API creates accounts as enabled/active, so run this folder in order; do not run a create request by itself without also running its following pause request.
4. **D. Retrieve account** — includes invalid and nonexistent IDs.
5. **E. Update account** — tests supported edits, rename collision, invalid category, and rejected internal-field changes.
6. **F. Enable and disable monitoring** — tests both state transitions and unauthenticated rejection, then pauses the Nitter account again. The Mock account remains paused.
7. **G. Review / manual cleanup** — read-only confirmation of the two generated account IDs and their paused state.

Requests that require a saved account ID or JWT check the corresponding collection variable and explain the prerequisite if it is missing. The Nitter account uses a random synthetic username; the first successful poll may establish its notification baseline. The collection has no Telegram request and does not intentionally send a notification. However, the API creates the account enabled and active, making it eligible for polling until the next request pauses it. A randomly generated handle is unlikely to correspond to a real X account, but if it does and a new post arrives during that window, the running backend could notify it. Run sequentially against the local backend. Nitter availability is experimental; an upstream feed failure does not change the API's successful account-creation response.

### Cleanup

There is no `DELETE /api/accounts` endpoint, and the collection intentionally does not invent or call one. Both test accounts are left paused. To remove them manually in MongoDB Compass, use the saved `testAccountId` and `testMockAccountId` values to filter the `BreakingNews.monitoredaccounts` collection by exact `_id`, then verify the corresponding generated username and provider before deleting that account document. Do not delete by a broad username-prefix filter. Before deletion, check the `posts` collection for documents whose `monitoredAccount` equals that account ID; deleting an account does not cascade-delete posts, so avoid deletion if related posts need to be retained or reviewed.

### API limitations covered by the collection

- There is no account deletion endpoint.
- The account response intentionally omits `notificationBaselineAt`, post checkpoints, and notification/processing fields. The collection confirms those internal fields cannot be set through create/update/action requests; it cannot inspect the baseline through this API.
- The API returns accounts enabled and active at creation. Nitter baseline establishment depends on a later successful poll, not on the create response.
- Account listing has no pagination or filtering parameters in the current implementation.

## Phase 3 — Posts API

Import `Breaking-News-Monitor-Phase-3-Posts.postman_collection.json`. The repository does not contain an exported Postman environment file; select the same local environment used for Phases 1 and 2. It should define `baseUrl` (if absent, the collection fallback is `http://127.0.0.1:3000`), `adminUsername`, and `adminPassword`. Keep the password in a local, secret environment value and never export it.

Run **Admin login — populate adminToken** first. It follows the earlier login flow and saves the returned `accessToken` to `adminToken`; authenticated requests send `Authorization: Bearer {{adminToken}}`. The collection includes `userToken` for the non-admin-token check. Clear both token values after testing.

Run folders in order. The first authenticated Posts request also captures the first returned post's username, category, and notification status for the filter checks. The valid fallbacks are `phase3test`, `Other`, and `pending`, matching the controller and schemas. Filtering tests do not assume a matching record exists; they assert that any returned rows match the selected filters. The generated empty-result username is syntactically valid and highly unique, but its empty result is conditional on no stored post using that username. The custom pagination request is valid even when the selected page is empty.

The collection checks the actual DTO allowlist and sort order (`publishedAt`, then `createdAt`, then `_id`, descending), plus the implemented pagination and filter response behavior. The validation requests use unsupported/invalid values specifically to verify HTTP 400 responses.

### Authorization behavior note

The requested non-admin check expected HTTP 403, but the current backend's `requireAdmin` middleware returns HTTP 401 for a valid token whose role/subject is not admin. The login API only issues admin tokens, so it cannot mint a valid non-admin token. **GET Posts – Non-Admin Access (actual 401)** is conditional: it is skipped when `userToken` is empty. Supply a correctly signed, unexpired non-admin JWT to exercise the role check; an invalid or expired token will not pass because the test also checks the specific `Invalid authentication token` response. A 403 assertion would fail against the existing implementation and require a backend auth contract change.

The repeated-query validation is based on the installed Express version, 5.3.0. The app's query parser setting is `simple`; repeated `page` values parse as an array, which the posts controller rejects with HTTP 400.

### Test data requirements

- Authentication, pagination, DTO allowlisting, sorting, and all invalid-query tests can run without assuming any post documents exist (the backend itself must be running and its dependencies available).
- Username/category/status filter checks are record-dependent for non-empty matching results; the tests remain valid when the returned array is empty.
- The empty-results assertion is conditional on the generated username not being present in the database.
- The suite is read-only: it does not create or modify accounts/posts and does not call Telegram.
