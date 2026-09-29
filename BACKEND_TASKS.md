# Backend tasks

Found while building the frontend against the Penpot design, then updated after a full backend audit (routes, controllers, services, sockets, migrations) checked against what the client calls, then updated again after the audit bugs were fixed on `fix/backend-audit-bugs`.

Legend: DONE = shipped and verified in code. PARTIAL = shipped with a known problem. FIXED = was a bug, now repaired. OPEN = not started or still a stub. NEEDS DECISION = deliberately not actioned, waiting on a call.

**Current state:** every bug in the audit list below is either FIXED or explicitly deferred with a reason. The open work is the feature set (items A–J), not the bug list.

---

## Status summary

| Area                                    | Status                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| Auth (register, login, refresh, logout) | DONE (hardened; token rotation added — see Bug 11 client note)      |
| Users (me, update, list, delete)        | DONE (delete account repaired and now works)                         |
| Rooms (create, list, get, add member)   | DONE (public/private creatable, DMs deduped)                         |
| Messages (send, list, search)           | DONE (deleted content masked, attachment shapes unified)             |
| Decisions                               | PARTIAL (search and pagination fixed; `room_slug` still open, Bug 4) |
| Digest                                  | DONE (now genuinely time-bounded per room)                           |
| Sockets and presence                    | DONE (membership guards, no blocking KEYS, no phantom events)       |
| Tasks                                   | OPEN (all three handlers are stubs; now return 501)                  |
| Notifications                           | OPEN (both handlers are stubs; now return 501)                       |
| File upload (Cloudinary)                | OPEN (handler is a stub; now returns 501)                            |
| Migrations                              | DONE (runner is re-runnable and tracks applied files)                 |
| Tests                                   | OPEN (none exist — still the largest risk on this list)              |

### Verification status

**No SQL was executed.** Docker is not available in the environment this branch was built in, so every query and migration here is syntax-checked and module-loaded but unrun. Syntax is verified (`node --check` across all backend JS, and every controller plus the route tree loads). Before merging, run against a real Postgres:

- `006_drop_email_not_null.sql` — the fix for the delete-account 500
- `007_decisions_search_includes_tags.sql` — rebuilds the decisions GIN index
- the `(created_at, id)` tuple cursor, the `unnest($1::uuid[])` member insert, and the SCAN-based presence helpers

---

## Items from the original list

All six are shipped. Items 1–5 are DONE; item 6 was shipped broken and is now repaired.

### 1. Cross-room endpoints for Decisions and Digest: DONE

`GET /decisions` and `GET /digest` exist and return cross-room data. The room-scoped routes remain for backward compatibility. The response shapes match `previewDecisions`, `previewDigestSummary` and `previewDigestItems` in `client/src/config/devPreview.js`.

Since the original write-up, Bugs 2, 4, 5 and 9 have been addressed. Bug 4 (`room_slug`) is still open and is the only remaining gap on this item.

### 2. `listRooms` doesn't select `r.type`: DONE

`listRooms` now selects and groups by `r.type`. Bug 3 is also fixed, so `public` and `private` rooms can actually be created and the Hash and Lock icons can appear with real data.

### 3. `attachments` has no filename column: DONE

Migration `004_add_attachment_filename.sql` adds the column and backfills it from `file_url`. `listMessages` reads `a.filename`.

### 4. `createMessage` doesn't include attachments: DONE

`message.service.js` inserts attachments in the same transaction and returns them. Bug 6 is also fixed, so the returned shape now matches `listMessages`.

### 5. Message sender shape is inconsistent: DONE

REST and socket paths both return flat `sender_name` and `sender_avatar` now. The client helper in `MessageTimeline.jsx` that checks `sender.display_name` first can be simplified.

### 6. No delete-account endpoint: DONE (was broken on arrival)

`DELETE /users/me` exists and the profile page can call it. It shipped as a P0 that 500'd on every call — see Bug 1, now fixed.

---

## Bugs found in the backend

Ordered by severity. All fixed on `fix/backend-audit-bugs` except where marked NEEDS DECISION or deferred.

