# API Contracts

Base URL: `http://localhost:7000/api`
Auth: `Authorization: Bearer <accessToken>` on protected routes. Public health,
auth, and push configuration routes have their own rules; push renewal uses a
scoped credential as documented below.

Every response uses the same envelope, from `utils/apiResponse.js`:

```json
{ "success": true,  "data": { ... } }
{ "success": false, "message": "human readable", "details": null }
```

Status codes follow the error middleware: a malformed `:roomId` is **400** (not
500), a duplicate slug is **409**, a bad foreign key is **400**, and an
unimplemented route is **501** rather than a fake 200.

This is the source of truth the frontend codes against — not documentation
written after the fact. Where a shape is marked ⚠️, read the note before relying
on it.

---

## Recoverable synchronization

`GET /sync?after=<decimal cursor>` returns
`{cursor, reset, changes, hasMore}`. Cursors are opaque decimal strings; retain
their precision. Omit `after` for initial/full reconciliation. Invalid cursors
return 400; expired/future cursors return `reset: true`. A page has up to 200
authorized changes, each with `cursor`, `kind`, `operation`, `entity_id`,
`room_id`, and `user_id`. Changes identify invalidated state and contain no body.
Fetch current authorized state before persisting the returned cursor; continue
while `hasMore` is true. Repeated changes and socket hints are safe to replay.

`GET /messages/room/:roomId?ids=<comma-separated UUIDs>` returns
`{messages, missingIds, nextCursor: null}` from an atomic per-viewer snapshot.
Supply 1–200 IDs without another paging parameter. Current membership is required
(403 after removal). Missing IDs are authoritative removals for this room.
Message `sync_version` orders body/related-state updates; `sender_profile_version`
separately orders sender metadata. Receipt summary versions retain their existing
monotonic semantics. Preserve pending local outbox entries during reconciliation.

`sync:changed {cursor}` on the personal socket channel is an invalidation hint,
not an acknowledgement or message payload. Polling `/sync` recovers missed hints.

## Browser push

| Method | Route | Authorization / result |
| --- | --- | --- |
| GET | `/push/config` | Public; `{configured, publicKey}`; no private key |
| POST | `/push/subscriptions` | Bearer session; `{subscription}`; 201 with binding below |
| DELETE | `/push/subscriptions` | Bearer session; `{endpoint}`; removes caller's endpoint |
| POST | `/push/renew` | `Authorization: PushRenew <renewalToken>`; `{subscription}`; rotates binding credential |

Registration/renewal returns `{subscriptionId, bindingId, renewalToken, publicKey,
sessionExpiresAt}`. Store the scoped renewal credential only for the current
account/session. It cannot read messages or call authenticated APIs. Old tokens
stop working after renewal; expired/revoked sessions cannot renew. Subscriptions
must have a supported HTTPS provider endpoint and valid encryption keys.
Unconfigured delivery returns 503. Registration and renewal are rate limited.

Push payloads contain generic activity and a binding identifier. Current access,
blocking, preferences, unread state, room mute and foreground presence are checked
when dispatching. Notification socket events remain hints: clients refresh the
authoritative list and unread total after delivery/seen events rather than
subtracting `updated` deltas. See [setup and delivery guarantees](SYNC_AND_PUSH.md).

## Health

| Method | Path      | Notes                                         |
| ------ | --------- | --------------------------------------------- |
| GET    | `/health` | Outside `/api`. No auth. → `{ status: 'ok' }` |

## Auth

Registration is open to everyone. Invitations control private-room
collaboration, not account creation. Public rooms can be discovered and joined
by signed-in users; room reads still require membership.

| Method | Path           | Body                               | Returns                               | Notes                                                                                                                                                            |
| ------ | -------------- | ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /auth/register | `{ email, password, displayName }` | `{ user, accessToken, refreshToken }` | Validates email format, password 8–72 bytes. Email is stored lowercased.                                                                                         |
| POST   | /auth/login    | `{ email, password }`              | `{ user, accessToken, refreshToken }` | Case-insensitive on email. Same 401 for unknown, soft-deleted, and wrong password.                                                                               |
| POST   | /auth/refresh  | `{ refreshToken }`                 | `{ accessToken, refreshToken }`       | ⚠️ **Rotates.** The old token is revoked and a new one issued. **You must persist the returned `refreshToken`** or the user is signed out on the _next_ refresh. |
| POST   | /auth/logout   | `{ refreshToken }`                 | `{ message }`                         | Revokes the stable session and all rotated refresh tokens, disconnecting its sockets on every API instance. Unknown tokens also return success; cluster failures return 503.                                                                                          |

⚠️ `user` is the same shape from register and login:
`{ id, email, display_name, avatar_url, bio, created_at }`.

### Durable sessions and realtime access

Access and refresh JWTs contain `sid`, the stable `auth_sessions.id`. Every
protected REST request, socket handshake and inbound socket action checks the
session and account in PostgreSQL. Refresh rotates the token while preserving
`sid`; logout revokes that session across devices sharing its tokens. Other
independent logins remain active. Account deletion revokes all sessions.

- `session:revoked { sessionId? }`: sign out and stop reconnecting.
- `session:expired { sessionId }`: the server disconnects even idle sockets at
  access-token expiry. Refresh the active session and reconnect.
- Handshake error `data.code`: `AUTH_INVALID`, `ACCESS_EXPIRED`,
  `SESSION_REVOKED`, or `AUTH_UNAVAILABLE`. Only temporary failures retry.
