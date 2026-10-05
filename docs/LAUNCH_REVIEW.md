# Conclave launch review — 5 October 2026

## Architecture and ownership

React/Vite calls an Express REST API and a persistent Socket.IO server.
Postgres holds users, room membership, messages, decisions, tasks and notifications.
Redis handles presence and Socket.IO fan-out. Cloudinary is configured but uploads
are unimplemented. The API uses JWT access tokens plus stored, rotating refresh tokens.

Victor owns decisions, tasks, digests, sockets and uploads. Michael owns auth,
users, rooms and shared services. Isaac owns the frontend. This review includes
cross-cutting launch fixes because deploying a working app requires both sides.

## What works and what is missing

| Area | Observed state |
| --- | --- |
| Authentication, users, room APIs | Implemented; public registration contradicts invite-only copy |
| Messaging | REST and socket write paths share a service; room history and live messages are wired |
| Decisions and digests | Implemented APIs, but top-level UI still needs real data integration |
| Tasks, notifications, uploads | Controller stubs return 501 |
| First-user onboarding | No room-creation UI; tester rooms/memberships need API setup |
| Home, settings, notifications, DMs | Incomplete data or placeholder/missing screens |
| Invitations | Not implemented; public URL and signup policy are separate decisions |

## Fixes in this working tree

- Remove `password_hash` from successful login responses.
- Give each refresh JWT a unique ID; tokens issued within one second must differ.
- Refresh expired API sessions once, share concurrent refreshes within a tab,
  persist both rotated tokens, and notify the UI when refresh is rejected.
- Read fresh credentials during socket handshakes and retry temporary failures.
- Rejoin rooms and reload recent messages after reconnecting.
- Catch socket handler exceptions and reject malformed payloads without leaking
  internal errors or allowing unhandled promise rejections.
- Install room listeners before asynchronous presence initialization completes.
- Upgrade bcrypt and Multer; update frontend packages within existing ranges.
- Serialize migration runners with a session advisory lock and check Postgres at startup.
- Add Node 22 deployment configuration, a Render Blueprint, and CI that runs tests,
  builds the client, and applies migrations twice against disposable Postgres.

These changes are local and have not been pushed or deployed.

## Victor's recommended next work

1. **Uploads and attachment ownership.** Implement the Cloudinary endpoint with
   validated file types and size limits. Store upload ownership and resolve
   attachment URLs from server records; the message service still trusts URLs
   supplied by clients. Pair with Isaac on the attach button and progress/errors.
2. **Tasks end to end.** Add create/list/status endpoints with room-membership
   checks, cross-room filtering, assignees, due dates, timestamps and socket events.
   Pair with Isaac on the board. This also gives the digest useful task activity.
3. **Notifications and structured mentions.** Persist user IDs for mentions,
   scope notification reads/updates to the recipient, and connect live delivery.
4. **Finish decisions/digests with Isaac.** Wire their existing cross-room APIs,
   creation/search controls, source-message links and room-seen timestamps.
5. **Message editing, deletion and reactions.** Use existing schema fields,
   authorize each mutation and broadcast the persisted result.
6. **Later: sourced room Q&A.** Only after decisions, tasks, permissions and
   searchable history are dependable. Answers should cite source messages.

## Remaining launch concerns

- Agree signup policy with Michael and enforce it; registration is currently open.
- Add auth rate limiting. CONTRIBUTING.md explicitly leaves the library/store
  choice for discussion. No limiter was silently introduced during this review.
- Complete room creation/member onboarding with Isaac, or explicitly launch a
  small tester release whose rooms are provisioned via the API.
- Review the user-directory email exposure and permissions for deleted accounts
  with already-connected sockets. Handshake checks alone do not revoke a live socket.
- Refresh coordination currently shares work within one tab; simultaneous refresh
  from separate tabs needs browser-wide coordination or server-side handling.
- Reconnect recovery reloads the latest history page; long outages and older
  history still need proper pagination. Message sends also need acknowledgements
  and visible failure/retry states.
- Review React Router's remaining moderate production advisories and plan a
  tested router/toolchain upgrade. Development dependencies retain advisories;
  do not publish a Vite development server as the production frontend.
- Migration 008 can generate duplicate slugs for existing names such as `Room`,
  `Room`, and `Room-2`. Test populated database upgrades before treating that
  backfill as safe. A fresh empty schema does not exercise this case.

## Verification and limits

All 24 backend tests and 6 client session tests pass; the frontend production
build succeeds. The local runtime is Node 18.19.1; Node 22 is configured for CI
and hosting, but those remote checks have not run yet.

After dependency updates, `npm audit --omit=dev` reports zero backend advisories
and two moderate frontend entries (React Router and its DOM package). Full audits
still include development-tool findings.

No PostgreSQL/Redis service or provider credentials are configured here. Live
migrations, SQL behavior, two-browser realtime delivery, and the actual public
deployment remain unverified. Follow [DEPLOYMENT.md](../DEPLOYMENT.md) once provider
access and signup policy are available.