**Fix map:** Bug 1 → `13b5762` · Bugs 2 and 9 → `a8a83a2` · Bugs 10 and 14 → `1c921ef` · Bug 3 and one Bug 15 item → `520191a` · Bug 5 → `f02ed86` · Bug 11 → `3615495` · Bug 13 and two Bug 15 items → `aebfba2`

### Bug 1. Delete account fails at runtime (high): FIXED

**Cause.** `deleteMe` ran `UPDATE users SET email = NULL ...`, but `users.email` is declared `TEXT UNIQUE NOT NULL` in `001_init.sql`. Migration `005` only added `deleted_at`, so the constraint was still there and the transaction rolled back with a 500 on every call. The endpoint shipped marked DONE while being completely non-functional.

**Fix.** Migration `006_drop_email_not_null.sql` drops the NOT NULL. `UNIQUE` is kept and still meaningful for live accounts, because Postgres permits any number of NULLs under a unique constraint, and a deleted account no longer occupies its email.

### Bug 2. The digest never reflects "since you were away" (high): FIXED

Had three independent causes; all three had to be fixed for the digest to mean anything.

1. **Nothing wrote `room_members.last_seen_at`.** It equalled the join time forever, so `getRoomDigest` reported everything since joining. Added `POST /rooms/:roomId/seen` (`markRoomSeen`), plus a stamp on the socket's `leave-room`. This is now the only writer of that column.
2. **`getUserDigest` built a `lastSeenMap` and never used it.** Its decisions, tasks, mentions and files queries had no time filter, so it returned the newest 50 of everything regardless of what had been seen. Each query now joins `room_members` on `(room_id, user_id)` and filters against that row's own `last_seen_at`. Per-room rather than one shared timestamp is deliberate: a user who read #design-crit this morning but not #marketing since last week must see the marketing backlog and not the design one. The dead `lastSeenMap` is gone.
3. **The activity query used a correlated `MAX(last_seen_at)` subquery** and stamped every activity item with `new Date().toISOString()`, so all room activity always sorted to the top. It now joins `room_members` like the others and carries `MAX(created_at)` through as `last_activity_at`.

**Also.** Digest items in both endpoints now carry `room_id` and `room_name` as real fields rather than only a formatted `metadata` string, so the client can deep-link to the originating room.

### Bug 3. Room types `public` and `private` cannot be created (medium): FIXED

- `VALID_TYPES` now covers all five types named in the schema comment, so the Hash and Lock icons in `RoomList.jsx` can appear with real data.
- DMs are deduped: `createRoom` looks for an existing 2-member DM between the pair and returns it with `existing: true` instead of minting another.
- Invitees are resolved before the room is inserted. An unknown `memberId` previously reached the INSERT and surfaced as a foreign-key 500; it is now a 400 naming the offender. Soft-deleted users are rejected here too.
- `memberIds` go in as a single `INSERT ... SELECT unnest($1::uuid[])` instead of one query per member in a loop.
- The response `members` array is read back from the database, matching the shape `getRoom` returns. It used to be built from the request body, so it could advertise members that `ON CONFLICT` had skipped.
- `memberIds` is validated as an array of UUIDs.

**Deferred.** The `rooms.type` comment is still not backed by a CHECK constraint. Adding one needs validating against real data, and no database was available, so it is left as a follow-up.

### Bug 4. Decisions response has no `room_slug` (medium): NEEDS DECISION

`Decisions.jsx` renders `#{decision.room_slug}`. The backend returns `room_name` only, and `rooms` has no slug column, so real data renders `#undefined`. Either add a `slug` column to `rooms` (with a migration and backfill) or have the client render `room_name`.

**Still open — this is a product call, not a bug fix.** A slug is a real schema addition with backfill and uniqueness rules; changing the client to render `room_name` is a one-line change. Decide which before building the page. This is the only audit bug left unaddressed.

### Bug 5. Decision search is limited and inconsistent (medium): FIXED

- `searchDecisions` is now mounted at `GET /decisions/search?q=` for the cross-room page, and the handler serves both routes, room-scoped when `:roomId` is present.
- Tags are actually searched. The comment claimed "title, body, tags" but both the GIN index and the query covered only title and body. Migration `007_decisions_search_includes_tags.sql` rebuilds `idx_decisions_search` over all three, and the query uses the identical expression so the index is used.
- `listDecisions` takes `?before=<ISO>` and returns `nextCursor`, the same shape `listMessages` uses. The hard `LIMIT 50` with no cursor made older decisions unreachable.

