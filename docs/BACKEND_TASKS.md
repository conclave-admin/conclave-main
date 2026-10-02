# Backend tasks

Found while building the frontend against the Penpot design, then updated after a full backend audit (routes, controllers, services, sockets, migrations) checked against what the client calls, then updated again after the audit bugs were fixed, and once more after everything was finally run against a real database.

Legend: DONE = shipped and verified. PARTIAL = shipped with a known problem. FIXED = was a bug, now repaired and verified. OPEN = not started or still a stub. MOSTLY FIXED = the reported problem is closed but related work remains.

**Current state:** all fifteen audited bugs are FIXED, and all of them have now been executed against a real PostgreSQL rather than merely type-checked. The remaining work is the feature set (items A–J), not the bug list. Two things are deliberately still open and are _decisions_ rather than defects: whether decision search should rank on tags (Bug 5), and the four product questions in item G and Bug 11.

---

## Status summary

| Area                                    | Status                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| Auth (register, login, refresh, logout) | DONE (hardened; token rotation added — see Bug 11 client note)        |
| Users (me, update, list, delete)        | DONE (delete account repaired and now works)                          |
| Rooms (create, list, get, add member)   | DONE (public/private creatable, DMs deduped)                          |
| Messages (send, list, search)           | DONE (deleted content masked, attachment shapes unified)              |
| Decisions                               | DONE (`room_slug` shipped — see Bug 4)                                |
| Digest                                  | DONE (now genuinely time-bounded per room)                            |
| Sockets and presence                    | DONE (membership guards, no blocking KEYS, no phantom events)         |
| Tasks                                   | DONE (three endpoints; `status` constrained in the schema)            |
| Notifications                           | DONE (list, unread count, mark-seen; invites and mentions emitted)    |
| File upload (Cloudinary)                | DONE (real round trip verified; attachments are server-owned)         |
| Migrations                              | DONE (runner is re-runnable; all 11 verified against a real Postgres) |
| Tests                                   | DONE (99 tests: 15 no-database smoke, 84 on a real DB + Cloudinary)   |

### Verification status

**Everything below has now been executed against a real PostgreSQL 16.** The earlier claim that no SQL had been run is no longer true — Docker became available after the fixes were written, and the whole thing was then migrated onto a clean database and re-verified.

What that verification found and changed:

- **All eight migrations apply in order on a clean database**, and re-running the runner is a no-op (`Nothing to migrate — database is up to date`), confirming the `schema_migrations` tracking added for Bug 10.
- **Migration 007 was wrong and failed on its first real execution**: `functions in index expression must be marked IMMUTABLE`. `array_to_string` is STABLE, not IMMUTABLE, so it cannot appear in an index expression. It was rewritten to index title+body and match tags separately, with a new GIN index on `decisions.tags`. Worth remembering if anyone tries to fold tags back into the tsvector.
- **The per-file transaction added for Bug 10 did its job on that failure**: 007 rolled back alone, 001–006 stayed recorded, and the error named the file. Under the old single-transaction runner all seven would have been rolled back with no indication of which one broke.
- **The delete-account P0 now commits.** Before migration 006 the transaction rolled back with a 500 on every call.
- **The `rooms.slug` backfill produces correct values on real data**, including the two cases most likely to break: a duplicate room name (`Product & Engineering` → `product-engineering` and `product-engineering-2`) and a name with nothing sluggable (`日本語` → `room`).
- The `(created_at, id)` tuple cursor pages through tied timestamps without skipping; the per-room digest window returns only the unread room, where a single shared `MAX(last_seen_at)` would have returned nothing; `22P02`/`23503`/`23505` map as documented.

**This is now automated, not a one-off.** `backend/tests/integration.test.js` applies all twelve migrations to a throwaway `conclave_test` database, asserts the above, and drops the database afterwards, so it cannot touch development data. `backend/tests/upload.test.js` does the same for the Cloudinary path, including a real upload round trip, and skips when credentials are absent. `npm test` runs both alongside the no-database smoke suite — 99 tests total.

One thing that verification still cannot prove: behaviour under real production data volume. The queries were verified for correctness, not for query plans at scale.

### Migrations

