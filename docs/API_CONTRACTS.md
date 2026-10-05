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
| POST | /tasks | 501: unimplemented |
| GET | /tasks/room/:roomId | 501: unimplemented |
| PATCH | /tasks/:taskId/status | 501: unimplemented |
| GET | /notifications | 501: unimplemented |
| PATCH | /notifications/seen | 501: unimplemented |
| POST | /upload | 501: unimplemented |

Responses use `{ success: true, data }` or
`{ success: false, message }`. Listed implementation status does not imply
frontend integration or live database verification. Detailed payload contracts
for older message/decision/digest routes still need documentation.