### Bug 6. Attachment shape differs between endpoints (medium): FIXED

`createMessage` returned raw rows as `{ id, filename, file_url, file_type, size_bytes }` while `listMessages` returns `{ id, filename, size, mime_type, url }`. The service now maps its output through `serializeAttachment`, so history and live socket messages agree.

**On the mixed convention.** `file_type` is commented in the schema as a category (`image | video | pdf | doc | xlsx | zip | other`), but the client-supplied `mime_type` is what gets stored there. That was left as-is deliberately: the frontend fixtures use real mime types (`application/pdf`), and the query aliases `file_type` to `mime_type`, so the current behaviour is what the client expects. The schema comment is the stale part, and correcting it is a comment-only change to ship with a future migration.

### Bug 7. Deleted messages are not hidden, and there is no edit or delete API (medium): PARTIAL

- **Fixed:** `listMessages` now withholds the content of soft-deleted messages and sets `is_deleted` so the client can render a tombstone, while keeping the row in the timeline so replies and ordering hold. `searchMessages` excludes deleted rows outright, so a search can never surface retracted content.
- **Also fixed (not in the original list):** `searchMessages` had no attachments aggregate at all, so search results silently dropped the file card that `listMessages` shows. Same class of bug as item 3, one function over.
- **Still open:** there are no endpoints for edit or delete, even though `edited_at` and `deleted_at` are in every payload, and `message_reactions` has a table but no routes. See item I.

### Bug 8. `createMessage` rejects attachment-only messages (medium): FIXED

- Content is now optional when attachments are present, so the file-only message in the preview fixtures can be sent. A message that is empty in both senses is still a 400.
- Attachments are now validated: `filename`, `url` and `mime_type` are required, `size` must be a positive integer, capped at 25MB and 10 files per message.

**Known limitation.** `url` is still client-supplied, so this validates shape, not provenance. The service should take URLs from the upload endpoint's records instead. That is not possible until the upload endpoint exists (item C); the code carries a comment saying so.

### Bug 9. Mention matching is unreliable (medium): FIXED (still a stopgap)

Was `content ILIKE '%@' || display_name || '%'`, which had three problems: `%` and `_` in a display name acted as wildcards, a user named "Al" matched "@Alice", and names with spaces only matched if typed in full.

Now matches a regex-escaped display name with an explicit non-word boundary after it, via the `mentionPattern` helper. "Al" no longer matches "@Alice", and metacharacters in a name are inert.

**Still a stopgap.** This is text matching and cannot be correct — a display name is not an identity, and renaming a user changes who gets mentioned. The `message_mentions` table (item H) is the real fix.

### Bug 10. `migrate.js` is not re-runnable (medium): FIXED

It applied every `.sql` file on every run with no tracking, so running it against an existing database failed on `001_init.sql`. It now records applied filenames in `schema_migrations`, skips them, and wraps each file in its own transaction so one bad migration names itself instead of rolling back the whole batch.

**Baseline is explicit, not guessed.** A database that predates the tracking table has no record of what ran, so auto-baselining could skip a migration that never actually ran. Instead there is a one-time `node backend/database/migrate.js --baseline` that records files without executing them and says so on stdout. Anyone with a database from before this change needs to run it once, after confirming which of 001–005 are genuinely applied.

### Bug 11. Auth hardening gaps (medium): MOSTLY FIXED

**Fixed.**

- Server-side validation for email format and password length. The only password rule was `minLength="8"` in the client form, so any client could register a one-character password.
- Passwords over 72 bytes are rejected; bcrypt only reads the first 72 and silently discards the rest, so a long passphrase was not fully protected.
- Emails normalised with `lower(trim(...))` and compared on `lower(email)`, so `A@x.com` and `a@x.com` can no longer both register. Comparing `lower(email)` rather than the raw column means rows written before normalisation still match.
- `login` and `register` return the same user shape; they previously disagreed on `avatar_url` and `bio`.
- `login` gives the same 401 for a missing account, a soft-deleted account, and a wrong password, so it is not a user-enumeration oracle.
- Refresh tokens are **rotated**: the presented token is revoked and a replacement issued in one transaction, with `FOR UPDATE` so concurrent refreshes of the same token cannot both win. A stolen refresh token is now single-use rather than valid for 7 days.
- Refresh expiry derives from `JWT_REFRESH_EXPIRES_IN` instead of a hardcoded `INTERVAL '7 days'` that could disagree with the token itself.