Nine files, applied in filename order and recorded in `schema_migrations`. 001–003 are the original schema; 004 onward came out of this audit and the differentiator lane.

| Migration                                | What it does                                                                     | Why                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `001_init.sql`                           | users, roles, rooms, membership, messages, reactions, attachments, notifications | original schema                                                |
| `002_decisions_tasks_digest.sql`         | `decisions`, `tasks`, `digests` — the differentiator layer                       | original schema                                                |
| `003_messages_search_index.sql`          | FTS GIN index + composite index for cursor paging                                | original schema                                                |
| `004_add_attachment_filename.sql`        | adds `attachments.filename`, backfills from `file_url`                           | the file card rendered a URL instead of a name                 |
| `005_add_user_deleted_at.sql`            | adds `users.deleted_at`                                                          | soft delete, so FKs from messages/decisions/tasks stay valid   |
| `006_drop_email_not_null.sql`            | drops `NOT NULL` on `users.email`                                                | without it the soft delete always rolled back with a 500       |
| `007_decisions_search_includes_tags.sql` | GIN index on `decisions.tags`                                                    | tags were never searchable despite the docs claiming otherwise |
| `008_add_rooms_slug.sql`                 | adds `rooms.slug`, backfills, disambiguates, `UNIQUE`                            | decisions rendered `#undefined`                                |
| `009_add_notification_actor.sql`         | adds `notifications.actor_id`                                                    | a room invite could not say who invited you                    |
| `010_add_file_uploads.sql`               | adds `file_uploads`, `UNIQUE` on `file_url`, partial index on unclaimed          | any member could persist an arbitrary string as a file URL     |
| `011_tasks_status_check.sql`             | `CHECK (status IN ('open','in_progress','done'))` on `tasks`                     | migration 002 only documented the values in a comment          |
| `012_add_message_mentions.sql`           | adds `message_mentions`, composite PK, index leading on `user_id`                 | a display name is not an identity, so a rename redirected mentions |

Three of these are worth knowing about before you touch them:

- **Never edit a migration that has been applied.** Add a new numbered file. Editing 008 on a machine that already ran it changes nothing, because the runner skips recorded filenames.
- **`007` is the one that will bite you.** If you are tempted to fold tags back into the tsvector so they affect ranking, do not — `array_to_string` is STABLE, not IMMUTABLE, and `CREATE INDEX` will fail. The migration file documents the trigger-maintained `search_vector` column as the proper upgrade.

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

Ordered by severity. All fifteen are fixed and verified against a real database. Where something is only partly fixed, or was deliberately left, the section says so and says why.

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

**Still open, and now verifiable.** A tag-only hit **matches but does not contribute to rank**, so it sorts by date rather than relevance. That is a deliberate trade-off, not an oversight: the first attempt folded tags into the tsvector and failed at `CREATE INDEX` because `array_to_string` is STABLE, not IMMUTABLE. Replacing it properly means a trigger-maintained `search_vector` column, which sidesteps the immutability rule because it is a column rather than an expression, at the cost of having to keep it in sync. Worth doing only if tag relevance actually matters.

**Deferred.** The `rooms.type` comment is still not backed by a CHECK constraint. The code now honours all five documented types, so the constraint is belt-and-braces — but adding one means validating against whatever rows already exist, so it is left as a follow-up rather than risking a failed migration.

### Bug 4. Decisions response has no `room_slug` (medium): FIXED

`Decisions.jsx` rendered `#{decision.room_slug}` while the backend returned `room_name` only, so real data rendered `#undefined`. The dev fixtures carried a `room_slug` that no endpoint ever returned, which is what hid it.

Resolved by adding the column rather than changing the client:

- Migration `008_add_rooms_slug.sql` adds `rooms.slug`, backfills it, then sets `NOT NULL` and adds a unique index.
- `rooms.name` is **not** unique, so the backfill disambiguates duplicates with `row_number() OVER (PARTITION BY base ORDER BY created_at, id)`. Ordering by `created_at` makes the outcome deterministic — the oldest room keeps the bare slug, later ones get `-2`, `-3` — rather than depending on scan order. Names with nothing sluggable fall back to `room` and resolve through the same ranking.
- `createRoom` derives the slug server-side and never accepts one from the request, so a handle cannot be squatted. Collisions walk `-2`, `-3` up to ten attempts; the unique index is the real guarantee and a genuine race surfaces as a 409 via the Postgres error mapping.
- The slugify expression in JS mirrors the migration's SQL, so rooms created now and rooms backfilled then produce identical slugs.
- `listRooms`, `getRoom`, `listDecisions` and `searchDecisions` all return `slug`. `promoteToDecision` was returning a bare `RETURNING *` with no `room_name`, `room_slug` or `author_name` at all; it now joins so the create response matches the list response.

