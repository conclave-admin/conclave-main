# Deploying Conclave

Target: free tiers, today. Stack: **Vercel** (client) + **Render** (backend) +
**Supabase** (Postgres) + a free Redis.

Read section 1 before touching anything, and section 4 (pre-flight) before you
deploy — there is a real chance the first deploy fails on the database, and it is
not a configuration mistake when it does.

---

## 1. The architecture, and why it isn't all on Vercel

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
precise about, because Vercel *does* now support WebSockets (public beta since
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
*external* Redis from SQL. It is not a Redis you can point `REDIS_URL` at. So
Redis has to come from somewhere else — section 5.

### Free tier comparison for the backend

| Platform    | Card? | Sleeps?             | WebSockets | Verdict for Conclave             |
| ----------- | ----- | ------------------- | ---------- | -------------------------------- |
| Render      | No    | Yes, after ~15 min  | Yes        | **Chosen.** Accept the sleep.    |
| Vercel      | No    | 300s connection cap | Beta       | Client only.                     |
| Railway     | No    | No                  | Yes        | Good alternative, ~$1/mo credit. |
| Northflank  | Yes   | No                  | Yes        | Best fit, but needs a card.      |
| Koyeb       | Yes   | Scales to zero      | Yes        | Good alternative, needs a card.  |

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

## 4. Pre-flight: the migrations have never been run

**Read this twice.** `docs/BACKEND_TASKS.md` records that the backend was written
in an environment without Docker, so:

- No migration has ever executed against a real Postgres.
- `migrate.js`'s `schema_migrations` ledger has never been exercised.
- Migration `008` (rooms slug) has never run.
- The `(created_at, id)` tuple cursors, the `unnest($1::uuid[])` member insert and
  the SCAN-based presence helpers have never been run.

If you deploy and then discover a migration is broken, you are debugging against
a live environment with a half-built schema. Do this first, on a throwaway
database, and you find out in five minutes instead of an hour.

The new smoke tests (`cd backend && npm test`) do **not** cover this — they run no
SQL by design.

---

## 5. Supabase — Postgres

1. **New project.** Pick the region closest to where Render runs. Set a strong
   database password and **save it in your password manager** — you cannot read
   it back from the dashboard.
2. **Database → Connection string.** Use the **Session mode (port 5432)**
   connection string, not Transaction mode.

   This matters and is a common failure. The *direct* connection
   (`db.<ref>.supabase.co:5432`) is **IPv6-only** on the free tier. Render's
   instances are IPv4-only, so the direct string will not connect. The Supavisor
   **session-mode** string (`aws-<region>.pooler.supabase.com:5432`) is IPv4 and
   built for exactly this — a long-running backend on an IPv4 network.

   Use session mode, not transaction mode: your app uses multi-statement
   transactions (`rooms.controller.js` does explicit `BEGIN`/`COMMIT` around room
   creation, and `message.service.js` does the same), and transaction-mode pooling
   hands out a different backend connection per statement, which breaks them.

   The dashboard gives you the URL-encoded string ready to paste. Don't hand-build
   it — Supabase passwords frequently contain `@` and `/`, which silently
   truncate a hand-written connection string.

3. **Database → Connection pooling.** Leave the default. The app uses a `pg.Pool`
   with no explicit `max`, so it defaults to 10 connections. That is well within
   the free tier.

4. **Network → Restrictions.** Supabase allows connections from anywhere by
   default. You can restrict it, but Render assigns dynamic outbound IPs, so a
   static allowlist is impractical on a free account. Leave it open; the password
   is the control.

5. Save the string as `DATABASE_URL`.

---

## 6. Run the migrations — against Supabase, from your laptop

You do not need Docker or `psql` for this. You have Node and the backend's
dependencies, so you can run the project's own migration runner against Supabase
directly. This also exercises `migrate.js` itself, which is currently unproven.

```bash
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

Finally, exercise the real query paths. The digest is the one most likely to have
a latent SQL error, and it is also the feature that has never been run at all:

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

| Connected users | Heartbeat writes/day | vs 10k budget |
| --------------- | -------------------- | -------------- |
| 1               | 2,880                | comfortable    |
| 3               | 8,640                | nearly all of it |
| 5               | 14,400               | **over**       |

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

| Setting                | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| Root Directory         | `backend`                                                |
| Runtime                | Node                                                     |
| Build Command          | `npm ci`                                                 |
| Start Command          | `node src/server.js`                                     |
| Health Check Path      | `/health`                                                |

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

If you don't, put it in the Build Command instead:

```
npm ci && npm run migrate
```

(That runs migrations at build time, which is mildly unorthodox, but it is
idempotent and it works. The alternative — running them by hand against Supabase
once, as in section 6 — is also fine and arguably better, since you then control
exactly when the schema changes.)

**Environment variables** (Render → Environment):

```
NODE_ENV=production
DATABASE_URL=postgresql://postgres.<ref>:<PASSWORD>@aws-<region>.pooler.supabase.com:5432/postgres
REDIS_URL=rediss://default:<token>@<region>.upstash.io:6379
JWT_ACCESS_SECRET=<64 random hex chars>
JWT_REFRESH_SECRET=<64 different random hex chars>
CLIENT_ORIGIN=https://conclave-xyz.vercel.app
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**Three things to be careful about here:**

1. **`CLIENT_ORIGIN` is not optional and not decorative.** It feeds CORS, and
   Socket.IO reads it too. Until it is set to your Vercel URL, the browser will
   refuse every request from the deployed client. Set it *after* step 9 when you
   know the URL, then redeploy.
2. **Do not rely on the compose fallbacks.** `docker-compose.yml` contains
   `dev-only-access-secret-change-me`. Never copy those into a real environment.
3. **`PORT` is injected by Render** — don't set it. `config/env.js` reads
   `process.env.PORT` first, so Render's value wins.

Set `NODE_ENV=production`. This switches morgan from `dev` to `combined` logging
and marks the environment correctly. Note that `morgan` in `combined` mode logs
every request line to stdout, which on a free instance that sleeps and restarts
will be the first thing you want when debugging.

---

## 9. Vercel — the client

Dashboard: **New Project → import the repo.**

| Setting           | Value                                            |
| ----------------- | ------------------------------------------------ |
| Root Directory    | `client`                                         |
| Framework Preset  | Vite                                             |
| Build Command     | `npm run build`                                  |
| Output Directory  | `dist`                                           |

A `client/vercel.json` is included with an SPA rewrite. **Without it, refreshing
`/rooms/<id>` returns Vercel's 404** rather than your app, because there is no
file at that path and no rewrite to hand it to `index.html`. Every in-app link
uses client-side routing, so this only bites on hard refresh and on shared links
— which is to say, exactly when someone sends you a link to a room.

**Environment variables:**

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

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `relation "users" does not exist` | Migrations never ran | Section 6. This is the one to expect first. |
| CORS error in the browser console | `CLIENT_ORIGIN` not set to the Vercel URL | Set it on Render, then redeploy. Env changes restart the service. |
| Socket connects, then immediately drops | Render cold start; client gave up | It retries. If persistent, check `REDIS_URL` in the logs. |
| Server exits at boot, logs `Failed to start server` | Redis unreachable. `connectRedis()` is a hard dependency | Check `REDIS_URL`. On Upstash, confirm the `rediss://` scheme and the region. |
| `invalid input syntax for type uuid` | Usually the pooler string was hand-assembled | Copy the session-mode string from the dashboard verbatim. |
| `too many connections` | Pool size vs Supabase limits | `pg.Pool` defaults to 10. Free Supabase allows ~15 direct. Fine unless you add services. |
| `bcrypt` fails to load on deploy | Native build | Native runtime: Render's build tools handle it. Docker: the `Dockerfile` installs python3/make/g++ in the same layer, which is required on Alpine. |
| Vercel 404 on `/rooms/<id>` | Missing SPA rewrite | `client/vercel.json` is included; confirm Root Directory is `client`. |
| Everything works locally, nothing in production | `VITE_*` baked at build time | Vite inlines env vars **at build time**. Changing them in the dashboard requires a **redeploy**, not just a restart. |

---

## 13. If you need to start over

Supabase: delete the project and create a new one. It is the fastest way to undo
a bad schema, and for a pre-launch database there is nothing worth preserving.

Render: the service can be deleted and recreated; nothing is stored on it.

Vercel: redeploys are cheap and the client is a static build with no server state.

**Secrets are not recoverable.** Once a JWT secret is set and users have tokens
signed with it, changing it invalidates every session. Set it once, correctly.
And confirm `backend/.env` has never been committed — `docs/BACKEND_TASKS.md`
Bug 12 records that it was checked on this repo and is clean, but re-check any
archives or other branches you have shared.
