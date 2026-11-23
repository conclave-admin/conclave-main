# Deploying Conclave

Deployment configuration is committed. Provider provisioning and a public
instance have not been verified from this workspace. See the
[backend backlog](docs/BACKEND_TASKS.md) for product gaps and release priorities.

The configuration is ready for a staging deployment. Before inviting users,
complete live acceptance, privacy policy, backup and restore checks below.
Registration remains open. Public rooms can be discovered and joined by signed-in
users; private room content remains membership-restricted.

## Deployment shape

- Vercel: the static React build from `client/`.
- Render: the persistent Express + Socket.IO process from `backend/`.
- Supabase: PostgreSQL, using a session-pooler connection.
- Redis: a compatible TCP Redis service, configured through `REDIS_URL`.
- R2: primary upload storage; configure the R2 variables in `backend/.env.example`, bucket CORS, multipart lifecycle, and preview Worker bindings. Cloudinary credentials are needed only to support retained legacy files.

This preserves the existing architecture. Render supports persistent WebSocket
connections. Free web services can sleep, so allow for slow initial connections;
choose an always-on plan when the team requires dependable chat availability.
Check current plans before provisioning paid resources.

Sources: [Render WebSockets](https://render.com/docs/websocket),
[Render free services](https://render.com/docs/free),
[Render Blueprint reference](https://render.com/docs/blueprint-spec).

## Before publishing

1. Registration is open to everyone (product decision). Confirm that open
   registration remains appropriate for the first public launch.
2. Confirm provider accounts and connect the GitHub repository
   `conclave-admin/conclave-main`. Push the reviewed local changes before importing
   the Blueprint; a provider cannot deploy changes that exist only on this machine.
3. Run the checks below and a real database/realtime acceptance test. Unit tests
   alone do not prove migrations, SQL queries, or Redis work in production.
4. Replace the marked operator-specific entries in the privacy and terms pages
   (legal entity, contact, provider regions, retention and dispute venue) before
   accepting real users or user-generated content.
5. Perform a backup restore drill against a disposable database and record the
   verified recovery point and recovery time. Configure provider alerts for API,
   PostgreSQL, Redis and object-storage outages.

## Local checks and CI

Use Node 22 (`.nvmrc`), which matches Render, Docker, and the new GitHub workflow.
Run `npm ci` in both `backend/` and `client/`, then:

```sh
cd backend
npm test
cd ../client
npm test
npm run build
```

The GitHub workflow also starts a disposable PostgreSQL 16 instance, runs
migrations twice, and runs `npm run test:db` against disposable databases to
exercise the implemented API queries and permissions.
That workflow has been added but has not been executed remotely in this session.

## Database and Redis

Create a Supabase project and copy its **session pooler** connection string from
the Connect panel. Use the provider's TLS settings and properly encoded password.
Keep this URL only in server-side secrets as `DATABASE_URL`.

Session pooling works with this persistent Node server and the migration runner's
session advisory lock. Transaction pooling _does_ support transactions, but it
must not be used for this runner because session locks require connection affinity.
See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

Before using a new database, point `DATABASE_URL` at a disposable database and run
`npm run migrate` twice from `backend/`. The second run should report that the
database is up to date. Never use `--baseline` unless all recorded migrations
have actually been applied already. Do not delete an existing production database
as a troubleshooting step.

For multi-instance deployments, configure `REDIS_URL` with a Redis TCP URL
(`rediss://` for a TLS service) and set `SOCKET_REDIS_ADAPTER=true`. An HTTP REST
Redis endpoint is not compatible with the node-redis client. Keep the adapter
disabled for one API instance. Redis outages and Upstash quota errors do not
block startup; optional state falls back to local memory.

A single instance keeps presence and typing state locally. When shared Redis
presence is enabled, socket leases last five minutes and refresh no more often
than every four minutes; stale-socket cleanup runs once per minute only while
sockets are connected, with full index reconciliation hourly. Nothing touches
Redis on a timer while no users are connected. See
[Redis operations](docs/redis.md) for the free-tier command-budget guidance.
Shutdown drains presence cleanup before closing Redis and PostgreSQL.

Deploy the presence API and client together. The client expects complete snapshots
with separate connected and foreground-viewing rosters. Missing/outdated snapshots
show “Presence unavailable”. No additional database migration or environment
variables are needed for issues 2.1–2.4 beyond the existing Phase 1 session setup.

## Render API

### Synchronization and background notifications

Run `npm run migrate` before deploying the Phase 3–4 API/client changes. Migrations
034–035 add the committed change journal, message/profile versions, and durable
push subscriptions/jobs. The persistent API process runs both recovery workers;
no separate scheduler is needed. PostgreSQL and Redis must remain available.

Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a real public contact in
`VAPID_SUBJECT` to enable browser push. Keep the key pair stable across instances.
See [synchronization and push setup](docs/SYNC_AND_PUSH.md) for key generation,
privacy policy, subscription lifecycle, and the required live acceptance checks.

Import the root `render.yaml` as a Render Blueprint. It explicitly selects the
free web-service plan and creates only the API service, with these settings:

| Setting        | Value                     |
| -------------- | ------------------------- |
| Root directory | `backend`                 |
| Runtime        | Node 22                   |
| Build          | `npm ci --omit=dev`       |
| Start          | `sh docker-entrypoint.sh` |
| Health path    | `/healthz`                |

Supply these values in Render's environment settings:

| Variable        | Value                                                 |
| --------------- | ----------------------------------------------------- |
| `DATABASE_URL`  | Supabase session-pooler URL                           |
| `REDIS_URL`     | Optional Redis TCP connection URL                     |
| `SOCKET_REDIS_ADAPTER` | `false` for one instance; enable only for 2+ instances |
| `CLIENT_ORIGIN` | Exact frontend HTTPS origin, without a trailing slash |

The Blueprint generates separate JWT signing secrets automatically. Keep them
stable between deployments; changing them invalidates existing sessions. Render
provides `PORT`. Never put backend secrets in `VITE_*` variables.

The start script applies pending migrations before starting Node. The migration
runner serializes overlapping runners with an advisory lock. Server startup
requires PostgreSQL; Redis is optional and its connection failure does not block
the API. `/healthz` is a dependency-free liveness check; `/ready` checks
PostgreSQL and Redis.

See [Redis operations](docs/redis.md) for the single-instance fallback and
Upstash command-budget guidance.

## Vercel client

Import the repository with root directory `client`, framework Vite, build command
`npm run build`, and output directory `dist`. Use Node 22. The included
`client/vercel.json` handles direct links and refreshes on SPA routes.

Set these **build-time** variables, replacing the example hostname:

```dotenv
VITE_API_URL=https://YOUR-API.onrender.com/api
VITE_SOCKET_URL=https://YOUR-API.onrender.com
VITE_DEV_AUTH_BYPASS=false
```

Redeploy the client after changing these values. Set Render's `CLIENT_ORIGIN` to
the final Vercel origin and restart the API. Production builds do not permit the
local auth-preview bypass.

## Acceptance before sharing

- `/healthz` returns 200; `/api/nope` returns JSON 404; anonymous `/api/rooms` returns 401.
- `/ready` returns 200 only when PostgreSQL and Redis both respond; it returns 503 without exposing provider errors otherwise.
- Register/login with the intended access policy; confirm login contains no password hash.
- Create a room and add a second tester using the existing API.
- Open two separate browser sessions and confirm messages appear live in both.
- Refresh a nested room URL and confirm Vercel serves the SPA.
- Reconnect a browser and restart the API; confirm room subscription recovery.
- Exercise access-token expiry and refresh rotation, including a second refresh.
- Verify members can read decisions/digests and nonmembers cannot.
- Confirm backups and record the actual frontend/API URLs and provider projects.
- Trigger an API restart and a Redis reconnect in staging; confirm readiness changes
  and messaging resumes without duplicate messages.

Cloudinary-backed upload round trips still require configured credentials.
Exercise discovery/join, private-room denial, message history, and socket events
with two real accounts before making the service public.

## Albums and resumable media

Apply backend migrations 028 and 029. Review [private media operations](docs/MEDIA_STORAGE.md)
before enabling `R2_DIRECT_UPLOADS_ENABLED=true`. `npm run storage:configure`
prints a merged CORS/lifecycle plan; its `--apply` option writes reviewed bucket
settings. Leave the direct-upload flag false until the real client origins and
exposed ETag header are configured. The API process runs durable cleanup; hosts
that sleep can schedule `npm run media:cleanup` separately.

## Phase 1 session rollout

Apply migration `032_revocable_sessions.sql` with `cd backend && npm run migrate`
before starting the updated API. Deploy all API instances and the client
in a coordinated restart: older servers do not enforce the new session or
cluster revocation protocol. Existing users must sign in again; legacy tokens
have no stable session and are intentionally rejected. New refreshes preserve
session identity, and logout invalidates both REST and realtime access.

The Redis adapter must be connected on every instance. Removal fails with 503
and rolls back if a peer cannot acknowledge eviction. Do not report a successful
removal to users when that check fails. Already downloaded history remains on
devices; revocation prevents future authorized access, not copies already held.

Security checks use disposable databases and require PostgreSQL `CREATEDB` plus
Redis. Run `cd backend && npm test && npm run test:db`. The database suite includes
two Socket.IO servers with a real Redis adapter, multiple devices, join/removal
races, refresh rotation, logout, and idle expiry. For client removal checks run
`cd client && npx playwright test --config=playwright.realtime-access.config.js`.

### Phase 2 receipt rollout

Run `cd backend && npm run migrate` before deploying the updated API and client.
Migration 033 adds immutable message recipients, acknowledgement times and summary
versions, with a transactional trigger for all message creation paths. Existing
messages are marked as having incomplete recipient history; departed recipients
and historical acknowledgement times cannot be reconstructed. No new environment
variables or services are required. Deploy the API and client together so ticks
use send-time summaries and automatic reads use foreground viewport checks.

## Privacy and account-security rollout

1. Back up the database and inspect migration 061 before rollout: it removes
   former E2EE conversations and associated data and queues storage cleanup.
   Run the complete migration chain with `npm run migrate` from the repository
   root only against the intended deployment database. Historical migration 037
   remains part of that chain; it is not a feature to enable independently.
2. Deploy API and client together. Run the Redis adapter and durable sync
   dispatcher on each instance for session invalidation and shared rate limits.
3. Configure `RESEND_API_KEY`, a verified `RESEND_FROM`, `APP_PUBLIC_URL`, and
   stable `MAIL_ENCRYPTION_KEY` as described in `backend/.env.example`. Keep
   secrets on the server. Test real verification and recovery inbox delivery.
4. Apply migrations 062 and 063 before deploying notification preferences.
   Message previews and in-app alerts default on; users can disable them.
   Hidden tabs defer interruptions to browser push. Complete real push acceptance.
5. Serve HTTPS. Messages and attachments are server-readable, not end-to-end
   encrypted. Protect database/storage backups and the mail queue key. See
   [current privacy policy](docs/PRIVACY_AND_ENCRYPTION.md) and record deployment
   evidence in [the release checklist](docs/RELEASE_EVIDENCE.md).

Verification: run `npm test && npm run test:db` from `backend`, then `npm test`,
`npx playwright test --config playwright.security.config.js`, and
`npx playwright test --config playwright.recovery.config.js` from `client`. Browser security tests use a disposable real API/database
and mocked R2 (no actual bucket or email delivery). Live storage/mail and deployed
HTTPS checks remain separate release requirements.