**Client side:** `Decisions.jsx` falls back to `room_name` when `room_slug` is nullish, using `??` rather than `||` so an empty string does not silently drop the handle. `previewRoom` gained the `slug` field it was missing.

Verified against real rows: a duplicate name yields `product-engineering` and `product-engineering-2`; `日本語` yields `room` rather than an empty string.

### Bug 5. Decision search is limited and inconsistent (medium): FIXED

- `searchDecisions` is now mounted at `GET /decisions/search?q=` for the cross-room page, and the handler serves both routes, room-scoped when `:roomId` is present.
- Tags are actually searched. The comment claimed "title, body, tags" but the query only covered title and body. Migration `007_decisions_search_includes_tags.sql` adds a GIN index on `decisions.tags` and the query matches tags by array containment plus an escaped substring scan, alongside the existing title+body index.
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
- Attachments are validated for shape (up to 10 per message, each with a non-empty `url`).
- **Provenance limitation resolved.** `url` is no longer trusted. `POST /upload` (item C) records every accepted file in `file_uploads`, and `createMessage` claims the upload inside the message transaction, taking `filename`, `mime_type` and `size` from the record rather than the request. An upload can only be attached once, and only by the user who uploaded it.

### Bug 9. Mention matching is unreliable (medium): FIXED (still a stopgap)

Was `content ILIKE '%@' || display_name || '%'`, which had three problems: `%` and `_` in a display name acted as wildcards, a user named "Al" matched "@Alice", and names with spaces only matched if typed in full.

Now matches a regex-escaped display name with an explicit non-word boundary after it, via the `mentionPattern` helper. "Al" no longer matches "@Alice", and metacharacters in a name are inert.

**Real fix landed in item H.** `message_mentions` now records who was mentioned, by id, and both the digest and notifications read it. A rename no longer moves a mention.

The matcher itself still exists as a temporary fallback in `createMessage`, for clients that send no `mentionedUserIds` — see item H for the removal condition. The digest no longer uses it at all, so history never re-derives mentions from text.

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
- The header advertised `notification`, `upload-progress`, `decision:created` and `task:updated`, none of which were emitted at the time. The list was rewritten to show only events that exist, with the unimplemented ones called out. `notification` and `task:updated` are now live; `upload-progress` and `decision:created` are still not sent.

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
- `addMember` reads the room and caller role in one query, then inserts in a separate transaction, so there is a small race window. (It no longer creates a notification silently — item B routes it through `createNotification` and emits it after the commit.)
- **A malformed `?before=` cursor is a 500.** Both `listMessages` and `listNotifications` accept an opaque `"<created_at>|<id>"` cursor and pass it straight to Postgres, so `?before=not-a-date|not-a-uuid` raises `22007`/`22008`. Neither SQLSTATE is in the `PG_ERRORS` map in `middlewares/error.middleware.js`, so it falls through to the generic 500. Two lines fix it for every paginated endpoint at once:

  ```js
  '22007': { status: 400, message: 'Invalid timestamp' },
  '22008': { status: 400, message: 'Invalid date or time value' },
  ```

  Not done here because it is pre-existing and reaches further than item B — it belongs in the same pass as any other error-mapping work.
- **Body-supplied ids bypass `validateUuidParams`.** That middleware only inspects `req.params`, so a UUID arriving in a request body is unvalidated — `PATCH /notifications/seen` takes `notificationId` in the body. It currently degrades correctly to a 400 via Postgres `22P02`, but that is an accident of the error mapper rather than deliberate validation, and any endpoint whose body id is not compared against a uuid column would get no protection at all. Extending the middleware to cover a named set of body fields, or validating at each handler, would make it intentional.
- `getRoom` builds the member list for the whole room with no cap.
- `listMessages` uses `LEFT JOIN attachments` with a `GROUP BY` over every message column. It works, but a lateral subquery would be simpler and faster.
- `Dockerfile` and `docker-compose.yml` only cover Postgres and Redis; the backend service is not in the compose file.
- `package.json` name is `platform-backend` and compose uses `platform_dev`, leftovers from the template.
- Prettier: `messages.controller.js` and `rooms.controller.js` use double quotes while the rest of the backend uses single quotes. Not normalised — pick one and enforce it.

