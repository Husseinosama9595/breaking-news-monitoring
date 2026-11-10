# Breaking News Monitor

A free, local-first portfolio project for monitoring selected public X timelines when a usable feed source is available, storing posts durably, and delivering Telegram notifications. It includes a protected Angular administration dashboard, account and post management, polling health, and optional live dashboard notifications. X feeds are experimental: RSSHub's public X route returned 404 during an earlier check, and Nitter instances can change or disappear. The project will not bypass authentication, CAPTCHAs, or access controls.

## Technology and local requirements

The backend uses Node.js ES modules, Express, MongoDB, optional Redis/BullMQ, and single-admin JWT authentication. The Angular frontend uses standalone components, TypeScript, Angular Router, Bootstrap, and SCSS. Feed polling supports `MockNewsProvider` for development and the experimental `NitterProvider` for public X timelines when selected. MongoDB stores retrieved posts and pending processing state; Redis is optional for polling and required for BullMQ processing.

### Requirements

- Node.js 20 or newer
- MongoDB Community Server running locally (required by the API)
- Optional: Redis running locally (the API remains available when Redis is stopped; leave `REDIS_URL` empty to disable it)

No hosted services or paid APIs are needed for local development. Hosted free tiers may impose limits and can incur charges if upgraded or exceeded; this repository does not configure them.

### Install local services on Windows

#### MongoDB Community Server

Download MongoDB Community Server from the [official Windows installation guide](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-windows/). In the installer, select **Install MongoD as a Service**. The default local connection is `mongodb://127.0.0.1:27017/BreakingNews`; MongoDB creates the database when the app first writes data.

After installation, open PowerShell and verify/start the service:

```powershell
Get-Service MongoDB
Start-Service MongoDB # Run PowerShell as Administrator only if Windows requires it.
Test-NetConnection 127.0.0.1 -Port 27017
```

The final command should report `TcpTestSucceeded : True`.

## Explicit Telegram pipeline smoke test (Phase 2, Step 6)

This optional manual test sends **one real Telegram message** only after you explicitly pass `--send-real-telegram`. It does not use X, RSSHub, or Nitter. It publishes one uniquely named post through a `MockNewsProvider` with no built-in Reuters/NASA fixtures, polls that single account, persists it, dispatches it through a uniquely named BullMQ queue, and waits for MongoDB to report `processingStatus: processed` and `notificationStatus: sent`.

The script always selects the separate local Mongo database `BreakingNewsE2E` and refuses `NODE_ENV=production`. It scopes dispatch and processing to the newly created post, so it cannot send older pending records. The database is retained after the run for inspection. Only the invocation's uniquely named BullMQ queue is removed. Telegram credentials are read from `backend/.env`, validated without displaying them, and never included in script output. A send accepted by Telegram followed by a process/DB failure before the success update can still result in a duplicate if manually retried; Telegram delivery cannot be made exactly once with this architecture.

### Prepare and run

1. In `backend/.env`, configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for a test channel. Add the bot to the channel with permission to post. Keep these values private.
2. Ensure local MongoDB and Redis are running and `MONGODB_URI` / `REDIS_URL` refer to those local services. The test refuses to run without Redis or Telegram settings.
3. Stop the normal backend process and any other local worker while running this test. Normal startup behavior is unchanged; stopping it prevents unrelated development activity from being confused with the explicit smoke test.
4. From the repository root in PowerShell, execute:

```powershell
Set-Location .\backend
npm run e2e:telegram -- --send-real-telegram
```

Without the explicit flag, the script exits before opening database or queue connections. The successful output includes the MongoDB test post ID and the two final states; it does not print credentials.

### Inspect the retained MongoDB result

In `mongosh`, select the dedicated database and query the post ID printed by the script:

```javascript
use BreakingNewsE2E
db.posts.findOne(
  { _id: ObjectId("PASTE_THE_PRINTED_TEST_POST_ID") },
  { username: 1, text: 1, providerPostId: 1, processingStatus: 1,
    processedAt: 1, notificationStatus: 1, telegramSent: 1,
    telegramSentAt: 1, telegramMessageId: 1 }
)
```

The expected final values are `processingStatus: "processed"`, `notificationStatus: "sent"`, and `telegramSent: true`. The post text includes a unique `[MOCK E2E TEST ...]` marker. This smoke test intentionally leaves the account and post in `BreakingNewsE2E` so you can inspect them. Do not point `MONGODB_URI` at a hosted database for this local-only project.

