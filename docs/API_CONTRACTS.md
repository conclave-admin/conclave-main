# API Contracts (working draft)

Base URL: `http://localhost:5000/api`
Auth: `Authorization: Bearer <accessToken>` on every route except `/auth/*`.

Fill this in as each route is actually implemented — treat it as the
source of truth the frontend codes against, not documentation written
after the fact.

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /auth/register | `{ email, password, displayName }` | ✅ implemented |
| POST | /auth/login | `{ email, password }` | ✅ implemented |
| POST | /auth/refresh | `{ refreshToken }` | ✅ implemented |
| POST | /auth/logout | `{ refreshToken }` | ✅ implemented |

## Users
| Method | Path | Notes |
|---|---|---|
| GET | /users/me | ✅ implemented |
| PATCH | /users/me | Implemented: profile fields |
| DELETE | /users/me | Implemented: soft-delete account |
| GET | /users | Implemented: user directory |

## Rooms
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /rooms | `{ name, type?, memberIds? }` | ✅ implemented — creates room, caller becomes admin |
| GET | /rooms | — | ✅ implemented — lists rooms user is a member of |
| GET | /rooms/:roomId | — | ✅ implemented — room details + members, membership check |
| POST | /rooms/:roomId/members | `{ userId }` | ✅ implemented — adds member, caller must be admin |
| POST | /rooms/:roomId/seen | — | Implemented: update caller's last-seen timestamp |

## Other route status

| Method | Path | State |
| --- | --- | --- |
| POST | /messages | Implemented |
| GET | /messages/room/:roomId | Implemented: paginated history |
| GET | /messages/room/:roomId/search | Implemented |
| POST | /decisions | Implemented |
| GET | /decisions | Implemented: cross-room listing |
| GET | /decisions/search | Implemented: cross-room search |
| GET | /decisions/room/:roomId | Implemented |
| GET | /decisions/room/:roomId/search | Implemented |
| GET | /digest | Implemented: cross-room digest |
| GET | /digest/room/:roomId | Implemented |
| POST | /tasks | Implemented: create in a member room |
| GET | /tasks | Implemented: paginated cross-room listing |
| GET | /tasks/room/:roomId | Implemented: paginated room listing |
| PATCH | /tasks/:taskId/status | Implemented: authorized status changes |
| GET | /notifications | 501: unimplemented |
| PATCH | /notifications/seen | 501: unimplemented |
| POST | /upload | 501: unimplemented |

Responses use `{ success: true, data }` or
`{ success: false, message }`. Listed implementation status does not imply
frontend integration or live database verification. Detailed payload contracts
for older message/decision/digest routes still need documentation.

## Tasks

All task routes require an access token and current room membership.

### Create — `POST /tasks`

```json
{
  "roomId": "<uuid>",
  "title": "Review the launch checklist",
  "assigneeId": "<uuid, optional>",
  "sourceMessageId": "<uuid, optional>",
  "dueDate": "2026-10-20"
}
```

`title` is trimmed and must contain 1–200 characters. Optional fields may be
omitted or null. Assignees must be active members of the same room. A source
message must belong to that room and must not be deleted. Due dates must be real
calendar dates in `YYYY-MM-DD` form. New tasks always start `open`.

Returns **201**, with `data` containing a task:

```json
{
  "id": "<uuid>",
  "room_id": "<uuid>",
  "source_message_id": null,
  "title": "Review the launch checklist",
  "assignee_id": "<uuid>",
  "status": "open",
  "due_date": "2026-10-20",
  "created_by": "<uuid>",
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>",
  "room_name": "Engineering",
  "room_slug": "engineering",
  "assignee_name": "Victor"
}
```

Unassigned tasks have null assignee fields. `due_date` is a date string or null,
never a timezone-shifted timestamp. Listing and status updates use the same shape.

### List — `GET /tasks` or `GET /tasks/room/:roomId`

Optional query parameters:

| Parameter | Values |
| --- | --- |
| `roomId` | UUID; must match the path when used on the room route |
| `status` | `open`, `in_progress`, `done` |
| `assigneeId` | UUID or `me` |
| `before` | The opaque `nextCursor` returned by the previous page |

Returns **200**, `{ success: true, data: { tasks: [...], nextCursor: null } }`.
Pages contain at most 50 tasks, ordered by `created_at DESC, id DESC`. An explicit
room filter requires membership; cross-room results include only the caller's
rooms. Send the returned cursor unchanged and URL-encoded, with the same filters,
to fetch another page. It preserves PostgreSQL timestamp precision. A null cursor
means no further page. An empty matching set returns an empty `tasks` array.

### Change status — `PATCH /tasks/:taskId/status`

Body: `{ "status": "in_progress" }`. Accepts `open`, `in_progress` or `done`,
including reopening completed tasks. Only the task creator, assignee or room
admin may update it, and they must still belong to the room.

Returns **200** with the task in `data`. A change updates `updated_at`; repeating
the existing status leaves the timestamp unchanged and emits no duplicate event.

### Errors and socket events

- **400:** invalid input, invalid assignee, or unavailable source message.
- **401:** missing/invalid access token or deleted caller account.
- **403:** no membership for create/room list, or a member without status-update rights.
- **404:** task missing or outside the caller's rooms on status update.
- After commit, room subscribers receive `task:created { task }` or
  `task:updated { task }`. Re-fetch a list after reconnecting; events are not a
  durable delivery channel. A delivery failure does not undo the saved mutation.

Assignment notifications and frontend board integration are separate follow-ups.
Task changes now populate the existing assignee-specific digest queries.

### Integration verification

Use a migrated disposable PostgreSQL database, then run from `backend/`:

```sh
TEST_DATABASE_URL='postgres://.../conclave_test' npm run test:integration
```

The suite creates random fixtures and deletes only those fixtures afterward.
Without `TEST_DATABASE_URL`, database tests are skipped; a skipped run is not
evidence that SQL works. CI supplies its disposable PostgreSQL 16 connection.