> **Client contract change.** `POST /auth/refresh` now returns a `refreshToken` alongside `accessToken`, and clients must persist it. The client has no 401 interceptor yet (the TODO in `client/src/lib/api.js`), so nothing calls refresh today and this is not yet live — but whoever adds that interceptor must call `saveSession()` with the new token, or the user will be signed out on the following refresh.

**Deferred, both needing a decision rather than a patch.**

- No rate limiting on `/auth/*`. Needs a dependency choice (`express-rate-limit` vs. hand-rolled on Redis).
- Registration is fully open while the login screen says "Conclave is invite-only", and `role_id` is never checked anywhere. Gating this is item G, a product decision.

### Bug 12. `.env` is included in the project archive (medium): VERIFIED, nothing to fix in code

Confirmed checked: `backend/.env` was **never committed** to git (`git log --all -- backend/.env` is empty) and `.env` is in `.gitignore`. Nothing real leaked — the archived copy matched `.env.example` with placeholder secrets and empty Cloudinary keys.

The remaining risk is process, not code: do not include `.env` in future shared archives, and confirm this was never committed on any other branch or in the zip you still hold.

### Bug 13. Socket handler gaps (low to medium): MOSTLY FIXED

**Fixed.**

- `message-read`, `typing` and `stop-typing` relayed to any `roomId` the client named without checking membership, so a user could spoof read receipts and typing indicators into rooms they are not in. All three now verify membership. `send-message` was already covered by `createMessage`.
- Errors were emitted on `error`, which Socket.IO reserves for its own internals. Renamed to `error:message`. No client listens for it today, so nothing breaks.
- Presence is per user, so closing one of two tabs broadcast `user-offline` while the user was still connected, and tore down their presence state. Sockets are now counted per user and presence is only torn down when the last one closes.
- `cleanupUserFromRooms`, `getTypingUsers` and `cleanupUserTyping` all used `KEYS`, which is O(N) across the whole keyspace and blocks the single-threaded server while it runs. Pattern lookups now use `SCAN`, and a new `user:{userId}:rooms` set tracks per-user room membership so cleanup is proportional to the rooms that user is actually in.
- `sweepStaleUsers` awaited one `EXISTS` per online user every 30 seconds, a full round trip each. Now pipelined.
- The header advertised `notification`, `upload-progress`, `decision:created` and `task:updated`, none of which are ever emitted. The list now shows only events that exist, with the unimplemented four called out separately.

**Still open.**

- `user-online` and `user-offline` are broadcast to every connected socket, including users who share no room with that person. Scoping these correctly needs a decision about what "online" means globally, so it was not guessed.
- `send-message` does not require the sender to have called `join-room` first. It is safe — `createMessage` authorises — but the message will not reach recipients who never joined.
- `message-read` still only broadcasts; nothing is persisted.
- Presence is still per user rather than per connection for the `online_users` set itself, which now disagrees slightly with the socket count. Consistent enough for the UI, worth revisiting if presence gets more precise.

### Bug 14. Error handling and response utils are inconsistent (low): FIXED

- `error.middleware.js` builds every response through `fail()` now, so the error shape can no longer drift from `ok()`'s counterpart.
- Postgres SQLSTATEs are translated: `22P02` → 400, `23503` → 400, `23505` → 409, `23502`/`23514`/`22001` → 400. A malformed `:roomId` used to surface as an opaque 500.
- Added `validateUuidParams` middleware, wired into every router with an `:...Id` param, so `/rooms/abc` is a 400 with a readable message.
- `MulterError` is handled, so an oversize upload is a 413 rather than a 500.
- Malformed and oversized JSON bodies report as 400/413, and `express.json()` is capped at 1mb (attachments go through multipart).
- The `tasks` and `notifications` stubs returned `200`/`201` with a TODO body, which the client treats as success. They now throw 501.
- Dropped the unused `fail` import from `auth.controller`.