### Automated integration test

The backend suite contains both mocked unit tests and integration tests. Some integration tests connect to the host in `MONGODB_URI`, drop their uniquely named test databases, and may connect to Redis and obliterate only a test-specific queue. Do not run the full suite unless you have first verified that `MONGODB_URI` and `REDIS_URL` point to disposable local test services. Tests do not use configured Telegram credentials; Telegram clients are mocked. See the Phase 6 test-safety notes below.

#### Optional Redis with Docker Desktop

Redis's official Windows guidance uses Docker. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) and use its WSL 2 backend. Docker Desktop is free for personal use; check its current license terms if your use changes. No cloud account or hosted Redis is needed for this local project.

In PowerShell, confirm Docker is running, then start a local Redis container:

```powershell
docker version
docker run -d --name breaking-news-redis -p 6379:6379 --restart unless-stopped redis:7-alpine
docker exec -it breaking-news-redis redis-cli ping
```

The last command should print `PONG`. This queue Redis instance does not need persistence for Phase 1: MongoDB is intended to be the durable source of pending work. If you do not want to install Docker, Redis is optional; set `REDIS_URL=` and run the API without BullMQ.

#### Configure and run the backend

From the project root in PowerShell (this preserves an existing local `.env`):

```powershell
if (-not (Test-Path .\backend\.env)) { Copy-Item .\backend\.env.example .\backend\.env }
notepad .\backend\.env
```

Keep `.env` local; `.gitignore` excludes it. Do not paste the file or its values into chat, screenshots, or commits. Set a unique `ADMIN_PASSWORD` with at least 12 characters and replace `JWT_SECRET` with a random value of at least 32 characters. Generate a JWT secret in PowerShell (this prints the generated secret locally; paste it into `.env` and do not share it):

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Use these local values unless you changed the service ports:

```text
MONGODB_URI=mongodb://127.0.0.1:27017/BreakingNews
REDIS_URL=redis://127.0.0.1:6379
```

Set `REDIS_URL=` to disable Redis. The checked-in `.env.example` contains placeholders only and is not copied automatically. In development, values in `.env` override inherited shell values so stale machine-level variables do not silently replace the local configuration. In production, explicitly supplied process environment variables take precedence.

Polling configuration:

```text
FEED_POLL_INTERVAL_MS=45000
FEED_POLL_TIMEOUT_MS=10000
FEED_POLL_CONCURRENCY=3
FEED_POLL_JITTER_MS=1000
FEED_FRESHNESS_MAX_AGE_MS=21600000
```

The interval must be between 1 second and 1 hour; request timeout must be between 100 milliseconds and 2 minutes. Polling concurrency defaults to 3 accounts (configurable from 1 to 50), and each account receives a random start delay from 0 through `FEED_POLL_JITTER_MS` (default 1000 ms). Jitter spreads requests inside a poll cycle; the bounded worker pool still attempts every eligible account, and overlapping cycles share the active cycle instead of starting another. The freshness age threshold defaults to 6 hours and can be set from 1 second to 7 days. It is an operational heuristic for classifying the newest valid post timestamp observed in a successful feed, not a guarantee about Nitter retention or an account's expected posting cadence. Empty feeds are reported as `empty`; nonempty feeds with no valid publication timestamp, or with a future timestamp, are `unknown`; otherwise the newest timestamp is classified `fresh` or `stale` relative to the threshold. A provider request can succeed even when its feed is stale.

The protected `GET /api/accounts` and `GET /api/accounts/:id` responses include additive `pollHealth` data: the last poll start/completion and duration, outcome/error code, returned/inserted/duplicate counts, plus the latest observed feed timestamp counts and freshness classification. `lastSuccessfulFetchAt` remains the time of the latest successfully ingested provider batch; it is distinct from the newest post's `publishedAt`. Failed provider requests do not erase the last successfully observed feed freshness. The API does not expose `lastError` text or credentials. Polling begins after MongoDB connects, processes active enabled X accounts stored in MongoDB, and stops before the database connection closes.

Nitter's available RSS history depth and retention period are not established by this application and may vary by instance. These freshness fields only describe timestamps present in the feed response; they cannot prove that every intervening post was returned or recover items that have already left the upstream feed.

Post processing and MongoDB recovery configuration:

