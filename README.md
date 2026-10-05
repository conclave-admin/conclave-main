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

2. **Start Postgres + Redis:**
   ```bash
   docker compose up -d
   ```

3. **Run migrations:**
   ```bash
   cd backend
   npm install
   npm run migrate
   ```

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

## Repo Structure

```
backend/     Express API + Socket.IO server
client/      React + Tailwind frontend (Vite)
docs/        Product brief, API contracts, backend backlog, design references
docker-compose.yml   Postgres + Redis for local dev
```

## Where to start

- **Auth flow (register/login/refresh) is already wired up** in `backend/src/controllers/auth.controller.js` — use it as the pattern for everything else.
- Rooms, messages, decisions, and digest APIs are implemented. Tasks, notifications, and uploads still return 501. See [the backend backlog](docs/BACKEND_TASKS.md) for current gaps and Victor's priorities, and [CONTRIBUTING.md](CONTRIBUTING.md) for ownership.
- Socket event names and payloads are documented in `backend/src/sockets/index.js`.
- Database schema lives in `backend/database/migrations/` as plain SQL — run in order.
- Deployment instructions and the Render Blueprint are in [DEPLOYMENT.md](DEPLOYMENT.md) and [render.yaml](render.yaml). Use Node 22 for hosting and CI.

## Architecture and documentation

REST requests follow routes → controllers → shared services → PostgreSQL.
Socket.IO uses the same message write service; Redis maintains presence and
relays events between API instances. Cloudinary is configured for future uploads.

- [API contracts](docs/API_CONTRACTS.md): endpoint payloads and integration notes.
- [Backend backlog](docs/BACKEND_TASKS.md): current status, priorities and risks.
- [Product brief](docs/PKB_Project_Architecture_Brief.docx): product rationale.
- [Frontend guidance](docs/CLAUDE.md), [design questions](docs/DESIGN_QUESTIONS.md)
  and [visual QA](docs/design-qa.md): Isaac's implementation references.
