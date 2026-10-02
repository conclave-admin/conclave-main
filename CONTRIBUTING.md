# Contributing to Conclave

## Who works on what

Three people, three lanes. The split is by **layer**, not by feature, because the
frontend and backend are contractually bound to each other — features that span
both need a pairing, and features inside one lane can be picked up and finished
without waiting on anyone.

| Owner   | Lane     | Owns                                                                                                                       |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Michael | Backend  | The differentiator layer: decisions, tasks, digest, upload, notifications, **the message write path and the socket layer** |
| Victor  | Backend  | Foundations: auth, users, rooms, plus the presence and token services                                                      |
| Isaac   | Frontend | Everything under `client/`, including design fidelity and the fixtures                                                     |

**Why `message.service.js` belongs to the differentiator lane.** It used to be
listed as a shared write path, which meant whoever owned decisions, tasks,
notifications or uploads had to cross lanes to touch it. All four write through
it — uploads insert attachments, notifications create rows on send, structured
mentions parse at send time, and tasks emit over the socket. Putting it in one
lane removes that crossing. It is now Michael's outright, not shared.

---

## Michael — Backend, the differentiator layer

**Why this lane:** decisions, tasks, digest and uploads are what separates
Conclave from a chat clone, and they are the least built. This is the
highest-leverage work available.

**Current state: mixed.** Decisions and digest are implemented. Tasks,
notifications and upload are 501 stubs. You also own `message.service.js` and the
socket layer, so the write path and everything emitted from it are yours.

**Owns going forward, in priority order:**

1. **Item C — File upload.** Unblocks the composer's attach button, and is the
   prerequisite for closing a real security hole: `message.service.js` currently
   takes the attachment `url` straight from the request body, so any room member
   can persist an arbitrary string as a file URL — and the code says so at
   `message.service.js:11`, _"this checks shape, not provenance."_ Once uploads
   exist, look the URL up from the upload record instead. Stream to
   `cloudinary.uploader.upload_stream`, allowlist mime types, return
   `{ filename, url, mime_type, size }`.
2. **Item A — Tasks endpoints.** DONE. `POST /tasks`, `GET /tasks` (cross-room,
   the page is top-level), and `PATCH /tasks/:taskId/status` limited to
   `open | in_progress | done`. `status` is constrained by a `CHECK` in migration
   011, not just validated in the controller, and `updated_at` is set explicitly
   because the digest's whole window depends on it. Emits `task:updated` to the
   room.
3. **Item B — Notifications.** `GET /notifications` with an unread count, and
   `PATCH /notifications/seen`. The table stores only `type` and `reference_id`,
   so the list needs a join to return readable text. Create `new_message` and
   `mention` rows and emit `notification` — `addMember` already writes a
   `room_invite` row and never emits it, which is the natural place to close that.
4. **Item H — Structured mentions.** The regex mention matcher is correct but
   it is still text matching, and a display name is not an identity: renaming a
   user changes who gets mentioned. Add `message_mentions(message_id, user_id)`,
   parse from a client-supplied `mentionedUserIds`, and use it for the digest and
   notifications. This is a new migration — the next number is `012`
   (`009` is the notification actor column, `010` is file uploads, `011` is the
   tasks status constraint).
5. **Item I — Message edit, delete, reactions.** `edited_at` and `deleted_at` ship
   in every payload and `message_reactions` has a table but no routes. The read
   side already handles soft-deleted rows (content withheld, `is_deleted` set), so
   once the delete endpoint exists it will behave. You own the write path, so
   this one is entirely in your lane.
6. **Global search (Item E)** — or decide the navbar icon opens per-room search only.

**Watch out for:**

- `decisions.searchDecisions` must keep its `to_tsvector` expression byte-identical
  to the one in `007_decisions_search_includes_tags.sql`, or the GIN index stops
  being used and search silently gets slow. Tags are matched separately because
  `array_to_string` is STABLE, not IMMUTABLE, so it can't be folded into an index.
  That migration has already failed once this way — don't rediscover it.