```text
POST_JOB_MAX_ATTEMPTS=5
POST_JOB_BACKOFF_MS=1000
POST_RECOVERY_INTERVAL_MS=5000
POST_STALE_AFTER_MS=120000
POST_RECOVERY_BATCH_SIZE=100
POST_WORKER_CONCURRENCY=5
QUEUE_RUNTIME_CHECK_INTERVAL_MS=5000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_REQUEST_TIMEOUT_MS=10000
TELEGRAM_MIN_INTERVAL_MS=1100
TELEGRAM_MAX_ATTEMPTS=5
TELEGRAM_BACKOFF_MS=2000
```

The dispatcher and worker only start when Redis is ready. MongoDB is the authoritative inbox and status ledger; BullMQ contains reconstructible execution jobs. The dispatcher rebuilds deterministic jobs from MongoDB and resets stale `processing` or `sending` records after the configured threshold. Redis outages leave MongoDB work pending for later recovery. Failed BullMQ jobs are retained for up to 7 days, with a 1000-job cap, and the recovery dispatcher periodically cleans only expired `failed` jobs. MongoDB notification/error records are not removed by this cleanup. Telegram remains disabled unless both Telegram credentials are configured. With Telegram disabled, posts can be processed while notifications remain pending. The Telegram token is used only in backend requests and is never logged or returned by the API.

For Telegram-enabled delivery, a Redis-backed per-chat gate coordinates concurrent workers, spaces messages by `TELEGRAM_MIN_INTERVAL_MS` (default 1100 ms), and pauses that chat for Telegram's `retry_after` duration after a 429. The retry delay is also persisted on the post in MongoDB, so ordinary recovery remains durable. If Redis is not configured, the notification service uses a process-local gate; the application does not start BullMQ workers without Redis.

Post processing and delivery are separate states: a post can be `processed` while its notification is still `pending`; it becomes `sent` only after Telegram confirms acceptance and MongoDB records that result. Telegram acceptance and the MongoDB success write cannot be atomic. If the process crashes between them, stale-notification recovery may send the message again, so delivery is at least once and can produce a duplicate in that failure window.

### Telegram channel setup and optional smoke test