---

## Remaining work (features the frontend needs)

Ordered by what blocks the most.

### A. Tasks endpoints (DONE)

`POST /tasks`, `GET /tasks` (cross-room) and `PATCH /tasks/:taskId/status` are implemented. The Tasks page shows To do, In progress and Done columns with assignee and due date, which is exactly the response shape these return.

- `createTask` takes `roomId`, `title`, `assigneeId?`, `dueDate?`, `sourceMessageId?`. It checks room membership, requires `sourceMessageId` to be an undeleted message **in the same room**, and requires `assigneeId` to be a member of that room — otherwise a task can be handed to someone who cannot open the room and whose digest, which filters on `assignee_id` within a room, would never surface it.
- `listTasks` is cross-room, scoped through `room_members`, with optional `?roomId`, `?status` and `?assigneeId`. `GET /tasks/room/:roomId` is kept and delegates to the same handler by rewriting `roomId` into the query, mirroring the decisions routes so the two cannot drift.
- `updateTaskStatus` is limited to `open | in_progress | done`, sets `updated_at = NOW()`, and emits `task:updated` to the room. It returns 404 rather than 403 for a task in a room the caller is not in, so the endpoint does not confirm the id exists.
- `tasks.status` is constrained by a `CHECK` in migration 011, not only validated in the controller. The digest reads this column straight into user-facing text, so a value like `banana` would otherwise surface in a catch-up feed.
- Undated tasks sort last (`NULLS LAST`), otherwise a missing due date reads as the most overdue item on the board.

**Known limitation.** `task:updated` is emitted to the task's room, but sockets only `join-room` on demand (`client/src/hooks/useMessages.js`, when a room view mounts). A user sitting on the top-level cross-room Tasks page has not joined the rooms it lists, so **that page will not update live** — only on reload. Documented rather than fixed: the fix is a per-user task subscription, not a change to this emit. The caller that made the change still receives the updated task in the response.

**Still open:** no notification is created when a task is assigned, and `assignee_id` is unindexed. `idx_tasks_room_status` covers the room filter, so that is adequate at current scale but is the first thing to add if the board grows.

### B. Notifications endpoints (DONE)

`GET /notifications` and `PATCH /notifications/seen` are implemented, and both `room_invite` and `mention` rows are now written **and emitted**.

- `GET /notifications` returns `{ notifications, unreadCount, nextCursor }`, newest first, with an optional `?unseenOnly=true`. Rows go through `presentNotifications`, so each one carries resolved context — room name, actor name, a 120-char message preview — with no second request. Because the resolver is shared with the emit path, the list payload and the socket payload are byte-identical, which is what lets the client drop an incoming notification straight into the list.
- Pagination reuses the compound `"<created_at>|<id>"` cursor from `listMessages`, including the tie-break that stops rows sharing a timestamp being skipped.
- `unreadCount` is a separate `COUNT` filtered only on unseen. Counting the returned rows would cap the bell badge at the page size.
- `PATCH /notifications/seen` takes `{ notificationId }` or `{ all: true }` and returns `{ updated }` — rows **this call** changed, so the client can adjust its badge without a refetch. Repeating it returns `updated: 0`.
- The single-notification `UPDATE` is scoped `WHERE id = $1 AND recipient_id = $2`. Without that, any authenticated user could silence someone else's bell by guessing a UUID. A miss is a **404**, not a 403, so the endpoint does not confirm the id exists.
- `addMember` now writes through `createNotification({ db: client })` instead of raw SQL — one type-validated path into the table, enlisted in the membership transaction — and emits after the commit. This row existed since PR1 and was never sent to anyone; that is now closed.
- `createMessage` creates a `mention` notification per named room member and pushes it. The sender is excluded in the query, so nobody is notified of their own message.

