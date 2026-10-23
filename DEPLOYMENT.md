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
- Cloudinary: required for uploads; configure `CLOUDINARY_CLOUD_NAME`,
  `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the backend environment.

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
   PostgreSQL, Redis and Cloudinary outages.

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

Configure `REDIS_URL` with a Redis TCP URL (`rediss://` for a TLS service).
An HTTP REST Redis endpoint is not compatible with the existing client and
Socket.IO adapter. Confirm the selected service supports Pub/Sub and its command
budget fits presence heartbeats plus three Redis connections per API instance.

Presence uses one 45-second lease per socket, 15-second client heartbeats, a
10-second expiry sweep, and periodic index reconciliation. Redis state is
reconstructed from authenticated sockets after data loss; a full presence keyspace
flush is not required for deployment or recovery. Do not remove another running
instance's presence records on startup. Dead API-instance leases expire while
healthy devices continue renewing independently. Shutdown drains presence cleanup
before closing Redis and PostgreSQL.

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
| Health path    | `/health`                 |

Supply these values in Render's environment settings:

| Variable        | Value                                                 |
| --------------- | ----------------------------------------------------- |
| `DATABASE_URL`  | Supabase session-pooler URL                           |
| `REDIS_URL`     | Redis TCP connection URL                              |
| `CLIENT_ORIGIN` | Exact frontend HTTPS origin, without a trailing slash |

The Blueprint generates separate JWT signing secrets automatically. Keep them
stable between deployments; changing them invalidates existing sessions. Render
provides `PORT`. Never put backend secrets in `VITE_*` variables.

The start script applies pending migrations before starting Node. The migration
runner serializes overlapping runners with an advisory lock. Server startup
checks Postgres and connects Redis before listening. `/health` is a liveness
check, not continuous database/cache readiness monitoring.

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

- `/health` returns 200; `/api/nope` returns JSON 404; anonymous `/api/rooms` returns 401.
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

## Phase 5 privacy and encryption rollout

1. Apply migrations `036_privacy_and_account_security.sql` and
   `037_device_encryption.sql` with `cd backend && npm run migrate` before
   starting the updated API. Existing rooms retain server-readable history.
2. Deploy API instances and client together. Redis adapter and durable sync
   dispatcher must run on each instance for session/device invalidations.
3. Configure the Resend API with `RESEND_API_KEY`, `RESEND_FROM` (a sender
   on a verified domain),
   `APP_PUBLIC_URL`, and stable `MAIL_ENCRYPTION_KEY` (32 random bytes in
   base64url). Use backend `.env.example`; never expose secrets through Vite.
   Mail jobs are encrypted in PostgreSQL and dispatched by the API every five
   seconds. Keep the queue key identical across instances. No extra mail daemon
   is required. Test actual Resend inbox delivery before enabling recovery to users.
4. Serve HTTPS and support Web Locks, IndexedDB, and WebAssembly. Back up the
   database and mail queue key securely; those backups cannot decrypt message
   content without device keys. Users must save their separate recovery keys.
5. Read [PRIVACY_AND_ENCRYPTION.md](docs/PRIVACY_AND_ENCRYPTION.md) before product
   claims. The custom protocol has no forward secrecy/ratchet or independent
   audit; schedule independent security review and real-device testing before
   broad rollout. `group` and `department` remain server-readable collaboration
   even if membership is restricted; explicit `private` rooms and DMs encrypt.

Verification: run `npm test && npm run test:db` from `backend`, then `npm test`,
`npx playwright test --config playwright.security.config.js`, and
`npx playwright test --config playwright.recovery.config.js` from `client`. Browser security tests use a disposable real API/database
and mocked R2 (no actual bucket or email delivery). Live storage/mail and deployed
HTTPS checks remain separate release requirements.
