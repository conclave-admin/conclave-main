# Deploying Conclave

Deployment configuration is committed. Provider provisioning and a public
instance have not been verified from this workspace. See the
[backend backlog](docs/BACKEND_TASKS.md) for product gaps and release priorities.

The configuration is ready for a staging deployment. Before inviting users,
complete the rate-limiting and live acceptance checks below. Registration is
intentionally open; group visibility does not yet provide public discovery/joining.

## Deployment shape

- Vercel: the static React build from `client/`.
- Render: the persistent Express + Socket.IO process from `backend/`.
- Supabase: PostgreSQL, using a session-pooler connection.
- Redis: a compatible TCP Redis service, configured through `REDIS_URL`.
- Cloudinary: optional until uploads are implemented.

This preserves the existing architecture. Render supports persistent WebSocket
connections. Free web services can sleep, so allow for slow initial connections;
choose an always-on plan when the team requires dependable chat availability.
Check current plans before provisioning paid resources.

Sources: [Render WebSockets](https://render.com/docs/websocket),
[Render free services](https://render.com/docs/free),
[Render Blueprint reference](https://render.com/docs/blueprint-spec).

## Before publishing

1. Registration is open to everyone (Victor’s decision). Group invitations and
   public/private group preferences govern collaboration. Existing room APIs
   remain membership-restricted; public discovery/joining is not implemented.
2. Add auth rate limiting. The repository leaves the implementation choice open.
3. Confirm provider accounts and connect the GitHub repository
   `conclave-admin/conclave-main`. Push the reviewed local changes before importing
   the Blueprint; a provider cannot deploy changes that exist only on this machine.
4. Run the checks below and a real database/realtime acceptance test. Unit tests
   alone do not prove migrations, SQL queries, or Redis work in production.
5. Arrange how initial rooms and memberships will be created: the APIs exist, but
   their creation/management UI is unfinished.

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
migrations twice, and tests task permissions and queries through the real API.
Fresh migrations and task integration have passed locally on PostgreSQL 18.4.
That workflow has been added but has not been executed remotely in this session.

## Database and Redis

Create a Supabase project and copy its **session pooler** connection string from
the Connect panel. Use the provider's TLS settings and properly encoded password.
Keep this URL only in server-side secrets as `DATABASE_URL`.

Session pooling works with this persistent Node server and the migration runner's
session advisory lock. Transaction pooling *does* support transactions, but it
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

## Render API

Import the root `render.yaml` as a Render Blueprint. It explicitly selects the
free web-service plan and creates only the API service, with these settings:

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Runtime | Node 22 |
| Build | `npm ci --omit=dev` |
| Start | `sh docker-entrypoint.sh` |
| Health path | `/health` |

Supply these values in Render's environment settings:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session-pooler URL |
| `REDIS_URL` | Redis TCP connection URL |
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
- Register/login with the intended access policy; confirm login contains no password hash.
- Create a room and add a second tester using the existing API.
- Open two separate browser sessions and confirm messages appear live in both.
- Refresh a nested room URL and confirm Vercel serves the SPA.
- Reconnect a browser and restart the API; confirm room subscription recovery.
- Exercise access-token expiry and refresh rotation, including a second refresh.
- Verify members can read decisions/digests and nonmembers cannot.
- Confirm backups and record the actual frontend/API URLs and provider projects.

Task APIs are implemented, but the board UI still needs integration. Notifications
and uploads still return 501. Several frontend screens remain fixtures or empty
placeholders.
