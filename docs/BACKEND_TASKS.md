# Backend work and launch status

Ownership and working rules live in [CONTRIBUTING.md](../CONTRIBUTING.md), endpoint
payloads in [API_CONTRACTS.md](API_CONTRACTS.md), and provider setup and acceptance
checks in [DEPLOYMENT.md](../DEPLOYMENT.md).

## Current state

| Area | State | Owner |
| --- | --- | --- |
| Auth, users, rooms | Implemented; group access, rate limiting and room management remain | Victor |
| Presence and tokens | Implemented; privacy and cross-tab refresh need review | Victor |
| Messages, decisions, tasks, digest | APIs implemented; further frontend integration remains | Michael / Isaac |
| Chat list | `GET /rooms` enriched (`display_name`, `display_avatar`, `last_message`, `unread_count`, activity order) and `chat:updated` emitted per member on create/edit/delete | Michael |
| Notifications | List/seen APIs, room invitations and mentions implemented | Michael |
| Uploads | Cloudinary upload and server-owned attachment records implemented | Michael |
| Frontend | Room chat wired; several screens use fixtures/placeholders | Isaac |
| Deployment | Configuration committed; public deployment not verified here | Victor coordinates |

## Victor's backlog

- **G — Group access:** registration is intentionally open to everyone. Implement
  public group discovery/joining and private group invitations according to
  user/admin preferences. Existing room reads require membership even for rooms
  typed `public`; anonymous reading has not been specified.
- **Auth rate limiting:** agree the library/store choice before implementation.
- **F — Room management:** editing, leave/remove/promote/delete and find-or-create
  DMs. Coordinate membership changes with Michael because digest windows and
  authorization depend on membership rows.
- **D — Home data:** unread counts, tasks due and recent activity.
- **Privacy/authorization:** directory email exposure, unused `role_id`, account
  deletion while sockets remain connected, and presence broadcast visibility.
- **Session reliability:** coordinate simultaneous refresh across browser tabs
  with Isaac; current refresh coalescing is within one tab.

## Michael's implemented features and follow-up

- **A — Tasks:** create, cross-room/per-room listing, status filters and room-member
  status updates. Lists sort by due date, undated last. Create/update emits
  `task:updated` to room subscribers. Pagination, assignment notifications and
  live updates on the top-level board remain possible follow-up work.
- **B — Notifications:** recipient-scoped pagination, unread count and mark-seen,
  with live room-invite/mention delivery. `new_message` fan-out is intentionally
  deferred pending a product decision about notification volume.
- **C — Uploads:** allowlisted files stream to Cloudinary and create ownership
  records. Message creation claims the upload once and reads metadata from the
  server record. Cloudinary credentials are needed for a real round-trip check.
- **H — Structured mentions:** IDs are persisted and used by notifications/digest.
  Remove text-matching fallback after Isaac's client sends `mentionedUserIds`.
- **I — Message mutations:** author edits, author/admin deletion and four allowed
  reactions are implemented with socket events. Read-receipt persistence remains.
- **E — Search:** decide whether the navbar needs global search or room search.
  Global queries must restrict results to the caller's rooms.

## Isaac's integration work

Wire decisions/tasks/digest/notifications, uploads and structured mentions; call
room-seen when opening a room; support older-message pagination and first-room
creation/member management. Connect existing account deletion. Frontend work
follows [CLAUDE.md](CLAUDE.md) and remains Isaac's lane.

## Remaining technical risks

- Migration 008's populated slug backfill may collide for existing names such as
  `Room`, `Room`, `Room-2`; fresh-schema checks do not cover populated upgrades.
- Review room-member authorization races and unbounded lists before scaling.
- Presence broadcasts currently reach sockets outside shared rooms. Decide the
  visibility policy and verify multi-tab room presence.
- Review frontend dependency advisories separately; never serve Vite's development
  server in production.
- Never silently baseline an existing database or rewrite applied migrations.

## Verification

Run the commands in [CONTRIBUTING.md](../CONTRIBUTING.md). On 2026-10-06, local
Node 22 checks passed 22 backend regression tests, 104 database/upload checks
and six client session tests. Four Cloudinary round-trip checks skipped because
credentials were absent. All 13 migrations applied to fresh PostgreSQL 18.4;
a second run was a no-op. Database isolation/cleanup and failure on unavailable
PostgreSQL were verified. The client production build also passed.

CI targets Node 22 and PostgreSQL 16; remote CI results are not verified here.
Notification regressions verify emitted payloads against persisted rows, with a
fake Socket.IO transport. Live Redis delivery, browser acceptance and actual
provider deployment remain separate staging checks.

## Historical audit reference

Older code comments refer to Bug 1–15 below. Details and patches are retained in
Git history; this index preserves their meaning without duplicating old reports.

| Reference | Concern and current follow-up |
| --- | --- |
| Bug 1 | Account deletion: email nullability repaired by migration 006 |
| Bug 2 | Digest windows: per-room `last_seen_at`; frontend seen calls remain |
| Bug 3 | Room types: public/private accepted |
| Bug 4 | Room slug: added by 008; populated backfill collision remains |
| Bug 5 | Decision search: includes tags; keep title/body tsvector identical to migration 007 |
| Bug 6 | Attachment response shape aligned; `file_type` stores MIME strings |
| Bug 7 | Deleted message reads/search handled; edit/delete/reaction endpoints implemented |
| Bug 8 | Attachment-only messages accepted; server-owned uploads claimed once per message |
| Bug 9 | Regex mention matching improved; structured IDs implemented; legacy client fallback remains |
| Bug 10 | Migration ledger and session advisory lock added |
| Bug 11 | Credential validation, token rotation, unique JWT IDs, safe login responses and client refresh added; group access/rate limiting remain |
| Bug 12 | Env files ignored; exclude credentials from shared archives |
| Bug 13 | Membership checks, per-user socket counts, SCAN cleanup, error handling and reconnect fixes added; visibility/read receipts remain |
| Bug 14 | Standard error envelopes, UUID validation and upload/body limits added |
| Bug 15 | Tuple cursors, deleted-user filtering and profile limits added; directory privacy/member races remain |