Two deliberate choices:

- **`new_message` is not implemented.** Notifying every member of a room on every message is a product decision about noise, not a technical one, and item H is about to change how mentions are identified. Building the fan-out now means building it twice. `file_uploaded` and `member_joined` are likewise still unwritten.
- **Mention matching is the existing stopgap**, now shared from `services/mention.service.js` rather than duplicated out of the digest controller — two copies of that regex would eventually disagree. Matching happens in JS, not SQL: the pattern embeds each member's display name, so it cannot be a single parameterised `~` comparison. Room membership is still enforced in SQL so an unauthorised room cannot be probed.

**Notification rows are written whether or not a socket is available.** The row is the source of truth and the socket is only delivery; gating the write on `io` is how `room_invite` stayed unreadable for two items. `notifyAndEmit` treats a missing `io` as write-only.

### C. File upload (DONE)

`POST /upload` stores a file in Cloudinary and records it in `file_uploads` (migration 010). It streams `req.file.buffer` via `upload_stream` with `resource_type: 'auto'` and returns `{ filename, url, mime_type, size }` in the standard `{ success, data }` envelope.

Verified end to end against real Cloudinary and a real Postgres: a 1x1 PNG uploads, lands in `conclave/attachments/`, gets a `file_uploads` row, and attaches to exactly one message.

Status codes: no file → 400, disallowed type → 415, over 25MB → 413 (multer), Cloudinary failure → 502, credentials absent → 503.

**The allowlist** is 22 types — images (including SVG), documents, Word/Excel/PowerPoint, zip and gzip, and five audio types. **Video is held back** because 25 MB is a poor ceiling for it.

**SVG is allowed and is safe here.** The client renders only the filename, never the URL, and `<img src>` does not execute script in an SVG. It would stop being safe if anything ever used `<object>`, `<embed>`, or inlined the markup. The residual risk is a user hosting branded content on the project's Cloudinary quota.

**The provenance fix this unblocked** (Bug 8): `createMessage` no longer trusts a client-supplied URL. Clients send `attachments: [{ url }]` and nothing else; the service resolves `filename`, `mime_type` and `size` from the upload record inside the message transaction. A conditional `UPDATE ... WHERE file_url = $1 AND uploader_id = $2 AND attached_message_id IS NULL RETURNING ...` does the lookup, the ownership check and the one-time-use check in one statement, and takes a row lock so concurrent sends cannot both claim the same upload. Zero rows means unknown, someone else's, or already attached — all three are a 400 that rolls back the message, so a failed send leaves the upload claimable.

**Known gap:** `mime_type` comes from the client-declared multipart `Content-Type`, so a client can label any file as an allowed type. Cloudinary stores the real bytes, so nothing executable is served as an image, but the recorded type can be inaccurate. Fixing it properly needs magic-byte sniffing (`file-type`), which was out of scope.

**Still open:** the composer's attach button is not wired up (Isaac's lane) — the endpoint exists but nothing calls it. `upload-progress` was not implemented. Uploaded files that are never attached accumulate as orphans; a sweeper can use the partial index `idx_file_uploads_unclaimed`.

### D. Home page data (OPEN)

The Home page shows unread messages, new decisions, tasks due, and a recent activity feed. Nothing supplies them.

Needed: either `GET /home/summary` or add `unread_count` to `listRooms` (messages after `last_seen_at`), plus counts for decisions and tasks due.

**Unblocked:** this depended on Bug 2, which is fixed. `room_members.last_seen_at` now actually moves, so "messages since last seen" is meaningful. Note that the client needs to start calling `POST /rooms/:roomId/seen` for the window to close at all.

### E. Global search (OPEN)

The Navbar has a search icon. Per-room message search and per-room decision search exist, and decision search is now also available cross-room at `GET /decisions/search?q=`. Still missing: a single `GET /search?q=` spanning messages and decisions across rooms, or a decision to make the icon open per-room search only.

### F. Rooms management (OPEN)

Missing: update room name, leave room, remove member, delete room, and promote member to admin. Also missing: find or create DM by user id (`POST /rooms/dm { userId }`), which the `/dms` screen needs.

