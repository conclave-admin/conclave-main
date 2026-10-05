# Deploying Conclave

Deployment configuration is committed. Provider provisioning and a public
instance have not been verified from this workspace. See the
[backend backlog](docs/BACKEND_TASKS.md) for product gaps and release priorities.

The configuration is ready for a staging deployment. Before inviting users,
complete the access-policy, rate-limiting and live acceptance checks below.

## Deployment shape

- Vercel: the static React build from `client/`.
- Render: the persistent Express + Socket.IO process from `backend/`.
- Supabase: PostgreSQL, using a session-pooler connection.
- Redis: a compatible TCP Redis service, configured through `REDIS_URL`.
- Cloudinary: optional until uploads are implemented.

```
  Browser
     │
     ├── HTTPS ──> Vercel  ─────> React SPA (static, Vite build)
     │                            client/dist/
     │
     ├── HTTPS ──> Render  ─────> Express + Socket.IO   (long-running Node)
     │                            ├─> Supabase Postgres  (durable data)
     │                            └─> Redis              (presence, typing, TTLs)
```

**Vercel is right for the client and wrong for the backend.** This is worth being
precise about, because Vercel _does_ now support WebSockets (public beta since
June 2026) and a lot of older advice says otherwise. The problem is the Hobby
tier's limits, not the absence of support:

- **Connection lifetime is capped at 300 seconds on Hobby.** Every socket is
  severed at five minutes and has to reconnect. For an app whose whole real-time
  surface is one long-lived connection, that is a constant churn of reconnects.
- WebSockets require Fluid compute, and each connection consumes a Function
  instance.
- There is no connection affinity — a reconnect can land on a different instance,
  so all state must already be external. (Yours is: Redis. That part is fine.)

Putting `src/server.js` on Vercel would also mean restructuring it: it is a
single long-running process that opens a real HTTP server, attaches Socket.IO,
and dups two Redis connections for the pub/sub adapter. None of that is the shape
Vercel Functions expect, and doing it the day before a launch is the definition of
introducing risk.

**Supabase is right for Postgres and has no Redis.** Supabase's only Redis
offering is `redis_wrapper`, a Postgres foreign-data wrapper for querying an
_external_ Redis from SQL. It is not a Redis you can point `REDIS_URL` at. So
Redis has to come from somewhere else — section 5.

### Free tier comparison for the backend

| Platform   | Card? | Sleeps?             | WebSockets | Verdict for Conclave             |
| ---------- | ----- | ------------------- | ---------- | -------------------------------- |
| Render     | No    | Yes, after ~15 min  | Yes        | **Chosen.** Accept the sleep.    |
| Vercel     | No    | 300s connection cap | Beta       | Client only.                     |
| Railway    | No    | No                  | Yes        | Good alternative, ~$1/mo credit. |
| Northflank | Yes   | No                  | Yes        | Best fit, but needs a card.      |
| Koyeb      | Yes   | Scales to zero      | Yes        | Good alternative, needs a card.  |

We picked **Render free with no keep-alive pinger** — agreed, and that is the
right instinct: a synthetic pinger is arguably circumventing the intent of the
free tier, and can get an account flagged. Section 9 covers what the sleep
actually feels like and what to do about it.

---

## 2. What you need before you start

- A GitHub repo this project is pushed to (Render and Vercel both deploy from git)
- A Supabase account
- A Render account
- A Vercel account
- An Upstash account (for Redis)
- A free Cloudinary account — optional, only needed once uploads are implemented
- `openssl` or a password generator for the JWT secrets

---

## 3. Order of operations

Do them in this order. Each step assumes the previous one works.

1. Supabase → Postgres
2. **Run the migrations** (section 6) ← the step that is currently untested
3. Redis
4. Render → backend, verify with `curl /health`
5. Vercel → client
6. Set `CLIENT_ORIGIN` on Render to the Vercel URL, and redeploy

---

## 4. Pre-flight: migrations on a throwaway database first

**Read this twice.** All eight migrations have now been run against a real
PostgreSQL 16 and pass, so this is no longer about discovering that they are
broken — it is about confirming *your* target database is at the version you
expect before a deploy does it for you.

Still worth doing before you point this at production:

- `migrate.js`'s `schema_migrations` ledger has been exercised, but not against
  your production database. Confirm `SELECT count(*) FROM schema_migrations`
  returns 8 there, or run `npm run migrate` and read what it says.
- Migration `008` adds `rooms.slug` and **backfills it**. On a database with
  real room names this is a write-heavy step: it rewrites every row in `rooms`.
  Check the row count and be ready for a longer transaction than the others.
