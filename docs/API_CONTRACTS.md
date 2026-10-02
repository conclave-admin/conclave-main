# API Contracts

Base URL: `http://localhost:5000/api`
Auth: `Authorization: Bearer <accessToken>` on every route except `/auth/*` and `/health`.

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

## Health

| Method | Path      | Notes                                         |
| ------ | --------- | --------------------------------------------- |
| GET    | `/health` | Outside `/api`. No auth. → `{ status: 'ok' }` |

## Auth

| Method | Path           | Body                               | Returns                               | Notes                                                                                                                                                            |
| ------ | -------------- | ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /auth/register | `{ email, password, displayName }` | `{ user, accessToken, refreshToken }` | Validates email format, password 8–72 bytes. Email is stored lowercased.                                                                                         |
| POST   | /auth/login    | `{ email, password }`              | `{ user, accessToken, refreshToken }` | Case-insensitive on email. Same 401 for unknown, soft-deleted, and wrong password.                                                                               |
| POST   | /auth/refresh  | `{ refreshToken }`                 | `{ accessToken, refreshToken }`       | ⚠️ **Rotates.** The old token is revoked and a new one issued. **You must persist the returned `refreshToken`** or the user is signed out on the _next_ refresh. |
| POST   | /auth/logout   | `{ refreshToken }`                 | `{ message }`                         | Revokes. Always returns success, so it cannot be used to probe a token.                                                                                          |

⚠️ `user` is the same shape from register and login:
`{ id, email, display_name, avatar_url, bio, created_at }`.

## Users

| Method | Path      | Body                                       | Returns                              | Notes                                                                                                                                                          |
| ------ | --------- | ------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /users/me | —                                          | user                                 | 404 if soft-deleted.                                                                                                                                           |
| PATCH  | /users/me | any of `display_name`, `avatar_url`, `bio` | user                                 | Whitelist-only. Per-field limits: 100 / 2048 / 1000 chars.                                                                                                     |
| DELETE | /users/me | —                                          | `{ message }`                        | **Soft delete.** Anonymises the row, revokes all sessions, removes room memberships. Messages, decisions and tasks are preserved and render as "Deleted user". |
| GET    | /users    | `?q=&page=`                                | `{ users, page, pageSize, hasMore }` | Directory for "add member" pickers. ⚠️ Soft-deleted users are excluded, but this currently returns every live user's email to any authenticated caller.        |

## Rooms

| Method | Path                   | Body                          | Returns                                 | Notes                                                                                                                                                                                                                               |
| ------ | ---------------------- | ----------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /rooms                 | `{ name, type?, memberIds? }` | room + `members[]`                      | `type` ∈ `dm, group, public, private, department`. Caller becomes admin. A DM between the same pair is **not** duplicated — the existing one is returned with `existing: true`. Slug is derived server-side and cannot be supplied. |
| GET    | /rooms                 | —                             | room[]                                  | Includes `slug`, `type`, `member_count`, `my_role`, `last_seen_at`.                                                                                                                                                                 |
| GET    | /rooms/:roomId         | —                             | room + `members[]`                      | Membership required.                                                                                                                                                                                                                |
| POST   | /rooms/:roomId/members | `{ userId }`                  | `{ roomId, userId, displayName, role }` | Admin only. 404 if the target is soft-deleted. Writes a `room_invite` notification row but does **not** emit it on the socket.                                                                                                      |
| POST   | /rooms/:roomId/seen    | —                             | `{ roomId, lastSeenAt }`                | **Call this when a room is opened.** It is the only thing that advances `room_members.last_seen_at` apart from socket `leave-room`, and the entire digest depends on it.                                                            |

## Messages

| Method | Path                          | Body                                             | Returns                    | Notes                                                                                                                                                                                                                                                                           |
| ------ | ----------------------------- | ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /messages                     | `{ roomId, content?, replyToId?, attachments? }` | message                    | ⚠️ `content` may be **empty if `attachments` is non-empty** — a file-only message is valid. Both empty is a 400. `attachments[]` is `{ url }` only, max 10 files. Send the `url` returned by `POST /upload`; `filename`, `mime_type` and `size` are read from the upload record and any values you send are ignored. |
| GET    | /messages/room/:roomId        | `?before=<cursor>`                               | `{ messages, nextCursor }` | Newest first. ⚠️ `nextCursor` is an **opaque string** — pass it straight back as `before`. Feed it into "load older"; it is currently discarded client-side.                                                                                                                    |
| GET    | /messages/room/:roomId/search | `?q=`                                            | `{ messages, query }`      | Full-text, room-scoped. Excludes deleted messages. Returns `attachments` too.                                                                                                                                                                                                   |

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
  ]
}
```

⚠️ A soft-deleted message is **kept in the timeline** with `content: null` and
`is_deleted: true`, so ordering and replies hold. Render a tombstone.

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

## File upload

| Method | Path    | Status | Body                                       | Returns |
| ------ | ------- | ------ | ------------------------------------------ | ------- |
| POST   | /upload | 201    | multipart `file`                           | `{ filename, url, mime_type, size }` |

Auth required. 25MB maximum. The response is wrapped in the standard
`{ success, data }` envelope, so read it from `data`.

```json
{
  "success": true,
  "data": {
    "filename": "checklist.pdf",
    "url": "https://res.cloudinary.com/…/checklist_abc123.pdf",
    "mime_type": "application/pdf",
    "size": 4096
  }
}
```

Errors: **400** no file · **413** over 25MB · **415** disallowed type · **502**
Cloudinary unavailable · **503** not configured on this server.

**Send only `url` back.** `POST /messages` takes `attachments: [{ url }]` and
resolves `filename`, `mime_type` and `size` from the upload record, so any
metadata you post is ignored. An upload can be attached to **exactly one
message**, by the user who uploaded it — a second use is a 400.

Accepted types: images (`jpeg`, `png`, `gif`, `webp`, `svg`), documents (`pdf`,
plain text, markdown, csv), Word, Excel and PowerPoint (both `.docx`-style and
legacy), `zip`, `gzip`, and audio (`mpeg`, `ogg`, `wav`, `webm`, `mp4`).
**Video is not accepted yet.**

## Tasks and Notifications — not implemented

Both return **501 Not Implemented**. They are not 200s with a placeholder body,
so do not treat a success-shaped response as real data.

| Method | Path                  | Status | Planned                                                      |
| ------ | --------------------- | ------ | ------------------------------------------------------------ |
| POST   | /tasks                | 501    | `{ roomId, title, assigneeId?, dueDate?, sourceMessageId? }` |
| GET    | /tasks/room/:roomId   | 501    | Room-scoped list                                             |
| PATCH  | /tasks/:taskId/status | 501    | `{ status }` ∈ `open \| in_progress \| done`                 |
| GET    | /notifications        | 501    | List + unread count                                          |
| PATCH  | /notifications/seen   | 501    | Mark one or all seen                                         |

## Not built yet

No endpoints exist for: room rename/leave/remove-member/delete/promote, finding
an existing DM by user id, home summary, or a global cross-room search. See
`CONTRIBUTING.md` for who owns each.

---

## Socket events

Server → client, as documented at the top of `backend/src/sockets/index.js`:
`receive-message`, `user-online`, `user-offline`, `room-presence`,
`room-typing`, `typing`, `stop-typing`, `message-read`, and `error:message`.
Errors are emitted on **`error:message`**, not `error` — Socket.IO reserves
`error` for its own internals.