1. Create a bot with Telegram's [@BotFather](https://t.me/BotFather) and copy its token directly into `backend\.env` as `TELEGRAM_BOT_TOKEN`. Do not paste it into chat or source files.
2. Create a channel and add the bot as an administrator with permission to publish messages.
3. Set `TELEGRAM_CHAT_ID` in `backend\.env` to the channel's public `@username` or numeric chat ID. Telegram's official [`sendMessage` method](https://core.telegram.org/bots/api#sendmessage) accepts a numeric chat ID or a public channel username.
4. Restart the backend after changing `.env`.

Optional: send one clearly marked mock message to verify the configured bot and channel. Run this from `backend`; it prints only the returned message ID, not the token:

```powershell
node --input-type=module -e "import { telegramNotificationService } from './src/services/telegramNotificationService.js'; const result = await telegramNotificationService.sendNotification({ username: 'LocalSmokeTest', text: '[MOCK] Breaking News Monitor Telegram smoke test.', category: 'Other', priority: 'NORMAL', receivedAt: new Date(), postUrl: null }); console.log(JSON.stringify({ accepted: true, messageId: result.messageId }));"
```

If an admin password or JWT secret is accidentally shared, change both values in `.env` before using the service again. Never paste the contents of `.env` into chat or commit it.

Install and start the backend:

```powershell
Set-Location .\backend
npm install
npm run dev
```

MongoDB must be running before startup. If Redis is configured but unavailable, the API still starts without queue features; `/health/ready` reports `degraded` with HTTP 200 as long as MongoDB is connected. The queue runtime waits for Redis and starts the worker/dispatcher after it reconnects. When Redis is disabled, it is reported as optional and not ready. Telegram can remain unconfigured without affecting backend startup. MongoDB connection failure prevents startup.

**Test safety:** the complete `npm test` suite is not an offline-only unit suite. Several integration tests connect to the MongoDB server specified by `MONGODB_URI`, drop explicitly named test databases, and some Redis tests obliterate a test-specific BullMQ queue. Do not run the full suite unless both configured services are confirmed to be disposable local test instances and you have inspected the test targets. The Telegram client is mocked in automated tests; the live E2E Telegram script is separate and requires `--send-real-telegram`.

To stop the backend, press `Ctrl+C` in its terminal. The shutdown handler stops scheduling polls and recovery dispatches, waits for active polling and worker jobs, then closes the HTTP server and database/queue connections.

### Verify locally

With the backend running, query liveness and readiness:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready | ConvertTo-Json -Depth 5
```

When MongoDB is connected and Redis is disabled, readiness should be `ready` (HTTP 200). When MongoDB is connected and Redis is configured but unavailable, readiness should be `degraded` (HTTP 200); Redis is optional. If MongoDB is unavailable, readiness is `not_ready` (HTTP 503), and the application will not start.

To verify login without putting the password in a command or PowerShell history, prompt for it securely:

```powershell
$adminUser = Read-Host 'Admin username'
$secureAdminPassword = Read-Host 'Admin password' -AsSecureString
$adminPasswordText = [System.Net.NetworkCredential]::new('', $secureAdminPassword).Password
$payload = @{ username = $adminUser; password = $adminPasswordText } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/auth/login' -ContentType 'application/json' -Body $payload
$token = $login.accessToken
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/auth/session' -Headers @{ Authorization = "Bearer $token" }
$adminPasswordText = $null
$token = $null
```

Successful login and session verification return HTTP 200. Calling `/api/auth/session` without a bearer token should return HTTP 401. To verify Redis, run `docker exec -it breaking-news-redis redis-cli ping` (expected output: `PONG`), then inspect `/health/ready`. To check graceful shutdown, press `Ctrl+C` in the backend terminal and confirm it logs `Received SIGINT; shutting down.`

### Endpoints

- `GET /health/live` — process liveness.
- `GET /health/ready` — MongoDB readiness and optional Redis status (`ready`, `degraded`, or `not_ready`).
- `POST /api/auth/login` — accepts `{ "username": "...", "password": "..." }` and returns an eight-hour bearer token.
- `GET /api/auth/session` — verifies the bearer token.
- `GET /api/accounts` and `GET /api/accounts/:id` — list and retrieve monitored accounts, including additive polling-health data.
- `POST /api/accounts` — create an account. `PATCH /api/accounts/:id` updates supported account fields; `PATCH /api/accounts/:id/enable` and `/disable` toggle monitoring.
- `GET /api/posts?page=1&limit=20` — list posts ordered by publication time descending, then creation time and ID descending, with pagination. Optional filters are `username`, `category`, and `notificationStatus`.
- `GET /api/notifications?page=1&limit=20&since=<ISO timestamp>` — authenticated persistent notification history, newest first, including unread count and pagination. `since` is inclusive so reconnect recovery can overlap and deduplicate safely.
- `GET /api/notifications/unread-count` — authenticated unread total.
- `PATCH /api/notifications/:id/read` and `PATCH /api/notifications/read-all` — persist read status.
- `GET /api/events/stream` — authenticated server-sent event stream for newly ingested eligible posts.

Management routes must use the `requireAdmin` middleware. CORS allows the configured `FRONTEND_URL` and exact origins listed in `EXTRA_CORS_ORIGINS`.

## Angular administration dashboard

The frontend is a standalone Angular application under `frontend/`. It uses the protected backend API for login, account data, and posts; it does not contain credentials or mock backend records. From the repository root, install and run it in a second PowerShell window:

```powershell
Set-Location .\frontend
npm install
npm start
```

Open `http://localhost:4200`. The development API origin is configured in `frontend/src/environments/environment.ts` as `http://localhost:3000`. Production builds do not fall back to localhost: they load the public `/runtime-config.json` asset before bootstrapping. Set its `apiBaseUrl` to the backend HTTPS origin, or leave it blank and route same-origin `/api` requests to the backend with the hosting platform's reverse proxy. This URL is public configuration, never a secret. The checked-in file is blank by default.

The dashboard and Accounts page show live account data, and the Posts page uses the paginated posts API. Poll health is separate from the enabled/monitoring status: a feed may be stale while monitoring is enabled; an empty feed is not itself a provider error; `unknown` means freshness could not be established from valid timestamps. Notification History is backed by MongoDB; read/unread state survives refreshes. Settings and sound/browser preferences remain local to the browser.

Desktop browser notifications require the user to grant browser permission; sound starts disabled and browsers require a user gesture before audio can play. Sound preferences are stored in that browser's local storage. Toasts, sound, and desktop alerts require an open dashboard; SSE has no replay buffer and is process-local, while persisted notification history can be recovered from the API after reconnect.

Open the bell menu and expand **Notification preferences** to enable sound, choose Email-style, Classic chime, Modern digital, or Soft double-tone, set volume from 0–100%, and preview the selected sound. Desktop notifications are a separate toggle and are created silently so they do not add a second sound. Permission is requested only when desktop notifications are enabled. Browser support and user/site settings can still block either feature.

## Architecture and data flow

The Angular client authenticates with the Express API and sends the JWT in the `Authorization: Bearer` header. Protected account and post routes return validated DTOs; the browser never receives backend credentials. Account polling runs on the backend at the configured interval and uses the per-account provider selection or the global provider override. Provider results are normalized, persisted/deduplicated in MongoDB, and only then become eligible processing work. MongoDB records the durable pending/processing/delivery states and account checkpoints.

When Redis is ready, BullMQ workers process those MongoDB-backed records and the recovery dispatcher reconstructs eligible jobs after interruptions. The worker sends eligible notifications through Telegram and updates MongoDB only after Telegram accepts the request; Redis queue state is not the durable source of truth. A dashboard notification record is embedded atomically in the eligible newly inserted Post document, before the process-local SSE event is published. The authenticated Angular stream hydrates persistent history and unread state through REST, buffers SSE events during that request, then deduplicates by notification ID. Reconnect recovery fetches records since the prior SSE connection timestamp. Restored records do not replay sound, desktop alerts, or toasts.

Older posts are not backfilled into notification history when this feature is deployed. Only eligible posts inserted after deployment receive embedded notification metadata; initial Nitter baseline posts remain suppressed. Existing post documents and Telegram delivery records are not rewritten.

## Environment configuration reference

Backend settings are validated in `backend/src/config/environment.js`. Copy `.env.example` to the ignored `backend/.env` and keep actual values private. Defaults shown below apply when an optional setting is omitted.

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`; use `test` or `production` where appropriate. |
| `PORT` | No | `3000`. |
| `FRONTEND_URL` | No | `http://localhost:4200`; allowed CORS origin. |
| `EXTRA_CORS_ORIGINS` | No | Empty; comma-separated exact additional origins. |
| `MONGODB_URI` | Yes | MongoDB connection string; local development example is documented above. |
| `REDIS_URL` | No | Empty disables Redis/BullMQ; otherwise local Redis connection. |
| `FEED_POLL_INTERVAL_MS` | No | `45000` (45 seconds). |
| `FEED_POLL_TIMEOUT_MS` | No | `10000` overall provider request timeout. |
| `FEED_POLL_CONCURRENCY` | No | `3` monitored accounts at a time. |
| `FEED_POLL_JITTER_MS` | No | `1000` maximum randomized account start delay. |
| `FEED_FRESHNESS_MAX_AGE_MS` | No | `21600000` (6 hours), heuristic only. |
| `FEED_PROVIDER` | No | `account`; may be `account`, `mock`, or `nitter`. |
| `NITTER_INSTANCES` | No | `https://xitter.cf,https://nitter.gq`; experimental RSS instances. |
| `NITTER_INSTANCE_TIMEOUT_MS` | No | `4000` per-instance timeout. |
| `NITTER_INSTANCE_COOLDOWN_MS` | No | `60000` cooldown after an instance failure. |
| `POST_JOB_MAX_ATTEMPTS` | No | `5` processing attempts. |
| `POST_JOB_BACKOFF_MS` | No | `1000` base processing retry delay. |
| `POST_RECOVERY_INTERVAL_MS` | No | `5000` MongoDB recovery scan interval when Redis is available. |
| `POST_STALE_AFTER_MS` | No | `120000` before stale work is eligible for recovery. |
| `POST_RECOVERY_BATCH_SIZE` | No | `100` records per recovery batch. |
| `POST_WORKER_CONCURRENCY` | No | `5` worker jobs. |
| `QUEUE_RUNTIME_CHECK_INTERVAL_MS` | No | `5000` Redis/worker readiness check interval. |
| `TELEGRAM_BOT_TOKEN` | No | Empty disables Telegram delivery. Keep secret. |
| `TELEGRAM_CHAT_ID` | No | Empty disables Telegram delivery. Keep private. |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | No | `10000`. |
| `TELEGRAM_MIN_INTERVAL_MS` | No | `1100` per-chat minimum spacing. |
| `TELEGRAM_MAX_ATTEMPTS` | No | `5`. |
| `TELEGRAM_BACKOFF_MS` | No | `2000` base delay for retryable errors. |
| `JWT_SECRET` | Yes | At least 32 characters; generate a unique random value. |
| `ADMIN_USERNAME` | Yes | Single administrator login name. |
| `ADMIN_PASSWORD` | Yes | 12–256 characters; use a unique password. |

Frontend `apiBaseUrl` is a TypeScript environment setting, not a backend `.env` variable. Never put Telegram or admin credentials in frontend environment files.

## Build and test commands

Frontend unit tests use Vitest and mock HTTP/service dependencies. Run them and make a production build from `frontend/`:

```powershell
npm test -- --watch=false
npm run build
```

Backend tests use Node's built-in test runner. The complete suite contains database/Redis integration tests with destructive cleanup scoped to test database and queue names, so first inspect `backend/test/` and confirm the target services are disposable. If you need to avoid service connections, run only the reviewed mock-based unit tests; do not treat the complete `npm test` command as safe offline verification. Neither automated suite is intended to send real Telegram messages.

## Troubleshooting

- **Backend will not start:** check that local MongoDB is running and that `MONGODB_URI` uses the intended local database. Environment validation reports variable names and validation reasons, not secret values.
- **Readiness is degraded:** MongoDB may be ready while optional Redis is unavailable. Check the local Redis service and `REDIS_URL`; queue workers and dispatching wait for Redis.
- **Login or protected API returns 401:** confirm the frontend uses the same backend origin, login credentials are correct, and the session has not expired. The JWT is stored in `sessionStorage` and is cleared when invalidated or the tab session ends.
- **Accounts show polling errors or stale/unknown freshness:** inspect poll-health fields and provider error codes in the Accounts page. Nitter availability and feed timestamps are outside this application's control; a successful HTTP request does not guarantee freshness.
- **Posts do not reach Telegram:** check that both Telegram settings are present, Redis is ready, the bot can post to the configured channel, and the post's notification status. Telegram 429 responses pause the chat according to `retry_after`; retries remain subject to Telegram acceptance and application recovery.
- **SSE/desktop notification not visible:** keep the dashboard open and authenticated, check browser network access to `/api/events/stream`, grant desktop permission if desired, and enable audio only after interacting with the page. Browser/local notification state does not replay missed events after refresh.
- **Production frontend calls the wrong API:** inspect the deployed `/runtime-config.json`; set its public `apiBaseUrl` to the HTTPS backend origin or configure same-origin `/api` rewrites. The production build never uses the development localhost URL.

## Project structure

- `backend/src/config/environment.js` validates settings before the server starts.
- `backend/src/config/database.js` owns the Mongoose connection lifecycle.
- `backend/src/config/redis.js` manages the optional local Redis connection.
- `backend/src/queues/notificationQueue.js` creates an optional BullMQ queue.
- `backend/src/providers/providerRegistry.js` registers the MockNewsProvider and NitterProvider implementations.
- `backend/src/services/feedPollingService.js` polls enabled monitored accounts and persists batches.
- `backend/src/services/postIngestionService.js` stores posts idempotently before advancing account checkpoints.
- `backend/src/services/mongoRecoveryDispatcher.js` rebuilds eligible BullMQ jobs from MongoDB.
- `backend/src/services/processingRuntime.js` starts queue components after Redis becomes ready and stops them gracefully.
- `backend/src/queues/postProcessingWorker.js` applies bounded retries and records processing state in MongoDB.
- `backend/src/services/telegramNotificationService.js` formats messages and calls the official Telegram Bot API using backend-only configuration.
- `backend/src/models/` defines monitored accounts and durable post work states.
- `backend/src/middleware/auth.js` implements admin credential verification and JWT protection.
- `backend/src/routes/` contains authentication, health, accounts, posts, and SSE endpoints.
- `backend/src/app.js` configures Express, CORS, security headers, JSON limits, and rate limits.
- `backend/server.js` connects services and handles graceful shutdown.

## Dashboard live notifications

An eligible newly inserted post receives `dashboardNotification.createdAt` and `dashboardNotification.readAt` in the same MongoDB document upsert. Its post `_id` is the stable notification ID; the existing unique post dedupe index therefore also enforces at most one notification per post. Baseline history and duplicate upserts do not receive notification metadata. This design requires no transaction and does not retroactively create notifications for legacy posts.

The protected `GET /api/events/stream` endpoint streams the persisted notification ID and post fields to connected clients; it uses the same admin Bearer JWT as the REST API. MongoDB persistence happens before SSE publication. The service buffers events during REST hydration, restores older records silently, and reconciles missed records on reconnect with an inclusive timestamp query. Duplicate REST/SSE representations are merged by notification ID. A failed SSE publish does not remove the MongoDB record.

`GET /api/notifications` supports `page` (default 1), `limit` (default 20, maximum 100), and optional ISO `since` timestamp. It returns page metadata and the global unread count. `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id/read`, and `PATCH /api/notifications/read-all` are protected by `requireAdmin`. Read changes are persisted on the same Post document. Angular uses optimistic changes but rolls them back and displays an error if the API update fails. History can load older pages; this is persistent notification history, while the toast stack and currently rendered browser state remain in memory.

SSE is still process-local and has no replay buffer or cross-process event broker. REST/MongoDB recovery covers refreshes and reconnects, but visible toasts, audio, and desktop notices cannot run while the browser is closed. Publication may be repeated over the network; client ID deduplication prevents duplicate entries/effects within the active browser state, but exactly-once event delivery is not claimed.

## Known feed limitations

`MockNewsProvider` remains available for deterministic development and tests. `NitterProvider` is an experimental public RSS source; its instances are independently operated and can disappear, throttle, return stale feeds, or change their XML. At implementation time, public checks returned RSS from `xitter.cf` and `nitter.gq`; that observation is not a continuing availability guarantee. X's terms currently restrict automated scraping without prior written consent, so the user is responsible for deciding whether their use is authorized. This project does not bypass X authentication, CAPTCHAs, or access controls.

Polling delay is at least the configured `FEED_POLL_INTERVAL_MS` plus upstream feed refresh and response delays. An unavailable instance is skipped for `NITTER_INSTANCE_COOLDOWN_MS`; after that period it is tried again first in configured order, allowing recovery. Each fallback attempt can add up to `NITTER_INSTANCE_TIMEOUT_MS`, subject to the overall `FEED_POLL_TIMEOUT_MS` deadline. A feed exposes only its recent entries, so enough posts during an outage or a long downtime can still cause misses. MongoDB reconciliation cannot recover posts that are no longer present in any upstream feed. No real-time or complete-delivery guarantee is made.

## Deployment readiness (not deployed)

The backend is designed to run as one continuously running Node.js process. It reads `PORT`, MongoDB/Redis URIs, JWT/admin values, Telegram credentials, provider settings, and CORS origins from validated environment variables. It listens on the configured port without binding to loopback only, starts feed polling after MongoDB connects, starts queue processing when Redis is available, and handles SIGINT/SIGTERM by stopping polling/workers and closing active SSE responses and service connections. Use a persistent web-service process; a short-lived serverless request runtime is unsuitable for this in-process polling/worker lifecycle.

Run exactly one backend instance for this version. Each process has its own poll-cycle locks, Nitter cooldowns, and SSE subscribers; multiple replicas could poll the same accounts and deliver duplicate live events. BullMQ queue names are database-scoped, but that does not coordinate feed polling across processes. No distributed lock or multi-instance fan-out is implemented.

### MongoDB Atlas

Set `MONGODB_URI` to an Atlas SRV connection string such as `mongodb+srv://<database-user>:<password>@<cluster-host>/<database-name>?retryWrites=true&w=majority`; URL-encode special characters in the username/password. Create a dedicated database user with read/write access only to the application database. Configure Atlas network access to allow the backend host's egress addresses; avoid a broad `0.0.0.0/0` rule for production unless the hosting network requires it and compensating controls are in place. This project does not connect to Atlas or configure backups. Before real use, enable the backup/snapshot capability available to your selected Atlas plan or schedule encrypted, access-controlled `mongodump` backups and test restoration. New indexes are declared in the Mongoose Post model; verify index creation on the deployment database before full polling.

### Redis-compatible service

Set `REDIS_URL` to a BullMQ-compatible Redis endpoint. Use the provider's TLS URL (`rediss://...`) when TLS is required, and keep credentials in the hosting secret store. The current ioredis configuration parses Redis URLs and sets the BullMQ-required `maxRetriesPerRequest: null`; the chosen provider must allow persistent connections and BullMQ blocking operations. MongoDB remains the durable work ledger if Redis disconnects. No hosted Redis service is configured or contacted by this project.

### Angular static hosting and CORS

Build the Angular app by running `npm run build` from `frontend/`. The production bootstrap fetches `/runtime-config.json` before loading the Angular application. Serve a deployment-specific public JSON asset such as `{"apiBaseUrl":"https://<your-backend-host>"}` at that path, or leave it blank and configure a same-origin `/api` proxy/rewrite. The file contains only a public API origin; never put secrets in it. The checked-in placeholder is blank, and the production build does not use `localhost:3000`.

Set backend `FRONTEND_URL` to the exact production frontend origin, e.g. `https://<your-project>.vercel.app`, and list any additional approved preview origins as comma-separated exact origins in `EXTRA_CORS_ORIGINS`. Do not use wildcard CORS. The API uses bearer authorization headers, not credentialed cookies. Confirm the production frontend origin and backend HTTPS certificate before enabling real accounts or Telegram delivery.

### Deployment security checklist

- Use unique production `JWT_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` values in the platform's secret manager; never set them in Angular runtime configuration.
- Keep Telegram bot credentials and database/Redis passwords server-side only. Restrict access to logs and rotate credentials if exposed.
- Terminate HTTPS at the hosting edge for both app and API. The backend sends generic API errors, applies Helmet, JSON body limits, exact-origin CORS, a global rate limit, and a stricter login limit.
- The admin JWT is stored in browser `sessionStorage`; same-origin XSS could steal it. Keep dependencies patched and review Content Security Policy and token storage before exposing the app publicly. The token expires after eight hours; there is no server-side revocation endpoint.
- Keep a single backend instance until distributed polling coordination and cross-instance SSE delivery are implemented. Monitor readiness and process logs without logging secrets.
- Test MongoDB backups/restoration and Redis reconnect behavior in a separate disposable staging environment. No production host, Atlas cluster, Redis service, or Vercel project has been provisioned or tested here.

## Nitter provider configuration

The existing provider contract and normalized post format are unchanged. `NitterProvider` is registered beside `MockNewsProvider`; mock remains the default for accounts whose `providerName` is `mock`. Existing account documents require no provider migration: choose a global provider in `backend/.env`, or leave `FEED_PROVIDER=account` and set an individual account's `providerName` to `nitter`.

```dotenv
FEED_PROVIDER=account
NITTER_INSTANCES=https://xitter.cf,https://nitter.gq
NITTER_INSTANCE_TIMEOUT_MS=4000
NITTER_INSTANCE_COOLDOWN_MS=60000
FEED_POLL_INTERVAL_MS=45000
FEED_POLL_TIMEOUT_MS=10000
```

`FEED_PROVIDER=account` respects each account's stored provider. `FEED_PROVIDER=mock` or `FEED_PROVIDER=nitter` forces that provider for all monitored X accounts; a successful poll updates the account's `providerName` to the provider used. To switch one account while using account mode, update its record in the existing local database, for example in `mongosh`:

```javascript
use BreakingNews
db.monitoredaccounts.updateOne(
  { platform: "x", normalizedUsername: "reuters" },
  { $set: { providerName: "nitter" } }
)
```

On the first successful Nitter poll for an account, the newest returned publication timestamp becomes its notification baseline. Returned history is stored in MongoDB as `processed` with `notificationStatus: skipped`; any earlier unsent records for that account are also marked skipped. Only later Nitter posts with a publication timestamp newer than the baseline become notification work. Untimestamped Nitter posts are stored but skipped because their age cannot be established safely. Queued or retried jobs re-check MongoDB status and cannot send a skipped post. `MockNewsProvider` behavior is unchanged.

The Nitter provider tries configured instances in order. A failing instance enters an in-memory cooldown while other instances are tried. Its health counters reset when the process restarts. Post IDs from X status links become canonical IDs, so the existing MongoDB dedupe index prevents repeated notifications when the same post appears through another Nitter instance.

## Manually check Nitter feeds

The smoke script performs read-only HTTP requests for one public account, prints each configured instance's status, elapsed time and entry count, then shows up to three post IDs, timestamps and original links. It does not connect to MongoDB or Telegram. It makes real requests only when you run it:

```powershell
Set-Location .\backend
npm run smoke:nitter -- Reuters
```

Replace `Reuters` with a public X username. Configure the instance list in `backend/.env` first if you want to test other deployments. Automated tests use mocked fetch responses and never call live Nitter instances or Telegram.