- If your database predates the ledger, `npm run migrate` will try to replay
  `001_init.sql` and fail on `roles`/`users` already existing. Use
  `npm run migrate:baseline` **once**, after confirming which of 001–008 have
  genuinely been applied.

**This is what the integration suite does for you, locally.** `npm run test:db`
creates a throwaway `conclave_test` database, applies all eight migrations, runs
22 assertions against the real query paths, and drops the database. Run it before
you deploy and you are reproducing the whole chain in seconds:

```bash
cd backend && npm run test:db
```

The `test/` smoke suite still runs no SQL by design, so it cannot tell you
anything about migrations. `tests/` is the one that can.

---

Sources: [Render WebSockets](https://render.com/docs/websocket),
[Render free services](https://render.com/docs/free),
[Render Blueprint reference](https://render.com/docs/blueprint-spec).

## Before publishing

   This matters and is a common failure. The _direct_ connection
   (`db.<ref>.supabase.co:5432`) is **IPv6-only** on the free tier. Render's
   instances are IPv4-only, so the direct string will not connect. The Supavisor
   **session-mode** string (`aws-<region>.pooler.supabase.com:5432`) is IPv4 and
   built for exactly this — a long-running backend on an IPv4 network.

## Local checks and CI

Use Node 22 (`.nvmrc`), which matches Render, Docker, and the new GitHub workflow.
Run `npm ci` in both `backend/` and `client/`, then:

```sh
cd backend
npm install

export DATABASE_URL='postgresql://postgres.<ref>:<PASSWORD>@aws-<region>.pooler.supabase.com:5432/postgres'
npm run migrate
```

**Before you do:** create a **throwaway** Supabase project and point at that
first. If `008` is broken, you want to find out on a database you can delete.

**What to expect:**

```
Applying 001_init.sql...
Applying 002_decisions_tasks_digest.sql...
...
Applying 008_add_rooms_slug.sql...
All migrations complete.
```

**Then prove it, because "the script said complete" is not verification:**

```bash
# Tables present?
psql "$DATABASE_URL" -c "\dt"
```

If you don't have `psql`, use the **SQL Editor** in the Supabase dashboard and run:

```sql
SELECT tablename FROM pg_tables WHERE schemptype = 'public' ORDER BY tablename;
```

You should see 15 tables. Then:

```sql
-- The ledger exists and is populated
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;

-- Migration 008 actually did its job: the column is NOT NULL and backfilled
SELECT count(*) AS total, count(slug) AS with_slug FROM rooms;

-- Migration 006 fixed the delete-account 500: email must be nullable
SELECT is_nullable FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'email';
-- expect 'YES'
```

**And prove it is re-runnable** — run `npm run migrate` a second time. It should
report that everything is already applied and exit cleanly. If it tries to
re-apply, the ledger is broken and every future deploy will fail.

Finally, exercise the real query paths against the deployed database. The digest
is the one most likely to have a latent SQL error, and it is the feature whose
window logic changed most recently — it now filters per room on that room's own
`room_members.last_seen_at`, and it does nothing at all unless the client calls
`POST /rooms/:roomId/seen` when a room is opened.

```sql
INSERT INTO users (email, password_hash, display_name, role_id)
VALUES ('smoke@test.local', 'x', 'Smoke', 3);
-- then, in a second statement using the id from above:
INSERT INTO room_members (room_id, user_id) VALUES ('<room-uuid>', '<user-uuid>');
```

Or more simply: deploy the backend and exercise the endpoints with `curl`. Section
10 has a ready-made sequence.

**If a migration fails:** `migrate.js` wraps each file in its own transaction, so
a failure rolls back that file only, not the whole batch — and it names the file
that broke. Fix the SQL, delete the database, and start over. There is no
down-migration system; for a pre-launch throwaway, recreating is faster and safer
than patching.

---

## 7. Redis

Your backend uses Redis for presence, typing indicators, and the Socket.IO
multi-instance pub/sub adapter. `connectRedis()` is a hard startup dependency:
**if Redis is unreachable, `server.js` exits** at the `main().catch(...)` handler
at the bottom of the file. So this step is not optional.

**Upstash** (free tier) is the simplest option:

1. Create a database, pick a region near your Render instance.
2. Copy the connection string. It looks like
   `rediss://default:<token>@<region>.upstash.io:6379`.
3. Use the `rediss://` (TLS) URL as-is. `node-redis` v4 handles it, and
   `createClient({ url })` accepts either scheme.
4. Save as `REDIS_URL`.

**Check the request budget honestly.** Upstash free is around 10,000 requests/day.
Conclave writes a presence TTL on every heartbeat, and `useHeartbeat.js` beats
every 30 seconds per connected client:

| Connected users | Heartbeat writes/day | vs 10k budget    |
| --------------- | -------------------- | ---------------- |
| 1               | 2,880                | comfortable      |
| 3               | 8,640                | nearly all of it |
| 5               | 14,400               | **over**         |

That is heartbeats alone — typing indicators, join/leave and the presence sweep
are on top. For a demo with a handful of people, one database is fine. The moment
you have more than about three concurrent users, either add a second free Upstash
database (your `presence.service.js` documents its key schema, and keys are
namespaced by `presence:`, so sharding is straightforward) or move to a Redis with
a byte-based quota instead of a request one. **Check the current numbers in the
dashboard before relying on this** — provider limits change.

Alternatives worth a look if Upstash's cap is too tight: a **Render Key Value**
instance alongside the web service, or **Railway's** Redis.

---

## 8. Render — the backend

Render's dashboard: **New → Web Service → connect the repo.**

| Setting           | Value                |
| ----------------- | -------------------- |
| Root Directory    | `backend`            |
| Runtime           | Node                 |
| Build Command     | `npm ci`             |
| Start Command     | `node src/server.js` |
| Health Check Path | `/health`            |

**Use the native runtime, not the Dockerfile.** You have a `backend/Dockerfile`
and Render would auto-detect it, and that path works too — the entrypoint runs
migrations then `exec node src/server.js`. But the native runtime is faster to
build (no musl, no compiling bcrypt from source) and there are fewer moving parts
on deploy day. Choose Docker only if you want the entrypoint's migration step to
do the work for you.

**Then handle migrations explicitly.** Render's Pre-deploy Command is the intended
place for this, but it is not available on every free-tier plan — check your
dashboard. If you see the field, set it to:

```
npm run migrate
```

The GitHub workflow also starts a disposable PostgreSQL 16 instance and runs
migrations twice, testing both the initial schema and the migration ledger.
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

1. **`CLIENT_ORIGIN` is not optional and not decorative.** It feeds CORS, and
   Socket.IO reads it too. Until it is set to your Vercel URL, the browser will
   refuse every request from the deployed client. Set it _after_ step 9 when you
   know the URL, then redeploy.
2. **Do not rely on the compose fallbacks.** `docker-compose.yml` contains
   `dev-only-access-secret-change-me`. Never copy those into a real environment.
3. **`PORT` is injected by Render** — don't set it. `config/env.js` reads
   `process.env.PORT` first, so Render's value wins.

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

| Setting          | Value           |
| ---------------- | --------------- |
| Root Directory   | `client`        |
| Framework Preset | Vite            |
| Build Command    | `npm run build` |
| Output Directory | `dist`          |

Import the repository with root directory `client`, framework Vite, build command
`npm run build`, and output directory `dist`. Use Node 22. The included
`client/vercel.json` handles direct links and refreshes on SPA routes.

Set these **build-time** variables, replacing the example hostname:

```dotenv
VITE_API_URL=https://YOUR-API.onrender.com/api
VITE_SOCKET_URL=https://YOUR-API.onrender.com
VITE_DEV_AUTH_BYPASS=false
```
VITE_API_URL=https://conclave-xyz.onrender.com/api
VITE_SOCKET_URL=https://conclave-xyz.onrender.com
```

Both are needed and they are different: `VITE_API_URL` is the REST base, with
`/api`; `VITE_SOCKET_URL` is the bare origin, because Socket.IO appends its own
path.

**`VITE_DEV_AUTH_BYPASS` — set it to `false`, or omit it entirely.**
`devPreview.js` gates on `import.meta.env.DEV && VITE_DEV_AUTH_BYPASS === "true"`.
Vite sets `DEV` to `false` in a production build, so **the bypass cannot activate
in a production bundle even if you set the variable**. It is safe by construction.
Setting it to `true` in local dev is what lets you review the seven pages that
have no backend endpoint yet.

---

## 10. Verify, in this order

```bash
# 1. Backend is up (no auth needed, /health is declared before the /api router)
curl https://conclave-xyz.onrender.com/health
# {"status":"ok"}

# 2. Unknown route now returns JSON, not HTML
curl -i https://conclave-xyz.onrender.com/api/nope
# HTTP/1.1 404, content-type: application/json
# {"success":false,"message":"Route not found"}

# 3. Protected route rejects an anonymous caller
curl -i https://conclave-xyz.onrender.com/api/rooms
# 401 {"success":false,"message":"Missing access token"}

# 4. Register and log in
curl -s -X POST https://conclave-xyz.onrender.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery","displayName":"You"}'

TOKEN=$(curl -s -X POST https://conclave-xyz.onrender.com/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

# 5. Authenticated call
curl -s https://conclave-xyz.onrender.com/api/rooms -H "Authorization: Bearer $TOKEN"
# {"success":true,"data":[]}

# 6. Create a room
curl -s -X POST https://conclave-xyz.onrender.com/api/rooms \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Launch Test","type":"group"}'

# 7. Delete the account — this is the endpoint migration 006 repaired.
#    It 500'd on every call before that migration; verify it end to end.
curl -s -X DELETE https://conclave-xyz.onrender.com/api/users/me \
  -H "Authorization: Bearer $TOKEN"
# {"success":true,"data":{"message":"Account deleted"}}

# 8. The old token must now be rejected (it was valid for up to 15 minutes before)
curl -i https://conclave-xyz.onrender.com/api/rooms -H "Authorization: Bearer $TOKEN"
# 401 — confirms the soft-delete check in requireAuth is live
```

Then open the Vercel URL in a browser: register, create a room, send a message,
and confirm a second browser window receives it live. **That last step is the only
real test of Socket.IO and Redis.**

---

## 11. The Render free sleep, honestly

A free Render web service spins down after roughly 15 minutes without inbound
traffic. Waking takes on the order of a minute.

What this means for Conclave specifically:

- **A user sitting in a room with an open socket may or may not keep the instance
  awake.** Render's idle detection has changed across releases; do not design
  around it. Assume it sleeps.
- **After a sleep, the first request is slow, and the first Socket.IO connection
  attempt is likely to time out** before the instance is listening. `socket.io-client`
  retries by default, so it will recover — but the user sees a "Reconnecting"
  state, and `Room.jsx` gates the composer on `isConnected`, so they cannot type
  until it does.
- **The heartbeat sweep and presence state are gone after a sleep.** Redis holds
  presence with a 45-second TTL, so a sleeping server's users are swept as
  offline — correctly, from Redis's point of view — and the sidebar presence dot
  resets.
- **The pg pool and Redis connections are re-established on wake.** `pg` and
  `node-redis` both reconnect on their own, so this should not require a restart.
  If you see connection errors in the logs after a sleep, that is the thing to
  look at first.

This is acceptable for a demo, a portfolio piece, or showing the app to a few
people. It is not acceptable as the steady state for a chat product, where
"sometimes the composer is dead for a minute" is the whole product.

**When it stops being acceptable, the upgrade is $7/month** for Render's Starter
plan, which removes the sleep. That is cheaper than any single user complaining
about it.

---

## 12. Troubleshooting

| Symptom                                             | Likely cause                                             | Fix                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relation "users" does not exist`                   | Migrations never ran                                     | Section 6. This is the one to expect first.                                                                                                        |
| CORS error in the browser console                   | `CLIENT_ORIGIN` not set to the Vercel URL                | Set it on Render, then redeploy. Env changes restart the service.                                                                                  |
| Socket connects, then immediately drops             | Render cold start; client gave up                        | It retries. If persistent, check `REDIS_URL` in the logs.                                                                                          |
| Server exits at boot, logs `Failed to start server` | Redis unreachable. `connectRedis()` is a hard dependency | Check `REDIS_URL`. On Upstash, confirm the `rediss://` scheme and the region.                                                                      |
| `invalid input syntax for type uuid`                | Usually the pooler string was hand-assembled             | Copy the session-mode string from the dashboard verbatim.                                                                                          |
| `too many connections`                              | Pool size vs Supabase limits                             | `pg.Pool` defaults to 10. Free Supabase allows ~15 direct. Fine unless you add services.                                                           |
| `bcrypt` fails to load on deploy                    | Native build                                             | Native runtime: Render's build tools handle it. Docker: the `Dockerfile` installs python3/make/g++ in the same layer, which is required on Alpine. |
| Vercel 404 on `/rooms/<id>`                         | Missing SPA rewrite                                      | `client/vercel.json` is included; confirm Root Directory is `client`.                                                                              |
| Everything works locally, nothing in production     | `VITE_*` baked at build time                             | Vite inlines env vars **at build time**. Changing them in the dashboard requires a **redeploy**, not just a restart.                               |

---

## 13. If you need to start over

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

Do not describe tasks, notifications, or uploads as working: their APIs still
return 501. Several frontend screens remain fixtures or empty placeholders.