- `room:members { roomId, userId, action, actorId, role? }`: `removed` / `left`
  invalidate local room access; `joined` / `role` refresh membership controls.
  Affected users receive changes through their personal channel after eviction.
- `room:resync { roomId }`: rejoin/refetch after a failed removal rolled back.

Room removal holds a database lock until every Redis-adapter peer acknowledges
local socket eviction and presence/typing cleanup completes. Joining and typing
use the same room lock so in-flight actions cannot restore revoked access.
A failed acknowledgement rolls membership back and returns 503.

## Users

| Method | Path      | Body                                       | Returns                              | Notes                                                                                                                                                          |
| ------ | --------- | ------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /users/me | —                                          | user                                 | 404 if soft-deleted.                                                                                                                                           |
| PATCH  | /users/me | any of `display_name`, `avatar_url`, `bio` | user                                 | Whitelist-only. Per-field limits: 100 / 2048 / 1000 chars.                                                                                                     |
| GET    | /users/avatar-url?url=<opaque R2 key> | — | `{ url, expiresAt }` | Authenticated. Signs an image only while it is an active user avatar or a room avatar visible to the caller. |
| DELETE | /users/me | —                                          | `{ message }`                        | **Soft delete.** Anonymises the row, revokes all sessions, removes room memberships. Messages, decisions and tasks are preserved and render as "Deleted user". |
| GET    | /users    | `?q=&page=`                                | `{ users, page, pageSize, hasMore }` | Authenticated directory; searches may match email, but responses never expose email addresses. Soft-deleted users are excluded. |
| GET    | /users/:userId/shared-rooms | — | `{ rooms }` | Lists rooms shared by the caller and target, excluding DMs. Used by the DM info page's “Groups in common” section. |
| GET    | /users/:userId/block | — | `{ blocked }` | Whether the caller has blocked the target. |
| POST   | /users/:userId/block | — | `{ userId, blocked }` | Idempotent. Prevents new and existing direct messages between the pair. |
| DELETE | /users/:userId/block | — | `{ userId, blocked: false }` | Removes the caller's block. |
| POST   | /users/:userId/report | `{ reason, details?, roomId? }` | report | Records an open report. Reasons: `spam`, `harassment`, `inappropriate_content`, `impersonation`, `other`. When `roomId` is supplied, both users must belong to it. |

## Rooms

