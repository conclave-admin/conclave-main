# Conclave — Private Collaboration Platform

A private, invite-only messaging & collaboration platform for the team — instant messaging, rooms, media sharing, plus a memory layer competitors don't have: **Decisions**, **Action Items**, and **Catch-up Digests** that survive the scroll.

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
docs/        PKB, API contracts, decision log
docker-compose.yml   Postgres + Redis for local dev
```

## Where to start

- **Auth flow (register/login/refresh) is already wired up** in `backend/src/controllers/auth.controller.js` — use it as the pattern for everything else.
- Rooms, messages, decisions, and digest APIs are implemented. Tasks, notifications, and uploads still return 501. See [the launch review](docs/LAUNCH_REVIEW.md) for current gaps and Victor's priorities, and [CONTRIBUTING.md](CONTRIBUTING.md) for ownership.
- Socket event names and payloads are documented in `backend/src/sockets/index.js`.
- Database schema lives in `backend/database/migrations/` as plain SQL — run in order.
- Deployment instructions and the Render Blueprint are in [DEPLOYMENT.md](DEPLOYMENT.md) and [render.yaml](render.yaml). Use Node 22 for hosting and CI.
