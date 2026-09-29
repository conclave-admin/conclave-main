# Contributing to Conclave

## Who works on what

Three people, three lanes. The split is by **layer**, not by feature, because the
frontend and backend are contractually bound to each other — features that span
both need a pairing, and features inside one lane can be picked up and finished
without waiting on anyone.

| Owner   | Lane      | Owns                                                                 |
| ------- | --------- | -------------------------------------------------------------------- |
| Michael | Backend   | Auth, users, rooms, and the shared write path in `services/`           |
| Victor  | Backend   | The differentiator layer: decisions, tasks, digest, sockets, upload    |
| Isaac   | Frontend  | Everything under `client/`, including design fidelity and the fixtures |

---

## Michael — Backend, foundations

**Why this lane:** auth and rooms are the substrate everything else queries
against. Room membership is checked by nearly every other controller, so these
need to be right and stable first.

**Current state: complete.** Auth (register/login/refresh/logout with rotation),
users (me/update/list/delete), rooms (create/list/get/add member/mark seen) are
all implemented and hardened.

**Owns going forward:**

- **Item G — Invites.** The open half of a known inconsistency: the login screen
  says "Conclave is invite-only" while `POST /auth/register` is completely open.
  Decide the model (invite links, email invites, admin-created accounts), then
  add the endpoints and gate registration. **This is a product decision — get it
  signed off before building.**
- **Item F — Rooms management.** Update room name, leave room, remove member,
  delete room, promote member to admin. Also `POST /rooms/dm { userId }` to find
  or create a DM, which the `/dms` screen needs — `createRoom` dedupes but
  there's still no way to *find* one.
- **Item D — Home page data.** `GET /home/summary`, or `unread_count` on
  `listRooms`. Now unblocked because `last_seen_at` actually moves.
- **Rate limiting on `/auth/*`.** Needs a dependency choice
  (`express-rate-limit` vs hand-rolled on Redis) — raise it, don't just pick.
- **`role_id` is never checked anywhere.** Decide what it's for or drop it.
- **`listUsers` leaks every user's email to any authenticated caller.** Scope it
  to shared rooms, or hide the address. Product/privacy call.

**Watch out for:**

- `requireAuth` now runs one `SELECT 1 FROM users ... AND deleted_at IS NULL` per
  authenticated request. That's deliberate — a JWT can't be revoked, so this is
  what makes account deletion mean anything — but it is a hot path. Don't remove
  it; if it ever needs to be cheaper, cache it with a short TTL.
- Anything that changes `room_members` or `users` affects the digest window
  (`last_seen_at`) and every membership check in the codebase.

---

## Victor — Backend, the differentiator layer

**Why this lane:** decisions, tasks and digest are what separates Conclave from a
chat clone, and they are the least built. This is the highest-leverage work.

**Current state: mixed.** Decisions and digest are implemented. Tasks,
notifications and upload are 501 stubs.

**Owns going forward, in priority order:**

1. **Item C — File upload.** Unblocks the composer's attach button, and is the
   prerequisite for closing a real security hole: `message.service.js` currently
   takes the attachment `url` straight from the request body, so any room member
   can persist an arbitrary string as a file URL. Once uploads exist, look the
   URL up from the upload record instead. Stream to `cloudinary.uploader.upload_stream`,
   allowlist mime types, return `{ filename, url, mime_type, size }`.
2. **Item A — Tasks endpoints.** Unblocks the Tasks page *and* the digest's task
   section, which is permanently empty until something writes to `tasks`.
   `POST /tasks`, `GET /tasks` (cross-room, the page is top-level), and
   `PATCH /tasks/:taskId/status` limited to `open | in_progress | done`, updating
   `updated_at` (nothing maintains that column today) and emitting `task:updated`.
3. **Item B — Notifications.** `GET /notifications` with an unread count, and
   `PATCH /notifications/seen`. The table stores only `type` and `reference_id`,
   so the list needs a join to return readable text. Create `new_message` and
   `mention` rows and emit `notification` — `addMember` already writes a
   `room_invite` row and never emits it, which is the natural place to close that.
4. **Item H — Structured mentions.** The regex mention matcher is correct but
   it is still text matching, and a display name is not an identity: renaming a
   user changes who gets mentioned. Add `message_mentions(message_id, user_id)`,
   parse from a client-supplied `mentionedUserIds`, and use it for the digest and
   notifications.
5. **Item I — Message edit, delete, reactions.** `edited_at` and `deleted_at` ship
   in every payload and `message_reactions` has a table but no routes. The read
   side already handles soft-deleted rows (content withheld, `is_deleted` set), so
   once the delete endpoint exists it will behave.
6. **Global search (Item E)** — or decide the navbar icon opens per-room search only.

**Watch out for:**

- `decisions.searchDecisions` must keep its `to_tsvector` expression byte-identical
  to the one in `007_decisions_search_includes_tags.sql`, or the GIN index stops
  being used and search silently gets slow. Tags are matched separately because
  `array_to_string` is STABLE, not IMMUTABLE, so it can't be folded into an index.
- Socket events are documented at the top of `sockets/index.js`. Add to that list
  when you add an event — the previous list advertised four events that were never
  emitted.
- Emit errors on `error:message`, not `error`. Socket.IO reserves `error`.

---

## Isaac — Frontend

**Why this lane:** the UI is built to a finished Penpot design and is largely
reviewable, but most of it is currently reading fixtures rather than endpoints.

**Current state: polished but disconnected.** Every protected route renders, but
seven of nine read from `config/devPreview.js`. The backend has shipped four
endpoints the client never calls.

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
  or the user is signed out on the *following* refresh. `auth.service.js` already
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
npm test          # 17 smoke tests: route table, auth wiring, error envelopes
node --check src/**/*.js
```

The smoke tests boot the real Express app and assert the route table, that
protected routes are actually protected, and that errors return the documented
JSON envelope. They run **no SQL and connect to nothing**, so they cannot catch a
bad query.

**The single biggest risk in this repo right now:** per `docs/BACKEND_TASKS.md`,
no SQL has ever been executed — the backend was built where Docker was
unavailable. Every migration and every query string is unverified against a real
Postgres. Before anything ships, run the migrations and exercise auth, room
membership, message create/list and the digest queries against a real database.
A test suite that boots the app is not a substitute.