### Bug 15. Smaller correctness issues (low): PARTIAL

**Fixed.**

- `listMessages` paginated on `created_at` alone, so two messages sharing a timestamp could be skipped at a page boundary. The cursor is now `"<created_at>|<id>"` compared as a tuple, with a bare timestamp still accepted so older clients keep working. `nextCursor` remains an opaque string, which is all the client treats it as today.
- `listUsers` filters `deleted_at IS NULL`, but `addMember` did not, so a soft-deleted user could be added to a room and appear as "Deleted user". `addMember` now filters on `deleted_at IS NULL`.
- `updateProfile` accepted an unbounded `avatar_url` or `bio`. Added per-field limits (display_name 100, avatar_url 2048, bio 1000).

**Still open.**

- `listUsers` lets any authenticated user list every user with their email. Consider scoping to shared rooms or hiding the address. This is a product/privacy call.
- `addMember` reads the room and caller role in one query, then inserts in a separate transaction, so there is a small race window. It also creates a notification but never emits it on the socket — that needs the notification event from item B.
- `getRoom` builds the member list for the whole room with no cap.
- `listMessages` uses `LEFT JOIN attachments` with a `GROUP BY` over every message column. It works, but a lateral subquery would be simpler and faster.
- `Dockerfile` and `docker-compose.yml` only cover Postgres and Redis; the backend service is not in the compose file.
- `package.json` name is `platform-backend` and compose uses `platform_dev`, leftovers from the template.
- Prettier: `messages.controller.js` and `rooms.controller.js` use double quotes while the rest of the backend uses single quotes. Not normalised — pick one and enforce it.

---

## Remaining work (features the frontend needs)

Ordered by what blocks the most.

### A. Tasks endpoints (OPEN, blocks the Tasks page and the digest)

`tasks.controller.js` has three stubs: `createTask`, `listTasks`, `updateTaskStatus`. They now throw 501 rather than returning a fake success, but nothing is implemented. The Tasks page shows To do, In progress and Done columns with assignee and due date.

Needed:

- `POST /tasks` with `roomId`, `title`, `assigneeId?`, `dueDate?`, `sourceMessageId?`, with a membership check and a check that the assignee is a room member.
- `GET /tasks` (cross-room, mine or all, filter by status) since the page is top-level, plus keep `GET /tasks/room/:roomId`. Return `assignee_name`, `room_name` and `due_date`.
- `PATCH /tasks/:taskId/status` limited to `open | in_progress | done`, updating `updated_at`, and emitting `task:updated` to the room.
- A notification for the assignee when a task is assigned.

Also note the digest's task query filters on `rm.last_seen_at`, which now works, so tasks will start appearing in digests once this lands.

### B. Notifications endpoints (OPEN, blocks the bell and the Notifications page)

- `GET /notifications` newest first with pagination, plus an unread count.
- `PATCH /notifications/seen` for one or all.
- The table stores `type` and `reference_id` only. The list needs a join or a resolver so the client gets readable text (room name, sender name) without a second request.
- Create notifications for `new_message` and `mention` (only `room_invite` exists today), and emit `notification` on the socket.

`addMember` already writes a `room_invite` row but never emits it, so this is the natural place to close that loop.

### C. File upload (OPEN, blocks the composer's attach button)

`upload.controller.js` is a stub and now throws 501. Multer is wired with a 25 MB memory limit, and Cloudinary config exists but `.env` has empty keys.

Needed:

- Stream `req.file.buffer` to `cloudinary.uploader.upload_stream` with `resource_type: 'auto'`.
- Return `{ filename, url, mime_type, size }` in the same shape `createMessage` expects and `listMessages` returns.
- Validate an allowlist of mime types and reject oversized files with a clear 413.
- Optional: emit `upload-progress` for large files.

**Already done ahead of this item:** oversize uploads are now a 413 rather than a 500, because the error middleware handles `MulterError` (was Bug 14). Malformed JSON bodies are a 400 too.

