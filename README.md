# Conclave — Private Collaboration Platform

A team messaging and collaboration platform with **Decisions**, **Action Items**,
and **Catch-up Digests** that survive the scroll. Invite-only access is the intended
model; registration is currently open until invitations are implemented.

Full product/architecture context: [`docs/PKB_Project_Architecture_Brief.docx`](docs/PKB_Project_Architecture_Brief.docx).

## Stack

- **Backend:** Node.js + Express
- **Real-time:** Socket.IO
- **Database:** PostgreSQL
- **Cache / presence / pub-sub:** Redis
- **Media storage:** Cloudinary
- **Auth:** JWT (access + refresh token)
- **Frontend:** React + Tailwind (Vite)

## Getting Started (local dev)

1. **Copy env files:**
   ```bash
   cp backend/.env.example backend/.env
   cp client/.env.example client/.env
   ```
   Fill in your Cloudinary credentials and JWT secrets in `backend/.env`.
   To browse the UI without a backend, set `VITE_DEV_AUTH_BYPASS=true` in `client/.env.local`.

2. **Start Postgres + Redis — name the services explicitly:**
   ```bash
   docker compose up -d postgres redis
   ```

   > **Read this before you type `docker compose up`.** A bare `docker compose up`
   > starts **all three** services, including `backend`, which publishes host port
   > **5000** — the same port step 4 binds with `npm run dev`. The datastores start
   > fine and the backend alone dies with:
   >
   > ```
   > failed to bind host port 0.0.0.0:5000/tcp: address already in use
   > ```
   >
   > This is a port conflict, not a misconfiguration. The `DATABASE_URL` and
   > `REDIS_URL` in `docker-compose.yml` and in your `.env` **do** agree — they are
   > just written two ways. `postgres:5432` is the hostname *inside* the compose
   > network; `localhost:5432` is the same Postgres seen *from your host*, because
   > compose publishes 5432. Both resolve to the same running database.
   >
   > **Two ways to fix it.** Pick one; neither is applied yet, because which one you
   > want is a project decision.
   >
   > **(a) Make the backend opt-in with a Compose profile** — recommended. Add to the
   > `backend` service in `docker-compose.yml`:
   >
   > ```yaml
   > backend:
   >   profiles: ["full"]
   >   build: ./backend
   >   # ...rest unchanged
   > ```
   >
   > Then plain `docker compose up` becomes safe for everyone:
   >
   > ```bash
   > docker compose up -d              # postgres + redis only  ← safe default
   > docker compose --profile full up  # everything, including the dockerised backend
   > ```
   >
   > This keeps the fully-dockerised path available for anyone without Node
   > installed, or for CI, while making the default collision-proof.
   >
   > **(b) Delete the `backend` service block** — simpler, if you never intend to run
   > the backend in Docker. Removes the ambiguity outright at the cost of the
   > all-Docker option.

3. **Run migrations:**
   ```bash
   cd backend
   npm install
   npm run migrate
   ```
   The runner records applied files in `schema_migrations` and is safe to re-run. If
   you have a database that predates that table, run `npm run migrate:baseline` once
   — it records the existing files **without executing them**, so check which
   migrations have genuinely been applied first.

4. **Start the backend:**
   ```bash
   npm run dev
   ```
   Runs on `http://localhost:5000` by default.

5. **Start the client (new terminal):**
   ```bash
   cd client
   npm install
   npm run dev
   ```
   Runs on `http://localhost:5173` by default.

6. **Run the tests:**
   ```bash
   cd backend
   npm test
   ```
   Two suites, 39 tests. `test/` boots the Express app in-process and asserts the
   route table, middleware order and error envelope — it needs no database.
   `tests/` is the integration suite: it applies all eight migrations to a
   throwaway `conclave_test` database, exercises the rewritten queries, and drops
   the database afterwards, so it can never touch your dev data. It skips itself
   if Postgres is unreachable.

   ```bash
   npm run test:db    # just the integration suite
   ```

## Repo Structure

```
backend/     Express API + Socket.IO server
  test/      no-database smoke tests (route table, middleware, errors)
  tests/     integration tests against a throwaway Postgres database
client/      React + Tailwind frontend (Vite)
docs/        PKB, API contracts, backend task status, decision log
docker-compose.yml   Postgres + Redis for local dev, plus an optional backend
```

## Where to start

- **Auth flow (register/login/refresh) is wired up** in `backend/src/controllers/auth.controller.js` — use it as the pattern for everything else.
- `rooms`, `messages`, `decisions` and `digest` are implemented. `tasks`, `notifications` and `upload` are still `501` stubs, so the Tasks page, the notifications bell and the composer's attach button have no data source yet. Those are the next pieces of work — see `docs/BACKEND_TASKS.md` items A–C.
- **What is still unbuilt is listed in `docs/BACKEND_TASKS.md`** — start with the "Remaining work" section. Its per-bug section records which of the 15 audited bugs are fixed, which are partial, and which were deliberately deferred with a reason.
- Socket event names and payloads are documented in `backend/src/sockets/index.js`. The header lists only events that actually exist; four that were documented but never emitted have been removed from it.
- Database schema lives in `backend/database/migrations/` as plain SQL — run in order, and never edit a file that has already been applied.