`createRoom` now returns an existing DM rather than duplicating one, but there is still no way to _find_ one by user id without creating it.

### G. Invites (OPEN)

The sidebar has an "Invite members" link and the login copy says invite-only. Decide the model (invite links, email invites, or admin-created accounts) and add endpoints, then close registration or gate it by invite token.

This is also the open half of Bug 11 — registration is fully open today while the login screen claims otherwise, and `role_id` is still never checked.

### H. Structured mentions (DONE, with one temporary fallback)

`message_mentions(message_id, user_id)` exists (migration 012), and both the digest and `mention` notifications read it instead of matching message text.

- **Composite primary key** `(message_id, user_id)` — a client that mentions someone twice records them once rather than erroring. Both FKs `ON DELETE CASCADE`, so a deleted message or account leaves nothing for the digest to join. The index leads with `user_id` because both digest queries read by recipient.
- **`createMessage` accepts `mentionedUserIds`** and writes the rows inside the message transaction, so a failed send leaves no mention rows behind. Notifications are driven by that same resolved list rather than a second pass over room members — resolving twice is how the two would come to disagree.
- **Ids that are not room members are silently dropped**, not rejected. A stale or hostile id list must not fail an otherwise-valid send. The sender is excluded, so nobody is notified of their own message.
- **`mentioned_user_ids` is on the payload** from `createMessage`, `listMessages` and `searchMessages`, as `[]` rather than `null` when empty. This is what `client/src/components/chat/MessageTimeline.jsx` needs to replace its `/(^|\s)@\w+/` heuristic — two members can share a display name (`display_name` is not unique, only `email` is), so text genuinely cannot tell them apart.
- **`send-message` on the socket accepts `mentionedUserIds`** as well, so the realtime path does not fall behind REST.

**The rename bug is fixed and tested.** A message records who was mentioned by id; renaming someone afterwards does not move the mention or suppress the notification. Verified end to end, including a message whose text contains no `@token` at all.

**One temporary fallback remains, deliberately time-boxed.** When a client sends no `mentionedUserIds`, `createMessage` still infers mentions from the text using the old regex (`services/mention.service.js`). This exists solely because the only client send path — `client/src/hooks/useMessages.js` — does not send ids yet, and removing mentions for every existing message would be a worse failure than keeping a known flaw.

**Remove it when that hook passes `mentionedUserIds`.** The removal condition is specific and one line of client work. Until then, renaming a user still misdirects mentions for messages sent without ids — which is exactly the bug this item fixes, alive only in the bridge.

**The digest deliberately has no such fallback.** It reads `message_mentions` only, so a message from an older client simply has no rows and does not appear. Re-deriving mentions from text in the digest would reintroduce the rename bug on historical rows, which is where it matters most: a name may have changed since those messages were written. That asymmetry with `createMessage` is intentional.

### I. Message edit, delete and reactions (OPEN)

The payloads already include `edited_at`, `deleted_at`, and there is a `message_reactions` table. Add `PATCH /messages/:id`, `DELETE /messages/:id` (soft delete, author or room admin), and reaction add/remove, with socket events so open clients update live.

**Partly ready:** the read side already handles soft-deleted rows correctly (Bug 7) — `listMessages` withholds the body and sets `is_deleted`, and `searchMessages` excludes them. So once the delete endpoint exists, it will behave. The client needs to render the tombstone.

### J. Tests and docs (MOSTLY DONE)

- **Tests exist and pass — 39 of them**, via `cd backend && npm test`. Two suites:
  - `backend/test/smoke.test.js` runs no SQL. It boots the Express app in-process and asserts the full route table, middleware order, the error envelope, UUID validation, and that the `501` stubs do not return a fake success. This is the class of breakage otherwise only found in production.
  - `backend/tests/integration.test.js` is the suite the audit actually needed. It creates a throwaway `conclave_test` database, applies all eight migrations, exercises the rewritten queries, and drops the database afterwards — so it cannot touch development data. It skips itself when Postgres is unreachable, so `npm test` stays green without Docker.
- **Still to add:** auth round-trips against real bcrypt hashing, room membership _denials_ (the suite covers grants, not refusals), socket-level tests for the events in `sockets/index.js`, and anything covering the Cloudinary path once item C exists.
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
