# Backend work and launch status

This is the current backlog. Ownership and collaboration rules live in
[CONTRIBUTING.md](../CONTRIBUTING.md); provider setup and acceptance checks live
in [DEPLOYMENT.md](../DEPLOYMENT.md). Keep endpoint payloads in
[API_CONTRACTS.md](API_CONTRACTS.md), not duplicated here.

## Current state

| Area | State | Owner |
| --- | --- | --- |
| Auth, users, rooms | Implemented; invitations, auth rate limiting and room management remain | Michael |
| Messaging | Implemented; pagination UI and send acknowledgements remain | Michael / Victor / Isaac by layer |
| Decisions and digest | APIs implemented; frontend integration remains | Victor / Isaac |
| Tasks | API stubs return 501 | Victor |
| Notifications and uploads | API stubs return 501 | Victor |
| Frontend | Room chat wired; several other screens are fixtures/placeholders | Isaac |
| Deployment | Configuration committed; no live deployment verified here | Victor coordinates |

## Victor's backlog

### A. Tasks

Implement create, cross-room and per-room listing, and status updates. Require
room membership, validate assignees against the room, and reject source messages
from other rooms or deleted messages. Return assignee and room metadata, provide
pagination and filters, maintain `updated_at`, and emit `task:updated` after
successful writes. Assignment notifications belong with item B. Isaac owns the
board integration; changing the backend alone does not finish the Tasks screen.

### B. Notifications

Implement recipient-scoped, paginated reads with an unread count and mark-seen
for one/all notifications. Resolve `type` and `reference_id` into readable text.
Add assignment, new-message and mention notifications and live delivery.
Michael's room-member endpoint already stores `room_invite`; coordinate any
change to that controller instead of taking over his work.

### C. Uploads and attachment ownership

Stream uploads to Cloudinary, enforce file-type and size limits, and keep the
filename/MIME/size response aligned with the API contract. Persist upload
ownership and resolve attachment URLs from server records. The shared message
service currently trusts client URLs, so coordinate that necessary change with
Michael. Isaac owns the composer UI. Cloudinary credentials are needed for a
real integration check; oversized multipart requests already return 413.

### E. Search

Decision search exists across rooms; message search is room-scoped. Decide
whether the navbar opens room search or needs a global message/decision search
endpoint before adding another API. Any global query must restrict room membership.

### H. Structured mentions

Replace display-name regex matching with `message_mentions(message_id, user_id)`
and validated `mentionedUserIds`. Names are mutable and are not identities.
This affects the shared message write path; coordinate with Michael and Isaac.

### I. Message edits, deletion and reactions

Add authorized mutations and socket events. `edited_at`, `deleted_at` and
`message_reactions` already exist. The read side withholds deleted content;
Isaac still needs to render tombstones and controls. Persist read receipts if
required; the existing event only broadcasts them.

### Later

Sourced room Q&A can build on reliable decisions, tasks, search and permissions.
Answers should link to their source messages.

## Work to coordinate, not take over

- **Michael — G, invitations:** choose invite links, email invites or admin-created
  accounts. Registration is open despite invite-only UI wording. Gate it before
  describing the deployment as invite-only.
- **Michael — auth rate limiting:** agree the library/store choice; none is wired.
- **Michael — F, room management:** room editing, leave/remove/promote/delete and
  find-or-create DMs. Room creation APIs exist but their onboarding UI does not.
- **Michael — D, home data:** unread counts, tasks due and recent activity.
- **Michael — privacy/authorization:** user-directory email exposure, unused
  `role_id`, and account deletion while existing sockets remain connected.
- **Isaac:** wire decisions/digest APIs, room-seen calls, older-message pagination,
  task/notification/upload screens, first-room creation and member management.
- **Isaac / Victor:** coordinate simultaneous token refresh across browser tabs,
  visible socket send failures and acknowledgements. Current refresh coalescing
  works within one tab; reconnect recovery fetches the latest history page.

## Remaining technical risks

- Migrations and query behavior still need a real PostgreSQL check. Migration
  008's backfill may collide for existing names such as `Room`, `Room`, `Room-2`;
  a fresh-schema check does not cover populated upgrades.
- Presence announcements currently reach sockets outside shared rooms. Decide
  the visibility policy and then scope broadcasts. Check multi-tab room presence.
- Review room-member authorization races and unbounded member lists before
  scaling. `listMessages` attachment aggregation could later be simplified.
- Review remaining React Router production advisories and development-tool
  advisories separately; do not serve Vite's dev server in production.
- New schema changes use numbered migrations. Never silently baseline an
  existing database or rewrite applied migrations.

## Verification status

The launch-hardening commit passed 24 backend tests, 6 client session tests and
the production frontend build locally on Node 18.19.1. Node 22 is configured for
CI/hosting. CI also applies migrations twice against disposable PostgreSQL 16;
remote results and live PostgreSQL/Redis/browser checks have not been verified
from this workspace. No hosting credentials are configured here.

The last production dependency audit reported zero backend findings and two
moderate frontend entries (React Router and its DOM package). This is a dated
check, not a guarantee about future dependency versions.

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
| Bug 7 | Deleted message reads/search handled; mutation endpoints remain |
| Bug 8 | Attachment-only messages accepted; URL ownership remains |
| Bug 9 | Regex mention matching improved; replace with user IDs in H |
| Bug 10 | Migration ledger and session advisory lock added |
| Bug 11 | Credential validation, token rotation, unique JWT IDs, safe login responses and client refresh added; invites/rate limiting remain |
| Bug 12 | Env files ignored; exclude credentials from shared archives |
| Bug 13 | Membership checks, per-user socket counts, SCAN cleanup, error handling and reconnect fixes added; visibility/read receipts remain |
| Bug 14 | Standard error envelopes, UUID validation and upload/body limits added |
| Bug 15 | Tuple cursors, deleted-user filtering and profile limits added; directory privacy/member races remain |