**Still open after this item:** `createMessage` still trusts the client-supplied attachment `url`. Once upload exists, the service should look the URL up from the upload record instead of accepting it from the request (noted in Bug 8).

### D. Home page data (OPEN)

The Home page shows unread messages, new decisions, tasks due, and a recent activity feed. Nothing supplies them.

Needed: either `GET /home/summary` or add `unread_count` to `listRooms` (messages after `last_seen_at`), plus counts for decisions and tasks due.

**Unblocked:** this depended on Bug 2, which is fixed. `room_members.last_seen_at` now actually moves, so "messages since last seen" is meaningful. Note that the client needs to start calling `POST /rooms/:roomId/seen` for the window to close at all.

### E. Global search (OPEN)

The Navbar has a search icon. Per-room message search and per-room decision search exist, and decision search is now also available cross-room at `GET /decisions/search?q=`. Still missing: a single `GET /search?q=` spanning messages and decisions across rooms, or a decision to make the icon open per-room search only.

### F. Rooms management (OPEN)

Missing: update room name, leave room, remove member, delete room, and promote member to admin. Also missing: find or create DM by user id (`POST /rooms/dm { userId }`), which the `/dms` screen needs.

`createRoom` now returns an existing DM rather than duplicating one, but there is still no way to *find* one by user id without creating it.

### G. Invites (OPEN)

The sidebar has an "Invite members" link and the login copy says invite-only. Decide the model (invite links, email invites, or admin-created accounts) and add endpoints, then close registration or gate it by invite token.

This is also the open half of Bug 11 — registration is fully open today while the login screen claims otherwise, and `role_id` is still never checked.

### H. Structured mentions (OPEN)

Add a `message_mentions(message_id, user_id)` table, parse `@` mentions at send time from a client-supplied `mentionedUserIds`, and use it for both the digest and `mention` notifications. This replaces the regex stopgap in Bug 9, which is correct but still text matching — a display name is not an identity, and renaming a user changes who gets mentioned.

### I. Message edit, delete and reactions (OPEN)

The payloads already include `edited_at`, `deleted_at`, and there is a `message_reactions` table. Add `PATCH /messages/:id`, `DELETE /messages/:id` (soft delete, author or room admin), and reaction add/remove, with socket events so open clients update live.

**Partly ready:** the read side already handles soft-deleted rows correctly (Bug 7) — `listMessages` withholds the body and sets `is_deleted`, and `searchMessages` excludes them. So once the delete endpoint exists, it will behave. The client needs to render the tombstone.

### J. Tests and docs (OPEN)

- **There are no tests, and this is now the biggest risk on this list.** The bug fixes on `fix/backend-audit-bugs` are syntax-checked and module-loaded but no SQL was executed, because Docker was unavailable. Everything should be exercised against a real Postgres before merge. Start with auth, room membership checks, message create/list, and the digest queries.
- `docs/API_CONTRACTS.md` still lists finished routes as TODO. Update it with every route above, including request bodies and response shapes.
- Add the frontend token refresh: `client/src/lib/api.js` has a TODO for a 401 interceptor calling `POST /auth/refresh`. Without it users are signed out every 15 minutes. The backend endpoint is ready — but note it now returns a rotated `refreshToken` that the interceptor must persist (see Bug 11).
- The client should call `POST /rooms/:roomId/seen` when a room is opened, otherwise digests keep showing everything.

---

## Working agreement

- Branch and open a PR rather than pushing to `main`.
- **Don't change `useMessages` or `useRoom` signatures without telling everyone.** The frontend is built against them. If a signature needs to change, that's a conversation first.
- Use the response helpers in `utils/apiResponse.js` (`ok` and `fail`) for every backend response. Do not hand-build response JSON in controllers or middleware.
- Formatting: an editor reformatted two whole files on a recent commit (single to double quotes, object expansion), turning a 4-line fix into a 172-line diff. Check the Prettier config against the repo's. `messages.controller.js` and `rooms.controller.js` currently use double quotes while the rest of the backend uses single quotes, so pick one and enforce it.
- Any new table or column ships as a numbered migration in `backend/database/migrations/`, never as an edit to an earlier file.
- Never edit `client/` from a backend task without saying so first.