| Method | Path                   | Body                          | Returns                                 | Notes                                                                                                                                                                                                                               |
| ------ | ---------------------- | ----------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /rooms                 | `{ name, type?, memberIds? }` | room + `members[]`                      | `type` ∈ `dm, group, public, private, department`. Caller becomes admin. A DM between the same pair is **not** duplicated — the existing one is returned with `existing: true`. Slug is derived server-side and cannot be supplied. |
| GET    | /rooms                 | —                             | room[]                                  | Everything the sidebar needs in one round trip. Includes `slug`, `type`, `member_count`, `my_role`, `last_seen_at`, plus **`display_name`** and **`display_avatar`** (a DM returns the *other* member's identity, not the room title; groups return their room photo), **`has_message`**, **`last_message`** and **`unread_count`**. Ordered by last activity, then creation. |
| GET    | /rooms/discover        | `?q=&page=`                   | `{ rooms, page, hasMore }`              | Authenticated directory of public rooms the caller has not joined. Search matches room name or description; page size is 25. |
| POST   | /rooms/:roomId/join    | —                             | `{ roomId, joined, existing }`          | Joins a public room. Idempotent; private rooms return 403. Membership is required before reading messages. |
| GET    | /rooms/:roomId         | —                             | room + `members[]`                      | Membership required. Member profiles include `bio` and `account_created_at` alongside room role, join time, and room-scoped last-seen/read pointers. Email addresses are never included. |
| POST   | /rooms/:roomId/members | `{ userId }`                  | `{ roomId, userId, displayName, role }` | Admin only. 404 if the target is soft-deleted. Writes a `room_invite` notification row but does **not** emit it on the socket.                                                                                                      |
| POST   | /rooms/:roomId/seen    | —                             | `{ roomId, lastSeenAt }`                | **Explicit mark-all-read action only.** Marks existing recipient receipts read and delivered, advances the room pointer, and emits receipt and room-seen updates. Automatic timeline reads use message-read; opening or leaving a room does not mark it all read.                                                            |
| PATCH  | /rooms/:roomId         | `{ name?, description?, avatar_url? }` | room | Admin only; DMs cannot be edited as rooms. Group avatar uploads are selected from the room info page. |
| DELETE | /rooms/:roomId/members/:userId | — | `{ roomId, userId, removed }` | Members may remove themselves to leave. Only admins may remove another member; a room must retain an admin. |
| PATCH  | /rooms/:roomId/members/:userId | `{ role: "admin" | "member" }` | `{ roomId, userId, role }` | Admin only. DMs have no member roles. |

### The chat-list row

`GET /rooms` is the sidebar's only request. Each entry adds:

```jsonc
{
  "display_name": "Zara Okonkwo",   // the OTHER member for type:"dm", else room.name
  "display_avatar": "https://…",    // null for non-DM rooms
  "has_message": true,              // false for a room nobody has spoken in — it still appears
  "last_message": {
    "id": "…",
    "content": "the last thing said",  // null when is_deleted
    "sender_id": "…",
    "sender_name": "…",
    "sender_avatar": null,
    "has_attachment": false,
    "is_deleted": false,
    "created_at": "2026-10-08T14:00:00Z"
  } | null,
  "unread_count": 3
}
```

`unread_count` counts messages beyond the contiguous `last_seen_sequence`
that are neither your own nor tombstones, excluding individually acknowledged
read receipts even when an earlier unread gap remains — a badge pointing at deleted content would open into
nothing. It is computed by the same SQL as `chat:updated`, so a row and its
badge can never disagree.

## Messages

| Method | Path                          | Body                                             | Returns                    | Notes                                                                                                                                                                                                                                                                                                                |
| ------ | ----------------------------- | ------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /messages                     | `{ roomId, clientId?, content?, replyToId?, attachments?, albumId?, mentionedUserIds? }` | message                    | ⚠️ `content` may be **empty if `attachments` is non-empty** — a file-only message is valid. Both empty is a 400. Each message may attach at most one `{ url }` returned by `POST /upload`; a multi-item send creates one message per item and shares a UUID `albumId`. `filename`, `mime_type` and `size` are read from the upload record and any values you send are ignored. `mentionedUserIds[]` is the ids of users the message mentions — see below. |
| GET    | /messages/room/:roomId        | `before?, afterSeq?, around?`                               | `{ messages, nextCursor }` | Newest first. ⚠️ `nextCursor` is an **opaque string** — pass it straight back as `before`. The client uses it to load older history. `around` opens a bounded shared-message context; see below.                                                                                                                                                         |
| GET    | /messages/room/:roomId/search | `?q=`                                            | `{ messages, query }`      | Full-text, room-scoped. Excludes deleted messages. Returns the **same message shape** as `listMessages`, plus a `rank`.                                                                                                                                                                                          |
| GET    | /messages/room/:roomId/media | `kind?, cursor?, limit?, after?` | `{ media, nextCursor }` | Membership required. Bounded shared-file pages; see below. |
| PATCH  | /messages/:messageId          | `{ content }`                                   | message                    | Author only, no time limit. Sets `edited_at`. Empty content is a 400 unless the message has an attachment. Mentions and notifications are **not** affected.                                                                                                                                        |
| DELETE | /messages/:messageId          | —                                                | message                    | Author **or room admin**. Soft delete: sets `deleted_at` and overwrites `content` to NULL. Returns the tombstone (`is_deleted: true`).                                                                                                                                                                   |
| PUT    | /messages/:messageId/reactions | `{ emoji }`                                    | message                    | Idempotent — reacting twice does not stack. `emoji` ∈ `👍 👎 🎉 ✅`; anything else is a 400.                                                                                                                                                                          |
| DELETE | /messages/:messageId/reactions/:emoji | —                                    | message                    | Removes your own reaction. `emoji` must be URL-encoded. Removing an absent reaction succeeds.                                                                                                                                                                          |

“Clear messages for me” is client-side and per signed-in user/device: it hides
messages at or before the local clear time while leaving shared room history
untouched. New messages remain visible.

A message row is:

```json
{
  "id": "uuid",
  "room_id": "uuid",
  "sender_id": "uuid",
  "sender_name": "Amina",
  "sender_avatar": null,
  "content": "text or null",
  "is_deleted": false,
  "reply_to_id": null,
  "edited_at": null,
  "deleted_at": null,
  "created_at": "ISO",
  "attachments": [
    {
      "id": "uuid",
      "filename": "x.pdf",
      "size": 4096,
      "mime_type": "application/pdf",
      "url": "https://…"
    }
  ],
  "mentioned_user_ids": ["uuid"],
  "reactions": [
    { "emoji": "👍", "count": 3, "user_ids": ["uuid", "…"], "reacted": true }
  ]
}
```

⚠️ `reactions` is always an array — `[]` when there are none. It is aggregated in
allowlist order, and `reacted` is **per viewer**: the same message legitimately
reads `reacted: true` for one person and `false` for another. `user_ids` is present
so you can show who reacted without a second request.

⚠️ A soft-deleted message is **kept in the timeline** with `content: null` and
`is_deleted: true`, so ordering and replies hold. Render a tombstone.

⚠️ `mentioned_user_ids` is always an array — `[]` when nobody is mentioned, never
`null`, so you can map over it unconditionally. Use it to style a real mention
rather than regex-matching `content`: `display_name` is **not unique** (only
`email` is), so two members can share a name and text cannot tell them apart.

**Send `mentionedUserIds` when a client mentions somebody.** Only the client knows
who the user picked from autocomplete. Ids that are not members of the room are
silently dropped — the message still sends — and the sender is excluded from their
own mentions.

⚠️ Omitting `mentionedUserIds` currently falls back to inferring mentions from
`content` by display name. **This is temporary** and preserves the old behaviour so
existing clients keep working, but it means renaming a user still misdirects
mentions for messages sent without ids. Send the ids and that stops applying.

The socket `receive-message` event returns this **same shape** — including flat
`sender_name`, and `attachments` as the array above.

## Decisions

| Method | Path                           | Body                                               | Returns                     | Notes                                                                                                              |
| ------ | ------------------------------ | -------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | /decisions                     | `{ roomId, title, body, tags?, sourceMessageId? }` | decision                    | Membership required. Returns the **same shape as the list**, including `room_name`, `room_slug` and `author_name`. |
| GET    | /decisions                     | `?roomId=&before=`                                 | `{ decisions, nextCursor }` | Cross-room by default. Omit `roomId` for every room the caller is in.                                              |
| GET    | /decisions/search              | `?q=`                                              | `{ decisions, query }`      | Cross-room search. ⚠️ A tag-only hit **matches but does not rank** — it sorts by date.                             |
| GET    | /decisions/room/:roomId        | —                                                  | `{ decisions, nextCursor }` | Room-scoped, kept for compatibility.                                                                               |
| GET    | /decisions/room/:roomId/search | `?q=`                                              | `{ decisions, query }`      | Room-scoped search.                                                                                                |

A decision row:

```json
{
  "id": "uuid",
  "room_id": "uuid",
  "room_name": "Product & Engineering",
  "room_slug": "product-eng",
  "source_message_id": null,
  "title": "…",
  "body": "…",
  "tags": ["urgent"],
  "created_by": "uuid",
  "author_name": "Victor",
  "created_at": "ISO"
}
```

## Digest

| Method | Path                 | Returns              | Notes                                                                                                      |
| ------ | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | /digest              | `{ items, summary }` | Cross-room. Each room is filtered by **its own** `last_seen_at`, so one unread room does not hide another. |
| GET    | /digest/room/:roomId | `{ items, summary }` | Room-scoped.                                                                                               |

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "decision | task | mention | file | activity",
      "title": "…",
      "metadata": "… or null",
      "room_id": "uuid",
      "room_name": "Product & Engineering",
      "created_at": "ISO"
    }
  ],
  "summary": { "headline": "5 meaningful updates", "summary": "…" }
}
```

⚠️ `type` is the only display hint the backend sends. The type→label/colour
mapping belongs in the client. **Handle an unknown `type` without throwing** — a
single unrecognised value should not take the page down.

`type: "mention"` items come from the `message_mentions` table, joined by id —
the digest does **not** match message text. A message sent by a client that
omitted `mentionedUserIds` before the structured-mention contract existed has no
mention rows and will not appear here. There is deliberately no text fallback:
re-deriving mentions from `content` would reintroduce the rename bug on historical
rows, where a name may have changed since the message was sent.

## File upload

| Method | Path    | Status | Body             | Returns                              |
| ------ | ------- | ------ | ---------------- | ------------------------------------ |
| POST   | /upload | 201    | multipart `file` | `{ filename, url, mime_type, size, width, height, preview_url }` |

Auth required. 25MB maximum. The response is wrapped in the standard
`{ success, data }` envelope, so read it from `data`.

```json
{
  "success": true,
  "data": {
    "filename": "checklist.pdf",
    "url": "r2://conclave-uploads/conclave/attachments/<opaque-key>",
    "mime_type": "application/pdf",
    "size": 4096
  }
}
```

Errors: **400** no file · **413** over the type-specific limit (25MB, or 50MB
for video) · **415** disallowed type · **502** storage unavailable · **503**
R2 is not configured. Upload bytes are stored server-side in Cloudflare R2; the
opaque `url` is only an attachment claim key. Downloads use the authenticated
attachment proxy, which checks room membership. Existing Cloudinary attachments
continue to use the legacy delivery path.

For image attachments, `GET /attachments/:attachmentId/preview-url` checks room
membership and returns a five-minute HMAC URL for the private image-preview
Worker. The Worker transforms the R2 original into one fixed WebP preview and
checks the token before consulting its edge cache. Legacy and unsupported image
types return `url: null` and continue through the authenticated original path.

**Send only `url` back.** `POST /messages` takes `attachments: [{ url }]` and
resolves `filename`, `mime_type` and `size` from the upload record, so any
metadata you post is ignored. An upload can be attached to **exactly one
message**, by the user who uploaded it — a second use is a 400.

Accepted types: images (`jpeg`, `png`, `gif`, `webp`, `svg`), documents (`pdf`,
plain text, markdown, csv), Word, Excel and PowerPoint (both `.docx`-style and
legacy), `zip`, `gzip`, audio (`mpeg`, `ogg`, `wav`, `webm`, `mp4`) and video
(`mp4`, `webm`, `quicktime`, `3gpp`).

## Tasks

| Method | Path                  | Status | Body / query                                                 | Returns     |
| ------ | --------------------- | ------ | ------------------------------------------------------------ | ----------- |
| POST   | /tasks                | 201    | `{ roomId, title, assigneeId?, dueDate?, sourceMessageId? }` | task        |
| GET    | /tasks                | 200    | `?roomId=`, `?status=`, `?assigneeId=`                       | `{ tasks }` |
| GET    | /tasks/room/:roomId   | 200    | same filters                                                 | `{ tasks }` |
| PATCH  | /tasks/:taskId/status | 200    | `{ status }` ∈ `open \| in_progress \| done`                 | task        |

Auth required. `GET /tasks` is **cross-room** — the Tasks page is top-level — and
scoped to rooms you are a member of. `GET /tasks/room/:roomId` delegates to the
same handler. Every task row has the same shape from all three endpoints:

```json
{
  "id": "uuid",
  "room_id": "uuid",
  "room_name": "Product Engineering",
  "source_message_id": null,
  "title": "Confirm upload limits",
  "assignee_id": "uuid",
  "assignee_name": "Priya",
  "status": "open",
  "due_date": "2026-08-22",
  "created_by": "uuid",
  "created_at": "ISO",
  "updated_at": "ISO"
}
```

`assignee_name` is `null` for an unassigned task — those rows are still returned.
`due_date` is a `YYYY-MM-DD` calendar-date string or null, independent of the
server timezone. Create, list and status-update responses use the same shape.

Ordering is `due_date` ascending with undated tasks **last**, then newest first.

`POST /tasks` requires you to be in the room. `sourceMessageId`, if given, must be
an undeleted message **in that room**, and `assigneeId` must be a member of it —
assigning to a non-member produces a task that assignee can never see, since their
digest filters on `assignee_id` within a room they cannot open.

`PATCH` returns **404** for a task in a room you are not in, rather than 403, so
it does not confirm the id exists.

Creating or updating a task emits **`task:updated`** to the task's room.

⚠️ That event only reaches sockets that have joined that room, and joining is
on-demand — so the **top-level cross-room Tasks page will not update live**, only
on reload. The response body carries the updated task, so the client that made the
change is not left stale.

## Notifications

| Method | Path                | Status | Body / query                            | Returns                                      |
| ------ | ------------------- | ------ | --------------------------------------- | -------------------------------------------- |
| GET    | /notifications      | 200    | `?before=`, `?unseenOnly=true`          | `{ notifications, unreadCount, nextCursor }` |
| PATCH  | /notifications/seen | 200    | `{ notificationId }` or `{ all: true }` | `{ updated }`                                |

Auth required. Each row resolves its subject, so nothing needs a second request:

```json
{
  "id": "uuid",
  "type": "mention",
  "reference_id": "uuid",
  "seen": false,
  "created_at": "ISO",
  "context": {
    "room_id": "uuid",
    "room_name": "Product Engineering",
    "room_slug": "…",
    "actor_name": "Victor",
    "message_preview": "first 120 characters…"
  }
}
```

`actor_name` and `room_name` are `null` when the subject no longer exists, and
`message_preview` is `null` when the message was soft-deleted — render a
tombstone rather than text the author retracted. A notification is never dropped
because its subject is gone.

Newest first. `unreadCount` is your **total** unseen count, not a count of the
current page. `nextCursor` is an opaque `"<created_at>|<id>"` string, or `null`
on the last page — pass it back as `?before=`.

The same shape arrives over the socket as `notification { notification }`, so an
incoming event can be inserted into the list directly. ⚠️ `notification` **always**
carries a complete row — never a count. Marking rows seen emits the separate
`notification:seen { updated }`, so a client can safely append every
`notification` payload to its list without checking it first.

`PATCH` returns `updated`, the number of rows **this call** changed — subtract it
from your badge. A repeated `all: true` returns `0`.

Errors: **400** neither `notificationId` nor `all: true` · **404** no such
notification of yours.

Types currently written: `room_invite` (on being added to a room), `member_joined`
(on joining a public room), and `mention`. `new_message` and `file_uploaded` are
accepted by the service but nothing writes them yet.

## Not built yet

No endpoints exist for: room rename/leave/remove-member/delete/promote, finding
an existing DM by user id, home summary, or a global cross-room search. See
`CONTRIBUTING.md` for who owns each.

---

## Socket events

Server → client, as documented at the top of `backend/src/sockets/index.js`:
`receive-message`, `chat:updated`, `room-presence`, `room:members`, `room-typing`, `typing`, `stop-typing`, `start-recording`, `stop-recording`, `privacy:changed`, `message-read`, `message-delivered`, `message:receipts`,
`task:updated`, `message:updated`, `message:deleted`, `message:reaction`,
`notification`, `notification:seen`, and `error:message`.

`chat:updated { roomId, lastMessage, unreadCount }` goes to each member's personal channel
(`user:<id>`), because `unreadCount` is one person's number. It fires after every
message create, edit and delete, so a sidebar row updates without being opened.
`lastMessage` is `null` for a room with nothing in it, and carries
`is_deleted: true, content: null` when the newest row is a tombstone.

`message:updated`, `message:deleted` and `message:reaction` each carry the **whole
message** under `{ message }`, emitted to the room. Replacing your copy from the
event alone is enough — no refetch. `message:reaction` fires on both add and
remove, and the message is re-read per change rather than a delta being pushed,
because one person's reaction flips `reacted` for every other viewer.
Errors are emitted on **`error:message`**, not `error` — Socket.IO reserves
`error` for its own internals.

Client → server payloads: `join-room { roomId }`, `leave-room { roomId }`,
`send-message { roomId, clientId?, content?, replyToId?, attachments?, albumId?, mentionedUserIds? }`,
`typing { roomId }`, `stop-typing { roomId }`, `start-recording { roomId }`,
`stop-recording { roomId }`, `message-read { roomId, messageId }`,
`message-delivered { roomId, messageId }`,
`heartbeat { foreground?, roomId?, revision? }`.

### Presence and foreground attention

`room-presence` carries a complete, membership-scoped snapshot:

```json
{
  "roomId": "uuid",
  "available": true,
  "onlineUserIds": [],
  "viewingUserIds": [],
  "typingUserIds": [],
  "recordingUserIds": [],
  "hiddenUserIds": [],
  "activity": [],
  "activityVersion": 12,
  "checkedAt": 1792670400000
}
```

- **Online** means at least one authenticated device has a fresh socket lease,
  including a connected device elsewhere in Conclave or in a background tab.
- **Viewing this conversation** additionally requires a visible, focused chat
  timeline. Subscribing to a room or opening its info page does not imply viewing.
- **Typing** is temporary; the presence label expires it after five seconds.
- **Offline** comes from an available, fresh snapshot with no live device.
- **Unknown** is shown as “Presence unavailable” while disconnected, after resume
  pending a new snapshot, during a storage outage, or after 45 seconds without a
  fresh snapshot. Read pointers are never presented as last-seen presence.

Clients send a heartbeat every 15 seconds and immediately on route, focus,
visibility, online, and page-resume changes. `foreground` is a boolean, `roomId`
is the active timeline UUID or null, and `revision` increases per device update.
Delayed older revisions cannot restore an outdated foreground state. The server
checks room membership before accepting a viewing claim. Legacy empty heartbeats
renew connectivity without claiming foreground attention.

Heartbeat acknowledgements return `{ ok: true, data: { available, checkedAt } }`.
`presence:unavailable` invalidates cached snapshots; `presence:resync` asks clients
to send a fresh heartbeat. Room subscriptions receive full snapshots on join and
heartbeat. Online/viewing changes are broadcast only to rooms the user belongs to.

Each device lease lasts 45 seconds. A sweep runs every 10 seconds, atomically
removing expired device, room, typing, and reverse-index records without removing
another device's renewed lease. Index reconciliation runs approximately once per
minute. Heartbeats rebuild indexes after Redis data loss using current socket
subscriptions and locked database membership checks. Redis outages report
unknown presence; they do not manufacture offline snapshots.

### Typing, recording, and activity privacy

The composer emits typing at most once every 2.5 seconds while text changes,
with a stop after three idle seconds. Recording pulses every 2.5 seconds only
while capture is active. Blur, blank input, sending, navigation, disconnect,
and background transitions stop typing. Blur, navigation, disconnect, and
background transitions also stop recording indicators. Backgrounding finishes active
microphone capture; late permission grants after navigation release their tracks.
Recorder errors and ended microphone tracks stop recording indicators and release
the microphone.

The server requires membership, a room subscription, a fresh device lease, and
foreground viewing before accepting a positive activity event. It limits each
socket to 24 indicator events per 10 seconds before session verification and
limits positive events to 120 per minute per account across Redis-backed instances.
Negative events skip the account start limit. Activity acknowledgements return
`{ ok: true, data: { roomId, accepted } }`; invalid membership or subscription
returns 403, throttling returns 429, and unavailable activity storage rejects
positive events with 503.

Activity is stored per device for five seconds. A stop, send, leave, or disconnect
clears that device; other devices remain active. Event ordering prevents delayed
starts from undoing newer stops or foreground changes. Full `room-presence` and
`room-typing` snapshots include `activity` entries shaped as
`{ userId, kind: "typing" | "recording", ttlMs }`. Clients expire both snapshots
and incremental events using their remaining TTL. `activityVersion` is a shared,
increasing room revision; clients reject older activity snapshots and deltas.
Legacy deltas carry `{ roomId, userId, ttlMs, activityVersion }` and reflect the
user's aggregate state rather than the originating device alone.

Snapshots are filtered per subscribed member. A block in either direction hides
online, viewing, typing, and recording between the two users, including in shared
rooms. Other room members still receive their allowed activity. Block/unblock
emits `privacy:changed { userId, hidden }` to both users' personal channels,
invalidates client activity, and refreshes shared-room snapshots. Reverse blocks
remain effective after one user unblocks. Hidden peers display unknown presence.
Device IDs, audio content, and microphone permissions are not broadcast.
These changes require no new migration or environment variables.

`send-message` takes the same body as `POST /messages` and returns the same
message row on `receive-message`. Pass `mentionedUserIds` — see the warning above
for what omitting it costs.


### Message receipts and send-time recipients

Migration `033_message_receipts.sql` snapshots every message's recipients in the
same transaction as insertion. This includes text, media, forwards and polls.
The sender is excluded. Joining, leaving, removal, rejoining, and account deletion
do not add or remove the original recipients. These rows never grant access to
a conversation or its attachments.

Message payloads on creation, history, search, pins, edits, deletions and reactions
include `receipt_summary`:

```json
{
  "recipient_count": 3,
  "delivered_count": 3,
  "read_count": 1,
  "history_complete": true,
  "version": 4
}
```

- **Sent:** the server stored the message. A single recipient's acknowledgement
  does not change a group's tick.
- **Delivered:** every original recipient acknowledged the message on at least
  one device. This acknowledges message metadata, not a media download.
- **Read:** every original recipient acknowledged that specific message as read.
  Reading also implies delivery. Partial reads remain delivered if everybody
  received the message, otherwise sent.
- With zero recipients, or incomplete historical recipient data, the tick stays
  sent. Pending, queued and failed outbox states still take precedence.
- A departed recipient's pending receipt stays pending; the information dialog
  identifies them as no longer in the conversation. New members do not become
  recipients of older messages.

Automatic reads require a visible, focused, online timeline. The client checks
intersection against the scrollport and viewport, including very tall messages,
and suppresses reads behind modal dialogs. It rechecks unchanged intersections
on focus, visibility, page resume, reconnection and foreground-heartbeat success.
Only acknowledged reads are deduplicated; failed/offline attempts retry while
visible. In-flight reads remain deduplicated across renders.

The server checks current membership for all receipt events. Reads additionally
require a room subscription and that originating device's unexpired Redis lease and foreground
room claim; background read attempts return 409 and storage outages return 503.
A read acknowledges only the specified message. The contiguous room pointer
advances once earlier unread gaps close, rather than marking skipped messages
read. Delivery works in background tabs and for metadata fetched before a subscription
finishes. Reconnect retransmits delivery acknowledgements for cached messages,
including anchored historical timelines. Explicit `POST /rooms/:roomId/seen`
intentionally marks all existing messages read without a viewport claim.

`message:receipts { roomId, receipts: [{ messageId, receipt_summary }] }` publishes
aggregate changes to room subscribers. Summary versions increase per message;
clients reject older summaries, including delayed history and send acknowledgements.
Existing `message-read` and `message-delivered` events retain user and contiguous
pointer fields. Per-recipient timestamps are first-ack times and do not change
on duplicates or acknowledgements from another device.

| Method | Path | Returns | Access |
| --- | --- | --- | --- |
| GET | /messages/:messageId/receipts | `{ messageId, sentAt, summary, recipients }` | Sender who is still a room member; otherwise 404. |
| GET | /messages/room/:roomId/receipts?ids=uuid,uuid | `{ roomId, receipts }` | Current members; 1–200 valid IDs; other rooms' IDs return no data. |

Each recipient detail includes `user_id`, `display_name`, `delivered`, `read`,
`delivered_at`, `read_at`, and `current_member`. The sender's **Message info**
action opens these details; receipt events and reconnects refresh an open dialog.
Reconnection also refreshes summaries for all loaded messages, in batches of 200,
so a message need not arrive again for its tick to recover.

Older messages are explicitly marked `history_complete: false`: only surviving
memberships present by the message's creation can be reconstructed. Known flags
are backfilled from existing pointers, but acknowledgement times stay null.
The UI explains missing history and shows unavailable times. Missing historical
recipients and exact times cannot be recovered by this migration.

### Durable media sends and album ownership

The client saves selected file Blobs and captions in its account-scoped outbox
before uploading. Each item has its own stable UUID `clientId`. After upload, the
client sends the usual message payload with one attachment; file Blobs and local
object URLs never enter that payload. Retrying a completed upload uses the same
attachment claim and client ID. Creation, history, search and message updates
return `client_id` and nullable `album_id`.

`albumId` is a UUID shared by messages from the same selection. Each album item
must have one attachment, and the server rejects reuse of an album ID by another
sender or conversation. This check and message creation occur in one transaction.
The album ID does not replace any membership or upload-ownership checks.

Socket acknowledgements return `{ ok: true, data: message }` for a persisted send
or `{ ok: false, error, status }` for a failure. The status distinguishes temporary
server/rate-limit failures from permanent validation or access failures. A lost
acknowledgement is resolved by retrying the same client ID. A send with an unknown
outcome must not be discarded as though the server had definitely rejected it.


### Media display metadata (migration 027)

`POST /upload` accepts one `file` and an optional multipart text field
`mediaMetadata`, a JSON object with optional `width`, `height`, `preview_url`
and `duration`. Width/height must be paired positive integers no greater than
32768. `preview_url` accepts only a JPEG data URL capped at 12 KiB decoded;
external URLs and SVG thumbnails are rejected. Duration is video-only, in seconds,
greater than zero and no greater than 604800. These are device-supplied display
hints, not authoritative file-signature or security metadata.

The upload record owns these fields; attachment claims ignore message-supplied
metadata. Upload responses and live/history/search/shared-media attachment shapes
include `width`, `height`, `preview_url` and nullable `duration`. Legacy rows may
have null display metadata. New inline thumbnails are included only in authorized
message responses and do not require a public thumbnail object.

Original delivery continues through authenticated attachment endpoints. Browser
caching is local and account-scoped; it does not make R2 objects public. Previously
cached bytes can remain on a device independently of remote access changes.


### Resumable uploads and Range delivery (migrations 028–029)

- `GET /upload/capabilities`: `{ multipart, partSize }`; authenticated and safe to
  cache for the current app session. `multipart` requires the deployment flag.
- `POST /upload/sessions`: `{ roomId, clientId, filename, mime_type, size,
  metadata?, restart? }` returns 201 with `{ id, partSize, parts, expiresAt? }` or
  a completed `attachment`. Reusing an account/client ID is idempotent; changing
  its file identity is a 409. Membership and upload ownership are enforced.
- `GET /upload/sessions/:sessionId`: resumes from actual R2 parts. Each part has
  `{ partNumber, size, etag }`. Expired/cancelled sessions return 410.
- `POST /upload/sessions/:sessionId/parts`: `{ partNumber }` returns
  `{ url, size, expiresIn: 300 }`. Browser PUTs bytes directly to that URL.
- `POST /upload/sessions/:sessionId/complete`: validates actual bytes and returns
  the attachment descriptor. Idempotent after a lost response.
- `DELETE /upload/sessions/:sessionId`: retires an unclaimed upload and queues
  abort/deletion. An attached file returns 409.

`GET /attachments/:attachmentId` accepts single Range/If-Range requests for R2.
206 exposes Content-Range, Content-Length, Accept-Ranges and ETag. Invalid ranges
return 416 with `Content-Range: bytes */<size>`. Membership/deleted checks run
before storage access. Originals use private, no-store HTTP caching; local
account-scoped chunks and originals support offline reopening.

See [media operations](MEDIA_STORAGE.md) for rollout, retention, expiry and cleanup.


### Shared-file browsing

`GET /messages/room/:roomId/media` returns `{ media, nextCursor }`.
`kind` is `media` (photos/videos, default), `documents` (other non-audio files)
or `audio`. `limit` defaults to 24 and must be an integer from 1 to 100.
Each item includes the existing authorized attachment fields plus `message_id`,
`room_sequence`, `sender_id`, `sender_name` and `created_at`. Deleted messages
are excluded. Non-members receive 404.

Pass the opaque `nextCursor` back as `cursor` for older items. Ordering uses
room sequence and attachment UUID descending, so legacy messages with several
attachments page without omissions and new inserts do not shift older pages.
Cursors are bound to room, section and the optional `after` ISO timestamp.
`after` filters messages strictly newer than that date and lets the client honor
its existing device-specific clear-history cutoff. It does not change server
history or grant access. Invalid filters/cursors return 400.

`GET /messages/room/:roomId?around=<message UUID>` returns up to 50 history
messages ending at that message, in the usual newest-first message shape.
The ordinary `nextCursor` continues toward older history. It cannot be combined
with `before` or `afterSeq`. The anchor must be undeleted and in the same room;
a missing/deleted/cross-room anchor returns 404 after the normal membership check.
This bounded lookup avoids downloading every intervening page to follow a
shared-file link. The client offers Return to latest, keeps the context window
out of its latest-history cache, and resumes normal history when leaving it.


### Reference-based forwarding

`POST /messages` and `send-message` accept optional
`forwardSource: { messageId, attachmentId? }`. Include a stable `clientId` for retry.
The caller must currently belong to the source and destination conversations.
Destination DM blocks apply. Source deletion, lost membership, polls and invalid
attachment choices are rejected. Forward requests cannot mix upload claims or replies.
When a legacy source has several attachments, specify one `attachmentId` per new
message; these messages may share a new `albumId`.

Source content and attachment metadata are copied by the server, without copying
storage bytes or firing mentions from the old text. A new attachment ID authorizes
each destination independently. Public payloads include `forwarded: true`; internal
source identifiers are not exposed to recipients. An idempotent retry of an already
created destination message returns that message even if the source later disappears.
Migration 031 adds the forwarded marker.

## Phase 5 privacy, recovery, and devices

See [privacy/encryption policy](PRIVACY_AND_ENCRYPTION.md) for scope and limits.
`GET /users/me` and auth responses include `email_verified_at`. Profile/photo
fields in authenticated responses are personalized; do not reuse one viewer's
payload for another. Presence snapshots include only permitted online/last-seen
information. DM receipt summaries include `reads_visible`; hidden reads are not
an assertion that a recipient has not read the message.

### Account security routes (`/security`)

| Method/path | Access and payload |
| --- | --- |
| `POST /recovery` | Public, rate limited; `{email}`. Generic eligible/unknown response. |
| `POST /reset` | Public, rate limited; `{token,password}`. Single use, 30-minute token; password 12+ characters, max 72 UTF-8 bytes. Revokes every session. |
| `POST /verify` | Public, rate limited; `{token}`. Single use verification. |
| `POST /verification` | Authenticated; requests verification for current account's email. |
| `GET /privacy` | Current preference object. |
| `PATCH /privacy` | Partial preferences: `online_visibility`, `last_seen_visibility`, `photo_visibility`, `about_visibility` (`everyone/connections/nobody`), `read_receipts` boolean, `dm_policy` (`everyone/requests/connections/nobody`). |
| `GET /sessions` | `{sessions}`: current flag, device label, user agent, expiry, creation/last activity. |
| `PATCH /session` | `{label}` (1–80 characters), renames current session. |
| `DELETE /sessions/:sessionId` | `{password}`; UUID or `others`. Durable revocation and cluster eviction. |
| `GET /requests` | `{requests}` pending incoming DM requests, maximum 100. |
| `POST /requests/:roomId` | `{status: 'accepted' | 'declined'}` by recipient only. |

Mail configuration missing returns 503. An eviction failure may return 503 after
durable revocation; this never means the session was restored.

### Device encryption routes (`/encryption`, authenticated)

| Method/path | Contract |
| --- | --- |
| `GET /devices` | Account `identityKey` and public device records; no private keys. |
| `POST /devices` | `{id,boxKey,signingKey,label,identityKey,signature?}`. Base64url public keys. Identity signature required for initial/approved enrollment; otherwise pending until linked. |
| `POST /devices/:id/approve` | Root-signed certificate and sealed link payload from approved device; pending enrollment expires in 15 minutes. |
| `GET /devices/:id/link` | Encrypted link payload, accessible only to target device's current session. |
| `DELETE /devices/:id` | `{password}`; revokes device and its login session. |
| `GET /rooms/:id` | Authorized roster of members, identities, and active approved devices. |
| `POST /rooms/:id/upgrade` | Returns `{roomId}` for separate encrypted successor; legacy conversation stays server readable and becomes read only for new sends. |
| `GET /backup` | `{payload,revision,updated_at}` encrypted key backup only. |
| `PUT /backup` | Opaque encrypted backup payload; recovery key never sent. |
| `DELETE /backup` | `{password}` confirmation. |
| `POST /reset` | `{password,confirmation:'RESET ENCRYPTION',device}`; irreversibly replaces identity/backup and revokes other sessions. |

Room payloads expose `encryption_mode` (`none` or `e2ee-v1`) and
`superseded_by`. New `dm`/`private` conversations are encrypted; new
`group`/`department`/`public` remain server readable. All migration-era rooms
remain `none` until explicit move.

Encrypted sends use the normal message route/socket with `roomId`, `clientId`,
`encryptedPayload`, and uploaded attachment references. Plaintext content,
mentions, filename, MIME, caption, preview, dimensions, and file keys must not
be included in the wire message. `encryptedPayload` contains scheme, room/client/
sender context, revision, device ID, nonce, ciphertext, sorted per-device sealed
keys, and device signature. Server persists `[Encrypted message]` as `content`
and returns `encrypted_payload` with signed sender-certificate metadata; only
authorized clients decrypt it. Retries reuse the same client ID and sealed wire
payload. Edits use `{encryptedPayload}` with the next revision. Recipient-roster
changes may return 409, requiring a new encrypted envelope on manual retry.

Encrypted uploads use `application/vnd.conclave.encrypted`, `encrypted.bin`,
and the `CCEF1` authenticated container. Both server and direct upload paths
normalize the filename; image metadata is absent from server upload records.
The ciphertext upload cap is 50 MiB. Authorized download/Range endpoints remain
the transport; the browser decrypts and caches plaintext separately. Server
search/tasks/decisions/polls/forwarding that would process encrypted content are
rejected; local search covers only decrypted cached history.