- **Your digest depends on Victor not corrupting `room_members`.** `getUserDigest`
  filters on each room's own `last_seen_at`, so "leave room" and "remove member"
  (Item F, Victor's lane) move or delete rows your query depends on. If your
  digest suddenly reports the wrong window, look at his changes before yours.
- Socket events are documented at the top of `sockets/index.js`, and you own both
  the events and the doc. Add to that list when you add an event — the previous
  list advertised four events that were never emitted.
- Emit errors on `error:message`, not `error`. Socket.IO reserves `error`.

---

## Victor — Backend, foundations

**Why this lane:** auth and rooms are the substrate everything else queries
against. Room membership is checked by nearly every other controller, so these
need to be right and stable first.

**Current state: complete.** Auth (register/login/refresh/logout with rotation),
users (me/update/list/delete), rooms (create/list/get/add member/mark seen) are
all implemented and hardened. You also own `token.service.js` and
`presence.service.js`.

**Owns going forward:**

- **Item F — Rooms management.** Update room name, leave room, remove member,
  delete room, promote member to admin. Also `POST /rooms/dm { userId }` to find
  or create a DM, which the `/dms` screen needs — `createRoom` dedupes but
  there's still no way to _find_ one.
- **Item D — Home page data.** `GET /home/summary`, or `unread_count` on
  `listRooms`. Now unblocked because `last_seen_at` actually moves.
- **Item G — Invites.** The open half of a known inconsistency: the login screen
  says "Conclave is invite-only" while `POST /auth/register` is completely open.
  Decide the model (invite links, email invites, admin-created accounts), then
  add the endpoints and gate registration. **This is a product decision — get it
  signed off before building.**
- **Rate limiting on `/auth/*`.** Needs a dependency choice
  (`express-rate-limit` vs hand-rolled on Redis) — raise it, don't just pick.
- **`role_id` is never checked anywhere.** Decide what it's for or drop it.
- **`listUsers` leaks every user's email to any authenticated caller.** Scope it
  to shared rooms, or hide the address. Product/privacy call.

**Watch out for:**

- **You are on the critical path for someone else's feature.** Michael's digest
  filters each room on that room's own `room_members.last_seen_at`, so Item F —
  "leave room", "remove member" — moves or deletes rows his queries depend on. A
  digest that suddenly reports the wrong window after your change is your change.
  Talk to him before designing those two endpoints; it may need a design that
  preserves the row rather than deleting it.
- `requireAuth` now runs one `SELECT 1 FROM users ... AND deleted_at IS NULL` per
  authenticated request. That's deliberate — a JWT can't be revoked, so this is
  what makes account deletion mean anything — but it is a hot path. Don't remove
  it; if it ever needs to be cheaper, cache it with a short TTL.
- Anything that changes `room_members` or `users` affects every membership check
  in the codebase, not just the digest.
- `rooms.type` is still only documented in a schema comment, not enforced by a
  CHECK constraint. The code honours all five documented types. Adding the
  constraint means validating whatever rows already exist — coordinate before
  attempting it on a populated database.

---

## Isaac — Frontend

**Why this lane:** the UI is built to a finished Penpot design and is largely
reviewable, but most of it is currently reading fixtures rather than endpoints.

**Current state: polished but disconnected.** Every protected route renders, but
**three of the eight** — `Decisions`, `CatchUpDigestPage` and `Tasks` — still
render entirely from `config/devPreview.js` even though their backend endpoints
are live and implemented. `Home` also reads fixtures, and has no endpoint behind
it at all (item D, Victor's lane). Four live endpoints are never called:
`DELETE /api/users/me`, `POST /api/rooms/:roomId/seen`, `POST /api/auth/refresh`,
and `GET /api/decisions/search`.

**Highest-leverage first — these are backend fixes the client never picked up:**

- **Delete account works now.** `Profile.jsx` still calls `window.alert` and its
  comment claims no endpoint exists. `DELETE /api/users/me` was repaired by
  migration 006 and is live. Wire it up.
- **Call `POST /rooms/:roomId/seen` when a room is opened.** Until you do,
  `room_members.last_seen_at` only advances on socket `leave-room`, and
  `GET /api/digest` keeps reporting everything since the user joined. The entire
  digest feature is inert without this one call.
- **Add the 401 interceptor** in `lib/api.js`. Access tokens last 15 minutes and
  nothing refreshes them, so users get signed out every 15 minutes. The backend
  endpoint is ready — and it now **rotates**: `POST /auth/refresh` returns a new
  `refreshToken` alongside the access token, and the interceptor must persist it
  or the user is signed out on the _following_ refresh. `auth.service.js` already
  has `saveSession()`.
- **Wire a socket token-update path.** `lib/socket.js` captures the token once at
  connect, so a refreshed token never reaches a reconnecting socket. These two
  fixes are coupled — do them together.

**Then the feature work:**

- **Create the missing services.** `decisions.service.js`, `tasks.service.js`,
  `digest.service.js` and `notifications.service.js` do not exist. The backend
  endpoints for the first three are already live.
- **`CatchUpDigestPage.jsx` will crash on an unknown item type.**
  `ITEM_TYPES[type]` destructures with no default — one unexpected `type` from
  the backend throws and takes the page down.
- **Pagination.** `useMessages` receives `nextCursor` and discards it. There's no
  "load older" and the `before` parameter is never passed.
- **Dead affordances to either wire or remove:** the Decisions search input (no
  state, no filtering), "New decision", the composer's Attach and Mention
  buttons, the navbar Search and Notifications buttons, and the hardcoded green
  "Available" dot in the sidebar footer (there is no presence subscription, so it
  is fiction in every environment).
- **Bypass `logout` is a no-op.** `AuthContext.jsx` sets `previewUser` instead of
  `null` under `VITE_DEV_AUTH_BYPASS`, so the Profile logout button does nothing
  in preview mode.
- **`Room.jsx` remounts the header on every reconnect** because the header effect
  depends on `isConnected`.
- **`Profile.jsx` never calls `setRoomHeader`**, so its navbar reads "Workspace
  overview" while Decisions/Tasks/Digest correctly set their own.
- **`Settings` and `Notifications` are 9-line TODO stubs**, and both use
  `text-gray-500` — a stock Tailwind colour, not a Foundations token (`muted`).
  Their backend endpoints are 501, so be honest about that in the UI rather than
  calling them and rendering a placeholder as data.

**Constraints — read `docs/CLAUDE.md` before touching any component.** It is
binding, not advisory:

- Design values come from the connected Penpot file. There is no local spec file.
- Use Tailwind tokens. Never hardcode a hex or an arbitrary px. Board-measured
  values belong at `lg:` (Desktop, 1280) or `md:` (Tablet, 768).
- **`sm` is removed on purpose.** `md` and `lg` are the only breakpoints.
- Line heights are unitless 1.2.
- Some things deliberately have no board and no breakpoint value: RoomHeader's
  dynamic text, Room's error states, MessageTimeline's bottom padding. Don't
  invent one.
- Icons: check `client/src/assets/icons/` first, import via `?react`, never write
  inline SVG, never add an icon library. If the icon genuinely doesn't exist,
  stop and ask. 16 of the 90 icons are currently in use.

---

## Shared working agreement

These are already in `docs/CLAUDE.md` and `docs/BACKEND_TASKS.md`. Restated here
because they are the rules that keep three people from colliding:

- **Branch and open a PR. Never push to `main`.**
- **Don't change `useMessages` or `useRoom` signatures without telling everyone.**
  The frontend is built against them. If a signature needs to change, that's a
  conversation first.
- **Never edit `client/` from a backend task, or `backend/` from a frontend task,
  without saying so first.** Cross-lane work is allowed, just announced.
- Use `ok()` and `fail()` from `utils/apiResponse.js` for every response. Don't
  hand-build response JSON.
- New tables and columns ship as a **new numbered migration** in
  `backend/database/migrations/`. Never edit an earlier one.
- **Don't batch formatting changes with functional ones.** An editor reformatted
  two whole files on a recent commit, turning a 4-line fix into a 172-line diff.
  There is no Prettier config in the repo, and quote style is currently split:
  most of the backend uses single quotes, but `messages.controller.js` and
  `rooms.controller.js` use double. Pick one and enforce it in a separate commit
  that changes nothing else.

## Verifying your work

```bash
cd backend
npm test          # 39 tests: 17 smoke + 22 integration
npm run test:db   # just the integration suite
```

Two suites, and the split matters when something breaks:

- `backend/test/` — **runs no SQL, connects to nothing.** Boots the real Express
  app and asserts the route table, that protected routes are actually protected,
  and that errors return the documented JSON envelope. Fast, and it catches the
  class of breakage otherwise only found in production.
- `backend/tests/` — **needs Postgres.** Creates a throwaway `conclave_test`
  database, applies all eight migrations to it, runs 22 assertions against the
  real query paths, then drops the database. It cannot touch your dev data, and
  it skips itself if Postgres is unreachable.

All eight migrations have now been applied to a real PostgreSQL 16 and pass, and
the second suite asserts that on every run. That verification has already earned
its keep: migration `007` was wrong and failed on its first real execution
(`array_to_string` is STABLE, not IMMUTABLE, so it cannot appear in an index
expression), and nothing syntax-checks its way to finding that.

If you touch a query string, `npm test` is the check that matters — the smoke
suite will happily pass a broken `SELECT`.
